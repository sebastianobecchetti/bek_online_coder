// Shell-out to Homebrew's cwebp/dwebp (see DESIGN.md §4.2). This is the same
// libwebp linked by the C++ reference binary, so lossless encoding is
// bit-identical by construction -- verified for real: `-lossless -m 4 -q 100
// -exact` reproduces all three vq_sh_ac_s* blobs of ref_tiny.bek byte-for-byte
// (refbuild/probe_webp.ts). Do not change the flags without rerunning that
// probe. Requires `brew install webp` (README.md).

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpFile(ext: string): string {
  return join(tmpdir(), `bekts_webp_${process.pid}_${Math.random().toString(36).slice(2)}.${ext}`);
}

// `data` must already be padded to exactly W*H*ch bytes (ply_to_bek.cpp:591:
// `padded.resize(W*H*ch, 0)`). ch===1 planes are replicated onto R/G/B
// (ply_to_bek.cpp:597-601), matching WebPPictureImportRGB semantics exactly.
export function webpEncode(data: Uint8Array, W: number, H: number, ch: 1 | 3): Buffer {
  let rgb: Uint8Array;
  if (ch === 1) {
    rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const v = data[i];
      rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v;
    }
  } else {
    rgb = data;
  }
  const header = Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii');
  const ppm = Buffer.concat([header, Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength)]);

  const ppmPath = tmpFile('ppm');
  const webpPath = tmpFile('webp');
  try {
    writeFileSync(ppmPath, ppm);
    execFileSync('cwebp', ['-lossless', '-m', '4', '-q', '100', '-exact', '-quiet', '-o', webpPath, '--', ppmPath]);
    return readFileSync(webpPath);
  } finally {
    try { unlinkSync(ppmPath); } catch { /* best-effort cleanup */ }
    try { unlinkSync(webpPath); } catch { /* best-effort cleanup */ }
  }
}

// Returns exactly n*ch bytes: the unpadded plane, discarding the W*H*ch -
// n*ch zero padding and (ch===1) taking just the R byte of each pixel
// (bek_to_ply.cpp:127-142).
export function webpDecode(blob: Uint8Array, n: number, W: number, H: number, ch: 1 | 3): Uint8Array {
  const webpPath = tmpFile('webp');
  const ppmPath = tmpFile('ppm');
  try {
    writeFileSync(webpPath, blob);
    execFileSync('dwebp', [webpPath, '-ppm', '-o', ppmPath, '-quiet']);
    const ppm = readFileSync(ppmPath);
    let i = 0;
    const isWs = (b: number) => b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0d;
    function token(): string {
      while (isWs(ppm[i])) i++;
      const s = i;
      while (i < ppm.length && !isWs(ppm[i])) i++;
      return ppm.subarray(s, i).toString('ascii');
    }
    const magic = token();
    if (magic !== 'P6') throw new Error(`webpDecode: unexpected PPM magic '${magic}'`);
    const w = parseInt(token(), 10);
    const h = parseInt(token(), 10);
    token(); // maxval (255)
    i++; // single whitespace byte separating header from binary pixel data
    const pixels = ppm.subarray(i);
    if (w !== W || h !== H) {
      throw new Error(`webpDecode: dimension mismatch ${w}x${h} vs expected ${W}x${H}`);
    }
    const out = new Uint8Array(n);
    if (ch === 1) {
      for (let k = 0; k < n; k++) out[k] = pixels[k * 3];
    } else {
      out.set(pixels.subarray(0, n * 3));
    }
    return out;
  } finally {
    try { unlinkSync(webpPath); } catch { /* best-effort cleanup */ }
    try { unlinkSync(ppmPath); } catch { /* best-effort cleanup */ }
  }
}
