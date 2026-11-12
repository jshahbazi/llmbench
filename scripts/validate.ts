/** Checks sources.yaml. Exits non-zero with the first problem found. */
import { ConfigError, loadSources } from './lib/config.ts';

try {
  const sources = await loadSources();
  const allowed = sources.filter((s) => s.terms === 'allowed').length;
  console.log(`sources.yaml OK: ${sources.length} sources (${allowed} allowed, ${sources.length - allowed} blocked)`);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`sources.yaml: ${e.message}`);
  process.exitCode = 1;
}
