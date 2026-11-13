/**
 * Builds the site into site/dist from data/:
 *
 *   index.html, models/, benchmarks/, sources/, method/, data/   static pages
 *   data/index.json, data/cells/<source>.json                    what the explorer loads
 *   js/*.js                                                      the explorer, from site/src
 *   style.css, sitemap.xml, robots.txt, 404.html
 *
 * Run `npm run resolve` first so model names are matched.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileClient } from './site/client.ts';
import { loadSiteData } from './site/data.ts';
import { buildPages, SITE_URL, sitemap } from './site/pages.ts';

const OUT = join('site', 'dist');
const started = Date.now();

const d = await loadSiteData();
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'data', 'cells'), { recursive: true });

await writeFile(join(OUT, 'data', 'index.json'), JSON.stringify(d.index));
for (const f of d.cells) await writeFile(join(OUT, 'data', 'cells', `${f.source}.json`), JSON.stringify(f));

const pages = buildPages(d);
for (const p of pages) {
  const file = p.path === '' ? 'index.html' : p.path.endsWith('/') ? join(p.path, 'index.html') : p.path;
  await mkdir(join(OUT, file, '..'), { recursive: true });
  await writeFile(join(OUT, file), p.html);
}
await writeFile(join(OUT, 'sitemap.xml'), sitemap(pages));
await writeFile(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);

const scripts = await compileClient(join('site', 'src'), join(OUT, 'js'));
await cp(join('site', 'static'), OUT, { recursive: true });

const { index } = d;
const scores = d.cells.reduce((n, f) => n + f.cells.length, 0);
console.log(
  `site/dist: ${pages.length} pages, ${scripts.length} scripts; ${scores} scores, ${index.columns.length} columns, ` +
    `${index.models.length - index.stats.unmatched_models} models + ${index.stats.unmatched_models} unmatched names ` +
    `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
);
