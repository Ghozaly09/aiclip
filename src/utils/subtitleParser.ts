import { SubtitleWord, SubtitleLine } from '../types.ts';
import { getKeywordEmoji } from './emoji.ts';

export interface ParsedCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface CaptionChunk {
  words: SubtitleWord[];
  start: number;
  end: number;
}

// Format seconds into mm:ss or mm:ss.d
export function formatClockMinSec(seconds: number, withDecimals = false): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  if (withDecimals) {
    const whole = Math.floor(rem);
    const tenths = Math.floor((rem - whole) * 10);
    return `${String(mins).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${tenths}`;
  }
  const secs = Math.floor(rem);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Format seconds strictly as decimal minutes (e.g. "1.25 mnt")
export function formatMinutesValue(seconds: number, decimals = 2): string {
  const mins = (Number.isFinite(seconds) ? seconds : 0) / 60;
  return `${mins.toFixed(decimals)} mnt`;
}

// Format signed minute offset cleanly preserving 0.001 mnt (60ms) precision
export function formatSignedMinutes(offsetMinutes: number): string {
  const val = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  if (Math.abs(val) < 0.0004) return '0.000 mnt';
  const sign = val > 0 ? '+' : '-';
  const abs = Math.abs(val);
  return `${sign}${abs.toFixed(3)} mnt`;
}

// Convert various timestamp formats to seconds (e.g. 01:23:45,678 or 02:15.500 or 12.5)
export function parseTimestampToSeconds(timeStr: string): number {
  if (!timeStr) return 0;
  const clean = timeStr.trim().replace(',', '.');
  const parts = clean.split(':');

  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const mins = parseFloat(parts[1]) || 0;
    const secs = parseFloat(parts[2]) || 0;
    return parseFloat((hours * 3600 + mins * 60 + secs).toFixed(3));
  } else if (parts.length === 2) {
    const mins = parseFloat(parts[0]) || 0;
    const secs = parseFloat(parts[1]) || 0;
    return parseFloat((mins * 60 + secs).toFixed(3));
  }
  return parseFloat((parseFloat(clean) || 0).toFixed(3));
}

export const DEFAULT_CAPTION_LEAD_SEC = 0.10;

export function getSavedCaptionLeadSec(youtubeId: string): number {
  if (typeof window === 'undefined' || !youtubeId) return DEFAULT_CAPTION_LEAD_SEC;
  try {
    const raw = window.localStorage.getItem(`clip_studio_caption_lead_${youtubeId}`);
    if (raw === null) return DEFAULT_CAPTION_LEAD_SEC;
    const val = Number(raw);
    if (!Number.isFinite(val)) return DEFAULT_CAPTION_LEAD_SEC;
    return Math.max(-2, Math.min(2, parseFloat(val.toFixed(2))));
  } catch {
    return DEFAULT_CAPTION_LEAD_SEC;
  }
}

export function saveCaptionLeadSec(youtubeId: string, leadSec: number): number {
  const clamped = Math.max(-2, Math.min(2, parseFloat((Number(leadSec) || 0).toFixed(2))));
  if (typeof window !== 'undefined' && youtubeId) {
    try {
      window.localStorage.setItem(`clip_studio_caption_lead_${youtubeId}`, String(clamped));
    } catch {
      // ignore storage quota errors
    }
  }
  return clamped;
}

// Decode HTML entities, format tags, and optionally strip [Musik]/[Tepuk tangan] without changing spelling/slang
export function cleanTranscriptText(text: string, keepSoundCues = false): string {
  if (!text) return '';
  let out = String(text)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(?:p|div|span|font|i|b|u|c)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]+\}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return ' ';
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return ' ';
      }
    });

  if (!keepSoundCues) {
    out = out
      .replace(
        /[\[\(]\s*(?:music|musik|applause|tepuk\s+tangan|laughter|tertawa|cheering|sorakan|sound(?:\s+effect)?|sfx|inaudible|tak\s+terdengar|hening|silent|intro|outro|instrumental|backsound|♪+)(?:\s*[:\-][^\]\)]*)?\s*[\]\)]/gi,
        ' '
      )
      .replace(/[♪♫]+/g, ' ');
  }

  return out
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .trim();
}

// Strip HTML tags, formatting codes, music symbols, and inline stage cues like [Musik] / (tertawa)
function stripSubtitleHtml(text: string, keepSoundCues = false): string {
  return cleanTranscriptText(text, keepSoundCues);
}

export function isNonSpeechTag(text: string, keepSoundCues = false): boolean {
  const cleaned = text.trim();
  if (!cleaned) return true;
  if (keepSoundCues) return false;
  if (
    /^[\[\(]\s*(?:music|musik|applause|tepuk\s+tangan|laughter|tertawa|cheering|sound|sfx|inaudible|hening|♪+)\s*[\]\)]$/i.test(
      cleaned
    )
  ) {
    return true;
  }
  return false;
}

