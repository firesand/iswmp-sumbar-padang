// Paket bukti kehadiran per pegawai — ISWMP SumBar-Padang
//
// Menyusun berkas yang dapat diserahkan ke pemberi kerja atau auditor: dokumen
// tampilan (HTML, bisa dicetak jadi PDF), rekap harian (CSV), dan manifes
// verifikasi berisi sidik SHA-256 tiap foto menurut catatan server.
//
// Manifes sengaja mencantumkan hash dan jalur penyimpanan alih-alih URL: URL
// bukti bertanda tangan hanya berlaku 5 menit, jadi menyimpannya ke dalam arsip
// akan menghasilkan tautan mati — hash tetap dapat diverifikasi kapan pun.

import { PROJECT } from '../config/projectConfig.js';
import { escapeCsvCell } from './attendanceDisplay.js';
import { formatDateKeyId } from './contractPeriods.js';
import { toSafeFileName } from './zipArchive.js';

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const dash = (value) => (value === null || value === undefined || value === '' ? '-' : value);

const meters = (value) => (value === null || value === undefined ? '-' : `${value} m`);

/** Nama berkas foto di dalam paket: tanggal + sisi absensi. */
export const getPhotoFileName = (dateKey, action) =>
  `${dateKey}_${action === 'checkOut' ? 'check-out' : 'check-in'}.jpg`;

export const getEvidenceBundleName = (dossier) => {
  const periodPart = `Periode-${String(dossier.period.index).padStart(2, '0')}`;
  return `Bukti-Kehadiran_${periodPart}_${toSafeFileName(dossier.employee.name, 'pegawai')}`;
};

const sideRowsHtml = (day, photoSrc) => {
  const cell = (side, title) => {
    if (!side) {
      return `<div class="side empty"><p class="side-title">${title}</p>
        <p class="muted">Belum tercatat</p></div>`;
    }
    const src = photoSrc ? photoSrc(day.date, side.action) : null;
    const photo = side.hasPhoto && src
      ? `<img class="proof" src="${escapeHtml(src)}" alt="Bukti ${escapeHtml(title)} ${escapeHtml(day.date)}">`
      : `<p class="muted small">${side.hasPhoto
        ? 'Foto tidak disertakan pada berkas ini.'
        : 'Bukti foto tidak tersedia / tidak lolos verifikasi.'}</p>`;

    return `<div class="side">
      <div class="side-head">
        <p class="side-title">${title}</p>
        <p class="side-time">${escapeHtml(side.timeLabel)}</p>
      </div>
      ${side.isEffective
    ? '<p class="warn">Jam dari koreksi administratif, bukan rekaman perangkat.</p>'
    : ''}
      <table class="kv">
        <tr><td>Lokasi</td><td>${escapeHtml(side.locationName)}</td></tr>
        <tr><td>Kategori</td><td>${escapeHtml(side.locationCategoryLabel)}</td></tr>
        <tr><td>Koordinat</td><td class="mono">${escapeHtml(side.coordinatesLabel)}</td></tr>
        <tr><td>Akurasi GPS</td><td>${escapeHtml(meters(side.accuracyMeters))}</td></tr>
        <tr><td>Jarak dari titik</td><td>${escapeHtml(meters(side.distanceMeters))}</td></tr>
      </table>
      <p class="hash"><span class="muted">SHA-256 foto</span><br>
        <span class="mono tiny">${escapeHtml(dash(side.photoSha256))}</span></p>
      ${photo}
    </div>`;
  };

  return `<div class="sides">${cell(day.checkIn, 'Check-In')}${cell(day.checkOut, 'Check-Out')}</div>`;
};

/**
 * Dokumen tampilan berkas bukti satu pegawai.
 *
 * `photoSrc(dateKey, action)` menentukan asal gambar: jalur relatif untuk paket
 * ZIP, atau URL bertanda tangan untuk pencetakan langsung. Bila null, dokumen
 * tetap lengkap tanpa gambar.
 */
