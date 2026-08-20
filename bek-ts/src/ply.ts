// Minimal binary-little-endian PLY reader/writer, float32 only.
// Layout mirrors tinyply as used by ply_writer.cpp: 62 fixed properties in a
// fixed order. See DESIGN.md §3.12.

import * as fs from 'node:fs';

export interface VertexData {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  opacity: Float32Array;
  scale_0: Float32Array;
  scale_1: Float32Array;
  scale_2: Float32Array;
  rot_0: Float32Array;
  rot_1: Float32Array;
  rot_2: Float32Array;
  rot_3: Float32Array;
  f_dc_0: Float32Array;
  f_dc_1: Float32Array;
  f_dc_2: Float32Array;
  f_rest: Float32Array[]; // 45 entries, f_rest_0..44
}

// PLY scalar type -> byte width (used to compute stride for properties we
// don't care about but still must skip over correctly).
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

function readFloat32Column(buf: Buffer, dataStart: number, count: number, stride: number, offset: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = buf.readFloatLE(dataStart + i * stride + offset);
  }
  return out;
}

export function readPly(path: string): VertexData {
  const buf = fs.readFileSync(path);
  const marker = Buffer.from('end_header\n');
  const markerIdx = buf.indexOf(marker);
  if (markerIdx < 0) throw new Error(`${path}: end_header not found`);
  const dataStart = markerIdx + marker.length;
  const headerText = buf.toString('ascii', 0, dataStart);
  const lines = headerText.split('\n').filter((l) => l.length > 0);

  if (lines[0] !== 'ply') throw new Error(`${path}: not a ply file (missing 'ply' magic line)`);
  if (lines[1] !== 'format binary_little_endian 1.0') {
    throw new Error(`${path}: unsupported format (expected binary_little_endian 1.0): ${lines[1]}`);
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
  if (count < 0) throw new Error(`${path}: no 'element vertex' found`);

  // Validate types and compute byte offsets.
  const offsetByName = new Map<string, number>();
  let stride = 0;
  for (const { type, name } of props) {
    const width = TYPE_WIDTH[type];
    if (width === undefined) throw new Error(`${path}: unknown property type '${type}' for '${name}'`);
    if (REQUIRED_FLOAT32_NAMES.has(name) && type !== 'float' && type !== 'float32') {
      throw new Error(`${path}: property '${name}' must be float32, found '${type}'`);
    }
    offsetByName.set(name, stride);
    stride += width;
  }

  const needed = buf.length - dataStart;
  if (needed < count * stride) {
    throw new Error(`${path}: truncated binary payload (need ${count * stride} bytes, have ${needed})`);
  }

  const col = (name: string): Float32Array => {
    const offset = offsetByName.get(name);
    if (offset === undefined) throw new Error(`${path}: missing required property '${name}'`);
    return readFloat32Column(buf, dataStart, count, stride, offset);
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

const WRITE_PROP_NAMES = [
  'x', 'y', 'z', 'nx', 'ny', 'nz',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
  ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
  'opacity', 'scale_0', 'scale_1', 'scale_2',
  'rot_0', 'rot_1', 'rot_2', 'rot_3',
];

export function writePly(path: string, data: VertexData): void {
  const n = data.count;
  let header = 'ply\nformat binary_little_endian 1.0\n';
  header += `element vertex ${n}\n`;
  for (const name of WRITE_PROP_NAMES) header += `property float ${name}\n`;
  header += 'end_header\n';
  const headerBuf = Buffer.from(header, 'ascii');

  const stride = WRITE_PROP_NAMES.length * 4;
  const body = Buffer.allocUnsafe(n * stride);

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
      body.writeFloatLE(col[i], i * stride + colOffset);
    }
  }

  fs.writeFileSync(path, Buffer.concat([headerBuf, body]));
}
