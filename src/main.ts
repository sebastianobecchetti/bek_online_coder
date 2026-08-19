// Page wiring: file input/drag-drop, advanced options, worker lifecycle,
// progress-bar animation, results + download, theme toggle. No framework.

const dropzone = document.getElementById('dropzone')!;
const dropzoneLabel = document.getElementById('dropzone-label')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const progressWrap = document.getElementById('progress-wrap')!;
const progressFill = document.getElementById('progress-fill') as HTMLElement;
const progressLabel = document.getElementById('progress-label')!;
const resultsBox = document.getElementById('results')!;
const statsList = document.getElementById('stats')!;
const downloadLink = document.getElementById('download-link') as HTMLAnchorElement;
const errorBox = document.getElementById('error-box')!;

// ---------- theme toggle ----------
const themeToggle = document.getElementById('theme-toggle')!;
function applyStoredTheme(): void {
  const stored = localStorage.getItem('bek-theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);
}
applyStoredTheme();
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme')
    ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('bek-theme', next);
});

// ---------- file selection ----------
let selectedFile: File | null = null;

function pickFile(f: File): void {
  selectedFile = f;
  dropzoneLabel.textContent = `${f.name} (${formatBytes(f.size)}) — click to encode`;
  startEncode();
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) pickFile(fileInput.files[0]);
});
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const f = e.dataTransfer?.files?.[0];
  if (f) pickFile(f);
});

// ---------- advanced options ----------
function num(id: string): number {
  return parseInt((document.getElementById(id) as HTMLInputElement).value, 10);
}
function readOptions() {
  return {
    dcStages: num('opt-dc-stages'),
    shStages: num('opt-sh-stages'),
    posFractionalBits: num('opt-pos-bits'),
    vqIters: num('opt-vq-iters'),
    sortRefine: num('opt-sort-refine'),
    rotMagBits: num('opt-rot-mag-bits'),
  };
}

// ---------- progress model ----------
// Weights are a rough, honestly-labelled split of wall time between phases,
// not measured per file: RVQ (k-means training) dominates in practice (the
// task's own measurement: ~95% of encode time), so it gets the vast
// majority of the bar. Within an RVQ stage we don't get iteration-level
// callbacks (vendor/bek-ts's trainVq is a single blocking call -- see
// src/rvq-progress.ts for why), so we ease the fill smoothly toward the
// stage's target and snap to it when the real 'done' event for that stage
// arrives, rather than claim false per-iteration precision.
const PHASE_WEIGHT = { read: 0.02, sort: 0.03, rvq: 0.85, 'encode-channels': 0.08, container: 0.02 };
let phaseBase = 0; // cumulative fraction completed before the current phase
let rvqStageBase = 0; // fraction at the start of the current RVQ stage
let rvqStageSpan = 0; // fraction span of one RVQ stage
let animHandle = 0;

function setFill(frac: number, label: string): void {
  progressFill.style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`;
  progressLabel.textContent = label;
}

function animateWithinStage(base: number, span: number, label: string): void {
  cancelAnimationFrame(animHandle);
  const start = performance.now();
  const asymptote = base + span * 0.92; // never visually reach the end before 'done' arrives
  const tick = () => {
    const elapsed = (performance.now() - start) / 1000;
    const eased = base + (asymptote - base) * (1 - Math.exp(-elapsed / 8));
    setFill(eased, label);
    animHandle = requestAnimationFrame(tick);
  };
  animHandle = requestAnimationFrame(tick);
}

function handleProgress(e: any): void {
  switch (e.phase) {
    case 'read':
      if (e.status === 'start') setFill(phaseBase, 'Reading PLY…');
      else phaseBase = PHASE_WEIGHT.read;
      break;
    case 'sort':
      if (e.status === 'start') animateWithinStage(phaseBase, PHASE_WEIGHT.sort, 'Sorting splats (Morton order)…');
      else { cancelAnimationFrame(animHandle); phaseBase += PHASE_WEIGHT.sort; setFill(phaseBase, 'Sorted.'); }
      break;
    case 'rvq':
      if (e.status === 'start' && e.stageIndex === 0) rvqStageBase = phaseBase;
      rvqStageSpan = PHASE_WEIGHT.rvq / e.totalStages;
      if (e.status === 'start') {
        const label = `Training RVQ codebook — stage ${e.stageIndex + 1}/${e.totalStages} (${e.maxIters} k-means iterations)…`;
        animateWithinStage(rvqStageBase, rvqStageSpan, label);
      } else {
        cancelAnimationFrame(animHandle);
        rvqStageBase += rvqStageSpan;
        setFill(rvqStageBase, `RVQ stage ${e.stageIndex}/${e.totalStages} done.`);
        if (e.stageIndex === e.totalStages) phaseBase = rvqStageBase;
      }
      break;
    case 'encode-channels':
      // Single 'done' event: channel best-of codec selection + CBOR header
      // assembly happen inside the same call as RVQ, so we can only mark it
      // finished here, not bracket a start.
      phaseBase += PHASE_WEIGHT['encode-channels'];
      setFill(phaseBase, 'Encoded channels, picking best codec per channel…');
      break;
    case 'container':
      if (e.status === 'start') animateWithinStage(phaseBase, PHASE_WEIGHT.container, 'Writing .bek container…');
      else { cancelAnimationFrame(animHandle); setFill(1, 'Done.'); }
      break;
  }
}

// ---------- encode ----------
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

function startEncode(): void {
  if (!selectedFile) return;
  resultsBox.hidden = true;
  errorBox.hidden = true;
  progressWrap.hidden = false;
  phaseBase = 0; rvqStageBase = 0; rvqStageSpan = 0;
  setFill(0, 'Reading file…');

  const worker = new Worker('worker.js', { type: 'module' });
  const fileName = selectedFile.name;

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'progress') { handleProgress(msg); return; }
    if (msg.type === 'error') {
      progressWrap.hidden = true;
      errorBox.hidden = false;
      errorBox.textContent = `Encoding failed: ${msg.message}`;
      worker.terminate();
      return;
    }
    if (msg.type === 'done') {
      progressWrap.hidden = true;
      resultsBox.hidden = false;
      const { splatCount, originalBytes, bekBytes, elapsedMs } = msg.stats;
      const ratio = originalBytes / bekBytes;
      const bitsPerGaussian = (bekBytes * 8) / splatCount;
      statsList.innerHTML = '';
      const rows: [string, string][] = [
        ['Splats', splatCount.toLocaleString()],
        ['Original size', formatBytes(originalBytes)],
        ['.bek size', formatBytes(bekBytes)],
        ['Compression ratio', `${ratio.toFixed(2)}×`],
        ['Bits per gaussian', bitsPerGaussian.toFixed(2)],
        ['Time', `${(elapsedMs / 1000).toFixed(1)} s`],
      ];
      for (const [k, v] of rows) {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd'); dd.textContent = v;
        statsList.append(dt, dd);
      }
      const blob = new Blob([msg.bek], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      downloadLink.href = url;
      downloadLink.download = fileName.replace(/\.ply$/i, '') + '.bek';
      worker.terminate();
    }
  };

  worker.onerror = (e) => {
    progressWrap.hidden = true;
    errorBox.hidden = false;
    errorBox.textContent = `Worker error: ${e.message}`;
  };

  selectedFile.arrayBuffer().then((buf) => {
    worker.postMessage({ type: 'encode', buf, fileName, options: readOptions() }, [buf]);
  });
}