export const buildEvidenceDocumentHtml = ({
  dossier,
  contract,
  photoSrc = null,
  generatedAt = new Date(),
}) => {
  if (!dossier) throw new Error('Berkas bukti belum tersedia.');

  const { employee, period, summary } = dossier;
  const recordedDays = dossier.days.filter((day) => day.hasRecord);

  const dayBlocks = recordedDays.map((day) => `
    <section class="day">
      <div class="day-head">
        <div>
          <p class="day-date">${escapeHtml(formatDateKeyId(day.date))}</p>
          <p class="muted small">${escapeHtml(day.weekdayName)}</p>
        </div>
        <div class="day-meta">
          <span class="badge ${day.status === 'late' ? 'badge-late' : 'badge-ontime'}">
            ${escapeHtml(day.statusLabel)}
          </span>
          ${day.isCrossDay ? '<span class="badge badge-info">Lintas hari</span>' : ''}
          ${day.earlyLeave.isEarlyLeave ? '<span class="badge badge-warn">Pulang awal</span>' : ''}
          <span class="muted small">Jam kerja ${day.workHours.toFixed(2)}</span>
        </div>
      </div>
      <p class="muted small">Jaminan: <strong>${escapeHtml(day.assuranceLabel)}</strong>
        · ID record <span class="mono tiny">${escapeHtml(day.recordId)}</span></p>
      ${day.earlyLeave.isEarlyLeave && day.earlyLeave.reason
    ? `<p class="reason">Alasan pulang awal: ${escapeHtml(day.earlyLeave.reason)}</p>`
    : ''}
      ${sideRowsHtml(day, photoSrc)}
    </section>
  `).join('');

  const tableRows = dossier.days.map((day) => `
    <tr class="${day.hasRecord ? '' : 'row-muted'}">
      <td>${escapeHtml(formatDateKeyId(day.date))}</td>
      <td>${escapeHtml(day.weekdayName)}</td>
      <td>${escapeHtml(day.hasRecord ? day.statusLabel : day.statusLabel)}</td>
      <td class="num">${escapeHtml(day.checkIn ? day.checkIn.timeLabel : '-')}</td>
      <td class="num">${escapeHtml(day.checkOut ? day.checkOut.timeLabel : '-')}</td>
      <td class="num">${day.hasRecord ? day.workHours.toFixed(2) : '-'}</td>
      <td>${escapeHtml(day.checkIn ? day.checkIn.locationName : '-')}</td>
      <td>${escapeHtml(day.checkOut ? day.checkOut.locationName : '-')}</td>
    </tr>
  `).join('');

  const stamp = generatedAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bukti Kehadiran ${escapeHtml(employee.name)} — ${escapeHtml(period.shortLabel)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm 10mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    color: #111827; font-size: 11px; line-height: 1.5; background: #f8fafc;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { max-width: 900px; margin: 0 auto; background: #fff; padding: 20px; }
  h1 { font-size: 17px; margin: 0; }
  h2 {
    font-size: 12px; margin: 18px 0 8px; padding-bottom: 3px;
    border-bottom: 1.5px solid #059669; color: #065f46;
  }
  p { margin: 0; }
  .muted { color: #6b7280; }
  .small { font-size: 10px; }
  .tiny { font-size: 8.5px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .header { border-bottom: 2px solid #059669; padding-bottom: 10px; }
  .identity {
    margin-top: 10px; background: #ecfdf5; border: 1px solid #a7f3d0;
    border-radius: 6px; padding: 10px;
  }
  .identity .name { font-size: 15px; font-weight: 700; color: #065f46; }
  .stats { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .stat {
    flex: 1 1 110px; border: 1px solid #e5e7eb; border-radius: 6px;
    padding: 6px 8px; background: #fafafa;
  }
  .stat-label { font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
  .stat-value { font-size: 15px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th {
    background: #f3f4f6; text-align: left; font-size: 9px; text-transform: uppercase;
    letter-spacing: .03em; color: #374151; padding: 5px 4px; border-bottom: 1px solid #d1d5db;
  }
  td { padding: 4px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td.num, th.num { text-align: center; }
  .row-muted td { color: #9ca3af; }
  .day { break-inside: avoid; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
  .day-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .day-date { font-weight: 700; font-size: 12px; }
  .day-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .badge { border-radius: 999px; padding: 2px 8px; font-size: 9px; font-weight: 600; }
  .badge-ontime { background: #d1fae5; color: #065f46; }
  .badge-late { background: #fef3c7; color: #92400e; }
  .badge-info { background: #cffafe; color: #155e75; }
  .badge-warn { background: #ffedd5; color: #9a3412; }
  .reason { margin-top: 6px; background: #fff7ed; color: #9a3412; padding: 4px 6px; border-radius: 4px; }
  .sides { display: flex; gap: 8px; margin-top: 8px; }
  .side { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; }
  .side.empty { border-style: dashed; }
  .side-head { display: flex; justify-content: space-between; align-items: baseline; }
  .side-title { font-weight: 700; font-size: 10px; color: #374151; }
  .side-time { font-weight: 700; font-size: 12px; }
  .warn { background: #fffbeb; color: #92400e; padding: 3px 5px; border-radius: 4px; font-size: 9px; margin-top: 4px; }
  table.kv { margin-top: 5px; }
  table.kv td { border: 0; padding: 1px 0; font-size: 9.5px; }
  table.kv td:first-child { color: #6b7280; width: 46%; }
  table.kv td:last-child { text-align: right; }
  .hash { margin-top: 5px; font-size: 9px; line-height: 1.35; }
  .hash .mono { word-break: break-all; }
  img.proof {
    margin-top: 6px; width: 100%; border-radius: 6px; border: 1px solid #e5e7eb;
    display: block;
  }
  .footer {
    margin-top: 14px; padding-top: 6px; border-top: 1px solid #e5e7eb;
    display: flex; justify-content: space-between; color: #6b7280; font-size: 9px;
  }
  @media print { body { background: #fff; padding: 0; } .sheet { padding: 0; max-width: none; } }
</style>
</head>
<body>
<div class="sheet">
  <div class="header">
    <h1>Berkas Bukti Kehadiran</h1>
    <p class="muted small">${escapeHtml(PROJECT.fullName)}</p>
    <p class="muted small">${escapeHtml(PROJECT.ministry)} · ${escapeHtml(contract.label)}</p>
  </div>

  <div class="identity">
    <p class="name">${escapeHtml(employee.name)}</p>
    <p class="small">${escapeHtml(employee.position)} · ${escapeHtml(employee.department)}${
  employee.email ? ` · ${escapeHtml(employee.email)}` : ''}</p>
    <p class="small">${escapeHtml(period.label)} · hari kontrak ke-${period.contractDayStart}
      s/d ke-${period.contractDayEnd} dari ${contract.durationDays}</p>
  </div>

  <div class="stats">
    <div class="stat"><p class="stat-label">Hari tercatat</p><p class="stat-value">${summary.recordedDays}</p></div>
    <div class="stat"><p class="stat-label">Terlambat</p><p class="stat-value">${summary.lateDays}</p></div>
    <div class="stat"><p class="stat-label">Shift lengkap</p><p class="stat-value">${summary.completeDays}</p></div>
    <div class="stat"><p class="stat-label">Belum check-out</p><p class="stat-value">${summary.openShiftDays}</p></div>
    <div class="stat"><p class="stat-label">Pulang awal</p><p class="stat-value">${summary.earlyLeaveDays}</p></div>
    <div class="stat"><p class="stat-label">Jam kerja</p><p class="stat-value">${summary.totalWorkHours.toFixed(1)}</p></div>
    <div class="stat"><p class="stat-label">Bukti foto</p><p class="stat-value">${summary.photoCount}</p></div>
  </div>

  ${summary.manualCorrections > 0
    ? `<p class="reason">${summary.manualCorrections} hari diselesaikan lewat koreksi administratif — jam check-out-nya bukan rekaman perangkat.</p>`
    : ''}

  <h2>Rekapitulasi Harian</h2>
  <table>
    <thead>
      <tr>
        <th>Tanggal</th><th>Hari</th><th>Status</th>
        <th class="num">Masuk</th><th class="num">Pulang</th><th class="num">Jam</th>
        <th>Lokasi Masuk</th><th>Lokasi Pulang</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>

  <h2>Rincian Bukti per Hari</h2>
  ${dayBlocks || '<p class="muted">Tidak ada catatan kehadiran pada periode ini.</p>'}

  <div class="footer">
    <span>${escapeHtml(PROJECT.shortName)} · ${escapeHtml(contract.label)}</span>
    <span>Disusun ${escapeHtml(stamp)} WIB</span>
  </div>
</div>
</body>
</html>`;
};

/** Rekap harian dalam CSV; dipakai untuk analisis lanjutan di spreadsheet. */
export const buildEvidenceCsv = (dossier) => {
  const header = [
    'Tanggal', 'Hari', 'Status', 'Check In (WIB)', 'Check Out (WIB)', 'Jam Kerja',
    'Lokasi Check In', 'Kategori Check In', 'Koordinat Check In',
    'Akurasi Check In (m)', 'Jarak Check In (m)',
    'Lokasi Check Out', 'Koordinat Check Out',
    'Akurasi Check Out (m)', 'Jarak Check Out (m)',
    'Lintas Hari', 'Pulang Awal', 'Alasan Pulang Awal',
    'Jaminan', 'Koreksi Administratif',
    'SHA-256 Foto Check In', 'SHA-256 Foto Check Out', 'ID Record',
  ];

  const rows = dossier.days.map((day) => [
    day.date,
    day.weekdayName,
    day.statusLabel,
    day.checkIn?.timeLabel ?? '',
    day.checkOut?.timeLabel ?? '',
    day.hasRecord ? day.workHours.toFixed(2) : '',
    day.checkIn?.locationName ?? '',
    day.checkIn?.locationCategoryLabel ?? '',
    day.checkIn?.coordinatesLabel ?? '',
    day.checkIn?.accuracyMeters ?? '',
    day.checkIn?.distanceMeters ?? '',
    day.checkOut?.locationName ?? '',
    day.checkOut?.coordinatesLabel ?? '',
    day.checkOut?.accuracyMeters ?? '',
    day.checkOut?.distanceMeters ?? '',
    day.isCrossDay ? 'Ya' : '',
    day.earlyLeave.isEarlyLeave ? 'Ya' : '',
    day.earlyLeave.reason ?? '',
    day.hasRecord ? day.assuranceLabel : '',
    day.manualCorrection ? 'Ya' : '',
    day.checkIn?.photoSha256 ?? '',
    day.checkOut?.photoSha256 ?? '',
    day.recordId ?? '',
  ]);

  // BOM supaya Excel membaca UTF-8 dengan benar.
  return `\ufeff${[header, ...rows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\r\n')}\r\n`;
};

/**
 * Manifes verifikasi: identitas berkas, cakupan tanggal, dan sidik SHA-256
 * tiap foto menurut catatan server, berikut jalur objek penyimpanannya.
 */
export const buildEvidenceManifest = ({
  dossier,
  contract,
  includedPhotos = [],
  generatedAt = new Date(),
}) => {
  const includedByKey = new Set(
    includedPhotos.map((photo) => `${photo.date}__${photo.action}`)
  );

  const photos = [];
  dossier.days.filter((day) => day.hasRecord).forEach((day) => {
    [day.checkIn, day.checkOut].filter(Boolean).forEach((side) => {
      if (!side.hasPhoto) return;
      const key = `${day.date}__${side.action}`;
      photos.push({
        tanggal: day.date,
        aksi: side.action,
        berkas: includedByKey.has(key) ? `foto/${getPhotoFileName(day.date, side.action)}` : null,
        disertakan: includedByKey.has(key),
        sha256Server: side.photoSha256,
        jalurObjek: side.photoPath,
        generasiObjek: side.photoGeneration,
        idRecord: day.recordId,
      });
    });
  });

  return {
    skemaManifes: 1,
    proyek: { nama: PROJECT.fullName, ringkas: PROJECT.shortName, kementerian: PROJECT.ministry },
    kontrak: { label: contract.label, mulai: contract.startDate, durasiHari: contract.durationDays },
    periode: {
      indeks: dossier.period.index,
      label: dossier.period.label,
      mulai: dossier.period.startDate,
      selesai: dossier.period.endDate,
      hariKontrakMulai: dossier.period.contractDayStart,
      hariKontrakSelesai: dossier.period.contractDayEnd,
    },
    pegawai: dossier.employee,
    ringkasan: dossier.summary,
    jumlahHariDalamPeriode: dossier.days.length,
    fotoDisertakan: photos.filter((photo) => photo.disertakan).length,
    foto: photos,
    disusunPada: generatedAt.toISOString(),
    catatan: 'sha256Server adalah sidik yang dicatat server saat absensi diterima. '
      + 'Bandingkan dengan sha256sum berkas foto untuk memastikan isinya tidak berubah.',
  };
};

const buildReadme = ({ dossier, contract, photosIncluded }) => `PAKET BUKTI KEHADIRAN
${PROJECT.fullName}
${PROJECT.ministry} — ${contract.label}

Pegawai : ${dossier.employee.name} (${dossier.employee.position}, ${dossier.employee.department})
Periode : ${dossier.period.label}
Rentang : ${dossier.period.startDate} s/d ${dossier.period.endDate}

ISI PAKET
  index.html        Tampilan berkas bukti. Buka dengan peramban mana pun,
                    tidak perlu aplikasi atau koneksi internet. Untuk menjadikan
                    PDF: buka, lalu cetak (Ctrl+P) dan pilih "Save as PDF".
  rekap-harian.csv  Rekapitulasi harian untuk diolah di Excel/LibreOffice.
  manifes.json      Metadata paket dan sidik SHA-256 tiap foto menurut catatan
                    server, berikut jalur objek penyimpanannya.
${photosIncluded
    ? '  foto/             Berkas foto bukti check-in dan check-out per tanggal.'
    : '  (foto tidak disertakan pada paket ini — lihat bagian CATATAN)'}

CARA MEMVERIFIKASI FOTO
  Setiap foto memiliki sidik SHA-256 yang dicatat server pada saat absensi
  diterima, tercantum di manifes.json dan rekap-harian.csv. Sidik itu tidak
  dapat diubah dari sisi aplikasi. Untuk memastikan sebuah berkas foto identik
  dengan yang tercatat server, hitung ulang sidiknya:

      sha256sum foto/2026-07-13_check-in.jpg      (Linux/macOS)
      certutil -hashfile foto\\2026-07-13_check-in.jpg SHA256   (Windows)

  lalu bandingkan dengan nilai sha256Server pada manifes.json.

CATATAN
${photosIncluded
    ? '  Foto disertakan sebagai berkas JPEG asli, bukan hasil pemotretan ulang layar.'
    : `  Berkas foto tidak dapat disertakan otomatis karena kebijakan keamanan
  aplikasi membatasi pengambilan berkas dari penyimpanan langsung oleh
  peramban. Foto tetap dapat dilihat satu per satu pada tab Reports aplikasi,
  atau diminta ke pengelola sistem dengan menyebut jalur objek pada
  manifes.json. Sidik SHA-256 pada paket ini tetap sah untuk verifikasi.`}

  Hari tanpa catatan kehadiran tetap dicantumkan pada rekap-harian.csv agar
  rentang tanggalnya utuh dan tidak ada tanggal yang hilang.
`;

/**
 * Susun seluruh isi paket sebagai daftar `{ name, data }` siap dibungkus ZIP.
 * `photos` berisi `{ date, action, bytes }`; boleh kosong bila foto tidak dapat
 * diambil — paket tetap sah dan manifes menandainya sebagai tidak disertakan.
 */
export const buildEvidenceBundleEntries = ({
  dossier,
  contract,
  photos = [],
  generatedAt = new Date(),
}) => {
  const root = getEvidenceBundleName(dossier);
  const usablePhotos = photos.filter((photo) => photo?.bytes?.length > 0);
  const photosIncluded = usablePhotos.length > 0;

  const photoSrc = photosIncluded
    ? (dateKey, action) => (
      usablePhotos.some((photo) => photo.date === dateKey && photo.action === action)
        ? `foto/${getPhotoFileName(dateKey, action)}`
        : null
    )
    : null;

  const entries = [
    {
      name: `${root}/index.html`,
      data: buildEvidenceDocumentHtml({ dossier, contract, photoSrc, generatedAt }),
    },
    { name: `${root}/rekap-harian.csv`, data: buildEvidenceCsv(dossier) },
    {
      name: `${root}/manifes.json`,
      data: `${JSON.stringify(buildEvidenceManifest({
        dossier,
        contract,
        includedPhotos: usablePhotos,
        generatedAt,
      }), null, 2)}\n`,
    },
    {
      name: `${root}/BACA-DULU.txt`,
      data: buildReadme({ dossier, contract, photosIncluded }),
    },
  ];

  usablePhotos.forEach((photo) => {
    entries.push({
      name: `${root}/foto/${getPhotoFileName(photo.date, photo.action)}`,
      data: photo.bytes,
    });
  });

  return entries;
};
