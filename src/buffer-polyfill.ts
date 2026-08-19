// Minimal Buffer polyfill: the browser has no `Buffer` global. This
// implements exactly the slice of the API surface bek-ts's ambient.d.ts
// declares (src/ambient.d.ts) and actually calls from the code paths this
// project bundles (container.ts's writeBek, cbor.ts's encodeCbor, and
// encode.ts's final assembly) -- not the full Node Buffer API.
//
// Subclassing Uint8Array without overriding the constructor means
// `subarray()` already returns a `Buf` instance (TypedArray#subarray uses
// the species constructor with (buffer, byteOffset, length), which our
// inherited constructor already accepts), and `new Buf(n)` already
// zero-fills, matching Buffer.alloc/allocUnsafe closely enough (we never
// rely on allocUnsafe's uninitialized-memory behavior).

const te = new TextEncoder();
const td = new TextDecoder();

export class Buf extends Uint8Array {
  private dv(): DataView {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }

  readFloatLE(o: number): number { return this.dv().getFloat32(o, true); }
  writeFloatLE(v: number, o: number): number { this.dv().setFloat32(o, v, true); return o + 4; }
  readFloatBE(o: number): number { return this.dv().getFloat32(o, false); }
  writeFloatBE(v: number, o: number): number { this.dv().setFloat32(o, v, false); return o + 4; }
  readDoubleBE(o: number): number { return this.dv().getFloat64(o, false); }
  writeDoubleBE(v: number, o: number): number { this.dv().setFloat64(o, v, false); return o + 8; }
  readUInt16BE(o: number): number { return this.dv().getUint16(o, false); }
  writeUInt16BE(v: number, o: number): number { this.dv().setUint16(o, v, false); return o + 2; }
  readUInt32BE(o: number): number { return this.dv().getUint32(o, false); }
  writeUInt32BE(v: number, o: number): number { this.dv().setUint32(o, v, false); return o + 4; }
  readUInt32LE(o: number): number { return this.dv().getUint32(o, true); }
  writeUInt32LE(v: number, o: number): number { this.dv().setUint32(o, v, true); return o + 4; }
  readBigUInt64LE(o: number): bigint { return this.dv().getBigUint64(o, true); }
  readBigUInt64BE(o: number): bigint { return this.dv().getBigUint64(o, false); }
  writeBigUInt64LE(v: bigint, o: number): number { this.dv().setBigUint64(o, v, true); return o + 8; }
  writeBigUInt64BE(v: bigint, o: number): number { this.dv().setBigUint64(o, v, false); return o + 8; }

  toString(encoding: string = 'utf8', start = 0, end: number = this.length): string {
    const slice = this.subarray(start, end);
    if (encoding === 'ascii' || encoding === 'utf8' || encoding === 'utf-8') {
      return encoding === 'ascii'
        ? String.fromCharCode(...Array.from(slice))
        : td.decode(slice);
    }
    throw new Error(`Buf.toString: unsupported encoding '${encoding}'`);
  }

  equals(other: Uint8Array): boolean {
    if (this.length !== other.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }

  indexOf(value: string | Uint8Array | number, byteOffset = 0): number {
    if (typeof value === 'number') {
      for (let i = byteOffset; i < this.length; i++) if (this[i] === value) return i;
      return -1;
    }
    const needle = typeof value === 'string' ? te.encode(value) : value;
    outer: for (let i = byteOffset; i <= this.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  write(str: string, offset = 0, encoding = 'ascii'): number {
    if (encoding === 'ascii') {
      for (let i = 0; i < str.length; i++) this[offset + i] = str.charCodeAt(i) & 0xff;
      return str.length;
    }
    const bytes = te.encode(str);
    this.set(bytes, offset);
    return bytes.length;
  }
}

export const Buffer = Object.assign(Buf, {
  alloc(size: number): Buf { return new Buf(size); },
  allocUnsafe(size: number): Buf { return new Buf(size); },
  from(data: string | ArrayLike<number> | ArrayBufferLike, encodingOrOffset?: string | number, length?: number): Buf {
    if (typeof data === 'string') {
      const enc = (encodingOrOffset as string) ?? 'utf8';
      if (enc === 'ascii') {
        const b = new Buf(data.length);
        b.write(data, 0, 'ascii');
        return b;
      }
      return new Buf(te.encode(data));
    }
    if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)) {
      return new Buf(data, encodingOrOffset as number | undefined, length);
    }
    // ArrayLike<number> (plain array) or a TypedArray view -- copy semantics.
    return new Buf(data as ArrayLike<number>);
  },
  concat(list: Uint8Array[]): Buf {
    let total = 0;
    for (const b of list) total += b.length;
    const out = new Buf(total);
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  },
  byteLength(str: string, encoding = 'utf8'): number {
    return encoding === 'ascii' ? str.length : te.encode(str).length;
  },
});