// Sort cues and clamp overlaps so consecutive cues never overwrite each other's timestamps
export function normalizeCueOverlaps(cues: ParsedCue[]): ParsedCue[] {
  if (cues.length === 0) return [];
  const sorted = [...cues]
    .filter(c => c.text && !isNonSpeechTag(c.text))
    .sort((a, b) => a.start - b.start);

  return sorted.map((cue, idx) => {
    const next = sorted[idx + 1];
    let end = Math.max(cue.start + 0.25, cue.end);
    if (next && next.start > cue.start + 0.15 && end > next.start - 0.02) {
      end = Math.max(cue.start + 0.15, parseFloat((next.start - 0.02).toFixed(3)));
    }
    return {
      ...cue,
      start: parseFloat(Math.max(0, cue.start).toFixed(3)),
      end: parseFloat(end.toFixed(3))
    };
  });
}

// Parse raw SRT, VTT, SBV, or timestamped plain text into structured non-overlapping cues
export function parseSubtitleFile(content: string, keepSoundCues = false): ParsedCue[] {
  if (!content || !content.trim()) return [];

  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const cues: ParsedCue[] = [];

  const arrowRegex = /((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})/;
  const sbvRegex = /^((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*,\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})$/;
  const lineTimestampRegex = /^[\[\(]((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]?\d*)[\]\)]\s*(.*)$/;

  let currentCue: { start: number; end: number; text: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();

    if (!rawLine) {
      if (currentCue && currentCue.text.trim()) {
        const cleaned = stripSubtitleHtml(currentCue.text, keepSoundCues);
        if (!isNonSpeechTag(cleaned, keepSoundCues)) {
          cues.push({
            id: `cue-${cues.length + 1}`,
            start: currentCue.start,
            end: Math.max(currentCue.start + 0.35, currentCue.end),
            text: cleaned
          });
        }
        currentCue = null;
      }
      continue;
    }

    if (rawLine === 'WEBVTT' || rawLine.startsWith('NOTE') || /^\d+$/.test(rawLine)) {
      if (rawLine === 'WEBVTT' || rawLine.startsWith('NOTE')) continue;
      if (!currentCue) continue;
    }

    const arrowMatch = rawLine.match(arrowRegex);
    if (arrowMatch) {
      if (currentCue && currentCue.text.trim()) {
        const cleaned = stripSubtitleHtml(currentCue.text, keepSoundCues);
        if (!isNonSpeechTag(cleaned, keepSoundCues)) {
          cues.push({
            id: `cue-${cues.length + 1}`,
            start: currentCue.start,
            end: Math.max(currentCue.start + 0.35, currentCue.end),
            text: cleaned
          });
        }
      }
      currentCue = {
        start: parseTimestampToSeconds(arrowMatch[1]),
        end: parseTimestampToSeconds(arrowMatch[2]),
        text: ''
      };
      continue;
    }

    const sbvMatch = rawLine.match(sbvRegex);
    if (sbvMatch) {
      if (currentCue && currentCue.text.trim()) {
        const cleaned = stripSubtitleHtml(currentCue.text, keepSoundCues);
        if (!isNonSpeechTag(cleaned, keepSoundCues)) {
          cues.push({
            id: `cue-${cues.length + 1}`,
            start: currentCue.start,
            end: Math.max(currentCue.start + 0.35, currentCue.end),
            text: cleaned
          });
        }
      }
      currentCue = {
        start: parseTimestampToSeconds(sbvMatch[1]),
        end: parseTimestampToSeconds(sbvMatch[2]),
        text: ''
      };
      continue;
    }

    const lineTimeMatch = rawLine.match(lineTimestampRegex);
    if (lineTimeMatch) {
      if (currentCue && currentCue.text.trim()) {
        const cleaned = stripSubtitleHtml(currentCue.text, keepSoundCues);
        if (!isNonSpeechTag(cleaned, keepSoundCues)) {
          cues.push({
            id: `cue-${cues.length + 1}`,
            start: currentCue.start,
            end: Math.max(currentCue.start + 0.35, currentCue.end),
            text: cleaned
          });
        }
      }
      const s = parseTimestampToSeconds(lineTimeMatch[1]);
      currentCue = {
        start: s,
        end: s + 3.0,
        text: lineTimeMatch[2]
      };
      continue;
    }

    if (currentCue) {
      currentCue.text = currentCue.text ? `${currentCue.text} ${rawLine}` : rawLine;
    } else {
      const cleaned = stripSubtitleHtml(rawLine, keepSoundCues);
      if (!isNonSpeechTag(cleaned, keepSoundCues)) {
        const prevEnd = cues.length > 0 ? cues[cues.length - 1].end : 0;
        cues.push({
          id: `cue-${cues.length + 1}`,
          start: prevEnd,
          end: prevEnd + 3.0,
          text: cleaned
        });
      }
    }
  }

  if (currentCue && currentCue.text.trim()) {
    const cleaned = stripSubtitleHtml(currentCue.text, keepSoundCues);
    if (!isNonSpeechTag(cleaned, keepSoundCues)) {
      cues.push({
        id: `cue-${cues.length + 1}`,
        start: currentCue.start,
        end: Math.max(currentCue.start + 0.35, currentCue.end),
        text: cleaned
      });
    }
  }

  return normalizeCueOverlaps(cues);
}

