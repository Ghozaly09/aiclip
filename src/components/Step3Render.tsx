import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Upload,
  Copy,
  Check,
  Play,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Server,
  HardDrive,
  RefreshCw,
  XCircle,
  CheckCircle2,
  Download
} from 'lucide-react';
import {
  Clip,
  ClipSettings,
  RenderedClipRecord,
  VideoInfo,
  WhisperConfig
} from '../types.ts';
import {
  ColabClipError,
  checkColabHealth,
  downloadRenderedRecordMp4,
  fetchColabClipSourceBlob,
  generateSrtContent,
  isMp4RecordingSupported,
  renderVideoInBrowser
} from '../utils/renderEngine.ts';
import { formatClockMinSec, getSavedCaptionLeadSec } from '../utils/subtitleParser.ts';
import { saveRenderedClip } from '../utils/renderedClipDb.ts';
import { loadClipSettings } from './ClipEditor.tsx';

interface Step3RenderProps {
  videoInfo: VideoInfo;
  selectedClips: Clip[];
  selectedFile: File | null;
  onSelectFile: (file: File | null) => void;
  whisperConfig: WhisperConfig;
  onUpdateWhisperConfig?: (cfg: WhisperConfig) => void;
  renderedClips: RenderedClipRecord[];
  renderedClipIds: Set<string>;
  onClipRendered: (record: RenderedClipRecord) => void;
  onBack: () => void;
  onProceedToExport: () => void;
  singleReRenderClipId?: string | null;
  onClearSingleReRender?: () => void;
}

interface ClipQueueState {
  status: 'pending' | 'downloading' | 'rendering' | 'done' | 'failed';
  progress: number;
  message: string;
  etaSeconds?: number;
}

interface ColabHealthState {
  status: 'checking' | 'connected' | 'disconnected';
  error?: string;
}

