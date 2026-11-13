/** Checks sources.yaml and the curation files. Exits non-zero, listing every problem found. */
import { ConfigError, loadSources } from './lib/config.ts';
import { checkCuration } from './lib/curation.ts';

try {
  const sources = await loadSources();
  const allowed = sources.filter((s) => s.terms === 'allowed').length;
  console.log(`sources.yaml OK: ${sources.length} sources (${allowed} allowed, ${sources.length - allowed} blocked)`);
  const problems = await checkCuration(sources.map((s) => s.id));
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exitCode = 1;
  } else {
    console.log('curation/ OK');
  }
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`sources.yaml: ${e.message}`);
  process.exitCode = 1;
}
