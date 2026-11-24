import { SubtitleWord } from '../types.ts';
import { getKeywordEmoji } from './emoji.ts';
import { cleanTranscriptText, isNonSpeechTag, sanitizeMonotonicWords } from './subtitleParser.ts';

export interface TranscriptSegmentItem {
  start: number;
  end: number;
  text: string;
  words?: SubtitleWord[];
}

// Section A.3: Character-proportional word splitting fallback when only line timing exists
export function splitLineWordsProportionallyByChars(
  text: string,
  startSec: number,
  endSec: number,
  keepSoundCues = false
): SubtitleWord[] {
  const cleaned = cleanTranscriptText(text, keepSoundCues);
  if (!cleaned || isNonSpeechTag(cleaned, keepSoundCues)) return [];
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const safeStart = Math.max(0, startSec);
  const safeEnd = Math.max(safeStart + 0.18, endSec);
  const totalSpan = safeEnd - safeStart;
  const weights = tokens.map(t => Math.max(1, t.replace(/[^\p{L}\p{N}]/gu, '').length || t.length));
  const totalChars = weights.reduce((a, b) => a + b, 0);

  const out: SubtitleWord[] = [];
  let cursor = safeStart;
  for (let i = 0; i < tokens.length; i++) {
    const share = (weights[i] / totalChars) * totalSpan;
    const wStart = parseFloat(cursor.toFixed(3));
    const wEnd = parseFloat(
      Math.max(wStart + 0.06, Math.min(safeEnd, i === tokens.length - 1 ? safeEnd : cursor + share)).toFixed(3)
    );
    const emoji = getKeywordEmoji(tokens[i]);
    out.push({
      word: tokens[i],
      start: wStart,
      end: wEnd,
      ...(emoji ? { emoji } : {})
    });
    cursor = wEnd;
  }
  return out;
}

// Section A.3 + E: Parse YouTube json3 caption payload extracting per-word tOffsetMs & deduplicating aAppend rolling captions
export function parseYouTubeJson3(
  json3Data: any,
  keepSoundCues = false
): { segments: TranscriptSegmentItem[]; words: SubtitleWord[]; hasPerWordTiming: boolean } {
  const events: any[] = Array.isArray(json3Data?.events) ? json3Data.events : [];
  if (events.length === 0) {
    return { segments: [], words: [], hasPerWordTiming: false };
  }

  interface RawEventUnit {
    startMs: number;
    endMs: number;
    tokens: { text: string; startMs: number }[];
    fullText: string;
    hasOffsets: boolean;
  }

  const units: RawEventUnit[] = [];
  let anyOffsetSeen = false;

  for (let eIdx = 0; eIdx < events.length; eIdx++) {
    const ev = events[eIdx];
    const segs: any[] = Array.isArray(ev?.segs) ? ev.segs : [];
    if (segs.length === 0) continue;

    const tStartMs = Math.max(0, Number(ev?.tStartMs) || 0);
    const nextEvStartMs =
      eIdx + 1 < events.length && Number.isFinite(Number(events[eIdx + 1]?.tStartMs))
        ? Number(events[eIdx + 1].tStartMs)
        : tStartMs + 5000;
    const dDurationMs = Math.max(250, Number(ev?.dDurationMs) || Math.min(4500, Math.max(400, nextEvStartMs - tStartMs)));
    const evEndMs = tStartMs + dDurationMs;

    const evTokens: { text: string; startMs: number }[] = [];
    let eventHasOffsets = false;

    for (const seg of segs) {
      const rawUtf8 = String(seg?.utf8 || '');
      if (!rawUtf8 || rawUtf8 === '\n') continue;
      const segClean = cleanTranscriptText(rawUtf8, keepSoundCues);
      if (!segClean || isNonSpeechTag(segClean, keepSoundCues)) continue;

      const tOffsetMs = Number(seg?.tOffsetMs);
      if (Number.isFinite(tOffsetMs) && tOffsetMs >= 0) {
        eventHasOffsets = true;
        anyOffsetSeen = true;
      }
      const absSegStartMs = tStartMs + (Number.isFinite(tOffsetMs) && tOffsetMs >= 0 ? tOffsetMs : 0);

      const subWords = segClean.split(/\s+/).filter(Boolean);
      for (let k = 0; k < subWords.length; k++) {
        // If multiple words live inside a single seg block, interpolate slightly across 180ms each
        evTokens.push({
          text: subWords[k],
          startMs: absSegStartMs + k * 180
        });
      }
    }

    if (evTokens.length === 0) continue;
    const fullText = evTokens.map(t => t.text).join(' ').trim();
    if (!fullText) continue;

    // Handle YouTube ASR rolling caption duplication & aAppend:1 overlap
    const prev = units[units.length - 1];
    if (prev) {
      const normPrev = prev.fullText.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
      const normCur = fullText.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
      if (ev?.aAppend === 1 && normCur === normPrev) {
        continue;
      }
      // If consecutive rolling event starts within 0.35s and shares identical prefix of >= 2 words, skip duplicate prefix
      if (tStartMs - prev.startMs <= 1200 && normCur.startsWith(normPrev) && normPrev.length > 3) {
        const remainingCount = evTokens.length - prev.tokens.length;
        if (remainingCount <= 0) {
          prev.endMs = Math.max(prev.endMs, evEndMs);
          continue;
        }
        const trimmedTokens = evTokens.slice(prev.tokens.length);
        units.push({
          startMs: trimmedTokens[0].startMs,
          endMs: Math.max(trimmedTokens[0].startMs + 250, evEndMs),
          tokens: trimmedTokens,
          fullText: trimmedTokens.map(t => t.text).join(' '),
          hasOffsets: eventHasOffsets
        });
        continue;
      }
      // Deduplicate exact identical adjacent line within 1.5s
      if (Math.abs(tStartMs - prev.startMs) <= 1500 && normCur === normPrev) {
        continue;
      }
    }

    units.push({
      startMs: tStartMs,
      endMs: evEndMs,
      tokens: evTokens,
      fullText,
      hasOffsets: eventHasOffsets
    });
  }

  const allWords: SubtitleWord[] = [];
  const segments: TranscriptSegmentItem[] = [];

  for (let uIdx = 0; uIdx < units.length; uIdx++) {
    const u = units[uIdx];
    const nextUnit = units[uIdx + 1];
    const segStartSec = parseFloat((u.startMs / 1000).toFixed(3));
    const maxAllowedEndMs = nextUnit ? Math.max(u.startMs + 250, nextUnit.startMs - 10) : u.endMs;
    const segEndSec = parseFloat((Math.min(u.endMs, maxAllowedEndMs) / 1000).toFixed(3));

    let segWords: SubtitleWord[];
    if (u.hasOffsets) {
      segWords = u.tokens.map((tok, tIdx) => {
        const nextTokMs =
          u.tokens[tIdx + 1]?.startMs ??
          (nextUnit ? Math.min(u.endMs, nextUnit.startMs) : u.endMs);
        const wStart = Math.max(segStartSec, tok.startMs / 1000);
        const naturalCap = Math.max(0.20, Math.min(0.85, tok.text.length * 0.068 + 0.16));
        const wEnd = Math.max(wStart + 0.06, Math.min(nextTokMs / 1000, wStart + naturalCap));
        const emoji = getKeywordEmoji(tok.text);
        return {
          word: tok.text,
          start: parseFloat(wStart.toFixed(3)),
          end: parseFloat(wEnd.toFixed(3)),
          ...(emoji ? { emoji } : {})
        };
      });
    } else {
      segWords = splitLineWordsProportionallyByChars(u.fullText, segStartSec, segEndSec, keepSoundCues);
    }

    if (segWords.length > 0) {
      allWords.push(...segWords);
      segments.push({
        start: segWords[0].start,
        end: segWords[segWords.length - 1].end,
        text: u.fullText,
        words: segWords
      });
    }
  }

  return {
    segments,
    words: sanitizeMonotonicWords(allWords),
    hasPerWordTiming: anyOffsetSeen
  };
}

