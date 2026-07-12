// `npm run fuzz` — run every Jazzer.js target in ./fuzz for a short burst.
// Continuous fuzzing is done in CI by ClusterFuzzLite (.github/workflows/
// cflite.yml); this is the fast local repro loop. Targets import from ./dist,
// so `prefuzz` builds first. Override the per-target budget with FUZZ_SECONDS
// (default 30).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const targets = readdirSync(dir).filter((f) => f.endsWith('.fuzz.js')).sort();
const secs = process.env.FUZZ_SECONDS || '30';
// Run Jazzer's JS CLI directly under `node` — no .cmd wrapper, no shell, so a
// space in the repo path can't break the invocation.
const jazzerCli = createRequire(import.meta.url).resolve('@jazzer.js/core/dist/cli.js');

for (const t of targets) {
  console.log(`\n=== fuzzing ${t} (${secs}s) ===`);
  const r = spawnSync(
    process.execPath,
    [
      jazzerCli,
      `fuzz/${t.replace(/\.js$/, '')}`,
      '--sync',
      // Jazzer's ESM instrumentation can't compile dist/hook-pre-tool-use.js —
      // its shebang line (needed: the file ships as an executable hook script)
      // is a SyntaxError once the instrumenter re-emits it. Excluding it from
      // instrumentation only drops coverage feedback for that thin wrapper;
      // the guardrail matcher it calls stays instrumented. node_modules must
      // be re-listed because --excludes replaces the default exclude list.
      '--excludes', 'hook-pre-tool-use', 'node_modules',
      '--', `-max_total_time=${secs}`,
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) process.exit(r.status || 1);
}
