export const CLIP_CATEGORIES = [
  'Lucu/Humor',
  'Insight/Edukasi',
  'Motivasi',
  'Cerita/Storytelling',
  'Fakta Mengejutkan',
  'Drama/Konflik',
  'Tips Praktis',
  'Kutipan Ikonik'
] as const;

export type ClipCategory = (typeof CLIP_CATEGORIES)[number];

export interface SubtitleWord {
  word: string;
  start: number; // absolute seconds in video
  end: number;   // absolute seconds in video
  emoji?: string;
  low_confidence?: boolean;
}

export interface SubtitleLine {
  id: string;
  start: number;
  end: number;
  words: SubtitleWord[];
}

export type TranscriptSourceTier =
  | 'whisper'
  | 'youtube_manual'
  | 'youtube_auto_json3'
  | 'youtube_auto_fallback'
  | 'gemini_url'
  | 'manual_paste_srt'
  | 'manual_paste_plain';

export type QualityLabel =
  | 'Akurasi tinggi (Whisper)'
  | 'Akurasi baik (caption manual)'
  | 'Akurasi sedang (caption otomatis YouTube)'
  | 'Perkiraan (Gemini/timing dibagi rata)';

export interface FailedTierReport {
  tier: string;
  reason: string;
  durationMs: number;
  cloudBlocked?: boolean;
}

export interface TranscriptDiagnostics {
  sourceUsed: TranscriptSourceTier;
  qualityLabel: QualityLabel;
  detectedLanguage: string;
  wordCount: number;
  speechCoveragePct: number;
  wpm: number;
  isIncomplete: boolean;
  isSuspiciousWpm: boolean;
  cacheHit: boolean;
  keptSoundCues?: boolean;
  cloudBlockedHint?: boolean;
  timingsMs: {
    metadata?: number;
    whisper?: number;
    captions?: number;
    geminiTranscribe?: number;
    clipSelection?: number;
    total?: number;
  };
  failedTiers: FailedTierReport[];
}

export interface Clip {
  id: string;
  title: string;
  startTime: number;
  endTime: number;
  duration: number;
  viralityScore: number;
  reasons: string[];
  summary?: string;
  category: ClipCategory | string;
  hookText?: string;
  words: SubtitleWord[];
  lines?: SubtitleLine[];
  baseWords?: SubtitleWord[];
  rawWords?: SubtitleWord[];
  rawLines?: SubtitleLine[];
  customLinesEdited?: boolean;
  updatedAt?: number;
  timingSpeed?: number;
  timingOffsetSeconds?: number;
}

export interface VideoInfo {
  id: string;
  title: string;
  channelTitle: string;
  youtubeId: string;
  duration: number;
  thumbnailUrl: string;
  url: string;
  clips: Clip[];
  isAiTranscribed?: boolean;
  isManualSubtitle?: boolean;
  videoDescription?: string;
  detectedLanguage?: string;
  diagnostics?: TranscriptDiagnostics;
}

export interface WhisperConfig {
  url: string;
  token: string;
}

export interface AppAnalyzeSettings {
  durasi: number; // 10 - 180, default 60
  jumlah: number; // 1 - 20, default 6
  perKategori: number; // 1 - 10, default 2
  kategori: ClipCategory[];
  keepSoundCues: boolean;
}

export interface AnalyzeJobStatusResponse {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  result?: VideoInfo;
  error?: string;
}

export type AspectRatio = '9:16' | '1:1' | '4:5' | '16:9';

export interface CanvasSpec {
  aspectRatio: AspectRatio;
  fitMode: 'cover' | 'contain';
  horizontalPanPercent: number; // 0 to 100
  backgroundMode: 'blur' | 'color';
  backgroundColor: string;
  resolution: '720p' | '1080p';
}

export interface TitleStyle {
  text: string;
  enabled: boolean;
  position: 'top' | 'center';
  size: number; // Reference 1080px base
  textColor: string;
  strokeColor: string;
  backgroundBox: boolean;
  boxColor: string;
  durationMode: 'first_seconds' | 'full_clip';
  displaySeconds: number;
}

export type CaptionPreset = 'mrbeast' | 'neon' | 'white-outline' | 'punchy-box';
export type CaptionFont = 'Montserrat' | 'Anton' | 'Poppins';

export interface CaptionStyle {
  preset: CaptionPreset;
  fontFamily: CaptionFont;
  wordsPerLine: number; // 1-5
  size: number; // Reference 1080px base
  positionPercent: number; // Vertical pos (e.g. 76)
  horizontalAlign?: 'left' | 'center' | 'right';
  textColor: string;
  activeWordColor: string;
  strokeColor: string;
  uppercase: boolean;
  autoEmoji: boolean;
  popAnimation: boolean;
}

export interface ClipSettings {
  canvas: CanvasSpec;
  title: TitleStyle;
  caption: CaptionStyle;
}

export interface RenderedClipRecord {
  id: string; // `${videoId}::${clipId}`
  videoId: string;
  clipId: string;
  clipNumber: number;
  title: string;
  category: string;
  viralityScore: number;
  reasons: string[];
  transcriptText: string;
  srtContent: string;
  startTime: number;
  endTime: number;
  duration: number;
  mimeType: string;
  extension: 'mp4' | 'webm';
  captionedBlob: Blob;
  cleanBlob?: Blob;
  qualityLabel: string;
  renderedAt: number;
}
