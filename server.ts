import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, MediaResolution, Type } from '@google/genai';
import { YoutubeTranscript } from 'youtube-transcript';
import {
  CLIP_CATEGORIES,
  ClipCategory,
  FailedTierReport,
  QualityLabel,
  SubtitleWord,
  TranscriptDiagnostics,
  TranscriptSourceTier
} from './src/types.ts';
import { getKeywordEmoji } from './src/utils/emoji.ts';
import {
  cleanTranscriptText,
  groupWordsIntoChunks,
  isNonSpeechTag,
  sanitizeMonotonicWords,
  smoothWordTimings,
  validateAndCleanTranscriptWords
} from './src/utils/subtitleParser.ts';
import {
  buildVideoContextGlossary,
  mergeParallelGeminiChunks,
  ParallelChunkTranscript,
  parseYouTubeJson3,
  repairAndExtractJsonArray,
  splitLineWordsProportionallyByChars,
  validateColabWhisperUrl
} from './src/utils/transcriptUtils.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================================
// Cache & Async Job Store
// ============================================================================
const TRANSCRIPT_CACHE_DIR = path.resolve(__dirname, '.cache', 'transcripts');

interface CachedTranscriptRecord {
  videoId: string;
  language: string;
  sourceUsed: TranscriptSourceTier;
  qualityLabel: QualityLabel;
  detectedLanguage: string;
  keepSoundCues: boolean;
  title: string;
  channelTitle: string;
  description: string;
  thumbnailUrl: string;
  durationSeconds: number;
  rawWords: SubtitleWord[];
  smoothedWords: SubtitleWord[];
  wordCount: number;
  speechCoveragePct: number;
  wpm: number;
  isIncomplete: boolean;
  isSuspiciousWpm: boolean;
  cachedAt: number;
}

const memoryTranscriptCache = new Map<string, CachedTranscriptRecord>();

interface VideoMetaCacheEntry {
  title: string;
  channelTitle: string;
  description: string;
  thumbnailUrl: string;
  durationSeconds: number;
  captionTracks: any[];
  cloudBlocked: boolean;
  blockReason?: string;
  fetchedAt: number;
}
const memoryMetaCache = new Map<string, VideoMetaCacheEntry>();

interface AnalyzeJobRecord {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string;
  result?: any;
  error?: string;
  createdAt: number;
}
const analyzeJobs = new Map<string, AnalyzeJobRecord>();

// Clean up expired jobs older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of analyzeJobs.entries()) {
    if (job.createdAt < cutoff) analyzeJobs.delete(id);
  }
}, 15 * 60 * 1000).unref();

function buildCacheKey(
  videoId: string,
  lang: string,
  source: string,
  keepSoundCues: boolean
): string {
  const cleanPart = (s: string) => (s || 'auto').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  return `${cleanPart(videoId)}__${cleanPart(lang)}__${cleanPart(source)}__${keepSoundCues ? 'cues' : 'nocues'}`;
}

