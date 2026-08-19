# BEK Online Coder

Encodes 3D Gaussian Splatting `.ply` scenes into the compact `.bek` container
&mdash; entirely in your browser. Nothing is uploaded: the file is read,
encoded, and offered for download without ever leaving the tab.

Live page: served from `docs/` via GitHub Pages (see the Actions workflow).

## What this is

A static-site wrapper around [`bek-ts`](../bek-ts), a TypeScript/Node port of
the BEK codec (`.ply` &rarr; `.bek`), with two Node-only pieces replaced so it
can run in a browser tab:

- **WebP.** `bek-ts` shells out to Homebrew's `cwebp`/`dwebp`. This project
  instead uses a vendored WebAssembly build of libwebp from
  [PlayCanvas `splat-transform`](https://github.com/playcanvas/splat-transform)
  (`vendor/webp.wasm` + `vendor/webp.mjs`, MIT license, Copyright PlayCanvas)
  and calls `webp_encode_lossless_rgba` directly &mdash; verified
  byte-identical to the C++ reference's `cwebp -lossless -m 4 -q 100 -exact`
  output (see `scripts/verify-node-entry.ts`).
- **zstd.** `bek-ts` uses `node:zlib`'s zstd bindings, which don't exist in a
  browser. This project writes a valid zstd frame made entirely of
  `Raw_Block`s (uncompressed passthrough blocks) &mdash; no compression
  library, no wasm. Real compression only bought ~0.3% on `room.ply` because
  the payload is already entropy-coded upstream (range coder / WebP), so it
  wasn't worth another wasm blob. `build/bek_to_ply` (the C++ reference
  decoder) decompresses it without error &mdash; that's the correctness bar,
  not a matching library.

Neither of these touches `bek-ts`'s source. Both are swapped in with an
esbuild `onResolve` alias (`esbuild-alias-plugin.mjs`) that redirects
`./webp.ts` &rarr; `src/webp-wasm.ts` and `node:zlib` &rarr; `src/zstd-raw.ts`
only when imported from the vendored codec files. A third alias
(`./order.ts` / `./rvq.ts` &rarr; `src/order-progress.ts` / `src/rvq-progress.ts`)
adds progress-reporting hooks around the sort and RVQ (k-means) stages, since
those dominate encode time and the UI needs to show real phase progress
without a modified, un-verifiable copy of the codec.

`vendor/bek-ts/` is a frozen, unmodified copy of the `bek-ts` source files
this project actually imports (`encode.ts`, `container.ts`, `cbor.ts`,
`order.ts`, `quantize.ts`, `rangecoder.ts`, `rvq.ts`) &mdash; vendored because
GitHub Actions can't reach the sibling `../bek-ts` checkout this was
developed against. Run `scripts/sync-codec.sh` to refresh it from `../bek-ts`
when that project changes; nothing in this repo edits those files.

## Build

```bash
npm install
npm run build       # esbuild -> docs/ (index.html, main.js, worker.js, style.css, vendor/)
```

Serve `docs/` with any static file server to try it locally, e.g.
`python3 -m http.server 8080 --directory docs`.

## Verify

```bash
npm run verify       # bundles the same wasm-webp + zstd-raw path for Node,
                      # encodes bek-ts/data/tiny.ply, and diffs the pre-zstd
                      # buffer against bek-ts/test/ref_tiny_strict.raw
```

Decode the resulting `.bek` (or one downloaded from the page) with the C++
reference decoder to confirm the zstd-raw frame and channel encoding are
correct:

```bash
/path/to/3DGS-Compression-C++/build/bek_to_ply scratch-verify/tiny.bek out.ply
```

## Parameters

The page starts from the codec's default operating point (`dc_stages=2`,
`sh_stages=3`, `pos_bits=9`, `vq_iters=30`, `sort_refine=128`,
`rot_mag_bits=6`). The collapsible "Advanced parameters" section exposes
exactly the flags `bek-ts/src/cli.ts` implements for the encode path
(`--dc-stages`, `--sh-stages`, `--pos-bits`, `--vq-iters`, `--sort-refine`,
`--rot-mag-bits`) &mdash; nothing invented beyond what the codec accepts.

## Performance

Encoding is CPU-bound, single-threaded, and dominated by RVQ (k-means)
training &mdash; roughly 95% of wall time. `bek-ts`'s own measurement: ~5s
for a 20k-splat scene, and multiple minutes for real scenes in the
1-2M-splat range. It all runs in a Web Worker so the tab stays responsive,
but there's no server to offload the work to &mdash; that's the tradeoff for
"nothing ever leaves your browser."

## License / attribution

This project's own code has no stated license (ask the author). The vendored
WebAssembly build (`vendor/webp.wasm`, `vendor/webp.mjs`) is copied from
[`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform),
MIT licensed, Copyright (c) PlayCanvas, which itself builds on
[Google's libwebp](https://chromium.googlesource.com/webm/libwebp) (BSD-3-Clause).
