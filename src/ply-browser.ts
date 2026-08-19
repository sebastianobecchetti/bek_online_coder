// Browser PLY reader: same binary-little-endian, float32-only layout and
// validation as vendor/bek-ts/src/ply.ts's readPly (mirrors ply_writer.cpp),
// but reading from an in-memory ArrayBuffer (File API) instead of
// node:fs.readFileSync -- node:fs does not exist in a browser/worker.
// Not aliased in via esbuild because bek-ts's ply.ts is fs-only and pulls in
// no other logic worth reusing here; this is a straight, deliberate
// reimplementation of the same ~40 lines of header parsing.

export interface VertexData {
  count: number;
  x: Float32Array; y: Float32Array; z: Float32Array;
  opacity: Float32Array;
  scale_0: Float32Array; scale_1: Float32Array; scale_2: Float32Array;
  rot_0: Float32Array; rot_1: Float32Array; rot_2: Float32Array; rot_3: Float32Array;
  f_dc_0: Float32Array; f_dc_1: Float32Array; f_dc_2: Float32Array;
  f_rest: Float32Array[];
}

const TYPE_WIDTH: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4,
  double: 8, float64: 8,
};

const REQUIRED_FLOAT32_NAMES = new Set([
  'x', 'y', 'z', 'opacity',
  'scale_0', 'scale_1', 'scale_2',
  'rot_0', 'rot_1', 'rot_2', 'rot_3',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
  ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
]);

function findHeaderEnd(bytes: Uint8Array): number {
  const marker = new TextEncoder().encode('end_header\n');
  outer: for (let i = 0; i <= bytes.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    return i + marker.length;
  }
  throw new Error('ply: end_header not found');
}

export function readPlyFromArrayBuffer(buf: ArrayBuffer): VertexData {
  const bytes = new Uint8Array(buf);
  const dataStart = findHeaderEnd(bytes);
  const headerText = new TextDecoder('ascii').decode(bytes.subarray(0, dataStart));
  const lines = headerText.split('\n').filter((l) => l.length > 0);

  if (lines[0] !== 'ply') throw new Error(`ply: not a ply file (missing 'ply' magic line)`);
  if (lines[1] !== 'format binary_little_endian 1.0') {
    throw new Error(`ply: unsupported format (expected binary_little_endian 1.0): ${lines[1]}`);
  }

  let count = -1;
  const props: Array<{ type: string; name: string }> = [];
  let inVertexElement = false;
  for (let i = 2; i < lines.length; i++) {
    const l = lines[i];
    if (l === 'end_header') break;
    if (l.startsWith('element ')) {
      const parts = l.split(' ');
      inVertexElement = parts[1] === 'vertex';
      if (inVertexElement) count = parseInt(parts[2], 10);
      continue;
    }
    if (l.startsWith('property ') && inVertexElement) {
      const parts = l.split(' ');
      props.push({ type: parts[1], name: parts[2] });
    }
  }
  if (count < 0) throw new Error(`ply: no 'element vertex' found`);

  const offsetByName = new Map<string, number>();
  let stride = 0;
  for (const { type, name } of props) {
    const width = TYPE_WIDTH[type];
    if (width === undefined) throw new Error(`ply: unknown property type '${type}' for '${name}'`);
    if (REQUIRED_FLOAT32_NAMES.has(name) && type !== 'float' && type !== 'float32') {
      throw new Error(`ply: property '${name}' must be float32, found '${type}'`);
    }
    offsetByName.set(name, stride);
    stride += width;
  }

  const needed = bytes.length - dataStart;
  if (needed < count * stride) {
    throw new Error(`ply: truncated binary payload (need ${count * stride} bytes, have ${needed})`);
  }

  const dv = new DataView(buf, bytes.byteOffset, bytes.byteLength);
  const col = (name: string): Float32Array => {
    const offset = offsetByName.get(name);
    if (offset === undefined) throw new Error(`ply: missing required property '${name}'`);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = dv.getFloat32(dataStart + i * stride + offset, true);
    return out;
  };

  const f_rest: Float32Array[] = [];
  for (let i = 0; i < 45; i++) f_rest.push(col(`f_rest_${i}`));

  return {
    count,
    x: col('x'), y: col('y'), z: col('z'),
    opacity: col('opacity'),
    scale_0: col('scale_0'), scale_1: col('scale_1'), scale_2: col('scale_2'),
    rot_0: col('rot_0'), rot_1: col('rot_1'), rot_2: col('rot_2'), rot_3: col('rot_3'),
    f_dc_0: col('f_dc_0'), f_dc_1: col('f_dc_1'), f_dc_2: col('f_dc_2'),
    f_rest,
  };
}

// Browser PLY writer: same binary-little-endian, float32-only, fixed
// 62-property layout as vendor/bek-ts/src/ply.ts's writePly (mirrors
// ply_writer.cpp), but returning a Uint8Array instead of writing to
// node:fs. Used by the decode direction (a loaded .bek -> downloadable
// .ply). Property order and header text must stay byte-identical to
// ply.ts's WRITE_PROP_NAMES -- that's the whole point of Anello 4 in
// scripts/verify-node-entry.ts (bek_to_ply must decode what this project's
// .bek produces AND this project's decode of a C++ .bek must match
// bek_to_ply's own PLY output byte-for-byte).
const WRITE_PROP_NAMES = [
  'x', 'y', 'z', 'nx', 'ny', 'nz',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
  ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
  'opacity', 'scale_0', 'scale_1', 'scale_2',
  'rot_0', 'rot_1', 'rot_2', 'rot_3',
];

export function writePlyToArrayBuffer(data: VertexData): Uint8Array {
  const n = data.count;
  let header = 'ply\nformat binary_little_endian 1.0\n';
  header += `element vertex ${n}\n`;
  for (const name of WRITE_PROP_NAMES) header += `property float ${name}\n`;
  header += 'end_header\n';
  const headerBytes = new TextEncoder().encode(header);

  const stride = WRITE_PROP_NAMES.length * 4;
  const out = new Uint8Array(headerBytes.length + n * stride);
  out.set(headerBytes, 0);
  const dv = new DataView(out.buffer, headerBytes.length);

  const columns: Float32Array[] = [
    data.x, data.y, data.z,
    new Float32Array(n), new Float32Array(n), new Float32Array(n), // nx,ny,nz = 0
    data.f_dc_0, data.f_dc_1, data.f_dc_2,
    ...data.f_rest,
    data.opacity,
    data.scale_0, data.scale_1, data.scale_2,
    data.rot_0, data.rot_1, data.rot_2, data.rot_3,
  ];

  for (let p = 0; p < columns.length; p++) {
    const col = columns[p];
    const colOffset = p * 4;
    for (let i = 0; i < n; i++) {
      dv.setFloat32(i * stride + colOffset, col[i], true);
    }
  }

  return out;
}