function getConfinedCacheFilePath(cacheKey: string): string {
  const safeName = `${cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
  const resolved = path.resolve(TRANSCRIPT_CACHE_DIR, safeName);
  if (!resolved.startsWith(TRANSCRIPT_CACHE_DIR + path.sep)) {
    throw new Error('Invalid cache path');
  }
  return resolved;
}

async function readTranscriptCache(
  videoId: string,
  lang: string,
  source: string,
  keepSoundCues: boolean
): Promise<CachedTranscriptRecord | null> {
  const key = buildCacheKey(videoId, lang, source, keepSoundCues);
  const mem = memoryTranscriptCache.get(key);
  if (mem && Date.now() - mem.cachedAt < 24 * 60 * 60 * 1000) {
    return mem;
  }
  try {
    const filePath = getConfinedCacheFilePath(key);
    if (!fs.existsSync(filePath)) return null;
    const raw = await fsPromises.readFile(filePath, 'utf-8');
    const parsed: CachedTranscriptRecord = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.rawWords) && parsed.rawWords.length > 0) {
      memoryTranscriptCache.set(key, parsed);
      return parsed;
    }
  } catch {
    // ignore corrupt/missing cache file
  }
  return null;
}

async function writeTranscriptCache(record: CachedTranscriptRecord, lockLang: string): Promise<void> {
  const keys = new Set<string>([
    buildCacheKey(record.videoId, lockLang, record.sourceUsed, record.keepSoundCues),
    buildCacheKey(record.videoId, lockLang, 'auto', record.keepSoundCues)
  ]);
  try {
    await fsPromises.mkdir(TRANSCRIPT_CACHE_DIR, { recursive: true });
    const serialized = JSON.stringify(record);
    for (const k of keys) {
      memoryTranscriptCache.set(k, record);
      const filePath = getConfinedCacheFilePath(k);
      await fsPromises.writeFile(filePath, serialized, 'utf-8');
    }
  } catch (err) {
    console.warn('Cache write warning:', err);
  }
}

export function extractYouTubeId(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/;
  const match = trimmed.match(regExp);
  if (match && match[2].length === 11) {
    return match[2];
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

interface RichWord {
  word: string;
  start: number;
  end: number;
  emoji?: string;
  low_confidence?: boolean;
}

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: RichWord[];
}

interface RawTranscriptItem {
  text: string;
  duration: number;
  offset: number;
}

function groupWordsToTranscriptSegments(words: SubtitleWord[]): TranscriptSegment[] {
  if (!words || words.length === 0) return [];
  const clean = sanitizeMonotonicWords(words);
  const segs: TranscriptSegment[] = [];
  let buf: SubtitleWord[] = [];

  for (let i = 0; i < clean.length; i++) {
    const w = clean[i];
    if (buf.length > 0) {
      const prev = buf[buf.length - 1];
      const gap = w.start - prev.end;
      const endedSentence = /[.!?…]$/.test(prev.word);
      if (gap > 0.45 || endedSentence || buf.length >= 14 || w.end - buf[0].start > 9) {
        segs.push({
          start: buf[0].start,
          end: buf[buf.length - 1].end,
          text: buf.map(x => x.word).join(' '),
          words: buf
        });
        buf = [];
      }
    }
    buf.push(w);
  }
  if (buf.length > 0) {
    segs.push({
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      text: buf.map(x => x.word).join(' '),
      words: buf
    });
  }
  return segs;
}

function normalizeTranscriptSegments(segments: TranscriptSegment[], keepSoundCues = false): TranscriptSegment[] {
  const sorted = [...segments]
    .filter(s => s.text && !isNonSpeechTag(s.text, keepSoundCues))
    .sort((a, b) => a.start - b.start);

  return sorted.map((seg, idx) => {
    const next = sorted[idx + 1];
    let end = Math.max(seg.start + 0.25, seg.end);
    if (next && next.start > seg.start + 0.15 && end > next.start - 0.02) {
      end = Math.max(seg.start + 0.15, parseFloat((next.start - 0.02).toFixed(3)));
    }
    return {
      start: parseFloat(Math.max(0, seg.start).toFixed(3)),
      end: parseFloat(end.toFixed(3)),
      text: cleanTranscriptText(seg.text, keepSoundCues),
      ...(seg.words && seg.words.length > 0 ? { words: seg.words } : {})
    };
  });
}

function parseYouTubeCaptionXml(xml: string, keepSoundCues = false): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];

  const pRegex = /<p\s+([^>]*)>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = pRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const tAttr = attrs.match(/\bt="(\d+)"/);
    const dAttr = attrs.match(/\bd="(\d+)"/);
    if (!tAttr) continue;
    const startMs = parseInt(tAttr[1], 10);
    const durMs = dAttr ? parseInt(dAttr[1], 10) : 2500;
    const segStart = Math.max(0, startMs / 1000);
    const segEnd = Math.max(segStart + 0.25, (startMs + durMs) / 1000);
    const inner = match[2];

    const sTagRegex = /<s(?:\s+[^>]*?t="(\d+)")?[^>]*>([\s\S]*?)<\/s>/g;
    const rawWordTokens: { text: string; startSec: number }[] = [];
    let lastPos = 0;
    let sMatch: RegExpExecArray | null;

    while ((sMatch = sTagRegex.exec(inner)) !== null) {
      if (sMatch.index > lastPos) {
        const leading = cleanTranscriptText(inner.slice(lastPos, sMatch.index), keepSoundCues);
        if (leading) {
          for (const tok of leading.split(/\s+/).filter(Boolean)) {
            rawWordTokens.push({ text: tok, startSec: segStart });
          }
        }
      }
      const offsetMs = sMatch[1] ? parseInt(sMatch[1], 10) : 0;
      const wText = cleanTranscriptText(sMatch[2], keepSoundCues);
      if (wText) {
        for (const tok of wText.split(/\s+/).filter(Boolean)) {
          rawWordTokens.push({
            text: tok,
            startSec: parseFloat((segStart + offsetMs / 1000).toFixed(3))
          });
        }
      }
      lastPos = sMatch.index + sMatch[0].length;
    }

    if (rawWordTokens.length > 0 && lastPos < inner.length) {
      const trailing = cleanTranscriptText(inner.slice(lastPos), keepSoundCues);
      if (trailing) {
        const lastStart = rawWordTokens[rawWordTokens.length - 1].startSec;
        for (const tok of trailing.split(/\s+/).filter(Boolean)) {
          rawWordTokens.push({ text: tok, startSec: lastStart });
        }
      }
    }

    const plainText =
      rawWordTokens.length > 0
        ? rawWordTokens.map(t => t.text).join(' ')
        : cleanTranscriptText(inner, keepSoundCues);

    if (!plainText || isNonSpeechTag(plainText, keepSoundCues)) continue;

    let richWords: RichWord[] | undefined;
    if (rawWordTokens.length > 0) {
      richWords = rawWordTokens.map((tok, i) => {
        const nextStart = rawWordTokens[i + 1]?.startSec ?? segEnd;
        const start = Math.max(segStart, tok.startSec);
        const naturalCap = Math.max(0.20, Math.min(0.85, tok.text.length * 0.068 + 0.16));
        const end = Math.max(start + 0.06, Math.min(segEnd, nextStart, start + naturalCap));
        const emoji = getKeywordEmoji(tok.text);
        return {
          word: tok.text,
          start: parseFloat(start.toFixed(3)),
          end: parseFloat(end.toFixed(3)),
          ...(emoji ? { emoji } : {})
        };
      });
    }

    segments.push({
      start: parseFloat(segStart.toFixed(3)),
      end: parseFloat(segEnd.toFixed(3)),
      text: plainText,
      ...(richWords ? { words: richWords } : {})
    });
  }

  if (segments.length > 0) {
    return normalizeTranscriptSegments(segments, keepSoundCues);
  }

  const classicRegex = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  let cMatch: RegExpExecArray | null;
  while ((cMatch = classicRegex.exec(xml)) !== null) {
    const start = Math.max(0, parseFloat(cMatch[1]) || 0);
    const dur = Math.max(0.25, parseFloat(cMatch[2] || '2.0') || 2.0);
    const text = cleanTranscriptText(cMatch[3], keepSoundCues);
    if (!text || isNonSpeechTag(text, keepSoundCues)) continue;
    segments.push({
      start: parseFloat(start.toFixed(3)),
      end: parseFloat((start + dur).toFixed(3)),
      text,
      words: splitLineWordsProportionallyByChars(text, start, start + dur, keepSoundCues)
    });
  }

  return normalizeTranscriptSegments(segments, keepSoundCues);
}

function extractBalancedJsonObject(text: string, marker: string): any | null {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const braceStart = text.indexOf('{', idx + marker.length);
  if (braceStart === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = braceStart; i < text.length && i < braceStart + 900000; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(braceStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractJsonArrayAfterKey(text: string, keyToken: string): any[] | null {
  const keyIdx = text.indexOf(keyToken);
  if (keyIdx === -1) return null;
  const startBracket = text.indexOf('[', keyIdx + keyToken.length);
  if (startBracket === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startBracket; i < text.length && i < startBracket + 80000; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(startBracket, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function detectYouTubeBlockInText(status: number, bodyText: string): boolean {
  if (status === 403 || status === 429) return true;
  const raw = bodyText || '';
  const lower = raw.toLowerCase();
  const hasHealthyPlayerData =
    raw.includes('"captionTracks"') ||
    (raw.includes('"videoDetails"') && !lower.includes('login_required') && !lower.includes('sign in to confirm you'));
  if (hasHealthyPlayerData) return false;

  return (
    lower.includes('sign in to confirm you') ||
    lower.includes("confirm you're not a bot") ||
    lower.includes('confirm you’re not a bot') ||
    lower.includes('unusual traffic from your computer') ||
    lower.includes('login_required') ||
    (lower.includes('recaptcha') && !lower.includes('videodetails') && !lower.includes('captiontracks'))
  );
}

async function runWithRetryAndBackoff<T>(
  fn: (attemptNum: number) => Promise<T>,
  options: {
    retries?: number;
    delaysMs?: number[];
    shouldRetry?: (err: any) => boolean;
    getDelayMs?: (err: any, attempt: number) => number;
  } = {}
): Promise<T> {
  const retries = options.retries ?? 2;
  const delays = options.delaysMs ?? [1000, 3000];
  let lastErr: any;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: any) {
      lastErr = err;
      const retryable = options.shouldRetry ? options.shouldRetry(err) : true;
      if (!retryable || attempt >= retries) break;
      const fallbackDelay = delays[Math.min(attempt, delays.length - 1)] ?? 1000;
      const waitMs = options.getDelayMs ? options.getDelayMs(err, attempt) : fallbackDelay;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

async function fetchYouTubeVideoContext(videoId: string): Promise<VideoMetaCacheEntry> {
  const cached = memoryMetaCache.get(videoId);
  if (cached && Date.now() - cached.fetchedAt < 30 * 60 * 1000 && cached.captionTracks.length > 0) {
    return cached;
  }

  let title = 'Video YouTube';
  let channelTitle = 'Kanal YouTube';
  let description = '';
  let thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  let durationSeconds = 0;
  let captionTracks: any[] = [];
  const blockSignals: string[] = [];

  const oembedPromise = (async () => {
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const data: any = await res.json();
        if (data?.title) title = String(data.title);
        if (data?.author_name) channelTitle = String(data.author_name);
        if (data?.thumbnail_url) thumbnailUrl = String(data.thumbnail_url);
      }
    } catch {
      // ignore oEmbed failure
    }
  })();

  const watchAndInnertubePromise = (async () => {
    const watchTask = (async () => {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=id`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cookie': 'CONSENT=YES+cb; SOCS=CAI'
        },
        signal: AbortSignal.timeout(8000)
      });
      const html = await res.text();
      if (!res.ok || detectYouTubeBlockInText(res.status, html)) {
        if (res.status === 403 || res.status === 429 || detectYouTubeBlockInText(res.status, html)) {
          blockSignals.push(`YouTube memblokir IP server cloud (HTTP ${res.status} / verifikasi bot).`);
        }
      }
      const playerResp = extractBalancedJsonObject(html, 'var ytInitialPlayerResponse =');
      const vd = playerResp?.videoDetails;
      if (vd) {
        if (vd.title) title = String(vd.title);
        if (vd.author) channelTitle = String(vd.author);
        if (vd.shortDescription) description = String(vd.shortDescription);
        if (vd.lengthSeconds) durationSeconds = Math.max(durationSeconds, Number(vd.lengthSeconds) || 0);
      }
      const tracks =
        playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
        extractJsonArrayAfterKey(html, '"captionTracks":');
      if (Array.isArray(tracks) && tracks.length > 0) {
        captionTracks = tracks;
      }
    })().catch(() => {});

    const innertubeTask = (async () => {
      const clients = [
        {
          ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          client: {
            clientName: 'ANDROID_VR',
            clientVersion: '1.60.19',
            deviceMake: 'Oculus',
            deviceModel: 'Quest 3',
            osName: 'Android',
            osVersion: '12L',
            hl: 'id'
          }
        },
        {
          ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
          client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'id' }
        },
        {
          ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
          client: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2', hl: 'id' }
        }
      ];
      await Promise.all(
        clients.map(async cfg => {
          try {
            const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': cfg.ua
              },
              body: JSON.stringify({ context: { client: cfg.client }, videoId }),
              signal: AbortSignal.timeout(7000)
            });
            if (!r.ok) {
              if (r.status === 403 || r.status === 429) {
                blockSignals.push(`YouTube Innertube menolak permintaan (HTTP ${r.status}).`);
              }
              return;
            }
            const data: any = await r.json();
            if (data?.playabilityStatus?.status === 'LOGIN_REQUIRED') {
              blockSignals.push(
                data?.playabilityStatus?.reason ||
                  'YouTube meminta login / verifikasi anti-bot pada server cloud.'
              );
            }
            const vd = data?.videoDetails;
            if (vd) {
              if (vd.title && title === 'Video YouTube') title = String(vd.title);
              if (vd.author && channelTitle === 'Kanal YouTube') channelTitle = String(vd.author);
              if (vd.shortDescription && !description) description = String(vd.shortDescription);
              if (vd.lengthSeconds && !durationSeconds) durationSeconds = Number(vd.lengthSeconds) || 0;
            }
            const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (Array.isArray(tracks) && tracks.length > 0 && captionTracks.length === 0) {
              captionTracks = tracks;
            }
          } catch {
            // ignore
          }
        })
      );
    })();

    await Promise.all([watchTask, innertubeTask]);

    if (captionTracks.length === 0) {
      try {
        const embRes = await fetch(`https://www.youtube.com/embed/${videoId}`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Cookie': 'CONSENT=YES+cb; SOCS=CAI'
          },
          signal: AbortSignal.timeout(5000)
        });
        const embHtml = await embRes.text();
        const visitorData = embHtml.match(/"visitorData":"([^"]+)"/)?.[1];
        if (visitorData) {
          const retryClients = [
            {
              ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
              client: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', visitorData, hl: 'id' }
            },
            {
              ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
              client: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2', visitorData, hl: 'id' }
            }
          ];
          await Promise.all(
            retryClients.map(async cfg => {
              try {
                const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': cfg.ua,
                    'X-Goog-Visitor-Id': visitorData
                  },
                  body: JSON.stringify({ context: { client: cfg.client }, videoId }),
                  signal: AbortSignal.timeout(5000)
                });
                if (!r.ok) return;
                const d: any = await r.json();
                const vd = d?.videoDetails;
                if (vd) {
                  if (vd.title && title === 'Video YouTube') title = String(vd.title);
                  if (vd.author && channelTitle === 'Kanal YouTube') channelTitle = String(vd.author);
                  if (vd.shortDescription && !description) description = String(vd.shortDescription);
                  if (vd.lengthSeconds && !durationSeconds) durationSeconds = Number(vd.lengthSeconds) || 0;
                }
                const tracks = d?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (Array.isArray(tracks) && tracks.length > 0 && captionTracks.length === 0) {
                  captionTracks = tracks;
                }
              } catch {
                // ignore
              }
            })
          );
        }
      } catch {
        // ignore
      }
    }
  })();

  await Promise.all([oembedPromise, watchAndInnertubePromise]);

  const cloudBlocked = captionTracks.length === 0 && blockSignals.length > 0;
  const blockReason = cloudBlocked ? blockSignals[0] : undefined;

  const entry: VideoMetaCacheEntry = {
    title,
    channelTitle,
    description,
    thumbnailUrl,
    durationSeconds,
    captionTracks,
    cloudBlocked,
    blockReason,
    fetchedAt: Date.now()
  };
  memoryMetaCache.set(videoId, entry);
  return entry;
}

function pickCaptionTrack(
  tracks: any[],
  kindWanted: 'manual' | 'asr',
  preferredLang = 'auto'
): any | null {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const filtered = tracks.filter(t => (kindWanted === 'asr' ? t.kind === 'asr' : t.kind !== 'asr'));
  if (filtered.length === 0) return null;

  const matchesLang = (trackLang: string | undefined, target: string) => {
    if (!trackLang || !target || target === 'auto') return false;
    const lc = trackLang.toLowerCase();
    const tg = target.toLowerCase();
    if (tg === 'id' || tg === 'in') return lc === 'id' || lc.startsWith('id-') || lc === 'in';
    return lc === tg || lc.startsWith(`${tg}-`);
  };

  if (preferredLang && preferredLang !== 'auto') {
    const exact = filtered.find(t => matchesLang(t.languageCode, preferredLang));
    if (exact) return exact;
  }
  return (
    filtered.find(t => matchesLang(t.languageCode, 'id')) ||
    filtered.find(t => matchesLang(t.languageCode, 'en')) ||
    filtered[0]
  );
}

async function downloadTrackWords(
  track: any,
  keepSoundCues = false
): Promise<{ words: SubtitleWord[]; hasPerWordTiming: boolean; languageCode: string }> {
  if (!track?.baseUrl) {
    throw new Error('URL track caption YouTube tidak tersedia.');
  }
  const baseUrl = new URL(track.baseUrl);
  if (!baseUrl.hostname.endsWith('.youtube.com')) {
    throw new Error('Domain track caption YouTube tidak valid.');
  }

  const jsonUrl = new URL(baseUrl.toString());
  jsonUrl.searchParams.set('fmt', 'json3');

  const jsonRes = await fetch(jsonUrl.toString(), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(30000)
  });

  if (jsonRes.ok) {
    const rawBody = await jsonRes.text();
    if (rawBody.trim().startsWith('{')) {
      try {
        const parsedJson = JSON.parse(rawBody);
        const { words, hasPerWordTiming } = parseYouTubeJson3(parsedJson, keepSoundCues);
        if (words.length > 0) {
          return {
            words,
            hasPerWordTiming,
            languageCode: String(track.languageCode || 'id')
          };
        }
      } catch {
        // fallback to srv3 XML
      }
    }
  } else if (jsonRes.status === 403 || jsonRes.status === 429) {
    const err: any = new Error(`YouTube menolak unduhan caption json3 (HTTP ${jsonRes.status}).`);
    err.cloudBlocked = true;
    throw err;
  }

  const srv3Url = new URL(baseUrl.toString());
  srv3Url.searchParams.set('fmt', 'srv3');
  const xmlRes = await fetch(srv3Url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!xmlRes.ok) {
    const err: any = new Error(`Gagal mengunduh caption track (HTTP ${xmlRes.status}).`);
    if (xmlRes.status === 403 || xmlRes.status === 429) err.cloudBlocked = true;
    throw err;
  }
  const xmlText = await xmlRes.text();
  const segs = parseYouTubeCaptionXml(xmlText, keepSoundCues);
  const words: SubtitleWord[] = [];
  for (const s of segs) {
    if (s.words && s.words.length > 0) words.push(...s.words);
    else words.push(...splitLineWordsProportionallyByChars(s.text, s.start, s.end, keepSoundCues));
  }
  if (words.length === 0) {
    throw new Error('Track caption YouTube kosong atau tidak memuat teks dialog.');
  }
  return {
    words: sanitizeMonotonicWords(words),
    hasPerWordTiming: segs.some(s => (s.words?.length ?? 0) > 0),
    languageCode: String(track.languageCode || 'id')
  };
}

