// src/components/Deliverables/DeliverablePublicView.jsx
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getDeliverableById,
  formatFileSize,
  getSafeHttpUrl,
  getPublicDeliverableFileUrl,
  getYouTubeEmbedUrl,
} from '../../services/deliverablesService';
import { PROJECT } from '../../config/projectConfig';

export default function DeliverablePublicView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [deliverable, setDeliverable] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);

  useEffect(() => {
    const fetchDoc = async () => {
      setLoading(true);
      try {
        const data = await getDeliverableById(id);
        setDeliverable(data);
      } catch (err) {
        console.error('Error fetching deliverable:', err);
      } finally {
        setLoading(false);
      }
    };
    if (id) fetchDoc();
  }, [id]);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-semibold text-gray-700">Memuat berkas deliverable resmi...</p>
        </div>
      </div>
    );
  }

  if (!deliverable) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center border border-gray-200">
          <span className="text-5xl">📄</span>
          <h2 className="text-xl font-bold text-gray-900 mt-4">Dokumen Tidak Ditemukan</h2>
          <p className="text-xs text-gray-500 mt-2">
            Dokumen atau deliverable yang Anda cari belum tersedia atau tautan salah.
          </p>
          <button
            onClick={() => navigate('/login')}
            className="mt-6 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition"
          >
            Menuju Halaman Utama
          </button>
        </div>
      </div>
    );
  }

  const sub = deliverable.submission || {};
  const status = sub.status || 'draft';
  const files = (Array.isArray(sub.files) ? sub.files : [])
    .map((file) => ({
      ...file,
      url: getPublicDeliverableFileUrl(file),
    }))
    .filter((file) => file.url);
  const scopeChecklist = sub.scopeChecklist || {};
  const safeVideoUrl = getSafeHttpUrl(sub.videoUrl);
  const youtubeEmbedUrl = getYouTubeEmbedUrl(sub.videoUrl);

  const photoFiles = files.filter(
    (f) =>
      f.type?.startsWith('image/') ||
      /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name || '')
  );
  const videoFiles = files.filter(
    (f) =>
      f.type?.startsWith('video/') ||
      /\.(mp4|webm|mov|mkv)$/i.test(f.name || '')
  );
  const docFiles = files.filter(
    (f) => !photoFiles.includes(f) && !videoFiles.includes(f)
  );

  return (
    <div className="min-h-screen bg-slate-100/80 py-10 px-4 sm:px-6 lg:px-8 print:bg-white print:p-0">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Navigation & Action Bar (Hidden when Printing) */}
        <div className="flex items-center justify-between gap-4 print:hidden">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="px-4 py-2 bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 rounded-xl text-xs font-bold transition shadow-sm"
          >
            ← Kembali
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyLink}
              className="px-4 py-2 bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 rounded-xl text-xs font-bold transition shadow-sm"
            >
              {copied ? '✓ Link Tersalin' : '🔗 Salin Tautan'}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition shadow-sm flex items-center gap-1.5"
            >
              <span>🖨️ Cetak Lembar Dokumen</span>
            </button>
          </div>
        </div>

        {/* Main Document Paper Container */}
        <div className="bg-white rounded-3xl shadow-xl border border-gray-200 p-8 md:p-12 space-y-8 print:shadow-none print:border-none print:p-0">
          {/* Official Letterhead */}
          <div className="border-b-2 border-gray-900 pb-6">
            <div className="flex items-center justify-between gap-6">
              <div className="space-y-1">
                <p className="text-xs font-extrabold text-blue-900 tracking-widest uppercase">
                  PT SURYA ABADI KONSULTAN
                </p>
                <h1 className="text-lg md:text-xl font-black text-gray-900 leading-snug">
                  KONSULTAN MANAJEMEN PENDAMPINGAN PERSAMPAHAN KOTA PADANG (ISWMP)
                </h1>
                <p className="text-xs text-gray-600 font-medium">
                  {PROJECT.satker} · {PROJECT.location}
                </p>
              </div>
              <div className="text-right shrink-0">
                <span className="inline-block px-3 py-1 bg-blue-100 text-blue-900 rounded-xl font-mono text-xs font-black">
                  {deliverable.code}
                </span>
                <p className="text-[10px] text-gray-400 font-mono mt-1">
                  REG: {sub.registrationNumber || `DOC-${deliverable.code}/2026`}
                </p>
              </div>
            </div>
          </div>

          {/* Activity / Deliverable Header */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-xs px-3 py-1 rounded-full font-bold uppercase ${
                  status === 'approved'
                    ? 'bg-green-100 text-green-900 border border-green-300'
                    : status === 'submitted'
                    ? 'bg-blue-100 text-blue-900 border border-blue-300'
                    : 'bg-amber-100 text-amber-900 border border-amber-300'
                }`}
              >
                {status === 'approved'
                  ? '✓ Status: Disetujui & Diterima'
                  : status === 'submitted'
                  ? '⚡ Status: Berkas Resmi Submitted'
                  : '📝 Status: Draf Dokumen'}
              </span>
              {deliverable.boqRef && (
                <span className="text-xs bg-indigo-100 text-indigo-900 font-bold px-3 py-1 rounded-full border border-indigo-200">
                  {deliverable.boqRef}
                </span>
              )}
            </div>

            <h2 className="text-xl md:text-2xl font-black text-gray-900">
              {deliverable.title}
            </h2>
            <p className="text-xs md:text-sm text-gray-600 leading-relaxed">
              {deliverable.subtitle}
            </p>
          </div>

          {/* Activity Information Details (if BOQ activity or filled) */}
          {(sub.activityDate || sub.activityLocation || sub.attendeesCount || sub.speakers) && (
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-5 space-y-3">
              <h3 className="font-bold text-sm text-blue-950 flex items-center gap-2">
                <span>📋</span>
                <span>Rincian Pelaksanaan Kegiatan BOQ</span>
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                {sub.activityDate && (
                  <div>
                    <span className="text-gray-500 block">Tanggal:</span>
                    <span className="font-bold text-gray-900">
                      {new Date(sub.activityDate).toLocaleDateString('id-ID', { dateStyle: 'long' })}
                    </span>
                  </div>
                )}
                {sub.activityLocation && (
                  <div>
                    <span className="text-gray-500 block">Lokasi:</span>
                    <span className="font-bold text-gray-900">{sub.activityLocation}</span>
                  </div>
                )}
                {sub.attendeesCount && (
                  <div>
                    <span className="text-gray-500 block">Peserta Hadir:</span>
                    <span className="font-bold text-gray-900">{sub.attendeesCount}</span>
                  </div>
                )}
                {sub.speakers && (
                  <div>
                    <span className="text-gray-500 block">Narasumber/Fasilitator:</span>
                    <span className="font-bold text-gray-900">{sub.speakers}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Video Section (if any) */}
          {(videoFiles.length > 0 || sub.videoUrl) && (
            <div className="space-y-4 pt-2">
              <h3 className="font-bold text-sm md:text-base text-gray-900 flex items-center gap-2">
                <span>🎥</span>
                <span>Dokumentasi Video Kegiatan:</span>
              </h3>

              {sub.videoUrl && (
                <div className="bg-gray-900 rounded-2xl p-4 text-white overflow-hidden shadow-lg">
                  {youtubeEmbedUrl ? (
                    <div className="aspect-video w-full rounded-xl overflow-hidden bg-black">
                      <iframe
                        src={youtubeEmbedUrl}
                        title="Video Dokumentasi YouTube"
                        className="w-full h-full border-0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  ) : safeVideoUrl ? (
                    <div className="flex items-center justify-between bg-white/10 rounded-xl p-3 text-xs">
                      <span className="font-mono truncate">{sub.videoUrl}</span>
                      <a
                        href={safeVideoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shrink-0 ml-2"
                      >
                        Buka Tautan Video ↗
                      </a>
                    </div>
                  ) : (
                    <p className="rounded-xl bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-950">
                      Tautan video tidak valid dan tidak dapat dibuka.
                    </p>
                  )}
                </div>
              )}

              {videoFiles.map((vFile, idx) => (
                <div key={idx} className="bg-gray-900 rounded-2xl p-4 text-white shadow-lg space-y-2">
                  <p className="text-xs font-bold truncate">{vFile.name}</p>
                  <video controls className="w-full rounded-xl max-h-80 bg-black" src={vFile.url}>
                    Browser Anda tidak mendukung tag video.
                  </video>
                </div>
              ))}
            </div>
          )}

          {/* Photo Gallery Section */}
          {photoFiles.length > 0 && (
            <div className="space-y-4 pt-2">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-sm md:text-base text-gray-900 flex items-center gap-2">
                  <span>📸</span>
                  <span>Galeri Foto Dokumentasi Kegiatan ({photoFiles.length}):</span>
                </h3>
                <span className="text-xs text-gray-500 print:hidden">
                  Klik foto untuk melihat perbesaran
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {photoFiles.map((photo, idx) => (
                  <div
                    key={idx}
                    onClick={() => setLightboxPhoto(photo)}
                    className="group relative bg-gray-100 rounded-2xl overflow-hidden border border-gray-200 hover:shadow-lg transition aspect-square cursor-pointer"
                  >
                    <img
                      src={photo.url}
                      alt={photo.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                      loading="lazy"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition p-2 flex flex-col justify-end">
                      <p className="text-[11px] text-white font-medium truncate">{photo.name}</p>
                      <p className="text-[10px] text-gray-300">{formatFileSize(photo.size)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Lightbox for Photo View */}
          {lightboxPhoto && (
            <div
              className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 print:hidden"
              onClick={() => setLightboxPhoto(null)}
            >
              <div className="relative max-w-4xl max-h-[90vh] flex flex-col items-center">
                <button
                  onClick={() => setLightboxPhoto(null)}
                  className="absolute -top-10 right-0 text-white text-xl font-bold bg-white/20 hover:bg-white/40 rounded-full w-8 h-8 flex items-center justify-center"
                >
                  ✕
                </button>
                <img
                  src={lightboxPhoto.url}
                  alt={lightboxPhoto.name}
                  className="max-w-full max-h-[80vh] object-contain rounded-xl shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="mt-3 text-center text-white text-xs">
                  <p className="font-bold">{lightboxPhoto.name}</p>
                  <p className="text-gray-400 mt-0.5">
                    {formatFileSize(lightboxPhoto.size)} ·{' '}
                    <a
                      href={lightboxPhoto.url}
                      download={lightboxPhoto.name}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 underline hover:text-blue-300"
                    >
                      Unduh Berkas Foto Asli
                    </a>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Attached Document Files Section */}
          <div className="space-y-4 pt-2">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-sm md:text-base text-gray-900 flex items-center gap-2">
                <span>📁</span>
                <span>Berkas Dokumen Utama & Lampiran ({docFiles.length}):</span>
              </h3>
              <span className="text-xs text-gray-500">
                Penyimpanan Database Cloud PT Surya Abadi
              </span>
            </div>

            {docFiles.length === 0 ? (
              <p className="text-xs text-gray-500 italic p-4 bg-gray-50 rounded-2xl border text-center">
                Belum ada berkas dokumen digital yang terlampir pada laporan ini.
              </p>
            ) : (
              <div className="space-y-2.5">
                {docFiles.map((file, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-4 bg-slate-50 hover:bg-slate-100 rounded-2xl border border-slate-200 transition"
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <span className="text-2xl shrink-0">
                        {file.name?.endsWith('.pdf')
                          ? '📕'
                          : file.name?.endsWith('.xlsx') || file.name?.endsWith('.xls')
                          ? '📗'
                          : file.name?.endsWith('.pptx')
                          ? '📙'
                          : '📄'}
                      </span>
                      <div className="truncate">
                        <p className="font-bold text-gray-900 text-xs md:text-sm truncate">
                          {file.name}
                        </p>
                        <p className="text-[11px] text-gray-500 mt-0.5">
                          Ukuran: {formatFileSize(file.size)} · Diunggah {file.uploadedAt ? new Date(file.uploadedAt).toLocaleDateString('id-ID') : '-'}
                        </p>
                      </div>
                    </div>

                    <a
                      href={file.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={file.name}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-sm transition shrink-0 ml-3 print:hidden flex items-center gap-1.5"
                    >
                      <span>⬇️ Unduh</span>
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Scope Compliance Matrix */}
          <div className="space-y-3 pt-2">
            <h3 className="font-bold text-sm md:text-base text-gray-900 flex items-center gap-2">
              <span>☑️</span>
              <span>Matriks Pemenuhan Ruang Lingkup KAK:</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              {deliverable.scopeItems?.map((scope, idx) => {
                const isChecked = Boolean(scopeChecklist[idx]);
                return (
                  <div
                    key={idx}
                    className={`p-3 rounded-xl border flex items-start gap-2.5 ${
                      isChecked
                        ? 'bg-green-50/60 border-green-200 text-green-950'
                        : 'bg-gray-50 border-gray-200 text-gray-500'
                    }`}
                  >
                    <span className="font-bold shrink-0">
                      {isChecked ? '✓' : '○'}
                    </span>
                    <span>
                      <strong className="mr-1">{idx + 1})</strong> {scope}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Discussion & Minutes Record */}
          {(sub.discussionDate || sub.discussionNotes) && (
            <div className="p-5 bg-purple-50/70 border border-purple-200 rounded-2xl text-xs space-y-2">
              <h3 className="font-bold text-purple-950 flex items-center gap-1.5">
                <span>💬</span>
                <span>Catatan Pembahasan dengan {deliverable.discussionRequired}:</span>
              </h3>
              {sub.discussionDate && (
                <p className="text-purple-900 font-semibold">
                  Tanggal Pembahasan: {new Date(sub.discussionDate).toLocaleDateString('id-ID', { dateStyle: 'long' })}
                </p>
              )}
              {sub.discussionNotes && (
                <p className="text-purple-900 whitespace-pre-line leading-relaxed">
                  {sub.discussionNotes}
                </p>
              )}
            </div>
          )}

          {/* Formal Verification Signatures */}
          <div className="pt-8 border-t-2 border-gray-200 grid grid-cols-2 gap-8 text-center text-xs">
            <div>
              <p className="text-gray-500">Diajukan Oleh,</p>
              <p className="font-bold text-gray-900 mt-1">Konsultan Manajemen</p>
              <p className="font-extrabold text-blue-900">PT SURYA ABADI KONSULTAN</p>
              <div className="h-16 flex items-center justify-center font-script text-lg text-blue-700 italic">
                (Tanda Tangan Digital)
              </div>
              <p className="font-bold text-gray-900 underline">
                {sub.submittedBy || 'Misdar Putra'}
              </p>
              <p className="text-gray-500">Team Leader</p>
            </div>

            <div>
              <p className="text-gray-500">Diverifikasi & Diterima Oleh,</p>
              <p className="font-bold text-gray-900 mt-1">Satker / PPK Balai PU Padang</p>
              <p className="font-extrabold text-gray-700">{PROJECT.ministry}</p>
              <div className="h-16 flex items-center justify-center text-gray-400 italic">
                (Berita Acara Pembahasan)
              </div>
              <p className="font-bold text-gray-900 underline">
                Tim Bantuan Teknis / PPK
              </p>
              <p className="text-gray-500">ISWMP Kota Padang</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
