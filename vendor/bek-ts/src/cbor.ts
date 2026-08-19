// Canonical CBOR matching nlohmann::json::to_cbor/from_cbor as used by the
// BEK container header. NOT RFC 8949 canonical (that sorts by length first);
// this is pure byte-wise lexicographic key order. See DESIGN.md §3.10.

// Wrapper so float-typed values (major 7, 0xFA/0xFB) survive a decode/re-encode
// round trip distinct from integers (major 0/1) — plain JS numbers can't tell
// "5" (int) from "5.0" (float) apart on their own.
export class CborFloat {
  readonly value: number;
  constructor(value: number) { this.value = value; }
}

export type CborValue =
  | number
  | CborFloat
  | string
  | boolean
  | null
  | CborValue[]
  | Map<string, CborValue>;

// ---------- encode ----------

function encodeUintHead(major: number, n: number): Buffer {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n <= 0xff) return Buffer.from([m | 24, n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = m | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = m | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = m | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

function encodeInt(n: number): Buffer {
  return n >= 0 ? encodeUintHead(0, n) : encodeUintHead(1, -1 - n);
}

function encodeFloat(f: CborFloat): Buffer {
  const v = f.value;
  if (Math.fround(v) === v) {
    const b = Buffer.alloc(5);
    b[0] = (7 << 5) | 26;
    b.writeFloatBE(v, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (7 << 5) | 27;
  b.writeDoubleBE(v, 1);
  return b;
}

function encodeString(s: string): Buffer {
  const utf8 = Buffer.from(s, 'utf8');
  return Buffer.concat([encodeUintHead(3, utf8.length), utf8]);
}

export function encodeCbor(value: CborValue): Buffer {
  if (value instanceof CborFloat) return encodeFloat(value);
  if (typeof value === 'number') return encodeInt(value);
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'boolean') return Buffer.from([(7 << 5) | (value ? 21 : 20)]);
  if (value === null) return Buffer.from([(7 << 5) | 22]);
  if (Array.isArray(value)) {
    const parts = [encodeUintHead(4, value.length)];
    for (const item of value) parts.push(encodeCbor(item));
    return Buffer.concat(parts);
  }
  if (value instanceof Map) {
    const keys = [...value.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = [encodeUintHead(5, keys.length)];
    for (const k of keys) {
      parts.push(encodeString(k));
      parts.push(encodeCbor(value.get(k)!));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`encodeCbor: unsupported value ${String(value)}`);
}

// ---------- decode ----------

class Reader {
  pos = 0;
  buf: Buffer;
  constructor(buf: Buffer) { this.buf = buf; }
  u8(): number { return this.buf[this.pos++]; }
  bytes(n: number): Buffer { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
}

function readLength(r: Reader, info: number): number {
  if (info < 24) return info;
  if (info === 24) return r.u8();
  if (info === 25) { const v = r.buf.readUInt16BE(r.pos); r.pos += 2; return v; }
  if (info === 26) { const v = r.buf.readUInt32BE(r.pos); r.pos += 4; return v; }
  if (info === 27) {
    const v = r.buf.readBigUInt64BE(r.pos); r.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('decodeCbor: uint64 length exceeds MAX_SAFE_INTEGER');
    return Number(v);
  }
  throw new Error(`decodeCbor: unsupported length encoding, additional info ${info}`);
}

function decodeItem(r: Reader): CborValue {
  const ib = r.u8();
  const major = ib >> 5;
  const info = ib & 0x1f;

  switch (major) {
    case 0: return readLength(r, info);
    case 1: return -1 - readLength(r, info);
    case 2: { // byte string (not used by this codec, but decode faithfully)
      const len = readLength(r, info);
      throw new Error(`decodeCbor: byte strings unsupported (len ${len})`);
    }
    case 3: {
      const len = readLength(r, info);
      return r.bytes(len).toString('utf8');
    }
    case 4: {
      const len = readLength(r, info);
      const arr: CborValue[] = [];
      for (let i = 0; i < len; i++) arr.push(decodeItem(r));
      return arr;
    }
    case 5: {
      const len = readLength(r, info);
      const map = new Map<string, CborValue>();
      for (let i = 0; i < len; i++) {
        const k = decodeItem(r);
        if (typeof k !== 'string') throw new Error('decodeCbor: map key must be a text string');
        map.set(k, decodeItem(r));
      }
      return map;
    }
    case 7: {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 26) { const v = r.buf.readFloatBE(r.pos); r.pos += 4; return new CborFloat(v); }
      if (info === 27) { const v = r.buf.readDoubleBE(r.pos); r.pos += 8; return new CborFloat(v); }
      throw new Error(`decodeCbor: unsupported simple/float additional info ${info}`);
    }
    default:
      throw new Error(`decodeCbor: unsupported major type ${major}`);
  }
}

export function decodeCbor(buf: Buffer): CborValue {
  const r = new Reader(buf);
  const v = decodeItem(r);
  if (r.pos !== buf.length) throw new Error(`decodeCbor: ${buf.length - r.pos} trailing bytes after top-level item`);
  return v;
}
