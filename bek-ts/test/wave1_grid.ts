// Full wave-1 flag grid, run separately from `test/vectors.ts` (RVQ is slow:
// each combo re-trains DC + SH-AC RVQ from scratch, ~5-12s depending on
// vq-iters/stages). Run with:
//   node --experimental-strip-types test/wave1_grid.ts
//
// For each combo: encode data/tiny.ply with the strict-IEEE reference binary
// (refbuild/src_copy/build/ply_to_bek, same flags) and with this port
// (buildUncompressed), then compare all 11 channels' meta (excluding `codec`)
// and blob byte-for-byte. Full L2 expected on every combo, same as the
// default point (test/vectors.ts F5) -- refbuild is strict IEEE, so there is
// no -ffast-math confound here, unlike comparing against the production
// binary.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zstdDecompressSync } from 'node:zlib';
import { decodeCbor, CborFloat, type CborValue } from '../src/cbor.ts';
import { readPly } from '../src/ply.ts';
import { buildUncompressed, type EncodeOptions } from '../src/encode.ts';

const tinyPlyPath = 'data/tiny.ply';
const refBinary = 'refbuild/src_copy/build/ply_to_bek';

if (!fs.existsSync(refBinary)) {
  throw new Error(`wave1_grid: missing ${refBinary} -- see refbuild/README.md`);
}

interface Combo { label: string; cppArgs: string[]; opts: Partial<EncodeOptions> }

const combos: Combo[] = [
  { label: 'default', cppArgs: [], opts: {} },
  { label: 'dc-stages=1', cppArgs: ['--dc-stages', '1'], opts: { dcStages: 1 } },
  { label: 'dc-stages=4', cppArgs: ['--dc-stages', '4'], opts: { dcStages: 4 } },
  { label: 'sh-stages=1', cppArgs: ['--sh-stages', '1'], opts: { shStages: 1 } },
  { label: 'sh-stages=6', cppArgs: ['--sh-stages', '6'], opts: { shStages: 6 } },
  { label: 'vq-iters=15', cppArgs: ['--vq-iters', '15'], opts: { vqIters: 15 } },
  { label: 'vq-iters=30(explicit)', cppArgs: ['--vq-iters', '30'], opts: { vqIters: 30 } },
  { label: 'pos-bits=9', cppArgs: ['--pos-bits', '9'], opts: { posFractionalBits: 9 } },
  { label: 'pos-bits=11', cppArgs: ['--pos-bits', '11'], opts: { posFractionalBits: 11 } },
  { label: 'sort-refine=0', cppArgs: ['--sort-refine', '0'], opts: { sortRefine: 0 } },
  { label: 'sort-refine=128(explicit)', cppArgs: ['--sort-refine', '128'], opts: { sortRefine: 128 } },
  { label: 'sort-refine=256', cppArgs: ['--sort-refine', '256'], opts: { sortRefine: 256 } },
  { label: 'rot-mag-bits=2', cppArgs: ['--rot-mag-bits', '2'], opts: { rotMagBits: 2 } },
  { label: 'rot-mag-bits=6', cppArgs: ['--rot-mag-bits', '6'], opts: { rotMagBits: 6 } },
  { label: 'no-rvq-cb-order', cppArgs: ['--no-rvq-cb-order'], opts: { cbChainOrder: false } },
  {
    label: 'mixed: dc4/sh6/iters15/pos11',
    cppArgs: ['--dc-stages', '4', '--sh-stages', '6', '--vq-iters', '15', '--pos-bits', '11'],
    opts: { dcStages: 4, shStages: 6, vqIters: 15, posFractionalBits: 11 },
  },
  {
    label: 'mixed: sort0/rot2/no-cb-order',
    cppArgs: ['--sort-refine', '0', '--rot-mag-bits', '2', '--no-rvq-cb-order'],
    opts: { sortRefine: 0, rotMagBits: 2, cbChainOrder: false },
  },
  {
    label: 'mixed: dc1/sh1/iters15/pos9/sort0',
    cppArgs: ['--dc-stages', '1', '--sh-stages', '1', '--vq-iters', '15', '--pos-bits', '9', '--sort-refine', '0'],
    opts: { dcStages: 1, shStages: 1, vqIters: 15, posFractionalBits: 9, sortRefine: 0 },
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
  const outBek = path.join(os.tmpdir(), `wave1_grid_${combo.label.replace(/[^a-z0-9]+/gi, '_')}.bek`);
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
  if (!comboOk) {
    console.log(`  channel set mismatch: ref=${refNames.join(',')} mine=${mineNames.join(',')}`);
  }

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

  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${comboOk ? 'PASS' : 'FAIL'} [${combo.label}] (${ms} ms) args=${combo.cppArgs.join(' ') || '(default)'}`);
  if (!comboOk) failCount++;
}

if (failCount > 0) {
  console.error(`\n${failCount}/${combos.length} combos FAILED`);
  process.exitCode = 1;
} else {
  console.log(`\nALL ${combos.length} WAVE-1 GRID COMBOS PASSED (full L2 on data/tiny.ply)`);
}
