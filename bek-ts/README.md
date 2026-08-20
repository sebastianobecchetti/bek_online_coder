# bek-ts

TypeScript/Node port of the BEK 3D Gaussian Splatting codec. Encodes a
`.ply` into the `.bek` container and back. Zero npm runtime dependencies.

The reference implementation -- the C++ codec, the parameter sweep harness and
the BEK Simulation Studio GUI -- lives in
**[bek](https://github.com/sebastianobecchetti/bek)**. This port targets
byte-level parity with it; "the C++ reference" throughout this file means that
repository's `ply_to_bek` / `bek_to_ply`.
See `DESIGN.md` for the full design rationale.

The default invocation (no flags) is **byte-identical** to the original
default-operating-point-only port. On top of that, `src/cli.ts` accepts a
growing subset of `ply_to_bek`'s CLI flags -- same names, same defaults --
so the Python sweep harness can drive this codec exactly like the C++
binary. See "Flag parity" below for what's implemented and verified.

## Build & use

```bash
npm install        # devDependencies: typescript only
npm run build       # tsc -> dist/
node dist/cli.js encode <in.ply> <out.bek> [options]
node dist/cli.js decode <in.bek> <out.ply>
```

Or run straight from source (no build step) with Node's native TS stripping:

```bash
node --experimental-strip-types src/cli.ts encode <in.ply> <out.bek> [options]
node --experimental-strip-types src/cli.ts decode <in.bek> <out.ply>
```

Self-check (round-trips + cross-checks against the C++ reference; needs the
C++ binaries and reference files described below):

```bash
node --experimental-strip-types test/vectors.ts    # default op point -> ALL VECTORS PASSED
node --experimental-strip-types test/wave1_grid.ts # parametrized flags, full grid -> ALL PASSED
node --experimental-strip-types test/wave2_grid.ts # scale-stages + no-* flags -> ALL PASSED
```

## Flag parity

Flag names and defaults mirror `ply_to_bek.cpp:80-182` exactly. Verification
method: encode `data/tiny.ply` with the strict-IEEE reference binary
(`refbuild/src_copy/build/ply_to_bek`, same flags) and with this port, then
compare all channels' `meta` (excluding `codec`) and blob byte-for-byte
(full L2). See `test/wave1_grid.ts` / `test/wave2_grid.ts` for the exact
combinations run.

| flag | implemented | verified L2 | notes |
|---|---|---|---|
| `--dc-stages N` | yes | yes | `test/wave1_grid.ts` |
| `--sh-stages N` | yes | yes | `test/wave1_grid.ts` |
| `--sh1-stages N` | yes (alias of `--sh-stages`) | yes | same code path |
| `--sh2-stages N` / `--sh3-stages N` | yes (parsed, ignored) | n/a | matches C++: consumes arg, no-op |
| `--vq-iters N` | yes | yes | `test/wave1_grid.ts` |
| `--pos-bits N` | yes | yes | `test/wave1_grid.ts` |
| `--sort-refine N` | yes (0 disables 2-opt) | yes | `test/wave1_grid.ts` |
| `--rot-mag-bits N` | yes (clamped 2..6) | yes | `test/wave1_grid.ts` |
| `--rvq-cb-order` / `--no-rvq-cb-order` | yes | yes | `test/wave1_grid.ts` |
| `--scale-stages N` | yes (RVQ on scales, `vq_scale_s*`) | yes (L2 + L1) | `test/wave2_grid.ts` |
| `--no-positions` | yes | yes (L2 + L1) | `test/wave2_grid.ts` |
| `--no-opacity` | yes | yes (L2 + L1) | `test/wave2_grid.ts` |
| `--no-rotation` | yes | yes (L2 + L1) | `test/wave2_grid.ts` |
| `--no-scale` | yes | yes (L2 + L1) | `test/wave2_grid.ts` |
| `--dc-kmeans N` / `--sh-kmeans N` | no | -- | not ported this session |
| `--sort-mode nn` | no | -- | not ported this session |
| `--sort-metric bits` | no | -- | not ported this session |
| `--sh-whiten P` | no | -- | not ported this session |
| `--pos-joint` | no | -- | not ported this session |
| `--rot-split` | no | -- | not ported this session |
| `--legacy-tail` | no | -- | not ported this session |
| `--save-vq` / `--load-vq` | no | -- | not ported this session |
| `--cb-float` | no | -- | not ported this session |

Unported flags are **rejected with an error** by the CLI parser
(`src/cli.ts:50`), rather than being silently ignored: a sweep that relies on
one of those axes fails loudly instead of quietly falling back to the default
for it. Unrecognized flags error too.

## System prerequisite: libwebp

Three of the eleven default channels (`vq_sh_ac_s0/1/2`) win the codec
best-of with lossless WebP. This port shells out to Homebrew's `cwebp`/
`dwebp` rather than reimplementing VP8L or vendoring a WASM build (see
`DESIGN.md` §4.2 for why):

```bash
brew install webp
```

Encoding and decoding both fail without `cwebp`/`dwebp` on `$PATH`. Verified
against `libwebp` 1.6.0, the same version the C++ reference links
(`otool -L build/ply_to_bek` -> `/opt/homebrew/opt/webp/lib/libwebp.7.dylib`).
The exact flags (`-lossless -m 4 -q 100 -exact`) were found by grid-probing
`-m 0..6 x {-exact, off}` against real reference blobs -- `-m 4` is the only
method that reproduces the C++ output byte-for-byte on all three channels
(`refbuild/probe_webp.ts`). If Homebrew ever ships a `libwebp` update that
changes the lossless encoder's bitstream, re-run that probe and the strict
reference build (below) before trusting L2 again.

## Equivalence level reached

DESIGN.md §2 defines four levels; this port reaches:

- **L1 (full, both directions).** `bek_to_ply` (production C++ binary)
  decodes a `.bek` this port wrote into the strict-IEEE reference PLY
  byte-for-byte; this port's decoder reads a production `.bek` and matches
  production `bek_to_ply`'s own output byte-for-byte. See `test/vectors.ts`
  F6/F7.
- **L2, full, on `data/tiny.ply` (20 000 splats, 0 Morton ties).** The
  pre-zstd uncompressed buffer (header CBOR + all 11 channel blobs) this
  port produces is byte-identical to the C++ reference's, **11/11 channels**,
  meta and blob both. See `test/vectors.ts` F5.
- **L2' on real scenes: not measured in this session.** DESIGN.md's F8
  (`room_low.ply`, 1.1M splats, 6 Morton tie groups) was not run here. L1 is
  expected to still hold (it doesn't depend on tie-breaking or float
  strictness), but the per-channel/per-blob L2' claims are unverified beyond
  `tiny.ply`.
- **L3 (byte-identical final `.bek`) is out of scope by design** -- the
  production C++ encoder uses `ZSTD_c_nbWorkers = hardware_concurrency()`,
  which its own source comment documents as producing "compressed bytes
  [that] may differ marginally from the single-thread output" -- i.e. it
  isn't even reproducible against *itself* on a different core count. This
  port's zstd call never sets `nbWorkers`, so its output is deterministic
  but structurally cannot match the multi-threaded reference bit-for-bit.

## The `-ffast-math` problem (and how it was closed)

The production C++ repo compiles with `-ffast-math` (`CMakeLists.txt:9`).
That legalizes FMA contraction in the k-means/RVQ accumulation loop of
`sh_vq.cpp`, which silently breaks strict per-operation IEEE-754 float32
rounding -- the exact contract this port's `Float32Array`-based
`src/rvq.ts` implements. Comparing this port directly against the
production binary's RVQ-trained channels (`vq_dc_s*`, `vq_sh_ac_s*`)
therefore looked like a divergence that wasn't actually a bug.

Closed by building an independent, unmodified-source, strict-IEEE reference:
`refbuild/src_copy` is an `rsync` copy of the production repo (excluding
`build/`, `.git/`, `.venv/`, `data/`, `*.ply`) with exactly one line of
`CMakeLists.txt` changed (`-ffast-math` -> `-fno-fast-math -ffp-contract=off`).
**The production repo was never modified.** See `refbuild/README.md` for the
exact reproduction steps. Confirmed effect on `tiny.ply`, RVQ stage 0, DC
codebook entry 1:

```
production (-ffast-math): levels[0][1] = -1.83009386
strict IEEE (refbuild/):   levels[0][1] = -1.83009374
this port (TS):            levels[0][1] = -1.8300937414169312
```

The strict build matches this port bit-for-bit. `test/vectors.ts` F5 checks
the RVQ-trained channels against `test/ref_tiny_strict.raw` (generated from
`refbuild/`'s output), not against the production `-ffast-math` binary.

## Measured times (`data/tiny.ply`, 20 000 splats, Apple M-series)

| | this port (TS) | C++ reference |
|---|---|---|
| encode | ~9.9 s | ~0.37 s (25-30x faster) |
| decode | ~0.37 s | ~0.14 s (2.5x faster) |

Encode is dominated by the RVQ (k-means) training loops and the WebP
subprocess round trips; DESIGN.md §5 anticipated a 5-15x slowdown on larger
scenes from the k-means cost alone -- consistent with what's measured here
on a small input where subprocess/startup overhead is proportionally larger.
No `worker_threads` parallelism has been added (DESIGN.md §5 point 4: only
add it if a real-scene run shows it's needed -- not measured in this
session).

## File layout

See `DESIGN.md` §6. `src/cli.ts` is the entry point; `src/encode.ts` +
`src/container.ts` are the encode path, `src/decode.ts` the decode path.
`src/webp.ts` shells out to `cwebp`/`dwebp`. `refbuild/` and
`test/ref_tiny*.{raw,cbor}` are verification scaffolding, not part of the
shipped codec.

## Known gaps

- Real-scene (`room_low.ply` / F8) validation not run in this session --
  L2' status on scenes with Morton ties is unverified, including for the
  newly-added flags.
- No `worker_threads`; encode is single-threaded aside from the WebP
  subprocesses.
- See "Flag parity" above for exactly which `ply_to_bek` flags are ported
  (`--dc-kmeans`/`--sh-kmeans`/`--sort-mode nn`/`--sort-metric bits`/
  `--sh-whiten`/`--pos-joint`/`--rot-split`/`--legacy-tail`/
  `--save-vq`/`--load-vq`/`--cb-float` are not, as of this session).

## Datasets

All simulations and measurements referenced here were run on the scenes
distributed with
**[graphdeco-inria/gaussian-splatting](https://github.com/graphdeco-inria/gaussian-splatting)**.
The scenes are not redistributed in this repository: fetch them from there and
place the `.ply` files in `data/`. `data/tiny.ply` is a 20 000-splat subset cut
from one of those scenes for the self-checks.
