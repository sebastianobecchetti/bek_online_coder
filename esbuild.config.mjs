// Builds the static site straight into the repo root, next to index.html
// and style.css -- that's where GitHub Pages serves this repo from (see
// README.md "Deploy"): Pages has no way to point at a build artifact that
// isn't committed, and there's no token/gh CLI available here to change the
// Pages source setting via the API. So the build output ships as committed
// files instead of a docs/ directory. Two bundles: main.js (page logic) and
// worker.js (the codec, off the main thread). No framework, no runtime
// dependency beyond the vendored wasm (webp + zstd).
import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';
import { siteBuildOptions } from './scripts/build-site.mjs';

// Only remove prior build output, never the whole directory (it's the repo root).
for (const f of ['main.js', 'main.js.map', 'worker.js', 'worker.js.map']) {
  rmSync(f, { force: true });
}

await esbuild.build(siteBuildOptions('.'));

console.log('Built main.js + worker.js to repo root. index.html, style.css, vendor/ already live there.');
