// Dokumen cetak rekap periode — ISWMP SumBar-Padang
//
// Menyusun satu dokumen HTML mandiri yang meniru tampilan tab Rekap Periode,
// lalu mencetaknya lewat iframe tersembunyi. Dialog cetak peramban dipakai
// untuk menghasilkan PDF: hasilnya vektor dan teksnya tetap dapat diseleksi,
// berbeda dengan tangkapan layar, dan tidak menambah dependensi baru.

import { PROJECT } from '../config/projectConfig.js';
import { printHtmlDocument } from './printDocument.js';
import { formatDateKeyId } from './contractPeriods.js';
import {
  DAY_STATE,
  LOCATION_CATEGORIES,
  formatMinutesOfDay,
} from './attendanceRecap.js';

const DAY_STATE_PRINT = {
  [DAY_STATE.ONTIME]: { color: '#10b981', label: 'Hadir tepat waktu' },
  [DAY_STATE.LATE]: { color: '#f59e0b', label: 'Terlambat' },
  [DAY_STATE.ABSENT]: { color: '#fb7185', label: 'Tidak hadir' },
  [DAY_STATE.WEEKEND_PRESENT]: { color: '#0ea5e9', label: 'Hadir akhir pekan' },
  [DAY_STATE.WEEKEND]: { color: '#e5e7eb', label: 'Akhir pekan' },
  [DAY_STATE.FUTURE]: { color: '#f3f4f6', label: 'Belum berjalan' },
  [DAY_STATE.PRE_ACTIVE]: { color: '#ffffff', label: 'Belum bergabung' },
};

/** Nama pegawai dan lokasi berasal dari input pengguna, jadi selalu di-escape. */
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const oneDecimal = (value) => (Number.isFinite(value) ? value.toFixed(1) : '0.0');

const rateColor = (value) => {
  if (value >= 90) return '#059669';
  if (value >= 75) return '#d97706';
  return '#e11d48';
};

const statCard = (label, value, hint, color = '#111827') => `
  <div class="stat">
    <p class="stat-label">${escapeHtml(label)}</p>
    <p class="stat-value" style="color:${color}">${escapeHtml(value)}</p>
    <p class="stat-hint">${escapeHtml(hint)}</p>
  </div>
`;

const dayStripHtml = (dateKeys, dayStates) => dateKeys.map((dateKey) => {
  const state = dayStates[dateKey] || DAY_STATE.FUTURE;
  const style = DAY_STATE_PRINT[state] || DAY_STATE_PRINT[DAY_STATE.FUTURE];
  const border = state === DAY_STATE.PRE_ACTIVE
    ? 'border:1px dashed #d1d5db;'
    : 'border:1px solid rgba(0,0,0,0.05);';
  return `<span class="day" style="background:${style.color};${border}"></span>`;
}).join('');