// Tier 1: Whisper Colab Server with x-token & async { jobId } + polling GET /job/{id} (plus synchronous JSON compatibility)
async function fetchWhisperColabTranscript(params: {
  whisperUrl: string;
  whisperToken?: string;
  videoId: string;
  language: string;
  prompt: string;
  keepSoundCues: boolean;
  onJobProgress?: (msg: string) => void;
}): Promise<{ words: SubtitleWord[]; detectedLanguage: string }> {
  const urlCheck = validateColabWhisperUrl(params.whisperUrl);
  if (!urlCheck.valid || !urlCheck.url) {
    throw new Error(urlCheck.error || 'URL Whisper tidak valid.');
  }

  const baseUrl = urlCheck.url.replace(/\/+$/, '');
  const youtubeUrl = `https://www.youtube.com/watch?v=${params.videoId}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true'
  };
  if (params.whisperToken && params.whisperToken.trim()) {
    headers['x-token'] = params.whisperToken.trim();
  }

  const initialPayload = await runWithRetryAndBackoff(
    async () => {
      const targetUrl =
        baseUrl.endsWith('/transcribe') || baseUrl.endsWith('/asr') || baseUrl.includes('?')
          ? baseUrl
          : `${baseUrl}/transcribe`;

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url: youtubeUrl,
          language: params.language !== 'auto' ? params.language : undefined,
          prompt: params.prompt || undefined,
          initial_prompt: params.prompt || undefined,
          word_timestamps: true
        }),
        signal: AbortSignal.timeout(45000)
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const e: any = new Error(
          `Server Whisper (Colab) mengembalikan HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 120)}` : ''}`
        );
        e.nonRetryable = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404;
        throw e;
      }
      return res.json();
    },
    {
      retries: 2,
      delaysMs: [1000, 3000],
      shouldRetry: err => !err?.nonRetryable
    }
  );

  let rawJson: any = initialPayload;

  // Support Colab async jobId contract: { jobId } -> poll GET {baseUrl}/job/{id}
  if (initialPayload?.jobId && !Array.isArray(initialPayload?.segments) && !Array.isArray(initialPayload?.words)) {
    const jobId = String(initialPayload.jobId);
    const cleanRoot = baseUrl.replace(/\/(?:transcribe|asr)$/i, '');
    const pollUrl = `${cleanRoot}/job/${encodeURIComponent(jobId)}`;
    const pollHeaders: Record<string, string> = {
      'ngrok-skip-browser-warning': 'true'
    };
    if (params.whisperToken && params.whisperToken.trim()) {
      pollHeaders['x-token'] = params.whisperToken.trim();
    }

    const startedAt = Date.now();
    const maxWaitMs = 5 * 60 * 1000;
    while (Date.now() - startedAt < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const jobData = await runWithRetryAndBackoff(
        async () => {
          const r = await fetch(pollUrl, {
            method: 'GET',
            headers: pollHeaders,
            signal: AbortSignal.timeout(15000)
          });
          if (!r.ok) {
            const err: any = new Error(`Gagal polling job Whisper (HTTP ${r.status})`);
            err.nonRetryable = r.status === 401 || r.status === 403 || r.status === 404;
            throw err;
          }
          return r.json();
        },
        { retries: 2, delaysMs: [1000, 3000], shouldRetry: err => !err?.nonRetryable }
      );

      if (params.onJobProgress && jobData?.message) {
        params.onJobProgress(`Whisper Colab: ${String(jobData.message)}`);
      }
      const st = String(jobData?.status || '').toLowerCase();
      if (st === 'failed' || st === 'error') {
        throw new Error(jobData?.error || 'Proses Whisper di server Colab gagal.');
      }
      if (st === 'completed' || st === 'done' || st === 'finished') {
        rawJson = jobData?.result || jobData;
        break;
      }
    }
  }

  const detectedLang = String(rawJson?.language || (params.language !== 'auto' ? params.language : 'id'));
  const words: SubtitleWord[] = [];

  if (Array.isArray(rawJson?.words) && rawJson.words.length > 0) {
    for (const w of rawJson.words) {
      const txt = cleanTranscriptText(String(w?.word ?? w?.text ?? ''), params.keepSoundCues);
      if (!txt) continue;
      const s = Math.max(0, Number(w?.start ?? 0));
      const e = Math.max(s + 0.06, Number(w?.end ?? s + 0.25));
      for (const tok of txt.split(/\s+/).filter(Boolean)) {
        const emoji = getKeywordEmoji(tok);
        words.push({
          word: tok,
          start: parseFloat(s.toFixed(3)),
          end: parseFloat(e.toFixed(3)),
          ...(typeof w?.probability === 'number' && w.probability < 0.45 ? { low_confidence: true } : {}),
          ...(emoji ? { emoji } : {})
        });
      }
    }
  } else if (Array.isArray(rawJson?.segments) && rawJson.segments.length > 0) {
    for (const seg of rawJson.segments) {
      if (Array.isArray(seg?.words) && seg.words.length > 0) {
        for (const w of seg.words) {
          const txt = cleanTranscriptText(String(w?.word ?? w?.text ?? ''), params.keepSoundCues);
          if (!txt) continue;
          const s = Math.max(0, Number(w?.start ?? seg?.start ?? 0));
          const e = Math.max(s + 0.06, Number(w?.end ?? s + 0.25));
          const emoji = getKeywordEmoji(txt);
          words.push({
            word: txt,
            start: parseFloat(s.toFixed(3)),
            end: parseFloat(e.toFixed(3)),
            ...(typeof w?.probability === 'number' && w.probability < 0.45 ? { low_confidence: true } : {}),
            ...(emoji ? { emoji } : {})
          });
        }
      } else if (typeof seg?.text === 'string' && seg.text.trim()) {
        const segStart = Math.max(0, Number(seg?.start ?? 0));
        const segEnd = Math.max(segStart + 0.25, Number(seg?.end ?? segStart + 2));
        words.push(
          ...splitLineWordsProportionallyByChars(seg.text, segStart, segEnd, params.keepSoundCues)
        );
      }
    }
  }

  if (words.length === 0) {
    throw new Error('Server Whisper tidak mengembalikan daftar kata bertimestamp yang valid.');
  }

  return {
    words: sanitizeMonotonicWords(words),
    detectedLanguage: detectedLang
  };
}

async function runWithConcurrencySettled<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrent = 3
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;

  const workers = Array.from({ length: Math.min(maxConcurrent, tasks.length) }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) break;
      try {
        const value = await tasks[idx]();
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

function isGeminiMediaInvalidError(err: any): boolean {
  const raw = String(err?.message || err || '').toLowerCase();
  return (
    raw.includes('empty, corrupted, or malformed') ||
    raw.includes('unable to process input') ||
    raw.includes('invalid_argument') ||
    (raw.includes('400') && (raw.includes('media') || raw.includes('video') || raw.includes('fileuri') || raw.includes('metadata')))
  );
}

function formatGeminiError(err: any): { status: number; message: string; isTransient: boolean } {
  const raw = String(err?.message || err || '');
  const lower = raw.toLowerCase();

  if (lower.includes('api_key_invalid') || lower.includes('api key not valid') || (raw.includes('400') && lower.includes('api key'))) {
    return {
      status: 400,
      message: 'API Key Gemini tidak valid. Periksa kembali API Key Anda di panel Pengaturan.',
      isTransient: false
    };
  }
  if (lower.includes('empty, corrupted, or malformed') || lower.includes('unable to process input')) {
    return {
      status: 400,
      message:
        'Gemini tidak dapat memproses URL video YouTube ini (video mungkin Privat, Unlisted, Live, dibatasi usia/wilayah, atau gagal dimuat). Pastikan video berstatus Publik atau tempel transkrip/SRT manual.',
      isTransient: false
    };
  }
  if (lower.includes('permission_denied') || raw.includes('403')) {
    return {
      status: 403,
      message: 'API Key Gemini tidak memiliki izin (403). Periksa pengaturan kunci atau proyek API Anda.',
      isTransient: false
    };
  }
  if (lower.includes('resource_exhausted') || raw.includes('429') || lower.includes('quota')) {
    return {
      status: 429,
      message: 'Batas kuota API Gemini tercapai (429). Tunggu sebentar atau gunakan API Key lain.',
      isTransient: true
    };
  }
  if (
    raw.includes('503') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('timeout')
  ) {
    return {
      status: 503,
      message: 'Server AI sedang sibuk sementara (503) atau timeout. Coba ulangi beberapa detik lagi.',
      isTransient: true
    };
  }
  return {
    status: 500,
    message: raw || 'Error tidak diketahui saat menghubungi server AI.',
    isTransient: true
  };
}

interface GeminiAttemptSpec {
  model: string;
  isGemini4: boolean;
  timeoutMs: number;
}

function parseGeminiRetryDelayMs(err: any, fallbackMs = 5000): number {
  const raw = String(err?.message || err || '');
  const secMatch =
    raw.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i) ||
    raw.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (secMatch) {
    const ms = Math.ceil(parseFloat(secMatch[1]) * 1000) + 500;
    return Math.max(2500, Math.min(28000, ms));
  }
  return fallbackMs;
}

