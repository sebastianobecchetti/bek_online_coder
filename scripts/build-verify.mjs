// Builds a Node-runnable bundle of the exact same encode path the browser
// worker uses (wasm-webp + wasm-zstd, via the same esbuild-alias-plugin), for
// the "run the same new paths under Node" equivalence check (Ring 2 of
// `npm run verify`). Output goes to scratch-verify/ (gitignored), never the
// committed main.js/worker.js at repo root.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { bekAliasPlugin } from '../esbuild-alias-plugin.mjs';

const outdir = 'scratch-verify';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: ['scripts/verify-node-entry.ts'],
  outfile: `${outdir}/verify-node-entry.js`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['./vendor/webp.mjs', './vendor/zstd/zstd-wasm.mjs'],
  plugins: [bekAliasPlugin],
});

mkdirSync(`${outdir}/vendor`, { recursive: true });
mkdirSync(`${outdir}/vendor/zstd`, { recursive: true });
cpSync('vendor/webp.mjs', `${outdir}/vendor/webp.mjs`);
cpSync('vendor/webp.wasm', `${outdir}/vendor/webp.wasm`);
cpSync('vendor/zstd/zstd-wasm.mjs', `${outdir}/vendor/zstd/zstd-wasm.mjs`);
cpSync('vendor/zstd/zstd.wasm', `${outdir}/vendor/zstd/zstd.wasm`);

console.log(`Built to ${outdir}/`);
