// Self-checks for F1 (ply.ts) and F2 (cbor.ts). Run with:
//   node --experimental-strip-types test/vectors.ts
// or, after `npm run build`:
//   node dist/../test/vectors.js  (not used; source run is the documented path)

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { readPly, writePly } from '../src/ply.ts';
import { encodeCbor, decodeCbor, CborFloat, type CborValue } from '../src/cbor.ts';
import { Mt19937, buildSubsetIndices, sampleSize, quantizeScalarLloyd } from '../src/rvq.ts';
import {
  rc1Encode, rc1Decode,
  rc2Encode, rc2Decode,
  rcxEncode, rcxDecode,
  posmagEncode, posmagDecode,
  rotpackEncode, rotpackDecode,
} from '../src/rangecoder.ts';
import { buildUncompressed } from '../src/encode.ts';
import { webpEncode, webpDecode } from '../src/webp.ts';
import { writeBek, readBek } from '../src/container.ts';
import { decode } from '../src/decode.ts';
import { execFileSync } from 'node:child_process';

// Run from the bek-ts repo root: node --experimental-strip-types test/vectors.ts
const tinyPlyPath = 'data/tiny.ply';

// --- F1a: readPly(tiny.ply) -> writePly -> cmp byte-identical with original ---
{
  const vd = readPly(tinyPlyPath);
  const outPath = '/tmp/bek_ts_tiny_roundtrip.ply';
  writePly(outPath, vd);
  const a = fs.readFileSync(tinyPlyPath);
  const b = fs.readFileSync(outPath);
  assert.ok(a.equals(b), `F1a: tiny.ply round-trip mismatch (len ${a.length} vs ${b.length})`);
  console.log('F1a OK: readPly(tiny.ply) -> writePly is byte-identical to the original');
}

// --- F1b: decode ref_tiny.bek with C++ bek_to_ply (done externally into /tmp/from_cpp_tiny.ply),
//          then readPly + writePly of that result -> cmp identical (validates 62-prop tinyply layout) ---
{
  const fromCppPath = '/tmp/from_cpp_tiny.ply';
  if (!fs.existsSync(fromCppPath)) {
    throw new Error(`F1b: missing ${fromCppPath} - run bek_to_ply on ref_tiny.bek first`);
  }
  const vd = readPly(fromCppPath);
  const outPath = '/tmp/bek_ts_from_cpp_roundtrip.ply';
  writePly(outPath, vd);
  const a = fs.readFileSync(fromCppPath);
  const b = fs.readFileSync(outPath);
  assert.ok(a.equals(b), `F1b: from_cpp_tiny.ply round-trip mismatch (len ${a.length} vs ${b.length})`);
  console.log('F1b OK: readPly(from_cpp_tiny.ply) -> writePly is byte-identical (62-prop layout confirmed)');
}

// --- F2: extract CBOR header from ref_tiny.bek, decodeCbor -> encodeCbor -> cmp byte-identical ---
{
  const cborPath = '/tmp/ref_tiny_header.cbor';
  if (!fs.existsSync(cborPath)) {
    throw new Error(`F2: missing ${cborPath} - extract it from ref_tiny.bek first`);
  }
  const original = fs.readFileSync(cborPath);
  const decoded = decodeCbor(original);
  const reEncoded = encodeCbor(decoded);
  assert.ok(original.equals(reEncoded), `F2: cbor round-trip mismatch (len ${original.length} vs ${reEncoded.length})`);
  console.log('F2 OK: decodeCbor -> encodeCbor byte-identical to ref_tiny.bek header');
}

// --- F3: mt19937 test vector + subset_indices probe cross-check ---
{
  const rng = new Mt19937(5489);
  let v = 0;
  for (let i = 0; i < 10000; i++) v = rng.next();
  assert.equal(v, 4123659995, 'F3: mt19937 seed=5489 10000th output must match the standard test vector');
  console.log('F3a OK: mt19937(5489) 10000th output === 4123659995');

  const numPoints = 20000;
  const ss = sampleSize(numPoints);
  assert.equal(ss, 5000, 'F3: sample_size(20000) must be 5000');
  const idx = buildSubsetIndices(numPoints, ss);
  const probePath = '/tmp/probe_subset_out.txt';
  if (!fs.existsSync(probePath)) {
    throw new Error(`F3b: missing ${probePath} - run test/probe_subset.cpp first`);
  }
  const lines = fs.readFileSync(probePath, 'utf8').trim().split('\n');
  const expected = lines[lines.length - 1].split(',').map(Number);
  const actual = Array.from(idx.slice(0, 200));
  assert.deepEqual(actual, expected, 'F3b: subset_indices[0..200) must match the C++ probe');
  console.log('F3b OK: subset_indices[0..200) byte-identical to the C++ probe (probe_subset.cpp)');
}