// Estimate spoken syllable/pause weight of a word for natural speech pacing
function estimateWordSpeechWeight(word: string): { speakWeight: number; pauseWeight: number } {
  const alpha = word.replace(/[^\p{L}\p{N}]/gu, '');
  // Count vowel groups as syllable proxy (accurate for Indonesian & English)
  const vowelGroups = (alpha.match(/[aeiouyAEIOUY]+/g) || []).length;
  const syllables = Math.max(1, vowelGroups || Math.ceil(alpha.length / 3));
  const speakWeight = 0.8 + syllables * 0.55 + Math.min(4, alpha.length) * 0.12;

  let pauseWeight = 0;
  if (/[.!?…]$/.test(word)) {
    pauseWeight = 2.2;
  } else if (/[,;:—–-]$/.test(word)) {
    pauseWeight = 1.2;
  }
  return { speakWeight, pauseWeight };
}

// Distribute words inside [segStart, segEnd] using syllable + punctuation weights and natural speech pacing
export function distributeCueWords(
  cueWords: string[],
  segStart: number,
  segEnd: number
): SubtitleWord[] {
  if (cueWords.length === 0) return [];
  const rawCueDur = Math.max(0.18, segEnd - segStart);

  const metrics = cueWords.map(estimateWordSpeechWeight);
  const totalWeight = metrics.reduce((sum, m) => sum + m.speakWeight + m.pauseWeight, 0);

  // Cap overly padded SRT linger windows (e.g. a 2-word line left on screen for 5 seconds)
  // Conversational speech averages ~0.36-0.42s/word + punctuation pauses so words lock tightly to voice
  const punctuationBonus = metrics.reduce((s, m) => s + (m.pauseWeight > 0 ? 0.16 : 0), 0);
  const maxNaturalSpan = Math.max(0.45, cueWords.length * 0.40 + punctuationBonus);
  const effectiveSpan = Math.min(rawCueDur, maxNaturalSpan);
  const effectiveEnd = segStart + effectiveSpan;

  const out: SubtitleWord[] = [];
  let cursor = segStart;

  for (let i = 0; i < cueWords.length; i++) {
    const wStr = cueWords[i].trim();
    const m = metrics[i];
    const fracSpeak = (m.speakWeight / totalWeight) * effectiveSpan;
    const fracPause = (m.pauseWeight / totalWeight) * effectiveSpan;

    const wStart = parseFloat(cursor.toFixed(3));
    const speakEndRaw =
      i === cueWords.length - 1
        ? Math.min(effectiveEnd, cursor + fracSpeak + 0.08)
        : Math.min(effectiveEnd, cursor + fracSpeak);
    const wEnd = parseFloat(Math.max(wStart + 0.06, speakEndRaw).toFixed(3));

    out.push({
      word: wStr,
      start: wStart,
      end: wEnd,
      emoji: getKeywordEmoji(wStr)
    });

    cursor = Math.min(effectiveEnd, wEnd + fracPause);
  }
  return out;
}

// Ensure monotonic non-overlapping word timeline (start/end strictly increasing, zero overlap)
export function sanitizeMonotonicWords(rawWords: SubtitleWord[]): SubtitleWord[] {
  if (rawWords.length === 0) return [];
  const sorted = [...rawWords]
    .filter(w => w && typeof w.word === 'string' && w.word.trim().length > 0)
    .sort((a, b) => a.start - b.start);

  const result: SubtitleWord[] = [];

  for (const w of sorted) {
    let start = Math.max(0, Number.isFinite(w.start) ? w.start : 0);
    let end = Math.max(start + 0.06, Number.isFinite(w.end) ? w.end : start + 0.25);

    if (result.length > 0) {
      const prev = result[result.length - 1];
      if (start < prev.end) {
        // Trim minor tail overlap on previous word if it preserves spoken body, then push start
        if (prev.end - start <= 0.16 && prev.end - prev.start > 0.16) {
          prev.end = parseFloat(Math.max(prev.start + 0.06, start).toFixed(3));
        }
        start = Math.max(prev.end, start);
        end = Math.max(start + 0.06, end);
      }
    }

    result.push({
      ...w,
      word: w.word.trim(),
      start: parseFloat(start.toFixed(3)),
      end: parseFloat(end.toFixed(3))
    });
  }
  return result;
}

