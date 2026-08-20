// Wave-2 grid: --scale-stages (item 1) and --no-positions/--no-opacity/
// --no-rotation/--no-scale (item 3). Run with:
//   node --experimental-strip-types test/wave2_grid.ts
//
// Same method as test/wave1_grid.ts: strict-IEEE reference binary
// (refbuild/) vs buildUncompressed(), full per-channel L2 on data/tiny.ply.
// Additionally runs an L1 round-trip: the .bek this port writes must decode
// through production bek_to_ply into the same PLY as the strict reference's
// own .bek decoded by the same binary (isolates this port's encoder/decoder
// from bek_to_ply's own -ffast-math, which doesn't matter for decode).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zstdDecompressSync } from 'node:zlib';
import { decodeCbor, CborFloat, type CborValue } from '../src/cbor.ts';
import { readPly, writePly } from '../src/ply.ts';
import { buildUncompressed, type EncodeOptions } from '../src/encode.ts';
import { writeBek } from '../src/container.ts';
import { decode } from '../src/decode.ts';

const tinyPlyPath = 'data/tiny.ply';
const refBinary = 'refbuild/src_copy/build/ply_to_bek';
const refDecoder = 'refbuild/src_copy/build/bek_to_ply';

if (!fs.existsSync(refBinary) || !fs.existsSync(refDecoder)) {
  throw new Error(`wave2_grid: missing ${refBinary} or ${refDecoder} -- see refbuild/README.md`);
}

interface Combo { label: string; cppArgs: string[]; opts: Partial<EncodeOptions> }

const combos: Combo[] = [
  { label: 'scale-stages=1', cppArgs: ['--scale-stages', '1'], opts: { scaleStages: 1 } },
  { label: 'scale-stages=2', cppArgs: ['--scale-stages', '2'], opts: { scaleStages: 2 } },
  { label: 'no-positions', cppArgs: ['--no-positions'], opts: { noPositions: true } },
  { label: 'no-opacity', cppArgs: ['--no-opacity'], opts: { noOpacity: true } },
  { label: 'no-rotation', cppArgs: ['--no-rotation'], opts: { noRotation: true } },
  { label: 'no-scale', cppArgs: ['--no-scale'], opts: { noScale: true } },
  {
    label: 'mixed: no-opacity/no-rotation + scale-stages=2',
    cppArgs: ['--no-opacity', '--no-rotation', '--scale-stages', '2'],
    opts: { noOpacity: true, noRotation: true, scaleStages: 2 },
  },
  {
    label: 'all no-*',
    cppArgs: ['--no-positions', '--no-opacity', '--no-rotation', '--no-scale'],
    opts: { noPositions: true, noOpacity: true, noRotation: true, noScale: true },
  },
];

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

const ply = readPly(tinyPlyPath);
let failCount = 0;

for (const combo of combos) {
  const t0 = performance.now();
  const tag = combo.label.replace(/[^a-z0-9]+/gi, '_');
  const outBek = path.join(os.tmpdir(), `wave2_grid_${tag}.bek`);
  execFileSync(refBinary, [tinyPlyPath, outBek, ...combo.cppArgs]);
  const raw = fs.readFileSync(outBek);
  const uncompressedSize = Number(raw.readBigUInt64LE(4));
  const refBuf = zstdDecompressSync(raw.subarray(12), { maxOutputLength: uncompressedSize });
  const ref = loadUncompressed(refBuf);
  const refChannels = channelsByName(ref.header);

  const mineBuf = buildUncompressed(ply, combo.opts);
  const mine = loadUncompressed(mineBuf);
  const mineChannels = channelsByName(mine.header);

  const refNames = [...refChannels.keys()].sort();
  const mineNames = [...mineChannels.keys()].sort();
  let comboOk = JSON.stringify(refNames) === JSON.stringify(mineNames);
  if (!comboOk) console.log(`  channel set mismatch: ref=${refNames.join(',')} mine=${mineNames.join(',')}`);

  for (const name of refNames) {
    const r = refChannels.get(name)!;
    const m = mineChannels.get(name);
    if (!m) { comboOk = false; console.log(`  ${name}: missing on TS side`); continue; }
    const rMeta = r.get('meta') as unknown as Map<string, CborValue>;
    const mMeta = m.get('meta') as unknown as Map<string, CborValue>;
    const metaOk = metaEqualExcludingCodec(rMeta, mMeta);
    const rOff = r.get('offset') as unknown as number, rSize = r.get('size') as unknown as number;
    const mOff = m.get('offset') as unknown as number, mSize = m.get('size') as unknown as number;
    const rBlob = ref.payload.subarray(rOff, rOff + rSize);
    const mBlob = mine.payload.subarray(mOff, mOff + mSize);
    const blobOk = rBlob.equals(mBlob);
    if (!metaOk || !blobOk) {
      comboOk = false;
      console.log(`  ${name}: meta=${metaOk} blob=${blobOk} (ref codec=${rMeta.get('codec')}, mine codec=${mMeta.get('codec')})`);
    }
  }

  // L1 round-trip: production bek_to_ply decodes both the strict reference's
  // own .bek and this port's .bek; the resulting PLYs must be identical.
  const tsBek = writeBek(mineBuf);
  const tsBekPath = path.join(os.tmpdir(), `wave2_grid_${tag}_ts.bek`);
  fs.writeFileSync(tsBekPath, tsBek);
  const refPlyPath = path.join(os.tmpdir(), `wave2_grid_${tag}_ref.ply`);
  const tsPlyPath = path.join(os.tmpdir(), `wave2_grid_${tag}_ts.ply`);
  execFileSync(refDecoder, [outBek, refPlyPath]);
  execFileSync(refDecoder, [tsBekPath, tsPlyPath]);
  const refPly = fs.readFileSync(refPlyPath);
  const tsPly = fs.readFileSync(tsPlyPath);
  const l1Ok = refPly.equals(tsPly);
  if (!l1Ok) { comboOk = false; console.log(`  L1 round-trip mismatch (production bek_to_ply): ref len=${refPly.length} ts len=${tsPly.length}`); }

  // Also check this port's own decoder against the same production .bek (L1, this port's decode path).
  const vdFromRef = decode(raw);
  const tsDecodedPath = path.join(os.tmpdir(), `wave2_grid_${tag}_tsdecoded.ply`);
  writePly(tsDecodedPath, vdFromRef);
  const tsDecoded = fs.readFileSync(tsDecodedPath);
  const l1DecOk = tsDecoded.equals(refPly);
  if (!l1DecOk) { comboOk = false; console.log(`  L1 this-port-decode(ref.bek) mismatch production bek_to_ply(ref.bek)`); }

  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${comboOk ? 'PASS' : 'FAIL'} [${combo.label}] (${ms} ms) args=${combo.cppArgs.join(' ')}`);
  if (!comboOk) failCount++;
}

if (failCount > 0) {
  console.error(`\n${failCount}/${combos.length} combos FAILED`);
  process.exitCode = 1;
} else {
  console.log(`\nALL ${combos.length} WAVE-2 (scale-stages, no-*) GRID COMBOS PASSED (L2 + L1)`);
}
