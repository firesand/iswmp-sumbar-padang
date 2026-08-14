// src/components/Admin/AttendanceArchive.jsx
//
// Arsip bukti kehadiran per periode kontrak. Ditelusuri berjenjang: daftar
// periode → daftar pegawai → berkas harian satu pegawai berisi jam, lokasi
// check-in/check-out, dan foto buktinya. Sasarannya penelusuran oleh pemberi
// kerja dan auditor, jadi seluruh data dibaca langsung dari record kanonik —
// tidak ada salinan ringkasan yang bisa menyimpang dari sumbernya.
import { useMemo, useState } from 'react';

import { CONTRACT } from '../../config/projectConfig';
import { getWibDateString } from '../../utils/attendanceTime';
import {
  formatDateKeyId,
  getContractPeriods,
} from '../../utils/contractPeriods';
import { buildEmployeeDossier } from '../../utils/attendanceDossier';
import { buildPeriodRecap } from '../../utils/attendanceRecap';
import {
  fetchActiveEmployees,
  fetchAttendancesInRange,
} from '../../services/attendanceReportData';
import { evaluatePeriodRemunerationEligibility } from '../../utils/remunerationEligibility';
import { getAllDeliverables } from '../../services/deliverablesService';
import {
  getAttendanceErrorMessage,
  getAttendancePhotoUrl,
} from '../../services/attendanceService';
import {
  buildEvidenceBundleEntries,
  buildEvidenceDocumentHtml,
  getEvidenceBundleName,
} from '../../utils/attendanceEvidenceBundle';
import { createZipArchive } from '../../utils/zipArchive';
import { downloadBlob, printHtmlDocument } from '../../utils/printDocument';

const periodStatus = (period, todayDateKey) => {
  if (todayDateKey < period.startDate) return { label: 'Belum mulai', tone: 'bg-gray-100 text-gray-600' };
  if (todayDateKey > period.endDate) return { label: 'Selesai', tone: 'bg-emerald-100 text-emerald-700' };
  return { label: 'Berjalan', tone: 'bg-amber-100 text-amber-700' };
};

const dayRowTone = (day) => {
  if (day.hasRecord) {
    return day.status === 'late'
      ? 'border-l-4 border-amber-400'
      : 'border-l-4 border-emerald-500';
  }
  if (day.isPending) return 'border-l-4 border-gray-200';
  if (day.isWeekend) return 'border-l-4 border-gray-200';
  return 'border-l-4 border-rose-400';
};

function SummaryChip({ label, value, tone = 'bg-gray-50 text-gray-800' }) {
  return (
    <div className={`rounded-lg px-3 py-2 ${tone}`}>
      <p className="text-[11px] opacity-75">{label}</p>
      <p className="text-base font-semibold">{value}</p>
    </div>
  );
}