async function callGeminiStrictJson(
  ai: GoogleGenAI,
  contents: any,
  options: {
    responseSchema?: any;
    mediaResolution?: MediaResolution;
    timeoutMs?: number;
    temperature?: number;
  } = {}
): Promise<string> {
  const baseTimeout = options.timeoutMs || 45000;
  const attempts: GeminiAttemptSpec[] = [
    { model: 'gemini-3.1-flash-lite', isGemini4: false, timeoutMs: baseTimeout },
    { model: 'gemini-4-hydrogen', isGemini4: true, timeoutMs: Math.round(baseTimeout * 1.15) }
  ];

  let lastErr: any = null;
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i];
    try {
      const config: any = {
        responseMimeType: 'application/json',
        seed: 42
      };
      if (att.isGemini4) {
        // SKILL rule: never pass temperature to gemini-4-* models
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      } else {
        config.temperature = options.temperature ?? 0;
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
      }
      if (options.mediaResolution) {
        config.mediaResolution = options.mediaResolution;
      }
      if (options.responseSchema) {
        config.responseSchema = options.responseSchema;
      }

      const resp = await Promise.race([
        ai.models.generateContent({
          model: att.model,
          contents,
          config
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout dari model ${att.model} (${att.timeoutMs}ms)`)), att.timeoutMs)
        )
      ]);
      if (resp?.text) return resp.text;
      throw new Error(`Respons kosong dari model ${att.model}`);
    } catch (err: any) {
      lastErr = err;
      const info = formatGeminiError(err);
      const rawMsg = String(err?.message || '').toLowerCase();
      const isModelNotFound = rawMsg.includes('404') || rawMsg.includes('not found') || rawMsg.includes('unsupported');
      if (!info.isTransient && !isModelNotFound) {
        throw err;
      }
      if (i < attempts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, info.status === 429 ? 1200 : 800));
      }
    }
  }
  throw lastErr;
}

// Tier 4: Gemini reading public YouTube URL in 8-10 min chunks (5s overlap, max 3 concurrent)
async function transcribeYouTubeUrlWithGeminiChunks(params: {
  ai: GoogleGenAI;
  videoId: string;
  title: string;
  channelTitle: string;
  contextTerms: string[];
  lockLanguage: string;
  totalDurationSec: number;
  keepSoundCues: boolean;
}): Promise<SubtitleWord[]> {
  const CHUNK_SEC = 540; // 9 minutes per chunk
  const OVERLAP_SEC = 5; // 5s overlap
  const youtubeUrl = `https://www.youtube.com/watch?v=${params.videoId}`;

  const sliceWindows: { start: number; end: number; useVideoMetadata: boolean }[] = [];
  if (params.totalDurationSec > CHUNK_SEC) {
    const estTotal = Math.min(params.totalDurationSec, 3600);
    for (let cursor = 0; cursor < estTotal && sliceWindows.length < 7; ) {
      const end = Math.min(estTotal, cursor + CHUNK_SEC);
      sliceWindows.push({ start: cursor, end, useVideoMetadata: true });
      if (end >= estTotal) break;
      cursor = end - OVERLAP_SEC;
    }
  } else {
    sliceWindows.push({
      start: 0,
      end: params.totalDurationSec > 0 ? params.totalDurationSec : 0,
      useVideoMetadata: false
    });
  }

  const chunkSchema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        startSec: { type: Type.NUMBER },
        endSec: { type: Type.NUMBER },
        text: { type: Type.STRING }
      },
      required: ['startSec', 'endSec', 'text']
    }
  };

  const langDirective =
    params.lockLanguage === 'id'
      ? 'Kunci bahasa utama ke Bahasa Indonesia (boleh ada kata Inggris/gaul jika memang terucap, JANGAN membakukan kata seperti "gak" menjadi "tidak", JANGAN menerjemahkan).'
      : params.lockLanguage === 'en'
      ? 'Kunci bahasa utama ke Bahasa Inggris (verbatim persis ucapan pembicara, JANGAN menerjemahkan).'
      : 'Ikuti bahasa asli yang diucapkan pembicara (termasuk bahasa campur dan bahasa gaul apa adanya, JANGAN membakukan dan JANGAN menerjemahkan).';

  const glossaryNote =
    params.contextTerms.length > 0
      ? `Daftar nama orang, merek, dan istilah video: ${params.contextTerms.slice(0, 35).join(', ')}.`
      : '';

  const chunkTasks = sliceWindows.map((win, chunkIndex) => async (): Promise<ParallelChunkTranscript> => {
    const rangeDesc = win.useVideoMetadata
      ? `pada potongan video ini (${win.start}s sampai ${win.end}s)`
      : win.end > 0
      ? `dari seluruh video publik ini (durasi ~${win.end}s)`
      : `dari seluruh video publik ini`;
    const tsRangeHint = win.useVideoMetadata
      ? `${win.start}..${win.end}`
      : win.end > 0
      ? `0..${win.end}`
      : `detik mulai dari 0`;

    const prompt = `Transkrip audio ucapan manusia secara HARFIAH (verbatim) ${rangeDesc}.
Video: "${params.title}" — Kanal: "${params.channelTitle}"
${glossaryNote}

ATURAN WAJIB:
1. ${langDirective}
2. DILARANG merangkum, DILARANG menambah kata, DILARANG memperbaiki tata bahasa, dan DILARANG menebak ucapan yang tak terdengar (kosongkan bagian yang tak terdengar/musik/hening).
3. Pecah ucapan menjadi segmen kalimat/frasa pendek (1.5–4.0 detik) dengan "startSec" dan "endSec" detik video (${tsRangeHint}).
4. Output HANYA JSON array sesuai skema.`;

    const buildVideoPart = (opts: { includeMetadata: boolean; includeMime: boolean }) => {
      const part: any = {
        fileData: opts.includeMime
          ? { fileUri: youtubeUrl, mimeType: 'video/mp4' }
          : { fileUri: youtubeUrl }
      };
      if (opts.includeMetadata && win.useVideoMetadata && win.end > win.start) {
        part.videoMetadata = {
          startOffset: `${win.start}s`,
          endOffset: `${win.end}s`
        };
      }
      return part;
    };

    const callVariant = async (opts: {
      includeMetadata: boolean;
      includeMime: boolean;
      useLowRes: boolean;
    }) => {
      const videoPart = buildVideoPart({ includeMetadata: opts.includeMetadata, includeMime: opts.includeMime });
      const callOpts = {
        responseSchema: chunkSchema,
        ...(opts.useLowRes ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW } : {}),
        timeoutMs: 55000,
        temperature: 0
      };
      const rawText = await callGeminiStrictJson(
        params.ai,
        { parts: [videoPart, { text: prompt }] },
        callOpts
      );
      let arr = repairAndExtractJsonArray(rawText);
      if (!arr) {
        const retryText = await callGeminiStrictJson(
          params.ai,
          {
            parts: [
              videoPart,
              { text: `${prompt}\n\nPENTING: HANYA JSON array yang valid tanpa teks pembuka atau penutup!` }
            ]
          },
          { ...callOpts, timeoutMs: 50000 }
        );
        arr = repairAndExtractJsonArray(retryText);
      }
      if (!arr) throw new Error(`Respons Gemini potongan #${chunkIndex + 1} bukan JSON valid.`);
      return arr;
    };

    const callAndParseWithFallback = async () => {
      const variants: { includeMetadata: boolean; includeMime: boolean; useLowRes: boolean }[] = [
        { includeMetadata: win.useVideoMetadata, includeMime: false, useLowRes: true },
        { includeMetadata: win.useVideoMetadata, includeMime: true, useLowRes: false }
      ];
      if (win.useVideoMetadata && (sliceWindows.length === 1 || chunkIndex === 0)) {
        variants.push({ includeMetadata: false, includeMime: false, useLowRes: false });
        variants.push({ includeMetadata: false, includeMime: true, useLowRes: false });
      }

      let lastVariantErr: any;
      for (let v = 0; v < variants.length; v++) {
        try {
          return await callVariant(variants[v]);
        } catch (err: any) {
          lastVariantErr = err;
          if (!isGeminiMediaInvalidError(err) || v >= variants.length - 1) {
            throw err;
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      throw lastVariantErr;
    };

    if (chunkIndex > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(2500, chunkIndex * 1000)));
    }

    const parsedSegments = await runWithRetryAndBackoff(() => callAndParseWithFallback(), {
      retries: 2,
      delaysMs: [1000, 3000],
      getDelayMs: (err, attempt) => {
        const info = formatGeminiError(err);
        if (info.status === 429) {
          return parseGeminiRetryDelayMs(err, attempt === 0 ? 5000 : 12000);
        }
        return attempt === 0 ? 1000 : 3000;
      },
      shouldRetry: err => {
        const info = formatGeminiError(err);
        const raw = String(err?.message || '').toLowerCase();
        return info.isTransient && !raw.includes('timeout');
      }
    });

    const chunkWords: SubtitleWord[] = [];
    for (const item of parsedSegments) {
      const txt = cleanTranscriptText(String(item?.text ?? ''), params.keepSoundCues);
      if (!txt || isNonSpeechTag(txt, params.keepSoundCues)) continue;
      const s = Math.max(0, Number(item?.startSec ?? item?.start ?? 0));
      const e = Math.max(s + 0.25, Number(item?.endSec ?? item?.end ?? s + 1.5));
      chunkWords.push(...splitLineWordsProportionallyByChars(txt, s, e, params.keepSoundCues));
    }

    return {
      chunkIndex,
      chunkStartSec: win.start,
      chunkEndSec: win.end > 0 ? win.end : 3600,
      words: chunkWords
    };
  });

  const settled = await runWithConcurrencySettled(chunkTasks, 3);
  const succeededChunks: ParallelChunkTranscript[] = [];
  let firstRejectedErr: any = null;
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      succeededChunks.push(s.value);
    } else if (!firstRejectedErr) {
      firstRejectedErr = s.reason;
    }
  }

  if (
    succeededChunks.length === 0 &&
    params.totalDurationSec <= 0 &&
    sliceWindows.length === 1 &&
    !sliceWindows[0].useVideoMetadata &&
    String(firstRejectedErr?.message || '').toLowerCase().includes('timeout')
  ) {
    const recoveryWindows = [
      { start: 0, end: 480 },
      { start: 475, end: 960 }
    ];
    const recoveryTasks = recoveryWindows.map((w, idx) => async (): Promise<ParallelChunkTranscript> => {
      const recPrompt = `Transkrip audio ucapan manusia secara HARFIAH (verbatim) pada potongan video ini (${w.start}s sampai ${w.end}s).
Video: "${params.title}" — Kanal: "${params.channelTitle}"
${glossaryNote}

ATURAN WAJIB:
1. ${langDirective}
2. DILARANG merangkum, DILARANG menambah kata, DILARANG menebak ucapan tak terdengar.
3. Pecah ucapan menjadi segmen frasa pendek dengan "startSec" dan "endSec" detik video (${w.start}..${w.end}).
4. Output HANYA JSON array sesuai skema.`;
      const rawText = await callGeminiStrictJson(
        params.ai,
        {
          parts: [
            {
              fileData: { fileUri: youtubeUrl },
              videoMetadata: { startOffset: `${w.start}s`, endOffset: `${w.end}s` }
            },
            { text: recPrompt }
          ]
        },
        {
          responseSchema: chunkSchema,
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          timeoutMs: 55000,
          temperature: 0
        }
      );
      const arr = repairAndExtractJsonArray(rawText) || [];
      const chunkWords: SubtitleWord[] = [];
      for (const item of arr) {
        const txt = cleanTranscriptText(String(item?.text ?? ''), params.keepSoundCues);
        if (!txt || isNonSpeechTag(txt, params.keepSoundCues)) continue;
        const s = Math.max(0, Number(item?.startSec ?? item?.start ?? 0));
        const e = Math.max(s + 0.25, Number(item?.endSec ?? item?.end ?? s + 1.5));
        chunkWords.push(...splitLineWordsProportionallyByChars(txt, s, e, params.keepSoundCues));
      }
      return { chunkIndex: idx, chunkStartSec: w.start, chunkEndSec: w.end, words: chunkWords };
    });
    const recSettled = await runWithConcurrencySettled(recoveryTasks, 2);
    for (const s of recSettled) {
      if (s.status === 'fulfilled' && s.value.words.length > 0) {
        succeededChunks.push(s.value);
      }
    }
  }

  if (succeededChunks.length === 0) {
    throw firstRejectedErr || new Error('Gemini tidak dapat membaca URL YouTube ini.');
  }

  const merged = mergeParallelGeminiChunks(succeededChunks);
  if (merged.length === 0) {
    throw new Error('Gemini tidak menemukan ucapan dialog pada video publik ini.');
  }
  return merged;
}

