// src/components/Deliverables/DeliverableDetailModal.jsx
import { useState, useRef } from 'react';
import {
  uploadDeliverableFile,
  commitDeliverableUploads,
  deleteUncommittedDeliverableFile,
  saveDeliverableSubmission,
  getDeliverableShareUrl,
  formatFileSize,
  getSafeHttpUrl,
  getYouTubeEmbedUrl,
} from '../../services/deliverablesService';
import { auth } from '../../config/firebase';
import { PROJECT } from '../../config/projectConfig';

export const PADANG_LOCATIONS = [
  'Kelurahan Air Tawar Barat',
  'Kelurahan Air Tawar Timur',
  'Kelurahan Ulak Karang Selatan',
  'Kelurahan Ulak Karang Utara',
  'Kelurahan Lolong Belanti',
  'Kelurahan Flamboyan Baru',
  'Kelurahan Rimbo Kaluang',
  'Kelurahan Gunung Pangilun',
  'Kelurahan Kampung Lapai',
  'Kelurahan Kampung Olo',
  'Kelurahan Surau Gadang',
  'Kantor Proyek PT Surya Abadi Konsultan',
  'Balai Penataan Bangunan Prasarana Kawasan (BPBPK) Sumbar',
  'Dinas Lingkungan Hidup Kota Padang',
  'Bappeda Kota Padang',
  'Hotel / Gedung Pertemuan di Kota Padang',
  'Seluruh 11 Kelurahan Kota Padang',
];