/** Kartu satu sisi absensi: jam, lokasi, koordinat, jarak, dan foto bukti. */
function SideCard({ side, title, photo, onLoadPhoto }) {
  if (!side) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-3">
        <p className="text-xs font-semibold text-gray-500">{title}</p>
        <p className="mt-1 text-sm text-gray-500">Belum tercatat</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold text-gray-600">{title}</p>
        <p className="text-sm font-bold text-gray-800">{side.timeLabel}</p>
      </div>
      {side.isEffective && (
        <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          Jam dari koreksi administratif, bukan rekaman perangkat.
        </p>
      )}

      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Lokasi</dt>
          <dd className="text-right font-medium text-gray-800">{side.locationName}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Kategori</dt>
          <dd className="text-right text-gray-700">{side.locationCategoryLabel}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Koordinat</dt>
          <dd className="text-right font-mono text-[11px] text-gray-700">
            {side.coordinatesLabel}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Akurasi GPS</dt>
          <dd className="text-right text-gray-700">
            {side.accuracyMeters === null ? '-' : `${side.accuracyMeters} m`}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-500">Jarak dari titik</dt>
          <dd className="text-right text-gray-700">
            {side.distanceMeters === null ? '-' : `${side.distanceMeters} m`}
          </dd>
        </div>
      </dl>

      {side.mapsUrl && (
        <a
          href={side.mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline"
        >
          📍 Buka di Google Maps
        </a>
      )}

      <div className="mt-3">
        {!side.hasPhoto && (
          <p className="rounded bg-gray-50 px-2 py-1.5 text-[11px] text-gray-500">
            Bukti foto tidak tersedia atau tidak lolos verifikasi.
          </p>
        )}
        {side.hasPhoto && photo?.status === 'loaded' && (
          <>
            <img
              src={photo.url}
              alt={`Bukti ${title.toLowerCase()}`}
              className="w-full rounded-lg border border-gray-200 object-cover"
            />
            <a
              href={photo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-xs text-blue-600 hover:underline"
            >
              Buka ukuran penuh
            </a>
          </>
        )}
        {side.hasPhoto && photo?.status === 'loading' && (
          <p className="text-xs text-gray-500">Memuat bukti foto…</p>
        )}
        {side.hasPhoto && photo?.status === 'error' && (
          <div className="rounded bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
            {photo.message}
            <button
              onClick={onLoadPhoto}
              className="ml-2 font-medium underline"
            >
              Coba lagi
            </button>
          </div>
        )}
        {side.hasPhoto && !photo && (
          <button
            onClick={onLoadPhoto}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            🖼️ Tampilkan bukti foto
          </button>
        )}
      </div>
    </div>
  );
}

function AttendanceArchive() {
  const contractPeriods = useMemo(() => getContractPeriods(), []);
  const todayDateKey = getWibDateString();

  const [openPeriodIndex, setOpenPeriodIndex] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [attendances, setAttendances] = useState([]);
  const [recap, setRecap] = useState(null);
  const [remunerationEligibility, setRemunerationEligibility] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(null);
  const [expandedDate, setExpandedDate] = useState(null);
  const [photos, setPhotos] = useState({});
  const [onlyRecordedDays, setOnlyRecordedDays] = useState(true);
  const [exportTask, setExportTask] = useState(null);

  const openPeriod = contractPeriods.find(
    (period) => period.index === openPeriodIndex
  ) || null;

  const selectedEmployee = employees.find(
    (employee) => employee.id === selectedEmployeeId
  ) || null;

  const dossier = useMemo(() => {
    if (!selectedEmployee || !openPeriod) return null;
    return buildEmployeeDossier({
      employee: selectedEmployee,
      attendances,
      period: openPeriod,
      cutoffDateKey: todayDateKey,
    });
  }, [selectedEmployee, openPeriod, attendances, todayDateKey]);

  const visibleDays = dossier
    ? dossier.days.filter((day) => (onlyRecordedDays ? day.hasRecord : true))
    : [];

  const openPeriodData = async (period) => {
    setLoading(true);
    setError('');
    setSelectedEmployeeId(null);
    setExpandedDate(null);
    setPhotos({});
    try {
      const loadedEmployees = await fetchActiveEmployees();
      const loadedAttendances = await fetchAttendancesInRange(
        period.startDate,
        period.endDate,
        loadedEmployees
      );
      const deliverables = await getAllDeliverables();
      const eligibility = evaluatePeriodRemunerationEligibility({
        periodIndex: period.index,
        period,
        attendances: loadedAttendances,
        deliverables,
      });

      setEmployees(loadedEmployees);
      setAttendances(loadedAttendances);
      setRecap(buildPeriodRecap({
        employees: loadedEmployees,
        attendances: loadedAttendances,
        period,
        todayDateKey,
      }));
      setRemunerationEligibility(eligibility);
      setOpenPeriodIndex(period.index);
    } catch (caught) {
      console.error('Gagal membuka arsip periode:', caught);
      setError('Gagal memuat arsip periode. Coba ulangi beberapa saat lagi.');
    } finally {
      setLoading(false);
    }
  };

  const closePeriod = () => {
    setOpenPeriodIndex(null);
    setSelectedEmployeeId(null);
    setEmployees([]);
    setAttendances([]);
    setRecap(null);
    setRemunerationEligibility(null);
    setPhotos({});
  };

  const loadPhoto = async (recordId, action) => {
    const key = `${recordId}__${action}`;
    setPhotos((current) => ({ ...current, [key]: { status: 'loading' } }));
    try {
      const { url } = await getAttendancePhotoUrl(recordId, action);
      setPhotos((current) => ({ ...current, [key]: { status: 'loaded', url } }));
    } catch (caught) {
      setPhotos((current) => ({
        ...current,
        [key]: { status: 'error', message: getAttendanceErrorMessage(caught) },
      }));
    }
  };

  /** Membuka satu hari langsung memuat bukti fotonya sekaligus. */
  const toggleDay = (day) => {
    if (expandedDate === day.date) {
      setExpandedDate(null);
      return;
    }
    setExpandedDate(day.date);
    if (!day.recordId) return;
    if (day.checkIn?.hasPhoto && !photos[`${day.recordId}__checkIn`]) {
      loadPhoto(day.recordId, 'checkIn');
    }
    if (day.checkOut?.hasPhoto && !photos[`${day.recordId}__checkOut`]) {
      loadPhoto(day.recordId, 'checkOut');
    }
  };

  const employeeRows = recap ? recap.employees : [];

  /**
   * Ambil URL bertanda tangan seluruh foto berkas ini. URL hanya berlaku 5
   * menit, jadi pengambilannya dilakukan tepat sebelum dokumen disusun.
   */
  const collectPhotoUrls = async (activeDossier, onProgress) => {
    const wanted = [];
    activeDossier.days.filter((day) => day.hasRecord).forEach((day) => {
      [day.checkIn, day.checkOut].filter(Boolean).forEach((side) => {
        if (side.hasPhoto) wanted.push({ date: day.date, action: side.action, recordId: day.recordId });
      });
    });

    const resolved = new Map();
    for (let index = 0; index < wanted.length; index += 1) {
      const item = wanted[index];
      onProgress?.(index + 1, wanted.length);
      try {
        // Berurutan, bukan paralel: puluhan callable sekaligus memicu
        // pembatasan laju dan justru memperlambat keseluruhan.
        const { url } = await getAttendancePhotoUrl(item.recordId, item.action);
        resolved.set(`${item.date}__${item.action}`, url);
      } catch (caught) {
        console.warn('Bukti foto dilewati:', item, caught);
      }
    }
    return resolved;
  };

  const downloadEvidencePdf = async () => {
    if (!dossier) return;
    setError('');
    try {
      const urls = await collectPhotoUrls(dossier, (done, total) => {
        setExportTask({ label: 'Menyiapkan PDF', done, total });
      });
      setExportTask({ label: 'Menyusun dokumen', done: 1, total: 1 });
      const html = buildEvidenceDocumentHtml({
        dossier,
        contract: CONTRACT,
        photoSrc: (dateKey, action) => urls.get(`${dateKey}__${action}`) ?? null,
      });
      await printHtmlDocument(html, {
        title: getEvidenceBundleName(dossier),
        widthPx: 794,
        heightPx: 1123,
      });
    } catch (caught) {
      console.error('Gagal menyiapkan PDF berkas:', caught);
      setError('Gagal menyiapkan dokumen PDF berkas bukti.');
    } finally {
      setExportTask(null);
    }
  };

  const downloadEvidenceBundle = async () => {
    if (!dossier) return;
    setError('');
    try {
      setExportTask({ label: 'Menyusun paket arsip', done: 1, total: 1 });
      // Berkas foto tidak dibungkus ke dalam ZIP: URL bukti berada di
      // storage.googleapis.com yang tidak diizinkan `connect-src` pada CSP
      // hosting, sehingga byte-nya tidak dapat dibaca peramban. Manifes tetap
      // memuat sidik SHA-256 tiap foto agar keasliannya bisa diverifikasi.
      const entries = buildEvidenceBundleEntries({
        dossier,
        contract: CONTRACT,
        photos: [],
      });
      const zip = createZipArchive(entries);
      downloadBlob(zip, `${getEvidenceBundleName(dossier)}.zip`, 'application/zip');
    } catch (caught) {
      console.error('Gagal menyusun paket arsip:', caught);
      setError('Gagal menyusun paket arsip.');
    } finally {
      setExportTask(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Jejak navigasi */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          onClick={closePeriod}
          className={`font-medium ${openPeriod ? 'text-green-700 hover:underline' : 'text-gray-800'}`}
        >
          🗂️ Arsip Periode
        </button>
        {openPeriod && (
          <>
            <span className="text-gray-400">›</span>
            <button
              onClick={() => setSelectedEmployeeId(null)}
              className={`font-medium ${selectedEmployee ? 'text-green-700 hover:underline' : 'text-gray-800'}`}
            >
              {openPeriod.shortLabel}
            </button>
          </>
        )}
        {selectedEmployee && (
          <>
            <span className="text-gray-400">›</span>
            <span className="font-medium text-gray-800">{selectedEmployee.name}</span>
          </>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading && (
        <div className="rounded-xl bg-white p-8 text-center shadow-md">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-t-4 border-green-600" />
          <p className="mt-3 text-sm text-gray-600">Memuat arsip periode…</p>
        </div>
      )}

      {/* Tingkat 1 — daftar periode */}
      {!openPeriod && !loading && (
        <div className="rounded-xl bg-white p-5 shadow-md">
          <h2 className="text-xl font-bold text-gray-800">🗂️ Arsip Bukti Kehadiran</h2>
          <p className="mt-1 text-sm text-gray-600">
            {CONTRACT.label} · {formatDateKeyId(CONTRACT.startDate)} –
            {' '}{formatDateKeyId(contractPeriods[contractPeriods.length - 1]?.endDate)} ·
            {' '}{contractPeriods.length} periode. Pilih periode, lalu klik nama
            pegawai untuk membuka rekap harian, lokasi check-in/check-out, dan
            foto buktinya.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {contractPeriods.map((period) => {
              const status = periodStatus(period, todayDateKey);
              return (
                <button
                  key={period.index}
                  onClick={() => openPeriodData(period)}
                  className="rounded-xl border border-gray-200 p-4 text-left transition-colors hover:border-green-400 hover:bg-green-50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-gray-800">{period.shortLabel}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${status.tone}`}>
                      {status.label}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">{period.rangeLabel}</p>
                  <p className="mt-2 text-[11px] text-gray-500">
                    Hari kontrak ke-{period.contractDayStart} s/d ke-
                    {period.contractDayEnd} · {period.totalDays} hari
                    {period.isPartial ? ' · periode akhir' : ''}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tingkat 2 — daftar pegawai pada periode */}
      {openPeriod && !selectedEmployee && !loading && (
        <div className="rounded-xl bg-white p-5 shadow-md">
          <div className="mb-4">
            <h2 className="text-lg font-bold text-gray-800">{openPeriod.label}</h2>
            <p className="text-sm text-gray-600">
              {recap?.workingDays} hari kerja · {employeeRows.length} pegawai ·
              {' '}data s/d {formatDateKeyId(recap?.cutoffDateKey || openPeriod.endDate)}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Klik nama untuk membuka berkas bukti harian pegawai tersebut.
            </p>
          </div>

          {/* Panel Status Kelayakan Pembayaran Remunerasi / Gaji */}
          {remunerationEligibility && (
            <div
              className={`rounded-2xl p-4 md:p-5 mb-5 border shadow-xs transition-all duration-300 ${
                remunerationEligibility.isEligible
                  ? 'bg-gradient-to-br from-emerald-50 via-green-50/70 to-emerald-100/50 border-emerald-300'
                  : 'bg-gradient-to-br from-amber-50 via-orange-50/50 to-amber-100/50 border-amber-300'
              }`}
            >
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 shadow-xs ${
                      remunerationEligibility.isEligible
                        ? 'bg-emerald-600 text-white'
                        : 'bg-amber-500 text-white'
                    }`}
                  >
                    {remunerationEligibility.isEligible ? '✓' : '⚠️'}
                  </div>

                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-[11px] px-2.5 py-0.5 rounded-full font-black uppercase tracking-wider border ${
                          remunerationEligibility.isEligible
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-amber-600 text-white border-amber-600'
                        }`}
                      >
                        {remunerationEligibility.statusLabel}
                      </span>
                      <span className="text-xs font-semibold text-gray-700">
                        Dasar Pembayaran Remunerasi {openPeriod.label}
                      </span>
                    </div>

                    <h4 className="text-base font-bold text-gray-900 mt-1">
                      {remunerationEligibility.isEligible
                        ? 'Hak Pembayaran Remunerasi: BERHAK DIBAYARKAN'
                        : 'Hak Pembayaran Remunerasi: MENUNGGU KELENGKAPAN BERKAS'}
                    </h4>
                    <p className="text-xs text-gray-700 mt-0.5 leading-relaxed max-w-3xl">
                      {remunerationEligibility.summaryMessage}
                    </p>
                  </div>
                </div>

                <div className="text-right shrink-0 bg-white/90 p-2.5 rounded-xl border border-gray-200 shadow-2xs w-full md:w-auto">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase">
                    Kelengkapan
                  </p>
                  <p className="text-xl font-black text-gray-900">
                    {remunerationEligibility.completedCount}{' '}
                    <span className="text-xs font-medium text-gray-500">
                      / {remunerationEligibility.totalRequirementsCount}
                    </span>
                  </p>
                </div>
              </div>

              {/* Checklist Mini */}
              <div className="mt-3.5 pt-3 border-t border-gray-200/80 grid grid-cols-1 md:grid-cols-3 gap-2">
                {remunerationEligibility.checklist.map((item) => (
                  <div
                    key={item.id}
                    className={`p-2.5 rounded-lg border flex items-center justify-between text-xs ${
                      item.fulfilled
                        ? 'bg-white/90 border-emerald-200 text-emerald-950'
                        : 'bg-white/90 border-amber-200 text-amber-950'
                    }`}
                  >
                    <div className="truncate">
                      <span className="font-bold mr-1.5">
                        {item.fulfilled ? '✅' : '⏳'}
                      </span>
                      <span className="font-semibold">{item.title}</span>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded shrink-0 ml-2 ${
                        item.fulfilled
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {item.fulfilled ? 'Lengkap' : 'Pending'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="px-3 py-3 text-left text-xs font-semibold text-gray-700">Pegawai</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-700">Hadir</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-700">Telat</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-700">Absen</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-700">Kehadiran</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold text-gray-700">Lokasi Dominan</th>
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-700">Berkas</th>
                </tr>
              </thead>
              <tbody>
                {employeeRows.map((row) => (
                  <tr key={row.id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-3">
                      <button
                        onClick={() => {
                          setSelectedEmployeeId(row.id);
                          setExpandedDate(null);
                        }}
                        className="text-left"
                      >
                        <p className="font-medium text-green-700 hover:underline">{row.name}</p>
                        <p className="text-[11px] text-gray-500">
                          {row.position} · {row.department}
                        </p>
                      </button>
                    </td>
                    <td className="px-3 py-3 text-center text-sm font-medium text-emerald-600">
                      {row.presentDays}
                      <span className="text-[11px] text-gray-400">/{row.elapsedWorkingDays}</span>
                    </td>
                    <td className="px-3 py-3 text-center text-sm text-amber-600">{row.lateDays}</td>
                    <td className="px-3 py-3 text-center text-sm text-rose-600">{row.absentDays}</td>
                    <td className="px-3 py-3 text-center text-sm font-semibold text-gray-700">
                      {row.attendanceRate.toFixed(0)}%
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-700">
                      {row.dominantLocation
                        ? `${row.dominantLocation.label} (${row.dominantLocation.days})`
                        : '-'}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <button
                        onClick={() => {
                          setSelectedEmployeeId(row.id);
                          setExpandedDate(null);
                        }}
                        className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                      >
                        Buka berkas
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {employeeRows.length === 0 && (
            <p className="py-6 text-center text-sm text-gray-500">
              Tidak ada pegawai aktif pada periode ini.
            </p>
          )}
        </div>
      )}

      {/* Tingkat 3 — berkas harian satu pegawai */}
      {dossier && !loading && (
        <>
          <div className="rounded-xl bg-gradient-to-r from-green-600 to-emerald-500 p-5 text-white shadow-md">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide opacity-90">
                  {CONTRACT.label} · {openPeriod.label}
                </p>
                <h2 className="text-xl font-bold">{dossier.employee.name}</h2>
                <p className="text-sm opacity-90">
                  {dossier.employee.position} · {dossier.employee.department}
                  {dossier.employee.email ? ` · ${dossier.employee.email}` : ''}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={downloadEvidencePdf}
                  disabled={Boolean(exportTask)}
                  className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-green-700 transition-colors hover:bg-green-50 disabled:opacity-60"
                >
                  🖨️ PDF Berkas + Foto
                </button>
                <button
                  onClick={downloadEvidenceBundle}
                  disabled={Boolean(exportTask)}
                  className="rounded-lg bg-green-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-900 disabled:opacity-60"
                >
                  📦 Paket Arsip (.zip)
                </button>
              </div>
            </div>

            {exportTask && (
              <div className="mt-3">
                <p className="text-xs opacity-90">
                  {exportTask.label}
                  {exportTask.total > 1 ? ` — ${exportTask.done}/${exportTask.total} bukti` : '…'}
                </p>
                <div className="mt-1 h-1.5 w-full rounded-full bg-white/25">
                  <div
                    className="h-1.5 rounded-full bg-white transition-all"
                    style={{ width: `${(exportTask.done / Math.max(exportTask.total, 1)) * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <strong>PDF Berkas + Foto</strong> memuat seluruh foto bukti langsung
            di dalam dokumen — pilih tujuan &quot;Save as PDF&quot; pada dialog
            cetak. <strong>Paket Arsip (.zip)</strong> berisi tampilan berkas
            (index.html), rekap harian (CSV), dan manifes berisi sidik SHA-256
            tiap foto untuk verifikasi keaslian; berkas foto sendiri belum dapat
            disertakan otomatis ke dalam ZIP.
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <SummaryChip label="Hari tercatat" value={dossier.summary.recordedDays} />
            <SummaryChip
              label="Terlambat"
              value={dossier.summary.lateDays}
              tone="bg-amber-50 text-amber-800"
            />
            <SummaryChip label="Shift lengkap" value={dossier.summary.completeDays} />
            <SummaryChip
              label="Belum check-out"
              value={dossier.summary.openShiftDays}
              tone="bg-rose-50 text-rose-800"
            />
            <SummaryChip label="Pulang awal" value={dossier.summary.earlyLeaveDays} />
            <SummaryChip
              label="Jam kerja"
              value={dossier.summary.totalWorkHours.toFixed(1)}
            />
            <SummaryChip
              label="Bukti foto"
              value={dossier.summary.photoCount}
              tone="bg-sky-50 text-sky-800"
            />
          </div>

          {dossier.summary.manualCorrections > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {dossier.summary.manualCorrections} hari diselesaikan lewat koreksi
              administratif — jam check-out-nya bukan rekaman perangkat.
            </p>
          )}
          {dossier.summary.duplicateRecords > 0 && (
            <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
              Ada {dossier.summary.duplicateRecords} record tambahan pada tanggal
              yang sudah terisi. Rekap memakai record pertama tiap tanggal.
            </p>
          )}

          <div className="rounded-xl bg-white p-5 shadow-md">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-base font-semibold text-gray-800">
                  Catatan Harian · {openPeriod.rangeLabel}
                </h3>
                <p className="text-xs text-gray-500">
                  Klik satu tanggal untuk melihat lokasi dan foto bukti
                  check-in/check-out.
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={onlyRecordedDays}
                  onChange={(event) => setOnlyRecordedDays(event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                Hanya hari yang ada catatannya
              </label>
            </div>

            <div className="space-y-2">
              {visibleDays.map((day) => {
                const isExpanded = expandedDate === day.date;
                return (
                  <div
                    key={day.date}
                    className={`rounded-lg bg-gray-50 ${dayRowTone(day)}`}
                  >
                    <button
                      onClick={() => toggleDay(day)}
                      disabled={!day.hasRecord}
                      className="flex w-full flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-left disabled:cursor-default"
                    >
                      <div className="min-w-[150px]">
                        <p className="text-sm font-medium text-gray-800">
                          {formatDateKeyId(day.date)}
                        </p>
                        <p className="text-[11px] text-gray-500">{day.weekdayName}</p>
                      </div>

                      {day.hasRecord ? (
                        <>
                          <div className="text-xs text-gray-700">
                            <span className="text-gray-500">Masuk </span>
                            <span className="font-semibold">{day.checkIn.timeLabel}</span>
                            <span className="text-gray-500"> · Pulang </span>
                            <span className="font-semibold">
                              {day.checkOut ? day.checkOut.timeLabel : 'belum'}
                            </span>
                          </div>
                          <div className="text-xs text-gray-600">
                            📍 {day.checkIn.locationName}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              day.status === 'late'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                            >
                              {day.statusLabel}
                            </span>
                            {day.isCrossDay && (
                              <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[11px] text-cyan-800">
                                Lintas hari
                              </span>
                            )}
                            {day.earlyLeave.isEarlyLeave && (
                              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] text-orange-800">
                                Pulang awal
                              </span>
                            )}
                            <span className="text-xs text-gray-400">
                              {isExpanded ? '▲' : '▼'}
                            </span>
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-gray-500">{day.statusLabel}</span>
                      )}
                    </button>

                    {isExpanded && day.hasRecord && (
                      <div className="border-t border-gray-200 px-3 py-3">
                        <div className="mb-3 flex flex-wrap gap-3 text-[11px] text-gray-600">
                          <span>
                            Jaminan: <strong>{day.assuranceLabel}</strong>
                          </span>
                          <span>
                            Jam kerja: <strong>{day.workHours.toFixed(2)}</strong>
                          </span>
                          <span className="font-mono text-gray-400">{day.recordId}</span>
                        </div>

                        {day.earlyLeave.isEarlyLeave && day.earlyLeave.reason && (
                          <p className="mb-3 rounded bg-orange-50 px-2 py-1.5 text-xs text-orange-800">
                            Alasan pulang awal: {day.earlyLeave.reason}
                          </p>
                        )}

                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                          <SideCard
                            side={day.checkIn}
                            title="Check-In"
                            photo={photos[`${day.recordId}__checkIn`]}
                            onLoadPhoto={() => loadPhoto(day.recordId, 'checkIn')}
                          />
                          <SideCard
                            side={day.checkOut}
                            title="Check-Out"
                            photo={photos[`${day.recordId}__checkOut`]}
                            onLoadPhoto={() => loadPhoto(day.recordId, 'checkOut')}
                          />
                        </div>

                        {day.extraRecords.length > 0 && (
                          <p className="mt-3 rounded bg-sky-50 px-2 py-1.5 text-[11px] text-sky-800">
                            {day.extraRecords.length} record tambahan pada tanggal
                            ini: {day.extraRecords.map((record) => record.id).join(', ')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {visibleDays.length === 0 && (
              <p className="py-6 text-center text-sm text-gray-500">
                Tidak ada catatan kehadiran pada periode ini.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default AttendanceArchive;
