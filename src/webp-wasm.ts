// Shim for bek-ts/src/webp.ts, swapped in by the esbuild alias plugin
// (esbuild.config.mjs) so encode.ts's `import { webpEncode } from './webp.ts'`
// resolves here instead of the cwebp/dwebp subprocess version.
//
// Uses PlayCanvas splat-transform's webp.wasm (MIT, vendor/webp.wasm +
// vendor/webp.mjs -- see README.md for attribution). Verified experimentally
// (see task notes / scripts/verify-node.mjs) that `webp_encode_lossless_rgba`
// produces byte-identical output to the C++ reference's cwebp
// `-lossless -m 4 -q 100 -exact` call: WebPConfigLosslessPreset(6) resolves
// to method 4, which is exactly what WebPEncodeLosslessRGBA (the function
// this wasm build's C wrapper calls) uses by default.
//
// vendor/webp.mjs is imported dynamically with the specifier './vendor/webp.mjs',
// marked external in every esbuild config that bundles this file (see
// esbuild.config.mjs / scripts/build-verify.mjs) so esbuild leaves the
// import statement untouched. That specifier is resolved at *runtime*
// relative to the bundle's own output location, so every build that
// bundles this module must place its output file directly in a directory
// that has a `vendor/webp.mjs` + `vendor/webp.wasm` sitting next to it
// (both build configs copy vendor/ into their output dir for this reason).

interface WebpModule {
  _malloc(n: number): number;
  _free(p: number): void;
  _webp_encode_lossless_rgba(rgba: number, w: number, h: number, stride: number, outBufPtr: number, outSizePtr: number): number;
  _webp_decode_rgba(data: number, dataSize: number, outBufPtr: number, outWidthPtr: number, outHeightPtr: number): number;
  _webp_free(p: number): void;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
}

let mod: WebpModule | null = null;

export async function initWebp(): Promise<void> {
  if (mod) return;
  const factory = (await import('./vendor/webp.mjs')).default as (cfg: object) => Promise<WebpModule>;
  mod = await factory({});
}

// `data` is the padded plane (W*H*ch bytes, ch===1 or 3) exactly as
// ply_to_bek.cpp / bek-ts's webp.ts build it. Builds RGBA (ch===1 replicated
// onto R/G/B, alpha=255) and calls the wasm lossless encoder synchronously.
export function webpEncode(data: Uint8Array, W: number, H: number, ch: 1 | 3): Uint8Array {
  if (!mod) throw new Error('webp-wasm: initWebp() was not awaited before encoding');
  const n = W * H;
  const rgba = new Uint8Array(n * 4);
  if (ch === 1) {
    for (let i = 0; i < n; i++) {
      const v = data[i];
      const o = i * 4;
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const s = i * 3, o = i * 4;
      rgba[o] = data[s]; rgba[o + 1] = data[s + 1]; rgba[o + 2] = data[s + 2]; rgba[o + 3] = 255;
    }
  }

  const inPtr = mod._malloc(rgba.length);
  const outPtrPtr = mod._malloc(4);
  const outSizePtr = mod._malloc(4);
  try {
    mod.HEAPU8.set(rgba, inPtr);
    const ok = mod._webp_encode_lossless_rgba(inPtr, W, H, W * 4, outPtrPtr, outSizePtr);
    if (!ok) throw new Error('webp-wasm: WebPEncodeLosslessRGBA failed');
    const outPtr = mod.HEAPU32[outPtrPtr >> 2];
    const outSize = mod.HEAPU32[outSizePtr >> 2];
    const bytes = mod.HEAPU8.slice(outPtr, outPtr + outSize);
    mod._webp_free(outPtr);
    return bytes;
  } finally {
    mod._free(inPtr);
    mod._free(outPtrPtr);
    mod._free(outSizePtr);
  }
}

// Mirrors bek-ts/src/webp.ts's webpDecode: decodes `blob` (a lossless WebP
// image) to RGBA, then unpacks exactly `n` bytes of the unpadded plane --
// ch===1 takes the R byte of each pixel (the plane was replicated onto
// R/G/B/A=255 on encode), ch===3 takes RGB and drops alpha, both discarding
// the W*H*ch - n zero padding tail bek_to_ply.cpp itself discards.
export function webpDecode(blob: Uint8Array, n: number, W: number, H: number, ch: 1 | 3): Uint8Array {
  if (!mod) throw new Error('webp-wasm: initWebp() was not awaited before decoding');
  const inPtr = mod._malloc(blob.length);
  const outPtrPtr = mod._malloc(4);
  const widthPtr = mod._malloc(4);
  const heightPtr = mod._malloc(4);
  try {
    mod.HEAPU8.set(blob, inPtr);
    const ok = mod._webp_decode_rgba(inPtr, blob.length, outPtrPtr, widthPtr, heightPtr);
    if (!ok) throw new Error('webp-wasm: WebPDecodeRGBA failed');
    const outPtr = mod.HEAPU32[outPtrPtr >> 2];
    const w = mod.HEAPU32[widthPtr >> 2];
    const h = mod.HEAPU32[heightPtr >> 2];
    if (w !== W || h !== H) {
      throw new Error(`webp-wasm: dimension mismatch ${w}x${h} vs expected ${W}x${H}`);
    }
    const rgba = mod.HEAPU8.subarray(outPtr, outPtr + w * h * 4);
    const out = new Uint8Array(n);
    if (ch === 1) {
      for (let k = 0; k < n; k++) out[k] = rgba[k * 4];
    } else {
      for (let k = 0; k < n / 3; k++) {
        out[k * 3] = rgba[k * 4]; out[k * 3 + 1] = rgba[k * 4 + 1]; out[k * 3 + 2] = rgba[k * 4 + 2];
      }
    }
    mod._webp_free(outPtr);
    return out;
  } finally {
    mod._free(inPtr);
    mod._free(outPtrPtr);
    mod._free(widthPtr);
    mod._free(heightPtr);
  }
}
