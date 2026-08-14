// src/utils/remunerationEligibility.js
//
// Logika penentuan kelayakan pembayaran remunerasi/gaji per periode kontrak:
// 1. Syarat 1: Laporan Daily Activity / Rekap Kehadiran Harian tercatat.
// 2. Syarat 2: Laporan Bulanan Ke-N telah disubmit/diupload.
// 3. Syarat 3 (Kondisional per Periode):
//    - Periode 1: Laporan Pendahuluan (Inception Report).
//    - Periode 3: Laporan Triwulanan I & Slide Bahan Presentasi BPBPK.
//    - Periode 6: Laporan Triwulanan II & Slide Bahan Presentasi BPBPK.
//    - Periode 9: Laporan Triwulanan III & Slide Bahan Presentasi BPBPK.
//    - Periode 10: Laporan Akhir & Basis Data BNBA (SSD 1TB).

import { isCompletedVerifiedAttendance } from './attendanceIntegrity.js';

/**
 * Mengevaluasi apakah suatu deliverable dianggap telah disubmit / valid
 */
export const isDeliverableSubmitted = (deliverable) => {
  if (!deliverable) return false;
  const sub = deliverable.submission;
  if (!sub) return false;
  if (sub.status === 'submitted' || sub.status === 'approved') return true;
  return false;
};

/**
 * Mendapatkan daftar laporan khusus kontraktual untuk periode tertentu
 */
export const getPeriodSpecificDeliverableConfigs = (periodIndex) => {
  const specific = [];
  if (periodIndex === 1) {
    specific.push({
      id: 'laporan_pendahuluan',
      title: 'Laporan Pendahuluan (Inception Report)',
      code: 'LP',
      deadlineInfo: 'Paling lambat 25 hari kalender sejak SPMK (07 Agustus 2026)',
    });
  } else if (periodIndex === 3) {
    specific.push({
      id: 'laporan_triwulan_01',
      title: 'Laporan Triwulanan I & Bahan Presentasi BPBPK',
      code: 'LTW-01',
      deadlineInfo: 'Disampaikan ke BPBPK (Rapat Offline Bulan ke-3)',
    });
  } else if (periodIndex === 6) {
    specific.push({
      id: 'laporan_triwulan_02',
      title: 'Laporan Triwulanan II & Bahan Presentasi BPBPK',
      code: 'LTW-02',
      deadlineInfo: 'Disampaikan ke BPBPK (Rapat Offline Bulan ke-6)',
    });
  } else if (periodIndex === 9) {
    specific.push({
      id: 'laporan_triwulan_03',
      title: 'Laporan Triwulanan III & Bahan Presentasi BPBPK',
      code: 'LTW-03',
      deadlineInfo: 'Disampaikan ke BPBPK (Rapat Offline Bulan ke-9)',
    });
  } else if (periodIndex === 10) {
    specific.push({
      id: 'laporan_akhir',
      title: 'Laporan Akhir, Basis Data BNBA, & SSD 1TB',
      code: 'LA-FINAL',
      deadlineInfo: 'Paling lambat pada akhir masa kontrak (08 Mei 2027)',
    });
  }
  return specific;
};

/**
 * Mengevaluasi kelayakan pembayaran gaji/remunerasi untuk satu periode kontrak
 *
 * @param {Object} params
 * @param {number} params.periodIndex - Indeks periode (1 s/d 10)
 * @param {Object} [params.period] - Objek periode kontrak
 * @param {Array} [params.attendances] - Daftar record kehadiran pada periode ini
 * @param {Array} [params.deliverables] - Daftar seluruh deliverables KAK dengan status submission
 * @returns {Object} Hasil evaluasi kelayakan remunerasi
 */
