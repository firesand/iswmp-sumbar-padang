// src/components/Deliverables/DeliverablesHub.jsx
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getAllDeliverables,
  DELIVERABLE_CATEGORIES,
  getDeliverableShareUrl,
  formatFileSize,
} from '../../services/deliverablesService';
import { auth } from '../../config/firebase';
import DeliverableDetailModal from './DeliverableDetailModal';
import { PROJECT } from '../../config/projectConfig';
import { isMonitorOnlyAdmin } from '../../utils/authorization';

export default function DeliverablesHub({ user, userData, readOnly = false }) {
  const navigate = useNavigate();
  const currentUser = user || auth?.currentUser;
  const isReadOnly = readOnly || isMonitorOnlyAdmin(userData);
  const [deliverables, setDeliverables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState('pendahuluan');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDeliverable, setSelectedDeliverable] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  const fetchDeliverables = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAllDeliverables();
      setDeliverables(data);
    } catch (err) {
      console.error('Error loading deliverables:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDeliverables();
  }, [fetchDeliverables]);

  // Filtered deliverables by category & search query
  const filteredDeliverables = useMemo(() => {
    return deliverables.filter((item) => {
      const matchesCategory =
        activeCategory === 'all' || item.category === activeCategory;
      const matchesSearch =
        !searchQuery ||
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.subtitle.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [deliverables, activeCategory, searchQuery]);

  // Deliverables Statistics
  const stats = useMemo(() => {
    const total = deliverables.length;
    const approved = deliverables.filter((d) => d.submission?.status === 'approved').length;
    const submitted = deliverables.filter((d) => d.submission?.status === 'submitted').length;
    const review = deliverables.filter((d) => d.submission?.status === 'review').length;
    const draft = deliverables.filter((d) => !d.submission?.status || d.submission?.status === 'draft').length;

    let totalFiles = 0;
    let totalBytes = 0;
    let totalPhotos = 0;
    let totalVideos = 0;

    deliverables.forEach((d) => {
      if (Array.isArray(d.submission?.files)) {
        totalFiles += d.submission.files.length;
        d.submission.files.forEach((f) => {
          totalBytes += Number(f.size || 0);
          if (f.type?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name || '')) {
            totalPhotos += 1;
          } else if (f.type?.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(f.name || '')) {
            totalVideos += 1;
          }
        });
      }
      if (d.submission?.videoUrl) {
        totalVideos += 1;
      }
    });

    return {
      total,
      approved,
      submitted,
      review,
      draft,
      completedRate: total > 0 ? Math.round(((approved + submitted) / total) * 100) : 0,
      totalFiles,
      totalPhotos,
      totalVideos,
      totalBytesFormatted: formatFileSize(totalBytes),
    };
  }, [deliverables]);

  const handleCopyShareLink = (e, item) => {
    e.stopPropagation();
    const url = getDeliverableShareUrl(item.id);
    navigator.clipboard.writeText(url);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 3000);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/40 to-slate-100 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Top Breadcrumb & Title */}
        <div className="bg-white rounded-3xl shadow-sm border border-blue-100 p-6 md:p-8 relative overflow-hidden">
          <div className="absolute -right-12 -top-12 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
            <div>
              <div className="flex items-center gap-2 flex-wrap text-xs text-blue-900 font-semibold mb-2">
                <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full">
                  PT Surya Abadi Konsultan
                </span>
                <span>•</span>
                <span className="bg-amber-100 text-amber-900 px-3 py-1 rounded-full">
                  {PROJECT.ministry}
                </span>
                <span>•</span>
                <span className="bg-slate-100 text-slate-700 px-3 py-1 rounded-full">
                  Kontrak 300 Hari Kalender
                </span>
              </div>
              <h1 className="text-2xl md:text-3xl font-extrabold text-gray-900 tracking-tight">
                Portal Pelaporan & Deliverables KAK / BOQ
              </h1>
              <p className="text-sm md:text-base text-gray-600 mt-1 max-w-3xl leading-relaxed">
                Pusat pengiriman, arsip digital terpusat, dokumentasi foto & video kegiatan BOQ, dan verifikasi dokumen resmi kontrak Konsultan Manajemen ISWMP Kota Padang oleh <strong>Team Leader (Bpk. Misdar Putra)</strong> dan <strong>Tenaga Ahli Manajemen Data (Bpk. Abdul Aziz Sikumbang)</strong>.
              </p>
              {isReadOnly && (
                <p className="mt-3 inline-flex rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                  Mode pemantauan: akun ini hanya dapat melihat dan mengunduh berkas.
                </p>
              )}
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={() => navigate(userData?.role === 'admin' || userData?.isAdmin ? '/admin' : '/employee')}
                className="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 text-xs font-bold rounded-xl transition"
              >
                ← {userData?.role === 'admin' || userData?.isAdmin ? 'Dashboard Admin' : 'Dashboard Absensi'}
              </button>
            </div>
          </div>

          {/* Quick KPI Stat Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8 pt-6 border-t border-gray-100">
            <div className="bg-blue-50/80 rounded-2xl p-4 border border-blue-100">
              <p className="text-xs text-blue-700 font-medium">Total Deliverables & BOQ</p>
              <p className="text-2xl font-extrabold text-blue-950 mt-1">
                {stats.total}{' '}
                <span className="text-xs font-semibold text-blue-700">Item</span>
              </p>
              <div className="w-full bg-blue-200 rounded-full h-1.5 mt-2">
                <div
                  className="bg-blue-600 h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${stats.completedRate}%` }}
                />
              </div>
              <p className="text-[11px] text-blue-700 mt-1">{stats.completedRate}% Terpenuhi</p>
            </div>

            <div className="bg-green-50/80 rounded-2xl p-4 border border-green-100">
              <p className="text-xs text-green-700 font-medium">Disetujui & Submitted</p>
              <p className="text-2xl font-extrabold text-green-950 mt-1">
                {stats.approved + stats.submitted}{' '}
                <span className="text-xs font-semibold text-green-700">/ {stats.total}</span>
              </p>
              <p className="text-[11px] text-green-700 mt-2">
                {stats.approved} Disetujui · {stats.submitted} Submitted
              </p>
            </div>

            <div className="bg-purple-50/80 rounded-2xl p-4 border border-purple-100">
              <p className="text-xs text-purple-700 font-medium">Media & Dokumentasi</p>
              <p className="text-2xl font-extrabold text-purple-950 mt-1">
                {stats.totalPhotos + stats.totalVideos}{' '}
                <span className="text-xs font-semibold text-purple-700">Media</span>
              </p>
              <p className="text-[11px] text-purple-700 mt-2">
                📸 {stats.totalPhotos} Foto · 🎥 {stats.totalVideos} Video
              </p>
            </div>

            <div className="bg-amber-50/80 rounded-2xl p-4 border border-amber-100">
              <p className="text-xs text-amber-700 font-medium">Berkas & Kapasitas</p>
              <p className="text-2xl font-extrabold text-amber-950 mt-1">
                {stats.totalFiles}{' '}
                <span className="text-xs font-semibold text-amber-700">Berkas</span>
              </p>
              <p className="text-[11px] text-amber-800 mt-2">
                Ukuran Total: {stats.totalBytesFormatted}
              </p>
            </div>
          </div>
        </div>

        {/* Category Tabs & Search Filter */}
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
          <div className="flex items-center gap-2 overflow-x-auto bg-white p-1.5 rounded-2xl shadow-sm border border-gray-200">
            {DELIVERABLE_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-4 py-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap flex items-center gap-2 ${
                  activeCategory === cat.id
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <span>{cat.label}</span>
              </button>
            ))}
            <button
              onClick={() => setActiveCategory('all')}
              className={`px-4 py-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap ${
                activeCategory === 'all'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              Semua ({deliverables.length})
            </button>
          </div>

          {/* Search Input */}
          <div className="relative w-full md:w-72">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari laporan, RTPS, BNBA, BimTek..."
              className="w-full pl-9 pr-4 py-2.5 text-xs bg-white border border-gray-300 rounded-xl shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
            />
            <span className="absolute left-3 top-2.5 text-gray-400 text-sm">🔍</span>
          </div>
        </div>

        {/* Deliverables Grid Cards */}
        {loading ? (
          <div className="p-12 text-center bg-white rounded-3xl shadow-sm border border-gray-200">
            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-sm font-semibold text-gray-700">Memuat berkas deliverables KAK...</p>
          </div>
        ) : filteredDeliverables.length === 0 ? (
          <div className="p-12 text-center bg-white rounded-3xl shadow-sm border border-gray-200">
            <span className="text-4xl">📂</span>
            <p className="text-sm font-bold text-gray-800 mt-2">Tidak ada laporan yang sesuai</p>
            <p className="text-xs text-gray-500 mt-1">Coba ubah kata kunci pencarian atau kategori tab.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredDeliverables.map((item) => {
              const status = item.submission?.status || 'draft';
              const files = item.submission?.files || [];
              const fileCount = files.length;
              const photoCount = files.filter((f) =>
                f.type?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name || '')
              ).length;
              const videoCount =
                files.filter((f) =>
                  f.type?.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(f.name || '')
                ).length + (item.submission?.videoUrl ? 1 : 0);

              const completedScopeCount = Object.values(
                item.submission?.scopeChecklist || {}
              ).filter(Boolean).length;
              const totalScopes = item.scopeItems?.length || 0;
              const isCopied = copiedId === item.id;

              return (
                <div
                  key={item.id}
                  onClick={() => setSelectedDeliverable(item)}
                  className="bg-white rounded-3xl shadow-sm hover:shadow-xl border border-gray-200/90 hover:border-blue-300 transition-all duration-300 p-6 flex flex-col justify-between cursor-pointer group relative overflow-hidden"
                >
                  <div className="space-y-4">
                    {/* Badge Header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="bg-blue-100 text-blue-900 font-mono font-bold text-xs px-3 py-1 rounded-xl group-hover:bg-blue-600 group-hover:text-white transition">
                          {item.code}
                        </span>
                        {item.isBoqActivity && (
                          <span className="bg-indigo-100 text-indigo-900 font-semibold text-[10px] px-2 py-0.5 rounded-lg">
                            BOQ Kegiatan
                          </span>
                        )}
                      </div>
                      <span
                        className={`text-xs px-3 py-1 rounded-full font-bold uppercase tracking-wider ${
                          status === 'approved'
                            ? 'bg-green-100 text-green-900 border border-green-300'
                            : status === 'submitted'
                            ? 'bg-yellow-100 text-amber-950 border border-yellow-300'
                            : status === 'review'
                            ? 'bg-purple-100 text-purple-950 border border-purple-300'
                            : 'bg-gray-100 text-gray-700 border border-gray-300'
                        }`}
                      >
                        {status === 'approved'
                          ? '✓ Disetujui'
                          : status === 'submitted'
                          ? '⚡ Submitted'
                          : status === 'review'
                          ? '🔍 Review'
                          : '📝 Draf'}
                      </span>
                    </div>

                    {/* Title & Subtitle */}
                    <div>
                      <h3 className="font-bold text-base text-gray-900 group-hover:text-blue-600 transition tracking-tight line-clamp-2">
                        {item.title}
                      </h3>
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                        {item.subtitle}
                      </p>
                    </div>

                    {/* Deadline / Execution Information */}
                    <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100 space-y-1.5 text-xs">
                      {item.isBoqActivity ? (
                        <>
                          <div className="flex items-center justify-between text-gray-600">
                            <span className="font-medium">Lokasi:</span>
                            <span className="font-bold text-gray-900 truncate max-w-[170px]">
                              {item.submission?.activityLocation || '11 Kelurahan / Venue'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-gray-600">
                            <span className="font-medium">Tgl Kegiatan:</span>
                            <span className="font-semibold text-blue-800">
                              {item.submission?.activityDate
                                ? new Date(item.submission.activityDate).toLocaleDateString('id-ID', {
                                    day: 'numeric',
                                    month: 'short',
                                    year: 'numeric',
                                  })
                                : 'Sesuai Jadwal'}
                            </span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center justify-between text-gray-600">
                            <span className="font-medium">Target Waktu:</span>
                            <span className="font-bold text-gray-900">{item.deadlineLabel}</span>
                          </div>
                          <div className="flex items-center justify-between text-gray-600">
                            <span className="font-medium">Pembahasan:</span>
                            <span className="font-semibold text-blue-800 truncate max-w-[170px]">
                              {item.discussionRequired}
                            </span>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Scope Checklist Progress */}
                    <div>
                      <div className="flex justify-between text-xs text-gray-600 font-medium mb-1">
                        <span>Checklist Substansi {item.isBoqActivity ? 'BOQ' : 'KAK'}</span>
                        <span className="font-bold text-blue-700">
                          {completedScopeCount}/{totalScopes}
                        </span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-blue-600 h-2 transition-all duration-300"
                          style={{
                            width: `${
                              totalScopes > 0
                                ? (completedScopeCount / totalScopes) * 100
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                    </div>

                    {/* Uploaded Files & Media Summary */}
                    <div className="flex items-center justify-between text-xs text-gray-600 pt-1 flex-wrap gap-1">
                      <div className="flex items-center gap-1.5 font-medium">
                        <span>📁 {fileCount} Berkas</span>
                        {(photoCount > 0 || videoCount > 0) && (
                          <span className="text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md font-bold">
                            📸 {photoCount} · 🎥 {videoCount}
                          </span>
                        )}
                      </div>
                      {item.submission?.submittedAt && (
                        <span className="text-green-700 font-medium text-[11px]">
                          Submit {new Date(item.submission.submittedAt).toLocaleDateString('id-ID')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={(e) => handleCopyShareLink(e, item)}
                      className="px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl text-xs font-semibold transition flex items-center gap-1 shrink-0"
                      title="Salin Tautan Berkas Resmi"
                    >
                      <span>🔗</span>
                      <span>{isCopied ? 'Tersalin' : 'Link'}</span>
                    </button>

                    <button
                      type="button"
                      className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-md hover:shadow-blue-600/25 transition text-center"
                    >
                      {isReadOnly ? 'Lihat Detail ↗' : 'Kelola & Unggah ↗'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Deliverable Detail Modal */}
      {selectedDeliverable && (
        <DeliverableDetailModal
          deliverable={selectedDeliverable}
          user={user}
          userData={userData}
          readOnly={isReadOnly}
          onClose={() => setSelectedDeliverable(null)}
          onSaved={() => {
            fetchDeliverables();
          }}
        />
      )}
    </div>
  );
}
