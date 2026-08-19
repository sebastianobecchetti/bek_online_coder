// Partial encoder (F5 scope): assembles the 11 default-op-point channels,
// picks the best-of codec per channel, and writes the pre-zstd uncompressed
// buffer (uint32 header_size + CBOR header + payload). zstd wrapping and the
// CLI are out of scope here (F6). See DESIGN.md §0 (frozen default op point),
// §1.3 (container layout), §3.8 (channel sort + best-of priority order).

import type { VertexData } from './ply.ts';
import { encodeCbor, CborFloat, type CborValue } from './cbor.ts';
import { sortMorton, reorder } from './order.ts';
import {
  quantizePositionSpzZz, quantizeOpacitySigmoid,
  packQuaternionSmallestThreeVar, quantizeToU8Levels,
} from './quantize.ts';
import { computeRvq, packRvqPooled } from './rvq.ts';
import { rc1Encode, rc2Encode, rcxEncode, posmagEncode, rotpackEncode } from './rangecoder.ts';
import { webpEncode } from './webp.ts';

// Frozen default operating point (DESIGN.md §0) + wave-1 CLI-parametrized
// flags (ply_to_bek.cpp:80-182). Defaults below match the C++ defaults
// exactly; an empty `opts` on buildUncompressed() stays byte-identical to
// the pre-flag behavior.
export interface EncodeOptions {
  dcStages: number;
  shStages: number;
  posFractionalBits: number;
  rotMagBits: number; // clamped 2..6 by the CLI, matching std::clamp in ply_to_bek.cpp
  vqIters: number;
  sortRefine: number;
  cbChainOrder: boolean;
  scaleStages: number; // >0 -> RVQ on scales (vq_scale_s*) instead of u8_levels
  noPositions: boolean;
  noOpacity: boolean;
  noRotation: boolean;
  noScale: boolean;
}

export const DEFAULT_ENCODE_OPTIONS: EncodeOptions = {
  dcStages: 2,
  shStages: 3,
  posFractionalBits: 9,
  rotMagBits: 6,
  vqIters: 30,
  sortRefine: 128,
  cbChainOrder: true,
  scaleStages: 0,
  noPositions: false,
  noOpacity: false,
  noRotation: false,
  noScale: false,
};

const CLUSTERS_PER_STAGE = 256;

interface Channel {
  name: string;
  channels: number; // bytes per point for this plane
  data: Uint8Array;  // raw, pre-entropy-coding bytes
  meta: Map<string, CborValue>;
}

