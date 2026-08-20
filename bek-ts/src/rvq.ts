// RNG + Lloyd portion of sh_vq.cpp (F3 scope only). See DESIGN.md §3.4, §3.9.

// std::mt19937, 32-bit Mersenne Twister, matching libstdc++/libc++ (identical
// standard algorithm; verified against the canonical test vector in
// test/vectors.ts: seed 5489, 10000th output === 4123659995).
export class Mt19937 {
  private static readonly N = 624;
  private static readonly M = 397;
  private static readonly MATRIX_A = 0x9908b0df;
  private static readonly UPPER_MASK = 0x80000000;
  private static readonly LOWER_MASK = 0x7fffffff;

  private mt = new Uint32Array(Mt19937.N);
  private mti = Mt19937.N + 1;

  constructor(seed: number) {
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < Mt19937.N; i++) {
      // mt[i] = (1812433253 * (mt[i-1] ^ (mt[i-1] >> 30)) + i)
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      // 32x32->32 multiply, matching uint32_t wraparound. Split into hi/lo
      // 16-bit halves so the product stays within Number.MAX_SAFE_INTEGER.
      const lo = prev & 0xffff;
      const hi = prev >>> 16;
      const prod = ((((hi * 1812433253) & 0xffff) << 16) >>> 0) + lo * 1812433253;
      this.mt[i] = (prod + i) >>> 0;
    }
    this.mti = Mt19937.N;
  }

  next(): number {
    const { N, M, MATRIX_A, UPPER_MASK, LOWER_MASK } = Mt19937;
    const mag01 = [0, MATRIX_A];
    if (this.mti >= N) {
      const mt = this.mt;
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = (mt[kk + M] ^ (y >>> 1) ^ mag01[y & 1]) >>> 0;
      }
      for (; kk < N - 1; kk++) {
        const y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = (mt[kk + (M - N)] ^ (y >>> 1) ^ mag01[y & 1]) >>> 0;
      }
      const y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = (mt[M - 1] ^ (y >>> 1) ^ mag01[y & 1]) >>> 0;
      this.mti = 0;
    }
    let y = this.mt[this.mti++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

// std::uniform_int_distribution<int>(a, b) for a 32-bit engine, libc++
// algorithm (DESIGN.md §3.9): for the full-range engine used here (mt19937
// produces 32 uniform bits), the "extract w bits" step reduces to the low w
// bits of one engine draw, with rejection when that value >= Rp.
function uniformInt(rng: Mt19937, a: number, b: number): number {
  const Rp = (b - a + 1) >>> 0; // range size; fits in uint32 for our use (b < 2^31)
  if (Rp === 1) return a;
  let w = 32 - Math.clz32(Rp) - 1;
  if ((Rp & (0xffffffff >>> (32 - w))) !== 0) w++;
  const mask = w >= 32 ? 0xffffffff : ((1 << w) - 1) >>> 0;
  let u: number;
  do {
    u = rng.next() & mask;
  } while (u >= Rp);
  return u + a;
}

// sh_vq.cpp:40-51 subset_indices construction (Fisher-Yates-ish partial
// shuffle via uniform_int_distribution(i, num_points-1)).
export function buildSubsetIndices(numPoints: number, sampleSize: number): Int32Array {
  const idx = new Int32Array(numPoints);
  for (let i = 0; i < numPoints; i++) idx[i] = i;
  const rng = new Mt19937(0);
  for (let i = 0; i < sampleSize; i++) {
    const j = uniformInt(rng, i, numPoints - 1);
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx;
}

// sample_size = min(35000, max(5000, trunc(num_points * 0.10))) — sh_vq.cpp:44-46.
export function sampleSize(numPoints: number, sampleCap = 35000): number {
  return Math.min(sampleCap, Math.max(5000, Math.trunc(numPoints * 0.1)), numPoints);
}

// sh_vq.cpp:291-355 quantize_scalar_lloyd — 1D k-means (Lloyd) used to build
// the pooled RVQ codebook quantization (num_levels=256, max_iters=20 on the
// default path). Operates on plain float32 scalars.
export interface QuantizedScalarCodebook {
  levels: Float32Array;
  indices: Uint8Array;
}

export function quantizeScalarLloyd(data: Float32Array, numLevels: number, maxIters: number): QuantizedScalarCodebook {
  const n = data.length;
  const res: QuantizedScalarCodebook = { levels: new Float32Array(0), indices: new Uint8Array(0) };
  if (n === 0) return res;

  numLevels = Math.min(numLevels, n);
  const levels = new Float32Array(numLevels);

  let dmin = data[0];
  let dmax = data[0];
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (v < dmin) dmin = v;
    if (v > dmax) dmax = v;
  }

  if (numLevels > 1) {
    for (let i = 0; i < numLevels; i++) {
      // dmin + (dmax - dmin) * (float(i) / (numLevels - 1)), all float32.
      const frac = Math.fround(Math.fround(i) / (numLevels - 1));
      levels[i] = Math.fround(dmin + Math.fround(Math.fround(dmax - dmin) * frac));
    }
  } else {
    levels[0] = Math.fround(Math.fround(dmin + dmax) / 2.0);
  }

  const labels = new Int32Array(n);
  const newLevels = new Float32Array(numLevels);
  const counts = new Int32Array(numLevels);

  for (let iter = 0; iter < maxIters; iter++) {
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      let bestL = 0;
      const v = data[i];
      for (let l = 0; l < numLevels; l++) {
        const dist = Math.abs(Math.fround(v - levels[l]));
        if (dist < minDist) {
          minDist = dist;
          bestL = l;
        }
      }
      labels[i] = bestL;
    }

    newLevels.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const l = labels[i];
      newLevels[l] = Math.fround(newLevels[l] + data[i]);
      counts[l]++;
    }

    let changed = false;
    for (let l = 0; l < numLevels; l++) {
      if (counts[l] > 0) {
        const nl = Math.fround(newLevels[l] / counts[l]);
        if (Math.abs(levels[l] - nl) > 1e-6) {
          changed = true;
          levels[l] = nl;
        }
      }
    }
    if (!changed) break;
  }

  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = labels[i];

  return { levels, indices };
}