export default function DeliverableDetailModal({
  deliverable,
  user,
  userData,
  readOnly = false,
  onClose,
  onSaved,
}) {
  const currentUser = user || auth?.currentUser;
  const [activeTab, setActiveTab] = useState(
    deliverable.isBoqActivity ? 'gallery' : 'submission'
  ); // 'submission' | 'gallery' | 'checklist' | 'discussion' | 'share'
  const [status, setStatus] = useState(deliverable.submission?.status || 'draft');
  const [scopeChecklist, setScopeChecklist] = useState(
    deliverable.submission?.scopeChecklist || {}
  );
  const [notes, setNotes] = useState(deliverable.submission?.notes || '');
  const [driveUrl, setDriveUrl] = useState(deliverable.submission?.driveUrl || '');
  const [videoUrl, setVideoUrl] = useState(deliverable.submission?.videoUrl || '');
  const [activityDate, setActivityDate] = useState(
    deliverable.submission?.activityDate || ''
  );
  const [activityLocation, setActivityLocation] = useState(
    deliverable.submission?.activityLocation || ''
  );
  const [attendeesCount, setAttendeesCount] = useState(
    deliverable.submission?.attendeesCount || ''
  );
  const [speakers, setSpeakers] = useState(
    deliverable.submission?.speakers || ''
  );
  const [discussionDate, setDiscussionDate] = useState(
    deliverable.submission?.discussionDate || ''
  );
  const [discussionNotes, setDiscussionNotes] = useState(
    deliverable.submission?.discussionNotes || ''
  );
  const [files, setFiles] = useState(deliverable.submission?.files || []);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [notification, setNotification] = useState(null);
  const [selectedPhotoPreview, setSelectedPhotoPreview] = useState(null);

  const fileInputRef = useRef(null);
  const mediaInputRef = useRef(null);
  const committedSubmissionRef = useRef(deliverable.submission || {});
  const shareUrl = getDeliverableShareUrl(deliverable.id);
  const safeVideoUrl = getSafeHttpUrl(videoUrl);
  const youtubeEmbedUrl = getYouTubeEmbedUrl(videoUrl);

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

  const buildSubmissionFormPayload = (finalStatus, nextFiles = files) => ({
    status: finalStatus,
    revision: Number.isInteger(committedSubmissionRef.current.revision)
      ? committedSubmissionRef.current.revision
      : 0,
    scopeChecklist,
    notes,
    driveUrl,
    videoUrl,
    activityDate,
    activityLocation,
    attendeesCount,
    speakers,
    discussionDate,
    discussionNotes,
    files: nextFiles,
    submittedBy:
      finalStatus === 'submitted' || finalStatus === 'approved'
        ? userData?.name || userData?.nama || 'Misdar Putra (Team Leader)'
        : committedSubmissionRef.current.submittedBy || null,
    submittedAt:
      (finalStatus === 'submitted' || finalStatus === 'approved')
        && !committedSubmissionRef.current.submittedAt
        ? new Date().toISOString()
        : committedSubmissionRef.current.submittedAt || null,
  });

  const handleToggleScope = (index) => {
    if (readOnly) return;
    setScopeChecklist((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  const handleFileUpload = async (e) => {
    if (readOnly) return;
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length === 0) return;

    setUploading(true);
    setUploadProgress(0);
    const uploadedResults = [];

    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        const res = await uploadDeliverableFile(
          deliverable.id,
          file,
          (progress) => {
            setUploadProgress(progress);
          }
        );
        uploadedResults.push(res);
      }

      const savedSubmission = await commitDeliverableUploads(
        deliverable.id,
        committedSubmissionRef.current,
        uploadedResults,
        currentUser,
        userData
      );
      committedSubmissionRef.current = savedSubmission;
      setFiles(savedSubmission.files || []);
      setNotification({
        type: 'success',
        message: `${selectedFiles.length} berkas berhasil diunggah dan disimpan.`,
      });
      if (onSaved) onSaved();
    } catch (err) {
      console.error('File upload failed:', err);
      const cleanupTargets = [...uploadedResults];
      if (err.storagePath && err.uploadReservationId) {
        cleanupTargets.push({
          storagePath: err.storagePath,
          uploadReservationId: err.uploadReservationId,
        });
      }
      const cleanupResults = await Promise.allSettled(
        cleanupTargets.map((uploadedFile) =>
          deleteUncommittedDeliverableFile(deliverable.id, uploadedFile)
        )
      );
      const cleanupFailed = cleanupResults.some(
        (result) => result.status === 'rejected'
      );
      if (cleanupFailed) {
        console.error('Some uncommitted deliverable uploads could not be cleaned up.');
      }
      setNotification({
        type: 'error',
        message: 'Gagal mengunggah/menyimpan berkas: ' +
          (err.message || 'Terjadi kesalahan'),
      });
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (mediaInputRef.current) mediaInputRef.current.value = '';
    }
  };

  const handleRemoveFile = (indexToRemove) => {
    if (readOnly) return;
    if (!window.confirm('Hapus berkas ini dari daftar deliverables?')) return;
    setFiles((prev) => prev.filter((_, idx) => idx !== indexToRemove));
  };

  const handleSave = async (submitStatus = null) => {
    if (readOnly) return;
    const finalStatus = submitStatus || status;
    setSaving(true);
    setNotification(null);

    const payload = buildSubmissionFormPayload(finalStatus);

    try {
      const savedSubmission = await saveDeliverableSubmission(
        deliverable.id,
        payload,
        currentUser,
        userData
      );
      committedSubmissionRef.current = savedSubmission;
      setNotification({
        type: 'success',
        message:
          finalStatus === 'submitted'
            ? 'Laporan berhasil disubmit ke database PT Surya Abadi Konsultan!'
            : 'Perubahan laporan berhasil disimpan.',
      });
      setStatus(finalStatus);
      if (onSaved) onSaved();
    } catch (err) {
      console.error('Save failed:', err);
      setNotification({
        type: 'error',
        message: 'Gagal menyimpan laporan: ' + err.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 3000);
  };

  const handlePrintReceipt = () => {
    window.open(shareUrl + '?print=1', '_blank');
  };

  // Calculate scope completion percentage
  const totalScopes = deliverable.scopeItems?.length || 0;
  const completedScopes = Object.values(scopeChecklist).filter(Boolean).length;
  const scopePercent = totalScopes > 0 ? Math.round((completedScopes / totalScopes) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 md:p-6">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden border border-gray-200 animate-in fade-in zoom-in-95 duration-200">
        {/* Header Modal */}
        <div className="bg-gradient-to-r from-blue-700 via-indigo-700 to-blue-800 text-white p-5 md:p-6 shrink-0 relative">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="bg-blue-900/80 text-yellow-300 font-mono font-bold text-xs px-2.5 py-0.5 rounded-full border border-yellow-300/30">
                  {deliverable.code}
                </span>
                <span className="bg-white/20 text-white text-xs px-2.5 py-0.5 rounded-full">
                  Target Cetak: {deliverable.copiesRequired} Eksemplar
                </span>
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                    status === 'approved'
                      ? 'bg-green-400 text-green-950'
                      : status === 'submitted'
                      ? 'bg-yellow-300 text-amber-950'
                      : status === 'review'
                      ? 'bg-purple-300 text-purple-950'
                      : 'bg-gray-200 text-gray-800'
                  }`}
                >
                  {status === 'approved'
                    ? '✓ Disetujui'
                    : status === 'submitted'
                    ? '⚡ Submitted'
                    : status === 'review'
                    ? '🔍 Review Tim Teknis'
                    : '📝 Draf'}
                </span>
              </div>
              <h3 className="text-xl md:text-2xl font-bold mt-1.5 text-white tracking-tight">
                {deliverable.title}
              </h3>
              <p className="text-xs md:text-sm text-blue-100 mt-1 leading-relaxed">
                {deliverable.subtitle}
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-white/70 hover:text-white bg-white/10 hover:bg-white/20 rounded-full p-2 transition shrink-0"
              title="Tutup Modal"
            >
              ✕
            </button>
          </div>

          {/* Navigation Tabs in Modal */}
          <div className="flex items-center gap-2 mt-4 overflow-x-auto border-t border-white/15 pt-3">
            <button
              onClick={() => setActiveTab('submission')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                activeTab === 'submission'
                  ? 'bg-white text-blue-900 shadow-md font-bold'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              📂 Berkas & Dokumen ({docFiles.length})
            </button>
            <button
              onClick={() => setActiveTab('gallery')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                activeTab === 'gallery'
                  ? 'bg-white text-blue-900 shadow-md font-bold'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              📷 Foto & Video Kegiatan ({photoFiles.length + videoFiles.length})
            </button>
            <button
              onClick={() => setActiveTab('checklist')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                activeTab === 'checklist'
                  ? 'bg-white text-blue-900 shadow-md font-bold'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              ☑️ Checklist KAK / BOQ ({scopePercent}%)
            </button>
            <button
              onClick={() => setActiveTab('discussion')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                activeTab === 'discussion'
                  ? 'bg-white text-blue-900 shadow-md font-bold'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              💬 Pembahasan & Berita Acara
            </button>
            <button
              onClick={() => setActiveTab('share')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                activeTab === 'share'
                  ? 'bg-white text-blue-900 shadow-md font-bold'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              🔗 Tautan & Bukti Kirim
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 md:p-6 overflow-y-auto flex-1 space-y-6">
          {readOnly && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
              Mode pemantauan aktif. Data dapat dilihat dan diunduh, tetapi tidak dapat diubah.
            </div>
          )}

          {notification && (
            <div
              className={`p-4 rounded-xl text-sm font-medium flex items-center justify-between gap-3 ${
                notification.type === 'success'
                  ? 'bg-green-50 border border-green-200 text-green-800'
                  : 'bg-red-50 border border-red-200 text-red-800'
              }`}
            >
              <span>{notification.message}</span>
              <button
                onClick={() => setNotification(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
          )}

          {/* TAB 1: SUBMISSION & FILE UPLOADS */}
          {activeTab === 'submission' && (
            <div className="space-y-5">
              {/* Executive Summary / Pengantar */}
              <div>
                <label className="block text-sm font-bold text-gray-800 mb-1.5">
                  Ringkasan Eksekutif & Catatan Pengantar Team Leader
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  readOnly={readOnly}
                  rows={3}
                  placeholder={`Contoh: Dokumen ${deliverable.title} telah disiapkan mencakup seluruh substansi pendampingan lapangan, baseline data, dan tindak lanjut rekomendasi KAK...`}
                  className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                />
              </div>

              {/* Upload Dropzone */}
              {!readOnly && <div>
                <label className="block text-sm font-bold text-gray-800 mb-1.5">
                  Unggah Dokumen Utama & Lampiran Berkas (PDF / Word / Excel / ZIP)
                </label>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-blue-300 hover:border-blue-500 bg-blue-50/50 hover:bg-blue-50 rounded-2xl p-6 text-center cursor-pointer transition flex flex-col items-center justify-center group"
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    multiple
                    accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.zip,.rar,.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm"
                    className="hidden"
                  />
                  <div className="w-12 h-12 bg-blue-100 group-hover:bg-blue-200 rounded-2xl flex items-center justify-center text-2xl transition mb-2">
                    📂
                  </div>
                  <p className="text-sm font-bold text-blue-950">
                    Klik atau Seret Berkas ke Sini untuk Mengunggah
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Format: PDF, Word (DOCX), Excel (XLSX), PowerPoint (PPTX), ZIP, Foto, Video
                  </p>
                </div>

                {uploading && (
                  <div className="mt-3 bg-blue-50 border border-blue-200 rounded-xl p-3">
                    <div className="flex justify-between text-xs font-semibold text-blue-900 mb-1">
                      <span>Mengunggah ke Cloud Storage PT Surya Abadi...</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <div className="w-full bg-blue-200 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-blue-600 h-2 transition-all duration-300"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>}

              {/* Output Deliverables Checklist Guidance */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-xs text-amber-950">
                <span className="font-bold flex items-center gap-1">
                  <span>📌</span>
                  <span>Kelengkapan Berkas Sesuai KAK & BOQ Kontrak:</span>
                </span>
                <ul className="list-disc list-inside mt-1 space-y-0.5 text-amber-900">
                  {deliverable.requiredDeliverableOutputs?.map((out, idx) => (
                    <li key={idx}>{out}</li>
                  ))}
                </ul>
              </div>

              {/* Uploaded Files List */}
              <div>
                <h4 className="text-sm font-bold text-gray-800 mb-2">
                  Daftar Berkas Dokumen Tersimpan ({docFiles.length}):
                </h4>
                {docFiles.length === 0 ? (
                  <p className="text-xs text-gray-500 italic p-3 bg-gray-50 rounded-xl border border-gray-200 text-center">
                    Belum ada berkas dokumen yang diunggah. Silakan unggah dokumen laporan, notula, atau berita acara.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {docFiles.map((file, idx) => {
                      const realIndex = files.indexOf(file);
                      return (
                        <div
                          key={idx}
                          className="flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100/80 rounded-xl border border-gray-200 transition text-sm"
                        >
                          <div className="flex items-center gap-3 overflow-hidden">
                            <span className="text-xl shrink-0">
                              {file.name?.endsWith('.pdf')
                                ? '📕'
                                : file.name?.endsWith('.xlsx') || file.name?.endsWith('.xls')
                                ? '📗'
                                : file.name?.endsWith('.pptx')
                                ? '📙'
                                : '📄'}
                            </span>
                            <div className="truncate">
                              <p className="font-semibold text-gray-800 truncate">
                                {file.name}
                              </p>
                              <p className="text-xs text-gray-500">
                                {formatFileSize(file.size)} · Diunggah {file.uploadedAt ? new Date(file.uploadedAt).toLocaleDateString('id-ID') : 'Baru saja'}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            <a
                              href={file.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              download={file.name}
                              className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition"
                            >
                              Unduh ⬇️
                            </a>
                            {!readOnly && (
                              <button
                                type="button"
                                onClick={() => handleRemoveFile(realIndex)}
                                className="px-2 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-xs font-semibold transition"
                                title="Hapus berkas"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Cloud / Google Drive Link (Optional) */}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Tautan Cloud Tambahan / Google Drive Folder (Opsional)
                </label>
                <input
                  type="url"
                  value={driveUrl}
                  onChange={(e) => setDriveUrl(e.target.value)}
                  readOnly={readOnly}
                  placeholder="https://drive.google.com/drive/folders/..."
                  className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition font-mono"
                />
              </div>
            </div>
          )}

          {/* TAB 2: GALLERY FOTO & VIDEO KEGIATAN */}
          {activeTab === 'gallery' && (
            <div className="space-y-6">
              {/* Kegiatan BOQ Metadata Form */}
              <div className="bg-gradient-to-br from-blue-50/70 to-indigo-50/70 border border-blue-200/80 rounded-2xl p-4 md:p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-blue-950 flex items-center gap-2">
                    <span>📋</span>
                    <span>Informasi Pelaksanaan Kegiatan BOQ</span>
                  </h4>
                  {deliverable.boqRef && (
                    <span className="text-[11px] font-bold bg-blue-600 text-white px-2.5 py-0.5 rounded-full shadow-sm">
                      {deliverable.boqRef}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div>
                    <label className="block font-bold text-gray-700 mb-1">
                      Tanggal Pelaksanaan Kegiatan:
                    </label>
                    <input
                      type="date"
                      value={activityDate}
                      onChange={(e) => setActivityDate(e.target.value)}
                      readOnly={readOnly}
                      className="w-full px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 bg-white font-medium"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-gray-700 mb-1">
                      Lokasi / Kelurahan Pelaksanaan:
                    </label>
                    <input
                      type="text"
                      list="padang-locations-list"
                      value={activityLocation}
                      onChange={(e) => setActivityLocation(e.target.value)}
                      readOnly={readOnly}
                      placeholder="Pilih atau ketik nama kelurahan / gedung..."
                      className="w-full px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 bg-white font-medium"
                    />
                    <datalist id="padang-locations-list">
                      {PADANG_LOCATIONS.map((loc, idx) => (
                        <option key={idx} value={loc} />
                      ))}
                    </datalist>
                  </div>

                  <div>
                    <label className="block font-bold text-gray-700 mb-1">
                      Jumlah Peserta / Warga Hadir:
                    </label>
                    <input
                      type="text"
                      value={attendeesCount}
                      onChange={(e) => setAttendeesCount(e.target.value)}
                      readOnly={readOnly}
                      placeholder="Contoh: 50 Orang / 25 Peserta RW"
                      className="w-full px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 bg-white font-medium"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-gray-700 mb-1">
                      Narasumber / Fasilitator / Tim Ahli:
                    </label>
                    <input
                      type="text"
                      value={speakers}
                      onChange={(e) => setSpeakers(e.target.value)}
                      readOnly={readOnly}
                      placeholder="Contoh: Misdar Putra (TL), DLH Padang, BPBPK Sumbar"
                      className="w-full px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 bg-white font-medium"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700 mb-1">
                    Tautan Video Dokumentasi (YouTube / Google Drive / Google Photos):
                  </label>
                  <input
                    type="url"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    readOnly={readOnly}
                    placeholder="https://youtu.be/... atau https://drive.google.com/file/d/..."
                    className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                  />
                </div>
              </div>

              {/* Upload Media Dropzone */}
              {!readOnly && <div>
                <label className="block text-sm font-bold text-gray-800 mb-1.5">
                  Unggah Foto-Foto Kegiatan & Berkas Video
                </label>
                <div
                  onClick={() => mediaInputRef.current?.click()}
                  className="border-2 border-dashed border-indigo-300 hover:border-indigo-500 bg-indigo-50/40 hover:bg-indigo-50 rounded-2xl p-6 text-center cursor-pointer transition flex flex-col items-center justify-center group"
                >
                  <input
                    type="file"
                    ref={mediaInputRef}
                    onChange={handleFileUpload}
                    multiple
                    accept="image/*,video/*,.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm"
                    className="hidden"
                  />
                  <div className="w-12 h-12 bg-indigo-100 group-hover:bg-indigo-200 rounded-2xl flex items-center justify-center text-2xl transition mb-2">
                    📸
                  </div>
                  <p className="text-sm font-bold text-indigo-950">
                    Klik atau Seret Foto & Video ke Sini untuk Mengunggah
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Mendukung: JPG, PNG, WEBP, MP4, WEBM, MOV
                  </p>
                </div>
              </div>}

              {/* Video Player Section */}
              {(videoFiles.length > 0 || videoUrl) && (
                <div className="space-y-3">
                  <h4 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                    <span>🎥</span>
                    <span>Video Dokumentasi Kegiatan ({videoFiles.length + (videoUrl ? 1 : 0)})</span>
                  </h4>

                  {videoUrl && (
                    <div className="bg-gray-900 rounded-2xl p-4 text-white overflow-hidden shadow-lg">
                      <p className="text-xs text-gray-300 font-medium mb-2 flex items-center gap-1.5">
                        <span>▶️</span>
                        <span>Video Tautan Eksternal</span>
                      </p>
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
                          <span className="font-mono truncate">{videoUrl}</span>
                          <a
                            href={safeVideoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shrink-0 ml-2"
                          >
                            Buka Video ↗
                          </a>
                        </div>
                      ) : (
                        <p className="rounded-xl bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-950">
                          Masukkan tautan lengkap yang diawali https:// atau http://.
                        </p>
                      )}
                    </div>
                  )}

                  {videoFiles.map((vFile, idx) => {
                    const realIndex = files.indexOf(vFile);
                    return (
                      <div key={idx} className="bg-gray-900 rounded-2xl p-4 text-white shadow-lg space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold truncate">{vFile.name} ({formatFileSize(vFile.size)})</span>
                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() => handleRemoveFile(realIndex)}
                              className="text-red-400 hover:text-red-300 bg-red-950/40 px-2 py-1 rounded"
                            >
                              Hapus ✕
                            </button>
                          )}
                        </div>
                        <video controls className="w-full rounded-xl max-h-72 bg-black" src={vFile.url}>
                          Browser Anda tidak mendukung tag video.
                        </video>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Photo Gallery Grid Section */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                    <span>🖼️</span>
                    <span>Galeri Foto Dokumentasi Lapangan ({photoFiles.length})</span>
                  </h4>
                  {photoFiles.length > 0 && (
                    <span className="text-xs text-gray-500">
                      Klik foto untuk memperbesar
                    </span>
                  )}
                </div>

                {photoFiles.length === 0 ? (
                  <div className="p-6 bg-gray-50 border border-gray-200 rounded-2xl text-center text-xs text-gray-500 italic">
                    Belum ada foto dokumentasi yang diunggah. Unggah foto-foto pelaksanaan kegiatan di atas.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {photoFiles.map((photo, idx) => {
                      const realIndex = files.indexOf(photo);
                      return (
                        <div
                          key={idx}
                          className="group relative bg-gray-100 rounded-xl overflow-hidden border border-gray-200 hover:shadow-md transition aspect-square flex flex-col justify-end"
                        >
                          <img
                            src={photo.url}
                            alt={photo.name}
                            className="absolute inset-0 w-full h-full object-cover cursor-pointer group-hover:scale-105 transition duration-300"
                            onClick={() => setSelectedPhotoPreview(photo)}
                            loading="lazy"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20 opacity-0 group-hover:opacity-100 transition p-2 flex flex-col justify-between">
                            <div className="flex justify-end">
                              {!readOnly && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveFile(realIndex);
                                  }}
                                  className="p-1 bg-red-600/80 hover:bg-red-600 text-white rounded-lg text-xs"
                                  title="Hapus foto"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                            <div>
                              <p className="text-[11px] text-white font-medium truncate">
                                {photo.name}
                              </p>
                              <div className="flex items-center justify-between text-[10px] text-gray-300 mt-0.5">
                                <span>{formatFileSize(photo.size)}</span>
                                <span
                                  onClick={() => setSelectedPhotoPreview(photo)}
                                  className="underline cursor-pointer text-blue-300 hover:text-white"
                                >
                                  Perbesar 🔍
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Lightbox Modal for Photo Preview */}
          {selectedPhotoPreview && (
            <div
              className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
              onClick={() => setSelectedPhotoPreview(null)}
            >
              <div className="relative max-w-4xl max-h-[90vh] flex flex-col items-center">
                <button
                  onClick={() => setSelectedPhotoPreview(null)}
                  className="absolute -top-10 right-0 text-white text-xl font-bold bg-white/20 hover:bg-white/40 rounded-full w-8 h-8 flex items-center justify-center"
                >
                  ✕
                </button>
                <img
                  src={selectedPhotoPreview.url}
                  alt={selectedPhotoPreview.name}
                  className="max-w-full max-h-[80vh] object-contain rounded-xl shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="mt-3 text-center text-white text-xs">
                  <p className="font-bold">{selectedPhotoPreview.name}</p>
                  <p className="text-gray-400 mt-0.5">
                    {formatFileSize(selectedPhotoPreview.size)} ·{' '}
                    <a
                      href={selectedPhotoPreview.url}
                      download={selectedPhotoPreview.name}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 underline hover:text-blue-300"
                    >
                      Unduh Berkas Asli
                    </a>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: SCOPE CHECKLIST */}
          {activeTab === 'checklist' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-blue-50 p-4 rounded-xl border border-blue-200">
                <div>
                  <h4 className="text-sm font-bold text-blue-950">
                    Kepatuhan Ruang Lingkup Dokumen KAK
                  </h4>
                  <p className="text-xs text-blue-800 mt-0.5">
                    Centang seluruh substansi KAK yang telah dimuat di dalam dokumen laporan ini.
                  </p>
                </div>
                <span className="text-lg font-black text-blue-700 bg-white px-3 py-1 rounded-xl shadow-sm">
                  {completedScopes} / {totalScopes}
                </span>
              </div>

              <div className="space-y-2.5">
                {deliverable.scopeItems?.map((scope, index) => {
                  const isChecked = Boolean(scopeChecklist[index]);
                  return (
                    <label
                      key={index}
                      onClick={() => handleToggleScope(index)}
                      className={`flex items-start gap-3 p-3.5 rounded-xl border transition select-none ${
                        readOnly ? 'cursor-default' : 'cursor-pointer'
                      } ${
                        isChecked
                          ? 'bg-green-50/80 border-green-300 text-green-950 shadow-sm'
                          : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        disabled={readOnly}
                        className="mt-0.5 w-4 h-4 text-green-600 rounded focus:ring-green-500"
                      />
                      <div className="text-xs md:text-sm">
                        <span className="font-bold mr-1.5">
                          {index + 1})
                        </span>
                        <span className={isChecked ? 'font-semibold' : ''}>
                          {scope}
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: DISCUSSION & MINUTES */}
          {activeTab === 'discussion' && (
            <div className="space-y-4">
              <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
                <h4 className="text-sm font-bold text-purple-950">
                  Pembahasan dengan {deliverable.discussionRequired}
                </h4>
                <p className="text-xs text-purple-800 mt-0.5">
                  Catat tanggal pembahasan, masukan tim teknis, serta lampirkan Berita Acara (BA) pembahasan.
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Tanggal Pelaksanaan Pembahasan / Paparan
                </label>
                <input
                  type="date"
                  value={discussionDate}
                  onChange={(e) => setDiscussionDate(e.target.value)}
                  readOnly={readOnly}
                  className="w-full md:w-64 px-3 py-2 text-xs border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Catatan Rekomendasi & Hasil Pembahasan Tim Teknis
                </label>
                <textarea
                  value={discussionNotes}
                  onChange={(e) => setDiscussionNotes(e.target.value)}
                  readOnly={readOnly}
                  rows={4}
                  placeholder="Catatan hasil diskusi dengan Tim Bantuan Teknis / BPBPK, saran perbaikan dokumen, atau kesepakatan final..."
                  className="w-full px-3.5 py-2.5 text-xs border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition"
                />
              </div>
            </div>
          )}

          {/* TAB 4: SHARE LINK & RECEIPT */}
          {activeTab === 'share' && (
            <div className="space-y-5">
              <div className="bg-gradient-to-r from-cyan-50 to-blue-50 border border-cyan-200 rounded-2xl p-5">
                <h4 className="text-sm font-bold text-cyan-950 flex items-center gap-1.5">
                  <span>🔗</span>
                  <span>Tautan Dokumen Resmi (Shareable Link)</span>
                </h4>
                <p className="text-xs text-cyan-800 mt-1 leading-relaxed">
                  Tautan ini dapat diberikan kepada Balai PU Padang, CPIU, BPBPK, maupun Direksi PT Surya Abadi Konsultan untuk melihat dan mengunduh berkas laporan secara resmi.
                </p>

                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={shareUrl}
                    className="flex-1 px-3 py-2 text-xs bg-white border border-cyan-300 rounded-xl font-mono text-cyan-900 select-all"
                  />
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl text-xs font-bold transition shrink-0"
                  >
                    {copiedLink ? '✓ Tersalin' : 'Salin Link'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl">
                  <p className="text-xs text-gray-500 font-medium">Nomor Registrasi Dokumen</p>
                  <p className="text-sm font-bold text-gray-800 font-mono mt-0.5">
                    {deliverable.submission?.registrationNumber || `DOC-ISWMP-${deliverable.code}/SAK/2026`}
                  </p>
                </div>
                <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl">
                  <p className="text-xs text-gray-500 font-medium">Pengunggah / Team Leader</p>
                  <p className="text-sm font-bold text-gray-800 mt-0.5">
                    {deliverable.submission?.submittedBy || userData?.name || 'Misdar Putra'}
                  </p>
                </div>
              </div>

              <div className="pt-2 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={handlePrintReceipt}
                  className="px-4 py-2.5 bg-gray-800 hover:bg-gray-900 text-white rounded-xl text-xs font-bold transition flex items-center gap-2"
                >
                  <span>🖨️</span>
                  <span>Buka Pratinjau Dokumen / Cetak Tanda Terima</span>
                </button>
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2.5 bg-blue-100 hover:bg-blue-200 text-blue-900 rounded-xl text-xs font-bold transition flex items-center gap-1.5"
                >
                  <span>👁️</span>
                  <span>Lihat Halaman Publik</span>
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="bg-gray-50 border-t border-gray-200 p-4 md:p-5 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
          {readOnly ? (
            <p className="text-xs font-semibold text-amber-800">
              Hanya lihat — unggah, perubahan status, simpan, dan submit dinonaktifkan.
            </p>
          ) : (
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <label className="text-xs text-gray-600 font-medium">Ubah Status:</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="text-xs border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white font-medium focus:ring-2 focus:ring-blue-500"
              >
                <option value="draft">📝 Draf</option>
                <option value="submitted">⚡ Submitted</option>
                <option value="review">🔍 Review Tim Teknis</option>
                <option value="approved">✓ Disetujui (BA Lengkap)</option>
              </select>
            </div>
          )}

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2.5 text-xs font-semibold text-gray-700 bg-white hover:bg-gray-100 border border-gray-300 rounded-xl transition disabled:opacity-50"
            >
              Tutup
            </button>
            {!readOnly && (
              <>
                <button
                  type="button"
                  onClick={() => handleSave()}
                  disabled={saving || uploading}
                  className="px-4 py-2.5 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition disabled:opacity-50"
                >
                  {saving
                    ? 'Menyimpan...'
                    : status === 'draft'
                    ? 'Simpan Draf'
                    : 'Simpan Perubahan'}
                </button>
                <button
                  type="button"
                  onClick={() => handleSave('submitted')}
                  disabled={saving || uploading}
                  className="px-5 py-2.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-md hover:shadow-blue-600/30 rounded-xl transition disabled:opacity-50 flex items-center gap-1.5"
                >
                  <span>🚀</span>
                  <span>{saving ? 'Memproses...' : 'Kirim & Submit Laporan'}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
