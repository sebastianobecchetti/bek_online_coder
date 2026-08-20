// Port of range_coder.cpp/.h — LZMA-style binary range coder plus the five
// entropy codecs used on the default path: rc1, rc2, rcx, posmag, rotpack.
// posmag3 (only used by --pos-joint) is intentionally NOT ported.
// See DESIGN.md §3.1 (low fits in a `number`, no BigInt, no `<<` on low),
// §3.2 (__builtin_clz -> Math.clz32), §3.7 (uint32 indices, DataView).

const PROB_BITS = 11;
const PROB_INIT = (1 << PROB_BITS) / 2; // 1024
const MOVE_BITS = 5;
const TOP_VALUE = 1 << 24;

// ---------- core LZMA-style coder ----------

class RangeEncoder {
  out: number[] = [];
  low = 0; // invariant: 0 <= low < 2^33 (fits safely in a `number`)
  range = 0xffffffff;
  cache = 0;
  cacheSize = 1;

  private shiftLow(): void {
    if ((this.low >>> 0) < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let temp = this.cache;
      do {
        this.out.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = (this.low / 0x1000000) & 0xff; // (low >> 24) & 0xff
    }
    ++this.cacheSize;
    // (low << 8) & 0xFFFFFFFF, without using << (low can exceed 2^32).
    this.low = ((this.low % 0x100000000) * 256) % 0x100000000;
  }

  encodeBit(probs: Uint16Array, probIdx: number, bit: number): void {
    const prob = probs[probIdx];
    const bound = ((this.range >>> PROB_BITS) * prob) >>> 0;
    if (bit === 0) {
      this.range = bound;
      probs[probIdx] = prob + (((1 << PROB_BITS) - prob) >>> MOVE_BITS);
    } else {
      this.low += bound;
      this.range = (this.range - bound) >>> 0;
      probs[probIdx] = prob - (prob >>> MOVE_BITS);
    }
    while ((this.range >>> 0) < TOP_VALUE) {
      this.range = (this.range << 8) >>> 0;
      this.shiftLow();
    }
  }

  encodeBitDirect(bit: number): void {
    this.range = this.range >>> 1;
    if (bit) this.low += this.range;
    while ((this.range >>> 0) < TOP_VALUE) {
      this.range = (this.range << 8) >>> 0;
      this.shiftLow();
    }
  }

  flush(): void {
    for (let i = 0; i < 5; i++) this.shiftLow();
  }

  toBuffer(): Buffer {
    return Buffer.from(this.out);
  }
}

class RangeDecoder {
  buf: Buffer;
  pos = 0;
  range = 0xffffffff;
  code = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  private readByte(): number {
    return this.pos < this.buf.length ? this.buf[this.pos++] : 0;
  }

  init(): void {
    this.readByte(); // encoder's initial cache byte (always 0)
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.readByte()) >>> 0;
  }

  decodeBit(probs: Uint16Array, probIdx: number): number {
    const prob = probs[probIdx];
    const bound = ((this.range >>> PROB_BITS) * prob) >>> 0;
    let bit: number;
    if ((this.code >>> 0) < bound) {
      this.range = bound;
      probs[probIdx] = prob + (((1 << PROB_BITS) - prob) >>> MOVE_BITS);
      bit = 0;
    } else {
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      probs[probIdx] = prob - (prob >>> MOVE_BITS);
      bit = 1;
    }
    while ((this.range >>> 0) < TOP_VALUE) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.readByte()) >>> 0;
    }
    return bit;
  }

  decodeBitDirect(): number {
    this.range = this.range >>> 1;
    let bit: number;
    if ((this.code >>> 0) >= (this.range >>> 0)) {
      this.code = (this.code - this.range) >>> 0;
      bit = 1;
    } else {
      bit = 0;
    }
    while ((this.range >>> 0) < TOP_VALUE) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.readByte()) >>> 0;
    }
    return bit;
  }
}

function newProbs(n: number): Uint16Array {
  const p = new Uint16Array(n);
  p.fill(PROB_INIT);
  return p;
}

// ---------- rc2: context = prev sample of same plane (+quantized prev-prev / intra) ----------

const RC2_NUM_CONTEXTS = 8192;

function rc2Context(data: Uint8Array, i: number, stride: number): number {
  const plane = stride > 1 ? i % stride : 0;
  if (plane === 0) {
    const prev = i >= stride ? data[i - stride] : 0;
    const prev2 = i >= 2 * stride ? data[i - 2 * stride] : 0;
    return ((prev << 4) | (prev2 >>> 4)) >>> 0; // [0, 4096)
  }
  const intra = data[i - 1];
  const prev = i >= stride ? data[i - stride] : 0;
  return ((intra << 5) | (prev >>> 3)) >>> 0; // [0, 8192)
}

export function rc2Encode(data: Uint8Array, stride: number): Buffer {
  const probs = newProbs(RC2_NUM_CONTEXTS * 256);
  const enc = new RangeEncoder();
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const treeBase = rc2Context(data, i, stride) << 8;
    let m = 1;
    const b = data[i];
    for (let k = 7; k >= 0; k--) {
      const bit = (b >>> k) & 1;
      enc.encodeBit(probs, treeBase + m, bit);
      m = ((m << 1) | bit) & 0xffff;
    }
  }
  enc.flush();
  return enc.toBuffer();
}

