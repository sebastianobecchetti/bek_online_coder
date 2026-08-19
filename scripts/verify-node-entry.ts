// Anello 2 of `npm run verify`: encodes bek-ts/data/tiny.ply under Node
// using the exact same code path the browser worker uses (wasm-webp +
// wasm-zstd, via esbuild-alias-plugin.mjs), and checks two things:
//
//  1. The pre-zstd uncompressed buffer is byte-for-byte identical to
//     bek-ts/test/ref_tiny_strict.raw (the existing, already-verified
//     reference for the strict-IEEE / cwebp / node:zlib pipeline).
//  2. The resulting .bek, decoded by the real C++ reference decoder
//     (build/bek_to_ply), produces a PLY byte-identical to the one that
//     decoder produces from a reference .bek -- built by bek-ts's own CLI
//     (real cwebp + real node:zlib zstd), which is the pipeline already
//     proven L1-equivalent to the C++ encoder (see ../bek-ts/README.md
//     "Equivalence level reached"). This step needs both repos' binaries,
//     so it's skipped (not silently passed) when they aren't reachable --
//     e.g. always in CI.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readPlyFromArrayBuffer } from '../src/ply-browser.ts';
import { buildUncompressed } from '../vendor/bek-ts/src/encode.ts';
import { writeBek } from '../vendor/bek-ts/src/container.ts';
import { initWebp } from '../src/webp-wasm.ts';
import { initZstd } from '../src/zstd-wasm.ts';

const plyPath = process.argv[2] ?? '../bek-ts/data/tiny.ply';
const refRawPath = process.argv[3] ?? '../bek-ts/test/ref_tiny_strict.raw';
const outBekPath = process.argv[4] ?? 'scratch-verify/tiny.bek';
const outRawPath = process.argv[5] ?? 'scratch-verify/tiny_new_pipeline.raw';

await initWebp();
await initZstd();

const plyBuf = readFileSync(plyPath);
const ply = readPlyFromArrayBuffer(plyBuf.buffer.slice(plyBuf.byteOffset, plyBuf.byteOffset + plyBuf.byteLength));

const uncompressed = buildUncompressed(ply, {});
writeFileSync(outRawPath, uncompressed);

const ref = readFileSync(refRawPath);
let identical = ref.length === uncompressed.length && ref.equals(uncompressed);

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

// --- decode-diff step against the C++ reference decoder ---
const bekToPly = process.env.BEK_TO_PLY
  ?? '/Users/sebastianobecchetti/dev/Python/3DGS-Compression-C++/build/bek_to_ply';
const bekTsCli = '../bek-ts/src/cli.ts';
const bekTsRepo = '../bek-ts';

if (!existsSync(bekToPly)) {
  console.log(`SKIP: decode-diff step -- ${bekToPly} not found (needs the C++ build; not available in CI)`);
} else if (!existsSync(bekTsRepo)) {
  console.log(`SKIP: decode-diff step -- ${bekTsRepo} not found (sibling checkout needed to build the reference .bek; not available in CI)`);
} else {
  const refBekPath = 'scratch-verify/tiny_ref.bek';
  const refPlyPath = 'scratch-verify/tiny_ref.ply';
  const outPlyPath = 'scratch-verify/tiny_new_pipeline.ply';

  execFileSync('node', ['--experimental-strip-types', 'src/cli.ts', 'encode', 'data/tiny.ply', `../bek-online-coder/${refBekPath}`], { cwd: bekTsRepo, stdio: 'inherit' });
  execFileSync(bekToPly, [refBekPath, refPlyPath], { stdio: 'inherit' });
  execFileSync(bekToPly, [outBekPath, outPlyPath], { stdio: 'inherit' });

  const refPly = readFileSync(refPlyPath);
  const outPly = readFileSync(outPlyPath);
  const plyIdentical = refPly.length === outPly.length && refPly.equals(outPly);
  console.log(`reference PLY (from bek-ts CLI's .bek): ${refPly.length} bytes`);
  console.log(`browser-pipeline PLY (from ${outBekPath}): ${outPly.length} bytes`);
  if (plyIdentical) {
    console.log('PASS: bek_to_ply-decoded PLY is byte-identical to the reference decode');
  } else {
    console.log('FAIL: decoded PLYs differ');
    const n = Math.min(refPly.length, outPly.length);
    let firstDiff = -1;
    for (let i = 0; i < n; i++) if (refPly[i] !== outPly[i]) { firstDiff = i; break; }
    console.log(`first differing byte offset: ${firstDiff}`);
  }
  identical = identical && plyIdentical;
}

process.exitCode = identical ? 0 : 1;
