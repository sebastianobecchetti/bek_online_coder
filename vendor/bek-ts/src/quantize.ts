// Port of quantization.cpp (F5 scope, default-path functions only). See
// DESIGN.md §3.5 (cRound = std::round, half-away-from-zero; §3.6 24-bit
// modular DPCM + zigzag, sign extension via plain `>>`) and §3.4 (positions
// and quaternions stay in double — no fround beyond the exact float32 reads).

const SQRT1_2 = 0.7071067811865476;

// std::round: half away from zero (Math.round is half toward +Infinity).
export function cRound(v: number): number {
  return Math.sign(v) * Math.round(Math.abs(v));
}

// (v mod 2^24), result in [0, 2^24) for any finite v — floor-mod, matching
// the two's-complement truncation/masking chain in the C++ (static_cast to
// uint32_t then & 0xFFFFFF is equivalent to a floor-mod by 2^24).
function mod24(v: number): number {
  return v - Math.floor(v / 0x1000000) * 0x1000000;
}

// ---------- positions: quantize_position_spz_zz / dequantize_position_spz_zz ----------

export function quantizePositionSpzZz(data: Float32Array, fractionalBits: number): Uint8Array {
  const scale = Math.pow(2, fractionalBits); // double, matches (1 << fractional_bits) promoted to double
  const n = data.length;
  const out = new Uint8Array(n * 3);
  let prevQ = 0;
  for (let i = 0; i < n; i++) {
    const fixed = cRound(data[i] * scale); // static_cast<double>(data[i]) * scale, then std::round
    const curQ = mod24(fixed);
    let d = mod24(curQ - prevQ);
    if (d & 0x800000) d -= 0x1000000; // sign-extend the 24-bit modular delta
    const zz = ((d << 1) ^ (d >> 31)) & 0xffffff; // d >> 31 is arithmetic on ToInt32(d)
    out[i * 3] = zz & 0xff;
    out[i * 3 + 1] = (zz >>> 8) & 0xff;
    out[i * 3 + 2] = (zz >>> 16) & 0xff;
    prevQ = curQ;
  }
  return out;
}

export function dequantizePositionSpzZz(data: Uint8Array, fractionalBits: number, count: number): Float32Array {
  const scale = Math.pow(2, fractionalBits);
  const out = new Float32Array(count);
  let prevQ = 0;
  for (let i = 0; i < count; i++) {
    const zz = (data[i * 3] | (data[i * 3 + 1] << 8) | (data[i * 3 + 2] << 16)) >>> 0;
    const d = (zz >>> 1) ^ -(zz & 1);
    const curQ = mod24(prevQ + d);
    let fixed32 = curQ;
    if (fixed32 & 0x800000) fixed32 -= 0x1000000;
    out[i] = fixed32 / scale; // static_cast<float>(double/double) — auto-narrows on store
    prevQ = curQ;
  }
  return out;
}

// ---------- opacity: quantize_opacity_sigmoid / dequantize_opacity_sigmoid ----------

export function quantizeOpacitySigmoid(data: Float32Array): Uint8Array {
  const n = data.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const sigmoid = 1.0 / (1.0 + Math.exp(-data[i]));
    let val = cRound(sigmoid * 255.0);
    if (val < 0) val = 0;
    if (val > 255) val = 255;
    out[i] = val;
  }
  return out;
}

export function dequantizeOpacitySigmoid(data: Uint8Array): Float32Array {
  const n = data.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let alpha = data[i] / 255.0;
    if (alpha < 1e-6) alpha = 1e-6;
    if (alpha > 1.0 - 1e-6) alpha = 1.0 - 1e-6;
    out[i] = Math.log(alpha / (1.0 - alpha));
  }
  return out;
}

// ---------- rotation: pack/unpack_quaternion_smallest_three_var ----------

