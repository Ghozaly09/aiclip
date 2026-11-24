import {
  CanvasSpec,
  Clip,
  ClipSettings,
  RenderedClipRecord,
  SubtitleLine,
  SubtitleWord,
  VideoInfo,
  WhisperConfig
} from '../types.ts';
import {
  DEFAULT_CAPTION_LEAD_SEC,
  getActiveCaptionChunk,
  getSavedCaptionLeadSec,
  groupWordsIntoChunks,
  splitDisplayWordsIntoRows
} from './subtitleParser.ts';
import { saveRenderedClip } from './renderedClipDb.ts';

export interface DrawFrameParams {
  video: HTMLVideoElement;
  mediaTime: number;
  clip: Clip;
  style: {
    title: ClipSettings['title'];
    caption: ClipSettings['caption'];
  };
  canvasSpec: CanvasSpec;
  syncOffset?: number;
  captionLeadSec?: number;
  drawOverlays?: boolean;
}

export interface DrawFrameOptions {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
  mediaTime: number;
  clip: Clip;
  settings: ClipSettings;
  syncOffset?: number;
  captionLeadSec?: number;
}

// Offscreen low-res canvas for fast, Safari/Android-compatible blur background (zero ctx.filter dependency)
let blurBufferCanvas: HTMLCanvasElement | null = null;
let blurBufferCtx: CanvasRenderingContext2D | null = null;

function getBlurBuffer(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const targetW = Math.max(16, Math.round(w / 16));
  const targetH = Math.max(16, Math.round(h / 16));
  if (!blurBufferCanvas) {
    blurBufferCanvas = document.createElement('canvas');
    blurBufferCtx = blurBufferCanvas.getContext('2d');
  }
  if (blurBufferCanvas.width !== targetW || blurBufferCanvas.height !== targetH) {
    blurBufferCanvas.width = targetW;
    blurBufferCanvas.height = targetH;
  }
  return { canvas: blurBufferCanvas, ctx: blurBufferCtx! };
}

export function getCanvasDimensions(aspectRatio: string, resolution: '720p' | '1080p'): { width: number; height: number } {
  const is1080 = resolution === '1080p';
  switch (aspectRatio) {
    case '9:16':
      return is1080 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
    case '1:1':
      return is1080 ? { width: 1080, height: 1080 } : { width: 720, height: 720 };
    case '4:5':
      return is1080 ? { width: 1080, height: 1350 } : { width: 720, height: 900 };
    case '16:9':
      return is1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
    default:
      return is1080 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  }
}

export async function ensureRenderFontsLoaded(fontFamily: string): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    const primary = fontFamily === 'Anton' ? 'Anton' : fontFamily === 'Poppins' ? 'Poppins' : 'Montserrat';
    await Promise.allSettled([
      document.fonts.load(`800 48px "Montserrat"`),
      document.fonts.load(`900 58px "${primary}"`),
      document.fonts.ready
    ]);
  } catch {
    // non-fatal if browser blocks font API
  }
}

