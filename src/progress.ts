// Shared progress-event sink. worker.ts sets the sink to `postMessage`;
// order-progress.ts and rvq-progress.ts (the esbuild-aliased codec modules)
// call `report()` at the real phase boundaries they wrap. See
// esbuild.config.mjs for how './order.ts' / './rvq.ts' get redirected here.

export type ProgressEvent =
  | { phase: 'read' | 'container'; status: 'start' | 'done' }
  | { phase: 'sort'; status: 'start' | 'done' }
  | { phase: 'rvq'; status: 'start' | 'done'; stageIndex: number; totalStages: number; maxIters: number }
  | { phase: 'encode-channels'; status: 'start' | 'done' };

let sink: ((e: ProgressEvent) => void) | null = null;

export function setProgressSink(fn: (e: ProgressEvent) => void): void {
  sink = fn;
}

export function report(e: ProgressEvent): void {
  sink?.(e);
}
