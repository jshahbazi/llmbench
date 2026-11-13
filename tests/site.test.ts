import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteImports } from '../scripts/site/client.ts';
import { esc, html, raw, up } from '../scripts/site/html.ts';
import { buildPages, fetchUrl, sitemap } from '../scripts/site/pages.ts';
import type { SiteData } from '../scripts/site/data.ts';
import { applyTags, checkTags } from '../scripts/lib/tags.ts';
import { dataReuse, fmt, isPermissive, paramsLabel, safeUrl, slugify } from '../site/src/format.ts';
import { FLAG_QUANTIZED, FLAG_SEARCH, pickBest, ranks, toCsv, type Candidate } from '../site/src/select.ts';
import { DEFAULTS, parseState, serializeState } from '../site/src/state.ts';

test('URL state: defaults serialize to nothing, and every field round-trips', () => {
  assert.equal(serializeState(DEFAULTS), '');
  const s = {
    ...DEFAULTS,
    cols: ['arena:text/overall', 'bfcl:Overall Acc'],
    tag: 'coding',
    q: 'qwen',
    since: 12,
    open: true,
    permissive: true,
    size: -250,
    maker: 'Alibaba',
    runBy: [0, 1],
    unlisted: false,
    plain: true,
    min: 1,
    sort: 'bfcl:Overall Acc',
    dir: 'asc' as const,
    cmp: ['a', 'b'],
    view: 'compare' as const,
  };
  assert.deepEqual(parseState(serializeState(s)), s);
  // Junk in the URL falls back to defaults rather than breaking the page.
  assert.deepEqual(parseState('?n=abc&by=9x&dir=sideways&min=-4'), { ...DEFAULTS, min: 0 });
  // Old links that asked to show unmatched names still show them (now the default).
  assert.equal(parseState('?um=1').unlisted, true);
});

test('number formatting by unit', () => {
  assert.equal(fmt(0.873, 'fraction'), '87.3');
  assert.equal(fmt(77.47, 'percent'), '77.5');
  assert.equal(fmt(1473.6, 'elo'), '1474');
  assert.equal(fmt(0.0123, 'score'), '0.01');
  assert.equal(paramsLabel(235, 22), '235B-A22B');
  assert.equal(paramsLabel(1.73, 1.73), '1.7B');
});

test('permissive licences exclude custom and non-commercial ones', () => {
  for (const l of ['apache-2.0', 'MIT', 'bsd-3-clause', 'cc-by-4.0']) assert.ok(isPermissive(l), l);
  for (const l of ['llama3.3', 'gemma', 'cc-by-nc-4.0', 'proprietary', undefined]) assert.ok(!isPermissive(l), String(l));
});

test('source licences: stated, non-commercial, or none', () => {
  assert.equal(dataReuse('MIT'), 'licensed');
  assert.equal(dataReuse('CC BY 4.0'), 'licensed');
  assert.equal(dataReuse('CC BY-NC 4.0'), 'noncommercial');
  assert.equal(dataReuse('none stated'), 'unstated');
  assert.equal(dataReuse(undefined), 'unstated');
});

test('links: only http(s); slugs; fetch locations', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://x.org'), 'https://x.org');
  assert.equal(slugify('Total Cost ($)'), 'total-cost');
  assert.equal(slugify('text_style_control/overall'), 'text-style-control-overall');
  assert.equal(fetchUrl('github:o/r/a/b.yml'), 'https://github.com/o/r/blob/HEAD/a/b.yml');
  assert.equal(fetchUrl('hf:org/ds'), 'https://huggingface.co/datasets/org/ds');
});

const cand = (value: number, runBy: number, date = '', flags = 0): Candidate => ({
  value,
  runBy,
  date,
  context: '',
  url: null,
  interval: '',
  rawName: 'x',
  source: 's',
  history: null,
  flags,
});

test('a cell shows the best included score; ties go to the newest', () => {
  const list = [cand(80, 2), cand(70, 0, '2026-01-01'), cand(70, 1, '2026-06-01')];
  assert.equal(pickBest(list, 'higher', new Set([0, 1, 2]))?.best.value, 80);
  const p = pickBest(list, 'higher', new Set([0, 1]));
  assert.equal(p?.best.date, '2026-06-01');
  assert.equal(p?.n, 2);
  assert.equal(pickBest(list, 'lower', new Set([0, 1, 2]))?.best.value, 70);
  assert.equal(pickBest(list, 'higher', new Set()), null);
  // "Plain runs only" leaves out flagged runs, such as a quantized model's.
  const flagged = [cand(90, 0, '', FLAG_QUANTIZED), cand(85, 0, '', FLAG_SEARCH), cand(60, 0)];
  assert.equal(pickBest(flagged, 'higher', new Set([0]))?.best.value, 90);
  assert.equal(pickBest(flagged, 'higher', new Set([0]), FLAG_QUANTIZED | FLAG_SEARCH)?.best.value, 60);
});

