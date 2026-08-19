// Alias target for vendor/bek-ts/src/encode.ts's `import ... from './rvq.ts'`
// (esbuild.config.mjs redirects that specifier here).
//
// Re-exports everything from the real, unmodified vendored rvq.ts EXCEPT
// computeRvq, which is reimplemented here as a thin orchestration wrapper so
// we get a progress hook at each RVQ stage boundary (encode.ts never calls
// trainVq directly -- only computeRvq -- and internal calls inside a module
// bind to local declarations, not to the export object, so wrapping the
// `trainVq` export alone would not intercept computeRvq's calls to it).
//
// This orchestration loop is copied verbatim from the real computeRvq
// (vendor/bek-ts/src/rvq.ts) -- it is pure sequencing (call trainVq, chain
// reorder if enabled, assignVq, subtract), not numeric code. The actual
// k-means math (trainVq, reorderCodebookChain, assignVq -- the parts that
// must stay bit-exact) is imported unmodified and called unmodified.
export * from '../vendor/bek-ts/src/rvq.ts';
import { trainVq, reorderCodebookChain, assignVq, type RvqResult } from '../vendor/bek-ts/src/rvq.ts';
import { report } from './progress.ts';

let stageIndex = 0;
let totalStages = 0;

// Called once by worker.ts before encoding starts, once the total stage
// count (dcStages + shStages + scaleStages, in the order encode.ts invokes
// them) is known, so progress fractions are correct from the first stage.
export function planRvqStages(n: number): void {
  totalStages += n;
}

export function computeRvq(
  features: Float32Array[], numStages: number, clustersPerStage: number, maxIters: number,
  cbChainOrder = true,
): RvqResult {
  const result: RvqResult = { codebooks: [], indices: [] };
  if (features.length === 0 || features[0].length === 0) return result;

  const numPoints = features[0].length;
  const dims = features.length;

  const current = new Float32Array(numPoints * dims);
  for (let d = 0; d < dims; d++) {
    const col = features[d];
    for (let i = 0; i < numPoints; i++) current[i * dims + d] = col[i];
  }

  for (let s = 0; s < numStages; s++) {
    report({ phase: 'rvq', status: 'start', stageIndex, totalStages, maxIters });
    const codebook = trainVq(current, numPoints, dims, clustersPerStage, maxIters);
    if (cbChainOrder) reorderCodebookChain(codebook, dims);
    const indices = assignVq(current, numPoints, dims, codebook);
    result.codebooks.push(codebook);
    result.indices.push(indices);

    for (let i = 0; i < numPoints; i++) {
      const c = indices[i];
      const po = i * dims;
      const co = c * dims;
      for (let d = 0; d < dims; d++) current[po + d] -= codebook[co + d];
    }
    stageIndex++;
    report({ phase: 'rvq', status: 'done', stageIndex, totalStages, maxIters });
  }

  return result;
}