// Section B.2: Build <=200 word context prompt / proper-noun glossary from video metadata
export function buildVideoContextGlossary(
  title: string,
  channelTitle: string,
  description = '',
  extraPrompt = '',
  maxWords = 195
): { initialPrompt: string; terms: string[] } {
  const seen = new Set<string>();
  const terms: string[] = [];

  const pushTerm = (raw: string) => {
    const clean = raw.replace(/^[@#.,:;!?()[\]"']+|[@#.,:;!?()[\]"']+$/g, '').trim();
    if (!clean || clean.length < 2 || clean.length > 48) return;
    if (/^https?$/i.test(clean) || /^www\./i.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(clean);
  };

  if (channelTitle) pushTerm(channelTitle);

  // Extract capitalized / CamelCase / alphanumeric proper nouns & hashtags from title and description
  const combinedSource = `${title || ''}\n${extraPrompt || ''}\n${(description || '').slice(0, 2500)}`;
  const cleanedNoUrls = combinedSource.replace(/https?:\/\/\S+/gi, ' ');

  const hashtagMatches = cleanedNoUrls.match(/#[\p{L}\p{N}_]{2,32}/gu) || [];
  hashtagMatches.forEach(pushTerm);

  const properMatches =
    cleanedNoUrls.match(/\b(?:[A-Z][a-zA-Z0-9'.-]{1,}|[A-Z]{2,}[0-9]*)\b/g) || [];
  const stopCapitalized = new Set([
    'The', 'And', 'For', 'With', 'From', 'This', 'That', 'Video', 'Channel', 'Subscribe',
    'Like', 'Share', 'Comment', 'Follow', 'Instagram', 'TikTok', 'YouTube', 'Facebook',
    'Link', 'Download', 'Full', 'Part', 'Episode', 'Eps', 'Dan', 'Yang', 'Untuk', 'Dari',
    'Dengan', 'Pada', 'Ini', 'Itu', 'Kami', 'Kita', 'Saya', 'Anda', 'Jangan', 'Lupa'
  ]);
  for (const m of properMatches) {
    if (!stopCapitalized.has(m)) pushTerm(m);
  }

  const basePieces: string[] = [];
  if (extraPrompt && extraPrompt.trim()) basePieces.push(extraPrompt.trim());
  if (title && title.trim()) basePieces.push(`Judul: ${title.trim()}.`);
  if (channelTitle && channelTitle.trim()) basePieces.push(`Channel: ${channelTitle.trim()}.`);
  if (terms.length > 0) {
    basePieces.push(`Istilah & nama penting: ${terms.slice(0, 45).join(', ')}.`);
  }

  const allWords = basePieces.join(' ').split(/\s+/).filter(Boolean);
  const capped = allWords.slice(0, maxWords).join(' ');
  return {
    initialPrompt: capped,
    terms: terms.slice(0, 45)
  };
}

// Security: SSRF guard for user-supplied Colab Whisper URL
export function validateColabWhisperUrl(rawUrl: string): { valid: boolean; url?: string; error?: string } {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return { valid: false, error: 'URL Whisper kosong.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Format URL server Whisper tidak valid.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: 'URL server Whisper hanya boleh menggunakan http:// atau https://.' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    return { valid: false, error: 'Hostname server Whisper kosong.' };
  }

  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^fc00:/i.test(host) ||
    /^fe80:/i.test(host)
  ) {
    return {
      valid: false,
      error: 'URL server Whisper tidak diizinkan mengarah ke alamat lokal/internal (SSRF blocked).'
    };
  }

  return { valid: true, url: parsed.toString() };
}

// Section D: Extract valid JSON array (preferring largest array if wrapped in markdown/prose)
export function repairAndExtractJsonArray(rawText: string): any[] | null {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
    if (direct && Array.isArray(direct.words)) return direct.words;
    if (direct && Array.isArray(direct.segments)) return direct.segments;
  } catch {
    // scan for balanced JSON arrays
  }

  let bestArray: any[] | null = null;
  let bestScore = -1;

  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '[') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          const candidateStr = cleaned.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidateStr);
            if (Array.isArray(parsed) && candidateStr.length > bestScore) {
              bestArray = parsed;
              bestScore = candidateStr.length;
            }
          } catch {
            // keep scanning
          }
          break;
        }
      }
    }
  }

  return bestArray;
}