// ---------- sh_vq.cpp:14-27 compute_dist_sq — weights branch eliminated
// (the default op point always calls with weights=nullptr, i.e. plain L2). ----------

export function computeDistSq(a: Float32Array, ao: number, b: Float32Array, bo: number, dims: number): number {
  let dist = 0;
  for (let d = 0; d < dims; d++) {
    const diff = Math.fround(a[ao + d] - b[bo + d]);
    dist = Math.fround(dist + Math.fround(diff * diff));
  }
  return dist;
}

// ---------- sh_vq.cpp:30-118 train_vq_optimized (default path: no weights).
// Assignment loop has compute_dist_sq inlined by hand (DESIGN.md §5.2) — this
// is the single hottest loop in the encoder. ----------

export function trainVq(interleaved: Float32Array, numPoints: number, dims: number, numClustersIn: number, maxIters: number): Float32Array {
  if (interleaved.length === 0 || numPoints === 0) return new Float32Array(0);

  let numClusters = Math.min(numClustersIn, numPoints);
  const ss = Math.min(sampleSize(numPoints), numPoints);
  numClusters = Math.min(numClusters, ss);

  const subsetIdx = buildSubsetIndices(numPoints, ss);
  const subset = new Float32Array(ss * dims);
  for (let i = 0; i < ss; i++) {
    const srcOff = subsetIdx[i] * dims;
    const dstOff = i * dims;
    for (let d = 0; d < dims; d++) subset[dstOff + d] = interleaved[srcOff + d];
  }

  const codebook = new Float32Array(numClusters * dims);
  for (let i = 0; i < numClusters; i++) {
    const off = i * dims;
    for (let d = 0; d < dims; d++) codebook[off + d] = subset[off + d];
  }

  const labels = new Int32Array(ss);
  const counts = new Int32Array(numClusters);
  const newCodebook = new Float32Array(numClusters * dims);

  for (let iter = 0; iter < maxIters; iter++) {
    for (let i = 0; i < ss; i++) {
      let minDist = Infinity;
      let bestC = 0;
      const po = i * dims;
      for (let c = 0; c < numClusters; c++) {
        const co = c * dims;
        let dist = 0;
        for (let d = 0; d < dims; d++) {
          const diff = Math.fround(subset[po + d] - codebook[co + d]);
          dist = Math.fround(dist + Math.fround(diff * diff));
        }
        if (dist < minDist) { minDist = dist; bestC = c; }
      }
      labels[i] = bestC;
    }

    counts.fill(0);
    newCodebook.fill(0);
    for (let i = 0; i < ss; i++) {
      const c = labels[i];
      counts[c]++;
      const po = i * dims;
      const co = c * dims;
      for (let d = 0; d < dims; d++) newCodebook[co + d] += subset[po + d]; // f32 += f32, matches C++ float accumulation
    }

    for (let c = 0; c < numClusters; c++) {
      if (counts[c] > 0) {
        const co = c * dims;
        for (let d = 0; d < dims; d++) codebook[co + d] = newCodebook[co + d] / counts[c];
      }
    }
  }
  return codebook;
}

// ---------- sh_vq.cpp:120-146 assign_vq_optimized (default path: no weights). ----------

