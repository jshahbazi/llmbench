import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteImports } from '../scripts/site/client.ts';
import { esc, html, raw, up } from '../scripts/site/html.ts';
import { buildPages, fetchUrl, sitemap } from '../scripts/site/pages.ts';
import type { SiteData } from '../scripts/site/data.ts';
import { applyTags, checkTags } from '../scripts/lib/tags.ts';
import { fmt, isPermissive, paramsLabel, safeUrl, slugify } from '../site/src/format.ts';
import { pickBest, ranks, toCsv, type Candidate } from '../site/src/select.ts';
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
    unmatched: true,
    min: 1,
    sort: 'bfcl:Overall Acc',
    dir: 'asc' as const,
    cmp: ['a', 'b'],
    view: 'compare' as const,
  };
  assert.deepEqual(parseState(serializeState(s)), s);
  // Junk in the URL falls back to defaults rather than breaking the page.
  assert.deepEqual(parseState('?n=abc&by=9x&dir=sideways&min=-4'), { ...DEFAULTS, min: 0 });
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

test('links: only http(s); slugs; fetch locations', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://x.org'), 'https://x.org');
  assert.equal(slugify('Total Cost ($)'), 'total-cost');
  assert.equal(slugify('text_style_control/overall'), 'text-style-control-overall');
  assert.equal(fetchUrl('github:o/r/a/b.yml'), 'https://github.com/o/r/blob/HEAD/a/b.yml');
  assert.equal(fetchUrl('hf:org/ds'), 'https://huggingface.co/datasets/org/ds');
});

const cand = (value: number, runBy: number, date = ''): Candidate => ({
  value,
  runBy,
  date,
  context: '',
  url: null,
  interval: '',
  rawName: 'x',
  source: 's',
  history: null,
});

test('a cell shows the best included score; ties go to the newest', () => {
  const list = [cand(80, 2), cand(70, 0, '2026-01-01'), cand(70, 1, '2026-06-01')];
  assert.equal(pickBest(list, 'higher', new Set([0, 1, 2]))?.best.value, 80);
  const p = pickBest(list, 'higher', new Set([0, 1]));
  assert.equal(p?.best.date, '2026-06-01');
  assert.equal(p?.n, 2);
  assert.equal(pickBest(list, 'lower', new Set([0, 1, 2]))?.best.value, 70);
  assert.equal(pickBest(list, 'higher', new Set()), null);
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
      models: [{ id: 'm1', name: 'Model One' }, { id: 'unmatched:src:x', name: evil, unmatched: 'src' }],
      tags: [],
      stats: { invalid_excluded: 0, unparsable: 0, unmatched_models: 1 },
    },
    cells: [],
    byCell: new Map([
      ['0:0', [cand(70, 0)]],
      ['1:0', [{ ...cand(60, 0), url: 'javascript:alert(1)' }]],
    ]),
    modelColumns: new Map([[0, new Set([0])], [1, new Set([0])]]),
    columnModels: new Map([[0, new Set([0, 1])]]),
    names: new Map([['src', [{ raw: 'Model One', model: 0, method: 'name', qualifiers: '', rows: 1, scores: 1 }, { raw: evil, model: 1, method: '', qualifiers: '', rows: 1, scores: 1 }]]]),
    history: new Map(),
    config: [],
  };
  const pages = buildPages(d);
  const paths = pages.map((p) => p.path);
  for (const p of ['', 'models/m1/', 'benchmarks/', 'benchmarks/src/acc/', 'sources/', 'sources/src/', 'method/', 'data/', '404.html']) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => p.includes('unmatched')), 'no page for an unmatched name');
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