export function rc2Decode(blob: Buffer, outSize: number, stride: number): Uint8Array {
  const probs = newProbs(RC2_NUM_CONTEXTS * 256);
  const dec = new RangeDecoder(blob);
  dec.init();
  const out = new Uint8Array(outSize);
  for (let i = 0; i < outSize; i++) {
    const treeBase = rc2Context(out, i, stride) << 8;
    let m = 1;
    for (let k = 0; k < 8; k++) m = ((m << 1) | dec.decodeBit(probs, treeBase + m)) & 0xffff;
    out[i] = m & 0xff;
  }
  return out;
}

// ---------- rc1: context = prev same-plane byte (256 contexts) ----------

export function rc1Encode(data: Uint8Array, stride: number): Buffer {
  const probs = newProbs(256 * 256);
  const enc = new RangeEncoder();
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const ctx = i >= stride ? data[i - stride] : 0;
    const treeBase = ctx << 8;
    let m = 1;
    const b = data[i];
    for (let k = 7; k >= 0; k--) {
      const bit = (b >>> k) & 1;
      enc.encodeBit(probs, treeBase + m, bit);
      m = ((m << 1) | bit) & 0xffff;
    }
  }
  enc.flush();
  return enc.toBuffer();
}

export function rc1Decode(blob: Buffer, outSize: number, stride: number): Uint8Array {
  const probs = newProbs(256 * 256);
  const dec = new RangeDecoder(blob);
  dec.init();
  const out = new Uint8Array(outSize);
  for (let i = 0; i < outSize; i++) {
    const ctx = i >= stride ? out[i - stride] : 0;
    const treeBase = ctx << 8;
    let m = 1;
    for (let k = 0; k < 8; k++) m = ((m << 1) | dec.decodeBit(probs, treeBase + m)) & 0xffff;
    out[i] = m & 0xff;
  }
  return out;
}

// ---------- rcx: context = cross-plane full byte + prev byte of this plane (quantized) ----------

function rcxContext(ctxPlane: Uint8Array, data: Uint8Array, i: number): number {
  const cross = ctxPlane[i];
  const prev = i > 0 ? data[i - 1] : 0;
  return ((cross << 4) | (prev >>> 4)) >>> 0; // [0, 4096)
}

export function rcxEncode(data: Uint8Array, ctxPlane: Uint8Array): Buffer {
  const probs = newProbs(4096 * 256);
  const enc = new RangeEncoder();
  for (let i = 0; i < data.length; i++) {
    const treeBase = rcxContext(ctxPlane, data, i) << 8;
    let m = 1;
    const b = data[i];
    for (let k = 7; k >= 0; k--) {
      const bit = (b >>> k) & 1;
      enc.encodeBit(probs, treeBase + m, bit);
      m = ((m << 1) | bit) & 0xffff;
    }
  }
  enc.flush();
  return enc.toBuffer();
}

export function rcxDecode(blob: Buffer, outSize: number, ctxPlane: Uint8Array): Uint8Array {
  const probs = newProbs(4096 * 256);
  const dec = new RangeDecoder(blob);
  dec.init();
  const out = new Uint8Array(outSize);
  for (let i = 0; i < outSize; i++) {
    const treeBase = rcxContext(ctxPlane, out, i) << 8;
    let m = 1;
    for (let k = 0; k < 8; k++) m = ((m << 1) | dec.decodeBit(probs, treeBase + m)) & 0xffff;
    out[i] = m & 0xff;
  }
  return out;
}

// ---------- posmag: length-prefix + mantissa coder for 24-bit zigzag DPCM deltas ----------

function posmagBucket(nbits: number): number {
  if (nbits <= 3) return nbits; // 0,1,2,3
  if (nbits <= 6) return 4;
  if (nbits <= 9) return 5;
  if (nbits <= 13) return 6;
  return 7;
}

const POS_BUCKETS = 8;
const POS_LEN_BITS = 24;

export function posmagEncode(data: Uint8Array): Buffer {
  const n = data.length / 3;
  const cont = newProbs(POS_BUCKETS * POS_LEN_BITS);
  const mant = newProbs((POS_LEN_BITS + 1) * 2);
  const enc = new RangeEncoder();
  let prevBucket = 0;
  for (let i = 0; i < n; i++) {
    const zz = (data[i * 3] | (data[i * 3 + 1] << 8) | (data[i * 3 + 2] << 16)) >>> 0;
    const nbits = zz ? 32 - Math.clz32(zz) : 0;
    const cBase = prevBucket * POS_LEN_BITS;
    for (let k = 0; k < POS_LEN_BITS; k++) {
      const bit = nbits > k ? 1 : 0;
      enc.encodeBit(cont, cBase + k, bit);
      if (!bit) break;
    }
    for (let j = nbits - 2; j >= 0; j--) {
      const bit = (zz >>> j) & 1;
      const pos = nbits - 1 - j;
      if (pos <= 2) enc.encodeBit(mant, nbits * 2 + (pos - 1), bit);
      else enc.encodeBitDirect(bit);
    }
    prevBucket = posmagBucket(nbits);
  }
  enc.flush();
  return enc.toBuffer();
}