const buildDocument = (recap, contract, remuneration = null) => {
  const {
    period, totals, locationTotals, integrity, dateKeys,
  } = recap;

  const locationTotalDays = LOCATION_CATEGORIES.reduce(
    (sum, category) => sum + (locationTotals[category.key] || 0),
    0
  );

  const locationBar = locationTotalDays > 0
    ? LOCATION_CATEGORIES.map((category) => {
      const days = locationTotals[category.key] || 0;
      if (days === 0) return '';
      const width = (days / locationTotalDays) * 100;
      return `<div style="width:${width}%;background:${category.color}"></div>`;
    }).join('')
    : '';

  const locationLegend = LOCATION_CATEGORIES.map((category) => {
    const days = locationTotals[category.key] || 0;
    const share = locationTotalDays > 0
      ? ((days / locationTotalDays) * 100).toFixed(1)
      : '0.0';
    return `
      <div class="legend-item">
        <span class="swatch" style="background:${category.color}"></span>
        <div>
          <p class="legend-value">${days} orang-hari</p>
          <p class="legend-label">${escapeHtml(category.label)} · ${share}%</p>
        </div>
      </div>
    `;
  }).join('');

  const dayLegend = Object.values(DAY_STATE_PRINT).map((style) => `
    <span class="legend-chip">
      <span class="swatch" style="background:${style.color};border:1px solid #d1d5db"></span>
      ${escapeHtml(style.label)}
    </span>
  `).join('');

  const employeeRows = recap.employees.map((employee, index) => `
    <tr>
      <td class="num">${index + 1}</td>
      <td>
        <p class="name">${escapeHtml(employee.name)}</p>
        <p class="sub">${escapeHtml(employee.position)} · ${escapeHtml(employee.department)}</p>
      </td>
      <td class="num">${employee.presentDays}<span class="sub"> / ${employee.elapsedWorkingDays}</span></td>
      <td class="num">${employee.onTimeDays}</td>
      <td class="num">${employee.lateDays}</td>
      <td class="num">${employee.absentDays}</td>
      <td class="num">${employee.earlyLeaveDays}</td>
      <td>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.min(100, employee.attendanceRate)}%;background:${rateColor(employee.attendanceRate)}"></div>
        </div>
        <span class="bar-value" style="color:${rateColor(employee.attendanceRate)}">
          ${employee.attendanceRate.toFixed(0)}%
        </span>
      </td>
      <td class="num">${escapeHtml(employee.averageCheckInLabel)}</td>
      <td class="num">${oneDecimal(employee.totalWorkHours)}</td>
      <td>${escapeHtml(employee.dominantLocation
    ? `${employee.dominantLocation.label} (${employee.dominantLocation.days})`
    : '-')}</td>
    </tr>
  `).join('');

  const calendarRows = recap.employees.map((employee) => `
    <tr>
      <td class="calendar-name">
        <p class="name">${escapeHtml(employee.name)}</p>
        <p class="sub">${employee.presentDays} hadir · ${employee.lateDays} telat · ${employee.absentDays} absen</p>
      </td>
      <td><div class="strip">${dayStripHtml(dateKeys, employee.dayStates)}</div></td>
    </tr>
  `).join('');

  const locationDetailRows = recap.employees.map((employee) => `
    <tr>
      <td>${escapeHtml(employee.name)}</td>
      <td class="num">${employee.locationTally.kantor}</td>
      <td class="num">${employee.locationTally.kelurahan}</td>
      <td class="num">${employee.locationTally.temporary}</td>
      <td class="num">${employee.locationTally.lainnya}</td>
      <td>${escapeHtml(employee.topLocationNames
    .map((entry) => `${entry.name} (${entry.days})`)
    .join(', ') || '-')}</td>
    </tr>
  `).join('');

  const generatedAt = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
  });

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Rekap Kehadiran ${escapeHtml(period.shortLabel)} — ${escapeHtml(PROJECT.shortName)}</title>
<style>
  @page { size: A4 landscape; margin: 11mm 10mm 13mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    color: #111827;
    font-size: 9.5px;
    line-height: 1.45;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 { font-size: 15px; margin: 0; }
  h2 {
    font-size: 11px;
    margin: 0 0 6px;
    padding-bottom: 3px;
    border-bottom: 1.5px solid #059669;
    color: #065f46;
  }
  p { margin: 0; }
  section { margin-bottom: 12px; }
  section.break { break-before: page; }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    padding-bottom: 8px;
    margin-bottom: 12px;
    border-bottom: 2px solid #059669;
  }
  .header .sub { color: #4b5563; font-size: 9px; }
  .period-badge {
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
    border-radius: 6px;
    padding: 6px 10px;
    text-align: right;
    min-width: 190px;
  }
  .period-badge .title { font-weight: 700; color: #065f46; font-size: 11px; }
  .period-badge .meta { color: #047857; font-size: 8.5px; }
  .stats { display: flex; gap: 6px; }
  .stat {
    flex: 1;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 6px 8px;
    background: #fafafa;
  }
  .stat-label {
    font-size: 7.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #6b7280;
  }
  .stat-value { font-size: 15px; font-weight: 700; margin-top: 1px; }
  .stat-hint { font-size: 7.5px; color: #6b7280; }
  .location-bar {
    display: flex;
    height: 12px;
    border-radius: 6px;
    overflow: hidden;
    background: #f3f4f6;
    margin-bottom: 7px;
  }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; }
  .legend-item { display: flex; gap: 5px; align-items: flex-start; }
  .legend-value { font-weight: 600; }
  .legend-label { color: #6b7280; font-size: 8px; }
  .legend-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 8px; color: #4b5563; }
  .swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; flex: 0 0 auto; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th {
    background: #f3f4f6;
    text-align: left;
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #374151;
    padding: 5px 4px;
    border-bottom: 1px solid #d1d5db;
  }
  td { padding: 4px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td.num, th.num { text-align: center; }
  .name { font-weight: 600; }
  .sub { color: #6b7280; font-size: 8px; }
  .bar-track {
    height: 5px;
    width: 62px;
    background: #e5e7eb;
    border-radius: 3px;
    display: inline-block;
    vertical-align: middle;
    overflow: hidden;
  }
  .bar-fill { height: 5px; border-radius: 3px; }
  .bar-value { font-size: 8px; font-weight: 700; margin-left: 4px; }
  .strip { display: flex; flex-wrap: nowrap; gap: 1.5px; }
  .day { width: 8px; height: 12px; border-radius: 2px; display: inline-block; }
  .calendar-name { width: 150px; }
  .notes {
    display: flex;
    gap: 6px;
  }
  .note {
    flex: 1;
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 8.5px;
  }
  .footer {
    margin-top: 10px;
    padding-top: 6px;
    border-top: 1px solid #e5e7eb;
    display: flex;
    justify-content: space-between;
    color: #6b7280;
    font-size: 8px;
  }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Rekap Kehadiran per Periode Kontrak</h1>
      <p class="sub">${escapeHtml(PROJECT.fullName)}</p>
      <p class="sub">${escapeHtml(PROJECT.ministry)} · ${escapeHtml(contract.label)}</p>
    </div>
    <div class="period-badge">
      <p class="title">${escapeHtml(period.label)}</p>
      <p class="meta">Hari kontrak ke-${period.contractDayStart} s/d ke-${period.contractDayEnd} dari ${contract.durationDays}</p>
      <p class="meta">${period.totalDays} hari kalender · ${recap.workingDays} hari kerja</p>
      <p class="meta">Data s/d ${escapeHtml(formatDateKeyId(recap.cutoffDateKey))}${recap.isOngoing ? ' (berjalan)' : ' (selesai)'}</p>
    </div>
  </div>

  ${remuneration ? `
  <section style="background:${remuneration.isEligible ? '#ecfdf5' : '#fffbeb'};border:1.5px solid ${remuneration.isEligible ? '#10b981' : '#f59e0b'};border-radius:8px;padding:10px 12px;margin-bottom:12px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <h2 style="margin:0;color:${remuneration.isEligible ? '#065f46' : '#92400e'};font-size:12px;text-transform:uppercase;letter-spacing:0.5px">
        STATUS KELAYAKAN PEMBAYARAN REMUNERASI / GAJI: ${escapeHtml(remuneration.statusLabel)}
      </h2>
      <span style="font-size:11px;font-weight:bold;color:${remuneration.isEligible ? '#047857' : '#b45309'}">
        ${remuneration.completedCount} / ${remuneration.totalRequirementsCount} Syarat Terpenuhi
      </span>
    </div>
    <p style="margin:0 0 8px 0;font-size:10px;color:${remuneration.isEligible ? '#064e3b' : '#78350f'};line-height:1.4">
      ${escapeHtml(remuneration.summaryMessage)}
    </p>
    <div style="display:flex;gap:8px;font-size:9.5px">
      ${remuneration.checklist.map((c) => `
        <div style="background:#ffffff;border:1px solid ${c.fulfilled ? '#a7f3d0' : '#fde68a'};border-radius:6px;padding:5px 8px;flex:1">
          <p style="margin:0;font-weight:bold;color:#1f2937">${c.fulfilled ? '✓' : '⏳'} ${escapeHtml(c.title)}</p>
          <p style="margin:2px 0 0 0;font-size:8.5px;color:#4b5563">${escapeHtml(c.statusText)}</p>
        </div>
      `).join('')}
    </div>
  </section>
  ` : ''}

  <section>
    <h2>Ringkasan Periode</h2>
    <div class="stats">
      ${statCard('Pegawai', String(totals.employees), `${totals.manDaysCapacity} orang-hari`)}
      ${statCard('Kehadiran', `${oneDecimal(totals.attendanceRate)}%`, `${totals.presentDays} dari ${totals.manDaysCapacity} orang-hari`, rateColor(totals.attendanceRate))}
      ${statCard('Ketepatan Waktu', `${oneDecimal(totals.punctualityRate)}%`, `${totals.lateDays} hari terlambat`, rateColor(totals.punctualityRate))}
      ${statCard('Rata-rata Check-In', formatMinutesOfDay(totals.averageCheckInMinutes), 'WIB, seluruh pegawai')}
      ${statCard('Tidak Hadir', String(totals.absentDays), `${totals.earlyLeaveDays} hari pulang awal`, '#e11d48')}
      ${statCard('Jam Kerja', oneDecimal(totals.workHours), `${totals.openShiftDays} shift belum check-out`)}
    </div>
  </section>

  <section>
    <h2>Sebaran Lokasi Kehadiran — ${locationTotalDays} orang-hari</h2>
    <p class="sub" style="margin-bottom:6px">
      Satuan orang-hari: satu pegawai yang check-in pada satu hari dihitung 1,
      sehingga totalnya melebihi jumlah hari dalam periode.
    </p>
    <div class="location-bar">${locationBar}</div>
    <div class="legend">${locationLegend}</div>
  </section>

  <section>
    <h2>Rekap per Pegawai</h2>
    <table>
      <thead>
        <tr>
          <th class="num">No</th>
          <th>Pegawai</th>
          <th class="num">Hadir</th>
          <th class="num">Tepat Waktu</th>
          <th class="num">Telat</th>
          <th class="num">Absen</th>
          <th class="num">Pulang Awal</th>
          <th>Kehadiran</th>
          <th class="num">Rata-rata Check-In</th>
          <th class="num">Jam Kerja</th>
          <th>Lokasi Dominan</th>
        </tr>
      </thead>
      <tbody>${employeeRows}</tbody>
    </table>
  </section>

  <section class="break">
    <h2>Kalender Kehadiran · ${escapeHtml(formatDateKeyId(period.startDate))} – ${escapeHtml(formatDateKeyId(period.endDate))}</h2>
    <div class="legend" style="margin-bottom:7px">${dayLegend}</div>
    <table>
      <tbody>${calendarRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Rincian Lokasi Kehadiran per Pegawai (hari)</h2>
    <table>
      <thead>
        <tr>
          <th>Pegawai</th>
          <th class="num">Kantor Proyek</th>
          <th class="num">Lokasi Penugasan</th>
          <th class="num">Kegiatan Sementara</th>
          <th class="num">Lainnya</th>
          <th>Titik Tersering</th>
        </tr>
      </thead>
      <tbody>${locationDetailRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Catatan Integritas Data</h2>
    <div class="notes">
      <div class="note" style="background:#f9fafb">
        <p>Record terhitung</p>
        <p class="name">${integrity.eligibleRecords} / ${integrity.totalRecords}</p>
      </div>
      <div class="note" style="background:#fffbeb;color:#92400e">
        <p>Tidak lolos verifikasi</p>
        <p class="name">${integrity.ineligibleRecords}</p>
      </div>
      <div class="note" style="background:#fff1f2;color:#9f1239">
        <p>Projection koreksi ditolak</p>
        <p class="name">${integrity.invalidCorrectionProjections}</p>
      </div>
      <div class="note" style="background:#f0f9ff;color:#075985">
        <p>Pegawai nonaktif/tak dikenal</p>
        <p class="name">${integrity.unmatchedRecords}</p>
      </div>
      <div class="note" style="background:#f9fafb">
        <p>Koreksi administratif</p>
        <p class="name">${totals.manualCorrectionDays} hari</p>
      </div>
    </div>
  </section>

  <div class="footer">
    <span>${escapeHtml(PROJECT.shortName)} · ${escapeHtml(contract.label)}</span>
    <span>Dicetak ${escapeHtml(generatedAt)} WIB</span>
  </div>
</body>
</html>`;
};

export const buildPeriodRecapDocument = buildDocument;

export const getPeriodRecapPrintTitle = (recap) =>
  `Rekap_Kehadiran_Periode-${String(recap.period.index).padStart(2, '0')}_${recap.period.startDate}_${recap.period.endDate}`;

/** Cetak rekap periode; pengguna memilih "Save as PDF" pada dialog cetak. */
export const printPeriodRecap = async (recap, contract, remuneration = null) => {
  if (!recap?.period) throw new Error('Rekap belum tersedia.');
  await printHtmlDocument(buildDocument(recap, contract, remuneration), {
    title: getPeriodRecapPrintTitle(recap),
  });
};