// Auto-correct raw word timings without acoustic profile:
// 1. Cut unjustified single-word durations > 1.5s to natural spoken span + mark low_confidence if clamped heavily
// 2. Enforce strictly monotonic non-overlapping start/end
export function postCorrectWordTimestamps(rawWords: SubtitleWord[], maxWordDurSec = 1.5): SubtitleWord[] {
  const pre = rawWords.map(w => {
    const start = Math.max(0, Number(w.start) || 0);
    const end = Math.max(start + 0.06, Number(w.end) || start + 0.25);
    const dur = end - start;
    if (dur <= maxWordDurSec) {
      return { ...w, start, end };
    }
    const alpha = w.word.replace(/[^\p{L}\p{N}]/gu, '');
    const vowelGroups = (alpha.match(/[aeiouyAEIOUY]+/g) || []).length;
    const syllables = Math.max(1, vowelGroups || Math.ceil(alpha.length / 3));
    const hasPunct = /[.!?…,;:]$/.test(w.word);
    const naturalCap = Math.min(
      maxWordDurSec - 0.05,
      Math.max(0.38, syllables * 0.20 + alpha.length * 0.042 + (hasPunct ? 0.16 : 0.06))
    );
    return {
      ...w,
      start,
      end: parseFloat((start + naturalCap).toFixed(3)),
      low_confidence: w.low_confidence || dur - naturalCap > 0.45
    };
  });
  return sanitizeMonotonicWords(pre);
}

// Group words into Shorts-style subtitle displays:
// - 3-5 words max per display (or user-selected 1-5 cap)
// - Switches display immediately on breath pause (>0.22s), sentence ending, or phrase boundary
export function groupWordsIntoChunks(words: SubtitleWord[], wordsPerLine = 4): CaptionChunk[] {
  if (!words || words.length === 0) return [];
  const maxWords = Math.max(1, Math.min(5, wordsPerLine || 4));
  const sorted = sanitizeMonotonicWords(words);

  const chunks: CaptionChunk[] = [];
  let buf: SubtitleWord[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    if (buf.length > 0) {
      const prev = buf[buf.length - 1];
      const gap = w.start - prev.end;
      const prevEndedSentence = /[.!?…]$/.test(prev.word);
      const prevEndedClause = /[,;:—–-]$/.test(prev.word) && buf.length >= 2;
      const spanDur = w.end - buf[0].start;

      if (
        buf.length >= maxWords ||
        gap > 0.22 ||
        prevEndedSentence ||
        prevEndedClause ||
        spanDur > 2.6
      ) {
        chunks.push({
          words: buf,
          start: buf[0].start,
          end: buf[buf.length - 1].end
        });
        buf = [];
      }
    }
    buf.push(w);
  }

  if (buf.length > 0) {
    chunks.push({
      words: buf,
      start: buf[0].start,
      end: buf[buf.length - 1].end
    });
  }

  return chunks;
}

// Balance 1-5 display words cleanly into at most 2 visual rows for Shorts style
export function splitDisplayWordsIntoRows(words: SubtitleWord[], maxRows = 2): SubtitleWord[][] {
  if (!words || words.length === 0) return [];
  if (maxRows <= 1 || words.length <= 1) return [words];

  const totalChars = words.reduce((sum, w) => sum + w.word.length, 0) + Math.max(0, words.length - 1);
  if (words.length <= 2 && totalChars <= 13) {
    return [words];
  }
  if (words.length === 3 && totalChars <= 14) {
    return [words];
  }

  // Pick split index minimizing line character-length imbalance
  let bestSplit = Math.ceil(words.length / 2);
  let bestDiff = Infinity;
  for (let split = 1; split < words.length; split++) {
    const topLen =
      words.slice(0, split).reduce((s, w) => s + w.word.length, 0) + Math.max(0, split - 1);
    const botLen =
      words.slice(split).reduce((s, w) => s + w.word.length, 0) +
      Math.max(0, words.length - split - 1);
    // Slightly prefer equal or slightly wider top line for visual pyramid stability
    const diff = Math.abs(topLen - botLen) + (botLen > topLen + 3 ? 1.5 : 0);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = split;
    }
  }

  return [words.slice(0, bestSplit), words.slice(bestSplit)];
}