function buildChannels(ply: VertexData, opts: EncodeOptions): { channels: Channel[]; count: number } {
  const N = ply.count;
  const order = sortMorton(ply.x, ply.y, ply.z, opts.sortRefine);

  const x = reorder(ply.x, order);
  const y = reorder(ply.y, order);
  const z = reorder(ply.z, order);
  const opacity = reorder(ply.opacity, order);
  const scale0 = reorder(ply.scale_0, order);
  const scale1 = reorder(ply.scale_1, order);
  const scale2 = reorder(ply.scale_2, order);
  const rot0 = reorder(ply.rot_0, order);
  const rot1 = reorder(ply.rot_1, order);
  const rot2 = reorder(ply.rot_2, order);
  const rot3 = reorder(ply.rot_3, order);
  const fdc0 = reorder(ply.f_dc_0, order);
  const fdc1 = reorder(ply.f_dc_1, order);
  const fdc2 = reorder(ply.f_dc_2, order);
  const frest = ply.f_rest.map((col) => reorder(col, order));

  const channels: Channel[] = [];

  // 1. positions
  if (!opts.noPositions) {
    const px = quantizePositionSpzZz(x, opts.posFractionalBits);
    const py = quantizePositionSpzZz(y, opts.posFractionalBits);
    const pz = quantizePositionSpzZz(z, opts.posFractionalBits);
    const posMeta = (): Map<string, CborValue> => new Map<string, CborValue>([
      ['type', 'spz_dpcm_zz'], ['bits', 24], ['frac', opts.posFractionalBits],
    ]);
    channels.push({ name: 'pos_x', channels: 3, data: px, meta: posMeta() });
    channels.push({ name: 'pos_y', channels: 3, data: py, meta: posMeta() });
    channels.push({ name: 'pos_z', channels: 3, data: pz, meta: posMeta() });
  }

  // 2. opacity
  if (!opts.noOpacity) {
    const o = quantizeOpacitySigmoid(opacity);
    const meta = new Map<string, CborValue>([['type', 'sigmoid'], ['bits', 8]]);
    channels.push({ name: 'opacity', channels: 1, data: o, meta });
  }

  // 3. rotation
  if (!opts.noRotation) {
    const r = packQuaternionSmallestThreeVar(rot0, rot1, rot2, rot3, opts.rotMagBits);
    const meta = new Map<string, CborValue>([['type', 'smallest3_24'], ['bits', 24], ['mag_bits', opts.rotMagBits]]);
    channels.push({ name: 'rotation', channels: 3, data: r, meta });
  }

  // 4. scales: RVQ (scale_stages>0, vq_scale_s*) or per-axis u8_levels (default)
  if (!opts.noScale) {
    if (opts.scaleStages > 0) {
      pushRvqChannels(channels, [scale0, scale1, scale2], opts.scaleStages, 'vq_scale_s', 'rvq_stage_scale_quantized', undefined, opts);
    } else {
      const s0 = quantizeToU8Levels(scale0, 8);
      const s1 = quantizeToU8Levels(scale1, 8);
      const s2 = quantizeToU8Levels(scale2, 8);
      const packed = new Uint8Array(N * 3);
      for (let i = 0; i < N; i++) {
        packed[i * 3] = s0.data[i];
        packed[i * 3 + 1] = s1.data[i];
        packed[i * 3 + 2] = s2.data[i];
      }
      const meta = new Map<string, CborValue>([
        ['type', 'u8_levels'],
        ['min', [new CborFloat(s0.min), new CborFloat(s1.min), new CborFloat(s2.min)]],
        ['max', [new CborFloat(s0.max), new CborFloat(s1.max), new CborFloat(s2.max)]],
      ]);
      channels.push({ name: 'scales', channels: 3, data: packed, meta });
    }
  }

  // 5a. DC RVQ (joint 3-dim: f_dc_0/1/2)
  pushRvqChannels(channels, [fdc0, fdc1, fdc2], opts.dcStages, 'vq_dc_s', 'rvq_stage_quantized', undefined, opts);

  // 5b. SH-AC RVQ (joint 45-dim: f_rest_0..44)
  pushRvqChannels(channels, frest, opts.shStages, 'vq_sh_ac_s', 'rvq_stage_sh_ac_quantized', 45, opts);

  return { channels, count: N };
}

function pushRvqChannels(
  channels: Channel[], features: Float32Array[], stages: number,
  namePrefix: string, type: string, dims: number | undefined, opts: EncodeOptions,
): void {
  if (stages <= 0 || features.length === 0 || features[0].length === 0) return;
  const res = computeRvq(features, stages, CLUSTERS_PER_STAGE, opts.vqIters, opts.cbChainOrder);
  const pooled = packRvqPooled(res);
  const levelsCbor: CborValue[] = Array.from(pooled.levels, (v) => new CborFloat(v));
  for (let s = 0; s < stages; s++) {
    const idx8 = Uint8Array.from(pooled.pointIndices[s]);
    const cbIndices: CborValue[] = Array.from(pooled.cbIndices[s]);
    const entries: [string, CborValue][] = [
      ['type', type], ['stage', s],
      ['levels', levelsCbor], ['cb_indices', cbIndices],
    ];
    if (dims !== undefined) entries.push(['dims', dims]);
    channels.push({ name: `${namePrefix}${s}`, channels: 1, data: idx8, meta: new Map(entries) });
  }
}

// ---------- best-of codec selection (ply_to_bek.cpp:652-675) ----------
// WebP skip list (ply_to_bek.cpp:580-584), replicated literally: rotation,
// scales, opacity, vq_dc_s0 never get a WebP candidate.
const WEBP_SKIP = new Set(['rotation', 'scales', 'opacity', 'vq_dc_s0']);

interface Picked { blob: Uint8Array; codec: string; ctxName?: string }