// quantize_scalar_lloyd sanity: converges to distinct levels on tiny data, num_levels capped at n.
{
  const data = Float32Array.from([1, 1, 1, 5, 5, 9, 9, 9, 9]);
  const q = quantizeScalarLloyd(data, 3, 20);
  assert.equal(q.levels.length, 3);
  assert.equal(q.indices.length, data.length);
  console.log('F3c OK: quantizeScalarLloyd smoke test (levels/indices shapes)');
}

// --- F4a: range coder self-check — decode(encode(buf)) === buf on random + degenerate data ---
{
  function randomBytes(n: number): Uint8Array {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
    return a;
  }

  const patterns: Array<[string, (n: number) => Uint8Array]> = [
    ['random', randomBytes],
    ['zeros', (n) => new Uint8Array(n)],
    ['0xFF', (n) => new Uint8Array(n).fill(0xff)],
  ];
  const sizes = [0, 1, 3, 300];
  const strides = [1, 3, 4];

  for (const [pname, gen] of patterns) {
    for (const n of sizes) {
      for (const stride of strides) {
        const data = gen(n);
        {
          const enc = rc1Encode(data, stride);
          const dec = rc1Decode(enc, n, stride);
          assert.deepEqual(Array.from(dec), Array.from(data), `F4a rc1 mismatch (${pname}, n=${n}, stride=${stride})`);
        }
        {
          const enc = rc2Encode(data, stride);
          const dec = rc2Decode(enc, n, stride);
          assert.deepEqual(Array.from(dec), Array.from(data), `F4a rc2 mismatch (${pname}, n=${n}, stride=${stride})`);
        }
        {
          const ctxPlane = gen(n);
          const enc = rcxEncode(data, ctxPlane);
          const dec = rcxDecode(enc, n, ctxPlane);
          assert.deepEqual(Array.from(dec), Array.from(data), `F4a rcx mismatch (${pname}, n=${n}, stride=${stride})`);
        }
      }
    }
    // posmag operates on 3-byte-per-splat data; any 24-bit value round-trips exactly.
    for (const n3 of [0, 3, 9, 900]) {
      const data = gen(n3);
      const enc = posmagEncode(data);
      const dec = posmagDecode(enc, n3);
      assert.deepEqual(Array.from(dec), Array.from(data), `F4a posmag mismatch (${pname}, n=${n3})`);
    }
  }

  // rotpack is a structured field codec, not a generic byte coder: only bit
  // patterns produced by packing valid (idx, sign, mag) fields round-trip
  // losslessly (bits outside the used field width are, by construction,
  // never present in real rotation channel data). Build test words that way.
  function packRotWord(idx: number, comps: Array<[number, number]>, magBits: number): number {
    const fw = magBits + 1;
    let word = idx << (3 * fw);
    for (let s = 0; s < 3; s++) {
      const [sgn, mag] = comps[s];
      const comp = (sgn << magBits) | mag;
      word |= comp << ((2 - s) * fw);
    }
    return word >>> 0;
  }

  for (const magBits of [1, 3, 6]) {
    const magMax = (1 << magBits) - 1;
    for (const n of [0, 1, 300]) {
      const data = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(Math.random() * 4);
        const comps: Array<[number, number]> = [
          [Math.round(Math.random()), Math.floor(Math.random() * (magMax + 1))],
          [Math.round(Math.random()), Math.floor(Math.random() * (magMax + 1))],
          [Math.round(Math.random()), Math.floor(Math.random() * (magMax + 1))],
        ];
        const word = packRotWord(idx, comps, magBits);
        data[i * 3] = word & 0xff;
        data[i * 3 + 1] = (word >>> 8) & 0xff;
        data[i * 3 + 2] = (word >>> 16) & 0xff;
      }
      const enc = rotpackEncode(data, magBits);
      const dec = rotpackDecode(enc, n * 3, magBits);
      assert.deepEqual(Array.from(dec), Array.from(data), `F4a rotpack mismatch (magBits=${magBits}, n=${n})`);
    }
    // degenerate: all-zero and all-max packed words.
    for (const [label, comps] of [
      ['zero', [[0, 0], [0, 0], [0, 0]] as Array<[number, number]>],
      ['max', [[1, magMax], [1, magMax], [1, magMax]] as Array<[number, number]>],
    ] as const) {
      const n = 300;
      const data = new Uint8Array(n * 3);
      const word = packRotWord(3, comps, magBits);
      for (let i = 0; i < n; i++) {
        data[i * 3] = word & 0xff;
        data[i * 3 + 1] = (word >>> 8) & 0xff;
        data[i * 3 + 2] = (word >>> 16) & 0xff;
      }
      const enc = rotpackEncode(data, magBits);
      const dec = rotpackDecode(enc, n * 3, magBits);
      assert.deepEqual(Array.from(dec), Array.from(data), `F4a rotpack degenerate mismatch (magBits=${magBits}, ${label})`);
    }
  }

  console.log('F4a OK: decode(encode(buf)) === buf for rc1/rc2/rcx/posmag/rotpack (random + degenerate patterns)');
}

