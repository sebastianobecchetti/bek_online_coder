// Minimal ambient declarations for the slice of Node's Buffer/fs API this
// project uses. Written by hand instead of installing @types/node, per the
// zero-npm-dependency constraint (DESIGN.md §4): this project's package.json
// carries only `typescript` in devDependencies.

interface Buffer extends Uint8Array {
  readFloatLE(offset: number): number;
  writeFloatLE(value: number, offset: number): number;
  readUInt16BE(offset: number): number;
  writeUInt16BE(value: number, offset: number): number;
  readUInt32BE(offset: number): number;
  writeUInt32BE(value: number, offset: number): number;
  readUInt32LE(offset: number): number;
  writeUInt32LE(value: number, offset: number): number;
  readBigUInt64LE(offset: number): bigint;
  readBigUInt64BE(offset: number): bigint;
  writeBigUInt64LE(value: bigint, offset: number): number;
  writeBigUInt64BE(value: bigint, offset: number): number;
  readFloatBE(offset: number): number;
  writeFloatBE(value: number, offset: number): number;
  readDoubleBE(offset: number): number;
  writeDoubleBE(value: number, offset: number): number;
  toString(encoding?: string, start?: number, end?: number): string;
  subarray(start?: number, end?: number): Buffer;
  equals(other: Uint8Array): boolean;
  indexOf(value: string | Uint8Array | number, byteOffset?: number): number;
  write(str: string, offset?: number, encoding?: string): number;
}

declare var Buffer: {
  new (size: number): Buffer;
  from(data: string | ArrayLike<number>, encoding?: string): Buffer;
  from(data: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
  alloc(size: number): Buffer;
  allocUnsafe(size: number): Buffer;
  concat(list: Buffer[]): Buffer;
  byteLength(str: string, encoding?: string): number;
};

declare module 'node:fs' {
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: Buffer | Uint8Array): void;
  export function existsSync(path: string): boolean;
  export function unlinkSync(path: string): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:child_process' {
  export function execFileSync(
    command: string,
    args?: string[],
    options?: { stdio?: string | string[] },
  ): Buffer;
}

declare var process: { pid: number; argv: string[]; exitCode: number | undefined };

declare module 'node:zlib' {
  export function zstdCompressSync(data: Buffer | Uint8Array, options?: { params?: Record<number, number> }): Buffer;
  export function zstdDecompressSync(
    data: Buffer | Uint8Array,
    options?: { params?: Record<number, number>; maxOutputLength?: number },
  ): Buffer;
  export const constants: {
    ZSTD_c_compressionLevel: number;
    ZSTD_c_enableLongDistanceMatching: number;
    ZSTD_c_windowLog: number;
    ZSTD_d_windowLogMax: number;
  };
}

declare module 'node:assert/strict' {
  function ok(value: unknown, message?: string): asserts value;
  function equal(actual: unknown, expected: unknown, message?: string): void;
  const assertStrict: { ok: typeof ok; equal: typeof equal };
  export default assertStrict;
}
