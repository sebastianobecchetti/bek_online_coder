// esbuild onResolve plugin: redirects the three bek-ts codec import
// specifiers that need browser/Node-without-subprocess replacements, without
// touching vendor/bek-ts/src at all (per the task constraint). See each
// target file's header comment for why:
//   ./webp.ts   -> src/webp-wasm.ts   (wasm libwebp instead of cwebp/dwebp subprocess)
//   ./order.ts  -> src/order-progress.ts (adds a sortMorton progress hook)
//   ./rvq.ts    -> src/rvq-progress.ts   (adds a per-RVQ-stage progress hook)
//   node:zlib   -> src/zstd-wasm.ts   (real zstd in wasm instead of node:zlib)
//   ./ply.ts    -> src/ply-shim.ts    (decode.ts's `import { writePly } from './ply.ts'`
//                                      is fs-based and unused by this project -- see
//                                      src/ply-shim.ts for why it still has to resolve)
// These specifier strings are literal in vendor/bek-ts/src/encode.ts and
// container.ts only; the progress wrapper files themselves import the real
// vendored modules under a different (relative, non-matching) specifier, so
// there's no alias loop.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const ALIASES = {
  './webp.ts': path.join(here, 'src/webp-wasm.ts'),
  './order.ts': path.join(here, 'src/order-progress.ts'),
  './rvq.ts': path.join(here, 'src/rvq-progress.ts'),
  'node:zlib': path.join(here, 'src/zstd-wasm.ts'),
  './ply.ts': path.join(here, 'src/ply-shim.ts'),
};

export const bekAliasPlugin = {
  name: 'bek-alias',
  setup(build) {
    for (const [specifier, target] of Object.entries(ALIASES)) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === specifier) return { path: target };
        return null;
      });
    }
  },
};