// --- F4b: cross-check against ref_tiny.bek — decode C++ blob with TS decoder, re-encode, cmp bytes ---
{
  const bekPath = '/tmp/ref_tiny.bek';
  if (!fs.existsSync(bekPath)) {
    throw new Error(`F4b: missing ${bekPath} - run ./build/ply_to_bek data/tiny.ply /tmp/ref_tiny.bek first`);
  }
  const raw = fs.readFileSync(bekPath);
  if (raw.toString('ascii', 0, 4) !== 'BEK3') throw new Error('F4b: bad magic');
  const uncompressedSize = Number(raw.readBigUInt64LE(4));
  const buf = zstdDecompressSync(raw.subarray(12), { maxOutputLength: uncompressedSize });
  const headerSize = buf.readUInt32LE(0);
  const headerBuf = buf.subarray(4, 4 + headerSize);
  const payload = buf.subarray(4 + headerSize);
  const header = decodeCbor(headerBuf) as Map<string, CborValue>;
  const channels = header.get('channels') as unknown as Map<string, CborValue>[];
  const W = header.get('width') as unknown as number;
  const H = header.get('height') as unknown as number;

  const blobs = new Map<string, Buffer>();
  const codecs = new Map<string, string>();
  for (const ch of channels) {
    const name = ch.get('name') as unknown as string;
    const offset = ch.get('offset') as unknown as number;
    const size = ch.get('size') as unknown as number;
    const meta = ch.get('meta') as unknown as Map<string, CborValue>;
    const codec = meta.get('codec') as unknown as string;
    blobs.set(name, payload.subarray(offset, offset + size));
    codecs.set(name, codec);
  }

  let checked = 0;
  for (const ch of channels) {
    const name = ch.get('name') as unknown as string;
    const codec = codecs.get(name)!;
    const blob = blobs.get(name)!;
    const stride = ch.get('channels') as unknown as number;
    const meta = ch.get('meta') as unknown as Map<string, CborValue>;
    const outSize = stride * 20000; // count = 20000 for tiny.ply

    let decoded: Uint8Array;
    let reEncoded: Buffer;
    if (codec === 'webp') {
      decoded = webpDecode(blob, outSize, W, H, stride as 1 | 3);
      const padded = new Uint8Array(W * H * stride);
      padded.set(decoded);
      reEncoded = webpEncode(padded, W, H, stride as 1 | 3);
    } else if (codec === 'rc1') {
      decoded = rc1Decode(blob, outSize, stride);
      reEncoded = rc1Encode(decoded, stride);
    } else if (codec === 'rc2') {
      decoded = rc2Decode(blob, outSize, stride);
      reEncoded = rc2Encode(decoded, stride);
    } else if (codec === 'rcx') {
      const ctxName = meta.get('ctx_ch') as unknown as string;
      const ctxBlobEncoded = blobs.get(ctxName)!;
      const ctxCodec = codecs.get(ctxName)!;
      const ctxDecoded =
        ctxCodec === 'rc1' ? rc1Decode(ctxBlobEncoded, outSize, stride) : rc2Decode(ctxBlobEncoded, outSize, stride);
      decoded = rcxDecode(blob, outSize, ctxDecoded);
      reEncoded = rcxEncode(decoded, ctxDecoded);
    } else if (codec === 'posmag') {
      decoded = posmagDecode(blob, outSize);
      reEncoded = posmagEncode(decoded);
    } else if (codec === 'rotpack') {
      const magBits = meta.get('mag_bits') as unknown as number;
      decoded = rotpackDecode(blob, outSize, magBits);
      reEncoded = rotpackEncode(decoded, magBits);
    } else {
      throw new Error(`F4b: channel '${name}' uses unhandled codec '${codec}'`);
    }
    assert.ok(blob.equals(reEncoded), `F4b: channel '${name}' (codec ${codec}) re-encode mismatch (len ${blob.length} vs ${reEncoded.length})`);
    console.log(`F4b OK: channel '${name}' codec=${codec} decode->re-encode byte-identical to ref_tiny.bek`);
    checked++;
  }
  assert.ok(checked > 0, 'F4b: no channels were checked');
}

