// Shim for bek-ts/src/container.ts's `import ... from 'node:zlib'`, swapped
// in by the esbuild alias plugin (esbuild.config.mjs). Real zstd via
// @bokuweb/zstd-wasm 0.0.27 (MIT) instead of the raw-block passthrough this
// replaced (src/zstd-raw.ts): that shim cost ~14% size on small scenes
// because the payload isn't actually zstd-compressed, just framed. This one
// calls the real ZSTD_compress/ZSTD_decompress in wasm at level 22, same as
// container.ts asks for and the same level bek-ts's Node build uses.
//
// vendor/zstd/zstd-wasm.mjs is a frozen, pre-bundled build of the package's
// Module (emscripten glue) + waitInitialized + compress/decompress, built
// once from node_modules/@bokuweb/zstd-wasm/dist/esm via esbuild (see
// scripts/build-zstd-vendor.mjs) so it ships as a plain vendored asset, not
// a runtime npm dependency (the package stays a devDependency only, used to
// produce this file and vendor/zstd/zstd.wasm).
//
// We call `Module.init(bytes)` with the wasm bytes already in hand instead
// of the package's own fetch-driven `init(path)`, because the package's
// dist/esm/web build has no Node fallback (it only knows `fetch`, and
// Node's fetch doesn't support `file:` URLs). Passing raw bytes hits
// `WebAssembly.instantiate(bytes, imports)` directly in the glue, which
// works identically under a browser Worker and under Node (this project's
// own verify script runs the very same code path -- see
// scripts/verify-node-entry.ts).

interface ZstdModule {
  init(bytes: Uint8Array): unknown;
}

let zstd: { compress: (buf: Uint8Array, level: number) => Uint8Array; decompress: (buf: Uint8Array) => Uint8Array } | null = null;

async function loadWasmBytes(): Promise<Uint8Array> {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('./vendor/zstd/zstd.wasm', import.meta.url));
    return new Uint8Array(readFileSync(path));
  }
  const url = new URL('./vendor/zstd/zstd.wasm', import.meta.url).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`zstd-wasm: failed to fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function initZstd(): Promise<void> {
  if (zstd) return;
  const mod = (await import('./vendor/zstd/zstd-wasm.mjs')) as {
    Module: ZstdModule;
    waitInitialized: () => Promise<void>;
    compress: (buf: Uint8Array, level: number) => Uint8Array;
    decompress: (buf: Uint8Array) => Uint8Array;
  };
  const bytes = await loadWasmBytes();
  mod.Module.init(bytes);
  await mod.waitInitialized();
  zstd = { compress: mod.compress, decompress: mod.decompress };
}

export const constants = {
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_enableLongDistanceMatching: 101,
  ZSTD_c_windowLog: 102,
  ZSTD_d_windowLogMax: 200,
};

export function zstdCompressSync(data: Uint8Array, opts?: { params?: Record<number, number> }): Uint8Array {
  if (!zstd) throw new Error('zstd-wasm: initZstd() was not awaited before compressing');
  const level = opts?.params?.[constants.ZSTD_c_compressionLevel] ?? 3;
  return zstd.compress(data, level);
}

// bek-ts's container.ts/decode.ts treat this return value as a Buffer
// (readUInt32LE, subarray, etc.) -- @bokuweb's decompress() returns a plain
// Uint8Array, so it has to be rewrapped: the global `Buffer` here is
// Node's real one in the Node build (scripts/build-verify.mjs, no inject
// needed) and src/buffer-polyfill.ts's Buf in the browser build (injected
// by esbuild.config.mjs into every module in the bundle).
declare const Buffer: { from(data: Uint8Array): Uint8Array };

export function zstdDecompressSync(data: Uint8Array): Uint8Array {
  if (!zstd) throw new Error('zstd-wasm: initZstd() was not awaited before decompressing');
  return Buffer.from(zstd.decompress(data));
}