function buildWordsForRange(
  allWords: SubtitleWord[],
  startTime: number,
  endTime: number
): RichWord[] {
  const inside = allWords.filter(w => w.end >= startTime - 0.05 && w.start <= endTime + 0.15);
  return sanitizeMonotonicWords(inside);
}

function buildPromptTranscriptBlocks(transcript: TranscriptSegment[]): string {
  if (transcript.length === 0) return '';
  const fmtMin = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  return transcript
    .map(b => `[${b.start.toFixed(2)}s - ${b.end.toFixed(2)}s | ${fmtMin(b.start)}-${fmtMin(b.end)}] ${b.text}`)
    .join('\n');
}

function buildLinesFromWords(words: RichWord[], wordsPerLine = 4) {
  return groupWordsIntoChunks(words, wordsPerLine).map((chunk, idx) => ({
    id: `line-${idx + 1}-${Date.now()}`,
    start: chunk.start,
    end: chunk.end,
    words: chunk.words
  }));
}

// Snap raw Gemini candidate to exact sentence boundaries & apply -0.3s start / +0.4s end padding without crossing adjacent sentences
function snapAndPadClipBoundaries(
  sentences: TranscriptSegment[],
  rawStart: number,
  rawEnd: number,
  targetDuration: number,
  videoMaxDuration: number
): { start: number; end: number } {
  const minDur = Math.max(8, Math.round(targetDuration * 0.8));
  const maxDur = Math.min(180, Math.max(minDur + 4, Math.round(targetDuration * 1.2)));

  if (sentences.length === 0) {
    const s = Math.max(0, rawStart - 0.3);
    const e = Math.min(videoMaxDuration || rawEnd + 0.4, Math.max(s + minDur, rawEnd + 0.4));
    return { start: parseFloat(s.toFixed(2)), end: parseFloat(e.toFixed(2)) };
  }

  let startIdx = 0;
  let bestStartDiff = Infinity;
  for (let i = 0; i < sentences.length; i++) {
    const diff = Math.abs(sentences[i].start - rawStart);
    if (diff < bestStartDiff) {
      bestStartDiff = diff;
      startIdx = i;
    }
  }

  // Pick end sentence index matching rawEnd while keeping duration within ±20% of targetDuration where possible
  let endIdx = startIdx;
  let bestEndScore = Infinity;
  for (let j = startIdx; j < sentences.length; j++) {
    const candDur = sentences[j].end - sentences[startIdx].start;
    if (candDur > maxDur + 12 && j > startIdx) break;
    const rawDiff = Math.abs(sentences[j].end - rawEnd);
    const durPenalty = candDur < minDur || candDur > maxDur ? Math.abs(candDur - targetDuration) * 2.5 : 0;
    const score = rawDiff + durPenalty;
    if (score < bestEndScore) {
      bestEndScore = score;
      endIdx = j;
    }
  }

  const startSent = sentences[startIdx];
  const endSent = sentences[endIdx];
  const prevSent = startIdx > 0 ? sentences[startIdx - 1] : null;
  const nextSent = endIdx < sentences.length - 1 ? sentences[endIdx + 1] : null;

  // Shift start 0.3s earlier, bounded by previous sentence's end (+0.02s buffer)
  const minAllowedStart = prevSent ? prevSent.end + 0.02 : 0;
  const paddedStart = Math.max(0, minAllowedStart, startSent.start - 0.3);

  // Shift end 0.4s later, bounded by next sentence's start (-0.02s buffer) and videoMaxDuration
  const maxAllowedEnd = nextSent
    ? Math.max(endSent.end, nextSent.start - 0.02)
    : videoMaxDuration > 0
    ? videoMaxDuration
    : endSent.end + 0.4;
  const paddedEnd = Math.min(maxAllowedEnd, endSent.end + 0.4);

  return {
    start: parseFloat(paddedStart.toFixed(2)),
    end: parseFloat(Math.max(paddedStart + 3, paddedEnd).toFixed(2))
  };
}

// ============================================================================
// FFmpeg Helpers: Universal MP4 (H.264 + AAC) Conversion
// ============================================================================
function runFfmpeg(args: string[], timeoutMs = 180000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Proses FFmpeg melebihi batas waktu.'));
    }, timeoutMs);

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Gagal menjalankan FFmpeg: ${err.message}`));
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const lastLine =
          stderr
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .slice(-3)
            .join(' | ') || `exit code ${code}`;
        reject(new Error(`FFmpeg gagal (${code}): ${lastLine}`));
      }
    });
  });
}


app.post(
  '/api/convert-to-mp4',
  express.raw({ type: ['video/*', 'application/octet-stream'], limit: '250mb' }),
  async (req, res) => {
    const id = crypto.randomUUID();
    const inPath = path.join(os.tmpdir(), `clipstudio-in-${id}.webm`);
    const outPath = path.join(os.tmpdir(), `clipstudio-out-${id}.mp4`);

    try {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length < 128) {
        return res.status(400).json({ error: 'Berkas video input kosong atau tidak valid.' });
      }
      await fsPromises.writeFile(inPath, buf);

      await runFfmpeg([
        '-y',
        '-i',
        inPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-movflags',
        '+faststart',
        '-shortest',
        outPath
      ]);

      const mp4Buffer = await fsPromises.readFile(outPath);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(mp4Buffer.length));
      return res.send(mp4Buffer);
    } catch (err: any) {
      return res.status(500).json({
        error: `Gagal mengonversi video ke MP4: ${err?.message || 'FFmpeg error'}`
      });
    } finally {
      await Promise.allSettled([fsPromises.unlink(inPath), fsPromises.unlink(outPath)]);
    }
  }
);


// ============================================================================
// Whisper Colab & Video Clip Proxy Endpoints (SSRF Guarded, Zero Token Logging)
// ============================================================================
app.post('/api/whisper/health', async (req, res) => {
  try {
    const whisperUrl = String(req.body?.whisperUrl || '').trim();
    const whisperToken = String(req.body?.whisperToken || req.headers['x-token'] || '').trim();
    const check = validateColabWhisperUrl(whisperUrl);
    if (!check.valid || !check.url) {
      return res.status(400).json({ error: check.error || 'URL server Whisper tidak valid.' });
    }
    const baseUrl = check.url.replace(/\/+$/, '').replace(/\/(?:transcribe|asr|health)$/i, '');
    const headers: Record<string, string> = { 'ngrok-skip-browser-warning': 'true' };
    if (whisperToken) headers['x-token'] = whisperToken;

    const r = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) {
      return res.status(r.status).json({
        error: r.status === 401 || r.status === 403
          ? 'Token Whisper ditolak (401/403). Periksa kembali token Anda.'
          : `Server Whisper mengembalikan HTTP ${r.status}.`
      });
    }
    const data = await r.json().catch(() => ({ status: 'ok' }));
    return res.json({ ok: true, data });
  } catch (err: any) {
    return res.status(502).json({
      error: `Gagal menghubungi server Whisper: ${err?.message || 'Koneksi timeout / ditolak.'}`
    });
  }
});

async function extractColabResponseError(r: globalThis.Response): Promise<string> {
  const txt = await r.text().catch(() => '');
  if (txt) {
    try {
      const parsed = JSON.parse(txt);
      const raw = parsed?.detail || parsed?.error || parsed?.message;
      if (typeof raw === 'string' && raw.trim()) {
        return raw.trim();
      }
      if (raw && typeof raw === 'object') {
        return JSON.stringify(raw);
      }
    } catch {
      // plain text response from Colab
    }
    return txt.trim().slice(0, 600);
  }
  return `Server Colab mengembalikan HTTP ${r.status}`;
}

app.post('/api/colab/clip', async (req, res) => {
  try {
    const whisperUrl = String(req.body?.whisperUrl || '').trim();
    const whisperToken = String(req.body?.whisperToken || req.headers['x-token'] || '').trim();
    const url = String(req.body?.url || '').trim();
    const start = Number(req.body?.start);
    const end = Number(req.body?.end);

    const check = validateColabWhisperUrl(whisperUrl);
    if (!check.valid || !check.url) {
      return res.status(400).json({ error: check.error || 'URL Colab tidak valid.' });
    }
    if (!url || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return res.status(400).json({ error: 'Parameter url/start/end klip Colab tidak valid.' });
    }

    const baseUrl = check.url.replace(/\/+$/, '').replace(/\/(?:transcribe|asr|health)$/i, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true'
    };
    if (whisperToken) headers['x-token'] = whisperToken;

    const r = await fetch(`${baseUrl}/clip`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, start, end }),
      signal: AbortSignal.timeout(25000)
    });
    if (!r.ok) {
      const rawMsg = await extractColabResponseError(r);
      return res.status(r.status).json({ error: rawMsg });
    }
    const data = await r.json();
    return res.json(data);
  } catch (err: any) {
    return res.status(502).json({
      error: `Gagal mengirim tugas potong video ke Colab: ${err?.message || 'Timeout / tidak terjangkau'}`
    });
  }
});

app.get('/api/colab/job/:jobId', async (req, res) => {
  try {
    const whisperUrl = String(req.headers['x-whisper-url'] || '').trim();
    const whisperToken = String(req.headers['x-token'] || '').trim();
    const check = validateColabWhisperUrl(whisperUrl);
    if (!check.valid || !check.url) {
      return res.status(400).json({ error: check.error || 'URL Colab tidak valid.' });
    }
    const baseUrl = check.url.replace(/\/+$/, '').replace(/\/(?:transcribe|asr|health)$/i, '');
    const headers: Record<string, string> = { 'ngrok-skip-browser-warning': 'true' };
    if (whisperToken) headers['x-token'] = whisperToken;

    const r = await fetch(`${baseUrl}/job/${encodeURIComponent(req.params.jobId)}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) {
      const rawMsg = await extractColabResponseError(r);
      return res.status(r.status).json({ error: rawMsg });
    }
    const data = await r.json();
    return res.json(data);
  } catch (err: any) {
    return res.status(502).json({ error: `Gagal polling status job Colab: ${err?.message || 'Error koneksi'}` });
  }
});

