import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Maximize2,
  Type,
  Subtitles,
  Copy,
  Check,
  ChevronDown,
  Play,
  Pause,
  Upload,
  Gauge,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Sliders,
  Trash2,
  GitMerge,
  Scissors,
  X,
  Download,
  Loader2
} from 'lucide-react';
import {
  Clip,
  ClipSettings,
  CaptionPreset,
  CaptionFont,
  RenderedClipRecord,
  SubtitleWord,
  SubtitleLine,
  VideoInfo,
  WhisperConfig
} from '../types.ts';
import {
  parseSubtitleFile,
  cuesToWordsAndLines,
  getActiveCaptionChunk,
  groupWordsIntoChunks,
  splitDisplayWordsIntoRows,
  moveCueLineByDelta,
  sanitizeMonotonicWords,
  formatClockMinSec,
  getSavedCaptionLeadSec,
  saveCaptionLeadSec,
  DEFAULT_CAPTION_LEAD_SEC
} from '../utils/subtitleParser.ts';
import { getKeywordEmoji } from '../utils/emoji.ts';
import {
  downloadRenderedRecordMp4,
  renderAndSaveSingleClipMp4
} from '../utils/renderEngine.ts';

interface ClipEditorProps {
  clip: Clip;
  clipNumber?: number;
  videoInfo: VideoInfo;
  youtubeId: string;
  selectedFile?: File | null;
  whisperConfig?: WhisperConfig;
  existingRendered?: RenderedClipRecord;
  onClipRendered?: (record: RenderedClipRecord) => void;
  onUpdateClip: (updatedClip: Clip) => void;
  onApplyStyleToAll: (settings: ClipSettings) => void;
  onBack: () => void;
  onProceedToRender: () => void;
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export const defaultClipSettings: ClipSettings = {
  canvas: {
    aspectRatio: '9:16',
    fitMode: 'cover',
    horizontalPanPercent: 50,
    backgroundMode: 'blur',
    backgroundColor: '#0a0a0c',
    resolution: '720p'
  },
  title: {
    text: '',
    enabled: true,
    position: 'top',
    size: 48,
    textColor: '#FFFFFF',
    strokeColor: '#000000',
    backgroundBox: true,
    boxColor: '#000000',
    durationMode: 'first_seconds',
    displaySeconds: 4
  },
  caption: {
    preset: 'mrbeast',
    fontFamily: 'Montserrat',
    wordsPerLine: 4,
    size: 56,
    positionPercent: 76,
    horizontalAlign: 'center',
    textColor: '#FFFFFF',
    activeWordColor: '#FACC15',
    strokeColor: '#000000',
    uppercase: true,
    autoEmoji: true,
    popAnimation: true
  }
};

export function loadClipSettings(youtubeId: string, clip: Clip): ClipSettings {
  const key = `clip_studio_settings_${youtubeId}_${clip.id}`;
  const globalKey = `clip_studio_global_settings_${youtubeId}`;
  const saved = localStorage.getItem(key) || localStorage.getItem(globalKey);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return {
        canvas: { ...defaultClipSettings.canvas, ...parsed.canvas },
        title: {
          ...defaultClipSettings.title,
          ...parsed.title,
          text: parsed.title?.text || clip.hookText || clip.title
        },
        caption: { ...defaultClipSettings.caption, ...parsed.caption }
      };
    } catch {
      // ignore invalid saved json
    }
  }
  return {
    ...defaultClipSettings,
    title: {
      ...defaultClipSettings.title,
      text: clip.hookText || clip.title
    }
  };
}

