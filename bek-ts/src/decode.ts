// Decoder covering the default operating point plus wave-2 items 1 (scale
// RVQ, vq_scale_s*) and 3 (--no-* "channel absent" defaults). Still not
// ported: km_dc/km_sh_ac (--dc-kmeans/--sh-kmeans), vq_sh1/2/3_s* (legacy
// banded SH), rotation_idx/split (--rot-split). See README.md for status.

import { decodeCbor, CborFloat, type CborValue } from './cbor.ts';
import { readBek } from './container.ts';
import { rc1Decode, rc2Decode, rcxDecode, posmagDecode, rotpackDecode } from './rangecoder.ts';
import { webpDecode } from './webp.ts';
import {
  dequantizePositionSpzZz, dequantizeOpacitySigmoid,
  unpackQuaternionSmallestThreeVar, dequantizeFromU8Levels,
} from './quantize.ts';
import { writePly, type VertexData } from './ply.ts';

type CMap = Map<string, CborValue>;

function unwrapFloat(v: CborValue): number {
  return v instanceof CborFloat ? v.value : (v as number);
}

// Decodes a channel's codec-specific blob into its raw (pre-quantization)
// byte plane. `codec` defaults to "webp" when absent, matching bek_to_ply.cpp
// (`m.value("codec", "webp")`).
function decodeChannelBlob(
  blob: Buffer, meta: CMap, count: number, stride: number, W: number, H: number,
  planeCache: Map<string, Uint8Array>,
): Uint8Array {
  const codec = (meta.get('codec') as unknown as string | undefined) ?? 'webp';
  const outSize = count * stride;
  switch (codec) {
    case 'raw':
      return blob.subarray(0, outSize);
    case 'rc2':
      return rc2Decode(blob, outSize, stride);
    case 'rc1':
      return rc1Decode(blob, outSize, stride);
    case 'rcx': {
      const ctxName = meta.get('ctx_ch') as unknown as string;
      const ctxPlane = planeCache.get(ctxName);
      if (!ctxPlane) throw new Error(`decode: rcx channel missing context plane '${ctxName}'`);
      return rcxDecode(blob, outSize, ctxPlane);
    }
    case 'posmag':
      return posmagDecode(blob, outSize);
    case 'rotpack':
      return rotpackDecode(blob, outSize, (meta.get('mag_bits') as unknown as number) ?? 6);
    case 'webp':
      return webpDecode(blob, outSize, W, H, stride as 1 | 3);
    default:
      throw new Error(`decode: unhandled codec '${codec}'`);
  }
}

