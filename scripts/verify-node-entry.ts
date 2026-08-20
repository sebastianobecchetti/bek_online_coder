// Ring 2 of `npm run verify`: encodes bek-ts/data/tiny.ply under Node
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
//     proven L1-equivalent to the C++ encoder (see bek-ts/README.md
//     "Equivalence level reached").
//  3. Ring 4: the DECODE direction. Takes a .bek produced by the real
//     C++ encoder (build/ply_to_bek on the same tiny.ply), decodes it with
//     this project's own browser code path (decode.ts + webp-wasm decode +
//     zstd-wasm decode), and diffs the resulting .ply byte-for-byte against
//     build/bek_to_ply decoding that exact same .bek. No tolerance: decode
//     never re-runs k-means, so there's no -ffast-math rounding question --
//     either the bytes match or there's a decoder bug.
// All three of these need both repos' binaries, so they're skipped (not
// silently passed) when unreachable -- e.g. always in CI.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readPlyFromArrayBuffer, writePlyToArrayBuffer } from '../src/ply-browser.ts';
import { buildUncompressed } from '../vendor/bek-ts/src/encode.ts';
import { writeBek } from '../vendor/bek-ts/src/container.ts';
import { decode } from '../vendor/bek-ts/src/decode.ts';
import { initWebp } from '../src/webp-wasm.ts';
import { initZstd } from '../src/zstd-wasm.ts';

const plyPath = process.argv[2] ?? 'bek-ts/data/tiny.ply';
const refRawPath = process.argv[3] ?? 'bek-ts/test/ref_tiny_strict.raw';
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
// A checkout of https://github.com/sebastianobecchetti/bek with its binaries
// built (cmake -S . -B build && cmake --build build -j).
const bekCppRepo = process.env.BEK_CPP_REPO ?? '../bek';
const bekToPly = process.env.BEK_TO_PLY ?? `${bekCppRepo}/build/bek_to_ply`;
const bekTsCli = 'bek-ts/src/cli.ts';
const bekTsRepo = 'bek-ts';

if (!existsSync(bekToPly)) {
  console.log(`SKIP: decode-diff step -- ${bekToPly} not found (needs the C++ build; not available in CI)`);
} else if (!existsSync(bekTsRepo)) {
  console.log(`SKIP: decode-diff step -- ${bekTsRepo} not found (bek-ts/ sources needed to build the reference .bek)`);
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

// --- Ring 4: decode direction, C++-produced .bek -> page decode vs bek_to_ply ---
const plyToBek = process.env.PLY_TO_BEK ?? `${bekCppRepo}/build/ply_to_bek`;

if (!existsSync(bekToPly)) {
  console.log(`SKIP: Ring 4 (decode direction) -- ${bekToPly} not found (needs the C++ build; not available in CI)`);
} else if (!existsSync(plyToBek)) {
  console.log(`SKIP: Ring 4 (decode direction) -- ${plyToBek} not found (needs the C++ build; not available in CI)`);
} else if (!existsSync(plyPath)) {
  console.log(`SKIP: Ring 4 (decode direction) -- ${plyPath} not found (bek-ts/data/tiny.ply is gitignored; cut it locally with bek-ts/test/probe_subset.cpp)`);
} else {
  const cppBekPath = 'scratch-verify/tiny_cpp.bek';
  const cppPlyByCppPath = 'scratch-verify/tiny_cpp_decoded_by_cpp.ply';
  const cppPlyByPagePath = 'scratch-verify/tiny_cpp_decoded_by_page.ply';

  // 1. A .bek from the real C++ encoder (not this project's TS port).
  execFileSync(plyToBek, [plyPath, cppBekPath], { stdio: 'inherit' });
  // 2. Decoded by the real C++ decoder.
  execFileSync(bekToPly, [cppBekPath, cppPlyByCppPath], { stdio: 'inherit' });
  // 3. Decoded by this project's own browser code path (wasm-webp decode + wasm-zstd decode).
  const cppBek = readFileSync(cppBekPath);
  const vd = decode(cppBek);
  const pagePly = writePlyToArrayBuffer(vd);
  writeFileSync(cppPlyByPagePath, pagePly);

  const plyByCpp = readFileSync(cppPlyByCppPath);
  const plyByPage = readFileSync(cppPlyByPagePath);
  const decodeIdentical = plyByCpp.length === plyByPage.length && plyByCpp.equals(plyByPage);
  console.log(`bek_to_ply decode of C++ .bek:  ${plyByCpp.length} bytes`);
  console.log(`this page's decode of same .bek: ${plyByPage.length} bytes`);
  if (decodeIdentical) {
    console.log('PASS: Ring 4 -- page-decoded PLY is byte-identical to bek_to_ply decoding the same C++-produced .bek');
  } else {
    console.log('FAIL: Ring 4 -- decoded PLYs differ');
    const n = Math.min(plyByCpp.length, plyByPage.length);
    let firstDiff = -1;
    for (let i = 0; i < n; i++) if (plyByCpp[i] !== plyByPage[i]) { firstDiff = i; break; }
    console.log(`first differing byte offset: ${firstDiff}`);
  }
  identical = identical && decodeIdentical;
}

process.exitCode = identical ? 0 : 1;