test('competition ranks and CSV escaping', () => {
  assert.deepEqual(ranks([90, 95, 90, 80], 'higher'), [2, 1, 2, 4]);
  assert.deepEqual(ranks([1, 3, 2], 'lower'), [1, 3, 2]);
  assert.equal(toCsv([['a, b', 'say "hi"', '=SUM(A1)', 3]]), '"a, b","say ""hi""","=SUM(A1)",3\r\n');
});

test('html escapes everything that is not already Html', () => {
  assert.equal(esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(html`<p>${'<b>'}${raw('<i>ok</i>')}${['<', 1]}</p>`.value, '<p>&lt;b&gt;<i>ok</i>&lt;1</p>');
  assert.equal(up(0), './');
  assert.equal(up(2), '../../');
});

test('compiled browser modules import .js files', () => {
  assert.equal(rewriteImports(`import { a } from './format.ts';\nimport x from "../y.ts";`), `import { a } from './format.js';\nimport x from "../y.js";`);
  assert.equal(rewriteImports(`import 'https://cdn/x.ts';`), `import 'https://cdn/x.ts';`);
});

test('tags: lists, glob mappings, and unknown tags are rejected', () => {
  const metrics = [
    { id: 'text/overall', label: 't', direction: 'higher' as const, unit: 'elo' },
    { id: 'webdev/overall', label: 'w', direction: 'higher' as const, unit: 'elo', tags: ['chat'] },
  ];
  assert.deepEqual(applyTags(metrics, { 'webdev/*': ['coding'] }).map((m) => m.tags), [undefined, ['chat', 'coding']]);
  assert.deepEqual(applyTags(metrics, ['agents']).map((m) => m.tags), [['agents'], ['agents', 'chat']]);
  assert.deepEqual(checkTags({ x: ['coding'] }, 's'), []);
  assert.match(checkTags(['cooking'], 's')[0]!, /unknown tag "cooking"/);
});

test('pages escape scraped text and link every model and column', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const d: SiteData = {
    index: {
      generated_at: '2026-11-13T00:00:00Z',
      sources: [
        { id: 'src', name: 'Source', homepage: 'https://src.example', terms: 'allowed', every: '6h', row_count: 2, metric_count: 1, names: 2, matched_names: 1, license: 'MIT' },
      ],
      columns: [{ id: 'src:acc', source: 'src', metric: 'acc', label: `Accuracy ${evil}`, direction: 'higher', unit: 'percent', headline: true, slug: 'acc', coverage: 1 }],
      models: [{ id: 'm1', name: 'Model One' }, { id: 'x', name: evil, unlisted: true }],
      tags: [],
      stats: { invalid_excluded: 0, unparsable: 0, unlisted_models: 1 },
    },
    cells: [],
    byCell: new Map([
      ['0:0', [cand(70, 0)]],
      ['1:0', [{ ...cand(60, 0), url: 'javascript:alert(1)' }]],
    ]),
    modelColumns: new Map([[0, new Set([0])], [1, new Set([0])]]),
    columnModels: new Map([[0, new Set([0, 1])]]),
    names: new Map([['src', [{ raw: 'Model One', model: 0, method: 'exact', qualifiers: '', rows: 1, scores: 1 }, { raw: evil, model: 1, method: 'unlisted', qualifiers: evil, rows: 1, scores: 1 }]]]),
    history: new Map(),
    scores: [],
    config: [],
  };
  const pages = buildPages(d);
  const paths = pages.map((p) => p.path);
  for (const p of ['', 'models/m1/', 'models/x/', 'benchmarks/', 'benchmarks/src/acc/', 'sources/', 'sources/src/', 'method/', 'data/', '404.html']) assert.ok(paths.includes(p), p);
  assert.match(pages.find((p) => p.path === 'models/x/')!.html, /Not in the model catalogue/);
  for (const p of pages) {
    assert.ok(!p.html.includes('<img src=x'), `raw markup leaked into ${p.path || 'index'}`);
    assert.ok(!p.html.includes('javascript:alert'), `unsafe link in ${p.path || 'index'}`);
  }
  const board = pages.find((p) => p.path === 'benchmarks/src/acc/')!.html;
  assert.ok(board.includes('href="../../../models/m1/"'));
  const rows = board.slice(board.indexOf('<tbody>'));
  assert.ok(rows.indexOf('Model One') < rows.indexOf('&lt;img'), 'higher score ranks first');
  assert.match(sitemap(pages), /<loc>https:\/\/llmbench\.site\/models\/m1\/<\/loc>/);
});