// --- F5: order.ts + quantize.ts + rvq.ts + partial encode.ts, per-channel L2 check ---
// The production C++ reference binary (build/ply_to_bek) is compiled with
// -ffast-math (see CMakeLists.txt:9 in the production repo). That legalizes
// FMA contraction / reassociation in the k-means training loop, which
// silently breaks strict per-operation IEEE-754 float32 rounding — the exact
// contract DESIGN.md §3.4 asks the port to replicate. Confirmed by building
// an independent strict-IEEE reference (refbuild/src_copy, -fno-fast-math
// -ffp-contract=off, see refbuild/README.md): levels[0][1] flips from
// -1.83009386 (production, -ffast-math) to -1.83009374 (strict), matching
// this port's -1.8300937414169312 to full precision). test/ref_tiny_strict.raw
// is the uncompressed buffer from that strict binary and is now the ground
// truth for the RVQ-trained channels below: vq_dc_s0/s1 and vq_sh_ac_s* are
// all hard-asserted meta+blob identical (WebP is a real shell-out to the same
// libwebp the C++ binary links -- see src/webp.ts -- so its blob is bit-exact
// too). This is full L2 on tiny.ply: 11/11 channels.
{
  function loadUncompressed(buf: Buffer): { header: Map<string, CborValue>; payload: Buffer } {
    const headerSize = buf.readUInt32LE(0);
    const header = decodeCbor(buf.subarray(4, 4 + headerSize)) as Map<string, CborValue>;
    const payload = buf.subarray(4 + headerSize);
    return { header, payload };
  }
  function channelsByName(header: Map<string, CborValue>): Map<string, Map<string, CborValue>> {
    const m = new Map<string, Map<string, CborValue>>();
    for (const ch of header.get('channels') as unknown as Map<string, CborValue>[]) {
      m.set(ch.get('name') as unknown as string, ch);
    }
    return m;
  }
  function unwrap(v: CborValue): unknown {
    if (v instanceof CborFloat) return v.value;
    if (Array.isArray(v)) return v.map(unwrap);
    return v;
  }
  function metaEqualExcludingCodec(a: Map<string, CborValue>, b: Map<string, CborValue>): boolean {
    const ak = [...a.keys()].filter((k) => k !== 'codec' && k !== 'ctx_ch').sort();
    const bk = [...b.keys()].filter((k) => k !== 'codec' && k !== 'ctx_ch').sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    for (const k of ak) {
      if (JSON.stringify(unwrap(a.get(k)!)) !== JSON.stringify(unwrap(b.get(k)!))) return false;
    }
    return true;
  }

  const refBuf = fs.readFileSync('test/ref_tiny.raw');
  const ref = loadUncompressed(refBuf);
  const refChannels = channelsByName(ref.header);

  // Strict-IEEE reference (refbuild/), used only for the RVQ-trained channels below.
  const refStrictBuf = fs.readFileSync('test/ref_tiny_strict.raw');
  const refStrict = loadUncompressed(refStrictBuf);
  const refStrictChannels = channelsByName(refStrict.header);

  const ply = readPly(tinyPlyPath);
  const t0 = performance.now();
  const mineBuf = buildUncompressed(ply);
  const encodeMs = performance.now() - t0;
  const mine = loadUncompressed(mineBuf);
  const mineChannels = channelsByName(mine.header);

  // Hard-asserted: no k-means/float-accumulation loop feeds these, so they
  // must be (and are) bit-exact regardless of -ffast-math in the reference build.
  const DETERMINISTIC = ['opacity', 'pos_x', 'pos_y', 'pos_z', 'rotation', 'scales'];
  // Soft-checked: RVQ-trained (train_vq_optimized's accumulation loop is
  // exactly what -ffast-math re-rounds in the reference build — see comment
  // above). vq_dc_s* still gets a hard blob check where the codec happens to
  // agree (rc1 on both sides) and the divergence didn't move the byte stream;
  // meta is reported, not asserted.
  const RVQ_TRAINED = ['vq_dc_s0', 'vq_dc_s1', 'vq_sh_ac_s0', 'vq_sh_ac_s1', 'vq_sh_ac_s2'];

  console.log(`F5 encode(tiny.ply) took ${encodeMs.toFixed(0)} ms`);
  console.log('F5 channel-by-channel report (meta excl. codec | blob):');

  for (const name of DETERMINISTIC) {
    const r = refChannels.get(name);
    const m = mineChannels.get(name);
    assert.ok(r && m, `F5: channel '${name}' missing from ${!r ? 'reference' : 'mine'}`);
    const rMeta = r!.get('meta') as unknown as Map<string, CborValue>;
    const mMeta = m!.get('meta') as unknown as Map<string, CborValue>;
    const metaOk = metaEqualExcludingCodec(rMeta, mMeta);
    const rOff = r!.get('offset') as unknown as number, rSize = r!.get('size') as unknown as number;
    const mOff = m!.get('offset') as unknown as number, mSize = m!.get('size') as unknown as number;
    const rBlob = ref.payload.subarray(rOff, rOff + rSize);
    const mBlob = mine.payload.subarray(mOff, mOff + mSize);
    const blobOk = rBlob.equals(mBlob);
    console.log(`  ${name.padEnd(12)} meta=${metaOk}  blob=${blobOk}  (ref codec=${rMeta.get('codec')}, mine codec=${mMeta.get('codec')})`);
    assert.ok(metaOk, `F5: channel '${name}' meta differs from ref_tiny.raw (excluding codec)`);
    assert.ok(blobOk, `F5: channel '${name}' blob differs from ref_tiny.raw byte-for-byte`);
  }
  console.log(`F5 OK: all ${DETERMINISTIC.length} deterministic channels are meta-identical and blob-identical to ref_tiny.raw`);

  for (const name of RVQ_TRAINED) {
    const r = refStrictChannels.get(name);
    const m = mineChannels.get(name);
    assert.ok(r && m, `F5: channel '${name}' missing from ${!r ? 'strict reference' : 'mine'}`);
    const rMeta = r!.get('meta') as unknown as Map<string, CborValue>;
    const mMeta = m!.get('meta') as unknown as Map<string, CborValue>;
    const metaOk = metaEqualExcludingCodec(rMeta, mMeta);
    const rOff = r!.get('offset') as unknown as number, rSize = r!.get('size') as unknown as number;
    const mOff = m!.get('offset') as unknown as number, mSize = m!.get('size') as unknown as number;
    const rBlob = refStrict.payload.subarray(rOff, rOff + rSize);
    const mBlob = mine.payload.subarray(mOff, mOff + mSize);
    const blobOk = rBlob.equals(mBlob);
    console.log(`  ${name.padEnd(12)} meta=${metaOk}  blob=${blobOk}  (strict ref codec=${rMeta.get('codec')}, mine codec=${mMeta.get('codec')})`);
    assert.ok(metaOk, `F5: channel '${name}' meta differs from strict-IEEE reference (excluding codec)`);
    assert.ok(blobOk, `F5: channel '${name}' blob differs from strict-IEEE reference byte-for-byte`);
  }
  console.log(
    'F5 OK: vq_dc_s0/s1 and vq_sh_ac_s* meta+blob are byte-identical to the strict-IEEE reference ' +
    '(refbuild/, -fno-fast-math) -- full L2 on tiny.ply, 11/11 channels.',
  );
}

