#!/usr/bin/env node
// bek encode <in.ply> <out.bek> [options]
// bek decode <in.bek> <out.ply>

import * as fs from 'node:fs';
import { readPly, writePly } from './ply.ts';
import { buildUncompressed, type EncodeOptions } from './encode.ts';
import { writeBek } from './container.ts';
import { decode } from './decode.ts';

// Flag names/semantics mirror ply_to_bek.cpp:148-182 exactly, so the Python
// sweep harness can invoke this CLI with the same argv it uses for the C++
// binary. Flags that exist in the C++ but are NOT yet ported are rejected with
// an explicit error rather than ignored: silently falling back to the default
// would make a sweep record default results under a non-default label, i.e.
// fabricate data. See README.md for the per-flag status table.
const UNPORTED_FLAGS: Record<string, number> = {
  // flag -> number of values it consumes in the C++ parser
  '--dc-kmeans': 1, '--sh-kmeans': 1, '--sort-mode': 1, '--sort-metric': 1,
  '--sh-whiten': 1, '--save-vq': 1, '--load-vq': 1,
  '--pos-joint': 0, '--rot-split': 0, '--legacy-tail': 0, '--cb-float': 0,
};
function parseEncodeOptions(argv: string[]): Partial<EncodeOptions> {
  const opts: Partial<EncodeOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--dc-stages' && i + 1 < argv.length) opts.dcStages = parseInt(next(), 10);
    else if (arg === '--sh-stages' && i + 1 < argv.length) opts.shStages = parseInt(next(), 10);
    // --sh1-stages sets the joint stage count (back-compat with the banded
    // sweep). --sh2/--sh3-stages are parsed and ignored, matching the C++.
    else if (arg === '--sh1-stages' && i + 1 < argv.length) opts.shStages = parseInt(next(), 10);
    else if (arg === '--sh2-stages' && i + 1 < argv.length) next();
    else if (arg === '--sh3-stages' && i + 1 < argv.length) next();
    else if (arg === '--pos-bits' && i + 1 < argv.length) opts.posFractionalBits = parseInt(next(), 10);
    else if (arg === '--rot-mag-bits' && i + 1 < argv.length) {
      const v = parseInt(next(), 10);
      opts.rotMagBits = Math.min(6, Math.max(2, v));
    }
    else if (arg === '--vq-iters' && i + 1 < argv.length) opts.vqIters = parseInt(next(), 10);
    else if (arg === '--sort-refine' && i + 1 < argv.length) opts.sortRefine = parseInt(next(), 10);
    else if (arg === '--rvq-cb-order') opts.cbChainOrder = true;
    else if (arg === '--no-rvq-cb-order') opts.cbChainOrder = false;
    else if (arg === '--scale-stages' && i + 1 < argv.length) opts.scaleStages = parseInt(next(), 10);
    else if (arg === '--no-positions') opts.noPositions = true;
    else if (arg === '--no-opacity') opts.noOpacity = true;
    else if (arg === '--no-rotation') opts.noRotation = true;
    else if (arg === '--no-scale') opts.noScale = true;
    else if (arg in UNPORTED_FLAGS) {
      throw new Error(
        `bek: ${arg} exists in ply_to_bek but is not ported to this TypeScript codec. ` +
        `Refusing to run: silently ignoring it would record default-pipeline results ` +
        `under a non-default label. See README.md for the flag parity table.`);
    }
    else if (arg.startsWith('--')) {
      throw new Error(`bek: unrecognized flag ${arg}`);
    }
  }
  return opts;
}

function main(argv: string[]): void {
  const [cmd, inPath, outPath, ...rest] = argv;
  if (!cmd || !inPath || !outPath) {
    console.error('Usage: bek encode <in.ply> <out.bek> [options]\n       bek decode <in.bek> <out.ply>');
    process.exitCode = 1;
    return;
  }
  if (cmd === 'encode') {
    const ply = readPly(inPath);
    const opts = parseEncodeOptions(rest);
    const uncompressed = buildUncompressed(ply, opts);
    const bek = writeBek(uncompressed);
    fs.writeFileSync(outPath, bek);
  } else if (cmd === 'decode') {
    const bek = fs.readFileSync(inPath);
    const vd = decode(bek);
    writePly(outPath, vd);
  } else {
    console.error(`Unknown command '${cmd}'. Expected 'encode' or 'decode'.`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
