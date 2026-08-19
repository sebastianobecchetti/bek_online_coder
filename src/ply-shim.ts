// Alias target for vendor/bek-ts/src/decode.ts's
// `import { writePly, type VertexData } from './ply.ts'` (esbuild-alias-plugin.mjs
// redirects that specifier here). bek-ts's real ply.ts is fs-based (node:fs),
// which doesn't exist in a browser -- but decode.ts only calls `writePly`
// inside `decodeToPly`, a function this project never calls (it uses
// `decode()` directly and serializes the result with
// `writePlyToArrayBuffer` from ply-browser.ts instead). This shim exists
// purely so the import resolves; the real work happens in ply-browser.ts.
export type { VertexData } from './ply-browser.ts';

export function writePly(): never {
  throw new Error('ply-shim: writePly (fs-based, from decodeToPly) is not available in the browser -- this project never calls decodeToPly. See ply-browser.ts writePlyToArrayBuffer.');
}