// Unified frame renderer referenced from 1080px base width
export function drawFrame(ctx: CanvasRenderingContext2D, params: DrawFrameParams): void {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const { video, mediaTime, clip, style, canvasSpec, syncOffset = 0, captionLeadSec = DEFAULT_CAPTION_LEAD_SEC, drawOverlays = true } = params;
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  const scale = cw / 1080;

  ctx.clearRect(0, 0, cw, ch);

  if (canvasSpec.fitMode === 'contain') {
    if (canvasSpec.backgroundMode === 'blur') {
      // Draw downscaled 1/16 frame then scale up with imageSmoothingEnabled = true (works on Safari & Android Chrome)
      const { canvas: tinyCanvas, ctx: tinyCtx } = getBlurBuffer(cw, ch);
      const bgScale = Math.max(tinyCanvas.width / vw, tinyCanvas.height / vh) * 1.15;
      const bw = vw * bgScale;
      const bh = vh * bgScale;
      tinyCtx.save();
      tinyCtx.imageSmoothingEnabled = true;
      tinyCtx.imageSmoothingQuality = 'low';
      tinyCtx.clearRect(0, 0, tinyCanvas.width, tinyCanvas.height);
      tinyCtx.drawImage(video, (tinyCanvas.width - bw) / 2, (tinyCanvas.height - bh) / 2, bw, bh);
      tinyCtx.restore();

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tinyCanvas, 0, 0, cw, ch);
      ctx.fillStyle = 'rgba(7, 10, 18, 0.42)';
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
    } else {
      ctx.fillStyle = canvasSpec.backgroundColor || '#0a0a0c';
      ctx.fillRect(0, 0, cw, ch);
    }

    const fitScale = Math.min(cw / vw, ch / vh);
    const dw = vw * fitScale;
    const dh = vh * fitScale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    ctx.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh);
  } else {
    const targetRatio = cw / ch;
    const sourceRatio = vw / vh;
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;

    if (sourceRatio > targetRatio) {
      sw = vh * targetRatio;
      const maxShift = vw - sw;
      const pan = Math.min(100, Math.max(0, canvasSpec.horizontalPanPercent ?? 50)) / 100;
      sx = maxShift * pan;
    } else {
      sh = vw / targetRatio;
      sy = (vh - sh) / 2;
    }

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
  }

  if (!drawOverlays) return;

  const subtitleLookupTime = mediaTime - syncOffset;
  const relativeTime = subtitleLookupTime - clip.startTime;
  if (
    style.title.enabled &&
    style.title.text.trim() &&
    (style.title.durationMode === 'full_clip' || relativeTime <= (style.title.displaySeconds || 3))
  ) {
    drawTitleOverlay(ctx, cw, ch, scale, style.title);
  }

  drawCaptionOverlay(ctx, cw, ch, scale, subtitleLookupTime, clip, style.caption, captionLeadSec);
}

export function drawCanvasFrame(options: DrawFrameOptions, drawOverlays = true): void {
  drawFrame(options.ctx, {
    video: options.video,
    mediaTime: options.mediaTime,
    clip: options.clip,
    style: {
      title: options.settings.title,
      caption: options.settings.caption
    },
    canvasSpec: options.settings.canvas,
    syncOffset: options.syncOffset,
    captionLeadSec: options.captionLeadSec,
    drawOverlays
  });
}