app.get('/api/colab/file/:jobId', async (req, res) => {
  try {
    const whisperUrl = String(req.headers['x-whisper-url'] || '').trim();
    const whisperToken = String(req.headers['x-token'] || '').trim();
    const check = validateColabWhisperUrl(whisperUrl);
    if (!check.valid || !check.url) {
      return res.status(400).json({ error: check.error || 'URL Colab tidak valid.' });
    }
    const baseUrl = check.url.replace(/\/+$/, '').replace(/\/(?:transcribe|asr|health)$/i, '');
    const headers: Record<string, string> = { 'ngrok-skip-browser-warning': 'true' };
    if (whisperToken) headers['x-token'] = whisperToken;

    const r = await fetch(`${baseUrl}/file/${encodeURIComponent(req.params.jobId)}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(120000)
    });
    if (!r.ok) {
      const rawMsg = await extractColabResponseError(r);
      return res.status(r.status).json({ error: rawMsg });
    }
    const ct = r.headers.get('content-type') || 'video/mp4';
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Length', String(buf.length));
    return res.send(buf);
  } catch (err: any) {
    return res.status(502).json({ error: `Gagal mengunduh berkas klip dari Colab: ${err?.message || 'Error jaringan'}` });
  }
});

// ============================================================================
// Main Async Pipeline: POST /api/analyze & GET /api/analyze/:jobId
// ============================================================================
async function executeAnalyzePipeline(
  jobId: string,
  payload: {
    videoId: string;
    apiKey: string;
    durasi: number;
    jumlah: number;
    perKategori: number;
    kategori: ClipCategory[];
    whisperUrl: string;
    whisperToken: string;
    keepSoundCues: boolean;
    language: string;
    manualCues?: { start: number; end: number; text: string }[];
    manualSourceTier?: TranscriptSourceTier;
    forceSource: 'auto' | 'whisper' | 'youtube' | 'gemini';
    bypassCache: boolean;
  }
) {
  const job = analyzeJobs.get(jobId);
  if (!job) return;

  const updateJob = (patch: Partial<AnalyzeJobRecord>) => {
    const current = analyzeJobs.get(jobId);
    if (current) Object.assign(current, patch);
  };

  const totalStartMs = Date.now();
  const {
    videoId,
    apiKey,
    durasi,
    jumlah,
    perKategori,
    kategori,
    whisperUrl,
    whisperToken,
    keepSoundCues,
    language,
    manualCues,
    manualSourceTier,
    forceSource,
    bypassCache
  } = payload;

  try {
    updateJob({ status: 'processing', progress: 8, message: 'Mengambil informasi & metadata video YouTube...' });

    const lockLanguage = ['id', 'en'].includes(language.toLowerCase()) ? language.toLowerCase() : 'auto';
    const targetDuration = Math.max(10, Math.min(180, durasi || 60));
    const targetCount = Math.max(1, Math.min(20, jumlah || 6));
    const maxPerCategory = Math.max(1, Math.min(20, perKategori || 2));
    const selectedCategories: ClipCategory[] =
      Array.isArray(kategori) && kategori.length > 0 ? kategori : [...CLIP_CATEGORIES];

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });

    const timingsMs: TranscriptDiagnostics['timingsMs'] = {};
    const failedTiers: FailedTierReport[] = [];
    let cloudBlockedHint = false;

    const metaStart = Date.now();
    const metaPromise = fetchYouTubeVideoContext(videoId).then(m => {
      timingsMs.metadata = Date.now() - metaStart;
      if (m.cloudBlocked) cloudBlockedHint = true;
      return m;
    });

    const hasManualInput = Array.isArray(manualCues) && manualCues.length > 0;
    let cachedHitRecord: CachedTranscriptRecord | null = null;
    if (!hasManualInput && !bypassCache) {
      const lookupTier =
        forceSource === 'whisper'
          ? ['whisper']
          : forceSource === 'youtube'
          ? ['youtube_manual', 'youtube_auto_json3', 'youtube_auto_fallback']
          : forceSource === 'gemini'
          ? ['gemini_url']
          : ['auto'];
      for (const t of lookupTier) {
        cachedHitRecord = await readTranscriptCache(videoId, lockLanguage, t, keepSoundCues);
        if (cachedHitRecord) break;
      }
    }

    let rawWords: SubtitleWord[] = [];
    let smoothedWords: SubtitleWord[] = [];
    let sourceUsed: TranscriptSourceTier = 'youtube_auto_json3';
    let qualityLabel: QualityLabel = 'Akurasi sedang (caption otomatis YouTube)';
    let detectedLanguage = lockLanguage === 'auto' ? 'id' : lockLanguage;
    let wordCount = 0;
    let speechCoveragePct = 0;
    let wpm = 0;
    let isIncomplete = false;
    let isSuspiciousWpm = false;
    let cacheHit = false;

    let title = 'Video YouTube';
    let channelTitle = 'Kanal YouTube';
    let description = '';
    let thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    let durationSeconds = 0;

    if (hasManualInput) {
      updateJob({ progress: 25, message: 'Memproses transkrip / SRT tempelan...' });
      const meta = await metaPromise;
      title = meta.title;
      channelTitle = meta.channelTitle;
      description = meta.description;
      thumbnailUrl = meta.thumbnailUrl;
      durationSeconds = meta.durationSeconds;

      const assembled: SubtitleWord[] = [];
      for (const c of manualCues!) {
        if (typeof c?.text !== 'string' || !c.text.trim()) continue;
        const s = Math.max(0, Number(c.start) || 0);
        const e = Math.max(s + 0.25, Number(c.end) || s + 1.5);
        assembled.push(...splitLineWordsProportionallyByChars(c.text, s, e, keepSoundCues));
      }
      const val = validateAndCleanTranscriptWords(assembled, durationSeconds, {
        keepSoundCues,
        requireCompleteCoverage: false
      });
      if (val.validWords.length === 0) {
        updateJob({
          status: 'failed',
          progress: 100,
          error: 'Teks atau file SRT yang ditempel tidak berisi kalimat yang valid.'
        });
        return;
      }

      rawWords = val.validWords;
      smoothedWords = smoothWordTimings(rawWords);
      wordCount = val.wordCount;
      speechCoveragePct = val.speechCoveragePct;
      wpm = val.wpm;
      isIncomplete = val.isIncomplete;
      isSuspiciousWpm = val.isSuspiciousWpm;
      sourceUsed = manualSourceTier === 'manual_paste_plain' ? 'manual_paste_plain' : 'manual_paste_srt';
      qualityLabel =
        sourceUsed === 'manual_paste_plain'
          ? 'Perkiraan (Gemini/timing dibagi rata)'
          : 'Akurasi baik (caption manual)';
    } else if (cachedHitRecord) {
      updateJob({ progress: 42, message: 'Memuat transkrip tersimpan dari cache...' });
      const meta = await metaPromise;
      title = cachedHitRecord.title || meta.title;
      channelTitle = cachedHitRecord.channelTitle || meta.channelTitle;
      description = cachedHitRecord.description || meta.description;
      thumbnailUrl = cachedHitRecord.thumbnailUrl || meta.thumbnailUrl;
      durationSeconds = cachedHitRecord.durationSeconds || meta.durationSeconds;
      rawWords = cachedHitRecord.rawWords;
      smoothedWords = cachedHitRecord.smoothedWords;
      sourceUsed = cachedHitRecord.sourceUsed;
      qualityLabel = cachedHitRecord.qualityLabel;
      detectedLanguage = cachedHitRecord.detectedLanguage;
      wordCount = cachedHitRecord.wordCount;
      speechCoveragePct = cachedHitRecord.speechCoveragePct;
      wpm = cachedHitRecord.wpm;
      isIncomplete = cachedHitRecord.isIncomplete;
      isSuspiciousWpm = cachedHitRecord.isSuspiciousWpm;
      cacheHit = true;
    } else {
      const cleanWhisperUrl = whisperUrl.trim();
      const shouldTryWhisper = Boolean(cleanWhisperUrl) && (forceSource === 'auto' || forceSource === 'whisper');

      let whisperPromise: Promise<{ words: SubtitleWord[]; detectedLanguage: string } | null> | null = null;
      if (shouldTryWhisper) {
        updateJob({ progress: 18, message: 'Menghubungkan ke server Whisper (Colab)...' });
        const initialCtx = buildVideoContextGlossary('', '', '', '', 180);
        whisperPromise = (async () => {
          const wStart = Date.now();
          try {
            const res = await fetchWhisperColabTranscript({
              whisperUrl: cleanWhisperUrl,
              whisperToken,
              videoId,
              language: lockLanguage,
              prompt: initialCtx.initialPrompt,
              keepSoundCues,
              onJobProgress: msg => updateJob({ progress: 26, message: msg })
            });
            timingsMs.whisper = Date.now() - wStart;
            return res;
          } catch (err: any) {
            timingsMs.whisper = Date.now() - wStart;
            failedTiers.push({
              tier: 'Server Whisper (Colab)',
              reason: err?.message || 'Gagal terhubung ke server Whisper Colab.',
              durationMs: timingsMs.whisper
            });
            return null;
          }
        })();
      }

      const meta = await metaPromise;
      title = meta.title;
      channelTitle = meta.channelTitle;
      description = meta.description;
      thumbnailUrl = meta.thumbnailUrl;
      durationSeconds = meta.durationSeconds;
      const glossary = buildVideoContextGlossary(title, channelTitle, description, '', 195);

      const partialHolder: {
        backup: {
          words: SubtitleWord[];
          sourceUsed: TranscriptSourceTier;
          qualityLabel: QualityLabel;
          detectedLanguage: string;
          report: ReturnType<typeof validateAndCleanTranscriptWords>;
        } | null;
      } = { backup: null };

      const tryAcceptResult = (
        candidateWords: SubtitleWord[],
        tierName: string,
        tierCode: TranscriptSourceTier,
        label: QualityLabel,
        lang: string,
        elapsedMs: number
      ): boolean => {
        const val = validateAndCleanTranscriptWords(candidateWords, durationSeconds, {
          keepSoundCues,
          requireCompleteCoverage: true
        });
        if (val.passed) {
          rawWords = val.validWords;
          smoothedWords = smoothWordTimings(rawWords);
          sourceUsed = tierCode;
          qualityLabel = label;
          detectedLanguage = lang;
          wordCount = val.wordCount;
          speechCoveragePct = val.speechCoveragePct;
          wpm = val.wpm;
          isIncomplete = val.isIncomplete;
          isSuspiciousWpm = val.isSuspiciousWpm;
          return true;
        }
        if (val.validWords.length > 0 && (!partialHolder.backup || val.validWords.length > partialHolder.backup.words.length)) {
          partialHolder.backup = {
            words: val.validWords,
            sourceUsed: tierCode,
            qualityLabel: label,
            detectedLanguage: lang,
            report: val
          };
        }
        failedTiers.push({
          tier: tierName,
          reason: val.failureReason || 'Hasil tidak lolos validasi kelengkapan transkrip (>=60%).',
          durationMs: elapsedMs
        });
        return false;
      };

      let resolved = false;

      // TIER 1: Whisper (Colab)
      if (whisperPromise) {
        const wRes = await whisperPromise;
        if (wRes) {
          resolved = tryAcceptResult(
            wRes.words,
            'Server Whisper (Colab)',
            'whisper',
            'Akurasi tinggi (Whisper)',
            wRes.detectedLanguage,
            timingsMs.whisper || 0
          );
        }
      }

      // TIER 2: YouTube Manual Captions
      if (!resolved && (forceSource === 'auto' || forceSource === 'youtube')) {
        updateJob({ progress: 30, message: 'Memeriksa caption manual YouTube...' });
        const tStart = Date.now();
        const manualTrack = pickCaptionTrack(meta.captionTracks, 'manual', lockLanguage);
        if (manualTrack) {
          try {
            const dl = await runWithRetryAndBackoff(
              () => downloadTrackWords(manualTrack, keepSoundCues),
              { retries: 2, delaysMs: [1000, 3000], shouldRetry: err => !err?.cloudBlocked }
            );
            const elapsed = Date.now() - tStart;
            timingsMs.captions = (timingsMs.captions || 0) + elapsed;
            resolved = tryAcceptResult(
              dl.words,
              'Caption Manual YouTube',
              'youtube_manual',
              'Akurasi baik (caption manual)',
              lockLanguage !== 'auto' ? lockLanguage : dl.languageCode,
              elapsed
            );
          } catch (err: any) {
            const elapsed = Date.now() - tStart;
            timingsMs.captions = (timingsMs.captions || 0) + elapsed;
            if (err?.cloudBlocked) cloudBlockedHint = true;
            failedTiers.push({
              tier: 'Caption Manual YouTube',
              reason: err?.message || 'Gagal mengunduh caption manual YouTube.',
              durationMs: elapsed,
              cloudBlocked: Boolean(err?.cloudBlocked)
            });
          }
        } else {
          const elapsed = Date.now() - tStart;
          const hasAnyTracks = meta.captionTracks.length > 0;
          failedTiers.push({
            tier: 'Caption Manual YouTube',
            reason:
              !hasAnyTracks && meta.cloudBlocked
                ? meta.blockReason || 'Server cloud diblokir YouTube sehingga caption manual tidak terbaca.'
                : 'Video ini tidak memiliki caption manual.',
            durationMs: elapsed,
            cloudBlocked: !hasAnyTracks && meta.cloudBlocked
          });
        }
      }

      // TIER 3: YouTube Auto Captions (json3 -> youtube-transcript fallback)
      if (!resolved && (forceSource === 'auto' || forceSource === 'youtube')) {
        updateJob({ progress: 38, message: 'Mengambil caption otomatis YouTube (json3)...' });
        const tStart = Date.now();
        const asrTrack = pickCaptionTrack(meta.captionTracks, 'asr', lockLanguage);
        let asrFailed = false;

        if (asrTrack) {
          try {
            const dl = await runWithRetryAndBackoff(
              () => downloadTrackWords(asrTrack, keepSoundCues),
              { retries: 2, delaysMs: [1000, 3000], shouldRetry: err => !err?.cloudBlocked }
            );
            const elapsed = Date.now() - tStart;
            timingsMs.captions = (timingsMs.captions || 0) + elapsed;
            resolved = tryAcceptResult(
              dl.words,
              'Caption Otomatis YouTube (json3)',
              dl.hasPerWordTiming ? 'youtube_auto_json3' : 'youtube_auto_fallback',
              'Akurasi sedang (caption otomatis YouTube)',
              lockLanguage !== 'auto' ? lockLanguage : dl.languageCode,
              elapsed
            );
          } catch (err: any) {
            asrFailed = true;
            const elapsed = Date.now() - tStart;
            timingsMs.captions = (timingsMs.captions || 0) + elapsed;
            if (err?.cloudBlocked) cloudBlockedHint = true;
            failedTiers.push({
              tier: 'Caption Otomatis YouTube (json3)',
              reason: err?.message || 'Gagal mengunduh caption otomatis json3.',
              durationMs: elapsed,
              cloudBlocked: Boolean(err?.cloudBlocked)
            });
          }
        } else {
          asrFailed = true;
        }

        if (!resolved && (asrFailed || !asrTrack)) {
          const ytLibStart = Date.now();
          try {
            const langList =
              lockLanguage !== 'auto' ? [{ lang: lockLanguage }] : [{ lang: 'id' }, { lang: 'en' }, undefined];
            let items: RawTranscriptItem[] = [];
            let lastYtErr = '';
            for (const cfg of langList) {
              try {
                const resItems = await Promise.race([
                  YoutubeTranscript.fetchTranscript(videoId, cfg),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout mengambil youtube-transcript')), 12000)
                  )
                ]);
                if (Array.isArray(resItems) && resItems.length > 0) {
                  items = resItems as RawTranscriptItem[];
                  break;
                }
              } catch (e: any) {
                lastYtErr = String(e?.message || e || '');
              }
            }
            if (items.length === 0) {
              const errLower = lastYtErr.toLowerCase();
              const rawDisabled = errLower.includes('disabled') || errLower.includes('not available');
              const isBlocked = meta.cloudBlocked || detectYouTubeBlockInText(0, lastYtErr) || errLower.includes('too many requests');
              const isDisabled = !isBlocked && rawDisabled;
              const err: any = new Error(
                isBlocked
                  ? 'YouTube memblokir pengambilan caption dari IP server cloud.'
                  : isDisabled
                  ? 'Caption otomatis YouTube tidak tersedia atau dinonaktifkan.'
                  : lastYtErr || 'Track caption otomatis YouTube tidak tersedia.'
              );
              err.cloudBlocked = isBlocked;
              throw err;
            }
            const sortedDurations = items.map(i => Number(i.duration) || 0).sort((a, b) => a - b);
            const medianDur = sortedDurations[Math.floor(sortedDurations.length / 2)] || 0;
            const divisor = medianDur > 100 ? 1000 : 1;

            const fallbackWords: SubtitleWord[] = [];
            for (const it of items) {
              const s = Math.max(0, (Number(it.offset) || 0) / divisor);
              const d = Math.max(0.25, (Number(it.duration) || 0) / divisor);
              fallbackWords.push(...splitLineWordsProportionallyByChars(it.text, s, s + d, keepSoundCues));
            }
            const elapsed = Date.now() - ytLibStart;
            timingsMs.captions = (timingsMs.captions || 0) + elapsed;
            resolved = tryAcceptResult(
              fallbackWords,
              'Caption Otomatis YouTube (fallback baris)',
              'youtube_auto_fallback',
              'Akurasi sedang (caption otomatis YouTube)',
              lockLanguage !== 'auto' ? lockLanguage : 'id',
              elapsed
            );
          } catch (err: any) {
            const elapsed = Date.now() - ytLibStart;
            timingsMs.captions = (timingsMs.captions || 0) + elapsed;
            const msg = String(err?.message || '');
            const blocked = Boolean(err?.cloudBlocked);
            if (blocked) cloudBlockedHint = true;
            failedTiers.push({
              tier: 'Caption Otomatis YouTube',
              reason: msg || 'Caption otomatis YouTube tidak dapat diambil.',
              durationMs: elapsed,
              cloudBlocked: blocked
            });
          }
        }
      }

      // TIER 4: Gemini Reading Public YouTube URL (8-10m chunks, 5s overlap, max 3 parallel)
      if (!resolved && (forceSource === 'auto' || forceSource === 'gemini')) {
        updateJob({ progress: 50, message: 'Mentranskrip video YouTube via Gemini (potongan paralel)...' });
        const gStart = Date.now();
        try {
          const gWords = await transcribeYouTubeUrlWithGeminiChunks({
            ai,
            videoId,
            title,
            channelTitle,
            contextTerms: glossary.terms,
            lockLanguage,
            totalDurationSec: durationSeconds,
            keepSoundCues
          });
          const elapsed = Date.now() - gStart;
          timingsMs.geminiTranscribe = elapsed;
          resolved = tryAcceptResult(
            gWords,
            'Gemini URL YouTube',
            'gemini_url',
            'Perkiraan (Gemini/timing dibagi rata)',
            lockLanguage !== 'auto' ? lockLanguage : 'id',
            elapsed
          );
        } catch (err: any) {
          const elapsed = Date.now() - gStart;
          timingsMs.geminiTranscribe = elapsed;
          const formatted = formatGeminiError(err);
          failedTiers.push({
            tier: 'Gemini URL YouTube',
            reason: formatted.message || err?.message || 'Gemini gagal membaca URL YouTube.',
            durationMs: elapsed
          });
        }
      }

      if (!resolved && partialHolder.backup) {
        const pb = partialHolder.backup;
        rawWords = pb.words;
        smoothedWords = smoothWordTimings(rawWords);
        sourceUsed = pb.sourceUsed;
        qualityLabel = pb.qualityLabel;
        detectedLanguage = pb.detectedLanguage;
        wordCount = pb.report.wordCount;
        speechCoveragePct = pb.report.speechCoveragePct;
        wpm = pb.report.wpm;
        isIncomplete = pb.report.isIncomplete;
        isSuspiciousWpm = pb.report.isSuspiciousWpm;
        resolved = true;
      }

      if (!resolved || rawWords.length === 0) {
        const summaryReasons = failedTiers.map(f => `• ${f.tier}: ${f.reason}`).join('\n');
        const advice = cloudBlockedHint
          ? ' Server cloud terdeteksi diblokir YouTube — hubungkan server Whisper Colab atau tempel transkrip/SRT secara manual.'
          : ' Silakan tempel transkrip atau file SRT bertimestamp di kotak cadangan pada Langkah 1.';
        updateJob({
          status: 'failed',
          progress: 100,
          error: `Semua sumber transkrip otomatis gagal.${advice}\n${summaryReasons}`
        });
        return;
      }

      await writeTranscriptCache(
        {
          videoId,
          language: detectedLanguage,
          sourceUsed,
          qualityLabel,
          detectedLanguage,
          keepSoundCues,
          title,
          channelTitle,
          description,
          thumbnailUrl,
          durationSeconds,
          rawWords,
          smoothedWords,
          wordCount,
          speechCoveragePct,
          wpm,
          isIncomplete,
          isSuspiciousWpm,
          cachedAt: Date.now()
        },
        lockLanguage
      );
    }

    // Stage 2: Gemini Clip Selection with Category Quota & Sentence Boundary Padding
    updateJob({ progress: 72, message: 'Memilih kandidat klip terbaik per kategori dengan Gemini...' });
    const selStart = Date.now();

    const transcriptSegments = groupWordsToTranscriptSegments(smoothedWords);
    const transcriptMinStart = transcriptSegments.length > 0 ? transcriptSegments[0].start : 0;
    const videoTotalDuration = Math.max(
      durationSeconds,
      transcriptSegments.length > 0 ? transcriptSegments[transcriptSegments.length - 1].end : targetDuration
    );

    const effectiveTargetDuration = Math.min(
      targetDuration,
      Math.max(10, Math.round(videoTotalDuration - transcriptMinStart))
    );
    const minPromptDur = Math.max(8, Math.round(effectiveTargetDuration * 0.8));
    const maxPromptDur = Math.min(180, Math.max(minPromptDur + 2, Math.round(effectiveTargetDuration * 1.2)));
    const candidatePoolCount = Math.min(36, Math.max(targetCount * 2, selectedCategories.length * 2));

    const formattedBlocks = buildPromptTranscriptBlocks(transcriptSegments);

    const selectionPrompt = `Anda adalah kurator video short-form profesional.
Tugas: analisis transkrip bertimestamp berikut dan pilih sekitar ${candidatePoolCount} kandidat klip terbaik (target akhir ${targetCount} klip, maksimal ${maxPerCategory} per kategori).

INFORMASI VIDEO:
- Judul: "${title}"
- Channel: "${channelTitle}"
- Rentang waktu tersedia: ${transcriptMinStart.toFixed(1)}s sampai ${videoTotalDuration.toFixed(1)}s

KATEGORI YANG DIIZINKAN (WAJIB pilih salah satu persis dari daftar ini):
${selectedCategories.map(c => `- "${c}"`).join('\n')}

ATURAN KETAT PEMILIHAN KLIP:
1. Durasi setiap klip sekitar ${effectiveTargetDuration} detik (rentang ${minPromptDur}–${maxPromptDur} detik).
2. Kandidat tidak saling tumpang tindih satu sama lain.
3. Setiap klip HARUS berdiri sendiri (memiliki pembuka, isi, dan penutup yang utuh, tidak terpotong di tengah kalimat atau pembahasan).
4. Mulailah tepat di awal kalimat ("startTime") dan akhiri tepat di akhir kalimat ("endTime") berdasarkan timestamp kalimat di transkrip.
5. Dasar penilaian skor ("viralityScore" 0–100, adalah estimasi): kekuatan hook pada 3 detik pertama, kekuatan emosi, kebaruan informasi, dan kelengkapan cerita.
6. Field wajib tiap item:
   - "title": judul hook maksimal 8 kata yang menarik perhatian (Bahasa Indonesia).
   - "startTime": detik mulai awal kalimat.
   - "endTime": detik selesai akhir kalimat.
   - "category": salah satu string persis dari daftar kategori yang diizinkan.
   - "viralityScore": bilangan bulat 0–100.
   - "reasons": array tepat 3 alasan singkat dalam Bahasa Indonesia.
   - "summary": ringkasan 1 kalimat isi klip dalam Bahasa Indonesia.

TRANSKRIP KALIMAT BERTIMESTAMP:
${formattedBlocks.slice(0, 60000)}`;

    const clipSelectionSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
          category: { type: Type.STRING, enum: selectedCategories },
          viralityScore: { type: Type.INTEGER },
          reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
          summary: { type: Type.STRING }
        },
        required: ['title', 'startTime', 'endTime', 'category', 'viralityScore', 'reasons', 'summary']
      }
    };

    let rawCandidates: any[] = [];
    try {
      const respText = await callGeminiStrictJson(ai, selectionPrompt, {
        responseSchema: clipSelectionSchema,
        timeoutMs: 40000,
        temperature: 0.15
      });
      rawCandidates = repairAndExtractJsonArray(respText) || [];
    } catch (selErr: any) {
      const info = formatGeminiError(selErr);
      updateJob({
        status: 'failed',
        progress: 100,
        error: `Gemini gagal memilih klip: ${info.message}`
      });
      return;
    }

    if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
      updateJob({
        status: 'failed',
        progress: 100,
        error: 'Gemini tidak mengembalikan kandidat klip yang valid dari transkrip ini.'
      });
      return;
    }

    timingsMs.clipSelection = Date.now() - selStart;
    updateJob({ progress: 90, message: 'Menyelaraskan batas kalimat, membuang tumpang tindih, & mengatur kategori...' });

    // Normalize category & apply -0.3s start / +0.4s end sentence padding without crossing neighboring sentences
    const normalizedCandidates = rawCandidates.map((raw, idx) => {
      const rawStart = Math.max(transcriptMinStart, Number(raw?.startTime) || transcriptMinStart);
      const rawEnd = Math.max(rawStart + 3, Number(raw?.endTime) || rawStart + effectiveTargetDuration);
      const snapped = snapAndPadClipBoundaries(
        transcriptSegments,
        rawStart,
        rawEnd,
        effectiveTargetDuration,
        videoTotalDuration
      );

      const rawCat = String(raw?.category || '').trim();
      const matchedCat =
        selectedCategories.find(c => c.toLowerCase() === rawCat.toLowerCase()) ||
        selectedCategories[idx % selectedCategories.length];

      const rawTitleWords = String(raw?.title || '').trim().split(/\s+/).filter(Boolean);
      const hookTitle =
        rawTitleWords.length > 0
          ? rawTitleWords.slice(0, 8).join(' ')
          : `Klip #${idx + 1}`;

      const score = Math.min(100, Math.max(0, Math.round(Number(raw?.viralityScore) || 70)));
      const reasons =
        Array.isArray(raw?.reasons) && raw.reasons.length > 0
          ? raw.reasons.slice(0, 3).map((r: any) => String(r).trim()).filter(Boolean)
          : ['Hook pembuka kuat di 3 detik awal', 'Pembahasan utuh dan berdiri sendiri', 'Relevan untuk video vertikal pendek'];

      return {
        tempIdx: idx,
        title: hookTitle,
        startTime: snapped.start,
        endTime: snapped.end,
        duration: parseFloat((snapped.end - snapped.start).toFixed(2)),
        viralityScore: score,
        category: matchedCat,
        reasons,
        summary: String(raw?.summary || '').trim(),
        hookText: hookTitle
      };
    });

    // Remove overlapping clips (strictly keep highest viralityScore)
    const sortedByScore = [...normalizedCandidates].sort((a, b) => b.viralityScore - a.viralityScore);
    const nonOverlapping: typeof normalizedCandidates = [];
    for (const cand of sortedByScore) {
      const overlaps = nonOverlapping.some(
        kept => Math.min(kept.endTime, cand.endTime) - Math.max(kept.startTime, cand.startTime) > 0.1
      );
      if (!overlaps) {
        nonOverlapping.push(cand);
      }
    }

    // Category allocation:
    // 1. Every selected category gets its highest-scoring clip first
    // 2. Remaining slots up to targetCount filled by highest overall scores respecting maxPerCategory
    const chosen: typeof normalizedCandidates = [];
    const chosenIndices = new Set<number>();
    const categoryCounts = new Map<string, number>();

    for (const cat of selectedCategories) {
      if (chosen.length >= targetCount) break;
      const bestForCat = nonOverlapping.find(
        c => c.category === cat && !chosenIndices.has(c.tempIdx)
      );
      if (bestForCat) {
        chosen.push(bestForCat);
        chosenIndices.add(bestForCat.tempIdx);
        categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
      }
    }

    for (const cand of nonOverlapping) {
      if (chosen.length >= targetCount) break;
      if (chosenIndices.has(cand.tempIdx)) continue;
      const curCount = categoryCounts.get(cand.category) || 0;
      if (curCount >= maxPerCategory) continue;
      chosen.push(cand);
      chosenIndices.add(cand.tempIdx);
      categoryCounts.set(cand.category, curCount + 1);
    }

    // Build final Clip objects with word-level & line-level subtitles
    const finalClips = chosen
      .sort((a, b) => b.viralityScore - a.viralityScore)
      .map((c, idx) => {
        const clipSmoothedWords = buildWordsForRange(smoothedWords, c.startTime, c.endTime);
        const clipRawWords = buildWordsForRange(rawWords, c.startTime, c.endTime);
        const lines = buildLinesFromWords(clipSmoothedWords, 4);
        const rawLines = buildLinesFromWords(clipRawWords, 4);

        return {
          id: `clip-${videoId}-${idx + 1}`,
          title: c.title,
          startTime: c.startTime,
          endTime: c.endTime,
          duration: c.duration,
          viralityScore: c.viralityScore,
          reasons: c.reasons,
          summary: c.summary,
          category: c.category,
          hookText: c.hookText,
          words: clipSmoothedWords,
          lines,
          baseWords: clipSmoothedWords,
          rawWords: clipRawWords,
          rawLines
        };
      });

    if (finalClips.length === 0) {
      updateJob({
        status: 'failed',
        progress: 100,
        error: 'Tidak ada klip non-tumpang-tindih yang cocok dengan kriteria kategori & durasi.'
      });
      return;
    }

    timingsMs.total = Date.now() - totalStartMs;

    const diagnostics: TranscriptDiagnostics = {
      sourceUsed,
      qualityLabel,
      detectedLanguage,
      wordCount,
      speechCoveragePct,
      wpm,
      isIncomplete,
      isSuspiciousWpm,
      cacheHit,
      keptSoundCues: keepSoundCues,
      cloudBlockedHint,
      timingsMs,
      failedTiers
    };

    const videoInfo = {
      id: `yt-${videoId}`,
      title,
      channelTitle,
      youtubeId: videoId,
      duration: Math.round(videoTotalDuration),
      thumbnailUrl,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      clips: finalClips,
      isAiTranscribed: sourceUsed === 'gemini_url',
      isManualSubtitle: sourceUsed === 'manual_paste_srt' || sourceUsed === 'manual_paste_plain',
      videoDescription: description.slice(0, 1200),
      detectedLanguage,
      diagnostics
    };

    updateJob({
      status: 'completed',
      progress: 100,
      message: `Selesai! ${finalClips.length} klip terbaik siap ditinjau.`,
      result: videoInfo
    });
  } catch (err: any) {
    updateJob({
      status: 'failed',
      progress: 100,
      error: err?.message || 'Terjadi kesalahan internal saat menganalisis video.'
    });
  }
}

