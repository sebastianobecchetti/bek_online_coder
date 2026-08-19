// Alias target for vendor/bek-ts/src/encode.ts's `import ... from './order.ts'`
// (esbuild.config.mjs redirects that specifier here). Re-exports the real,
// unmodified sortMorton/reorder/etc. from the vendored module, wrapping only
// sortMorton with start/done progress hooks -- see src/progress.ts.
export * from '../vendor/bek-ts/src/order.ts';
import { sortMorton as realSortMorton } from '../vendor/bek-ts/src/order.ts';
import { report } from './progress.ts';

export function sortMorton(x: Float32Array, y: Float32Array, z: Float32Array, refineWindow: number): Uint32Array {
  report({ phase: 'sort', status: 'start' });
  const r = realSortMorton(x, y, z, refineWindow);
  report({ phase: 'sort', status: 'done' });
  return r;
}
