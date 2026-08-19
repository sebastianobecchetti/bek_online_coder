#!/usr/bin/env bash
# Re-vendors the bek-ts codec source this project bundles, from the sibling
# dev checkout at ../bek-ts. Run this manually whenever bek-ts changes and
# you want this project to pick up the update -- it is NOT run by the build
# or by CI (CI has no access to ../bek-ts; it only ever sees the committed
# vendor/bek-ts snapshot). This script only ever copies files OUT of
# ../bek-ts; it never writes into it.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=../bek-ts/src
DST=vendor/bek-ts/src
mkdir -p "$DST"

# Only the modules this project actually imports (encode path + types).
# webp.ts and node:fs-touching ply.ts are intentionally NOT vendored: this
# project aliases webp.ts to src/webp-wasm.ts and never uses ply.ts's
# fs-based reader/writer (see src/ply-browser.ts).
for f in cbor.ts order.ts quantize.ts rvq.ts rangecoder.ts encode.ts container.ts; do
  cp "$SRC/$f" "$DST/$f"
done

echo "Synced $(cd "$SRC" && git rev-parse HEAD 2>/dev/null || echo 'no-git') -> $DST"