function pickBestCodec(
  name: string, meta: Map<string, CborValue>, data: Uint8Array, stride: number,
  byName: Map<string, Channel>, W: number, H: number,
): Picked {
  const rc2 = rc2Encode(data, stride);
  const rc1 = rc1Encode(data, stride);

  let rcx: Uint8Array | undefined;
  let ctxName: string | undefined;
  if (name.startsWith('vq_')) {
    const spos = name.lastIndexOf('s');
    if (spos >= 0) {
      const stage = parseInt(name.slice(spos + 1), 10);
      if (!Number.isNaN(stage) && stage > 0) {
        const candidate = name.slice(0, spos + 1) + String(stage - 1);
        const other = byName.get(candidate);
        if (other && other.data.length === data.length) {
          ctxName = candidate;
          rcx = rcxEncode(data, other.data);
        }
      }
    }
  }

  let pmag: Uint8Array | undefined;
  if (name.startsWith('pos_') && name !== 'pos_xyz') pmag = posmagEncode(data);

  let rpk: Uint8Array | undefined;
  if (name === 'rotation' && meta.get('type') === 'smallest3_24') {
    const mb = meta.get('mag_bits') as number;
    if (mb >= 1 && mb <= 6) rpk = rotpackEncode(data, mb);
  }

  let webp: Buffer | undefined;
  if (!WEBP_SKIP.has(name) && (stride === 1 || stride === 3)) {
    const padded = new Uint8Array(W * H * stride);
    padded.set(data);
    webp = webpEncode(padded, W, H, stride as 1 | 3);
  }

  const MAX = Number.MAX_SAFE_INTEGER;
  const pmagSz = pmag ? pmag.length : MAX;
  const rpkSz = rpk ? rpk.length : MAX;
  const rcxSz = rcx ? rcx.length : MAX;
  const rc2Sz = rc2.length;
  const rc1Sz = rc1.length;
  const webpSz = webp ? webp.length : MAX;
  const rawSz = data.length;

  const best = Math.min(pmagSz, rpkSz, rcxSz, rc2Sz, rc1Sz, webpSz, rawSz);
  if (best === pmagSz) return { blob: pmag!, codec: 'posmag' };
  if (best === rpkSz) return { blob: rpk!, codec: 'rotpack' };
  if (best === rcxSz) return { blob: rcx!, codec: 'rcx', ctxName };
  if (best === rc2Sz) return { blob: rc2, codec: 'rc2' };
  if (best === rc1Sz) return { blob: rc1, codec: 'rc1' };
  if (best === webpSz) return { blob: webp!, codec: 'webp' };
  return { blob: data, codec: 'raw' };
}

// ---------- assembly: sort channels by name, best-of encode, write buffer ----------

export function buildUncompressed(ply: VertexData, opts: Partial<EncodeOptions> = {}): Buffer {
  const merged: EncodeOptions = { ...DEFAULT_ENCODE_OPTIONS, ...opts };
  const { channels, count } = buildChannels(ply, merged);
  channels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const byName = new Map(channels.map((c) => [c.name, c]));

  const N = count;
  const W = Math.ceil(Math.sqrt(N));
  const H = W > 0 ? Math.ceil(N / W) : 0;

  const payloadParts: Buffer[] = [];
  const channelEntries: CborValue[] = [];
  let offset = 0;

  for (const ch of channels) {
    const picked = pickBestCodec(ch.name, ch.meta, ch.data, ch.channels, byName, W, H);
    const blobBuf = Buffer.from(picked.blob);
    payloadParts.push(blobBuf);

    const meta = new Map(ch.meta);
    meta.set('codec', picked.codec);
    if (picked.ctxName !== undefined) meta.set('ctx_ch', picked.ctxName);

    channelEntries.push(new Map<string, CborValue>([
      ['channels', ch.channels],
      ['meta', meta],
      ['name', ch.name],
      ['offset', offset],
      ['size', blobBuf.length],
    ]));
    offset += blobBuf.length;
  }

  const header = new Map<string, CborValue>([
    ['channels', channelEntries],
    ['count', N],
    ['width', W],
    ['height', H],
  ]);
  const headerBuf = encodeCbor(header);

  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(headerBuf.length, 0);

  return Buffer.concat([sizeBuf, headerBuf, ...payloadParts]);
}