// Section C.3 Timing Smoothing:
// - Min display duration per word: 0.15s
// - end = min(rawEnd + 0.15s, nextStart)
// - Close intra-sentence gaps < 0.30s by extending previous word
// - Hold final word before long pause up to +0.40s then clear
export function smoothWordTimings(rawWords: SubtitleWord[]): SubtitleWord[] {
  const base = sanitizeMonotonicWords(rawWords);
  if (base.length === 0) return [];

  const MIN_WORD_DUR = 0.15;
  const INTRA_SENTENCE_MAX_GAP = 0.30;
  const LONG_PAUSE_THRESHOLD = 0.55;
  const LONG_PAUSE_HOLD = 0.40;
  const DEFAULT_EXTEND = 0.15;

  const out: SubtitleWord[] = [];
  for (let i = 0; i < base.length; i++) {
    const cur = base[i];
    const next = i < base.length - 1 ? base[i + 1] : null;
    const rawStart = Math.max(0, cur.start);
    const prevEnd = out.length > 0 ? out[out.length - 1].end : 0;
    const start = Math.max(prevEnd, rawStart);

    const endsSentence = /[.!?…]$/.test(cur.word);
    const minEnd = start + MIN_WORD_DUR;
    let end = Math.max(minEnd, cur.end);

    if (next) {
      const gapToNext = next.start - cur.end;
      if (!endsSentence && gapToNext > 0 && gapToNext < INTRA_SENTENCE_MAX_GAP) {
        // Bridge intra-sentence gaps < 0.30s seamlessly
        end = Math.max(minEnd, next.start);
      } else if (gapToNext >= LONG_PAUSE_THRESHOLD || endsSentence) {
        // Hold last word before long pause up to +0.40s without colliding with next word
        end = Math.min(next.start, Math.max(minEnd, cur.end + LONG_PAUSE_HOLD));
      } else {
        end = Math.min(next.start, Math.max(minEnd, cur.end + DEFAULT_EXTEND));
      }
      if (end > next.start && next.start > start + 0.04) {
        end = next.start;
      }
    } else {
      // Very last word in clip/transcript: hold up to +0.40s then disappear
      end = Math.max(minEnd, cur.end + LONG_PAUSE_HOLD);
    }

    out.push({
      ...cur,
      start: parseFloat(start.toFixed(3)),
      end: parseFloat(Math.max(start + 0.05, end).toFixed(3))
    });
  }

  return sanitizeMonotonicWords(out);
}

// Section E: Remove ASR/Whisper hallucinations (>=4x repeats & silent boilerplate) + enforce monotonic bounds
const SILENT_BOILERPLATE_PATTERNS: RegExp[] = [
  /terima\s+kasih\s+(?:telah|sudah)\s+menonton/i,
  /(?:jangan\s+lupa\s+)?like[\s,]+(?:comment|komen)?[\s,&]+subscribe/i,
  /^(?:subscribe|subrek|subcribe)[!.\s]*$/i,
  /amara\.org/i,
  /subtitles?\s+by\s+/i,
  /diterjemahkan\s+oleh/i,
  /thanks?\s+for\s+watching/i,
  /please\s+subscribe/i
];

export function stripBoilerplateAndRepeats(words: SubtitleWord[], keepSoundCues = false): SubtitleWord[] {
  if (!words || words.length === 0) return [];

  // 1. Clean tokens and drop invalid/non-finite timestamps
  const cleaned: SubtitleWord[] = [];
  for (const w of words) {
    if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0) continue;
    const tok = cleanTranscriptText(w.word, keepSoundCues);
    if (!tok || isNonSpeechTag(tok, keepSoundCues)) continue;
    cleaned.push({
      ...w,
      word: tok,
      start: Math.max(0, Number(w.start)),
      end: Math.max(Number(w.start) + 0.05, Number(w.end))
    });
  }

  if (cleaned.length === 0) return [];

  // 2. Remove consecutive n-gram repetitions >= 4x (e.g. "iya iya iya iya" or "dan lalu dan lalu...")
  const normTok = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const deduped: SubtitleWord[] = [];
  let i = 0;
  while (i < cleaned.length) {
    let matchedRepeat = false;
    for (let gram = 1; gram <= 4 && i + gram * 4 <= cleaned.length; gram++) {
      const pattern = cleaned.slice(i, i + gram).map(x => normTok(x.word));
      if (pattern.some(p => !p)) continue;
      let reps = 1;
      while (i + (reps + 1) * gram <= cleaned.length) {
        const nextSlice = cleaned.slice(i + reps * gram, i + (reps + 1) * gram).map(x => normTok(x.word));
        if (nextSlice.every((val, k) => val === pattern[k])) {
          reps++;
        } else {
          break;
        }
      }
      if (reps >= 4) {
        // Keep a single occurrence (or drop completely if >8 repeats of short filler)
        if (reps <= 6) {
          deduped.push(...cleaned.slice(i, i + gram));
        }
        i += reps * gram;
        matchedRepeat = true;
        break;
      }
    }
    if (!matchedRepeat) {
      deduped.push(cleaned[i]);
      i++;
    }
  }

  // 3. Remove trailing or isolated silent-hallucination boilerplate phrases
  const result: SubtitleWord[] = [];
  let idx = 0;
  while (idx < deduped.length) {
    let skipped = false;
    for (let win = Math.min(7, deduped.length - idx); win >= 2; win--) {
      const phrase = deduped
        .slice(idx, idx + win)
        .map(x => x.word)
        .join(' ')
        .trim();
      if (SILENT_BOILERPLATE_PATTERNS.some(rx => rx.test(phrase))) {
        idx += win;
        skipped = true;
        break;
      }
    }
    if (skipped) continue;
    const single = deduped[idx].word.trim();
    if (SILENT_BOILERPLATE_PATTERNS.some(rx => rx.test(single))) {
      idx++;
      continue;
    }
    result.push(deduped[idx]);
    idx++;
  }

  return sanitizeMonotonicWords(result);
}

