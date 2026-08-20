// Port of the ordering half of ply_reader.cpp (F5 scope): Morton encode/sort +
// windowed 2-opt refinement, and the generic pure-permutation reorder helper.
// See DESIGN.md §3.3 (63-bit Morton codes as hi/lo 32-bit halves, no BigInt;
// stable Array.sort vs non-stable std::sort) and §3.4 (cost_l1 / refine_2opt
// float32 arithmetic, evaluated left to right).

// ---------- Morton (Z-order) ----------

// Spreads the low 21 bits of v so bit k lands at bit 3k of a 63-bit code,
// split as [lo 32 bits, hi 31 bits]. A direct bit-by-bit spread (not the
// magic-constant bit-trick version) — only 21 iterations per point, and it's
// trivially correct instead of trivially wrong.
export function part1by2(v: number): [lo: number, hi: number] {
  v = v & 0x1fffff;
  let lo = 0;
  let hi = 0;
  for (let k = 0; k < 21; k++) {
    if (((v >>> k) & 1) === 0) continue;
    const bitPos = 3 * k;
    if (bitPos < 32) lo = (lo | (1 << bitPos)) >>> 0;
    else hi = (hi | (1 << (bitPos - 32))) >>> 0;
  }
  return [lo, hi];
}

function shiftLeftPair(lo: number, hi: number, shift: number): [number, number] {
  if (shift === 0) return [lo, hi];
  const carry = lo >>> (32 - shift);
  const newLo = (lo << shift) >>> 0;
  const newHi = ((hi << shift) | carry) >>> 0;
  return [newLo, newHi];
}

// encode_morton(x,y,z) = part1by2(x) | part1by2(y)<<1 | part1by2(z)<<2, as a
// 63-bit value returned split into [lo, hi] 32-bit halves (DESIGN.md §3.3).
export function encodeMorton(x: number, y: number, z: number): [lo: number, hi: number] {
  const [xlo, xhi] = part1by2(x);
  const [ylo0, yhi0] = part1by2(y);
  const [zlo0, zhi0] = part1by2(z);
  const [ylo, yhi] = shiftLeftPair(ylo0, yhi0, 1);
  const [zlo, zhi] = shiftLeftPair(zlo0, zhi0, 2);
  return [(xlo | ylo | zlo) >>> 0, (xhi | yhi | zhi) >>> 0];
}

// ---------- cost_l1 + windowed 2-opt (ply_reader.cpp:141-165, :313-315) ----------

export function costL1(x: Float32Array, y: Float32Array, z: Float32Array, a: number, b: number): number {
  return Math.fround(
    Math.fround(Math.abs(Math.fround(x[a] - x[b])) + Math.abs(Math.fround(y[a] - y[b]))) +
      Math.abs(Math.fround(z[a] - z[b])),
  );
}

// Mutates `order` in place; returns the number of passes run (capped at 4).
export function refine2opt(order: Uint32Array, W: number, cost: (a: number, b: number) => number): number {
  const n = order.length;
  if (n < 4 || W < 2) return 0;
  const kPasses = 4;
  let pass = 0;
  for (; pass < kPasses; pass++) {
    let improved = false;
    for (let i = 0; i + 3 < n; i++) {
      const a = order[i];
      const b = order[i + 1];
      const dab = cost(a, b);
      let jmax = i + 1 + W;
      if (jmax > n - 2) jmax = n - 2;
      let bestDelta = Math.fround(-1e-6);
      let bestJ = 0;
      for (let j = i + 2; j <= jmax; j++) {
        const c = order[j];
        const d = order[j + 1];
        const delta = Math.fround(Math.fround(cost(a, c) + cost(b, d)) - Math.fround(dab + cost(c, d)));
        if (delta < bestDelta) {
          bestDelta = delta;
          bestJ = j;
        }
      }
      if (bestJ !== 0) {
        // std::reverse(order.begin()+i+1, order.begin()+best_j+1): reverse the
        // inclusive range [i+1, bestJ].
        let lo = i + 1;
        let hi = bestJ;
        while (lo < hi) {
          const t = order[lo];
          order[lo] = order[hi];
          order[hi] = t;
          lo++;
          hi--;
        }
        improved = true;
      }
    }
    if (!improved) {
      pass++;
      break;
    }
  }
  return pass;
}

// ---------- sort_morton (ply_reader.cpp:264-333), default-path slice only:
// sort_mode=0 (Morton, no greedy-NN), metric=0 (L1, no bit-length metric). ----------

export function sortMorton(x: Float32Array, y: Float32Array, z: Float32Array, refineWindow: number): Uint32Array {
  const count = x.length;
  const identity = new Uint32Array(count);
  for (let i = 0; i < count; i++) identity[i] = i;
  if (count === 0) return identity;

  let minX = x[0], maxX = x[0];
  let minY = y[0], maxY = y[0];
  let minZ = z[0], maxZ = z[0];
  for (let i = 1; i < count; i++) {
    if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
    if (z[i] < minZ) minZ = z[i]; if (z[i] > maxZ) maxZ = z[i];
  }
  const rangeX = Math.max(Math.fround(maxX - minX), Math.fround(1e-6));
  const rangeY = Math.max(Math.fround(maxY - minY), Math.fround(1e-6));
  const rangeZ = Math.max(Math.fround(maxZ - minZ), Math.fround(1e-6));

  const MORTON_MAX = 2097151.0; // 2^21 - 1, computed in double (DESIGN.md §3.3)
  const lo = new Uint32Array(count);
  const hi = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const ix = (Math.trunc(Math.fround(Math.fround(x[i] - minX) / rangeX) * MORTON_MAX) >>> 0) & 0x1fffff;
    const iy = (Math.trunc(Math.fround(Math.fround(y[i] - minY) / rangeY) * MORTON_MAX) >>> 0) & 0x1fffff;
    const iz = (Math.trunc(Math.fround(Math.fround(z[i] - minZ) / rangeZ) * MORTON_MAX) >>> 0) & 0x1fffff;
    const [l, h] = encodeMorton(ix, iy, iz);
    lo[i] = l;
    hi[i] = h;
  }

  // Array.prototype.sort is stable; tie-break returns 0 so equal Morton codes
  // keep their original relative order (std::sort is not stable — see
  // DESIGN.md §3.3 on why this is an accepted, verifiable divergence point).
  const order = Array.from(identity);
  order.sort((a, b) => (hi[a] !== hi[b] ? (hi[a] < hi[b] ? -1 : 1) : lo[a] !== lo[b] ? (lo[a] < lo[b] ? -1 : 1) : 0));
  const orderU32 = Uint32Array.from(order);

  if (refineWindow > 1) {
    refine2opt(orderU32, refineWindow, (a, b) => costL1(x, y, z, a, b));
  }
  return orderU32;
}

// Pure permutation: out[i] = vec[indices[i]]. Data and indices move in
// lockstep, so reconstruction stays bit-identical (DESIGN.md non-negotiables).
export function reorder(vec: Float32Array, indices: Uint32Array): Float32Array {
  const n = vec.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = vec[indices[i]];
  return out;
}
