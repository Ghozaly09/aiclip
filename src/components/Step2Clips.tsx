import React, { useState, useMemo } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Activity,
  RefreshCw,
  Loader2,
  SlidersHorizontal,
  AlertTriangle,
  Download
} from 'lucide-react';
import {
  AnalyzeJobStatusResponse,
  Clip,
  RenderedClipRecord,
  VideoInfo,
  WhisperConfig
} from '../types.ts';
import { formatClockMinSec } from '../utils/subtitleParser.ts';
import {
  downloadRenderedRecordMp4,
  renderAndSaveSingleClipMp4
} from '../utils/renderEngine.ts';
import { loadClipSettings } from './ClipEditor.tsx';

interface Step2ClipsProps {
  videoInfo: VideoInfo;
  selectedClipIds: Set<string>;
  onToggleClipSelection: (clipId: string) => void;
  onSelectAllClips: (ids: string[]) => void;
  onOpenClipEditor: (clip: Clip) => void;
  onUpdateVideoInfo: (nextInfo: VideoInfo) => void;
  onBack: () => void;
  onProceedToRender: () => void;
  whisperConfig: WhisperConfig;
  selectedFile: File | null;
  renderedClips: RenderedClipRecord[];
  onClipRendered: (record: RenderedClipRecord) => void;
}

function getScoreStyle(score: number): { badgeClass: string; textClass: string; label: string } {
  if (score >= 80) {
    return {
      badgeClass: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
      textClass: 'text-emerald-400',
      label: 'Tinggi'
    };
  }
  if (score >= 60) {
    return {
      badgeClass: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
      textClass: 'text-amber-400',
      label: 'Sedang'
    };
  }
  return {
    badgeClass: 'bg-red-500/15 border-red-500/40 text-red-300',
    textClass: 'text-red-400',
    label: 'Rendah'
  };
}