export interface TranscriptValidationReport {
  validWords: SubtitleWord[];
  wordCount: number;
  speechCoveragePct: number;
  wpm: number;
  isIncomplete: boolean;
  isSuspiciousWpm: boolean;
  passed: boolean;
  failureReason?: string;
}

export function validateAndCleanTranscriptWords(
  rawWords: SubtitleWord[],
  videoDurationSec = 0,
  options: { keepSoundCues?: boolean; requireCompleteCoverage?: boolean } = {}
): TranscriptValidationReport {
  const { keepSoundCues = false, requireCompleteCoverage = true } = options;
  const validWords = stripBoilerplateAndRepeats(rawWords, keepSoundCues);
  const wordCount = validWords.length;

  if (wordCount === 0) {
    return {
      validWords: [],
      wordCount: 0,
      speechCoveragePct: 0,
      wpm: 0,
      isIncomplete: true,
      isSuspiciousWpm: true,
      passed: false,
      failureReason: 'Transkrip kosong atau tidak berisi ucapan yang valid.'
    };
  }

  const firstStart = validWords[0].start;
  const lastEnd = validWords[validWords.length - 1].end;
  const refDuration = Math.max(videoDurationSec > 0 ? videoDurationSec : lastEnd, lastEnd, 1);

  // Compute span coverage: covered range across 5s buckets vs total video duration
  const bucketSize = 5;
  const totalBuckets = Math.max(1, Math.ceil(refDuration / bucketSize));
  const activeBuckets = new Set<number>();
  for (const w of validWords) {
    const b0 = Math.floor(w.start / bucketSize);
    const b1 = Math.floor(w.end / bucketSize);
    for (let b = b0; b <= b1; b++) {
      activeBuckets.add(b);
    }
  }
  const bucketCoveragePct = (activeBuckets.size / totalBuckets) * 100;
  const spanCoveragePct = ((lastEnd - firstStart) / refDuration) * 100;
  const speechCoveragePct = Math.min(100, Math.round(Math.max(spanCoveragePct * 0.85, bucketCoveragePct)));

  const activeMinutes = Math.max(0.15, (lastEnd - firstStart) / 60);
  const wpm = Math.round(wordCount / activeMinutes);

  // Incomplete check for videos > 30s
  const isShortVideo = refDuration <= 30;
  const isIncomplete = !isShortVideo && (speechCoveragePct < 60 || wordCount < 12);
  const isSuspiciousWpm = !isShortVideo && (wpm < 60 || wpm > 280);

  let passed = true;
  let failureReason: string | undefined;
  if (requireCompleteCoverage && isIncomplete) {
    passed = false;
    failureReason = `Transkrip tidak lengkap (cakupan ${speechCoveragePct}%, ${wordCount} kata dari durasi ${Math.round(refDuration)} dtk).`;
  }

  return {
    validWords,
    wordCount,
    speechCoveragePct,
    wpm,
    isIncomplete,
    isSuspiciousWpm,
    passed,
    failureReason
  };
}

// Detect whether pasted transcript contains SRT/VTT/line timestamps or plain text
export function detectPastedTranscriptKind(rawText: string): 'timestamped' | 'plain' | 'empty' {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return 'empty';
  const hasArrow = /(?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3}\s*-->\s*(?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3}/.test(trimmed);
  const hasSbv = /^\s*(?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3}\s*,\s*(?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3}/m.test(trimmed);
  const hasInlineTime = /^\s*[\[\(](?:\d{1,3}:)?\d{1,2}:\d{2}(?:[,.]\d+)?[\]\)]/m.test(trimmed);
  return hasArrow || hasSbv || hasInlineTime ? 'timestamped' : 'plain';
}