export const evaluatePeriodRemunerationEligibility = ({
  periodIndex = 1,
  period = null,
  attendances = [],
  deliverables = [],
}) => {
  const index = Number(periodIndex) || 1;
  const checklist = [];
  const missingItems = [];

  // Map deliverables by ID
  const deliverablesMap = new Map();
  if (Array.isArray(deliverables)) {
    deliverables.forEach((d) => {
      if (d && d.id) deliverablesMap.set(d.id, d);
    });
  }

  // 1. Syarat Minimal 1: Laporan Daily Activity (Kehadiran Harian Tercatat)
  const validAttendancesCount = Array.isArray(attendances)
    ? attendances.filter(isCompletedVerifiedAttendance).length
    : 0;
  const dailyActivityFulfilled = validAttendancesCount > 0;

  checklist.push({
    id: 'daily_activity',
    category: 'daily',
    title: 'Laporan Daily Activity (Rekap Kehadiran Harian)',
    subtitle: 'Catatan kehadiran harian staf/tenaga ahli di lokasi penugasan / kantor',
    required: true,
    fulfilled: dailyActivityFulfilled,
    statusText: dailyActivityFulfilled
      ? `${validAttendancesCount} Hari Kehadiran Tercatat`
      : 'Belum ada catatan kehadiran',
    filesCount: validAttendancesCount,
  });

  if (!dailyActivityFulfilled) {
    missingItems.push('Laporan Daily Activity / Rekap Kehadiran Harian');
  }

  // 2. Syarat Minimal 2: Laporan Bulanan Ke-N
  const monthlyCode = `laporan_bulanan_${String(index).padStart(2, '0')}`;
  const monthlyDoc = deliverablesMap.get(monthlyCode);
  const monthlyFulfilled = isDeliverableSubmitted(monthlyDoc);
  const monthlyFilesCount = monthlyDoc?.submission?.files?.length || 0;

  checklist.push({
    id: monthlyCode,
    category: 'monthly',
    code: `LB-${String(index).padStart(2, '0')}`,
    title: `Laporan Bulanan Ke-${index}`,
    subtitle: monthlyDoc?.subtitle || `Laporan kemajuan bulanan periode ke-${index} (RTPS, Kelembagaan, Progres Lapangan)`,
    required: true,
    fulfilled: monthlyFulfilled,
    statusText: monthlyFulfilled
      ? `Disubmit (${monthlyFilesCount} Berkas Terunggah)`
      : 'Belum Disubmit / Draf',
    filesCount: monthlyFilesCount,
    deliverableId: monthlyCode,
    deliverable: monthlyDoc,
  });

  if (!monthlyFulfilled) {
    missingItems.push(`Laporan Bulanan Ke-${index}`);
  }

  // 3. Syarat Kontraktual Khusus per Periode
  const specificConfigs = getPeriodSpecificDeliverableConfigs(index);
  specificConfigs.forEach((cfg) => {
    const specificDoc = deliverablesMap.get(cfg.id);
    const specificFulfilled = isDeliverableSubmitted(specificDoc);
    const specificFilesCount = specificDoc?.submission?.files?.length || 0;

    checklist.push({
      id: cfg.id,
      category: 'specific',
      code: cfg.code,
      title: cfg.title,
      subtitle: cfg.deadlineInfo,
      required: true,
      fulfilled: specificFulfilled,
      statusText: specificFulfilled
        ? `Disubmit (${specificFilesCount} Berkas Terunggah)`
        : 'Belum Disubmit / Draf',
      filesCount: specificFilesCount,
      deliverableId: cfg.id,
      deliverable: specificDoc,
    });

    if (!specificFulfilled) {
      missingItems.push(cfg.title);
    }
  });

  // Evaluasi Kelayakan Akhir
  const isEligible = missingItems.length === 0;

  return {
    periodIndex: index,
    periodLabel: period?.label || `Periode ${index}`,
    isEligible,
    status: isEligible ? 'ELIGIBLE' : 'INCOMPLETE',
    statusLabel: isEligible
      ? 'BERHAK DIBAYARKAN (SYARAT KONTRAK LENGKAP)'
      : 'BELUM DAPAT DIBAYARKAN (DOKUMEN BELUM LENGKAP)',
    statusShortLabel: isEligible ? 'Berhak Dibayarkan' : 'Menunggu Dokumen',
    badgeTone: isEligible
      ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
      : 'bg-amber-100 text-amber-950 border-amber-300',
    summaryMessage: isEligible
      ? `Seluruh persyaratan kontraktual (Daily Activity, Laporan Bulanan Ke-${index}${
          specificConfigs.length > 0
            ? ` dan ${specificConfigs.map((c) => c.title).join(', ')}`
            : ''
        }) telah disubmit lengkap ke database PT Surya Abadi Konsultan. Tim kerja berhak untuk menerima pembayaran remunerasi/gaji periode ini.`
      : `Persyaratan pembayaran remunerasi periode ke-${index} belum lengkap. Masih menunggu penyerahan: ${missingItems.join(', ')}.`,
    checklist,
    missingItems,
    completedCount: checklist.filter((item) => item.fulfilled).length,
    totalRequirementsCount: checklist.length,
  };
};