export function decode(bek: Buffer): VertexData {
  const buf = readBek(bek);
  const headerSize = buf.readUInt32LE(0);
  const header = decodeCbor(buf.subarray(4, 4 + headerSize)) as CMap;
  const payload = buf.subarray(4 + headerSize);

  const N = header.get('count') as unknown as number;
  const W = header.get('width') as unknown as number;
  const H = header.get('height') as unknown as number;
  const channels = header.get('channels') as unknown as CMap[];

  const vd: VertexData = {
    count: N,
    x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N),
    opacity: new Float32Array(N),
    scale_0: new Float32Array(N), scale_1: new Float32Array(N), scale_2: new Float32Array(N),
    rot_0: new Float32Array(N), rot_1: new Float32Array(N), rot_2: new Float32Array(N), rot_3: new Float32Array(N),
    f_dc_0: new Float32Array(N), f_dc_1: new Float32Array(N), f_dc_2: new Float32Array(N),
    f_rest: Array.from({ length: 45 }, () => new Float32Array(N)),
  };

  const planeCache = new Map<string, Uint8Array>();
  let hadOpacity = false, hadRotation = false, hadScale = false;

  for (const ch of channels) {
    const name = ch.get('name') as unknown as string;
    const offset = ch.get('offset') as unknown as number;
    const size = ch.get('size') as unknown as number;
    const stride = ch.get('channels') as unknown as number;
    const meta = ch.get('meta') as unknown as CMap;
    const blob = payload.subarray(offset, offset + size);

    const raw = decodeChannelBlob(blob, meta, N, stride, W, H, planeCache);
    if (name.startsWith('vq_')) planeCache.set(name, raw);

    if (name === 'pos_x' || name === 'pos_y' || name === 'pos_z') {
      const frac = (meta.get('frac') as unknown as number) ?? 12;
      const dec = dequantizePositionSpzZz(raw, frac, N);
      if (name === 'pos_x') vd.x = dec; else if (name === 'pos_y') vd.y = dec; else vd.z = dec;
    } else if (name === 'opacity') {
      vd.opacity = dequantizeOpacitySigmoid(raw);
      hadOpacity = true;
    } else if (name === 'rotation') {
      const magBits = (meta.get('mag_bits') as unknown as number) ?? 6;
      const q = unpackQuaternionSmallestThreeVar(raw, N, magBits);
      vd.rot_0 = q.rot0; vd.rot_1 = q.rot1; vd.rot_2 = q.rot2; vd.rot_3 = q.rot3;
      hadRotation = true;
    } else if (name === 'scales') {
      const minV = (meta.get('min') as unknown as CborValue[]).map(unwrapFloat);
      const maxV = (meta.get('max') as unknown as CborValue[]).map(unwrapFloat);
      const packed = raw;
      const chData = [new Uint8Array(N), new Uint8Array(N), new Uint8Array(N)];
      for (let j = 0; j < N; j++) {
        chData[0][j] = packed[j * 3]; chData[1][j] = packed[j * 3 + 1]; chData[2][j] = packed[j * 3 + 2];
      }
      vd.scale_0 = dequantizeFromU8Levels(chData[0], 8, minV[0], maxV[0], N);
      vd.scale_1 = dequantizeFromU8Levels(chData[1], 8, minV[1], maxV[1], N);
      vd.scale_2 = dequantizeFromU8Levels(chData[2], 8, minV[2], maxV[2], N);
      hadScale = true;
    } else if (name.startsWith('vq_dc_s')) {
      const codebook = buildCodebook(meta, 3);
      for (let i = 0; i < N; i++) {
        const idx = raw[i];
        vd.f_dc_0[i] += codebook[idx * 3]; vd.f_dc_1[i] += codebook[idx * 3 + 1]; vd.f_dc_2[i] += codebook[idx * 3 + 2];
      }
    } else if (name.startsWith('vq_scale_s')) {
      // Scale RVQ (--scale-stages > 0): same accumulate-per-stage scheme as
      // vq_dc_s*, but into scale_0/1/2 (bek_to_ply.cpp's "vq_scale_s" branch).
      const codebook = buildCodebook(meta, 3);
      for (let i = 0; i < N; i++) {
        const idx = raw[i];
        vd.scale_0[i] += codebook[idx * 3]; vd.scale_1[i] += codebook[idx * 3 + 1]; vd.scale_2[i] += codebook[idx * 3 + 2];
      }
      hadScale = true;
    } else if (name.startsWith('vq_sh_ac_s')) {
      const dims = meta.get('dims') as unknown as number;
      const codebook = buildCodebook(meta, dims);
      for (let i = 0; i < N; i++) {
        const idx = raw[i];
        for (let d = 0; d < dims; d++) vd.f_rest[d][i] += codebook[idx * dims + d];
      }
    }
  }

  // "None per channel" defaults (bek_to_ply.cpp's FASE 2 block): a channel
  // absent from the header (--no-opacity/--no-rotation/--no-scale) gets a
  // renderable default instead of staying all-zero. Positions have no such
  // block in the C++ either -- absent positions decode to (0,0,0), which is
  // exactly what the zero-filled Float32Array above already gives.
  if (!hadOpacity) {
    // raw=255 -> alpha clamped to 1-1e-6 -> logit ~= 13.8155 (fully opaque).
    const opaqueLogit = dequantizeOpacitySigmoid(Uint8Array.of(255))[0];
    vd.opacity.fill(opaqueLogit);
  }
  if (!hadRotation) {
    // Identity quaternion; rot_0 is the real/w component in this codec's convention.
    vd.rot_0.fill(1); vd.rot_1.fill(0); vd.rot_2.fill(0); vd.rot_3.fill(0);
  }
  if (!hadScale) {
    vd.scale_0.fill(-5); vd.scale_1.fill(-5); vd.scale_2.fill(-5);
  }

  return vd;
}

function buildCodebook(meta: CMap, dims: number): Float32Array {
  const levels = (meta.get('levels') as unknown as CborValue[]).map(unwrapFloat);
  const cbIndices = meta.get('cb_indices') as unknown as number[];
  const codebook = new Float32Array(cbIndices.length);
  for (let i = 0; i < cbIndices.length; i++) codebook[i] = levels[cbIndices[i]];
  void dims; // codebook is already flattened per-entry (numClusters * dims), matches C++'s levels[idx] loop
  return codebook;
}

export function decodeToPly(bekPath: Buffer, outPlyPath: string): void {
  const vd = decode(bekPath);
  writePly(outPlyPath, vd);
}
