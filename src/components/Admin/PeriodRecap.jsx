// src/components/Admin/PeriodRecap.jsx
//
// Rekap kehadiran satu periode kontrak: dasar perhitungan remunerasi sekaligus
// papan monitoring-evaluasi kinerja berbasis kehadiran dan lokasi absensi.
import { Fragment, useMemo, useRef, useState } from 'react';

import { CONTRACT } from '../../config/projectConfig';
import { downloadExcelWorkbook } from '../../utils/excelExport';
import { getWibDateString } from '../../utils/attendanceTime';
import {
  formatDateKeyId,
  getActiveContractPeriod,
  getContractEndDate,
  getContractPeriodByIndex,
  getContractPeriods,
} from '../../utils/contractPeriods';
import {
  DAY_STATE,
  LOCATION_CATEGORIES,
  buildPeriodRecap,
  formatMinutesOfDay,
} from '../../utils/attendanceRecap';
import { printPeriodRecap } from '../../utils/periodRecapPrint';
import {
  fetchActiveEmployees,
  fetchAttendancesInRange,
} from '../../services/attendanceReportData';
import { evaluatePeriodRemunerationEligibility } from '../../utils/remunerationEligibility';
import { getAllDeliverables } from '../../services/deliverablesService';

const DAY_STATE_STYLES = {
  [DAY_STATE.ONTIME]: { className: 'bg-emerald-500', label: 'Hadir tepat waktu' },
  [DAY_STATE.LATE]: { className: 'bg-amber-500', label: 'Terlambat' },
  [DAY_STATE.ABSENT]: { className: 'bg-rose-400', label: 'Tidak hadir' },
  [DAY_STATE.WEEKEND_PRESENT]: { className: 'bg-sky-500', label: 'Hadir akhir pekan' },
  [DAY_STATE.WEEKEND]: { className: 'bg-gray-200', label: 'Akhir pekan' },
  [DAY_STATE.FUTURE]: { className: 'bg-gray-100', label: 'Belum berjalan' },
  [DAY_STATE.PRE_ACTIVE]: {
    className: 'bg-gray-100 border border-dashed border-gray-300',
    label: 'Belum bergabung',
  },
};

const SORT_OPTIONS = [
  { key: 'attendanceRate', label: 'Kehadiran tertinggi' },
  { key: 'attendanceRateAsc', label: 'Kehadiran terendah' },
  { key: 'lateDays', label: 'Paling sering terlambat' },
  { key: 'workHours', label: 'Jam kerja terbanyak' },
  { key: 'name', label: 'Nama (A–Z)' },
];

const sortEmployees = (employees, sortKey) => {
  const sorted = [...employees];
  switch (sortKey) {
    case 'attendanceRateAsc':
      return sorted.sort((a, b) => a.attendanceRate - b.attendanceRate);
    case 'lateDays':
      return sorted.sort((a, b) => b.lateDays - a.lateDays);
    case 'workHours':
      return sorted.sort((a, b) => b.totalWorkHours - a.totalWorkHours);
    case 'name':
      return sorted.sort((a, b) => a.name.localeCompare(b.name, 'id'));
    case 'attendanceRate':
    default:
      return sorted.sort((a, b) => b.attendanceRate - a.attendanceRate);
  }
};

const rateTone = (value) => {
  if (value >= 90) return 'text-emerald-600';
  if (value >= 75) return 'text-amber-600';
  return 'text-rose-600';
};

const rateBarTone = (value) => {
  if (value >= 90) return 'bg-emerald-500';
  if (value >= 75) return 'bg-amber-500';
  return 'bg-rose-500';
};

function StatCard({ label, value, hint, tone = 'text-gray-800' }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] text-gray-500">{hint}</p>}
    </div>
  );
}

function DayStrip({ dateKeys, dayStates }) {
  return (
    <div className="flex flex-wrap gap-[3px]">
      {dateKeys.map((dateKey) => {
        const state = dayStates[dateKey] || DAY_STATE.FUTURE;
        const style = DAY_STATE_STYLES[state];
        return (
          <span
            key={dateKey}
            title={`${formatDateKeyId(dateKey)} — ${style.label}`}
            className={`h-4 w-4 rounded-sm ${style.className}`}
          />
        );
      })}
    </div>
  );
}