app.post('/api/analyze', (req, res) => {
  const body = req.body || {};
  const url = String(body.url || '').trim();
  const apiKey = String(req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY || '').trim();

  if (!apiKey) {
    return res.status(400).json({ error: 'API Key belum diisi' });
  }

  if (!url) {
    return res.status(400).json({ error: 'URL video YouTube tidak boleh kosong.' });
  }

  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return res.status(400).json({
      error: 'URL YouTube tidak valid. Masukkan tautan YouTube yang benar (contoh: https://www.youtube.com/watch?v=... atau https://youtu.be/...).'
    });
  }

  const requestedCats: ClipCategory[] = Array.isArray(body.kategori)
    ? body.kategori.filter((k: any): k is ClipCategory => CLIP_CATEGORIES.includes(k))
    : [...CLIP_CATEGORIES];

  const forceSource: 'auto' | 'whisper' | 'youtube' | 'gemini' =
    body.forceSource === 'whisper' || body.forceSource === 'youtube' || body.forceSource === 'gemini'
      ? body.forceSource
      : 'auto';

  const jobId = crypto.randomUUID();
  analyzeJobs.set(jobId, {
    jobId,
    status: 'queued',
    progress: 2,
    message: 'Memulai antrean analisis video...',
    createdAt: Date.now()
  });

  void executeAnalyzePipeline(jobId, {
    videoId,
    apiKey,
    durasi: Number(body.durasi) || 60,
    jumlah: Number(body.jumlah) || 6,
    perKategori: Number(body.perKategori) || 2,
    kategori: requestedCats.length > 0 ? requestedCats : [...CLIP_CATEGORIES],
    whisperUrl: String(body.whisperUrl || process.env.WHISPER_COLAB_URL || '').trim(),
    whisperToken: String(body.whisperToken || '').trim(),
    keepSoundCues: Boolean(body.keepSoundCues),
    language: String(body.language || 'auto'),
    manualCues: Array.isArray(body.manualCues) ? body.manualCues : undefined,
    manualSourceTier: body.manualSourceTier,
    forceSource,
    bypassCache: Boolean(body.bypassCache)
  });

  return res.status(202).json({ jobId, videoId });
});

app.get('/api/analyze/:jobId', (req, res) => {
  const job = analyzeJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job analisis tidak ditemukan atau sudah kedaluwarsa.' });
  }
  return res.json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {})
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const server = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`[Clip Studio AI] Server running on http://0.0.0.0:${PORT}`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 300000;
}

startServer();
