// Web Worker: does the actual encode/decode off the main thread. Direction
// is sniffed from the file's own bytes, not its extension (a renamed file
// must still work, and a file that's neither gets a clear error) -- 'BEK3'
// at offset 0 means decode, 'ply\n' means encode. Protocol (all messages are
// plain objects over postMessage):
//   in:  { type: 'process', buf: ArrayBuffer, fileName: string, options: Partial<EncodeOptions> }
//   out: { type: 'progress', ...ProgressEvent }
//   out: { type: 'done', direction: 'encode' | 'decode', file: ArrayBuffer, stats: {...} }
//   out: { type: 'error', message: string }
import { readPlyFromArrayBuffer, writePlyToArrayBuffer } from './ply-browser.ts';
import { buildUncompressed, DEFAULT_ENCODE_OPTIONS, type EncodeOptions } from '../vendor/bek-ts/src/encode.ts';
import { writeBek } from '../vendor/bek-ts/src/container.ts';
import { decode } from '../vendor/bek-ts/src/decode.ts';
import { initWebp } from './webp-wasm.ts';
import { initZstd } from './zstd-wasm.ts';
import { planRvqStages } from './rvq-progress.ts';
import { setProgressSink, report, type ProgressEvent } from './progress.ts';

setProgressSink((e: ProgressEvent) => postMessage({ type: 'progress', ...e }));

function sniffDirection(buf: ArrayBuffer): 'encode' | 'decode' {
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const text = new TextDecoder('ascii').decode(head);
  if (text === 'BEK3') return 'decode';
  if (text.startsWith('ply')) return 'encode'; // 'ply\n' magic line, see ply-browser.ts
  throw new Error(`Unrecognized file: not a .ply (missing 'ply' magic) or a .bek (missing 'BEK3' magic). Got first bytes: ${JSON.stringify(text)}`);
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as { type: string; buf: ArrayBuffer; fileName: string; options: Partial<EncodeOptions> };
  if (msg.type !== 'process') return;
  try {
    await initWebp();
    await initZstd();

    const direction = sniffDirection(msg.buf);
    const t0 = performance.now();

    if (direction === 'encode') {
      const opts: EncodeOptions = { ...DEFAULT_ENCODE_OPTIONS, ...msg.options };
      const rvqStages = opts.dcStages + opts.shStages + (opts.scaleStages > 0 ? opts.scaleStages : 0);
      planRvqStages(rvqStages);

      report({ phase: 'read', status: 'start' });
      const ply = readPlyFromArrayBuffer(msg.buf);
      report({ phase: 'read', status: 'done' });

      const uncompressed = buildUncompressed(ply, opts);
      report({ phase: 'encode-channels', status: 'done' }); // channel best-of + cbor assembly happened inside buildUncompressed

      report({ phase: 'container', status: 'start' });
      const bek = writeBek(uncompressed);
      report({ phase: 'container', status: 'done' });
      const elapsedMs = performance.now() - t0;

      const bekBytes = bek.slice().buffer; // own, right-sized ArrayBuffer, transferable
      postMessage({
        type: 'done',
        direction,
        file: bekBytes,
        stats: { splatCount: ply.count, inputBytes: msg.buf.byteLength, outputBytes: bek.length, elapsedMs },
      }, [bekBytes]);
    } else {
      report({ phase: 'decode', status: 'start' });
      const vd = decode(Buffer.from(msg.buf));
      report({ phase: 'decode', status: 'done' });

      report({ phase: 'write', status: 'start' });
      const ply = writePlyToArrayBuffer(vd);
      report({ phase: 'write', status: 'done' });
      const elapsedMs = performance.now() - t0;

      const plyBytes = ply.buffer.slice(ply.byteOffset, ply.byteOffset + ply.byteLength) as ArrayBuffer;
      postMessage({
        type: 'done',
        direction,
        file: plyBytes,
        stats: { splatCount: vd.count, inputBytes: msg.buf.byteLength, outputBytes: plyBytes.byteLength, elapsedMs },
      }, [plyBytes]);
    }
  } catch (err) {
    postMessage({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