export const Step2Clips: React.FC<Step2ClipsProps> = ({
  videoInfo,
  selectedClipIds,
  onToggleClipSelection,
  onSelectAllClips,
  onOpenClipEditor,
  onUpdateVideoInfo,
  onBack,
  onProceedToRender,
  whisperConfig,
  selectedFile,
  renderedClips,
  onClipRendered
}) => {
  const [activeCategoryFilter, setActiveCategoryFilter] = useState<string>('ALL');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [retrySource, setRetrySource] = useState<'auto' | 'whisper' | 'youtube' | 'gemini'>('gemini');
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryProgressMsg, setRetryProgressMsg] = useState('');
  const [retryError, setRetryError] = useState<string | null>(null);

  const [quickDownloadState, setQuickDownloadState] = useState<
    Record<string, { loading: boolean; progress: number; message: string; error?: string }>
  >({});

  const renderedMap = useMemo(() => {
    const m = new Map<string, RenderedClipRecord>();
    renderedClips.forEach(r => m.set(r.clipId, r));
    return m;
  }, [renderedClips]);

  const handleQuickDownloadMp4 = async (
    e: React.MouseEvent,
    clip: Clip,
    globalIndex: number
  ) => {
    e.stopPropagation();
    const existing = renderedMap.get(clip.id);
    const isFreshMp4 =
      existing &&
      existing.extension === 'mp4' &&
      (!clip.updatedAt || existing.renderedAt >= clip.updatedAt);

    if (isFreshMp4) {
      downloadRenderedRecordMp4(existing);
      return;
    }

    if (quickDownloadState[clip.id]?.loading) return;

    setQuickDownloadState(prev => ({
      ...prev,
      [clip.id]: { loading: true, progress: 5, message: 'Menyiapkan MP4 & subtitle...' }
    }));

    try {
      const settings = loadClipSettings(videoInfo.youtubeId, clip);
      const record = await renderAndSaveSingleClipMp4({
        videoInfo,
        clip,
        clipNumber: globalIndex,
        settings,
        selectedFile,
        whisperConfig,
        onProgress: (pct, msg) => {
          setQuickDownloadState(prev => ({
            ...prev,
            [clip.id]: { loading: true, progress: pct, message: msg }
          }));
        }
      });
      onClipRendered(record);
      downloadRenderedRecordMp4(record);
      setQuickDownloadState(prev => {
        const copy = { ...prev };
        delete copy[clip.id];
        return copy;
      });
    } catch (err: any) {
      setQuickDownloadState(prev => ({
        ...prev,
        [clip.id]: {
          loading: false,
          progress: 0,
          message: '',
          error: err?.message || 'Gagal merender MP4.'
        }
      }));
    }
  };

  const categoriesPresent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of videoInfo.clips) {
      counts.set(c.category, (counts.get(c.category) || 0) + 1);
    }
    return Array.from(counts.entries());
  }, [videoInfo.clips]);

  // Group clips by category, sorted by viralityScore descending within each group
  const groupedClips = useMemo(() => {
    const filtered =
      activeCategoryFilter === 'ALL'
        ? videoInfo.clips
        : videoInfo.clips.filter(c => c.category === activeCategoryFilter);

    const groups = new Map<string, { clip: Clip; globalIndex: number }[]>();
    videoInfo.clips.forEach((clip, idx) => {
      if (activeCategoryFilter !== 'ALL' && clip.category !== activeCategoryFilter) return;
      const list = groups.get(clip.category) || [];
      list.push({ clip, globalIndex: idx + 1 });
      groups.set(clip.category, list);
    });

    for (const [cat, list] of groups.entries()) {
      list.sort((a, b) => b.clip.viralityScore - a.clip.viralityScore);
      groups.set(cat, list);
    }

    // Order categories by highest clip score in each category
    return Array.from(groups.entries()).sort(
      (a, b) => (b[1][0]?.clip.viralityScore || 0) - (a[1][0]?.clip.viralityScore || 0)
    );
  }, [videoInfo.clips, activeCategoryFilter]);

  const diag = videoInfo.diagnostics;

  const handleRetryWithSource = async () => {
    setIsRetrying(true);
    setRetryError(null);
    setRetryProgressMsg('Memulai ulang analisis dengan sumber terpilih...');
    try {
      const savedKey = localStorage.getItem('clip_studio_gemini_key') || '';
      const savedSettingsRaw = localStorage.getItem('clip_studio_analyze_settings_v2');
      const savedSettings = savedSettingsRaw ? JSON.parse(savedSettingsRaw) : {};

      const startRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(savedKey.trim() ? { 'x-gemini-key': savedKey.trim() } : {})
        },
        body: JSON.stringify({
          url: videoInfo.url,
          durasi: savedSettings.durasi || 60,
          jumlah: savedSettings.jumlah || 6,
          perKategori: savedSettings.perKategori || 2,
          kategori: savedSettings.kategori || undefined,
          whisperUrl: whisperConfig.url.trim(),
          whisperToken: whisperConfig.token.trim(),
          keepSoundCues: Boolean(savedSettings.keepSoundCues),
          forceSource: retrySource,
          bypassCache: true
        })
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !startData?.jobId) {
        throw new Error(startData?.error || 'Gagal mengulang analisis.');
      }

      const jobId = String(startData.jobId);
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const pollRes = await fetch(`/api/analyze/${encodeURIComponent(jobId)}`);
        const job: AnalyzeJobStatusResponse = await pollRes.json().catch(() => ({} as any));
        if (job.message) setRetryProgressMsg(job.message);
        if (job.status === 'completed' && job.result) {
          onUpdateVideoInfo(job.result);
          setIsRetrying(false);
          return;
        }
        if (job.status === 'failed') {
          throw new Error(job.error || 'Gagal mengambil transkrip dari sumber tersebut.');
        }
      }
    } catch (err: any) {
      setRetryError(err?.message || 'Gagal mengulang analisis.');
    } finally {
      setIsRetrying(false);
    }
  };

  const allSelected = videoInfo.clips.length > 0 && videoInfo.clips.every(c => selectedClipIds.has(c.id));

  return (
    <div className="w-full max-w-5xl mx-auto space-y-4 pb-24 sm:pb-8">
      {/* Video Summary Header */}
      <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <img
            src={videoInfo.thumbnailUrl}
            alt={videoInfo.title}
            className="w-24 h-14 sm:w-28 sm:h-16 object-cover rounded-lg bg-slate-900 shrink-0 border border-slate-800"
          />
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-bold text-slate-100 line-clamp-2">{videoInfo.title}</h2>
            <p className="text-xs text-slate-400 mt-0.5 truncate">
              {videoInfo.channelTitle} · <span className="font-mono-num">{formatClockMinSec(videoInfo.duration)}</span>
            </p>
            {diag && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 text-slate-200 font-medium">
                  {diag.qualityLabel}
                </span>
                {diag.isIncomplete && (
                  <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Cakupan sebagian ({diag.speechCoveragePct}%)
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onBack}
          className="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-300 flex items-center justify-center gap-1.5 shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Ganti Video</span>
        </button>
      </div>

      {/* Collapsible Diagnostic Panel */}
      {diag && (
        <div className="bg-[#121826] border border-slate-800 rounded-2xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowDiagnostics(v => !v)}
            aria-expanded={showDiagnostics}
            className="w-full min-h-[44px] px-4 py-3 flex items-center justify-between text-xs font-semibold text-slate-200 hover:bg-slate-900/50 transition"
          >
            <span className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-sky-400" />
              <span>Panel Diagnostik Transkrip</span>
            </span>
            {showDiagnostics ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </button>

          {showDiagnostics && (
            <div className="px-4 pb-4 pt-1 border-t border-slate-800/80 space-y-3 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5">
                <div className="bg-[#0b0f17] border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400">Sumber</div>
                  <div className="font-semibold text-slate-100 mt-0.5 truncate">{diag.sourceUsed}</div>
                </div>
                <div className="bg-[#0b0f17] border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400">Bahasa</div>
                  <div className="font-semibold text-slate-100 mt-0.5 uppercase">{diag.detectedLanguage}</div>
                </div>
                <div className="bg-[#0b0f17] border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400">Jumlah Kata</div>
                  <div className="font-mono-num font-semibold text-slate-100 mt-0.5">{diag.wordCount}</div>
                </div>
                <div className="bg-[#0b0f17] border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400">Cakupan Ucapan</div>
                  <div className="font-mono-num font-semibold text-slate-100 mt-0.5">{diag.speechCoveragePct}%</div>
                </div>
                <div className="bg-[#0b0f17] border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400">Kata / Menit</div>
                  <div className="font-mono-num font-semibold text-slate-100 mt-0.5">{diag.wpm} WPM</div>
                </div>
                <div className="bg-[#0b0f17] border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400">Total Waktu</div>
                  <div className="font-mono-num font-semibold text-slate-100 mt-0.5">{diag.timingsMs.total ?? 0} ms</div>
                </div>
              </div>

              {/* Per-Stage Timings */}
              <div className="flex flex-wrap gap-3 text-[11px] text-slate-400 font-mono-num">
                {diag.timingsMs.metadata !== undefined && <span>Metadata: {diag.timingsMs.metadata} ms</span>}
                {diag.timingsMs.whisper !== undefined && <span>Whisper: {diag.timingsMs.whisper} ms</span>}
                {diag.timingsMs.captions !== undefined && <span>Caption YT: {diag.timingsMs.captions} ms</span>}
                {diag.timingsMs.geminiTranscribe !== undefined && <span>Gemini Transkrip: {diag.timingsMs.geminiTranscribe} ms</span>}
                {diag.timingsMs.clipSelection !== undefined && <span>Seleksi Klip: {diag.timingsMs.clipSelection} ms</span>}
                <span>Cache: {diag.cacheHit ? 'Hit' : 'Baru'}</span>
              </div>

              {/* Failed Tiers */}
              {diag.failedTiers.length > 0 && (
                <div className="bg-[#0b0f17] border border-slate-800 rounded-lg p-3 space-y-1.5">
                  <div className="font-semibold text-slate-300">Tingkat yang Gagal Sebelumnya:</div>
                  {diag.failedTiers.map((ft, idx) => (
                    <div key={idx} className="text-[11px] text-slate-400">
                      • <span className="text-slate-200 font-medium">{ft.tier}</span> ({ft.durationMs} ms): {ft.reason}
                    </div>
                  ))}
                </div>
              )}

              {/* Retry with another source */}
              <div className="pt-2 border-t border-slate-800 flex flex-wrap items-center gap-2.5">
                <select
                  value={retrySource}
                  onChange={e => setRetrySource(e.target.value as any)}
                  aria-label="Pilih sumber transkrip"
                  className="min-h-[40px] px-3 bg-[#0b0f17] border border-slate-700 rounded-lg text-xs text-slate-100 outline-none"
                >
                  <option value="auto">Otomatis (Rantai Lengkap)</option>
                  <option value="whisper">Server Whisper (Colab)</option>
                  <option value="youtube">Caption YouTube</option>
                  <option value="gemini">Gemini URL YouTube</option>
                </select>
                <button
                  type="button"
                  onClick={handleRetryWithSource}
                  disabled={isRetrying}
                  className="min-h-[40px] px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-100 flex items-center gap-1.5"
                >
                  {isRetrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  <span>Ulangi dengan Sumber Lain</span>
                </button>
                {isRetrying && <span className="text-slate-400">{retryProgressMsg}</span>}
                {retryError && <span className="text-red-400">{retryError}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Filter & Bulk Selection Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
          <button
            type="button"
            onClick={() => setActiveCategoryFilter('ALL')}
            className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap transition ${
              activeCategoryFilter === 'ALL'
                ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                : 'bg-[#121826] text-slate-300 border-slate-800 hover:border-slate-700'
            }`}
          >
            Semua ({videoInfo.clips.length})
          </button>
          {categoriesPresent.map(([cat, count]) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategoryFilter(cat)}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap transition ${
                activeCategoryFilter === cat
                  ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                  : 'bg-[#121826] text-slate-300 border-slate-800 hover:border-slate-700'
              }`}
            >
              {cat} ({count})
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() =>
            onSelectAllClips(allSelected ? [] : videoInfo.clips.map(c => c.id))
          }
          className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#121826] hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200 self-start sm:self-auto shrink-0"
        >
          {allSelected ? 'Batal Pilih Semua' : 'Pilih Semua'}
        </button>
      </div>

      {/* Grouped Clip Cards */}
      <div className="space-y-6">
        {groupedClips.map(([categoryName, entries]) => (
          <section key={categoryName} className="space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800/90 pb-2">
              <h3 className="text-sm font-bold text-slate-100">{categoryName}</h3>
              <span className="text-xs text-slate-400 font-mono-num">{entries.length} klip</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {entries.map(({ clip, globalIndex }) => {
                const isChecked = selectedClipIds.has(clip.id);
                const scoreMeta = getScoreStyle(clip.viralityScore);

                return (
                  <div
                    key={clip.id}
                    onClick={() => onOpenClipEditor(clip)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpenClipEditor(clip);
                      }
                    }}
                    className={`bg-[#121826] border rounded-2xl p-4 cursor-pointer transition hover:border-slate-600 flex flex-col justify-between gap-3 ${
                      isChecked ? 'border-emerald-500/50' : 'border-slate-800 opacity-75'
                    }`}
                  >
                    <div className="space-y-2.5">
                      {/* Card Header */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-2.5 min-w-0">
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              onToggleClipSelection(clip.id);
                            }}
                            aria-label={isChecked ? `Batal pilih klip ${globalIndex}` : `Pilih klip ${globalIndex}`}
                            className={`w-7 h-7 mt-0.5 rounded-lg border flex items-center justify-center shrink-0 transition ${
                              isChecked
                                ? 'bg-emerald-500 border-emerald-500 text-slate-950'
                                : 'bg-[#0b0f17] border-slate-700 text-transparent hover:border-slate-500'
                            }`}
                          >
                            <Check className="w-4 h-4 stroke-[3]" />
                          </button>

                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <span className="text-xs font-mono-num font-bold text-slate-400">
                                #{globalIndex}
                              </span>
                              <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-800 text-slate-200 border border-slate-700">
                                {clip.category}
                              </span>
                            </div>
                            <h4 className="text-sm sm:text-base font-bold text-slate-100 leading-snug">
                              {clip.hookText || clip.title}
                            </h4>
                          </div>
                        </div>

                        {/* Virality Score Badge */}
                        <div className={`px-2.5 py-1 rounded-lg border text-right shrink-0 ${scoreMeta.badgeClass}`}>
                          <div className="font-mono-num text-sm font-bold leading-none">
                            {clip.viralityScore}
                          </div>
                          <div className="text-[10px] font-medium mt-0.5">{scoreMeta.label}</div>
                        </div>
                      </div>

                      {/* Time range & duration */}
                      <div className="flex items-center gap-3 text-xs text-slate-400 font-mono-num">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-slate-500" />
                          {formatClockMinSec(clip.startTime)} – {formatClockMinSec(clip.endTime)}
                        </span>
                        <span>·</span>
                        <span>{Math.round(clip.duration)} dtk</span>
                      </div>

                      {/* 3 Short Reasons */}
                      <ul className="space-y-1 text-xs text-slate-300">
                        {(clip.reasons || []).slice(0, 3).map((reason, rIdx) => (
                          <li key={rIdx} className="flex items-start gap-1.5">
                            <span className="text-emerald-400 font-bold leading-tight">•</span>
                            <span className="leading-snug">{reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Quick MP4 Progress / Error */}
                    {quickDownloadState[clip.id]?.loading && (
                      <div
                        onClick={e => e.stopPropagation()}
                        className="bg-[#0b0f17] border border-emerald-500/40 rounded-lg p-2.5 space-y-1.5 text-[11px]"
                      >
                        <div className="flex items-center justify-between text-slate-200 font-medium">
                          <span className="truncate pr-2">{quickDownloadState[clip.id].message}</span>
                          <span className="font-mono-num text-emerald-400 shrink-0">
                            {quickDownloadState[clip.id].progress}%
                          </span>
                        </div>
                        <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-500 transition-all duration-150"
                            style={{ width: `${Math.max(4, quickDownloadState[clip.id].progress)}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {quickDownloadState[clip.id]?.error && (
                      <div
                        onClick={e => e.stopPropagation()}
                        className="bg-red-950/40 border border-red-500/40 rounded-lg p-2.5 text-[11px] text-red-200 flex items-center justify-between gap-2"
                      >
                        <span>{quickDownloadState[clip.id].error}</span>
                        <button
                          type="button"
                          onClick={() => onProceedToRender()}
                          className="px-2 py-1 rounded bg-slate-800 text-slate-100 font-semibold shrink-0"
                        >
                          Langkah 3 →
                        </button>
                      </div>
                    )}

                    {/* Footer Tap Hint & Direct MP4 Download */}
                    <div className="pt-2.5 border-t border-slate-800/80 flex items-center justify-between gap-2 text-xs">
                      <span className="text-slate-400 flex items-center gap-1.5 truncate">
                        <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">Ketuk kartu untuk edit subtitle</span>
                      </span>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={e => void handleQuickDownloadMp4(e, clip, globalIndex)}
                          disabled={Boolean(quickDownloadState[clip.id]?.loading)}
                          className="min-h-[34px] px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500 hover:text-slate-950 border border-emerald-500/40 text-emerald-300 font-bold flex items-center gap-1 transition"
                        >
                          {quickDownloadState[clip.id]?.loading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Download className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {renderedMap.get(clip.id)?.extension === 'mp4' &&
                            (!clip.updatedAt || (renderedMap.get(clip.id)?.renderedAt ?? 0) >= clip.updatedAt)
                              ? 'Unduh MP4'
                              : 'MP4'}
                          </span>
                        </button>
                        <span className="text-emerald-400 font-semibold">Edit →</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {/* Bottom Sticky CTA */}
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-[#0b0f17]/95 backdrop-blur border-t border-slate-800 px-4 py-3 sm:static sm:bg-transparent sm:border-0 sm:p-0">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="text-xs text-slate-300 font-medium tabular-nums">
            <span className="text-emerald-400 font-bold">{selectedClipIds.size}</span> dari {videoInfo.clips.length} klip dipilih
          </div>
          <button
            type="button"
            disabled={selectedClipIds.size === 0}
            onClick={onProceedToRender}
            className="min-h-[46px] px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-sm flex items-center gap-2 transition cursor-pointer disabled:cursor-not-allowed"
          >
            <span>Lanjut ke Render ({selectedClipIds.size})</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
