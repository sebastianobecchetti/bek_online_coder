// Builds the static site into docs/ (the directory GitHub Pages serves).
// Two bundles: main.js (page logic) and worker.js (the codec, off the main
// thread). No framework, no runtime dependency beyond the vendored wasm.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { bekAliasPlugin } from './esbuild-alias-plugin.mjs';

const outdir = 'docs';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: ['src/main.ts', 'src/worker.ts'],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  inject: ['src/buffer-polyfill.ts'],
  external: ['./vendor/webp.mjs'],
  plugins: [bekAliasPlugin],
});

cpSync('index.html', `${outdir}/index.html`);
cpSync('style.css', `${outdir}/style.css`);
mkdirSync(`${outdir}/vendor`, { recursive: true });
cpSync('vendor/webp.mjs', `${outdir}/vendor/webp.mjs`);
cpSync('vendor/webp.wasm', `${outdir}/vendor/webp.wasm`);

console.log(`Built to ${outdir}/`);