export function posmagDecode(blob: Buffer, outSize: number): Uint8Array {
  const n = outSize / 3;
  const cont = newProbs(POS_BUCKETS * POS_LEN_BITS);
  const mant = newProbs((POS_LEN_BITS + 1) * 2);
  const dec = new RangeDecoder(blob);
  dec.init();
  const out = new Uint8Array(outSize);
  let prevBucket = 0;
  for (let i = 0; i < n; i++) {
    const cBase = prevBucket * POS_LEN_BITS;
    let nbits = POS_LEN_BITS;
    for (let k = 0; k < POS_LEN_BITS; k++) {
      if (dec.decodeBit(cont, cBase + k) === 0) {
        nbits = k;
        break;
      }
    }
    let zz = 0;
    if (nbits >= 1) {
      zz = (1 << (nbits - 1)) >>> 0;
      for (let j = nbits - 2; j >= 0; j--) {
        const pos = nbits - 1 - j;
        const bit = pos <= 2 ? dec.decodeBit(mant, nbits * 2 + (pos - 1)) : dec.decodeBitDirect();
        zz = (zz | (bit << j)) >>> 0;
      }
    }
    out[i * 3] = zz & 0xff;
    out[i * 3 + 1] = (zz >>> 8) & 0xff;
    out[i * 3 + 2] = (zz >>> 16) & 0xff;
    prevBucket = posmagBucket(nbits);
  }
  return out;
}

// ---------- rotpack: dedicated coder for the smallest3_24 rotation channel ----------

export function rotpackEncode(data: Uint8Array, magBits: number): Buffer {
  const m = magBits;
  const fw = m + 1;
  const fmask = ((1 << fw) - 1) >>> 0;
  const magmask = ((1 << m) - 1) >>> 0;
  const n = data.length / 3;
  const idxTree = newProbs(4 * 4);
  const sign = newProbs(4 * 3);
  const magTree = newProbs(4 * 3 * (1 << m));
  const enc = new RangeEncoder();
  let prevIdx = 0;
  for (let i = 0; i < n; i++) {
    const word = (data[i * 3] | (data[i * 3 + 1] << 8) | (data[i * 3 + 2] << 16)) >>> 0;
    const idx = (word >>> (3 * fw)) & 0x3;
    const itBase = prevIdx * 4;
    let mt = 1;
    for (let k = 1; k >= 0; k--) {
      const bit = (idx >>> k) & 1;
      enc.encodeBit(idxTree, itBase + mt, bit);
      mt = (mt << 1) | bit;
    }
    for (let s = 0; s < 3; s++) {
      const comp = (word >>> ((2 - s) * fw)) & fmask;
      const sgn = (comp >>> m) & 1;
      const mag = comp & magmask;
      enc.encodeBit(sign, idx * 3 + s, sgn);
      const mtreeBase = (idx * 3 + s) << m;
      let mm = 1;
      for (let k = m - 1; k >= 0; k--) {
        const bit = (mag >>> k) & 1;
        enc.encodeBit(magTree, mtreeBase + mm, bit);
        mm = (mm << 1) | bit;
      }
    }
    prevIdx = idx;
  }
  enc.flush();
  return enc.toBuffer();
}

export function rotpackDecode(blob: Buffer, outSize: number, magBits: number): Uint8Array {
  const m = magBits;
  const fw = m + 1;
  const magmask = ((1 << m) - 1) >>> 0;
  const n = outSize / 3;
  const idxTree = newProbs(4 * 4);
  const sign = newProbs(4 * 3);
  const magTree = newProbs(4 * 3 * (1 << m));
  const dec = new RangeDecoder(blob);
  dec.init();
  const out = new Uint8Array(outSize);
  let prevIdx = 0;
  for (let i = 0; i < n; i++) {
    const itBase = prevIdx * 4;
    let mt = 1;
    for (let k = 0; k < 2; k++) mt = (mt << 1) | dec.decodeBit(idxTree, itBase + mt);
    const idx = mt & 0x3;
    let word = (idx << (3 * fw)) >>> 0;
    for (let s = 0; s < 3; s++) {
      const sgn = dec.decodeBit(sign, idx * 3 + s);
      const mtreeBase = (idx * 3 + s) << m;
      let mm = 1;
      for (let k = 0; k < m; k++) mm = (mm << 1) | dec.decodeBit(magTree, mtreeBase + mm);
      const comp = ((sgn << m) | (mm & magmask)) >>> 0;
      word = (word | (comp << ((2 - s) * fw))) >>> 0;
    }
    out[i * 3] = word & 0xff;
    out[i * 3 + 1] = (word >>> 8) & 0xff;
    out[i * 3 + 2] = (word >>> 16) & 0xff;
    prevIdx = idx;
  }
  return out;
}