export function assignVq(interleaved: Float32Array, numPoints: number, dims: number, codebook: Float32Array): Uint16Array {
  const indices = new Uint16Array(numPoints);
  if (interleaved.length === 0 || codebook.length === 0) return new Uint16Array(0);
  const numClusters = codebook.length / dims;
  for (let i = 0; i < numPoints; i++) {
    let minDist = Infinity;
    let bestC = 0;
    const po = i * dims;
    for (let c = 0; c < numClusters; c++) {
      const co = c * dims;
      let dist = 0;
      for (let d = 0; d < dims; d++) {
        const diff = Math.fround(interleaved[po + d] - codebook[co + d]);
        dist = Math.fround(dist + Math.fround(diff * diff));
      }
      if (dist < minDist) { minDist = dist; bestC = c; }
    }
    indices[i] = bestC;
  }
  return indices;
}

// ---------- sh_vq.cpp:207-241 reorder_codebook_chain (default: cb_chain_order
// is always true on the default op point, weights always null). Mutates
// `codebook` in place: pure relabelling, same centroids, new numbering. ----------

export function reorderCodebookChain(codebook: Float32Array, dims: number): void {
  const K = codebook.length === 0 ? 0 : codebook.length / dims;
  if (K <= 2) return;

  const mean = new Float32Array(dims);
  for (let c = 0; c < K; c++) {
    const off = c * dims;
    for (let d = 0; d < dims; d++) mean[d] += codebook[off + d];
  }
  for (let d = 0; d < dims; d++) mean[d] = mean[d] / K;

  const used = new Uint8Array(K);
  const order = new Int32Array(K);

  let cur = 0;
  let best = Infinity;
  for (let c = 0; c < K; c++) {
    const dist = computeDistSq(mean, 0, codebook, c * dims, dims);
    if (dist < best) { best = dist; cur = c; }
  }

  for (let step = 0; step < K; step++) {
    used[cur] = 1;
    order[step] = cur;
    let next = -1;
    let bestD = Infinity;
    const curOff = cur * dims;
    for (let c = 0; c < K; c++) {
      if (used[c]) continue;
      const dist = computeDistSq(codebook, curOff, codebook, c * dims, dims);
      if (dist < bestD) { bestD = dist; next = c; }
    }
    if (next < 0) break;
    cur = next;
  }

  const reordered = new Float32Array(codebook.length);
  for (let slot = 0; slot < K; slot++) {
    const src = order[slot] * dims;
    const dst = slot * dims;
    for (let d = 0; d < dims; d++) reordered[dst + d] = codebook[src + d];
  }
  codebook.set(reordered);
}

// ---------- sh_vq.cpp:243-278 compute_rvq (default path: weights empty,
// cb_chain_order applied unless --no-rvq-cb-order). ----------

export interface RvqResult {
  codebooks: Float32Array[]; // one per stage, length clustersPerStage*dims
  indices: Uint16Array[];    // one per stage, length numPoints
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
    const codebook = trainVq(current, numPoints, dims, clustersPerStage, maxIters);
    if (cbChainOrder) reorderCodebookChain(codebook, dims);
    const indices = assignVq(current, numPoints, dims, codebook);
    result.codebooks.push(codebook);
    result.indices.push(indices);

    for (let i = 0; i < numPoints; i++) {
      const c = indices[i];
      const po = i * dims;
      const co = c * dims;
      for (let d = 0; d < dims; d++) current[po + d] -= codebook[co + d]; // f32 -=, auto-narrows on store
    }
  }

  return result;
}

// ---------- sh_vq.cpp:357-378 pack_rvq_pooled: Lloyd-quantize the pooled
// codebook floats to 256 shared levels, split back per stage as byte indices
// into that shared level table. Skips the C++'s q.codebooks (dequantized
// float centroids) — that field is computed but never consumed by the
// encoder; the decoder reconstructs codebook[e] = levels[cb_indices[e]] itself. ----------

export interface RvqPooled {
  cbIndices: Uint8Array[];     // one per stage, length clustersPerStage*dims — indices into `levels`
  levels: Float32Array;        // shared 256-entry Lloyd-quantized level table
  pointIndices: Uint16Array[]; // = RvqResult.indices, passed through unchanged
}

export function packRvqPooled(res: RvqResult): RvqPooled {
  const out: RvqPooled = { cbIndices: [], levels: new Float32Array(0), pointIndices: res.indices };
  if (res.codebooks.length === 0) return out;

  let poolLen = 0;
  for (const cb of res.codebooks) poolLen += cb.length;
  const pool = new Float32Array(poolLen);
  let off = 0;
  for (const cb of res.codebooks) { pool.set(cb, off); off += cb.length; }

  const qcb = quantizeScalarLloyd(pool, 256, 20);
  out.levels = qcb.levels;

  off = 0;
  for (const cb of res.codebooks) {
    out.cbIndices.push(qcb.indices.slice(off, off + cb.length));
    off += cb.length;
  }
  return out;
}
