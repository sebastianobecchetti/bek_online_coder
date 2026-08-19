// Builds a Node-runnable bundle of the exact same encode path the browser
// worker uses (wasm-webp + zstd-raw, via the same esbuild-alias-plugin), for
// task A's "run the same new paths under Node" equivalence check. Output
// goes to scratch-verify/ (gitignored), never docs/.
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
  external: ['./vendor/webp.mjs'],
  plugins: [bekAliasPlugin],
});

mkdirSync(`${outdir}/vendor`, { recursive: true });
cpSync('vendor/webp.mjs', `${outdir}/vendor/webp.mjs`);
cpSync('vendor/webp.wasm', `${outdir}/vendor/webp.wasm`);

console.log(`Built to ${outdir}/`);