// --- F6: container.ts + cli.ts, L1 TS->C++ ---
// The production bek_to_ply binary (-ffast-math) decodes a .bek this port
// wrote, and the result must match the strict-IEEE reference PLY (not the
// production one -- decoding doesn't re-run k-means, so -ffast-math is
// irrelevant on *this* side, but production ply_to_bek's own .bek was built
// with different RVQ codebooks than this port's, so /tmp/from_cpp_tiny.ply
// is not the honest comparison target here; /tmp/from_cpp_tiny_strict.ply is).
{
  // Path to a checkout of https://github.com/sebastianobecchetti/bek with its
  // binaries built (cmake -S . -B build && cmake --build build -j).
  const bekRepo = process.env.BEK_CPP_REPO ?? '../3DGS-Compression-C++';
  const prodBekToPly = `${bekRepo}/build/bek_to_ply`;
  const prodPlyToBek = `${bekRepo}/build/ply_to_bek`;
  const refBek = '/tmp/ref_tiny.bek';
  const strictPly = '/tmp/from_cpp_tiny_strict.ply';
  if (!fs.existsSync(prodBekToPly) || !fs.existsSync(strictPly)) {
    throw new Error('F6: missing production bek_to_ply or /tmp/from_cpp_tiny_strict.ply (see refbuild/README.md)');
  }
  const ply = readPly(tinyPlyPath);
  const uncompressed = buildUncompressed(ply);
  const tsBek = writeBek(uncompressed);
  fs.writeFileSync('/tmp/ts.bek', tsBek);

  execFileSync(prodBekToPly, ['/tmp/ts.bek', '/tmp/from_ts.ply']);
  const fromTs = fs.readFileSync('/tmp/from_ts.ply');
  const fromStrict = fs.readFileSync(strictPly);
  assert.ok(fromTs.equals(fromStrict), 'F6: bek_to_ply(ts.bek) != strict-IEEE reference PLY');
  console.log('F6 OK: production bek_to_ply decodes ts.bek into the strict-IEEE reference PLY, byte-identical');

  if (!fs.existsSync(refBek)) {
    execFileSync(prodPlyToBek, [tinyPlyPath, refBek]);
  }
  const refSize = fs.statSync(refBek).size;
  const tsSize = fs.statSync('/tmp/ts.bek').size;
  const ratio = tsSize / refSize;
  assert.ok(Math.abs(ratio - 1) <= 0.01, `F6: size(ts.bek)/size(ref.bek) = ${ratio.toFixed(4)}, expected within +/-1%`);
  console.log(`F6 OK: size(ts.bek)=${tsSize} size(ref.bek)=${refSize} ratio=${ratio.toFixed(4)} (within +/-1%)`);
}