test('display settings from sources.yaml apply at build time', async () => {
  const { presentMetrics } = await import('../scripts/lib/tags.ts');
  const metrics = [
    { id: 'a', label: 'a', direction: 'higher' as const, unit: 'score', headline: true },
    { id: 'b', label: 'b', direction: 'higher' as const, unit: 'score' },
  ];
  assert.deepEqual(presentMetrics(metrics, {}), metrics);
  assert.deepEqual(
    presentMetrics(metrics, { labels: { a: 'Alpha' }, headline: ['b'], tags: { a: ['math'] } }).map((m) => [m.label, m.headline, m.tags]),
    [['Alpha', false, ['math']], ['b', true, undefined]],
  );
});

test('downloads: CSV, Parquet and SQLite hold the same scores', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { asyncBufferFromFile, parquetReadObjects } = await import('hyparquet');
  const { writeDownloads } = await import('../scripts/site/exports.ts');
  const d: SiteData = {
    index: {
      generated_at: '2026-11-13T00:00:00Z',
      sources: [{ id: 'src', name: 'Source', homepage: 'https://src.example', terms: 'allowed', every: '6h', row_count: 2, metric_count: 1, names: 2, matched_names: 1, license: 'MIT' }],
      columns: [{ id: 'src:acc', source: 'src', metric: 'acc', label: 'Accuracy', direction: 'higher', unit: 'percent', headline: true, slug: 'acc', coverage: 2 }],
      models: [{ id: 'm1', name: 'Model One', provider: 'Lab', params_b: 7 }, { id: 'x', name: 'Name, with "quotes"', unlisted: true }],
      tags: [],
      stats: { invalid_excluded: 0, unparsable: 0, unlisted_models: 1 },
    },
    cells: [],
    byCell: new Map(),
    modelColumns: new Map(),
    columnModels: new Map(),
    names: new Map([['src', [{ raw: 'm-one_high', model: 0, method: 'variant', qualifiers: 'high effort', rows: 1, scores: 1 }]]]),
    history: new Map(),
    scores: [
      { model: 0, column: 0, value: 71.5, raw: '71.5%', runBy: 'independent', date: '2026-01-02', context: 'high effort', rawName: 'm-one_high', url: 'https://src.example/1', ciLow: '70', ciHigh: '73', rowKey: 'a' },
      { model: 1, column: 0, value: 60, raw: '60', runBy: 'submitted', date: '', context: '', rawName: 'Name, with "quotes"', url: '', ciLow: '', ciHigh: '', rowKey: 'b' },
    ],
    config: [],
  };
  const dir = await mkdtemp(join(tmpdir(), 'llmbench-'));
  try {
    const files = await writeDownloads(d, dir);
    assert.deepEqual(files.map((f) => f.file), ['llmbench-scores.csv', 'llmbench-models.csv', 'llmbench-benchmarks.csv', 'llmbench-names.csv', 'llmbench-sources.csv', 'llmbench-scores.parquet', 'llmbench.sqlite']);
    const csv = await readFile(join(dir, 'llmbench-scores.csv'), 'utf8');
    assert.match(csv, /^model_id,model,in_catalogue,source,source_license,column_id,benchmark,/);
    assert.match(csv, /x,"Name, with ""quotes""",false,src,MIT,src:acc,Accuracy,acc,60,percent,true,60,submitted,,,/);

    const rows = await parquetReadObjects({ file: await asyncBufferFromFile(join(dir, 'llmbench-scores.parquet')) });
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0]!['model_id'], rows[0]!['value'], rows[0]!['ci_low'], rows[0]!['in_catalogue']], ['m1', 71.5, 70, true]);
    assert.deepEqual([rows[1]!['date'], rows[1]!['ci_low']], [null, null]);
    assert.equal(rows[0]!['source_license'], 'MIT');

    const db = new DatabaseSync(join(dir, 'llmbench.sqlite'), { readOnly: true });
    try {
      const got = db.prepare('SELECT model, benchmark, value, context FROM scores_named ORDER BY value DESC').all();
      assert.deepEqual(got.map((r) => ({ ...r })), [
        { model: 'Model One', benchmark: 'Accuracy', value: 71.5, context: 'high effort' },
        { model: 'Name, with "quotes"', benchmark: 'Accuracy', value: 60, context: null },
      ]);
      assert.equal((db.prepare('SELECT in_catalogue FROM models WHERE id = ?').get('x') as { in_catalogue: number }).in_catalogue, 0);
      assert.deepEqual({ ...db.prepare('SELECT license, reuse FROM sources').get() }, { license: 'MIT', reuse: 'licensed' });
      assert.equal((db.prepare('SELECT DISTINCT source_license FROM scores_named').get() as { source_license: string }).source_license, 'MIT');
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