export function repairAndExtractJsonObject(rawText: string): Record<string, any> | null {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface ParallelChunkTranscript {
  chunkIndex: number;
  chunkStartSec: number;
  chunkEndSec: number;
  words: SubtitleWord[];
}

// Section B.5: Validate chunk-relative vs absolute timestamps and deduplicate overlapping boundary words
export function mergeParallelGeminiChunks(chunks: ParallelChunkTranscript[]): SubtitleWord[] {
  const sortedChunks = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const merged: SubtitleWord[] = [];

  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  for (const chunk of sortedChunks) {
    const chunkLen = Math.max(10, chunk.chunkEndSec - chunk.chunkStartSec);
    const rawWords = (chunk.words || []).filter(
      w => w && typeof w.word === 'string' && w.word.trim().length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end)
    );
    if (rawWords.length === 0) continue;

    // Auto-detect chunk-relative timestamps on chunkIndex > 0:
    // if all timestamps sit below chunkLen + 5s while chunkStartSec >= 60s, add chunkStartSec offset!
    const maxEnd = Math.max(...rawWords.map(w => w.end));
    const minStart = Math.min(...rawWords.map(w => w.start));
    const looksRelative =
      chunk.chunkStartSec >= 10 &&
      minStart < chunk.chunkStartSec * 0.5 &&
      maxEnd <= chunkLen + 6.0;

    const absWords: SubtitleWord[] = rawWords.map(w => {
      const s = looksRelative ? chunk.chunkStartSec + w.start : w.start;
      const e = looksRelative ? chunk.chunkStartSec + w.end : w.end;
      return {
        ...w,
        word: w.word.trim(),
        start: parseFloat(Math.max(chunk.chunkStartSec, s).toFixed(3)),
        end: parseFloat(Math.min(chunk.chunkEndSec + 1.5, Math.max(s + 0.06, e)).toFixed(3))
      };
    });

    if (merged.length === 0) {
      merged.push(...absWords);
      continue;
    }

    // Deduplicate in overlap zone: skip leading words in this chunk that overlap with tail of merged
    const tailWords = merged.slice(-24);
    const lastMergedEnd = merged[merged.length - 1].end;
    let skipUntil = 0;

    for (let i = 0; i < absWords.length; i++) {
      const cand = absWords[i];
      if (cand.start > lastMergedEnd + 0.35) break;
      const candNorm = norm(cand.word);
      const isDupNearBoundary = tailWords.some(
        tw => Math.abs(tw.start - cand.start) <= 2.5 && norm(tw.word) === candNorm && candNorm.length > 0
      );
      if (isDupNearBoundary || cand.end <= lastMergedEnd - 0.1) {
        skipUntil = i + 1;
      } else {
        break;
      }
    }

    merged.push(...absWords.slice(skipUntil));
  }

  return sanitizeMonotonicWords(merged);
}