// Split plain text without timestamps proportionally across estimated video duration
export function splitPlainTextProportionally(
  rawText: string,
  totalDurationSec = 180,
  keepSoundCues = false
): ParsedCue[] {
  const cleaned = cleanTranscriptText(rawText, keepSoundCues);
  if (!cleaned) return [];
  const sentences = cleaned
    .split(/(?<=[.!?…])\s+|[\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const parts = sentences.length > 0 ? sentences : [cleaned];
  const safeDur = Math.max(10, totalDurationSec || 180);
  const totalChars = parts.reduce((acc, p) => acc + Math.max(4, p.length), 0);

  const cues: ParsedCue[] = [];
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const share = (Math.max(4, parts[i].length) / totalChars) * safeDur;
    const start = parseFloat(cursor.toFixed(3));
    const end = parseFloat(Math.min(safeDur, cursor + Math.max(0.4, share)).toFixed(3));
    cues.push({
      id: `plain-cue-${i + 1}`,
      start,
      end,
      text: parts[i]
    });
    cursor = end;
  }
  return normalizeCueOverlaps(cues);
}

// Deterministic active caption chunk lookup shared by HTML preview & MP4 Canvas renderer
// captionLeadSec (+ = show subtitle slightly earlier than speech; default +0.10s)
export function getActiveCaptionChunk(
  words: SubtitleWord[],
  currentTime: number,
  wordsPerLine = 4,
  captionLeadSec = DEFAULT_CAPTION_LEAD_SEC,
  customLines?: SubtitleLine[]
): { chunk: SubtitleWord[]; activeIndexInChunk: number } {
  const chunks: CaptionChunk[] =
    customLines && customLines.length > 0
      ? customLines
          .filter(l => l.words && l.words.length > 0)
          .map(l => ({
            words: l.words,
            start: l.words[0].start,
            end: l.words[l.words.length - 1].end
          }))
      : groupWordsIntoChunks(words, wordsPerLine);
  if (chunks.length === 0) return { chunk: [], activeIndexInChunk: -1 };

  const lookupTime = currentTime + (Number.isFinite(captionLeadSec) ? captionLeadSec : DEFAULT_CAPTION_LEAD_SEC);

  // Brief bridge for consecutive turns within same conversation while keeping real pauses clean
  const PRE_ONSET_ANTICIPATION = 0.02;
  const HOLD_AFTER_CHUNK_END = 0.06;
  const CONVERSATION_BRIDGE_GAP = 0.24;

  for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
    const c = chunks[cIdx];
    const prevChunk = cIdx > 0 ? chunks[cIdx - 1] : null;
    const nextChunk = chunks[cIdx + 1];

    const earliestDisplayStart = prevChunk
      ? Math.max(prevChunk.end + 0.005, c.start - PRE_ONSET_ANTICIPATION)
      : c.start - PRE_ONSET_ANTICIPATION;

    let maxHoldEnd = c.end + HOLD_AFTER_CHUNK_END;
    if (nextChunk) {
      const gapToNext = nextChunk.start - c.end;
      const nextEarliestStart = Math.max(c.end + 0.005, nextChunk.start - PRE_ONSET_ANTICIPATION);
      if (gapToNext <= CONVERSATION_BRIDGE_GAP) {
        // Active conversation ongoing: hold seamlessly right up to next chunk's onset with zero blank gap
        maxHoldEnd = nextEarliestStart - 0.004;
      } else {
        maxHoldEnd = Math.min(c.end + HOLD_AFTER_CHUNK_END, nextEarliestStart - 0.008);
      }
    }

    if (lookupTime >= earliestDisplayStart && lookupTime <= maxHoldEnd) {
      let activeIdx = c.words.findIndex(
        w => lookupTime >= w.start - PRE_ONSET_ANTICIPATION && lookupTime <= w.end + 0.02
      );
      if (activeIdx === -1) {
        if (lookupTime < c.words[0].start) {
          activeIdx = 0;
        } else {
          // Keep most recent spoken word highlighted seamlessly across intra-chunk/turn pauses
          for (let i = c.words.length - 1; i >= 0; i--) {
            if (lookupTime >= c.words[i].start - PRE_ONSET_ANTICIPATION) {
              activeIdx = i;
              break;
            }
          }
        }
      }
      return { chunk: c.words, activeIndexInChunk: activeIdx };
    }
  }

  return { chunk: [], activeIndexInChunk: -1 };
}

// Convert parsed cues into synchronized words and lines for a given time window
export function cuesToWordsAndLines(
  cues: ParsedCue[],
  clipStart?: number,
  clipEnd?: number,
  wordsPerLine = 4
): { words: SubtitleWord[]; lines: SubtitleLine[] } {
  const cleanCues = normalizeCueOverlaps(cues);
  const filteredCues = (clipStart !== undefined && clipEnd !== undefined)
    ? cleanCues.filter(c => c.end >= clipStart && c.start <= clipEnd)
    : cleanCues;

  const allWords: SubtitleWord[] = [];

  for (const cue of filteredCues) {
    const cueWords = cue.text.split(/\s+/).filter(Boolean);
    if (cueWords.length === 0) continue;
    const distributed = distributeCueWords(cueWords, cue.start, cue.end);
    for (const w of distributed) {
      if (clipStart !== undefined && clipEnd !== undefined) {
        if (w.end < clipStart - 0.08 || w.start > clipEnd + 0.08) continue;
      }
      allWords.push(w);
    }
  }

  const words = sanitizeMonotonicWords(allWords);
  const chunks = groupWordsIntoChunks(words, wordsPerLine);
  const lines: SubtitleLine[] = chunks.map((c, idx) => ({
    id: `line-${idx + 1}-${Date.now()}`,
    start: c.start,
    end: c.end,
    words: c.words
  }));

  return { words, lines };
}