// --- F7: decode.ts, L1 C++->TS ---
{
  const refBek = '/tmp/ref_tiny.bek';
  const fromCppPath = '/tmp/from_cpp_tiny.ply';
  if (!fs.existsSync(refBek) || !fs.existsSync(fromCppPath)) {
    throw new Error(`F7: missing ${refBek} or ${fromCppPath}`);
  }
  // Decoding never re-runs k-means, so -ffast-math is irrelevant here: the
  // production .bek decoded by our TS decoder must match production
  // bek_to_ply's own output exactly.
  const bek = fs.readFileSync(refBek);
  const vdFromProd = decode(bek);
  const outPathA = '/tmp/ts_out.ply';
  writePly(outPathA, vdFromProd);
  const a = fs.readFileSync(outPathA);
  const b = fs.readFileSync(fromCppPath);
  assert.ok(a.equals(b), 'F7: decode(ref_tiny.bek) != from_cpp_tiny.ply');
  console.log('F7 OK: TS decoder on production ref_tiny.bek is byte-identical to production bek_to_ply output');

  // Round-trip TS-only: decode this port's own ts.bek with this port's own decoder.
  if (fs.existsSync('/tmp/ts.bek')) {
    const tsBek = fs.readFileSync('/tmp/ts.bek');
    const vdFromTs = decode(tsBek);
    writePly('/tmp/ts_ts.ply', vdFromTs);
    const tsts = fs.readFileSync('/tmp/ts_ts.ply');
    const fromTs = fs.readFileSync('/tmp/from_ts.ply');
    assert.ok(tsts.equals(fromTs), 'F7: pure-TS round trip differs from production bek_to_ply decode of the same ts.bek');
    console.log('F7 OK: pure TS round trip (encode+decode) matches production bek_to_ply decoding the same ts.bek');
  }
  // sanity check readBek roundtrips its own container format
  const reReadBuf = readBek(writeBek(buildUncompressed(readPly(tinyPlyPath))));
  assert.ok(reReadBuf.length > 0, 'F7: readBek(writeBek(...)) sanity check');
}

console.log('ALL VECTORS PASSED');
