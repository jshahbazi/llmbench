/**
 * Turns the browser code in site/src/*.ts into plain JavaScript modules by stripping the types
 * (Node's built-in stripper, no bundler). Imports keep working because ".ts" in relative import
 * specifiers is rewritten to ".js".
 */
import { readdir, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { writeText } from '../lib/store.ts';

export function rewriteImports(js: string): string {
  return js.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
}

export async function compileClient(srcDir: string, outDir: string): Promise<string[]> {
  const files = (await readdir(srcDir)).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const ts = await readFile(join(srcDir, f), 'utf8');
    const js = rewriteImports(stripTypeScriptTypes(ts, { mode: 'strip' }));
    await writeText(join(outDir, f.replace(/\.ts$/, '.js')), js);
  }
  return files;
}