// Adjust parsed subtitle cues by playback speed multiplier and start offset
export function adjustCuesTiming(
  cues: ParsedCue[],
  speed = 1.0,
  offsetSeconds = 0,
  anchorTime = 0
): ParsedCue[] {
  const safeSpeed = Math.max(0.5, Math.min(2.0, Number(speed) || 1.0));
  const safeOffset = Number(offsetSeconds) || 0;

  const adjusted = cues.map(cue => {
    const rawStart = anchorTime + (cue.start - anchorTime) / safeSpeed + safeOffset;
    const rawEnd = anchorTime + (cue.end - anchorTime) / safeSpeed + safeOffset;
    const start = Math.max(0, parseFloat(rawStart.toFixed(3)));
    const end = Math.max(start + 0.2, parseFloat(rawEnd.toFixed(3)));
    return {
      ...cue,
      start,
      end
    };
  });

  return normalizeCueOverlaps(adjusted);
}

// Adjust word-level subtitle timestamps non-destructively from base words and rebuild lines
export function adjustWordsAndLinesTiming(
  baseWords: SubtitleWord[],
  speed = 1.0,
  offsetSeconds = 0,
  anchorTime?: number,
  wordsPerLine = 4
): { words: SubtitleWord[]; lines: SubtitleLine[] } {
  const safeSpeed = Math.max(0.5, Math.min(2.0, Number(speed) || 1.0));
  const safeOffset = Number(offsetSeconds) || 0;
  const anchor = anchorTime !== undefined ? anchorTime : (baseWords[0]?.start ?? 0);

  const rawAdjusted: SubtitleWord[] = baseWords.map(w => {
    const rawStart = anchor + (w.start - anchor) / safeSpeed + safeOffset;
    const rawEnd = anchor + (w.end - anchor) / safeSpeed + safeOffset;
    const start = Math.max(0, parseFloat(rawStart.toFixed(3)));
    const end = Math.max(start + 0.05, parseFloat(rawEnd.toFixed(3)));
    return {
      ...w,
      start,
      end
    };
  });

  const words = sanitizeMonotonicWords(rawAdjusted);
  const chunks = groupWordsIntoChunks(words, wordsPerLine);
  const lines: SubtitleLine[] = chunks.map((c, idx) => ({
    id: `line-${idx + 1}-${Date.now()}`,
    start: c.start,
    end: c.end,
    words: c.words
  }));

  return { words, lines };
}

// Shift a single subtitle cue line (and all its constituent words) by deltaSec while enforcing monotonic non-overlapping bounds
export function moveCueLineByDelta(
  lines: SubtitleLine[],
  lineIndex: number,
  deltaSec: number
): { words: SubtitleWord[]; lines: SubtitleLine[]; appliedDeltaSec: number } {
  if (!lines || lineIndex < 0 || lineIndex >= lines.length) {
    const flat: SubtitleWord[] = [];
    (lines || []).forEach(l => flat.push(...l.words));
    return { words: flat, lines: lines || [], appliedDeltaSec: 0 };
  }

  const target = lines[lineIndex];
  const prevLine = lineIndex > 0 ? lines[lineIndex - 1] : null;
  const nextLine = lineIndex < lines.length - 1 ? lines[lineIndex + 1] : null;

  const minAllowedStart = prevLine ? prevLine.end + 0.01 : 0;
  const minDelta = minAllowedStart - target.start;
  const maxDelta = nextLine ? nextLine.start - 0.01 - target.end : Number.POSITIVE_INFINITY;
  const safeMaxDelta = Math.max(minDelta, maxDelta);
  const clampedDelta = parseFloat(Math.max(minDelta, Math.min(safeMaxDelta, deltaSec)).toFixed(3));

  const updatedLines: SubtitleLine[] = lines.map((l, idx) => {
    if (idx !== lineIndex) return l;
    const shiftedWords: SubtitleWord[] = l.words.map(w => {
      const s = Math.max(minAllowedStart, parseFloat((w.start + clampedDelta).toFixed(3)));
      const e = Math.max(s + 0.04, parseFloat((w.end + clampedDelta).toFixed(3)));
      return { ...w, start: s, end: e };
    });
    const finalWords = sanitizeMonotonicWords(shiftedWords);
    return {
      ...l,
      start: finalWords[0]?.start ?? Math.max(minAllowedStart, parseFloat((l.start + clampedDelta).toFixed(3))),
      end: finalWords[finalWords.length - 1]?.end ?? Math.max(minAllowedStart + 0.08, parseFloat((l.end + clampedDelta).toFixed(3))),
      words: finalWords
    };
  });

  const flatWords: SubtitleWord[] = [];
  updatedLines.forEach(ul => flatWords.push(...ul.words));

  return {
    words: sanitizeMonotonicWords(flatWords),
    lines: updatedLines,
    appliedDeltaSec: clampedDelta
  };
}

