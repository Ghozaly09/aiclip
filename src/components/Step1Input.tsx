import React, { useState, useEffect, useRef } from 'react';
import {
  Youtube,
  SlidersHorizontal,
  Sparkles,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  Server,
  ChevronDown,
  ChevronUp,
  FileText,
  CheckCircle2,
  XCircle
} from 'lucide-react';
import {
  AnalyzeJobStatusResponse,
  AppAnalyzeSettings,
  CLIP_CATEGORIES,
  ClipCategory,
  VideoInfo,
  WhisperConfig
} from '../types.ts';
import {
  detectPastedTranscriptKind,
  parseSubtitleFile,
  splitPlainTextProportionally
} from '../utils/subtitleParser.ts';

interface Step1InputProps {
  onSuccess: (videoInfo: VideoInfo) => void;
  whisperConfig: WhisperConfig;
  onUpdateWhisperConfig: (cfg: WhisperConfig) => void;
}

const DEFAULT_SETTINGS: AppAnalyzeSettings = {
  durasi: 60,
  jumlah: 6,
  perKategori: 2,
  kategori: [...CLIP_CATEGORIES],
  keepSoundCues: false
};

function loadSavedAnalyzeSettings(): AppAnalyzeSettings {
  try {
    const raw = localStorage.getItem('clip_studio_analyze_settings_v2');
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const validCats = Array.isArray(parsed.kategori)
      ? parsed.kategori.filter((k: any): k is ClipCategory => CLIP_CATEGORIES.includes(k))
      : DEFAULT_SETTINGS.kategori;
    return {
      durasi: Math.max(10, Math.min(180, Number(parsed.durasi) || 60)),
      jumlah: Math.max(1, Math.min(20, Number(parsed.jumlah) || 6)),
      perKategori: Math.max(1, Math.min(20, Number(parsed.perKategori) || 2)),
      kategori: validCats.length > 0 ? validCats : [...CLIP_CATEGORIES],
      keepSoundCues: Boolean(parsed.keepSoundCues)
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const Step1Input: React.FC<Step1InputProps> = ({
  onSuccess,
  whisperConfig,
  onUpdateWhisperConfig
}) => {
  const [url, setUrl] = useState(() => localStorage.getItem('clip_studio_last_url') || '');
  const [geminiKey, setGeminiKey] = useState(() => localStorage.getItem('clip_studio_gemini_key') || '');
  const [showGeminiKey, setShowGeminiKey] = useState(false);

  const [settings, setSettings] = useState<AppAnalyzeSettings>(loadSavedAnalyzeSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showManualBox, setShowManualBox] = useState(false);
  const [manualText, setManualText] = useState('');

  // Whisper health test state
  const [testingWhisper, setTestingWhisper] = useState(false);
  const [whisperStatus, setWhisperStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  // Async analysis polling state
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    localStorage.setItem('clip_studio_last_url', url);
  }, [url]);

  useEffect(() => {
    localStorage.setItem('clip_studio_gemini_key', geminiKey);
  }, [geminiKey]);

  useEffect(() => {
    localStorage.setItem('clip_studio_analyze_settings_v2', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const toggleCategory = (cat: ClipCategory) => {
    setSettings(prev => {
      const exists = prev.kategori.includes(cat);
      if (exists && prev.kategori.length === 1) {
        return prev; // Always keep at least 1 category active
      }
      const nextCats = exists
        ? prev.kategori.filter(c => c !== cat)
        : [...prev.kategori, cat];
      return { ...prev, kategori: nextCats };
    });
  };

  const handleTestWhisper = async () => {
    const cleanUrl = whisperConfig.url.trim();
    if (!cleanUrl) {
      setWhisperStatus({ ok: false, msg: 'Masukkan URL server Whisper terlebih dahulu.' });
      return;
    }
    setTestingWhisper(true);
    setWhisperStatus(null);
    try {
      const res = await fetch('/api/whisper/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          whisperUrl: cleanUrl,
          whisperToken: whisperConfig.token.trim()
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setWhisperStatus({
          ok: false,
          msg: data?.error || 'Koneksi ke server Whisper gagal.'
        });
      } else {
        setWhisperStatus({
          ok: true,
          msg: 'Terhubung! Server Whisper Colab siap dipakai.'
        });
      }
    } catch {
      setWhisperStatus({
        ok: false,
        msg: 'Tidak dapat menghubungi endpoint pengecekan server.'
      });
    } finally {
      setTestingWhisper(false);
    }
  };

  const handleUploadSrtFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setManualText(text);
      setShowManualBox(true);
      setError(null);
    } catch {
      setError('Gagal membaca berkas subtitle.');
    }
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const handleAnalyze = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError(null);

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError('Tempel link video YouTube terlebih dahulu.');
      return;
    }

    let manualCues: { start: number; end: number; text: string }[] | undefined;
    let manualSourceTier: 'manual_paste_srt' | 'manual_paste_plain' | undefined;

    if (manualText.trim()) {
      const kind = detectPastedTranscriptKind(manualText);
      if (kind === 'timestamped') {
        const parsed = parseSubtitleFile(manualText, settings.keepSoundCues);
        if (parsed.length === 0) {
          setError('Format SRT/transkrip bertimestamp tidak dapat dibaca.');
          return;
        }
        manualCues = parsed.map(c => ({ start: c.start, end: c.end, text: c.text }));
        manualSourceTier = 'manual_paste_srt';
      } else if (kind === 'plain') {
        const plainCues = splitPlainTextProportionally(manualText, 180, settings.keepSoundCues);
        if (plainCues.length === 0) {
          setError('Teks transkrip kosong atau tidak valid.');
          return;
        }
        manualCues = plainCues.map(c => ({ start: c.start, end: c.end, text: c.text }));
        manualSourceTier = 'manual_paste_plain';
      }
    }

    stopPolling();
    setIsLoading(true);
    setProgress(4);
    setStatusMessage('Mengirim permintaan analisis video...');

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (geminiKey.trim()) {
        headers['x-gemini-key'] = geminiKey.trim();
      }

      const startRes = await fetch('/api/analyze', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url: trimmedUrl,
          durasi: settings.durasi,
          jumlah: settings.jumlah,
          perKategori: settings.perKategori,
          kategori: settings.kategori,
          whisperUrl: whisperConfig.url.trim(),
          whisperToken: whisperConfig.token.trim(),
          keepSoundCues: settings.keepSoundCues,
          ...(manualCues ? { manualCues, manualSourceTier } : {})
        })
      });

      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !startData?.jobId) {
        throw new Error(startData?.error || 'Gagal memulai analisis video.');
      }

      const jobId = String(startData.jobId);

      const pollOnce = async () => {
        try {
          const pollRes = await fetch(`/api/analyze/${encodeURIComponent(jobId)}`);
          const job: AnalyzeJobStatusResponse = await pollRes.json().catch(() => ({} as any));

          if (!pollRes.ok) {
            throw new Error((job as any)?.error || `Gagal memantau proses (HTTP ${pollRes.status}).`);
          }

          if (typeof job.progress === 'number') setProgress(job.progress);
          if (job.message) setStatusMessage(job.message);

          if (job.status === 'completed' && job.result) {
            stopPolling();
            setIsLoading(false);
            onSuccess(job.result);
          } else if (job.status === 'failed') {
            stopPolling();
            setIsLoading(false);
            setError(job.error || 'Analisis video gagal.');
            setShowManualBox(true);
          }
        } catch (pollErr: any) {
          stopPolling();
          setIsLoading(false);
          setError(pollErr?.message || 'Koneksi terputus saat memantau progres analisis.');
        }
      };

      await pollOnce();
      pollTimerRef.current = setInterval(pollOnce, 2000);
    } catch (err: any) {
      stopPolling();
      setIsLoading(false);
      setError(err?.message || 'Terjadi kesalahan saat memulai analisis.');
    }
  };

  const manualKind = detectPastedTranscriptKind(manualText);

  return (
    <div className="w-full max-w-3xl mx-auto space-y-4">
      <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl">
        <div className="mb-5">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-100 tracking-tight">
            Potong Video YouTube Jadi Klip Siap Tayang
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Tempel tautan YouTube publik. AI akan memilih momen terbaik per kategori dengan subtitle per kata yang presisi.
          </p>
        </div>

        <form onSubmit={handleAnalyze} className="space-y-4">
          {/* YouTube URL Input */}
          <div>
            <label htmlFor="yt-url-input" className="block text-xs font-semibold text-slate-300 mb-1.5">
              Tautan Video YouTube
            </label>
            <div className="relative">
              <Youtube className="w-5 h-5 text-red-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="yt-url-input"
                type="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=... atau https://youtu.be/..."
                disabled={isLoading}
                className="w-full min-h-[48px] pl-11 pr-4 py-3 bg-[#0b0f17] border border-slate-700/80 focus:border-emerald-500 rounded-xl text-sm text-slate-100 placeholder:text-slate-500 outline-none transition"
              />
            </div>
          </div>

          {/* Primary CTA */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full min-h-[50px] px-5 py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-500/50 text-slate-950 font-bold text-base flex items-center justify-center gap-2 transition cursor-pointer disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Menganalisis Video...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                <span>Analisis Video</span>
              </>
            )}
          </button>

          {/* Progress Bar while Polling */}
          {isLoading && (
            <div className="bg-[#0b0f17] border border-slate-800 rounded-xl p-3.5 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-200 font-medium">{statusMessage || 'Memproses...'}</span>
                <span className="font-mono-num text-emerald-400 font-semibold">{progress}%</span>
              </div>
              <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
                />
              </div>
            </div>
          )}

          {/* Error Banner */}
          {error && (
            <div className="bg-red-950/50 border border-red-500/40 rounded-xl p-3.5 flex items-start gap-2.5 text-sm text-red-200">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div className="space-y-1 whitespace-pre-line text-xs sm:text-sm leading-relaxed">
                {error}
              </div>
            </div>
          )}
        </form>

        {/* Collapsible Pengaturan Panel */}
        <div className="mt-5 pt-4 border-t border-slate-800/90">
          <button
            type="button"
            onClick={() => setShowSettings(prev => !prev)}
            aria-expanded={showSettings}
            className="w-full min-h-[44px] flex items-center justify-between px-3 py-2 rounded-xl bg-slate-900/70 hover:bg-slate-800/80 border border-slate-800 text-sm font-semibold text-slate-200 transition"
          >
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-emerald-400" />
              <span>Pengaturan</span>
              <span className="text-xs font-normal text-slate-400 tabular-nums">
                ({settings.durasi} dtk · {settings.jumlah} klip · {settings.kategori.length} kategori)
              </span>
            </span>
            {showSettings ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </button>

          {showSettings && (
            <div className="mt-3 space-y-5 bg-[#0b0f17] border border-slate-800 rounded-xl p-4">
              {/* API Key Gemini */}
              <div>
                <label htmlFor="gemini-key-input" className="block text-xs font-semibold text-slate-300 mb-1.5">
                  API Key Gemini
                </label>
                <div className="relative flex items-center">
                  <input
                    id="gemini-key-input"
                    type={showGeminiKey ? 'text' : 'password'}
                    value={geminiKey}
                    onChange={e => setGeminiKey(e.target.value)}
                    placeholder="AIza... (kosongkan jika sudah diset di server)"
                    autoComplete="off"
                    className="w-full min-h-[44px] pl-3.5 pr-12 py-2 bg-[#121826] border border-slate-700 focus:border-emerald-500 rounded-lg text-sm text-slate-100 placeholder:text-slate-500 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowGeminiKey(v => !v)}
                    aria-label={showGeminiKey ? 'Sembunyikan API Key' : 'Tampilkan API Key'}
                    className="absolute right-1 w-10 h-10 flex items-center justify-center text-slate-400 hover:text-slate-200"
                  >
                    {showGeminiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  Disimpan lokal di browser Anda dan dikirim lewat header aman saat analisis.
                </p>
              </div>

              {/* Kategori Klip */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-slate-300">Kategori Klip</span>
                  <button
                    type="button"
                    onClick={() => setSettings(prev => ({ ...prev, kategori: [...CLIP_CATEGORIES] }))}
                    className="text-xs text-emerald-400 hover:text-emerald-300 font-medium"
                  >
                    Pilih Semua
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {CLIP_CATEGORIES.map(cat => {
                    const active = settings.kategori.includes(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => toggleCategory(cat)}
                        className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                          active
                            ? 'bg-emerald-500/15 border-emerald-500 text-emerald-300'
                            : 'bg-[#121826] border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}
                      >
                        {cat}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Durasi Klip */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-2">
                  Durasi Klip Target (detik)
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {[15, 30, 60].map(preset => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setSettings(prev => ({ ...prev, durasi: preset }))}
                      className={`min-h-[44px] rounded-lg text-xs font-bold border tabular-nums transition ${
                        settings.durasi === preset
                          ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                          : 'bg-[#121826] text-slate-300 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      {preset} dtk
                    </button>
                  ))}
                  <input
                    type="number"
                    min={10}
                    max={180}
                    value={settings.durasi}
                    onChange={e =>
                      setSettings(prev => ({
                        ...prev,
                        durasi: Math.max(10, Math.min(180, Number(e.target.value) || 60))
                      }))
                    }
                    aria-label="Durasi klip kustom (10-180 detik)"
                    className="min-h-[44px] px-3 bg-[#121826] border border-slate-700 focus:border-emerald-500 rounded-lg text-xs font-mono-num text-slate-100 text-center outline-none"
                  />
                </div>
                <p className="text-[11px] text-slate-500 mt-1">Rentang bebas 10–180 detik (default 60 detik).</p>
              </div>

              {/* Jumlah Klip & Maks per Kategori */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="jumlah-klip-input" className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Total Klip Diinginkan (1–20)
                  </label>
                  <input
                    id="jumlah-klip-input"
                    type="number"
                    min={1}
                    max={20}
                    value={settings.jumlah}
                    onChange={e =>
                      setSettings(prev => ({
                        ...prev,
                        jumlah: Math.max(1, Math.min(20, Number(e.target.value) || 6))
                      }))
                    }
                    className="w-full min-h-[44px] px-3 bg-[#121826] border border-slate-700 focus:border-emerald-500 rounded-lg text-sm font-mono-num text-slate-100 outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="per-kat-input" className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Maksimal Klip per Kategori
                  </label>
                  <input
                    id="per-kat-input"
                    type="number"
                    min={1}
                    max={20}
                    value={settings.perKategori}
                    onChange={e =>
                      setSettings(prev => ({
                        ...prev,
                        perKategori: Math.max(1, Math.min(20, Number(e.target.value) || 2))
                      }))
                    }
                    className="w-full min-h-[44px] px-3 bg-[#121826] border border-slate-700 focus:border-emerald-500 rounded-lg text-sm font-mono-num text-slate-100 outline-none"
                  />
                </div>
              </div>

              {/* Optional Whisper Colab Server */}
              <div className="pt-3 border-t border-slate-800 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                  <Server className="w-4 h-4 text-sky-400" />
                  <span>Server Whisper Colab (Opsional)</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <input
                    type="url"
                    value={whisperConfig.url}
                    onChange={e => onUpdateWhisperConfig({ ...whisperConfig, url: e.target.value })}
                    placeholder="https://xxxx.ngrok-free.app"
                    className="w-full min-h-[44px] px-3 bg-[#121826] border border-slate-700 focus:border-sky-500 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                  />
                  <input
                    type="password"
                    value={whisperConfig.token}
                    onChange={e => onUpdateWhisperConfig({ ...whisperConfig, token: e.target.value })}
                    placeholder="Token x-token (opsional)"
                    autoComplete="off"
                    className="w-full min-h-[44px] px-3 bg-[#121826] border border-slate-700 focus:border-sky-500 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleTestWhisper}
                    disabled={testingWhisper}
                    className="min-h-[40px] px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-100 border border-slate-700 flex items-center gap-2 transition"
                  >
                    {testingWhisper && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>Tes Koneksi</span>
                  </button>
                  {whisperStatus && (
                    <span
                      className={`text-xs flex items-center gap-1.5 ${
                        whisperStatus.ok ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {whisperStatus.ok ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                      <span>{whisperStatus.msg}</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Filter Musik / Efek */}
              <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={settings.keepSoundCues}
                  onChange={e => setSettings(prev => ({ ...prev, keepSoundCues: e.target.checked }))}
                  className="w-4 h-4 accent-emerald-500 rounded"
                />
                <span>Sertakan penanda non-ucapan seperti [Musik] / [Tepuk tangan]</span>
              </label>
            </div>
          )}
        </div>

        {/* Tier 5 Manual Fallback Box */}
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowManualBox(prev => !prev)}
            className="text-xs font-medium text-slate-400 hover:text-slate-200 flex items-center gap-1.5 py-2"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>{showManualBox ? 'Sembunyikan' : 'Cadangan:'} Tempel SRT atau transkrip bertimestamp</span>
          </button>

          {showManualBox && (
            <div className="bg-[#0b0f17] border border-slate-800 rounded-xl p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-300">
                  Tempel SRT, VTT, atau Transkrip
                </span>
                <label className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 cursor-pointer">
                  Pilih Berkas .SRT/.TXT
                  <input
                    type="file"
                    accept=".srt,.vtt,.sbv,.txt"
                    onChange={handleUploadSrtFile}
                    className="hidden"
                  />
                </label>
              </div>
              <textarea
                rows={5}
                value={manualText}
                onChange={e => setManualText(e.target.value)}
                placeholder="Tempel isi file .SRT atau teks transkrip bertimestamp di sini..."
                className="w-full p-3 bg-[#121826] border border-slate-700 focus:border-emerald-500 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 font-mono outline-none"
              />
              {manualText.trim() && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className={manualKind === 'plain' ? 'text-amber-400' : 'text-emerald-400'}>
                    {manualKind === 'plain'
                      ? 'Terdeteksi teks polos tanpa timestamp — label kualitas akan ditandai "Perkiraan".'
                      : 'Terdeteksi format SRT/bertimestamp.'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setManualText('')}
                    className="text-slate-400 hover:text-slate-200"
                  >
                    Kosongkan
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
