// Shim for bek-ts/src/container.ts's `import ... from 'node:zlib'`, swapped
// in by the esbuild alias plugin (esbuild.config.mjs). Writes a zstd frame
// made of nothing but Raw_Block (block type 0) blocks -- no compression
// library needed, no wasm. The payload is already entropy-coded (range
// coder / WebP), so real zstd only bought ~0.3% on room.ply; not worth
// ~600KB of wasm for that.
//
// Frame format: RFC 8878 §3.1.1. Magic_Number (4B LE) + Frame_Header_Descriptor
// (1B: Single_Segment_flag set, Frame_Content_Size_flag=3 -> 8B FCS field,
// Content_Checksum_flag=0) + Frame_Content_Size (8B LE) + Data_Block(s).
// Each Raw_Block: 3-byte LE header (bit0 Last_Block, bits1-2 Block_Type=00,
// bits3-23 Block_Size) + the raw bytes, chunked to <=128KiB per block.
//
// Verified against the real decoder: ZSTD_decompress (C++ reference,
// build/bek_to_ply) decompresses this frame without error -- see
// scripts/verify-node.mjs.

const MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_BLOCK = 128 * 1024;

export function zstdCompressSync(data: Uint8Array): Uint8Array {
  const n = data.length;
  const nBlocks = Math.max(1, Math.ceil(n / MAX_BLOCK));
  const headerSize = 4 + 1 + 8;
  const framedSize = headerSize + nBlocks * 3 + n;
  const out = new Uint8Array(framedSize);
  const dv = new DataView(out.buffer);

  out.set(MAGIC, 0);
  out[4] = 0xe0; // Single_Segment_flag(bit5) | Frame_Content_Size_flag=3(bits6-7)
  dv.setBigUint64(5, BigInt(n), true);

  let srcOff = 0;
  let dstOff = headerSize;
  for (let i = 0; i < nBlocks; i++) {
    const remaining = n - srcOff;
    const size = Math.min(MAX_BLOCK, remaining);
    const isLast = i === nBlocks - 1;
    const blockHeader = (isLast ? 1 : 0) | (0 << 1) | (size << 3);
    out[dstOff] = blockHeader & 0xff;
    out[dstOff + 1] = (blockHeader >>> 8) & 0xff;
    out[dstOff + 2] = (blockHeader >>> 16) & 0xff;
    dstOff += 3;
    out.set(data.subarray(srcOff, srcOff + size), dstOff);
    dstOff += size;
    srcOff += size;
  }
  return out;
}

export function zstdDecompressSync(): never {
  throw new Error('zstd-raw shim: decompress not implemented (browser encoder never decodes)');
}

export const constants = {
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_enableLongDistanceMatching: 101,
  ZSTD_c_windowLog: 102,
  ZSTD_d_windowLogMax: 100,
};