export const Step3Render: React.FC<Step3RenderProps> = ({
  videoInfo,
  selectedClips,
  selectedFile,
  onSelectFile,
  whisperConfig,
  onUpdateWhisperConfig,
  renderedClips,
  renderedClipIds,
  onClipRendered,
  onBack,
  onProceedToExport,
  singleReRenderClipId,
  onClearSingleReRender
}) => {
  const hasColabConfigured = Boolean(whisperConfig.url.trim());
  const [sourceMode, setSourceMode] = useState<'colab' | 'local'>(() =>
    selectedFile ? 'local' : hasColabConfigured ? 'colab' : 'local'
  );
  const [colabHealth, setColabHealth] = useState<ColabHealthState>(() =>
    hasColabConfigured
      ? { status: 'checking' }
      : { status: 'disconnected', error: 'URL server Colab belum diisi.' }
  );

  const [isCutClip, setIsCutClip] = useState(false);
  const [detectedFileDuration, setDetectedFileDuration] = useState<number | null>(null);
  const [includeCleanVersion, setIncludeCleanVersion] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const [isRenderingQueue, setIsRenderingQueue] = useState(false);
  const [queueStates, setQueueStates] = useState<Record<string, ClipQueueState>>({});
  const [queueError, setQueueError] = useState<string | null>(null);
  const [isColabClipFailure, setIsColabClipFailure] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const localFileInputRef = useRef<HTMLInputElement | null>(null);
  const mp4Supported = isMp4RecordingSupported();

  const targetClips = React.useMemo(() => {
    if (singleReRenderClipId) {
      const match = videoInfo.clips.find(c => c.id === singleReRenderClipId);
      if (match) return [match];
    }
    return selectedClips;
  }, [singleReRenderClipId, selectedClips, videoInfo.clips]);

  const runColabHealthCheck = React.useCallback(
    async (cfg: WhisperConfig, signal?: AbortSignal) => {
      if (!cfg.url.trim()) {
        setColabHealth({
          status: 'disconnected',
          error: 'URL server Colab belum diisi.'
        });
        return false;
      }
      setColabHealth({ status: 'checking' });
      const res = await checkColabHealth(cfg, signal);
      if (signal?.aborted) return false;
      if (res.ok) {
        setColabHealth({ status: 'connected' });
        return true;
      }
      setColabHealth({
        status: 'disconnected',
        error: res.error || 'Tes koneksi GET /health gagal.'
      });
      return false;
    },
    []
  );

  // Verify Colab /health automatically on mount or when config changes externally
  useEffect(() => {
    if (!whisperConfig.url.trim()) {
      setColabHealth({
        status: 'disconnected',
        error: 'URL server Colab belum diisi.'
      });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void runColabHealthCheck(whisperConfig, controller.signal);
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [whisperConfig.url, whisperConfig.token, runColabHealthCheck]);

  const isRenderingQueueRef = useRef(isRenderingQueue);
  isRenderingQueueRef.current = isRenderingQueue;
  const lastAutoSwitchedFileRef = useRef<File | null>(selectedFile);

  // Auto-switch to local mode when user newly selects a local file
  useEffect(() => {
    if (
      selectedFile &&
      selectedFile !== lastAutoSwitchedFileRef.current &&
      !isRenderingQueueRef.current
    ) {
      lastAutoSwitchedFileRef.current = selectedFile;
      setSourceMode('local');
      setQueueError(null);
      setIsColabClipFailure(false);
    }
  }, [selectedFile]);

  // Auto-detect whether uploaded local file is a cut clip or full video
  useEffect(() => {
    if (!selectedFile) {
      setDetectedFileDuration(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => {
      const dur = v.duration || 0;
      setDetectedFileDuration(dur);
      const refClip = targetClips[0];
      if (refClip && Math.abs(dur - refClip.duration) <= 3 && targetClips.length === 1) {
        setIsCutClip(true);
      } else {
        setIsCutClip(false);
      }
      URL.revokeObjectURL(url);
    };
    v.onerror = () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  const ytdlpCommand = `yt-dlp -f "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080]" --merge-output-format mp4 -o video.mp4 "${videoInfo.url}"`;

  const handleCopyCommand = () => {
    navigator.clipboard.writeText(ytdlpCommand).then(() => {
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2000);
    }).catch(() => {});
  };

  const isColabConnected = colabHealth.status === 'connected';
  const hasLocalVideo = Boolean(selectedFile);

  const renderDisabledReason: string | null = (() => {
    if (targetClips.length === 0) {
      return 'Tidak ada klip yang dipilih untuk dirender.';
    }
    if (!isColabConnected && !hasLocalVideo) {
      return 'Hubungkan server Colab atau pilih berkas video';
    }
    if (sourceMode === 'colab' && !isColabConnected) {
      return 'Server Colab belum terhubung. Hubungkan server Colab atau pilih berkas video.';
    }
    if (sourceMode === 'local' && !hasLocalVideo) {
      return 'Pilih berkas video lokal atau beralih ke server Colab yang terhubung.';
    }
    return null;
  })();

  const handleSwitchToLocalAndPickFile = () => {
    setSourceMode('local');
    setQueueError(null);
    setIsColabClipFailure(false);
    localFileInputRef.current?.click();
  };

  const handleStartQueue = async () => {
    if (targetClips.length === 0) return;

    if (sourceMode === 'local') {
      if (!selectedFile) {
        setQueueError('Hubungkan server Colab atau pilih berkas video');
        setIsColabClipFailure(false);
        return;
      }
    } else {
      const ok = isColabConnected || (await runColabHealthCheck(whisperConfig));
      if (!ok) {
        setQueueError('Hubungkan server Colab atau pilih berkas video');
        setIsColabClipFailure(false);
        return;
      }
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsRenderingQueue(true);
    setQueueError(null);
    setIsColabClipFailure(false);

    const initialStates: Record<string, ClipQueueState> = {};
    targetClips.forEach(c => {
      initialStates[c.id] = { status: 'pending', progress: 0, message: 'Menunggu antrean...' };
    });
    setQueueStates(initialStates);

    const captionLeadSec = getSavedCaptionLeadSec(videoInfo.youtubeId);

    try {
      for (let i = 0; i < targetClips.length; i++) {
        if (controller.signal.aborted) break;
        const clip = targetClips[i];
        const clipNumber = videoInfo.clips.findIndex(c => c.id === clip.id) + 1 || i + 1;
        const settings: ClipSettings = loadClipSettings(videoInfo.youtubeId, clip);

        try {
          let sourceBlob: Blob;
          let cutFlag = isCutClip;

          if (sourceMode === 'colab') {
            sourceBlob = await fetchColabClipSourceBlob({
              whisperConfig,
              videoUrl: videoInfo.url,
              startTime: clip.startTime,
              endTime: clip.endTime,
              signal: controller.signal,
              onStatus: (msg, pct) => {
                setQueueStates(prev => ({
                  ...prev,
                  [clip.id]: { status: 'downloading', progress: pct, message: msg }
                }));
              }
            });
            cutFlag = true;
          } else {
            sourceBlob = selectedFile!;
          }

          setQueueStates(prev => ({
            ...prev,
            [clip.id]: { status: 'rendering', progress: 0, message: 'Menyiapkan canvas render...' }
          }));

          const result = await renderVideoInBrowser({
            videoFile: sourceBlob,
            clip,
            settings,
            syncOffset: 0,
            captionLeadSec,
            isCutClip: cutFlag,
            includeCleanVersion,
            signal: controller.signal,
            onProgress: (pct, statusText, eta) => {
              setQueueStates(prev => ({
                ...prev,
                [clip.id]: {
                  status: 'rendering',
                  progress: pct,
                  message: statusText,
                  etaSeconds: eta
                }
              }));
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
          onClipRendered(record);

          setQueueStates(prev => ({
            ...prev,
            [clip.id]: { status: 'done', progress: 100, message: 'Selesai & tersimpan!' }
          }));
        } catch (clipErr: any) {
          const msg = clipErr?.message || 'Gagal merender klip.';
          const colabFailed =
            sourceMode === 'colab' &&
            (clipErr instanceof ColabClipError || Boolean(clipErr?.isColabClipFailure));
          setQueueStates(prev => ({
            ...prev,
            [clip.id]: { status: 'failed', progress: 0, message: msg }
          }));
          setQueueError(msg);
          setIsColabClipFailure(colabFailed);
          break;
        }
      }
    } finally {
      setIsRenderingQueue(false);
      abortControllerRef.current = null;
      if (onClearSingleReRender) onClearSingleReRender();
    }
  };

  const handleCancelRender = () => {
    abortControllerRef.current?.abort();
  };

  const doneCount = targetClips.filter(
    c => queueStates[c.id]?.status === 'done' || renderedClipIds.has(c.id)
  ).length;

  return (
    <div className="w-full max-w-4xl mx-auto space-y-4 pb-8">
      {/* Persistent hidden file input so switching from Colab failure opens device picker immediately */}
      <input
        ref={localFileInputRef}
        type="file"
        accept="video/*"
        disabled={isRenderingQueue}
        onChange={e => {
          const file = e.target.files?.[0] || null;
          onSelectFile(file);
          e.target.value = '';
        }}
        className="hidden"
      />

      {/* Header */}
      <div className="flex items-center justify-between gap-2 sm:gap-3 bg-[#121826] border border-slate-800 rounded-2xl p-3.5">
        <button
          type="button"
          onClick={onBack}
          disabled={isRenderingQueue}
          className="min-h-[44px] px-3 sm:px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Kembali</span>
        </button>

        <div className="text-center min-w-0">
          <div className="text-xs font-bold text-slate-100 truncate">Render Klip Terpilih</div>
          <div className="text-[11px] text-slate-400 font-mono-num">
            {targetClips.length} klip siap dirender
          </div>
        </div>

        <button
          type="button"
          onClick={onProceedToExport}
          disabled={renderedClipIds.size === 0 || isRenderingQueue}
          className="min-h-[44px] px-3 sm:px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 text-xs font-bold flex items-center gap-1.5 shrink-0"
        >
          <span>Hasil ({renderedClipIds.size})</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      {/* Browser MP4 Auto-Conversion Info */}
      {!mp4Supported && (
        <div className="bg-sky-950/40 border border-sky-500/40 rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-sky-200">
          <AlertTriangle className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
          <span>
            Browser merekam sementara via WebM, lalu server otomatis mengonversinya menjadi berkas MP4 (H.264 + AAC) siap putar &amp; unduh.
          </span>
        </div>
      )}

      {/* Source Selection (ONLY 2 sources: Colab OR Local File) */}
      <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
        <h2 className="text-sm font-bold text-slate-100">1. Pilih Sumber Video</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            disabled={isRenderingQueue}
            onClick={() => {
              setSourceMode('colab');
              setQueueError(null);
              setIsColabClipFailure(false);
            }}
            className={`min-h-[64px] p-3.5 rounded-xl border text-left flex items-start gap-3 transition ${
              sourceMode === 'colab'
                ? 'bg-emerald-500/15 border-emerald-500 text-slate-100'
                : 'bg-[#0b0f17] border-slate-800 text-slate-300 hover:border-slate-700'
            }`}
          >
            <Server className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold">Server Colab</span>
                {colabHealth.status === 'connected' && (
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-semibold">
                    Terhubung
                  </span>
                )}
                {colabHealth.status === 'checking' && (
                  <span className="px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 text-[10px] font-semibold">
                    Memeriksa...
                  </span>
                )}
                {colabHealth.status === 'disconnected' && (
                  <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold">
                    Belum terhubung
                  </span>
                )}
              </div>
              <div className="text-[11px] text-slate-400">
                Potong &amp; unduh segmen video lewat server Colab (POST /clip).
              </div>
            </div>
          </button>

          <button
            type="button"
            disabled={isRenderingQueue}
            onClick={() => {
              setSourceMode('local');
              setQueueError(null);
              setIsColabClipFailure(false);
            }}
            className={`min-h-[64px] p-3.5 rounded-xl border text-left flex items-start gap-3 transition ${
              sourceMode === 'local'
                ? 'bg-emerald-500/15 border-emerald-500 text-slate-100'
                : 'bg-[#0b0f17] border-slate-800 text-slate-300 hover:border-slate-700'
            }`}
          >
            <HardDrive className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold">Berkas Video Lokal</span>
                {selectedFile && (
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-semibold">
                    Berkas siap
                  </span>
                )}
              </div>
              <div className="text-[11px] text-slate-400">
                1 berkas video dari perangkat dipakai untuk semua klip (diproses di browser).
              </div>
            </div>
          </button>
        </div>

        {/* Colab Configuration & Health Test Panel */}
        {sourceMode === 'colab' && (
          <div className="bg-[#0b0f17] border border-slate-800 rounded-xl p-4 space-y-3 text-xs">
            {onUpdateWhisperConfig && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input
                  type="url"
                  disabled={isRenderingQueue}
                  value={whisperConfig.url}
                  onChange={e => onUpdateWhisperConfig({ ...whisperConfig, url: e.target.value })}
                  placeholder="https://xxxx.ngrok-free.app"
                  className="w-full min-h-[42px] px-3 bg-[#121826] border border-slate-700 focus:border-sky-500 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                />
                <input
                  type="password"
                  disabled={isRenderingQueue}
                  value={whisperConfig.token}
                  onChange={e => onUpdateWhisperConfig({ ...whisperConfig, token: e.target.value })}
                  placeholder="Token x-token (opsional)"
                  autoComplete="off"
                  className="w-full min-h-[42px] px-3 bg-[#121826] border border-slate-700 focus:border-sky-500 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {colabHealth.status === 'connected' && (
                  <span className="text-emerald-400 flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>Server Colab terhubung (GET /health OK).</span>
                  </span>
                )}
                {colabHealth.status === 'checking' && (
                  <span className="text-sky-300 flex items-center gap-1.5 font-medium">
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span>Memeriksa koneksi Colab (GET /health)...</span>
                  </span>
                )}
                {colabHealth.status === 'disconnected' && (
                  <span className="text-amber-300 flex items-start gap-1.5">
                    <XCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <span className="break-words">
                      {colabHealth.error || 'Server Colab belum terhubung.'}
                    </span>
                  </span>
                )}
              </div>

              <button
                type="button"
                disabled={isRenderingQueue || colabHealth.status === 'checking'}
                onClick={() => void runColabHealthCheck(whisperConfig)}
                className="min-h-[38px] px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 text-xs font-semibold text-slate-100 flex items-center gap-1.5 shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${colabHealth.status === 'checking' ? 'animate-spin' : ''}`} />
                <span>Tes koneksi</span>
              </button>
            </div>
          </div>
        )}

        {/* Local File Picker & Helper Instructions */}
        {sourceMode === 'local' && (
          <div className="bg-[#0b0f17] border border-slate-800 rounded-xl p-4 space-y-3.5 text-xs">
            <button
              type="button"
              disabled={isRenderingQueue}
              onClick={() => localFileInputRef.current?.click()}
              className="w-full min-h-[56px] border-2 border-dashed border-slate-700 hover:border-emerald-500 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-center gap-2.5 cursor-pointer transition"
            >
              <Upload className="w-5 h-5 text-emerald-400 shrink-0" />
              <span className="font-semibold text-slate-200 text-center break-all">
                {selectedFile
                  ? `Berkas dipilih: ${selectedFile.name} (${(selectedFile.size / (1024 * 1024)).toFixed(1)} MB)`
                  : 'Ketuk untuk memilih berkas video MP4/WebM dari perangkat'}
              </span>
            </button>

            {selectedFile && detectedFileDuration !== null && (
              <div className="flex flex-wrap items-center justify-between gap-2 bg-[#121826] border border-slate-800 rounded-lg p-2.5">
                <span className="text-slate-300 font-mono-num">
                  Durasi berkas: {formatClockMinSec(detectedFileDuration)}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsCutClip(false)}
                    className={`px-2.5 py-1 rounded-md font-semibold ${
                      !isCutClip ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    Video Penuh
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsCutClip(true)}
                    className={`px-2.5 py-1 rounded-md font-semibold ${
                      isCutClip ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    Potongan Klip
                  </button>
                </div>
              </div>
            )}

            {/* Helper: yt-dlp command & YouTube link */}
            <div className="space-y-2 pt-2 border-t border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-300">Belum punya file video?</span>
                <a
                  href={videoInfo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 font-semibold"
                >
                  <span>Buka di YouTube</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
              <div className="flex items-center gap-2 bg-[#121826] border border-slate-800 rounded-lg p-2">
                <code className="flex-1 text-[11px] font-mono text-slate-300 overflow-x-auto whitespace-nowrap">
                  {ytdlpCommand}
                </code>
                <button
                  type="button"
                  onClick={handleCopyCommand}
                  className="min-h-[34px] px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold flex items-center gap-1 shrink-0"
                >
                  {copiedCmd ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedCmd ? 'Disalin' : 'Salin'}</span>
                </button>
              </div>
              <p className="text-[11px] text-slate-500">
                Catatan hak cipta: Pengguna bertanggung jawab penuh atas video yang diunduh. Berkas hanya dibaca lokal di browser dan tidak diunggah ke server.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Render Controls & Queue */}
      <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-slate-100">2. Antrean Render</h2>
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              disabled={isRenderingQueue}
              checked={includeCleanVersion}
              onChange={e => setIncludeCleanVersion(e.target.checked)}
              className="w-4 h-4 accent-emerald-500"
            />
            <span>Sertakan versi tanpa subtitle</span>
          </label>
        </div>

        <div className="bg-slate-900/70 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-300">
          Jangan tutup tab atau matikan layar selama proses render berlangsung.
        </div>

        {/* Queue Items (Mobile-safe: status placed on its own row below title) */}
        <div className="space-y-2.5">
          {targetClips.map((clip, idx) => {
            const st = queueStates[clip.id];
            const alreadySaved = renderedClipIds.has(clip.id);
            const effectiveStatus = st?.status || (alreadySaved ? 'done' : 'pending');

            return (
              <div
                key={clip.id}
                className="bg-[#0b0f17] border border-slate-800 rounded-xl p-3.5 space-y-2.5 overflow-hidden"
              >
                {/* Row 1: Number, Time & Wrapped/Ellipsized Title */}
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-[11px] font-mono-num text-slate-400">
                    <span className="font-bold text-slate-300">#{idx + 1}</span>
                    <span>
                      ({formatClockMinSec(clip.startTime)}–{formatClockMinSec(clip.endTime)})
                    </span>
                  </div>
                  <div className="text-xs sm:text-sm font-bold text-slate-100 leading-snug line-clamp-2 break-words">
                    {clip.hookText || clip.title}
                  </div>
                </div>

                {/* Row 2: Status on its own dedicated row below title */}
                <div className="pt-2 border-t border-slate-800/70 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold">
                  {effectiveStatus === 'done' && (
                    <>
                      <span className="text-emerald-400 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>Selesai</span>
                      </span>
                      {(() => {
                        const rec = renderedClips.find(r => r.clipId === clip.id);
                        return rec ? (
                          <button
                            type="button"
                            onClick={() => downloadRenderedRecordMp4(rec)}
                            className="min-h-[34px] px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-[11px] flex items-center gap-1.5 shrink-0"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Unduh MP4</span>
                          </button>
                        ) : null;
                      })()}
                    </>
                  )}

                  {effectiveStatus === 'failed' && (
                    <span className="text-red-400 flex items-center gap-1.5">
                      <XCircle className="w-4 h-4 shrink-0" />
                      <span>Gagal</span>
                    </span>
                  )}

                  {(effectiveStatus === 'downloading' || effectiveStatus === 'rendering') && (
                    <div className="w-full space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-slate-300">
                          {st?.message || 'Memproses...'}
                        </span>
                        <span className="font-mono-num text-sky-400 shrink-0">
                          {st?.progress ?? 0}%
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 transition-all duration-200"
                          style={{ width: `${Math.max(3, st?.progress ?? 0)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {effectiveStatus === 'pending' && (
                    <span className="text-slate-400">Siap</span>
                  )}
                </div>

                {effectiveStatus === 'failed' && st?.message && (
                  <div className="text-[11px] text-red-400 leading-relaxed break-words whitespace-pre-wrap">
                    {st.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Queue Error Banner (with raw Colab error + yt-dlp/cookies advice + Retry + Pick Local File) */}
        {queueError && !isRenderingQueue && (
          <div className="bg-red-950/50 border border-red-500/40 rounded-xl p-3.5 space-y-3 text-xs text-red-200">
            <div className="space-y-1.5">
              <div className="font-semibold text-red-100 break-words whitespace-pre-wrap leading-relaxed">
                {queueError}
              </div>
              {isColabClipFailure && (
                <div className="text-amber-200 bg-amber-950/40 border border-amber-500/30 rounded-lg px-3 py-2 leading-relaxed">
                  Saran: Perbarui yt-dlp di Colab (jalankan ulang sel 1) atau unggah cookies.txt
                </div>
              )}
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={handleStartQueue}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-red-500 hover:bg-red-400 text-slate-950 font-bold flex items-center justify-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Coba lagi</span>
              </button>
              {isColabClipFailure && (
                <button
                  type="button"
                  onClick={handleSwitchToLocalAndPickFile}
                  className="min-h-[42px] px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-bold flex items-center justify-center gap-1.5"
                >
                  <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Pilih berkas video sebagai gantinya</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Clear explanation when Render button is disabled */}
        {renderDisabledReason && !isRenderingQueue && (
          <div className="bg-amber-950/35 border border-amber-500/35 rounded-xl px-3.5 py-2.5 flex items-center gap-2 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{renderDisabledReason}</span>
          </div>
        )}

        {/* Primary Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-3">
          {!isRenderingQueue ? (
            <button
              type="button"
              onClick={handleStartQueue}
              disabled={Boolean(renderDisabledReason)}
              className="flex-1 min-h-[48px] px-5 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 transition cursor-pointer disabled:cursor-not-allowed"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>
                {singleReRenderClipId
                  ? 'Render Ulang Klip Ini'
                  : `Render Klip Terpilih (${targetClips.length})`}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCancelRender}
              className="flex-1 min-h-[48px] px-5 py-3 rounded-xl bg-red-500 hover:bg-red-400 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 transition"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Batalkan Antrean Render</span>
            </button>
          )}

          {doneCount > 0 && !isRenderingQueue && (
            <button
              type="button"
              onClick={onProceedToExport}
              className="min-h-[48px] px-5 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-bold text-sm flex items-center justify-center gap-2"
            >
              <span>Buka Hasil &amp; Ekspor ({renderedClipIds.size})</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
