// BEK3 container: magic + uint64 LE uncompressed_size + zstd frame.
// See DESIGN.md §1.3 (layout) and §3.11 (zstd params + why L3 is out of
// scope: the C++ encoder uses ZSTD_c_nbWorkers = hardware_concurrency(),
// which is documented in ply_to_bek.cpp as non-reproducible across machines).

import { zstdCompressSync, zstdDecompressSync, constants as ZC } from 'node:zlib';

const MAGIC = 'BEK3';

export function writeBek(uncompressed: Buffer): Buffer {
  const compressed = zstdCompressSync(uncompressed, {
    params: {
      [ZC.ZSTD_c_compressionLevel]: 22,
      [ZC.ZSTD_c_enableLongDistanceMatching]: 1,
      [ZC.ZSTD_c_windowLog]: 27,
      // Never set ZSTD_c_nbWorkers: single-thread output is deterministic
      // and reproducible; nbWorkers is the source of the C++ encoder's
      // machine-dependent output (DESIGN.md §2).
    },
  });

  const header = Buffer.alloc(12);
  header.write(MAGIC, 0, 'ascii');
  header.writeBigUInt64LE(BigInt(uncompressed.length), 4);
  return Buffer.concat([header, compressed]);
}

export function readBek(bek: Buffer): Buffer {
  if (bek.toString('ascii', 0, 4) !== MAGIC) {
    throw new Error(`readBek: bad magic (expected 'BEK3')`);
  }
  const uncompressedSizeBig = bek.readBigUInt64LE(4);
  if (uncompressedSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('readBek: uncompressed_size exceeds Number.MAX_SAFE_INTEGER');
  }
  const uncompressedSize = Number(uncompressedSizeBig);
  return zstdDecompressSync(bek.subarray(12), {
    params: { [ZC.ZSTD_d_windowLogMax]: 31 },
    maxOutputLength: uncompressedSize,
  });
}
