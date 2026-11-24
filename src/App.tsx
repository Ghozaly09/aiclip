import React, { useState, useEffect, useMemo } from 'react';
import { Film, Check } from 'lucide-react';
import {
  Clip,
  ClipSettings,
  RenderedClipRecord,
  VideoInfo,
  WhisperConfig
} from './types.ts';
import { Step1Input } from './components/Step1Input.tsx';
import { Step2Clips } from './components/Step2Clips.tsx';
import { ClipEditor } from './components/ClipEditor.tsx';
import { Step3Render } from './components/Step3Render.tsx';
import { Step4Export } from './components/Step4Export.tsx';
import { getRenderedClipsForVideo } from './utils/renderedClipDb.ts';

type StepNumber = 1 | 2 | 3 | 4;

const STEP_LABELS: { step: StepNumber; label: string }[] = [
  { step: 1, label: '1. Link' },
  { step: 2, label: '2. Klip Pilihan' },
  { step: 3, label: '3. Render' },
  { step: 4, label: '4. Hasil & Ekspor' }
];

function loadSavedWhisperConfig(): WhisperConfig {
  try {
    return {
      url: localStorage.getItem('clip_studio_whisper_url') || '',
      token: localStorage.getItem('clip_studio_whisper_token') || ''
    };
  } catch {
    return { url: '', token: '' };
  }
}