function PeriodRecap() {
  const contractPeriods = useMemo(() => getContractPeriods(), []);
  const contractEndDate = useMemo(() => getContractEndDate(), []);
  const [selectedPeriodIndex, setSelectedPeriodIndex] = useState(
    () => getActiveContractPeriod()?.index ?? 1
  );
  const [recap, setRecap] = useState(null);
  const [remunerationEligibility, setRemunerationEligibility] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState('attendanceRate');
  const [expandedEmployeeId, setExpandedEmployeeId] = useState(null);
  const recapRequestIdRef = useRef(0);

  const selectedPeriod = getContractPeriodByIndex(selectedPeriodIndex)
    ?? contractPeriods[0]
    ?? null;

  const sortedEmployees = useMemo(
    () => (recap ? sortEmployees(recap.employees, sortKey) : []),
    [recap, sortKey]
  );

  const locationTotalDays = recap
    ? LOCATION_CATEGORIES.reduce(
      (sum, category) => sum + (recap.locationTotals[category.key] || 0),
      0
    )
    : 0;

  const selectPeriod = (periodIndex) => {
    if (periodIndex === selectedPeriodIndex) return;

    // Invalidate both the displayed result and any request still resolving for
    // the previous period. This prevents exporting old data under a new label.
    recapRequestIdRef.current += 1;
    setSelectedPeriodIndex(periodIndex);
    setRecap(null);
    setRemunerationEligibility(null);
    setExpandedEmployeeId(null);
    setError('');
    setLoading(false);
  };

  const generateRecap = async () => {
    if (!selectedPeriod) {
      setError('Periode kontrak belum dikonfigurasi.');
      return;
    }

    const requestId = recapRequestIdRef.current + 1;
    recapRequestIdRef.current = requestId;
    const period = selectedPeriod;

    setLoading(true);
    setError('');
    try {
      const employees = await fetchActiveEmployees();
      const attendances = await fetchAttendancesInRange(
        period.startDate,
        period.endDate,
        employees
      );
      const deliverables = await getAllDeliverables();
      const eligibility = evaluatePeriodRemunerationEligibility({
        periodIndex: period.index,
        period,
        attendances,
        deliverables,
      });

      if (requestId !== recapRequestIdRef.current) return;

      setRecap(buildPeriodRecap({
        employees,
        attendances,
        period,
        todayDateKey: getWibDateString(),
      }));
      setRemunerationEligibility(eligibility);
      setExpandedEmployeeId(null);
    } catch (caught) {
      if (requestId !== recapRequestIdRef.current) return;
      console.error('Gagal menyusun rekap periode:', caught);
      setError('Gagal memuat rekap periode. Coba ulangi beberapa saat lagi.');
      setRecap(null);
      setRemunerationEligibility(null);
    } finally {
      if (requestId === recapRequestIdRef.current) {
        setLoading(false);
      }
    }
  };

  const downloadPdf = async () => {
    if (!recap) return;
    try {
      await printPeriodRecap(recap, CONTRACT, remunerationEligibility);
    } catch (caught) {
      console.error('Gagal menyiapkan dokumen PDF:', caught);
      setError('Gagal menyiapkan dokumen PDF.');
    }
  };

  const exportRecap = async () => {
    if (!recap) return;

    const summarySheet = [
      ['REKAP KEHADIRAN PER PERIODE KONTRAK'],
      [''],
      ['Kontrak', CONTRACT.label],
      ['Periode', recap.period.label],
      ['Rentang', `${recap.period.startDate} s/d ${recap.period.endDate}`],
      [
        'Hari kontrak',
        `${recap.period.contractDayStart} - ${recap.period.contractDayEnd} dari ${CONTRACT.durationDays}`,
      ],
      ['Hari kalender', recap.period.totalDays],
      ['Hari kerja (Sen–Jum)', recap.workingDays],
      ['Hari kerja berjalan', recap.elapsedWorkingDays],
      ['Status periode', recap.isOngoing ? 'Sedang berjalan' : 'Selesai'],
      ['Data s/d tanggal', recap.cutoffDateKey],
      [''],
      ['STATUS KELAYAKAN PEMBAYARAN REMUNERASI / GAJI'],
      ['Status Hak Pembayaran', remunerationEligibility?.statusLabel || '-'],
      ['Keterangan', remunerationEligibility?.summaryMessage || '-'],
      [
        'Syarat Terpenuhi',
        `${remunerationEligibility?.completedCount || 0} dari ${remunerationEligibility?.totalRequirementsCount || 0} syarat`,
      ],
      ...(remunerationEligibility?.checklist?.map((c) => [
        `Syarat: ${c.title}`,
        c.fulfilled ? 'TERPENUHI' : 'BELUM TERPENUHI',
        c.statusText,
      ]) || []),
      [''],
      ['RINGKASAN KEHADIRAN'],
      ['Jumlah pegawai', recap.totals.employees],
      ['Kapasitas orang-hari', recap.totals.manDaysCapacity],
      ['Total hari hadir', recap.totals.presentDays],
      ['Tepat waktu', recap.totals.onTimeDays],
      ['Terlambat', recap.totals.lateDays],
      ['Tidak hadir', recap.totals.absentDays],
      ['Hadir akhir pekan', recap.totals.weekendPresentDays],
      ['Pulang awal', recap.totals.earlyLeaveDays],
      ['Shift belum check-out', recap.totals.openShiftDays],
      ['Total jam kerja', Number(recap.totals.workHours.toFixed(2))],
      ['Rata-rata kehadiran (%)', Number(recap.totals.attendanceRate.toFixed(1))],
      ['Ketepatan waktu (%)', Number(recap.totals.punctualityRate.toFixed(1))],
      [
        'Rata-rata jam check-in (WIB)',
        formatMinutesOfDay(recap.totals.averageCheckInMinutes),
      ],
      [''],
      ['SEBARAN LOKASI KEHADIRAN (orang-hari: 1 pegawai × 1 hari = 1)'],
      ...LOCATION_CATEGORIES.map((category) => [
        category.label,
        recap.locationTotals[category.key] || 0,
      ]),
      [''],
      ['CATATAN INTEGRITAS'],
      ['Record terhitung', recap.integrity.eligibleRecords],
      ['Record tidak lolos verifikasi', recap.integrity.ineligibleRecords],
      ['Projection koreksi ditolak', recap.integrity.invalidCorrectionProjections],
      ['Record pegawai nonaktif/tak dikenal', recap.integrity.unmatchedRecords],
      ['Koreksi administratif', recap.totals.manualCorrectionDays],
    ];

    const recapHeaders = [
      'Nama', 'Departemen', 'Posisi',
      'Hari Kerja Periode', 'Hari Kerja Berjalan',
      'Hari Hadir', 'Tepat Waktu', 'Terlambat', 'Tidak Hadir',
      'Hadir Akhir Pekan', 'Pulang Awal', 'Shift Terbuka',
      'Kehadiran (%)', 'Ketepatan Waktu (%)',
      'Total Jam Kerja', 'Rata-rata Jam/Shift',
      'Rata-rata Check-In (WIB)',
      'Hari di Kantor', 'Hari di Lokasi Penugasan',
      'Hari di Kegiatan Sementara', 'Hari Lokasi Lainnya',
      'Lokasi Dominan', 'Lokasi Tercatat Terbanyak',
      'Koreksi Administratif', 'Record Tidak Terverifikasi',
    ];
    const recapRows = sortedEmployees.map((employee) => [
      employee.name,
      employee.department,
      employee.position,
      employee.workingDays,
      employee.elapsedWorkingDays,
      employee.presentDays,
      employee.onTimeDays,
      employee.lateDays,
      employee.absentDays,
      employee.weekendPresentDays,
      employee.earlyLeaveDays,
      employee.openShiftDays,
      Number(employee.attendanceRate.toFixed(1)),
      Number(employee.punctualityRate.toFixed(1)),
      Number(employee.totalWorkHours.toFixed(2)),
      Number(employee.avgWorkHours.toFixed(2)),
      employee.averageCheckInLabel,
      employee.locationTally.kantor,
      employee.locationTally.kelurahan,
      employee.locationTally.temporary,
      employee.locationTally.lainnya,
      employee.dominantLocation?.label || '-',
      employee.topLocationNames.map((entry) => `${entry.name} (${entry.days})`).join('; ') || '-',
      employee.manualCorrectionDays,
      employee.unverifiedDays,
    ]);

    // Matriks harian: satu baris per pegawai, satu kolom per tanggal periode.
    const matrixLegend = {
      [DAY_STATE.ONTIME]: 'H',
      [DAY_STATE.LATE]: 'T',
      [DAY_STATE.ABSENT]: 'A',
      [DAY_STATE.WEEKEND_PRESENT]: 'L',
      [DAY_STATE.WEEKEND]: '-',
      [DAY_STATE.FUTURE]: '',
    };
    const matrixHeaders = [
      'Nama',
      ...recap.dateKeys.map((dateKey) => dateKey.slice(8)),
    ];
    const matrixRows = sortedEmployees.map((employee) => [
      employee.name,
      ...recap.dateKeys.map(
        (dateKey) => matrixLegend[employee.dayStates[dateKey]] ?? ''
      ),
    ]);
    const matrixSheet = [
      ['Keterangan: H = hadir tepat waktu, T = terlambat, A = tidak hadir, L = hadir akhir pekan, - = akhir pekan'],
      [`Bulan tanggal: ${recap.period.startDate} s/d ${recap.period.endDate}`],
      [''],
      matrixHeaders,
      ...matrixRows,
    ];

    const trendSheet = [
      ['Tanggal', 'Hari', 'Hadir', 'Terlambat', 'Status'],
      ...recap.dailyTrend.map((day) => [
        day.date,
        day.weekend ? 'Akhir pekan' : 'Hari kerja',
        day.present,
        day.late,
        day.elapsed ? 'Berjalan' : 'Belum berjalan',
      ]),
    ];

    const fileName = `Rekap_Kehadiran_Periode-${String(recap.period.index).padStart(2, '0')}_${recap.period.startDate}_${recap.period.endDate}.xlsx`;
    try {
      await downloadExcelWorkbook([
        { data: summarySheet, sheet: 'Ringkasan' },
        { data: [recapHeaders, ...recapRows], sheet: 'Rekap Pegawai', stickyRowsCount: 1 },
        { data: matrixSheet, sheet: 'Matriks Harian', stickyRowsCount: 4 },
        { data: trendSheet, sheet: 'Tren Harian', stickyRowsCount: 1 },
      ], fileName);
    } catch (caught) {
      console.error('Gagal mengekspor rekap:', caught);
      setError('Gagal mengekspor rekap ke Excel.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Kontrol periode */}
      <div className="bg-white rounded-xl shadow-md p-5">
        <div className="flex flex-col gap-1 mb-4">
          <h2 className="text-xl font-bold text-gray-800">
            📋 Rekap Kehadiran per Periode Kontrak
          </h2>
          <p className="text-sm text-gray-600">
            {CONTRACT.label} · {formatDateKeyId(CONTRACT.startDate)} –
            {' '}{formatDateKeyId(contractEndDate)} · {CONTRACT.durationDays} hari ·
            {' '}{contractPeriods.length} periode
          </p>
        </div>

        {/* Peta periode kontrak */}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {contractPeriods.map((period) => {
            const isSelected = period.index === selectedPeriodIndex;
            return (
              <button
                key={period.index}
                onClick={() => selectPeriod(period.index)}
                title={period.rangeLabel}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                  isSelected
                    ? 'bg-green-600 border-green-600 text-white'
                    : 'bg-gray-50 border-gray-200 text-gray-600 hover:border-green-400 hover:text-green-700'
                }`}
              >
                P{period.index}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Periode
            </label>
            <select
              value={selectedPeriodIndex}
              onChange={(event) => selectPeriod(parseInt(event.target.value, 10))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
            >
              {contractPeriods.map((period) => (
                <option key={period.index} value={period.index}>
                  {period.label}{period.isPartial ? ' (periode akhir)' : ''}
                </option>
              ))}
            </select>
            {selectedPeriod && (
              <p className="mt-2 text-xs text-gray-500">
                Hari kontrak ke-{selectedPeriod.contractDayStart} s/d ke-
                {selectedPeriod.contractDayEnd} dari {CONTRACT.durationDays} ·
                {' '}{selectedPeriod.totalDays} hari kalender
              </p>
            )}
          </div>

          <div className="flex items-start">
            <button
              onClick={generateRecap}
              disabled={loading}
              className="w-full mt-7 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Menyusun…' : 'Susun Rekap'}
            </button>
          </div>

          <div className="flex items-start">
            <button
              onClick={exportRecap}
              disabled={!recap}
              className="w-full mt-7 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              📥 Excel
            </button>
          </div>

          <div className="flex items-start">
            <button
              onClick={downloadPdf}
              disabled={!recap}
              className="w-full mt-7 px-4 py-2 bg-rose-600 text-white rounded-lg hover:bg-rose-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              🖨️ PDF
            </button>
          </div>
        </div>

        {recap && (
          <p className="mt-3 text-xs text-gray-500">
            PDF dibuat lewat dialog cetak peramban — pilih tujuan
            {' '}<strong>Save as PDF</strong> (atau &quot;Simpan sebagai PDF&quot;),
            ukuran A4 landscape.
          </p>
        )}

        {error && (
          <p className="mt-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>

      {recap && (
        <>
          {/* Judul periode + status */}
          <div className="bg-gradient-to-r from-green-600 to-emerald-500 rounded-xl shadow-md p-5 text-white">
            <p className="text-xs uppercase tracking-wide opacity-90">
              {CONTRACT.label}
            </p>
            <h3 className="text-lg font-bold">{recap.period.label}</h3>
            <p className="mt-1 text-sm opacity-90">
              {recap.workingDays} hari kerja · {recap.elapsedWorkingDays} hari
              {' '}berjalan · data s/d {formatDateKeyId(recap.cutoffDateKey)}
              {recap.isOngoing ? ' (periode sedang berjalan)' : ' (periode selesai)'}
            </p>
            <div className="mt-3 h-2 w-full rounded-full bg-white/25">
              <div
                className="h-2 rounded-full bg-white"
                style={{
                  width: `${recap.workingDays > 0
                    ? Math.min(100, (recap.elapsedWorkingDays / recap.workingDays) * 100)
                    : 0}%`,
                }}
              />
            </div>
          </div>

          {/* Panel Status Kelayakan Pembayaran Remunerasi / Gaji */}
          {remunerationEligibility && (
            <div
              className={`rounded-2xl p-5 md:p-6 border shadow-sm transition-all duration-300 ${
                remunerationEligibility.isEligible
                  ? 'bg-gradient-to-br from-emerald-50 via-green-50/70 to-emerald-100/50 border-emerald-300'
                  : 'bg-gradient-to-br from-amber-50 via-orange-50/50 to-amber-100/50 border-amber-300'
              }`}
            >
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-start gap-3.5">
                  <div
                    className={`w-12 h-12 rounded-2xl flex items-center justify-center text-2xl shrink-0 shadow-sm ${
                      remunerationEligibility.isEligible
                        ? 'bg-emerald-600 text-white shadow-emerald-600/20'
                        : 'bg-amber-500 text-white shadow-amber-500/20'
                    }`}
                  >
                    {remunerationEligibility.isEligible ? '✓' : '⚠️'}
                  </div>

                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-xs px-3 py-1 rounded-full font-black uppercase tracking-wider border shadow-xs ${
                          remunerationEligibility.isEligible
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-amber-600 text-white border-amber-600'
                        }`}
                      >
                        {remunerationEligibility.statusLabel}
                      </span>
                      <span className="text-xs font-semibold text-gray-700">
                        Dasar Pembayaran Remunerasi {recap.period.label}
                      </span>
                    </div>

                    <h3 className="text-lg md:text-xl font-extrabold text-gray-900 mt-1.5">
                      {remunerationEligibility.isEligible
                        ? 'Hak Pembayaran Remunerasi / Gaji: BERHAK DIBAYARKAN'
                        : 'Hak Pembayaran Remunerasi / Gaji: MENUNGGU KELENGKAPAN BERKAS'}
                    </h3>
                    <p className="text-xs md:text-sm text-gray-700 mt-1 leading-relaxed max-w-4xl">
                      {remunerationEligibility.summaryMessage}
                    </p>
                  </div>
                </div>

                <div className="text-right shrink-0 bg-white/90 backdrop-blur-xs p-3.5 rounded-2xl border border-gray-200 shadow-xs w-full md:w-auto">
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                    Kelengkapan Syarat
                  </p>
                  <p className="text-2xl font-black text-gray-900 mt-0.5">
                    {remunerationEligibility.completedCount}{' '}
                    <span className="text-xs font-semibold text-gray-500">
                      / {remunerationEligibility.totalRequirementsCount} Syarat
                    </span>
                  </p>
                </div>
              </div>

              {/* Checklist Rincian Syarat Kontraktual */}
              <div className="mt-5 pt-4 border-t border-gray-200/80">
                <p className="text-xs font-bold text-gray-800 uppercase tracking-wider mb-2.5">
                  Rincian Pemenuhan Syarat Kontraktual Remunerasi:
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {remunerationEligibility.checklist.map((item) => (
                    <div
                      key={item.id}
                      className={`p-3.5 rounded-xl border flex items-start justify-between gap-2 shadow-2xs ${
                        item.fulfilled
                          ? 'bg-white/95 border-emerald-300 text-emerald-950'
                          : 'bg-white/95 border-amber-300 text-amber-950'
                      }`}
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-sm">
                            {item.fulfilled ? '✅' : '⏳'}
                          </span>
                          <span className="font-bold text-xs md:text-sm">
                            {item.title}
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-600 line-clamp-1">
                          {item.subtitle}
                        </p>
                        <p
                          className={`text-[11px] font-bold mt-1 ${
                            item.fulfilled ? 'text-emerald-700' : 'text-amber-700'
                          }`}
                        >
                          Status: {item.statusText}
                        </p>
                      </div>

                      {item.deliverableId && (
                        <a
                          href={`/deliverables/view/${item.deliverableId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] font-bold rounded-lg transition shrink-0 ml-1"
                          title="Buka Dokumen"
                        >
                          Lihat ↗
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* KPI */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard
              label="Pegawai"
              value={recap.totals.employees}
              hint={`${recap.totals.manDaysCapacity} orang-hari`}
            />
            <StatCard
              label="Kehadiran"
              value={`${recap.totals.attendanceRate.toFixed(1)}%`}
              tone={rateTone(recap.totals.attendanceRate)}
              hint={`${recap.totals.presentDays} dari ${recap.totals.manDaysCapacity} orang-hari`}
            />
            <StatCard
              label="Ketepatan Waktu"
              value={`${recap.totals.punctualityRate.toFixed(1)}%`}
              tone={rateTone(recap.totals.punctualityRate)}
              hint={`${recap.totals.lateDays} hari terlambat`}
            />
            <StatCard
              label="Rata-rata Check-In"
              value={formatMinutesOfDay(recap.totals.averageCheckInMinutes)}
              hint="WIB, seluruh pegawai"
            />
            <StatCard
              label="Tidak Hadir"
              value={recap.totals.absentDays}
              tone="text-rose-600"
              hint={`${recap.totals.earlyLeaveDays} hari pulang awal`}
            />
            <StatCard
              label="Jam Kerja"
              value={recap.totals.workHours.toFixed(1)}
              hint={`${recap.totals.openShiftDays} shift belum check-out`}
            />
          </div>

          {/* Sebaran lokasi kehadiran */}
          <div className="bg-white rounded-xl shadow-md p-5">
            <h3 className="text-base font-semibold text-gray-800">
              Sebaran Lokasi Kehadiran
            </h3>
            <p className="mt-1 text-xs text-gray-500">
              Satuannya <strong>orang-hari</strong>: satu pegawai yang check-in
              pada satu hari dihitung 1. Totalnya {locationTotalDays} orang-hari
              dari seluruh {recap.totals.employees} pegawai sepanjang periode —
              jadi angkanya wajar melebihi jumlah hari dalam periode. Lokasi
              diambil dari titik operasional yang tervalidasi server saat check-in.
            </p>

            {locationTotalDays > 0 ? (
              <>
                <div className="mt-4 flex h-4 w-full overflow-hidden rounded-full bg-gray-100">
                  {LOCATION_CATEGORIES.map((category) => {
                    const days = recap.locationTotals[category.key] || 0;
                    if (days === 0) return null;
                    return (
                      <div
                        key={category.key}
                        title={`${category.label}: ${days} orang-hari`}
                        style={{
                          width: `${(days / locationTotalDays) * 100}%`,
                          backgroundColor: category.color,
                        }}
                      />
                    );
                  })}
                </div>
                <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                  {LOCATION_CATEGORIES.map((category) => {
                    const days = recap.locationTotals[category.key] || 0;
                    return (
                      <div key={category.key} className="flex items-start gap-2">
                        <span
                          className="mt-1 h-3 w-3 shrink-0 rounded-sm"
                          style={{ backgroundColor: category.color }}
                        />
                        <div>
                          <p className="text-sm font-medium text-gray-800">
                            {days} orang-hari
                          </p>
                          <p className="text-xs text-gray-500">{category.label}</p>
                          <p className="text-[11px] text-gray-400">
                            {((days / locationTotalDays) * 100).toFixed(1)}%
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="mt-4 text-sm text-gray-500">
                Belum ada kehadiran tercatat pada periode ini.
              </p>
            )}
          </div>

          {/* Tren harian */}
          <div className="bg-white rounded-xl shadow-md p-5">
            <h3 className="text-base font-semibold text-gray-800">Tren Kehadiran Harian</h3>
            <p className="mt-1 text-xs text-gray-500">
              Tinggi batang = jumlah pegawai hadir; bagian oranye = terlambat.
            </p>
            <div className="mt-4 flex items-end gap-[3px] overflow-x-auto pb-1">
              {recap.dailyTrend.map((day) => {
                const capacity = Math.max(recap.totals.employees, 1);
                const height = Math.round((day.present / capacity) * 56);
                const lateHeight = Math.round((day.late / capacity) * 56);
                return (
                  <div
                    key={day.date}
                    title={`${formatDateKeyId(day.date)} — hadir ${day.present}, terlambat ${day.late}`}
                    className="flex w-3 shrink-0 flex-col justify-end"
                    style={{ height: 60 }}
                  >
                    <div
                      className={`w-full rounded-t-sm ${day.weekend ? 'bg-gray-300' : 'bg-emerald-500'}`}
                      style={{ height: Math.max(height, day.present > 0 ? 3 : 1) }}
                    />
                    {lateHeight > 0 && (
                      <div className="w-full bg-amber-500" style={{ height: lateHeight }} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tabel rekap pegawai */}
          <div className="bg-white rounded-xl shadow-md p-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div>
                <h3 className="text-base font-semibold text-gray-800">
                  Rekap per Pegawai
                </h3>
                <p className="text-xs text-gray-500">
                  Klik baris untuk melihat kalender kehadiran dan rincian lokasi.
                </p>
              </div>
              <select
                value={sortKey}
                onChange={(event) => setSortKey(event.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="mb-4 flex flex-wrap gap-3 text-[11px] text-gray-600">
              {Object.entries(DAY_STATE_STYLES).map(([state, style]) => (
                <span key={state} className="flex items-center gap-1.5">
                  <span className={`h-3 w-3 rounded-sm ${style.className}`} />
                  {style.label}
                </span>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700">Pegawai</th>
                    <th className="text-center py-3 px-3 text-xs font-semibold text-gray-700">Hadir</th>
                    <th className="text-center py-3 px-3 text-xs font-semibold text-gray-700">Telat</th>
                    <th className="text-center py-3 px-3 text-xs font-semibold text-gray-700">Absen</th>
                    <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700">Kehadiran</th>
                    <th className="text-center py-3 px-3 text-xs font-semibold text-gray-700">Check-In</th>
                    <th className="text-left py-3 px-3 text-xs font-semibold text-gray-700">Lokasi Dominan</th>
                    <th className="text-center py-3 px-3 text-xs font-semibold text-gray-700">Jam Kerja</th>
                    <th className="text-center py-3 px-3 text-xs font-semibold text-gray-700">Pulang Awal</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedEmployees.map((employee) => {
                    const isExpanded = expandedEmployeeId === employee.id;
                    return (
                      <Fragment key={employee.id}>
                        <tr
                          onClick={() => setExpandedEmployeeId(
                            isExpanded ? null : employee.id
                          )}
                          className={`border-b cursor-pointer transition-colors ${
                            isExpanded ? 'bg-green-50' : 'hover:bg-gray-50'
                          }`}
                        >
                          <td className="py-3 px-3">
                            <p className="font-medium text-gray-800 text-sm">{employee.name}</p>
                            <p className="text-[11px] text-gray-500">
                              {employee.position} · {employee.department}
                            </p>
                          </td>
                          <td className="text-center py-3 px-3 text-sm font-medium text-emerald-600">
                            {employee.presentDays}
                            <span className="text-[11px] text-gray-400">
                              /{employee.elapsedWorkingDays}
                            </span>
                          </td>
                          <td className="text-center py-3 px-3 text-sm text-amber-600">
                            {employee.lateDays}
                          </td>
                          <td className="text-center py-3 px-3 text-sm text-rose-600">
                            {employee.absentDays}
                          </td>
                          <td className="py-3 px-3">
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-24 rounded-full bg-gray-200">
                                <div
                                  className={`h-2 rounded-full ${rateBarTone(employee.attendanceRate)}`}
                                  style={{ width: `${Math.min(100, employee.attendanceRate)}%` }}
                                />
                              </div>
                              <span className={`text-xs font-semibold ${rateTone(employee.attendanceRate)}`}>
                                {employee.attendanceRate.toFixed(0)}%
                              </span>
                            </div>
                          </td>
                          <td className="text-center py-3 px-3 text-sm text-gray-700">
                            {employee.averageCheckInLabel}
                          </td>
                          <td className="py-3 px-3 text-xs text-gray-700">
                            {employee.dominantLocation
                              ? `${employee.dominantLocation.label} (${employee.dominantLocation.days})`
                              : '-'}
                          </td>
                          <td className="text-center py-3 px-3 text-sm text-gray-700">
                            {employee.totalWorkHours.toFixed(1)}
                          </td>
                          <td className="text-center py-3 px-3 text-sm text-gray-700">
                            {employee.earlyLeaveDays}
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="bg-green-50/50 border-b">
                            <td colSpan={9} className="px-3 py-4">
                              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                                <div className="lg:col-span-2">
                                  <p className="text-xs font-semibold text-gray-700 mb-2">
                                    Kalender kehadiran periode
                                  </p>
                                  <DayStrip
                                    dateKeys={recap.dateKeys}
                                    dayStates={employee.dayStates}
                                  />
                                  <p className="mt-2 text-[11px] text-gray-500">
                                    {formatDateKeyId(recap.period.startDate)} –
                                    {' '}{formatDateKeyId(recap.period.endDate)}
                                  </p>
                                </div>
                                <div className="space-y-3">
                                  <div>
                                    <p className="text-xs font-semibold text-gray-700 mb-1">
                                      Lokasi kehadiran
                                    </p>
                                    <ul className="space-y-0.5 text-xs text-gray-600">
                                      {LOCATION_CATEGORIES.map((category) => (
                                        <li key={category.key} className="flex justify-between gap-3">
                                          <span>{category.label}</span>
                                          <span className="font-medium text-gray-800">
                                            {employee.locationTally[category.key]} hari
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                    {employee.topLocationNames.length > 0 && (
                                      <p className="mt-2 text-[11px] text-gray-500">
                                        Titik tersering:{' '}
                                        {employee.topLocationNames
                                          .map((entry) => `${entry.name} (${entry.days})`)
                                          .join(', ')}
                                      </p>
                                    )}
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div className="rounded-lg bg-white border border-gray-200 p-2">
                                      <p className="text-gray-500">Pulang awal</p>
                                      <p className="font-semibold text-gray-800">
                                        {employee.earlyLeaveDays} hari
                                      </p>
                                    </div>
                                    <div className="rounded-lg bg-white border border-gray-200 p-2">
                                      <p className="text-gray-500">Shift terbuka</p>
                                      <p className="font-semibold text-gray-800">
                                        {employee.openShiftDays} hari
                                      </p>
                                    </div>
                                    <div className="rounded-lg bg-white border border-gray-200 p-2">
                                      <p className="text-gray-500">Hadir akhir pekan</p>
                                      <p className="font-semibold text-gray-800">
                                        {employee.weekendPresentDays} hari
                                      </p>
                                    </div>
                                    <div className="rounded-lg bg-white border border-gray-200 p-2">
                                      <p className="text-gray-500">Koreksi admin</p>
                                      <p className="font-semibold text-gray-800">
                                        {employee.manualCorrectionDays} hari
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {sortedEmployees.length === 0 && (
              <p className="py-6 text-center text-sm text-gray-500">
                Tidak ada pegawai aktif untuk direkap.
              </p>
            )}
          </div>

          {/* Catatan integritas */}
          <div className="bg-white rounded-xl shadow-md p-5">
            <h3 className="text-base font-semibold text-gray-800">Catatan Integritas Data</h3>
            <p className="mt-1 text-xs text-gray-500">
              Rekap hanya menghitung record yang lolos verifikasi. Angka di bawah
              menunjukkan apa yang dikecualikan agar dapat ditelusuri.
            </p>
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div className="rounded-lg bg-gray-50 p-3">
                <p className="text-xs text-gray-500">Record terhitung</p>
                <p className="font-semibold text-gray-800">
                  {recap.integrity.eligibleRecords} / {recap.integrity.totalRecords}
                </p>
              </div>
              <div className="rounded-lg bg-amber-50 p-3">
                <p className="text-xs text-amber-700">Tidak lolos verifikasi</p>
                <p className="font-semibold text-amber-800">
                  {recap.integrity.ineligibleRecords}
                </p>
              </div>
              <div className="rounded-lg bg-rose-50 p-3">
                <p className="text-xs text-rose-700">Projection koreksi ditolak</p>
                <p className="font-semibold text-rose-800">
                  {recap.integrity.invalidCorrectionProjections}
                </p>
              </div>
              <div className="rounded-lg bg-sky-50 p-3">
                <p className="text-xs text-sky-700">Pegawai nonaktif/tak dikenal</p>
                <p className="font-semibold text-sky-800">
                  {recap.integrity.unmatchedRecords}
                </p>
              </div>
            </div>
          </div>
        </>
      )}

      {!recap && !loading && (
        <div className="bg-white rounded-xl shadow-md p-10 text-center">
          <p className="text-4xl">📊</p>
          <p className="mt-3 text-sm text-gray-600">
            Pilih periode kontrak lalu tekan <strong>Susun Rekap</strong> untuk
            melihat rekapitulasi kehadiran, lokasi, dan dasar remunerasi.
          </p>
        </div>
      )}
    </div>
  );
}

export default PeriodRecap;