function drawTitleOverlay(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  scale: number,
  titleStyle: ClipSettings['title']
) {
  ctx.save();
  const fontSize = Math.round((titleStyle.size || 52) * scale);
  ctx.font = `800 ${fontSize}px "Montserrat", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const titleY = titleStyle.position === 'top' ? ch * 0.14 : ch * 0.45;
  const maxWidth = cw * 0.88;

  const words = titleStyle.text.trim().split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const w of words) {
    const testLine = currentLine ? `${currentLine} ${w}` : w;
    if (ctx.measureText(testLine).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = w;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  const lineHeight = fontSize * 1.25;
  const totalBoxHeight = lines.length * lineHeight + 24 * scale;

  if (titleStyle.backgroundBox) {
    const maxLineWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
    const boxWidth = Math.min(cw * 0.92, maxLineWidth + 48 * scale);
    ctx.fillStyle = titleStyle.boxColor || 'rgba(0, 0, 0, 0.85)';
    const boxX = (cw - boxWidth) / 2;
    const boxY = titleY - totalBoxHeight / 2;
    roundRect(ctx, boxX, boxY, boxWidth, totalBoxHeight, 16 * scale);
    ctx.fill();
  }

  const startY = titleY - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, idx) => {
    const y = startY + idx * lineHeight;
    if (titleStyle.strokeColor && titleStyle.strokeColor !== 'transparent') {
      ctx.strokeStyle = titleStyle.strokeColor;
      ctx.lineWidth = Math.max(2, 6 * scale);
      ctx.strokeText(line, cw / 2, y);
    }
    ctx.fillStyle = titleStyle.textColor || '#FFFFFF';
    ctx.fillText(line, cw / 2, y);
  });

  ctx.restore();
}

interface MeasuredWordToken {
  text: string;
  width: number;
  isActive: boolean;
  progress: number;
  raw: SubtitleWord;
}

function wrapCaptionTokensByWidth(
  tokens: MeasuredWordToken[],
  suggestedRows: SubtitleWord[][],
  spaceWidth: number,
  maxRowWidth: number
): MeasuredWordToken[][] {
  // First check if suggested balanced rows already fit within 90% maxRowWidth
  const tokenByRef = new Map<SubtitleWord, MeasuredWordToken>();
  tokens.forEach(t => tokenByRef.set(t.raw, t));

  const mappedSuggested = suggestedRows
    .map(r => r.map(w => tokenByRef.get(w)!).filter(Boolean))
    .filter(r => r.length > 0);

  const allFit =
    mappedSuggested.length > 0 &&
    mappedSuggested.every(row => {
      const w = row.reduce((acc, t) => acc + t.width, 0) + Math.max(0, row.length - 1) * spaceWidth;
      return w <= maxRowWidth;
    });

  if (allFit) return mappedSuggested;

  // Fallback greedy measureText wrap enforcing <= maxRowWidth (90% of canvas width)
  const wrapped: MeasuredWordToken[][] = [];
  let current: MeasuredWordToken[] = [];
  let currentWidth = 0;

  for (const tok of tokens) {
    const addedWidth = current.length === 0 ? tok.width : spaceWidth + tok.width;
    if (current.length > 0 && currentWidth + addedWidth > maxRowWidth) {
      wrapped.push(current);
      current = [tok];
      currentWidth = tok.width;
    } else {
      current.push(tok);
      currentWidth += addedWidth;
    }
  }
  if (current.length > 0) wrapped.push(current);
  return wrapped;
}

function drawCaptionOverlay(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  scale: number,
  currentTime: number,
  clip: Clip,
  captionStyle: ClipSettings['caption'],
  captionLeadSec = DEFAULT_CAPTION_LEAD_SEC
) {
  const words = clip.words || [];
  if (words.length === 0) return;

  const wordsPerLine = Math.max(1, Math.min(5, captionStyle.wordsPerLine || 4));
  const { chunk: currentChunk, activeIndexInChunk } = getActiveCaptionChunk(
    words,
    currentTime,
    wordsPerLine,
    captionLeadSec,
    clip.customLinesEdited ? clip.lines : undefined
  );
  if (currentChunk.length === 0) return;

  ctx.save();
  const baseFontSize = Math.round((captionStyle.size || 58) * scale);
  const fontFamily =
    captionStyle.fontFamily === 'Anton'
      ? '"Anton"'
      : captionStyle.fontFamily === 'Poppins'
      ? '"Poppins"'
      : '"Montserrat"';

  const setFontAtSize = (px: number) => {
    ctx.font = `900 ${px}px ${fontFamily}, sans-serif`;
  };

  setFontAtSize(baseFontSize);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const maxRowWidth = cw * 0.90;
  let activeFontSize = baseFontSize;

  // Measure tokens and auto-shrink slightly if a single very long word exceeds 90% width
  const buildMeasured = (fontPx: number) => {
    setFontAtSize(fontPx);
    const spW = ctx.measureText(' ').width;
    const measured: MeasuredWordToken[] = currentChunk.map((w, idx) => {
      let displayText = captionStyle.uppercase ? w.word.toUpperCase() : w.word;
      if (captionStyle.autoEmoji && w.emoji) {
        displayText = `${displayText} ${w.emoji}`;
      }
      const width = ctx.measureText(displayText).width;
      const isActive = idx === activeIndexInChunk;
      const progress = isActive ? Math.max(0, Math.min(1, (currentTime - w.start) / 0.12)) : 0;
      return { text: displayText, width, isActive, progress, raw: w };
    });
    return { spW, measured };
  };

  let { spW: spaceWidth, measured } = buildMeasured(activeFontSize);
  const widestWord = Math.max(...measured.map(m => m.width));
  if (widestWord > maxRowWidth) {
    activeFontSize = Math.max(18, Math.floor(activeFontSize * (maxRowWidth / widestWord)));
    ({ spW: spaceWidth, measured } = buildMeasured(activeFontSize));
  }

  const suggestedRows = splitDisplayWordsIntoRows(currentChunk, 2);
  const wrappedRows = wrapCaptionTokensByWidth(measured, suggestedRows, spaceWidth, maxRowWidth);

  const posY = ch * ((captionStyle.positionPercent || 76) / 100);
  const safePad = cw * 0.05;
  const hAlign = captionStyle.horizontalAlign || 'center';

  const rowLayouts = wrappedRows.map(row => {
    const lineWidth = row.reduce((acc, m) => acc + m.width, 0) + Math.max(0, row.length - 1) * spaceWidth;
    let startX = (cw - lineWidth) / 2;
    if (hAlign === 'left') {
      startX = safePad;
    } else if (hAlign === 'right') {
      startX = Math.max(safePad, cw - safePad - lineWidth);
    } else {
      startX = Math.max(safePad, (cw - lineWidth) / 2);
    }
    return { metrics: row, lineWidth, startX };
  });

  const lineHeight = activeFontSize * 1.24;
  const startY = rowLayouts.length === 1 ? posY : posY - ((rowLayouts.length - 1) * lineHeight) / 2;

  if (captionStyle.preset === 'punchy-box') {
    const boxPadX = 22 * scale;
    const boxPadY = 14 * scale;
    const maxLineW = Math.min(maxRowWidth, Math.max(...rowLayouts.map(r => r.lineWidth)));
    const minRowStartX = Math.min(...rowLayouts.map(r => r.startX));
    const boxH = rowLayouts.length * lineHeight + boxPadY * 1.4;
    const boxW = Math.min(cw * 0.94, maxLineW + boxPadX * 2);
    const boxX = hAlign === 'center' ? (cw - boxW) / 2 : Math.max(cw * 0.03, minRowStartX - boxPadX);
    const boxY = posY - boxH / 2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
    roundRect(ctx, boxX, boxY, boxW, boxH, 14 * scale);
    ctx.fill();
  }

  rowLayouts.forEach((row, rIdx) => {
    const rowY = startY + rIdx * lineHeight;
    let curX = row.startX;

    for (const m of row.metrics) {
      ctx.save();
      let wordScale = 1.0;
      if (m.isActive && captionStyle.popAnimation) {
        wordScale = 1.0 + Math.sin(m.progress * Math.PI) * 0.15;
      }

      const centerX = curX + m.width / 2;
      ctx.translate(centerX, rowY);
      ctx.scale(wordScale, wordScale);
      ctx.translate(-centerX, -rowY);

      if (captionStyle.strokeColor && captionStyle.strokeColor !== 'transparent') {
        ctx.strokeStyle = captionStyle.strokeColor;
        ctx.lineWidth = Math.max(2, Math.round(7 * scale));
        ctx.strokeText(m.text, curX, rowY);
      }

      if (m.isActive) {
        ctx.fillStyle = captionStyle.activeWordColor || '#FACC15';
        if (captionStyle.preset === 'neon') {
          ctx.shadowColor = captionStyle.activeWordColor || '#00FFCC';
          ctx.shadowBlur = 18 * scale;
        }
      } else {
        ctx.fillStyle = captionStyle.textColor || '#FFFFFF';
      }

      ctx.fillText(m.text, curX, rowY);
      ctx.restore();

      curX += m.width + spaceWidth;
    }
  });

  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function generateSrtContent(
  words: SubtitleWord[],
  clipStartTime: number,
  wordsPerLine = 3,
  customLines?: SubtitleLine[]
): string {
  if (!words || words.length === 0) return '';
  const chunks =
    customLines && customLines.length > 0
      ? customLines
          .filter(l => l.words && l.words.length > 0)
          .map(l => ({ words: l.words, start: l.words[0].start, end: l.words[l.words.length - 1].end }))
      : groupWordsIntoChunks(words, wordsPerLine);
  const lines: string[] = [];
  let srtIdx = 1;

  const formatTime = (sec: number) => {
    const s = Math.max(0, sec);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 1000);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  for (const chunk of chunks) {
    const relStart = Math.max(0, chunk.start - clipStartTime);
    const relEnd = Math.max(relStart + 0.35, chunk.end - clipStartTime);
    const text = chunk.words.map(w => w.word).join(' ');

    lines.push(String(srtIdx++));
    lines.push(`${formatTime(relStart)} --> ${formatTime(relEnd)}`);
    lines.push(text);
    lines.push('');
  }

  return lines.join('\n');
}

export function sanitizeExportFilename(input: string, maxLen = 48): string {
  return (input || 'klip')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, maxLen) || 'klip';
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function convertBlobToMp4OnServer(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch('/api/convert-to-mp4', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream'
    },
    body: blob,
    signal
  });
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    throw new Error(errJson?.error || `Gagal mengonversi video ke MP4 (HTTP ${res.status}).`);
  }
  const mp4Buf = await res.arrayBuffer();
  return new Blob([mp4Buf], { type: 'video/mp4' });
}

export class ColabClipError extends Error {
  isColabClipFailure = true;
  constructor(message: string) {
    super(message);
    this.name = 'ColabClipError';
  }
}

export async function checkColabHealth(
  whisperConfig: WhisperConfig,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  const cleanUrl = whisperConfig.url.trim();
  if (!cleanUrl) {
    return { ok: false, error: 'URL server Colab belum diisi.' };
  }
  try {
    const res = await fetch('/api/whisper/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        whisperUrl: cleanUrl,
        whisperToken: whisperConfig.token.trim()
      }),
      signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        error: data?.error || `Server Colab gagal diuji (HTTP ${res.status}).`
      };
    }
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || 'Gagal menghubungi server Colab.'
    };
  }
}

export async function fetchColabClipSourceBlob(params: {
  whisperConfig: WhisperConfig;
  videoUrl: string;
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
  onStatus?: (msg: string, pct: number) => void;
}): Promise<Blob> {
  const { whisperConfig, videoUrl, startTime, endTime, signal, onStatus } = params;
  onStatus?.('Meminta potongan video ke server Colab...', 5);
  const startRes = await fetch('/api/colab/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      whisperUrl: whisperConfig.url.trim(),
      whisperToken: whisperConfig.token.trim(),
      url: videoUrl,
      start: startTime,
      end: endTime
    }),
    signal
  });
  const startData = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !startData?.jobId) {
    throw new ColabClipError(
      startData?.error || startData?.detail || `Server Colab gagal membuat klip (HTTP ${startRes.status}).`
    );
  }

  const jobId = String(startData.jobId);
  while (true) {
    if (signal?.aborted) throw new Error('Render dibatalkan.');
    await new Promise(resolve => setTimeout(resolve, 1800));
    const jobRes = await fetch(`/api/colab/job/${encodeURIComponent(jobId)}`, {
      headers: {
        'x-whisper-url': whisperConfig.url.trim(),
        ...(whisperConfig.token.trim() ? { 'x-token': whisperConfig.token.trim() } : {})
      },
      signal
    });
    const jobData = await jobRes.json().catch(() => ({}));
    if (!jobRes.ok) {
      throw new ColabClipError(
        jobData?.error || jobData?.detail || `Gagal memeriksa status job Colab (HTTP ${jobRes.status}).`
      );
    }
    const pct = Math.min(90, Math.max(10, Number(jobData?.progress) || 25));
    onStatus?.(jobData?.message || 'Memotong video di Colab...', pct);
    const st = String(jobData?.status || '').toLowerCase();
    if (st === 'failed' || st === 'error') {
      throw new ColabClipError(
        jobData?.error || jobData?.detail || jobData?.message || 'Proses pemotongan klip di Colab gagal.'
      );
    }
    if (st === 'completed' || st === 'done' || st === 'finished') {
      break;
    }
  }

  onStatus?.('Mengunduh potongan video dari Colab...', 95);
  const fileRes = await fetch(`/api/colab/file/${encodeURIComponent(jobId)}`, {
    headers: {
      'x-whisper-url': whisperConfig.url.trim(),
      ...(whisperConfig.token.trim() ? { 'x-token': whisperConfig.token.trim() } : {})
    },
    signal
  });
  if (!fileRes.ok) {
    const errData = await fileRes.json().catch(() => ({}));
    throw new ColabClipError(
      errData?.error || `Gagal mengunduh video hasil potong dari Colab (HTTP ${fileRes.status}).`
    );
  }
  return await fileRes.blob();
}

export function getSupportedMimeType(): string {
  const types = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const t of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return 'video/webm';
}

export function isMp4RecordingSupported(): boolean {
  return getSupportedMimeType().includes('mp4');
}

export interface RenderOptions {
  videoFile: Blob;
  clip: Clip;
  settings: ClipSettings;
  syncOffset: number;
  captionLeadSec?: number;
  isCutClip: boolean;
  includeCleanVersion?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number, statusText: string, etaSeconds?: number) => void;
}

export interface RenderResult {
  captionedBlob: Blob;
  cleanBlob?: Blob;
  mimeType: string;
  extension: 'mp4' | 'webm';
}

export async function renderVideoInBrowser({
  videoFile,
  clip,
  settings,
  syncOffset,
  captionLeadSec = DEFAULT_CAPTION_LEAD_SEC,
  isCutClip,
  includeCleanVersion = false,
  signal,
  onProgress
}: RenderOptions): Promise<RenderResult> {
  if (signal?.aborted) {
    throw new Error('Render dibatalkan.');
  }

  const mimeType = getSupportedMimeType();
  const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const bitrate = settings.canvas.resolution === '1080p' ? 10_000_000 : 6_000_000;

  // Ensure fonts are loaded before drawing frames
  await ensureRenderFontsLoaded(settings.caption.fontFamily);

  // Request Screen Wake Lock
  let wakeLock: any = null;
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await (navigator as any).wakeLock.request('screen');
    } catch {
      // non-critical
    }
  }

  const videoUrl = URL.createObjectURL(videoFile);
  const video = document.createElement('video');
  video.src = videoUrl;
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.muted = false;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Gagal memuat file video untuk dirender.'));
    });
  } catch (err) {
    URL.revokeObjectURL(videoUrl);
    if (wakeLock) wakeLock.release().catch(() => {});
    throw err;
  }

  const { width: cw, height: ch } = getCanvasDimensions(settings.canvas.aspectRatio, settings.canvas.resolution);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  let cleanCanvas: HTMLCanvasElement | null = null;
  let cleanCtx: CanvasRenderingContext2D | null = null;
  if (includeCleanVersion) {
    cleanCanvas = document.createElement('canvas');
    cleanCanvas.width = cw;
    cleanCanvas.height = ch;
    cleanCtx = cleanCanvas.getContext('2d', { alpha: false })!;
  }

  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const audioCtx = new AudioContextClass();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume().catch(() => {});
  }

  const sourceNode = audioCtx.createMediaElementSource(video);
  const destNode = audioCtx.createMediaStreamDestination();
  sourceNode.connect(destNode);
  // Intentionally NOT connected to audioCtx.destination so rendering stays silent

  const canvasStream = canvas.captureStream(30);
  if (destNode.stream.getAudioTracks().length > 0) {
    canvasStream.addTrack(destNode.stream.getAudioTracks()[0]);
  }

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(canvasStream, {
    mimeType,
    videoBitsPerSecond: bitrate
  });
  recorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  let cleanChunks: Blob[] = [];
  let cleanRecorder: MediaRecorder | null = null;
  if (includeCleanVersion && cleanCanvas) {
    const cleanStream = cleanCanvas.captureStream(30);
    if (destNode.stream.getAudioTracks().length > 0) {
      cleanStream.addTrack(destNode.stream.getAudioTracks()[0].clone());
    }
    cleanRecorder = new MediaRecorder(cleanStream, {
      mimeType,
      videoBitsPerSecond: bitrate
    });
    cleanRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) cleanChunks.push(e.data);
    };
  }

  const clipStart = isCutClip ? 0 : Math.max(0, clip.startTime);
  const rawClipEnd = isCutClip ? clip.duration : clip.endTime;
  const clipEnd = Math.min(video.duration || rawClipEnd, Math.max(clipStart + 0.5, rawClipEnd));
  const totalDuration = Math.max(0.5, clipEnd - clipStart);

  video.currentTime = clipStart;
  await new Promise<void>(resolve => {
    const done = () => resolve();
    video.addEventListener('seeked', done, { once: true });
    setTimeout(done, 1500);
  });

  return new Promise<RenderResult>((resolve, reject) => {
    let animationFrameId = 0;
    let isFinished = false;
    let abortedReason: string | null = null;

    const cleanup = () => {
      if (isFinished) return;
      isFinished = true;
      cancelAnimationFrame(animationFrameId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (signal) signal.removeEventListener('abort', handleSignalAbort);
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // ignore
      }
      URL.revokeObjectURL(videoUrl);
      if (audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
      if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
    };

    const failAndAbort = (msg: string) => {
      if (isFinished) return;
      abortedReason = msg;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // ignore
      }
      try {
        if (cleanRecorder && cleanRecorder.state !== 'inactive') cleanRecorder.stop();
      } catch {
        // ignore
      }
      cleanup();
      reject(new Error(msg));
    };

    const handleVisibilityChange = () => {
      if (document.hidden && !isFinished) {
        failAndAbort('Perekaman dihentikan karena tab browser disembunyikan atau layar dimatikan. Biarkan tab tetap aktif lalu klik "Coba lagi".');
      }
    };

    const handleSignalAbort = () => {
      if (!isFinished) {
        failAndAbort('Render dibatalkan oleh pengguna.');
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (signal) signal.addEventListener('abort', handleSignalAbort);

    recorder.onstop = async () => {
      if (abortedReason) return;
      const rawCaptionedBlob = new Blob(chunks, { type: mimeType });
      const rawCleanBlob = cleanChunks.length > 0 ? new Blob(cleanChunks, { type: mimeType }) : undefined;
      cleanup();

      if (mimeType.includes('mp4')) {
        resolve({
          captionedBlob: rawCaptionedBlob,
          cleanBlob: rawCleanBlob,
          mimeType: 'video/mp4',
          extension: 'mp4'
        });
        return;
      }

      try {
        onProgress?.(96, 'Mengonversi video ke format MP4 (H.264 + AAC)...', 2);
        const captionedMp4 = await convertBlobToMp4OnServer(rawCaptionedBlob, signal);
        const cleanMp4 = rawCleanBlob ? await convertBlobToMp4OnServer(rawCleanBlob, signal) : undefined;
        resolve({
          captionedBlob: captionedMp4,
          cleanBlob: cleanMp4,
          mimeType: 'video/mp4',
          extension: 'mp4'
        });
      } catch (convErr: any) {
        reject(new Error(convErr?.message || 'Gagal mengonversi video hasil render ke format MP4.'));
      }
    };

    recorder.onerror = () => {
      failAndAbort('Terjadi kegagalan MediaRecorder saat menyandikan frame video.');
    };

    video
      .play()
      .then(() => {
        if (isFinished) return;
        recorder.start(100);
        if (cleanRecorder) cleanRecorder.start(100);

        const startTimeStamp = performance.now();

        const renderLoop = () => {
          if (isFinished) return;

          const currentVideoTime = video.currentTime;
          const mappedMediaTime = isCutClip ? clip.startTime + currentVideoTime : currentVideoTime;

          drawFrame(
            ctx,
            {
              video,
              mediaTime: mappedMediaTime,
              clip,
              style: {
                title: settings.title,
                caption: settings.caption
              },
              canvasSpec: settings.canvas,
              syncOffset,
              captionLeadSec,
              drawOverlays: true
            }
          );

          if (cleanCtx) {
            drawFrame(
              cleanCtx,
              {
                video,
                mediaTime: mappedMediaTime,
                clip,
                style: {
                  title: settings.title,
                  caption: settings.caption
                },
                canvasSpec: settings.canvas,
                syncOffset,
                captionLeadSec,
                drawOverlays: false
              }
            );
          }

          const elapsed = Math.max(0, currentVideoTime - clipStart);
          const progressPercent = Math.min(93, Math.round((elapsed / totalDuration) * 93));

          const timeElapsedSec = (performance.now() - startTimeStamp) / 1000;
          const estimatedTotalSec = progressPercent > 2 ? (timeElapsedSec / progressPercent) * 100 : totalDuration;
          const remainingSec = Math.max(0, Math.round(estimatedTotalSec - timeElapsedSec));

          if (onProgress) {
            onProgress(progressPercent, `Merender klip & subtitle... sisa ~${remainingSec} dtk (${progressPercent}%)`, remainingSec);
          }

          if (currentVideoTime >= clipEnd || video.ended) {
            if (onProgress) onProgress(94, 'Menyelesaikan berkas MP4...', 1);
            try {
              if (recorder.state !== 'inactive') recorder.stop();
              if (cleanRecorder && cleanRecorder.state !== 'inactive') cleanRecorder.stop();
            } catch (e: any) {
              failAndAbort(e?.message || 'Gagal menghentikan perekam video.');
            }
            return;
          }

          animationFrameId = requestAnimationFrame(renderLoop);
        };

        animationFrameId = requestAnimationFrame(renderLoop);
      })
      .catch(err => {
        failAndAbort(`Pemutar video gagal memulai render: ${err?.message || 'Playback error'}`);
      });
  });
}

export async function renderAndSaveSingleClipMp4(params: {
  videoInfo: VideoInfo;
  clip: Clip;
  clipNumber: number;
  settings: ClipSettings;
  selectedFile?: File | null;
  isCutLocalFile?: boolean;
  whisperConfig?: WhisperConfig;
  includeCleanVersion?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number, statusText: string) => void;
}): Promise<RenderedClipRecord> {
  const {
    videoInfo,
    clip,
    clipNumber,
    settings,
    selectedFile,
    isCutLocalFile = false,
    whisperConfig,
    includeCleanVersion = false,
    signal,
    onProgress
  } = params;

  let sourceBlob: Blob;
  let isCut = isCutLocalFile;

  if (selectedFile) {
    sourceBlob = selectedFile;
  } else if (whisperConfig?.url?.trim()) {
    onProgress?.(3, 'Memeriksa koneksi Server Colab (/health)...');
    const health = await checkColabHealth(whisperConfig, signal);
    if (!health.ok) {
      throw new Error(
        `Hubungkan server Colab atau pilih berkas video di Langkah 3. (${health.error || 'Tes /health gagal'})`
      );
    }
    onProgress?.(6, 'Mengambil potongan video dari Server Colab...');
    sourceBlob = await fetchColabClipSourceBlob({
      whisperConfig,
      videoUrl: videoInfo.url,
      startTime: clip.startTime,
      endTime: clip.endTime,
      signal,
      onStatus: (msg, pct) => onProgress?.(Math.min(28, Math.round(pct * 0.28)), msg)
    });
    isCut = true;
  } else {
    throw new Error('Hubungkan server Colab atau pilih berkas video di Langkah 3.');
  }

  const captionLeadSec = getSavedCaptionLeadSec(videoInfo.youtubeId);
  const result = await renderVideoInBrowser({
    videoFile: sourceBlob,
    clip,
    settings,
    syncOffset: 0,
    captionLeadSec,
    isCutClip: isCut,
    includeCleanVersion,
    signal,
    onProgress: (pct, msg) => {
      const scaled = selectedFile ? pct : Math.min(99, Math.round(30 + pct * 0.7));
      onProgress?.(scaled, msg);
    }
  });

  const srtContent = generateSrtContent(
    clip.words || [],
    clip.startTime,
    settings.caption.wordsPerLine || 3,
    clip.customLinesEdited ? clip.lines : undefined
  );
  const transcriptText = (clip.words || []).map(w => w.word).join(' ').trim();

  const record: RenderedClipRecord = {
    id: `${videoInfo.youtubeId}::${clip.id}`,
    videoId: videoInfo.youtubeId,
    clipId: clip.id,
    clipNumber,
    title: settings.title.text.trim() || clip.hookText || clip.title,
    category: clip.category,
    viralityScore: clip.viralityScore,
    reasons: clip.reasons || [],
    transcriptText,
    srtContent,
    startTime: clip.startTime,
    endTime: clip.endTime,
    duration: clip.duration,
    mimeType: result.mimeType,
    extension: result.extension,
    captionedBlob: result.captionedBlob,
    cleanBlob: result.cleanBlob,
    qualityLabel: videoInfo.diagnostics?.qualityLabel || 'Standar',
    renderedAt: Date.now()
  };

  await saveRenderedClip(record);
  return record;
}

export function downloadRenderedRecordMp4(record: RenderedClipRecord, useClean = false): void {
  const blob = useClean && record.cleanBlob ? record.cleanBlob : record.captionedBlob;
  const nn = String(record.clipNumber).padStart(2, '0');
  const cat = sanitizeExportFilename(record.category, 24);
  const title = sanitizeExportFilename(record.title, 40);
  const suffix = useClean ? '_tanpa_subtitle' : '';
  triggerBlobDownload(blob, `${nn}_${cat}_${title}${suffix}.${record.extension}`);
}
