// Task A, step 1: encodes bek-ts/data/tiny.ply under Node using the exact
// same code path the browser worker uses (wasm-webp + zstd-raw, via
// esbuild-alias-plugin.mjs), and compares the pre-zstd uncompressed buffer
// byte-for-byte against bek-ts/test/ref_tiny_strict.raw (the existing,
// already-verified reference for the strict-IEEE / cwebp / node:zlib
// pipeline). Also writes the resulting .bek to scratch-verify/tiny.bek for
// step 2 (bek_to_ply decode check, done outside this script).
import { readFileSync, writeFileSync } from 'node:fs';
import { readPlyFromArrayBuffer } from '../src/ply-browser.ts';
import { buildUncompressed } from '../vendor/bek-ts/src/encode.ts';
import { writeBek } from '../vendor/bek-ts/src/container.ts';
import { initWebp } from '../src/webp-wasm.ts';

const plyPath = process.argv[2] ?? '../bek-ts/data/tiny.ply';
const refRawPath = process.argv[3] ?? '../bek-ts/test/ref_tiny_strict.raw';
const outBekPath = process.argv[4] ?? 'scratch-verify/tiny.bek';
const outRawPath = process.argv[5] ?? 'scratch-verify/tiny_new_pipeline.raw';

await initWebp();

const plyBuf = readFileSync(plyPath);
const ply = readPlyFromArrayBuffer(plyBuf.buffer.slice(plyBuf.byteOffset, plyBuf.byteOffset + plyBuf.byteLength));

const uncompressed = buildUncompressed(ply, {});
writeFileSync(outRawPath, uncompressed);

const ref = readFileSync(refRawPath);
const identical = ref.length === uncompressed.length && ref.equals(uncompressed);

console.log(`new-pipeline buffer: ${uncompressed.length} bytes`);
console.log(`reference buffer:    ${ref.length} bytes`);
if (identical) {
  console.log('PASS: pre-zstd uncompressed buffer is byte-identical to ref_tiny_strict.raw');
} else {
  console.log('FAIL: buffers differ');
  const n = Math.min(ref.length, uncompressed.length);
  let firstDiff = -1;
  for (let i = 0; i < n; i++) if (ref[i] !== uncompressed[i]) { firstDiff = i; break; }
  console.log(`first differing byte offset: ${firstDiff} (ref=${ref[firstDiff]}, got=${uncompressed[firstDiff]})`);
}

const bek = writeBek(uncompressed);
writeFileSync(outBekPath, bek);
console.log(`.bek written: ${outBekPath} (${bek.length} bytes)`);

process.exitCode = identical ? 0 : 1;