export const ClipEditor: React.FC<ClipEditorProps> = ({
  clip,
  clipNumber = 1,
  videoInfo,
  youtubeId,
  selectedFile,
  whisperConfig,
  existingRendered,
  onClipRendered,
  onUpdateClip,
  onApplyStyleToAll,
  onBack,
  onProceedToRender
}) => {
  const [activeTab, setActiveTab] = useState<'caption' | 'canvas' | 'title' | 'text'>('caption');
  const [showAdvancedCaption, setShowAdvancedCaption] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  const [directDownloading, setDirectDownloading] = useState(false);
  const [directProgress, setDirectProgress] = useState(0);
  const [directStatus, setDirectStatus] = useState('');
  const [directError, setDirectError] = useState<string | null>(null);
  const directAbortRef = useRef<AbortController | null>(null);

  const [settings, setSettings] = useState<ClipSettings>(() => loadClipSettings(youtubeId, clip));

  useEffect(() => {
    setSettings(loadClipSettings(youtubeId, clip));
  }, [clip.id, youtubeId]);

  useEffect(() => {
    const key = `clip_studio_settings_${youtubeId}_${clip.id}`;
    localStorage.setItem(key, JSON.stringify(settings));
  }, [settings, youtubeId, clip.id]);

  // Smooth YouTube IFrame playback clock
  const [currentTime, setCurrentTime] = useState<number>(clip.startTime);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);

  const [captionLeadSec, setCaptionLeadSec] = useState<number>(() => getSavedCaptionLeadSec(youtubeId));
  useEffect(() => {
    setCaptionLeadSec(getSavedCaptionLeadSec(youtubeId));
  }, [youtubeId]);

  const handleChangeCaptionLead = (nextLead: number) => {
    const saved = saveCaptionLeadSec(youtubeId, nextLead);
    setCaptionLeadSec(saved);
  };

  const [syncCalibActive, setSyncCalibActive] = useState(false);
  const syncCalibStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [editingLineIdx, setEditingLineIdx] = useState<number | null>(null);
  const [editingLineDraft, setEditingLineDraft] = useState<string>('');
  const [textFeedback, setTextFeedback] = useState<string | null>(null);
  const subtitleFileInputRef = useRef<HTMLInputElement>(null);

  const playerRef = useRef<any>(null);
  const rafIdRef = useRef<number | null>(null);
  const pollIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clipStartRef = useRef<number>(clip.startTime);
  const clipEndRef = useRef<number>(clip.endTime);
  clipStartRef.current = clip.startTime;
  clipEndRef.current = clip.endTime;

  const lastRawYtTimeRef = useRef<number | null>(null);
  const clockAnchorTimeRef = useRef<number>(clip.startTime);
  const clockAnchorPerfRef = useRef<number>(typeof performance !== 'undefined' ? performance.now() : 0);
  const clockPlaybackRateRef = useRef<number>(1);
  const clockFrozenRef = useRef<boolean>(false);

  // Sync clock when clip switches
  useEffect(() => {
    clockAnchorTimeRef.current = clip.startTime;
    clockAnchorPerfRef.current = performance.now();
    lastRawYtTimeRef.current = null;
    setCurrentTime(clip.startTime);
    setEditingLineIdx(null);
    setTextFeedback(null);
    if (playerRef.current && typeof playerRef.current.seekTo === 'function') {
      try {
        playerRef.current.seekTo(clip.startTime, true);
      } catch {
        // ignore
      }
    }
  }, [clip.id]);

  // YouTube IFrame Player API initialization + 100ms poll + rAF interpolation
  useEffect(() => {
    let isCancelled = false;

    const initPlayer = () => {
      if (isCancelled || !window.YT || !window.YT.Player) return;
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          // ignore
        }
      }

      playerRef.current = new window.YT.Player('yt-player-container', {
        videoId: youtubeId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          start: Math.floor(clipStartRef.current),
          playsinline: 1,
          mute: 0
        },
        events: {
          onReady: (event: any) => {
            if (isCancelled) return;
            try {
              clockAnchorTimeRef.current = clipStartRef.current;
              clockAnchorPerfRef.current = performance.now();
              clockPlaybackRateRef.current = event.target.getPlaybackRate?.() || 1;
              clockFrozenRef.current = false;
              lastRawYtTimeRef.current = null;
              event.target.seekTo(clipStartRef.current, true);
              event.target.playVideo();
              setIsPlaying(true);
            } catch {
              // ignore
            }
          },
          onPlaybackRateChange: (event: any) => {
            try {
              const rate = Number(event?.data);
              if (Number.isFinite(rate) && rate > 0) {
                const now = performance.now();
                const currentAnchor = clockFrozenRef.current
                  ? clockAnchorTimeRef.current
                  : clockAnchorTimeRef.current + ((now - clockAnchorPerfRef.current) * clockPlaybackRateRef.current) / 1000;
                clockAnchorTimeRef.current = currentAnchor;
                clockAnchorPerfRef.current = now;
                clockPlaybackRateRef.current = rate;
              }
            } catch {
              // ignore
            }
          },
          onStateChange: (event: any) => {
            const YTState = window.YT?.PlayerState;
            const now = performance.now();
            if (event.data === YTState?.ENDED) {
              clockAnchorTimeRef.current = clipStartRef.current;
              clockAnchorPerfRef.current = now;
              clockFrozenRef.current = false;
              lastRawYtTimeRef.current = null;
              event.target.seekTo(clipStartRef.current, true);
              event.target.playVideo();
            } else if (event.data === YTState?.PLAYING) {
              try {
                const rawNow = event.target.getCurrentTime?.();
                const rate = event.target.getPlaybackRate?.();
                if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
                  clockPlaybackRateRef.current = rate;
                }
                if (typeof rawNow === 'number' && !isNaN(rawNow)) {
                  clockAnchorTimeRef.current = rawNow;
                  lastRawYtTimeRef.current = rawNow;
                }
              } catch {
                // ignore
              }
              clockAnchorPerfRef.current = now;
              clockFrozenRef.current = false;
              setIsPlaying(true);
            } else if (
              event.data === YTState?.PAUSED ||
              event.data === YTState?.BUFFERING ||
              event.data === YTState?.CUED
            ) {
              try {
                const rawNow = event.target.getCurrentTime?.();
                if (typeof rawNow === 'number' && !isNaN(rawNow)) {
                  clockAnchorTimeRef.current = rawNow;
                  lastRawYtTimeRef.current = rawNow;
                  setCurrentTime(rawNow);
                }
              } catch {
                // ignore
              }
              clockAnchorPerfRef.current = now;
              clockFrozenRef.current = true;
              if (event.data === YTState?.PAUSED) setIsPlaying(false);
            }
          }
        }
      });
    };

    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag?.parentNode?.insertBefore(tag, firstScriptTag);
      window.onYouTubeIframeAPIReady = initPlayer;
    } else {
      initPlayer();
    }

    pollIdRef.current = setInterval(() => {
      if (isCancelled || !playerRef.current || typeof playerRef.current.getCurrentTime !== 'function') return;
      try {
        const rawT = playerRef.current.getCurrentTime();
        const playerState =
          typeof playerRef.current.getPlayerState === 'function' ? playerRef.current.getPlayerState() : 1;
        const rateRaw =
          typeof playerRef.current.getPlaybackRate === 'function' ? playerRef.current.getPlaybackRate() : 1;
        const rate = typeof rateRaw === 'number' && Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : 1;
        const now = performance.now();

        clockPlaybackRateRef.current = rate;
        if (typeof rawT !== 'number' || isNaN(rawT)) return;

        if (playerState !== 1) {
          clockFrozenRef.current = true;
          clockAnchorTimeRef.current = rawT;
          clockAnchorPerfRef.current = now;
          lastRawYtTimeRef.current = rawT;
          return;
        }

        const predictedNow = clockFrozenRef.current
          ? rawT
          : clockAnchorTimeRef.current + ((now - clockAnchorPerfRef.current) * rate) / 1000;
        const drift = Math.abs(predictedNow - rawT);

        if (
          clockFrozenRef.current ||
          lastRawYtTimeRef.current === null ||
          drift > 0.25 ||
          Math.abs(rawT - lastRawYtTimeRef.current) > 0.001
        ) {
          clockAnchorTimeRef.current = rawT;
          clockAnchorPerfRef.current = now;
          lastRawYtTimeRef.current = rawT;
          clockFrozenRef.current = false;
        }
      } catch {
        // ignore
      }
    }, 100);

    const tickPlaybackClock = () => {
      if (isCancelled) return;
      const now = performance.now();
      const effectiveTime = clockFrozenRef.current
        ? clockAnchorTimeRef.current
        : clockAnchorTimeRef.current + ((now - clockAnchorPerfRef.current) * clockPlaybackRateRef.current) / 1000;

      if (
        playerRef.current &&
        typeof playerRef.current.seekTo === 'function' &&
        (effectiveTime >= clipEndRef.current || effectiveTime < clipStartRef.current - 1)
      ) {
        clockAnchorTimeRef.current = clipStartRef.current;
        clockAnchorPerfRef.current = now;
        lastRawYtTimeRef.current = clipStartRef.current;
        try {
          playerRef.current.seekTo(clipStartRef.current, true);
        } catch {
          // ignore
        }
        setCurrentTime(clipStartRef.current);
      } else {
        setCurrentTime(effectiveTime);
      }

      rafIdRef.current = requestAnimationFrame(tickPlaybackClock);
    };

    rafIdRef.current = requestAnimationFrame(tickPlaybackClock);

    return () => {
      isCancelled = true;
      if (pollIdRef.current !== null) clearInterval(pollIdRef.current);
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      if (syncCalibStopTimerRef.current !== null) clearTimeout(syncCalibStopTimerRef.current);
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          // ignore
        }
      }
    };
  }, [youtubeId]);

  const togglePlayPause = () => {
    if (!playerRef.current) return;
    try {
      if (isPlaying) {
        clockFrozenRef.current = true;
        playerRef.current.pauseVideo();
        setIsPlaying(false);
      } else {
        clockAnchorPerfRef.current = performance.now();
        clockFrozenRef.current = false;
        playerRef.current.playVideo();
        setIsPlaying(true);
      }
    } catch {
      // ignore
    }
  };

  const jumpToTime = (time: number) => {
    if (playerRef.current && typeof playerRef.current.seekTo === 'function') {
      try {
        clockAnchorTimeRef.current = time;
        clockAnchorPerfRef.current = performance.now();
        lastRawYtTimeRef.current = time;
        clockFrozenRef.current = false;
        playerRef.current.seekTo(time, true);
        setCurrentTime(time);
        if (!isPlaying) {
          playerRef.current.playVideo();
          setIsPlaying(true);
        }
      } catch {
        // ignore
      }
    }
  };

  const startSyncCalibration = () => {
    const speechStart =
      clip.words && clip.words.length > 0
        ? Math.max(clip.startTime, Math.min(clip.endTime - 2, clip.words[0].start - 0.3))
        : clip.startTime;
    setSyncCalibActive(true);
    jumpToTime(speechStart);
    if (syncCalibStopTimerRef.current) clearTimeout(syncCalibStopTimerRef.current);
    syncCalibStopTimerRef.current = setTimeout(() => {
      try {
        playerRef.current?.pauseVideo?.();
        clockFrozenRef.current = true;
        setIsPlaying(false);
      } catch {
        // ignore
      }
    }, 10000);
  };

  const closeSyncCalibration = () => {
    setSyncCalibActive(false);
    if (syncCalibStopTimerRef.current) {
      clearTimeout(syncCalibStopTimerRef.current);
      syncCalibStopTimerRef.current = null;
    }
    saveCaptionLeadSec(youtubeId, captionLeadSec);
  };

  // Lines helper (always derive from clip.lines or chunked clip.words)
  const displayLines: SubtitleLine[] = React.useMemo(() => {
    if (clip.lines && clip.lines.length > 0) return clip.lines;
    const chunks = groupWordsIntoChunks(clip.words || [], settings.caption.wordsPerLine || 4);
    return chunks.map((c, idx) => ({
      id: `line-${idx + 1}`,
      start: c.start,
      end: c.end,
      words: c.words
    }));
  }, [clip.lines, clip.words, settings.caption.wordsPerLine]);

  const commitUpdatedLines = (nextLines: SubtitleLine[], feedback?: string) => {
    const cleanLines = nextLines.filter(l => l.words.length > 0);
    const flatWords: SubtitleWord[] = [];
    cleanLines.forEach(l => flatWords.push(...l.words));
    const monotonic = sanitizeMonotonicWords(flatWords);

    onUpdateClip({
      ...clip,
      words: monotonic,
      lines: cleanLines,
      baseWords: monotonic,
      customLinesEdited: true
    });
    if (feedback) setTextFeedback(feedback);
  };

  const handleSaveLineText = (lineIdx: number) => {
    const target = displayLines[lineIdx];
    if (!target) return;
    const tokens = editingLineDraft.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      // Deleting all words removes the line
      commitUpdatedLines(displayLines.filter((_, i) => i !== lineIdx), 'Baris kosong dihapus.');
      setEditingLineIdx(null);
      return;
    }

    const totalDur = Math.max(0.25, target.end - target.start);
    const weights = tokens.map(t => Math.max(1, t.replace(/[^\p{L}\p{N}]/gu, '').length || t.length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let cursor = target.start;
    const nextWords: SubtitleWord[] = tokens.map((tok, idx) => {
      const share = (weights[idx] / totalWeight) * totalDur;
      const wStart = parseFloat(cursor.toFixed(3));
      const wEnd = parseFloat(
        Math.max(wStart + 0.06, idx === tokens.length - 1 ? target.end : cursor + share).toFixed(3)
      );
      cursor = wEnd;
      return {
        word: tok,
        start: wStart,
        end: wEnd,
        emoji: getKeywordEmoji(tok)
      };
    });

    const nextLines = displayLines.map((l, i) =>
      i === lineIdx
        ? { ...l, start: nextWords[0].start, end: nextWords[nextWords.length - 1].end, words: nextWords }
        : l
    );
    commitUpdatedLines(nextLines, `Baris #${lineIdx + 1} diperbarui.`);
    setEditingLineIdx(null);
  };

  const handleMoveLineDelta = (lineIdx: number, deltaSec: number) => {
    const { words, lines, appliedDeltaSec } = moveCueLineByDelta(displayLines, lineIdx, deltaSec);
    onUpdateClip({
      ...clip,
      words,
      lines,
      baseWords: words,
      customLinesEdited: true
    });
    const ms = Math.round(appliedDeltaSec * 1000);
    setTextFeedback(`Baris #${lineIdx + 1} digeser ${ms >= 0 ? `+${ms}` : ms} ms.`);
  };

  const handleDeleteWord = (lineIdx: number, wordIdx: number) => {
    const target = displayLines[lineIdx];
    if (!target) return;
    const remainingWords = target.words.filter((_, i) => i !== wordIdx);
    const nextLines =
      remainingWords.length === 0
        ? displayLines.filter((_, i) => i !== lineIdx)
        : displayLines.map((l, i) =>
            i === lineIdx
              ? {
                  ...l,
                  start: remainingWords[0].start,
                  end: remainingWords[remainingWords.length - 1].end,
                  words: remainingWords
                }
              : l
          );
    commitUpdatedLines(nextLines, 'Kata dihapus.');
  };

  const handleMergeWithNextLine = (lineIdx: number) => {
    if (lineIdx < 0 || lineIdx >= displayLines.length - 1) return;
    const cur = displayLines[lineIdx];
    const nxt = displayLines[lineIdx + 1];
    const mergedWords = sanitizeMonotonicWords([...cur.words, ...nxt.words]);
    const mergedLine: SubtitleLine = {
      id: cur.id,
      start: mergedWords[0]?.start ?? cur.start,
      end: mergedWords[mergedWords.length - 1]?.end ?? nxt.end,
      words: mergedWords
    };
    const nextLines = [
      ...displayLines.slice(0, lineIdx),
      mergedLine,
      ...displayLines.slice(lineIdx + 2)
    ];
    commitUpdatedLines(nextLines, `Baris #${lineIdx + 1} & #${lineIdx + 2} digabung.`);
  };

  const handleSplitLine = (lineIdx: number) => {
    const target = displayLines[lineIdx];
    if (!target || target.words.length < 2) return;
    const mid = Math.ceil(target.words.length / 2);
    const topWords = target.words.slice(0, mid);
    const botWords = target.words.slice(mid);
    const topLine: SubtitleLine = {
      id: `${target.id}-a`,
      start: topWords[0].start,
      end: topWords[topWords.length - 1].end,
      words: topWords
    };
    const botLine: SubtitleLine = {
      id: `${target.id}-b-${Date.now()}`,
      start: botWords[0].start,
      end: botWords[botWords.length - 1].end,
      words: botWords
    };
    const nextLines = [
      ...displayLines.slice(0, lineIdx),
      topLine,
      botLine,
      ...displayLines.slice(lineIdx + 1)
    ];
    commitUpdatedLines(nextLines, `Baris #${lineIdx + 1} dipecah menjadi 2 baris.`);
  };

  const handleUploadSrt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseSubtitleFile(text);
      if (parsed.length === 0) {
        setTextFeedback('File SRT/VTT kosong atau tidak valid.');
        return;
      }
      const { words, lines } = cuesToWordsAndLines(
        parsed,
        clip.startTime,
        clip.endTime,
        settings.caption.wordsPerLine || 4
      );
      onUpdateClip({ ...clip, words, lines, baseWords: words, customLinesEdited: true });
      setTextFeedback(`Berhasil memuat ${words.length} kata dari file subtitle.`);
    } catch {
      setTextFeedback('Gagal membaca file subtitle.');
    }
  };

  const handleTrim = (type: 'start' | 'end', delta: number) => {
    if (type === 'start') {
      const newStart = Math.max(0, clip.startTime + delta);
      if (newStart < clip.endTime - 3) {
        onUpdateClip({
          ...clip,
          startTime: parseFloat(newStart.toFixed(2)),
          duration: parseFloat((clip.endTime - newStart).toFixed(2))
        });
        jumpToTime(newStart);
      }
    } else {
      const newEnd = clip.endTime + delta;
      if (newEnd > clip.startTime + 3) {
        onUpdateClip({
          ...clip,
          endTime: parseFloat(newEnd.toFixed(2)),
          duration: parseFloat((newEnd - clip.startTime).toFixed(2))
        });
      }
    }
  };

  const applyPreset = (preset: CaptionPreset) => {
    switch (preset) {
      case 'mrbeast':
        setSettings(prev => ({
          ...prev,
          caption: {
            ...prev.caption,
            preset: 'mrbeast',
            fontFamily: 'Montserrat',
            textColor: '#FFFFFF',
            activeWordColor: '#FACC15',
            strokeColor: '#000000',
            uppercase: true,
            popAnimation: true
          }
        }));
        break;
      case 'neon':
        setSettings(prev => ({
          ...prev,
          caption: {
            ...prev.caption,
            preset: 'neon',
            fontFamily: 'Anton',
            textColor: '#E2E8F0',
            activeWordColor: '#00FFCC',
            strokeColor: '#064E3B',
            uppercase: true,
            popAnimation: true
          }
        }));
        break;
      case 'white-outline':
        setSettings(prev => ({
          ...prev,
          caption: {
            ...prev.caption,
            preset: 'white-outline',
            fontFamily: 'Poppins',
            textColor: '#FFFFFF',
            activeWordColor: '#FFFFFF',
            strokeColor: '#000000',
            uppercase: true,
            popAnimation: false
          }
        }));
        break;
      case 'punchy-box':
        setSettings(prev => ({
          ...prev,
          caption: {
            ...prev.caption,
            preset: 'punchy-box',
            fontFamily: 'Montserrat',
            textColor: '#FFFFFF',
            activeWordColor: '#FBBF24',
            strokeColor: 'transparent',
            uppercase: true,
            popAnimation: true
          }
        }));
        break;
    }
  };

  const handleApplyToAllClips = () => {
    localStorage.setItem(`clip_studio_global_settings_${youtubeId}`, JSON.stringify(settings));
    onApplyStyleToAll(settings);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2500);
  };

  const handleDirectDownloadMp4 = async () => {
    if (directDownloading) {
      directAbortRef.current?.abort();
      return;
    }

    const isFreshCached =
      existingRendered &&
      existingRendered.extension === 'mp4' &&
      (!clip.updatedAt || existingRendered.renderedAt >= clip.updatedAt);

    if (isFreshCached) {
      downloadRenderedRecordMp4(existingRendered);
      return;
    }

    const controller = new AbortController();
    directAbortRef.current = controller;
    setDirectDownloading(true);
    setDirectProgress(4);
    setDirectStatus('Menyiapkan video & subtitle yang sudah diedit...');
    setDirectError(null);

    try {
      const record = await renderAndSaveSingleClipMp4({
        videoInfo,
        clip,
        clipNumber,
        settings,
        selectedFile,
        whisperConfig,
        signal: controller.signal,
        onProgress: (pct, msg) => {
          setDirectProgress(pct);
          setDirectStatus(msg);
        }
      });
      onClipRendered?.(record);
      downloadRenderedRecordMp4(record);
    } catch (err: any) {
      if (!controller.signal.aborted) {
        setDirectError(err?.message || 'Gagal merender klip ke MP4.');
      }
    } finally {
      setDirectDownloading(false);
      directAbortRef.current = null;
    }
  };

  const currentWords = clip.words || [];
  const wordsPerLine = settings.caption.wordsPerLine || 4;
  const { chunk: activeChunk, activeIndexInChunk } = getActiveCaptionChunk(
    currentWords,
    currentTime,
    wordsPerLine,
    captionLeadSec,
    clip.customLinesEdited ? clip.lines : undefined
  );
  const activeRows = splitDisplayWordsIntoRows(activeChunk, 2);

  const previewRef = useRef<HTMLDivElement>(null);
  const [scaleFactor, setScaleFactor] = useState(0.25);

  useEffect(() => {
    const updateScale = () => {
      if (previewRef.current) {
        setScaleFactor(previewRef.current.clientWidth / 1080);
      }
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [settings.canvas.aspectRatio]);

  const getAspectClass = () => {
    switch (settings.canvas.aspectRatio) {
      case '9:16':
        return 'aspect-[9/16] w-[250px] sm:w-[280px] max-w-full';
      case '1:1':
        return 'aspect-square w-[270px] sm:w-[300px] max-w-full';
      case '4:5':
        return 'aspect-[4/5] w-[270px] sm:w-[290px] max-w-full';
      case '16:9':
        return 'aspect-[16/9] w-full max-w-[380px]';
    }
  };

  const relTime = currentTime - clip.startTime;
  const isTitleVisible =
    settings.title.enabled &&
    settings.title.text.trim() &&
    (settings.title.durationMode === 'full_clip' || relTime <= (settings.title.displaySeconds || 3));

  return (
    <div className="w-full max-w-6xl mx-auto space-y-4 pb-8">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 bg-[#121826] border border-slate-800 rounded-2xl px-3.5 py-2.5">
        <button
          type="button"
          onClick={onBack}
          disabled={directDownloading}
          className="min-h-[44px] px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 border border-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Daftar Klip</span>
        </button>

        <div className="min-w-0 text-center flex-1">
          <div className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wide">
            Editor Klip
          </div>
          <div className="text-xs sm:text-sm font-bold text-slate-100 truncate max-w-[200px] sm:max-w-xs mx-auto">
            {clip.hookText || clip.title}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDirectDownloadMp4}
            className={`min-h-[44px] px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition ${
              directDownloading
                ? 'bg-red-500 hover:bg-red-400 text-slate-950'
                : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
            }`}
          >
            {directDownloading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Batal ({directProgress}%)</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>Unduh MP4</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onProceedToRender}
            disabled={directDownloading}
            className="min-h-[44px] px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-700 text-slate-100 text-xs font-semibold flex items-center gap-1.5"
          >
            <span>Antrean Render</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Direct MP4 Render Progress / Error */}
      {directDownloading && (
        <div className="bg-[#121826] border border-emerald-500/40 rounded-xl p-3.5 space-y-2 text-xs">
          <div className="flex items-center justify-between text-slate-200 font-semibold">
            <span>{directStatus}</span>
            <span className="font-mono-num text-emerald-400">{directProgress}%</span>
          </div>
          <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-150"
              style={{ width: `${Math.max(4, directProgress)}%` }}
            />
          </div>
        </div>
      )}

      {directError && (
        <div className="bg-red-950/50 border border-red-500/40 rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-red-200">
          <span>{directError}</span>
          <button
            type="button"
            onClick={onProceedToRender}
            className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-100 font-semibold shrink-0"
          >
            Pilih Video di Langkah 3 →
          </button>
        </div>
      )}

      {/* Responsive Split Layout: Preview Left, Tabs Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left: WYSIWYG Preview + Trim + Sync Calibration */}
        <div className="lg:col-span-5 flex flex-col items-center space-y-3">
          <div
            ref={previewRef}
            className={`relative ${getAspectClass()} rounded-2xl overflow-hidden bg-black border border-slate-700 shadow-2xl flex items-center justify-center select-none`}
          >
            <div className="absolute inset-0 w-full h-full pointer-events-none">
              <div id="yt-player-container" className="w-full h-full" />
            </div>

            <div
              onClick={togglePlayPause}
              className="absolute inset-0 z-10 cursor-pointer flex items-center justify-center"
            >
              {!isPlaying && (
                <div className="w-12 h-12 rounded-full bg-black/70 border border-white/25 flex items-center justify-center text-white">
                  <Play className="w-6 h-6 fill-white ml-0.5" />
                </div>
              )}
            </div>

            {/* Title Overlay scaled from 1080px reference */}
            {isTitleVisible && (
              <div
                className="absolute left-0 right-0 z-20 px-3 pointer-events-none text-center"
                style={{ top: settings.title.position === 'top' ? '12%' : '42%' }}
              >
                <div
                  className="inline-block font-extrabold leading-tight"
                  style={{
                    fontSize: `${Math.round(settings.title.size * scaleFactor)}px`,
                    color: settings.title.textColor,
                    WebkitTextStroke:
                      settings.title.strokeColor && settings.title.strokeColor !== 'transparent'
                        ? `${Math.max(1, Math.round(5 * scaleFactor))}px ${settings.title.strokeColor}`
                        : 'none',
                    backgroundColor: settings.title.backgroundBox ? settings.title.boxColor : 'transparent',
                    padding: settings.title.backgroundBox
                      ? `${Math.round(8 * scaleFactor)}px ${Math.round(18 * scaleFactor)}px`
                      : '0',
                    borderRadius: `${Math.round(12 * scaleFactor)}px`,
                    fontFamily: '"Montserrat", sans-serif'
                  }}
                >
                  {settings.title.text}
                </div>
              </div>
            )}

            {/* Caption Overlay scaled from 1080px reference */}
            <div
              className={`absolute left-0 right-0 z-20 px-3 pointer-events-none flex -translate-y-1/2 ${
                settings.caption.horizontalAlign === 'left'
                  ? 'justify-start'
                  : settings.caption.horizontalAlign === 'right'
                  ? 'justify-end'
                  : 'justify-center'
              }`}
              style={{ top: `${settings.caption.positionPercent}%` }}
            >
              {activeRows.length > 0 && (() => {
                let runningWordIdx = 0;
                return (
                  <div
                    className={`flex flex-col gap-0.5 font-black leading-tight max-w-[90%] ${
                      settings.caption.horizontalAlign === 'left'
                        ? 'items-start text-left'
                        : settings.caption.horizontalAlign === 'right'
                        ? 'items-end text-right'
                        : 'items-center text-center'
                    }`}
                    style={{
                      fontSize: `${Math.round(settings.caption.size * scaleFactor)}px`,
                      fontFamily:
                        settings.caption.fontFamily === 'Anton'
                          ? '"Anton", sans-serif'
                          : settings.caption.fontFamily === 'Poppins'
                          ? '"Poppins", sans-serif'
                          : '"Montserrat", sans-serif',
                      backgroundColor:
                        settings.caption.preset === 'punchy-box' ? 'rgba(0, 0, 0, 0.88)' : 'transparent',
                      padding:
                        settings.caption.preset === 'punchy-box'
                          ? `${Math.round(6 * scaleFactor)}px ${Math.round(14 * scaleFactor)}px`
                          : '0',
                      borderRadius: `${Math.round(10 * scaleFactor)}px`
                    }}
                  >
                    {activeRows.map((rowWords, rIdx) => (
                      <div key={rIdx} className="flex items-center gap-1.5 flex-wrap justify-center">
                        {rowWords.map((w, idx) => {
                          const myIdx = runningWordIdx++;
                          const isActive = myIdx === activeIndexInChunk;
                          const wordText = settings.caption.uppercase ? w.word.toUpperCase() : w.word;
                          return (
                            <span
                              key={idx}
                              style={{
                                color: isActive ? settings.caption.activeWordColor : settings.caption.textColor,
                                WebkitTextStroke:
                                  settings.caption.strokeColor && settings.caption.strokeColor !== 'transparent'
                                    ? `${Math.max(1, Math.round(5 * scaleFactor))}px ${settings.caption.strokeColor}`
                                    : 'none',
                                transform: isActive && settings.caption.popAnimation ? 'scale(1.14)' : 'scale(1)',
                                transition: 'transform 65ms ease-out',
                                display: 'inline-block'
                              }}
                            >
                              {wordText}
                              {settings.caption.autoEmoji && w.emoji ? ` ${w.emoji}` : ''}
                            </span>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Trim & Play Controls */}
          <div className="w-full max-w-[380px] bg-[#121826] border border-slate-800 rounded-xl p-2.5 flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => handleTrim('start', -1)}
                className="min-h-[36px] px-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 font-bold"
              >
                -1s
              </button>
              <span className="font-mono-num text-slate-300 px-1">
                {formatClockMinSec(clip.startTime)}
              </span>
              <button
                type="button"
                onClick={() => handleTrim('start', 1)}
                className="min-h-[36px] px-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 font-bold"
              >
                +1s
              </button>
            </div>

            <button
              type="button"
              onClick={togglePlayPause}
              aria-label={isPlaying ? 'Jeda video' : 'Putar video'}
              className="w-10 h-10 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center justify-center shrink-0"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => handleTrim('end', -1)}
                className="min-h-[36px] px-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 font-bold"
              >
                -1s
              </button>
              <span className="font-mono-num text-slate-300 px-1">
                {formatClockMinSec(clip.endTime)}
              </span>
              <button
                type="button"
                onClick={() => handleTrim('end', 1)}
                className="min-h-[36px] px-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 font-bold"
              >
                +1s
              </button>
            </div>
          </div>

          {/* 10s Sync Calibration Bar */}
          {syncCalibActive && (
            <div className="w-full max-w-[380px] p-3 rounded-xl bg-sky-950/50 border border-sky-500/50 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-sky-200 font-mono-num">
                  Cek Sinkron (10 dtk) · Lead: {captionLeadSec >= 0 ? `+${captionLeadSec.toFixed(2)}s` : `${captionLeadSec.toFixed(2)}s`}
                </span>
                <button type="button" onClick={closeSyncCalibration} className="text-slate-400 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => handleChangeCaptionLead(captionLeadSec - 0.1)}
                  className="min-h-[40px] px-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-sky-500/40 text-sky-200 font-bold"
                >
                  Terlalu cepat
                </button>
                <button
                  type="button"
                  onClick={closeSyncCalibration}
                  className="min-h-[40px] px-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold"
                >
                  Pas
                </button>
                <button
                  type="button"
                  onClick={() => handleChangeCaptionLead(captionLeadSec + 0.1)}
                  className="min-h-[40px] px-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-sky-500/40 text-sky-200 font-bold"
                >
                  Terlalu lambat
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: 4 Editor Tabs & Settings */}
        <div className="lg:col-span-7 space-y-3">
          {/* Tabs Bar */}
          <div className="grid grid-cols-4 gap-1.5 p-1.5 bg-[#121826] border border-slate-800 rounded-2xl text-xs font-bold">
            {[
              { id: 'caption', label: 'Caption', icon: Subtitles },
              { id: 'canvas', label: 'Kanvas', icon: Maximize2 },
              { id: 'title', label: 'Judul', icon: Type },
              { id: 'text', label: 'Edit Teks', icon: Gauge }
            ].map(tab => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`min-h-[44px] px-2 rounded-xl flex items-center justify-center gap-1.5 transition ${
                    active ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>

          <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-5 text-xs">
            {/* TAB CAPTION */}
            {activeTab === 'caption' && (
              <div className="space-y-4">
                <div>
                  <label className="block font-bold text-slate-200 mb-2">Preset Gaya Caption</label>
                  <div className="grid grid-cols-2 gap-2.5">
                    {[
                      { id: 'mrbeast', name: 'MrBeast Kuning', tag: 'Populer', color: '#FACC15' },
                      { id: 'neon', name: 'Neon Cyber', tag: 'Glow', color: '#00FFCC' },
                      { id: 'white-outline', name: 'Putih Outline', tag: 'Bersih', color: '#FFFFFF' },
                      { id: 'punchy-box', name: 'Kotak Tebal', tag: 'Kontras', color: '#FBBF24' }
                    ].map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applyPreset(p.id as CaptionPreset)}
                        className={`min-h-[48px] p-3 rounded-xl border text-left flex items-center justify-between transition ${
                          settings.caption.preset === p.id
                            ? 'bg-slate-800 border-emerald-500 text-white'
                            : 'bg-[#0b0f17] border-slate-800 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div>
                          <div className="font-bold flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                            <span>{p.name}</span>
                          </div>
                          <span className="text-[11px] text-slate-400">{p.tag}</span>
                        </div>
                        {settings.caption.preset === p.id && <Check className="w-4 h-4 text-emerald-400" />}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Global Caption Sync Slider (±2s, step 0.05, default +0.10s) */}
                <div className="pt-3 border-t border-slate-800 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-bold text-slate-200">
                      <Sliders className="w-4 h-4 text-sky-400" />
                      <span>Sinkron Caption Global (±2s)</span>
                    </span>
                    <button
                      type="button"
                      onClick={startSyncCalibration}
                      className="min-h-[36px] px-3 py-1 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-300 font-semibold"
                    >
                      Cek Sinkron (10 dtk)
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={-2}
                      max={2}
                      step={0.05}
                      value={captionLeadSec}
                      onChange={e => handleChangeCaptionLead(parseFloat(e.target.value))}
                      className="flex-1 accent-sky-400"
                    />
                    <span className="font-mono-num text-xs font-bold text-sky-300 w-16 text-right">
                      {captionLeadSec >= 0 ? `+${captionLeadSec.toFixed(2)}s` : `${captionLeadSec.toFixed(2)}s`}
                    </span>
                    {Math.abs(captionLeadSec - DEFAULT_CAPTION_LEAD_SEC) > 0.005 && (
                      <button
                        type="button"
                        onClick={() => handleChangeCaptionLead(DEFAULT_CAPTION_LEAD_SEC)}
                        className="text-[11px] text-slate-400 hover:text-white"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>

                {/* Advanced Caption Accordion */}
                <div className="pt-3 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowAdvancedCaption(v => !v)}
                    className="w-full min-h-[40px] flex items-center justify-between text-slate-300 font-semibold"
                  >
                    <span>Pengaturan Lanjutan Caption</span>
                    <ChevronDown className={`w-4 h-4 transition-transform ${showAdvancedCaption ? 'rotate-180' : ''}`} />
                  </button>

                  {showAdvancedCaption && (
                    <div className="mt-3 space-y-3.5 bg-[#0b0f17] border border-slate-800 rounded-xl p-3.5">
                      {/* Font */}
                      <div className="grid grid-cols-3 gap-2">
                        {(['Montserrat', 'Anton', 'Poppins'] as CaptionFont[]).map(font => (
                          <button
                            key={font}
                            type="button"
                            onClick={() =>
                              setSettings(prev => ({
                                ...prev,
                                caption: { ...prev.caption, fontFamily: font }
                              }))
                            }
                            className={`min-h-[40px] rounded-lg border font-bold ${
                              settings.caption.fontFamily === font
                                ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                                : 'bg-[#121826] text-slate-300 border-slate-700'
                            }`}
                          >
                            {font}
                          </button>
                        ))}
                      </div>

                      {/* Words per line & Size */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <div className="flex justify-between mb-1 text-slate-300">
                            <span>Kata per baris</span>
                            <span className="font-mono-num">{settings.caption.wordsPerLine}</span>
                          </div>
                          <input
                            type="range"
                            min={1}
                            max={5}
                            step={1}
                            value={settings.caption.wordsPerLine}
                            onChange={e => {
                              const nextWpl = Number(e.target.value);
                              setSettings(prev => ({
                                ...prev,
                                caption: { ...prev.caption, wordsPerLine: nextWpl }
                              }));
                              if (clip.customLinesEdited) {
                                onUpdateClip({ ...clip, customLinesEdited: false });
                              }
                            }}
                            className="w-full accent-emerald-500"
                          />
                        </div>

                        <div>
                          <div className="flex justify-between mb-1 text-slate-300">
                            <span>Ukuran Font</span>
                            <span className="font-mono-num">{settings.caption.size}px</span>
                          </div>
                          <input
                            type="range"
                            min={32}
                            max={96}
                            step={2}
                            value={settings.caption.size}
                            onChange={e =>
                              setSettings(prev => ({
                                ...prev,
                                caption: { ...prev.caption, size: Number(e.target.value) }
                              }))
                            }
                            className="w-full accent-emerald-500"
                          />
                        </div>
                      </div>

                      {/* Vertical Position & Horizontal Align */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                        <div>
                          <div className="flex justify-between mb-1 text-slate-300">
                            <span>Posisi Vertikal</span>
                            <span className="font-mono-num">{settings.caption.positionPercent}%</span>
                          </div>
                          <input
                            type="range"
                            min={15}
                            max={90}
                            step={1}
                            value={settings.caption.positionPercent}
                            onChange={e =>
                              setSettings(prev => ({
                                ...prev,
                                caption: { ...prev.caption, positionPercent: Number(e.target.value) }
                              }))
                            }
                            className="w-full accent-emerald-500"
                          />
                        </div>

                        <div className="flex gap-1.5">
                          {[
                            { id: 'left', icon: AlignLeft, label: 'Kiri' },
                            { id: 'center', icon: AlignCenter, label: 'Tengah' },
                            { id: 'right', icon: AlignRight, label: 'Kanan' }
                          ].map(al => {
                            const Icon = al.icon;
                            return (
                              <button
                                key={al.id}
                                type="button"
                                onClick={() =>
                                  setSettings(prev => ({
                                    ...prev,
                                    caption: { ...prev.caption, horizontalAlign: al.id as any }
                                  }))
                                }
                                aria-label={al.label}
                                className={`flex-1 min-h-[40px] rounded-lg border flex items-center justify-center ${
                                  (settings.caption.horizontalAlign || 'center') === al.id
                                    ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                                    : 'bg-[#121826] text-slate-300 border-slate-700'
                                }`}
                              >
                                <Icon className="w-4 h-4" />
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Colors: Text, Active Word, Stroke */}
                      <div className="grid grid-cols-3 gap-2.5">
                        <label className="flex items-center justify-between bg-[#121826] border border-slate-700 rounded-lg px-2.5 py-2">
                          <span className="text-slate-300">Teks</span>
                          <input
                            type="color"
                            value={settings.caption.textColor}
                            onChange={e =>
                              setSettings(prev => ({
                                ...prev,
                                caption: { ...prev.caption, textColor: e.target.value }
                              }))
                            }
                            className="w-7 h-7 rounded cursor-pointer bg-transparent border-0"
                          />
                        </label>
                        <label className="flex items-center justify-between bg-[#121826] border border-slate-700 rounded-lg px-2.5 py-2">
                          <span className="text-slate-300">Aktif</span>
                          <input
                            type="color"
                            value={settings.caption.activeWordColor}
                            onChange={e =>
                              setSettings(prev => ({
                                ...prev,
                                caption: { ...prev.caption, activeWordColor: e.target.value }
                              }))
                            }
                            className="w-7 h-7 rounded cursor-pointer bg-transparent border-0"
                          />
                        </label>
                        <label className="flex items-center justify-between bg-[#121826] border border-slate-700 rounded-lg px-2.5 py-2">
                          <span className="text-slate-300">Stroke</span>
                          <input
                            type="color"
                            value={settings.caption.strokeColor === 'transparent' ? '#000000' : settings.caption.strokeColor}
                            onChange={e =>
                              setSettings(prev => ({
                                ...prev,
                                caption: { ...prev.caption, strokeColor: e.target.value }
                              }))
                            }
                            className="w-7 h-7 rounded cursor-pointer bg-transparent border-0"
                          />
                        </label>
                      </div>

                      {/* Toggles: Kapital, Emoji Otomatis, Animasi Pop */}
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { key: 'uppercase', label: 'KAPITAL' },
                          { key: 'autoEmoji', label: 'Emoji Otomatis' },
                          { key: 'popAnimation', label: 'Animasi Pop' }
                        ].map(item => {
                          const active = Boolean((settings.caption as any)[item.key]);
                          return (
                            <button
                              key={item.key}
                              type="button"
                              onClick={() =>
                                setSettings(prev => ({
                                  ...prev,
                                  caption: { ...prev.caption, [item.key]: !active }
                                }))
                              }
                              className={`min-h-[40px] px-2 rounded-lg border font-semibold ${
                                active
                                  ? 'bg-emerald-500/15 border-emerald-500 text-emerald-300'
                                  : 'bg-[#121826] border-slate-800 text-slate-400'
                              }`}
                            >
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB KANVAS */}
            {activeTab === 'canvas' && (
              <div className="space-y-4">
                <div>
                  <label className="block font-bold text-slate-200 mb-2">Rasio Aspek</label>
                  <div className="grid grid-cols-4 gap-2">
                    {(['9:16', '1:1', '4:5', '16:9'] as const).map(ar => (
                      <button
                        key={ar}
                        type="button"
                        onClick={() =>
                          setSettings(prev => ({ ...prev, canvas: { ...prev.canvas, aspectRatio: ar } }))
                        }
                        className={`min-h-[44px] rounded-xl border font-bold font-mono-num ${
                          settings.canvas.aspectRatio === ar
                            ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                            : 'bg-[#0b0f17] text-slate-300 border-slate-800'
                        }`}
                      >
                        {ar}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-slate-200 mb-2">Cara Pas Video</label>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() =>
                        setSettings(prev => ({ ...prev, canvas: { ...prev.canvas, fitMode: 'cover' } }))
                      }
                      className={`min-h-[44px] px-3 rounded-xl border font-semibold ${
                        settings.canvas.fitMode === 'cover'
                          ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                          : 'bg-[#0b0f17] text-slate-300 border-slate-800'
                      }`}
                    >
                      Isi Penuh (Crop)
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings(prev => ({ ...prev, canvas: { ...prev.canvas, fitMode: 'contain' } }))
                      }
                      className={`min-h-[44px] px-3 rounded-xl border font-semibold ${
                        settings.canvas.fitMode === 'contain'
                          ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                          : 'bg-[#0b0f17] text-slate-300 border-slate-800'
                      }`}
                    >
                      Muat Penuh (Utuh)
                    </button>
                  </div>
                </div>

                {settings.canvas.fitMode === 'cover' ? (
                  <div>
                    <div className="flex justify-between mb-1 text-slate-300 font-semibold">
                      <span>Posisi Crop Horizontal</span>
                      <span className="font-mono-num">{settings.canvas.horizontalPanPercent}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={settings.canvas.horizontalPanPercent}
                      onChange={e =>
                        setSettings(prev => ({
                          ...prev,
                          canvas: { ...prev.canvas, horizontalPanPercent: Number(e.target.value) }
                        }))
                      }
                      className="w-full accent-emerald-500"
                    />
                  </div>
                ) : (
                  <div className="space-y-3 bg-[#0b0f17] border border-slate-800 rounded-xl p-3">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setSettings(prev => ({ ...prev, canvas: { ...prev.canvas, backgroundMode: 'blur' } }))
                        }
                        className={`min-h-[40px] rounded-lg border font-semibold ${
                          settings.canvas.backgroundMode === 'blur'
                            ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                            : 'bg-[#121826] text-slate-300 border-slate-700'
                        }`}
                      >
                        Latar Blur
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSettings(prev => ({ ...prev, canvas: { ...prev.canvas, backgroundMode: 'color' } }))
                        }
                        className={`min-h-[40px] rounded-lg border font-semibold ${
                          settings.canvas.backgroundMode === 'color'
                            ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                            : 'bg-[#121826] text-slate-300 border-slate-700'
                        }`}
                      >
                        Warna Polos
                      </button>
                    </div>
                    {settings.canvas.backgroundMode === 'color' && (
                      <label className="flex items-center justify-between bg-[#121826] border border-slate-700 rounded-lg px-3 py-2">
                        <span className="text-slate-300">Warna Latar</span>
                        <input
                          type="color"
                          value={settings.canvas.backgroundColor}
                          onChange={e =>
                            setSettings(prev => ({
                              ...prev,
                              canvas: { ...prev.canvas, backgroundColor: e.target.value }
                            }))
                          }
                          className="w-8 h-8 bg-transparent border-0 cursor-pointer"
                        />
                      </label>
                    )}
                  </div>
                )}

                <div>
                  <label className="block font-bold text-slate-200 mb-2">Resolusi Render</label>
                  <div className="grid grid-cols-2 gap-2.5">
                    {(['720p', '1080p'] as const).map(res => (
                      <button
                        key={res}
                        type="button"
                        onClick={() =>
                          setSettings(prev => ({ ...prev, canvas: { ...prev.canvas, resolution: res } }))
                        }
                        className={`min-h-[44px] rounded-xl border font-bold font-mono-num ${
                          settings.canvas.resolution === res
                            ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                            : 'bg-[#0b0f17] text-slate-300 border-slate-800'
                        }`}
                      >
                        {res} {res === '720p' ? '(Default)' : '(FHD)'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* TAB JUDUL */}
            {activeTab === 'title' && (
              <div className="space-y-4">
                <label className="flex items-center justify-between bg-[#0b0f17] border border-slate-800 rounded-xl px-3.5 py-2.5 cursor-pointer">
                  <span className="font-bold text-slate-200">Tampilkan Judul di Video</span>
                  <input
                    type="checkbox"
                    checked={settings.title.enabled}
                    onChange={e =>
                      setSettings(prev => ({ ...prev, title: { ...prev.title, enabled: e.target.checked } }))
                    }
                    className="w-4 h-4 accent-emerald-500"
                  />
                </label>

                <div>
                  <label className="block font-semibold text-slate-300 mb-1.5">Teks Judul Hook</label>
                  <input
                    type="text"
                    value={settings.title.text}
                    onChange={e =>
                      setSettings(prev => ({ ...prev, title: { ...prev.title, text: e.target.value } }))
                    }
                    className="w-full min-h-[44px] px-3 bg-[#0b0f17] border border-slate-700 focus:border-emerald-500 rounded-xl text-sm text-slate-100 outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      setSettings(prev => ({ ...prev, title: { ...prev.title, position: 'top' } }))
                    }
                    className={`min-h-[42px] rounded-xl border font-semibold ${
                      settings.title.position === 'top'
                        ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                        : 'bg-[#0b0f17] text-slate-300 border-slate-800'
                    }`}
                  >
                    Posisi Atas
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setSettings(prev => ({ ...prev, title: { ...prev.title, position: 'center' } }))
                    }
                    className={`min-h-[42px] rounded-xl border font-semibold ${
                      settings.title.position === 'center'
                        ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                        : 'bg-[#0b0f17] text-slate-300 border-slate-800'
                    }`}
                  >
                    Posisi Tengah
                  </button>
                </div>

                <div>
                  <div className="flex justify-between mb-1 text-slate-300 font-semibold">
                    <span>Ukuran Judul</span>
                    <span className="font-mono-num">{settings.title.size}px</span>
                  </div>
                  <input
                    type="range"
                    min={28}
                    max={84}
                    step={2}
                    value={settings.title.size}
                    onChange={e =>
                      setSettings(prev => ({ ...prev, title: { ...prev.title, size: Number(e.target.value) } }))
                    }
                    className="w-full accent-emerald-500"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2.5">
                  <label className="flex items-center justify-between bg-[#0b0f17] border border-slate-800 rounded-lg px-2.5 py-2">
                    <span className="text-slate-300">Teks</span>
                    <input
                      type="color"
                      value={settings.title.textColor}
                      onChange={e =>
                        setSettings(prev => ({
                          ...prev,
                          title: { ...prev.title, textColor: e.target.value }
                        }))
                      }
                      className="w-7 h-7 bg-transparent border-0 cursor-pointer"
                    />
                  </label>
                  <label className="flex items-center justify-between bg-[#0b0f17] border border-slate-800 rounded-lg px-2.5 py-2">
                    <span className="text-slate-300">Stroke</span>
                    <input
                      type="color"
                      value={settings.title.strokeColor === 'transparent' ? '#000000' : settings.title.strokeColor}
                      onChange={e =>
                        setSettings(prev => ({
                          ...prev,
                          title: { ...prev.title, strokeColor: e.target.value }
                        }))
                      }
                      className="w-7 h-7 bg-transparent border-0 cursor-pointer"
                    />
                  </label>
                  <label className="flex items-center justify-between bg-[#0b0f17] border border-slate-800 rounded-lg px-2.5 py-2">
                    <span className="text-slate-300">Kotak</span>
                    <input
                      type="color"
                      value={settings.title.boxColor.startsWith('#') ? settings.title.boxColor : '#000000'}
                      onChange={e =>
                        setSettings(prev => ({
                          ...prev,
                          title: { ...prev.title, boxColor: e.target.value }
                        }))
                      }
                      className="w-7 h-7 bg-transparent border-0 cursor-pointer"
                    />
                  </label>
                </div>

                <label className="flex items-center gap-2.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.title.backgroundBox}
                    onChange={e =>
                      setSettings(prev => ({
                        ...prev,
                        title: { ...prev.title, backgroundBox: e.target.checked }
                      }))
                    }
                    className="w-4 h-4 accent-emerald-500"
                  />
                  <span>Gunakan kotak latar belakang judul</span>
                </label>

                <div className="pt-2 border-t border-slate-800 space-y-2.5">
                  <label className="block font-semibold text-slate-300">Lama Tampil Judul</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSettings(prev => ({ ...prev, title: { ...prev.title, durationMode: 'first_seconds' } }))
                      }
                      className={`min-h-[40px] rounded-lg border font-semibold ${
                        settings.title.durationMode === 'first_seconds'
                          ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                          : 'bg-[#0b0f17] text-slate-300 border-slate-800'
                      }`}
                    >
                      Detik Awal Saja
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings(prev => ({ ...prev, title: { ...prev.title, durationMode: 'full_clip' } }))
                      }
                      className={`min-h-[40px] rounded-lg border font-semibold ${
                        settings.title.durationMode === 'full_clip'
                          ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                          : 'bg-[#0b0f17] text-slate-300 border-slate-800'
                      }`}
                    >
                      Sepanjang Klip
                    </button>
                  </div>
                  {settings.title.durationMode === 'first_seconds' && (
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={15}
                        step={1}
                        value={settings.title.displaySeconds}
                        onChange={e =>
                          setSettings(prev => ({
                            ...prev,
                            title: { ...prev.title, displaySeconds: Number(e.target.value) }
                          }))
                        }
                        className="flex-1 accent-emerald-500"
                      />
                      <span className="font-mono-num font-bold text-slate-200 w-16 text-right">
                        {settings.title.displaySeconds} dtk
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB EDIT TEKS */}
            {activeTab === 'text' && (
              <div className="space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold text-slate-200">
                    Baris Caption ({displayLines.length})
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      ref={subtitleFileInputRef}
                      type="file"
                      accept=".srt,.vtt,.sbv"
                      onChange={handleUploadSrt}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => subtitleFileInputRef.current?.click()}
                      className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold flex items-center gap-1.5"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>Unggah SRT/VTT</span>
                    </button>
                  </div>
                </div>

                {textFeedback && (
                  <div className="px-3 py-2 rounded-lg bg-emerald-950/50 border border-emerald-500/30 text-emerald-300 text-xs">
                    {textFeedback}
                  </div>
                )}

                <div className="max-h-[420px] overflow-y-auto space-y-2.5 pr-1">
                  {displayLines.length === 0 ? (
                    <div className="p-6 text-center text-slate-400 bg-[#0b0f17] rounded-xl border border-slate-800">
                      Belum ada baris subtitle pada rentang klip ini.
                    </div>
                  ) : (
                    displayLines.map((line, lineIdx) => {
                      const isLineActive = currentTime >= line.start - 0.05 && currentTime <= line.end + 0.05;
                      const isEditingThis = editingLineIdx === lineIdx;
                      const lineText = line.words.map(w => w.word).join(' ');

                      return (
                        <div
                          key={line.id || lineIdx}
                          className={`p-3 rounded-xl border transition space-y-2 ${
                            isLineActive
                              ? 'bg-emerald-950/25 border-emerald-500/60'
                              : 'bg-[#0b0f17] border-slate-800'
                          }`}
                        >
                          {/* Line header: jump time, ±0.1s shift, merge/split */}
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => jumpToTime(line.start)}
                              className="font-mono-num text-[11px] font-bold text-emerald-400 hover:text-emerald-300 px-2 py-1 rounded bg-slate-900 border border-slate-800"
                            >
                              #{lineIdx + 1} · {formatClockMinSec(line.start, true)} → {formatClockMinSec(line.end, true)}
                            </button>

                            <div className="flex flex-wrap items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleMoveLineDelta(lineIdx, -0.1)}
                                title="Geser -0.1 detik"
                                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono-num text-[11px]"
                              >
                                -0.1s
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveLineDelta(lineIdx, 0.1)}
                                title="Geser +0.1 detik"
                                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono-num text-[11px]"
                              >
                                +0.1s
                              </button>
                              {line.words.length >= 2 && (
                                <button
                                  type="button"
                                  onClick={() => handleSplitLine(lineIdx)}
                                  title="Pecah baris"
                                  className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 text-[11px]"
                                >
                                  <Scissors className="w-3 h-3" />
                                  <span>Pecah</span>
                                </button>
                              )}
                              {lineIdx < displayLines.length - 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleMergeWithNextLine(lineIdx)}
                                  title="Gabung dengan baris bawah"
                                  className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 text-[11px]"
                                >
                                  <GitMerge className="w-3 h-3" />
                                  <span>Gabung</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Editable Text or Word Chips with Delete */}
                          {isEditingThis ? (
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={editingLineDraft}
                                onChange={e => setEditingLineDraft(e.target.value)}
                                className="flex-1 min-h-[38px] px-2.5 bg-[#121826] border border-emerald-500 rounded-lg text-xs text-white outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => handleSaveLineText(lineIdx)}
                                className="px-3 rounded-lg bg-emerald-500 text-slate-950 font-bold"
                              >
                                Simpan
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingLineIdx(null)}
                                className="px-2.5 rounded-lg bg-slate-800 text-slate-300"
                              >
                                Batal
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <button
                                  type="button"
                                  onClick={() => jumpToTime(line.start)}
                                  className="text-left text-sm font-semibold text-slate-100 hover:text-emerald-300"
                                >
                                  {lineText}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingLineIdx(lineIdx);
                                    setEditingLineDraft(lineText);
                                  }}
                                  className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold shrink-0"
                                >
                                  Ubah Teks
                                </button>
                              </div>

                              {/* Per-word chips with delete word button */}
                              <div className="flex flex-wrap gap-1.5">
                                {line.words.map((w, wIdx) => (
                                  <span
                                    key={`${line.id}-w-${wIdx}`}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[11px] text-slate-300"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => jumpToTime(w.start)}
                                      className="hover:text-emerald-300"
                                    >
                                      {w.word}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteWord(lineIdx, wIdx)}
                                      aria-label={`Hapus kata ${w.word}`}
                                      className="text-slate-500 hover:text-red-400"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* Apply style to all clips button */}
            <div className="pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2.5">
              <button
                type="button"
                onClick={handleApplyToAllClips}
                className="min-h-[42px] px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-100 flex items-center gap-2 transition"
              >
                {copySuccess ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                <span>{copySuccess ? 'Gaya Diterapkan ke Semua Klip!' : 'Terapkan gaya ke semua klip'}</span>
              </button>

              <span className="text-[11px] text-slate-400">
                Perubahan tersimpan otomatis
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