export function App() {
  const [step, setStep] = useState<StepNumber>(1);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set());
  const [activeEditClipId, setActiveEditClipId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [renderedClips, setRenderedClips] = useState<RenderedClipRecord[]>([]);
  const [singleReRenderClipId, setSingleReRenderClipId] = useState<string | null>(null);

  const [whisperConfig, setWhisperConfig] = useState<WhisperConfig>(loadSavedWhisperConfig);

  const handleUpdateWhisperConfig = (cfg: WhisperConfig) => {
    setWhisperConfig(cfg);
    try {
      localStorage.setItem('clip_studio_whisper_url', cfg.url);
      localStorage.setItem('clip_studio_whisper_token', cfg.token);
    } catch {
      // ignore storage errors
    }
  };

  // Load persisted rendered clips from IndexedDB whenever videoInfo changes
  useEffect(() => {
    if (!videoInfo?.youtubeId) {
      setRenderedClips([]);
      return;
    }
    let cancelled = false;
    getRenderedClipsForVideo(videoInfo.youtubeId).then(records => {
      if (!cancelled) setRenderedClips(records);
    });
    return () => {
      cancelled = true;
    };
  }, [videoInfo?.youtubeId]);

  const applySavedClipEdits = (info: VideoInfo): VideoInfo => {
    try {
      const raw = localStorage.getItem(`clip_studio_edited_clips_${info.youtubeId}`);
      if (!raw) return info;
      const savedMap = JSON.parse(raw) as Record<string, Partial<Clip>>;
      return {
        ...info,
        clips: info.clips.map(c => (savedMap[c.id] ? { ...c, ...savedMap[c.id] } : c))
      };
    } catch {
      return info;
    }
  };

  const persistClipEdits = (youtubeId: string, clips: Clip[]) => {
    try {
      const map: Record<string, Partial<Clip>> = {};
      for (const c of clips) {
        map[c.id] = {
          startTime: c.startTime,
          endTime: c.endTime,
          duration: c.duration,
          words: c.words,
          lines: c.lines,
          baseWords: c.baseWords,
          customLinesEdited: c.customLinesEdited,
          updatedAt: c.updatedAt
        };
      }
      localStorage.setItem(`clip_studio_edited_clips_${youtubeId}`, JSON.stringify(map));
    } catch {
      // ignore storage quota errors
    }
  };

  const handleAnalysisSuccess = (rawInfo: VideoInfo) => {
    const hydrated = applySavedClipEdits(rawInfo);
    setVideoInfo(hydrated);
    setSelectedClipIds(new Set(hydrated.clips.map(c => c.id)));
    setActiveEditClipId(null);
    setSelectedFile(null);
    setSingleReRenderClipId(null);
    setStep(2);
  };

  const handleUpdateVideoInfo = (nextInfo: VideoInfo) => {
    setVideoInfo(nextInfo);
    setSelectedClipIds(new Set(nextInfo.clips.map(c => c.id)));
    setActiveEditClipId(null);
  };

  const handleToggleClipSelection = (clipId: string) => {
    setSelectedClipIds(prev => {
      const next = new Set(prev);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return next;
    });
  };

  const handleSelectAllClips = (ids: string[]) => {
    setSelectedClipIds(new Set(ids));
  };

  const handleUpdateClip = (updatedClip: Clip) => {
    const stampedClip: Clip = { ...updatedClip, updatedAt: Date.now() };
    setVideoInfo(prev => {
      if (!prev) return null;
      const nextClips = prev.clips.map(c => (c.id === stampedClip.id ? stampedClip : c));
      persistClipEdits(prev.youtubeId, nextClips);
      return { ...prev, clips: nextClips };
    });
  };

  const handleApplyStyleToAll = (settings: ClipSettings) => {
    if (!videoInfo) return;
    const now = Date.now();
    for (const c of videoInfo.clips) {
      const key = `clip_studio_settings_${videoInfo.youtubeId}_${c.id}`;
      let perClipTitle = c.hookText || c.title;
      const existingRaw = localStorage.getItem(key);
      if (existingRaw) {
        try {
          const parsed = JSON.parse(existingRaw);
          if (parsed?.title?.text) perClipTitle = parsed.title.text;
        } catch {
          // ignore
        }
      }
      localStorage.setItem(
        key,
        JSON.stringify({
          ...settings,
          title: { ...settings.title, text: perClipTitle }
        })
      );
    }
    setVideoInfo(prev => {
      if (!prev) return null;
      const nextClips = prev.clips.map(c => ({ ...c, updatedAt: now }));
      persistClipEdits(prev.youtubeId, nextClips);
      return { ...prev, clips: nextClips };
    });
  };

  const handleClipRendered = (record: RenderedClipRecord) => {
    setRenderedClips(prev => {
      const filtered = prev.filter(r => r.clipId !== record.clipId);
      return [...filtered, record].sort((a, b) => a.clipNumber - b.clipNumber);
    });
  };

  const activeEditClip = useMemo(() => {
    if (!videoInfo || !activeEditClipId) return null;
    return videoInfo.clips.find(c => c.id === activeEditClipId) || null;
  }, [videoInfo, activeEditClipId]);

  const selectedClipsList = useMemo(() => {
    if (!videoInfo) return [];
    return videoInfo.clips.filter(c => selectedClipIds.has(c.id));
  }, [videoInfo, selectedClipIds]);

  const renderedClipIds = useMemo(
    () => new Set(renderedClips.map(r => r.clipId)),
    [renderedClips]
  );

  const canVisitStep = (target: StepNumber): boolean => {
    if (target === 1) return true;
    if (!videoInfo) return false;
    if (target === 2) return true;
    if (target === 3) return selectedClipIds.size > 0;
    if (target === 4) return renderedClips.length > 0;
    return false;
  };

  return (
    <div className="min-h-screen bg-[#0b0f17] text-slate-100 flex flex-col">
      {/* Compact Studio Top Bar */}
      <header className="sticky top-0 z-40 bg-[#0b0f17]/95 backdrop-blur border-b border-slate-800/90">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setActiveEditClipId(null);
              setStep(1);
            }}
            className="flex items-center gap-2.5 text-left"
          >
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center text-slate-950 shrink-0">
              <Film className="w-4 h-4 stroke-[2.4]" />
            </div>
            <span className="font-bold text-sm sm:text-base tracking-tight text-slate-100">
              Clip Studio AI
            </span>
          </button>

          {videoInfo && (
            <div className="text-xs text-slate-400 truncate max-w-[180px] sm:max-w-md">
              {videoInfo.title}
            </div>
          )}
        </div>

        {/* 4-Step Stepper */}
        <nav
          aria-label="Langkah alur kerja"
          className="max-w-6xl mx-auto px-4 sm:px-6 pb-2.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar"
        >
          {STEP_LABELS.map(item => {
            const unlocked = canVisitStep(item.step);
            const active = step === item.step;
            const completed =
              (item.step === 1 && Boolean(videoInfo)) ||
              (item.step === 2 && Boolean(videoInfo) && step > 2) ||
              (item.step === 3 && renderedClips.length > 0 && step > 3);

            return (
              <button
                key={item.step}
                type="button"
                disabled={!unlocked}
                onClick={() => {
                  setActiveEditClipId(null);
                  setSingleReRenderClipId(null);
                  setStep(item.step);
                }}
                className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap flex items-center gap-1.5 border transition ${
                  active
                    ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                    : unlocked
                    ? 'bg-[#121826] text-slate-200 border-slate-800 hover:border-slate-700'
                    : 'bg-transparent text-slate-600 border-slate-800/50 cursor-not-allowed'
                }`}
              >
                {completed && !active && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full px-4 sm:px-6 py-5 sm:py-6">
        {step === 1 && (
          <Step1Input
            onSuccess={handleAnalysisSuccess}
            whisperConfig={whisperConfig}
            onUpdateWhisperConfig={handleUpdateWhisperConfig}
          />
        )}

        {step === 2 && videoInfo && !activeEditClip && (
          <Step2Clips
            videoInfo={videoInfo}
            selectedClipIds={selectedClipIds}
            onToggleClipSelection={handleToggleClipSelection}
            onSelectAllClips={handleSelectAllClips}
            onOpenClipEditor={clip => setActiveEditClipId(clip.id)}
            onUpdateVideoInfo={handleUpdateVideoInfo}
            onBack={() => setStep(1)}
            onProceedToRender={() => {
              setSingleReRenderClipId(null);
              setStep(3);
            }}
            whisperConfig={whisperConfig}
            selectedFile={selectedFile}
            renderedClips={renderedClips}
            onClipRendered={handleClipRendered}
          />
        )}

        {step === 2 && videoInfo && activeEditClip && (
          <ClipEditor
            clip={activeEditClip}
            clipNumber={(videoInfo.clips.findIndex(c => c.id === activeEditClip.id) + 1) || 1}
            videoInfo={videoInfo}
            youtubeId={videoInfo.youtubeId}
            selectedFile={selectedFile}
            whisperConfig={whisperConfig}
            existingRendered={renderedClips.find(r => r.clipId === activeEditClip.id)}
            onClipRendered={handleClipRendered}
            onUpdateClip={handleUpdateClip}
            onApplyStyleToAll={handleApplyStyleToAll}
            onBack={() => setActiveEditClipId(null)}
            onProceedToRender={() => {
              setSelectedClipIds(prev => new Set(prev).add(activeEditClip.id));
              setActiveEditClipId(null);
              setSingleReRenderClipId(null);
              setStep(3);
            }}
          />
        )}

        {step === 3 && videoInfo && (
          <Step3Render
            videoInfo={videoInfo}
            selectedClips={selectedClipsList}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
            whisperConfig={whisperConfig}
            onUpdateWhisperConfig={handleUpdateWhisperConfig}
            renderedClips={renderedClips}
            renderedClipIds={renderedClipIds}
            onClipRendered={handleClipRendered}
            onBack={() => {
              setSingleReRenderClipId(null);
              setStep(2);
            }}
            onProceedToExport={() => {
              setSingleReRenderClipId(null);
              setStep(4);
            }}
            singleReRenderClipId={singleReRenderClipId}
            onClearSingleReRender={() => setSingleReRenderClipId(null)}
          />
        )}

        {step === 4 && videoInfo && (
          <Step4Export
            videoInfo={videoInfo}
            renderedClips={renderedClips}
            onReRenderClip={clipId => {
              setSingleReRenderClipId(clipId);
              setStep(3);
            }}
            onBackToRender={() => {
              setSingleReRenderClipId(null);
              setStep(3);
            }}
          />
        )}
      </main>
    </div>
  );
}

export default App;
