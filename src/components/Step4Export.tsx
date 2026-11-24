import React, { useState, useEffect, useMemo } from 'react';
import JSZip from 'jszip';
import {
  ArrowLeft,
  Download,
  FileText,
  Share2,
  RefreshCw,
  Archive,
  AlertTriangle,
  Loader2,
  FolderDown
} from 'lucide-react';
import { RenderedClipRecord, VideoInfo } from '../types.ts';
import { formatClockMinSec } from '../utils/subtitleParser.ts';
import { convertBlobToMp4OnServer } from '../utils/renderEngine.ts';

interface Step4ExportProps {
  videoInfo: VideoInfo;
  renderedClips: RenderedClipRecord[];
  onReRenderClip: (clipId: string) => void;
  onBackToRender: () => void;
}

function sanitizeFilename(input: string, maxLen = 48): string {
  return (input || 'klip')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, maxLen) || 'klip';
}

function csvCell(val: string | number): string {
  const s = String(val ?? '').replace(/"/g, '""');
  return `"${s}"`;
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function getScoreBadgeClass(score: number): string {
  if (score >= 80) return 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300';
  if (score >= 60) return 'bg-amber-500/15 border-amber-500/40 text-amber-300';
  return 'bg-red-500/15 border-red-500/40 text-red-300';
}

export const Step4Export: React.FC<Step4ExportProps> = ({
  videoInfo,
  renderedClips,
  onReRenderClip,
  onBackToRender
}) => {
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [zipProgress, setZipProgress] = useState<number | null>(null);
  const [zipStatus, setZipStatus] = useState<string>('');
  const [zipError, setZipError] = useState<string | null>(null);

  const canShareFiles = useMemo(() => {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;
    if (typeof navigator.canShare === 'function') {
      try {
        const testFile = new File(['x'], 'test.mp4', { type: 'video/mp4' });
        return navigator.canShare({ files: [testFile] });
      } catch {
        return false;
      }
    }
    return true;
  }, []);

  // Manage Blob Object URLs cleanly for video players
  useEffect(() => {
    const nextMap: Record<string, string> = {};
    renderedClips.forEach(rec => {
      nextMap[rec.clipId] = URL.createObjectURL(rec.captionedBlob);
    });
    setPreviewUrls(nextMap);
    return () => {
      Object.values(nextMap).forEach(url => URL.revokeObjectURL(url));
    };
  }, [renderedClips]);

  const totalBytes = useMemo(
    () =>
      renderedClips.reduce(
        (sum, r) => sum + (r.captionedBlob?.size || 0) + (r.cleanBlob?.size || 0),
        0
      ),
    [renderedClips]
  );
  const totalMb = totalBytes / (1024 * 1024);
  const exceedsMemorySafeLimit = totalMb > 500;

  const categoriesList = useMemo(() => {
    const map = new Map<string, RenderedClipRecord[]>();
    renderedClips.forEach(r => {
      const list = map.get(r.category) || [];
      list.push(r);
      map.set(r.category, list);
    });
    return Array.from(map.entries());
  }, [renderedClips]);

  const [convertingClipId, setConvertingClipId] = useState<string | null>(null);

  const handleDownloadVideo = async (rec: RenderedClipRecord, useClean = false) => {
    let blob = useClean && rec.cleanBlob ? rec.cleanBlob : rec.captionedBlob;
    let ext = rec.extension;
    if (ext !== 'mp4') {
      try {
        setConvertingClipId(rec.clipId);
        blob = await convertBlobToMp4OnServer(blob);
        ext = 'mp4';
      } catch (err: any) {
        setZipError(err?.message || 'Gagal mengonversi ke MP4.');
        return;
      } finally {
        setConvertingClipId(null);
      }
    }
    const nn = String(rec.clipNumber).padStart(2, '0');
    const cat = sanitizeFilename(rec.category, 24);
    const title = sanitizeFilename(rec.title, 40);
    const suffix = useClean ? '_tanpa_subtitle' : '';
    triggerBlobDownload(blob, `${nn}_${cat}_${title}${suffix}.${ext}`);
  };

  const handleDownloadSrt = (rec: RenderedClipRecord) => {
    const nn = String(rec.clipNumber).padStart(2, '0');
    const cat = sanitizeFilename(rec.category, 24);
    const title = sanitizeFilename(rec.title, 40);
    const blob = new Blob([rec.srtContent || ''], { type: 'text/plain;charset=utf-8' });
    triggerBlobDownload(blob, `${nn}_${cat}_${title}.srt`);
  };

  const handleShareClip = async (rec: RenderedClipRecord) => {
    if (!canShareFiles) return;
    const nn = String(rec.clipNumber).padStart(2, '0');
    const title = sanitizeFilename(rec.title, 36);
    const file = new File([rec.captionedBlob], `${nn}_${title}.${rec.extension}`, {
      type: rec.mimeType
    });
    try {
      await navigator.share({
        title: rec.title,
        text: `${rec.title} (${rec.category})`,
        files: [file]
      });
    } catch {
      // ignore user cancel
    }
  };

  const buildAndDownloadZip = async (recordsToZip: RenderedClipRecord[], zipFilename: string) => {
    if (recordsToZip.length === 0) return;
    setZipProgress(2);
    setZipStatus('Menyiapkan arsip ZIP...');
    setZipError(null);

    try {
      const zip = new JSZip();

      // Add files per category folder
      for (const rec of recordsToZip) {
        const folderName = sanitizeFilename(rec.category, 32);
        const folder = zip.folder(folderName) || zip;
        const nn = String(rec.clipNumber).padStart(2, '0');
        const safeTitle = sanitizeFilename(rec.title, 42);
        const baseName = `${nn}_${safeTitle}`;

        folder.file(`${baseName}.${rec.extension}`, rec.captionedBlob);
        if (rec.cleanBlob) {
          folder.file(`${baseName}_tanpa_subtitle.${rec.extension}`, rec.cleanBlob);
        }
        folder.file(`${baseName}.srt`, rec.srtContent || '');

        const infoTxt = [
          `Judul Hook : ${rec.title}`,
          `Kategori   : ${rec.category}`,
          `Skor Viral : ${rec.viralityScore}/100 (estimasi)`,
          `Waktu      : ${formatClockMinSec(rec.startTime)} - ${formatClockMinSec(rec.endTime)} (${Math.round(rec.duration)} dtk)`,
          `Kualitas   : ${rec.qualityLabel}`,
          '',
          'Alasan Pilihan:',
          ...(rec.reasons || []).map((r, idx) => `${idx + 1}. ${r}`),
          '',
          'Transkrip:',
          rec.transcriptText || '(kosong)'
        ].join('\n');
        folder.file(`${baseName}.txt`, infoTxt);
      }

      // Root clips.csv with UTF-8 BOM
      const csvHeader = [
        'nomor',
        'kategori',
        'judul',
        'mulai',
        'selesai',
        'durasi',
        'skor',
        'alasan',
        'label_kualitas_transkrip'
      ].join(',');
      const csvRows = recordsToZip.map(rec =>
        [
          rec.clipNumber,
          csvCell(rec.category),
          csvCell(rec.title),
          csvCell(formatClockMinSec(rec.startTime)),
          csvCell(formatClockMinSec(rec.endTime)),
          Math.round(rec.duration),
          rec.viralityScore,
          csvCell((rec.reasons || []).join(' | ')),
          csvCell(rec.qualityLabel)
        ].join(',')
      );
      const csvContent = '\uFEFF' + [csvHeader, ...csvRows].join('\n');
      zip.file('clips.csv', csvContent);

      // Root BACA_DULU.txt
      const readmeTxt = [
        `CLIP STUDIO AI — PAKET EKSPOR VIDEO`,
        `Video Sumber : ${videoInfo.title}`,
        `Channel      : ${videoInfo.channelTitle}`,
        `Tautan       : ${videoInfo.url}`,
        `Jumlah Klip  : ${recordsToZip.length}`,
        '',
        'ISI ARSIP:',
        '- Folder per kategori berisi video hasil render (.mp4/.webm), subtitle (.srt), dan catatan (.txt).',
        '- clips.csv berisi ringkasan seluruh klip (UTF-8 BOM, siap dibuka di Microsoft Excel / Google Sheets).',
        '',
        'CATATAN:',
        '- Skor virality adalah estimasi AI untuk membantu kurasi konten.',
        '- Jika video berformat .webm karena keterbatasan browser, Anda dapat membukanya di Chrome, VLC, atau CapCut.'
      ].join('\n');
      zip.file('BACA_DULU.txt', readmeTxt);

      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'STORE' },
        meta => {
          setZipProgress(Math.max(5, Math.round(meta.percent)));
          setZipStatus(`Mengemas berkas ke ZIP... ${Math.round(meta.percent)}%`);
        }
      );

      triggerBlobDownload(blob, zipFilename);
      setZipProgress(null);
      setZipStatus('');
    } catch (err: any) {
      setZipProgress(null);
      setZipStatus('');
      setZipError(
        `Gagal membuat ZIP (${err?.message || 'memori browser tidak mencukupi'}). Unduh per kategori atau unduh klip satu per satu di bawah.`
      );
    }
  };

  const handleDownloadAllZip = () => {
    const safeVideoTitle = sanitizeFilename(videoInfo.title, 32);
    void buildAndDownloadZip(renderedClips, `ClipStudioAI_${safeVideoTitle}.zip`);
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-5 pb-10">
      {/* Header & Main ZIP Action */}
      <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBackToRender}
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Antrean Render</span>
          </button>
          <div>
            <h2 className="text-base font-bold text-slate-100">Hasil &amp; Ekspor</h2>
            <p className="text-xs text-slate-400 font-mono-num">
              {renderedClips.length} klip selesai · Total {totalMb.toFixed(1)} MB
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleDownloadAllZip}
          disabled={renderedClips.length === 0 || zipProgress !== null}
          className="min-h-[48px] px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 transition cursor-pointer"
        >
          {zipProgress !== null ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Membuat ZIP ({zipProgress}%)</span>
            </>
          ) : (
            <>
              <Archive className="w-4 h-4" />
              <span>Unduh Semua (ZIP)</span>
            </>
          )}
        </button>
      </div>

      {/* ZIP Progress */}
      {zipProgress !== null && (
        <div className="bg-[#121826] border border-slate-800 rounded-xl p-3.5 space-y-2 text-xs">
          <div className="flex justify-between text-slate-200 font-semibold">
            <span>{zipStatus}</span>
            <span className="font-mono-num text-emerald-400">{zipProgress}%</span>
          </div>
          <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-150"
              style={{ width: `${zipProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* > 500 MB Warning or ZIP Memory Error -> Per-Category Download Options */}
      {(exceedsMemorySafeLimit || zipError) && (
        <div className="bg-amber-950/40 border border-amber-500/40 rounded-2xl p-4 space-y-3 text-xs text-amber-200">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-amber-100">
                {zipError ? 'Pembuatan ZIP Terhenti' : 'Ukuran Total Melebihi 500 MB'}
              </div>
              <p className="mt-0.5 leading-relaxed">
                {zipError ||
                  `Total ukuran file (${totalMb.toFixed(0)} MB) cukup besar untuk memori browser HP/desktop. Gunakan tombol Unduh per Kategori di bawah atau unduh tiap klip satu per satu.`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {categoriesList.map(([cat, recs]) => (
              <button
                key={cat}
                type="button"
                disabled={zipProgress !== null}
                onClick={() =>
                  void buildAndDownloadZip(
                    recs,
                    `ClipStudioAI_${sanitizeFilename(cat, 24)}.zip`
                  )
                }
                className="min-h-[40px] px-3.5 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-100 font-semibold flex items-center gap-1.5"
              >
                <FolderDown className="w-4 h-4" />
                <span>Unduh ZIP: {cat} ({recs.length})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Gallery */}
      {renderedClips.length === 0 ? (
        <div className="bg-[#121826] border border-slate-800 rounded-2xl p-8 text-center text-sm text-slate-400">
          Belum ada klip yang dirender untuk video ini. Kembali ke Langkah 3 untuk mulai merender.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {renderedClips.map(rec => (
            <div
              key={rec.clipId}
              className="bg-[#121826] border border-slate-800 rounded-2xl overflow-hidden flex flex-col justify-between"
            >
              {/* Video Player */}
              <div className="bg-black aspect-[9/16] max-h-[360px] w-full flex items-center justify-center border-b border-slate-800">
                {previewUrls[rec.clipId] ? (
                  <video
                    src={previewUrls[rec.clipId]}
                    controls
                    playsInline
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <Loader2 className="w-6 h-6 text-slate-500 animate-spin" />
                )}
              </div>

              {/* Card Body & Actions */}
              <div className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono-num text-xs text-slate-400">#{rec.clipNumber}</span>
                      <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-[11px] font-semibold text-slate-200">
                        {rec.category}
                      </span>
                    </div>
                    <h3 className="text-sm font-bold text-slate-100 line-clamp-2">{rec.title}</h3>
                  </div>

                  <span
                    className={`px-2 py-1 rounded-lg border font-mono-num text-xs font-bold shrink-0 ${getScoreBadgeClass(
                      rec.viralityScore
                    )}`}
                  >
                    {rec.viralityScore}
                  </span>
                </div>

                <div className="text-xs text-slate-400 font-mono-num flex items-center justify-between">
                  <span>{Math.round(rec.duration)} dtk</span>
                  <span>
                    {rec.extension.toUpperCase()} · {(rec.captionedBlob.size / (1024 * 1024)).toFixed(1)} MB
                  </span>
                </div>

                {/* Action Buttons */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    type="button"
                    disabled={convertingClipId === rec.clipId}
                    onClick={() => void handleDownloadVideo(rec, false)}
                    className="min-h-[42px] px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5"
                  >
                    {convertingClipId === rec.clipId ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Konversi MP4...</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5" />
                        <span>Unduh MP4</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadSrt(rec)}
                    className="min-h-[42px] px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold text-xs flex items-center justify-center gap-1.5"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>Unduh SRT</span>
                  </button>

                  {canShareFiles && (
                    <button
                      type="button"
                      onClick={() => handleShareClip(rec)}
                      className="min-h-[42px] px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold text-xs flex items-center justify-center gap-1.5"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      <span>Bagikan</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onReRenderClip(rec.clipId)}
                    className={`min-h-[42px] px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 font-semibold text-xs flex items-center justify-center gap-1.5 ${
                      canShareFiles ? '' : 'col-span-2'
                    }`}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Render Ulang</span>
                  </button>
                </div>

                {rec.cleanBlob && (
                  <button
                    type="button"
                    onClick={() => handleDownloadVideo(rec, true)}
                    className="w-full py-2 text-xs text-slate-400 hover:text-slate-200 underline"
                  >
                    Unduh versi tanpa subtitle ({(rec.cleanBlob.size / (1024 * 1024)).toFixed(1)} MB)
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
