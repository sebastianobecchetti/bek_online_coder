// Web Worker: does the actual encode off the main thread. Protocol (all
// messages are plain objects over postMessage):
//   in:  { type: 'encode', buf: ArrayBuffer, fileName: string, options: Partial<EncodeOptions> }
//   out: { type: 'progress', ...ProgressEvent }
//   out: { type: 'done', bek: ArrayBuffer, stats: {...} }
//   out: { type: 'error', message: string }
import { readPlyFromArrayBuffer } from './ply-browser.ts';
import { buildUncompressed, DEFAULT_ENCODE_OPTIONS, type EncodeOptions } from '../vendor/bek-ts/src/encode.ts';
import { writeBek } from '../vendor/bek-ts/src/container.ts';
import { initWebp } from './webp-wasm.ts';
import { planRvqStages } from './rvq-progress.ts';
import { setProgressSink, report, type ProgressEvent } from './progress.ts';

setProgressSink((e: ProgressEvent) => postMessage({ type: 'progress', ...e }));

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as { type: string; buf: ArrayBuffer; fileName: string; options: Partial<EncodeOptions> };
  if (msg.type !== 'encode') return;
  try {
    await initWebp();

    const opts: EncodeOptions = { ...DEFAULT_ENCODE_OPTIONS, ...msg.options };
    const rvqStages = opts.dcStages + opts.shStages + (opts.scaleStages > 0 ? opts.scaleStages : 0);
    planRvqStages(rvqStages);

    report({ phase: 'read', status: 'start' });
    const ply = readPlyFromArrayBuffer(msg.buf);
    report({ phase: 'read', status: 'done' });

    const t0 = performance.now();
    const uncompressed = buildUncompressed(ply, opts);
    report({ phase: 'encode-channels', status: 'done' }); // channel best-of + cbor assembly happened inside buildUncompressed

    report({ phase: 'container', status: 'start' });
    const bek = writeBek(uncompressed);
    report({ phase: 'container', status: 'done' });
    const elapsedMs = performance.now() - t0;

    const bekBytes = bek.slice().buffer; // own, right-sized ArrayBuffer, transferable
    postMessage({
      type: 'done',
      bek: bekBytes,
      stats: {
        splatCount: ply.count,
        originalBytes: msg.buf.byteLength,
        bekBytes: bek.length,
        elapsedMs,
      },
    }, [bekBytes]);
  } catch (err) {
    postMessage({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
