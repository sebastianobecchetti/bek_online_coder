// Shared esbuild options for the site bundle (main.js + worker.js), used by
// both esbuild.config.mjs (the real build, output to repo root) and
// scripts/verify-bundle.mjs (Ring 3 of `npm run verify`: rebuilds to a
// scratch dir and diffs against the committed main.js/worker.js, so a
// bundle committed from different sources gets caught). Keeping this in one
// place means the two can never drift apart from each other.
import * as esbuild from 'esbuild';
import { bekAliasPlugin } from '../esbuild-alias-plugin.mjs';

export function siteBuildOptions(outdir) {
  return {
    entryPoints: ['src/main.ts', 'src/worker.ts'],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false, // no sourcemaps in production; worker.js.map alone was 126KB users never need
    inject: ['src/buffer-polyfill.ts'],
    // node:fs / node:url: only reached by src/zstd-wasm.ts's Node branch,
    // which never runs in a browser (guarded by a process.versions.node
    // check); external here just stops esbuild trying to bundle Node
    // builtins for a browser target.
    external: ['./vendor/webp.mjs', './vendor/zstd/zstd-wasm.mjs', 'node:fs', 'node:url'],
    plugins: [bekAliasPlugin],
  };
}
