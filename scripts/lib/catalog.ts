/**
 * The model catalogue, merged from several feeds. A catalogue feed is a source in sources.yaml whose
 * plugin returns models; they are written to data/catalog/<source>.jsonl. Feeds are merged in the
 * order they appear in sources.yaml, and the first feed to describe a model wins:
 *
 *   - a model a later feed names exactly (the same id, the same name, or the same Hugging Face
 *     repository, by the matcher's own rules) only gets the fields earlier feeds left empty;
 *   - a model a later feed names as a variant of one already there (a snapshot, a preview, a maker
 *     prefix), or whose core name one already has, is left out: adding it could change which model
 *     names that already match go to;
 *   - anything else is added, under the feed's id for it.
 *
 * A feed marked `catalog: fill` in sources.yaml (Hugging Face) names catalogue models by their ids
 * and only fills fields; it never adds a model. curation/models.yaml applies on top of the merged
 * catalogue.
 */
import { Matcher } from './match.ts';
import { normalize } from './names.ts';
import { catalogPath, readJsonl } from './store.ts';
import type { CatalogModel, SourceConfig } from './types.ts';

export interface Feed {
  source: string;
  models: readonly CatalogModel[];
  /** Fill fields of models already in the catalogue; never add one. */
  fillOnly?: boolean;
}

export interface FeedStats {
  /** Models in the feed. */
  models: number;
  /** Models it added to the catalogue. */
  added: number;
  /** Catalogue models it gave at least one missing field. */
  filled: number;
  /** Models left out because one already in the catalogue has the same core name. */
  left_out: number;
}

/** Fields a later feed may fill in when earlier ones left them empty. */
export const FILLABLE = ['released', 'open_weights', 'license', 'params_b', 'active_b', 'context_k', 'model_repo'] as const;
type Fillable = (typeof FILLABLE)[number];

const byIdOrder = (a: CatalogModel, b: CatalogModel) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A word for how a model is run rather than which model it is, at the end of a name. */
const MODE = /[\s_-]*\(?\b(non-?reasoning|reasoning|non-?thinking|no-?thinking|thinking|x?high|medium|low|minimal)(-effort)?\)?$/i;

/** "Grok 4 Fast Non-Reasoning" -> "Grok 4 Fast": the name without run modes at its end. */
export function withoutModes(name: string): string {
  let out = name.trim();
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(MODE, '').trim();
  }
  return out || name;
}

/**
 * The catalogue model a feed's model is, 'related' when it is only a variant of one, shares a core
 * name with one, or is one run another way ("... Non-Reasoning"), or undefined when it is new.
 * Related models are left out: as catalogue models of their own they would take names that now
 * match the model they vary.
 */
function sameModel(matcher: Matcher, source: string, m: CatalogModel): string | 'related' | undefined {
  if (matcher.has(m.id)) return m.id;
  let related = false;
  for (const name of [m.name, m.id]) {
    const hit = matcher.match(source, name, m.model_repo ? { url: m.model_repo } : {});
    if (hit && (hit.method === 'exact' || hit.method === 'link')) return hit.modelId;
    const base = withoutModes(name);
    if (hit || matcher.knows(name) || (base !== name && (matcher.match(source, base) || matcher.knows(base)))) related = true;
  }
  return related ? 'related' : undefined;
}

/**
 * A maker's name as earlier feeds wrote it: "google" and "Google DeepMind" become "Google", "Meta
 * AI" becomes "Meta". The whole name first, then its first word; anything else is kept as given.
 */
function providerNamer(): { learn: (p?: string) => void; name: (p?: string) => string | undefined } {
  const known = new Map<string, string>();
  return {
    learn(p) {
      if (p && !known.has(normalize(p))) known.set(normalize(p), p);
    },
    name(p) {
      if (!p) return p;
      const first = normalize(p.split(/[\s(/,&]+/)[0] ?? '');
      return known.get(normalize(p)) ?? (first.length >= 3 ? known.get(first) : undefined) ?? p;
    },
  };
}

export function mergeCatalogs(feeds: readonly Feed[]): { catalog: CatalogModel[]; stats: Map<string, FeedStats>; leftOut: Map<string, CatalogModel[]> } {
  const byId = new Map<string, CatalogModel>();
  const matcher = new Matcher([]);
  const providers = providerNamer();
  const stats = new Map<string, FeedStats>();
  const leftOut = new Map<string, CatalogModel[]>();

  feeds.forEach((feed, i) => {
    const st: FeedStats = { models: feed.models.length, added: 0, filled: 0, left_out: 0 };
    stats.set(feed.source, st);
    const models = [...feed.models].sort(byIdOrder);
    if (i === 0 && !feed.fillOnly) {
      // The first feed is the base: taken whole, snapshots and all.
      for (const m of models) {
        byId.set(m.id, m);
        matcher.add(m);
        providers.learn(m.provider);
      }
      st.added = byId.size;
      return;
    }
    for (const m of models) {
      // A fill-only feed names the catalogue model by its id.
      const target = feed.fillOnly ? (matcher.has(m.id) ? m.id : undefined) : sameModel(matcher, feed.source, m);
      if (target === 'related') {
        if (!feed.fillOnly) {
          st.left_out++;
          leftOut.set(feed.source, [...(leftOut.get(feed.source) ?? []), m]);
        }
        continue;
      }
      if (target) {
        const base = byId.get(target)!;
        const add: Partial<Record<Fillable, unknown>> = {};
        for (const k of FILLABLE) if (base[k] === undefined && m[k] !== undefined) add[k] = m[k];
        if (Object.keys(add).length) {
          const next = { ...base, ...add } as CatalogModel;
          byId.set(target, next);
          if (add.model_repo) matcher.add(next);
          st.filled++;
        }
        continue;
      }
      if (feed.fillOnly) continue;
      const model: CatalogModel = { ...m, origin: feed.source };
      const provider = providers.name(m.provider);
      if (provider) model.provider = provider;
      byId.set(model.id, model);
      matcher.add(model);
      providers.learn(model.provider);
      st.added++;
    }
  });
  return { catalog: [...byId.values()].sort(byIdOrder), stats, leftOut };
}

/** True for a source whose models only fill fields (`catalog: fill`). */
export const fillsOnly = (s: SourceConfig): boolean => s.options['catalog'] === 'fill';

/**
 * Every catalogue feed's saved models, in sources.yaml order. With `before`, only the feeds that
 * come before that source (a fill-only feed reads the catalogue the others made).
 */
export async function loadFeeds(sources: readonly SourceConfig[], before?: string): Promise<Feed[]> {
  const feeds: Feed[] = [];
  for (const s of sources) {
    if (s.id === before) break;
    if (s.terms !== 'allowed') continue;
    const models = await readJsonl<CatalogModel>(catalogPath(s.id));
    if (models.length) feeds.push({ source: s.id, models, ...(fillsOnly(s) && { fillOnly: true }) });
  }
  return feeds;
}

/** "Apache 2.0", "Apache-2.0" and "apache-2.0" as one licence, in the catalogue's lower-case style. */
export function licenseId(text: string | undefined): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  const k = t.toLowerCase().replace(/\s+license$/, '').replace(/[\s_]+/g, '-');
  if (/^apache-?2(\.0)?$/.test(k)) return 'apache-2.0';
  if (k === 'mit') return 'mit';
  if (k === 'proprietary') return 'proprietary';
  if (/^cc-by(-nc)?(-sa)?(-nd)?-4\.0$/.test(k)) return k;
  return t;
}