export function packQuaternionSmallestThreeVar(
  rot0: Float32Array, rot1: Float32Array, rot2: Float32Array, rot3: Float32Array,
  magBits: number,
): Uint8Array {
  const n = rot0.length;
  const out = new Uint8Array(n * 3);
  const maxMag = (1 << magBits) - 1;
  const q = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    q[0] = rot0[i]; q[1] = rot1[i]; q[2] = rot2[i]; q[3] = rot3[i];
    const norm = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (norm <= 1e-20) {
      q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1;
    } else {
      q[0] /= norm; q[1] /= norm; q[2] /= norm; q[3] /= norm;
    }

    let iLargest = 0;
    let maxAbs = Math.abs(q[0]);
    for (let c = 1; c < 4; c++) {
      const a = Math.abs(q[c]);
      if (a > maxAbs) { maxAbs = a; iLargest = c; }
    }
    if (q[iLargest] < 0.0) { q[0] = -q[0]; q[1] = -q[1]; q[2] = -q[2]; q[3] = -q[3]; }

    let comp = iLargest >>> 0;
    for (let c = 0; c < 4; c++) {
      if (c === iLargest) continue;
      const clampedAbs = Math.min(SQRT1_2, Math.abs(q[c]));
      const negbit = q[c] < 0.0 ? 1 : 0;
      let mag = Math.floor(maxMag * (clampedAbs / SQRT1_2) + 0.5); // floor(x+0.5), NOT round (§3.5)
      if (mag < 0) mag = 0;
      if (mag > maxMag) mag = maxMag;
      comp = ((comp << (magBits + 1)) | (negbit << magBits) | mag) >>> 0;
    }
    out[i * 3] = comp & 0xff;
    out[i * 3 + 1] = (comp >>> 8) & 0xff;
    out[i * 3 + 2] = (comp >>> 16) & 0xff;
  }
  return out;
}

export interface Quaternions {
  rot0: Float32Array; rot1: Float32Array; rot2: Float32Array; rot3: Float32Array;
}

export function unpackQuaternionSmallestThreeVar(data: Uint8Array, count: number, magBits: number): Quaternions {
  const rot0 = new Float32Array(count);
  const rot1 = new Float32Array(count);
  const rot2 = new Float32Array(count);
  const rot3 = new Float32Array(count);
  const rots = [rot0, rot1, rot2, rot3];
  const magMask = (1 << magBits) - 1;
  const maxMag = magMask;
  const q = [0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    let c = (data[i * 3] | (data[i * 3 + 1] << 8) | (data[i * 3 + 2] << 16)) >>> 0;
    const iLargest = c >>> (3 * (magBits + 1));
    let sumSquares = 0;
    q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 0;
    for (let k = 3; k >= 0; k--) {
      if (k === iLargest) continue;
      const mag = c & magMask;
      const negbit = (c >>> magBits) & 1;
      c = c >>> (magBits + 1);
      let val = SQRT1_2 * (mag / maxMag);
      if (negbit) val = -val;
      q[k] = val;
      sumSquares += val * val;
    }
    q[iLargest] = Math.sqrt(Math.max(0, 1 - sumSquares));
    rots[0][i] = q[0]; rots[1][i] = q[1]; rots[2][i] = q[2]; rots[3][i] = q[3];
  }
  return { rot0, rot1, rot2, rot3 };
}

// ---------- scales: quantize_to_u8_levels / dequantize_from_u8_levels ----------

export interface U8Levels { data: Uint8Array; min: number; max: number }

export function quantizeToU8Levels(data: Float32Array, bits: number): U8Levels {
  const n = data.length;
  if (n === 0) return { data: new Uint8Array(0), min: 0, max: 0 };
  let mn = data[0];
  let mx = data[0];
  for (let i = 1; i < n; i++) {
    if (data[i] < mn) mn = data[i];
    if (data[i] > mx) mx = data[i];
  }
  const rangeVal = mx - mn;
  const levels = (1 << bits) - 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let normalized = 0;
    if (rangeVal > 0.0) normalized = (data[i] - mn) / rangeVal;
    let qv = cRound(normalized * levels);
    if (qv < 0) qv = 0;
    if (qv > levels) qv = levels;
    out[i] = qv;
  }
  return { data: out, min: mn, max: mx };
}

export function dequantizeFromU8Levels(data: Uint8Array, bits: number, minVal: number, maxVal: number, count: number): Float32Array {
  const levels = (1 << bits) - 1;
  const rangeVal = maxVal - minVal;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = (data[i] / levels) * rangeVal + minVal;
  return out;
}
