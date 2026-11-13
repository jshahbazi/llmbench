/**
 * Builds the site into site/dist from data/:
 *
 *   index.html, models/, benchmarks/, sources/, method/, data/   static pages
 *   data/index.json, data/cells/<source>.json                    what the explorer loads
 *   downloads/                                                   CSV, Parquet and SQLite
 *   js/*.js                                                      the explorer and SQL console, from site/src
 *   vendor/sql.js/                                               SQLite in WebAssembly for the SQL console
 *   style.css, sitemap.xml, robots.txt, 404.html
 *
 * Run `npm run resolve` first so model names are matched.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileClient } from './site/client.ts';
import { loadSiteData } from './site/data.ts';
import { writeDownloads } from './site/exports.ts';
import { buildPages, SITE_URL, sitemap } from './site/pages.ts';

const OUT = join('site', 'dist');
const started = Date.now();

const d = await loadSiteData();
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'data', 'cells'), { recursive: true });
await mkdir(join(OUT, 'downloads'), { recursive: true });

await writeFile(join(OUT, 'data', 'index.json'), JSON.stringify(d.index));
for (const f of d.cells) await writeFile(join(OUT, 'data', 'cells', `${f.source}.json`), JSON.stringify(f));

const downloads = await writeDownloads(d, join(OUT, 'downloads'));
const pages = buildPages(d, downloads);
for (const p of pages) {
  const file = p.path === '' ? 'index.html' : p.path.endsWith('/') ? join(p.path, 'index.html') : p.path;
  await mkdir(join(OUT, file, '..'), { recursive: true });
  await writeFile(join(OUT, file), p.html);
}
await writeFile(join(OUT, 'sitemap.xml'), sitemap(pages));
await writeFile(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);

const scripts = await compileClient(join('site', 'src'), join(OUT, 'js'));
await cp(join('site', 'static'), OUT, { recursive: true });
// SQLite for the SQL console, from the pinned sql.js package (MIT).
const sqljs = join('node_modules', 'sql.js');
await mkdir(join(OUT, 'vendor', 'sql.js'), { recursive: true });
for (const [from, to] of [
  ['dist/sql-wasm.js', 'sql-wasm.js'],
  ['dist/sql-wasm.wasm', 'sql-wasm.wasm'],
  ['LICENSE', 'LICENSE'],
]) {
  await cp(join(sqljs, from!), join(OUT, 'vendor', 'sql.js', to!));
}

const { index } = d;
const scores = d.cells.reduce((n, f) => n + f.cells.length, 0);
console.log(
  `site/dist: ${pages.length} pages, ${scripts.length} scripts; ${scores} scores, ${index.columns.length} columns, ` +
    `${index.models.length} models (${index.stats.unlisted_models} not in the catalogue), ${downloads.length} downloads ` +
    `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
);
