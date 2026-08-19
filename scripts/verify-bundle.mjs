// Anello 3 of `npm run verify`: proves the committed main.js/worker.js were
// actually produced by the committed sources -- rebuilds them (same esbuild
// options as the real build, see build-site.mjs) into a scratch dir and
// diffs byte-for-byte against the root main.js/worker.js. esbuild's output
// is deterministic for identical inputs/options/version, so any mismatch
// means the committed bundle didn't come from what's on disk right now.
import * as esbuild from 'esbuild';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { siteBuildOptions } from './build-site.mjs';

const tmp = 'scratch-verify/bundle-check';
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

await esbuild.build(siteBuildOptions(tmp));

let ok = true;
for (const name of ['main.js', 'worker.js']) {
  const committed = readFileSync(name);
  const rebuilt = readFileSync(`${tmp}/${name}`);
  if (committed.equals(rebuilt)) {
    console.log(`PASS: ${name} matches a fresh rebuild of the same sources (${committed.length} bytes)`);
  } else {
    console.log(`FAIL: committed ${name} (${committed.length} bytes) differs from a fresh rebuild (${rebuilt.length} bytes) -- run \`npm run build\` and commit the result`);
    ok = false;
  }
}

process.exitCode = ok ? 0 : 1;
