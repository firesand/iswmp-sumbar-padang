import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTRACT } from '../config/projectConfig.js';
import { getContractPeriodByIndex } from './contractPeriods.js';
import { createZipArchive } from './zipArchive.js';
import {
  buildEvidenceBundleEntries,
  buildEvidenceCsv,
  buildEvidenceDocumentHtml,
  buildEvidenceManifest,
  getEvidenceBundleName,
  getPhotoFileName,
} from './attendanceEvidenceBundle.js';

const period = getContractPeriodByIndex(1);

const side = (action, extra = {}) => ({
  action,
  recorded: true,
  isEffective: false,
  time: new Date('2026-07-13T00:50:00Z'),
  timeLabel: action === 'checkIn' ? '07.50 WIB' : '17.05 WIB',
  dateTimeLabel: '13 Jul 2026, 07.50 WIB',
  locationName: 'Kantor Proyek ISWMP Padang',
  locationCategory: 'kantor',
  locationCategoryLabel: 'Kantor Proyek',
  coordinates: { lat: -0.9546883, lng: 100.3643174 },
  coordinatesLabel: '-0.954688, 100.364317',
  mapsUrl: 'https://www.google.com/maps?q=-0.9546883%2C100.3643174',
  accuracyMeters: 12,
  distanceMeters: 23,
  hasPhoto: true,
  photoPath: `attendanceProofs/emp-1/${action}`,
  photoSha256: action === 'checkIn' ? 'a'.repeat(64) : 'e'.repeat(64),
  photoGeneration: '1',
  ...extra,
});

const dossier = {
  employee: {
    id: 'emp-1',
    name: 'Beni "Bento" Suwandi',
    email: 'beni@iswmp.test',
    position: 'Surveyor',
    department: 'Teknis',
  },
  period,
  days: [
    {
      date: '2026-07-13',
      weekdayName: 'Senin',
      isWeekend: false,
      isPending: false,
      hasRecord: true,
      status: 'ontime',
      statusLabel: 'Tepat waktu',
      checkIn: side('checkIn'),
      checkOut: side('checkOut'),
      workHours: 9.25,
      isCrossDay: false,
      earlyLeave: { isEarlyLeave: false, reason: '' },
      assuranceLabel: 'Verified v2 (perangkat terverifikasi)',
      manualCorrection: false,
      recordId: 'emp-1_2026-07-13',
      extraRecords: [],
    },
    {
      date: '2026-07-14',
      weekdayName: 'Selasa',
      isWeekend: false,
      isPending: false,
      hasRecord: false,
      status: null,
      statusLabel: 'Tidak ada catatan',
      checkIn: null,
      checkOut: null,
      workHours: 0,
      isCrossDay: false,
      earlyLeave: { isEarlyLeave: false, reason: '' },
      assuranceLabel: '-',
      manualCorrection: false,
      recordId: null,
      extraRecords: [],
    },
  ],
  summary: {
    recordedDays: 1,
    lateDays: 0,
    completeDays: 1,
    openShiftDays: 0,
    earlyLeaveDays: 0,
    crossDayShifts: 0,
    manualCorrections: 0,
    totalWorkHours: 9.25,
    photoCount: 2,
    duplicateRecords: 0,
  },
};

test('bundle and photo names are filesystem safe', () => {
  assert.equal(getPhotoFileName('2026-07-13', 'checkIn'), '2026-07-13_check-in.jpg');
  assert.equal(getPhotoFileName('2026-07-13', 'checkOut'), '2026-07-13_check-out.jpg');
  assert.equal(
    getEvidenceBundleName(dossier),
    'Bukti-Kehadiran_Periode-01_Beni-Bento-Suwandi'
  );
});

test('the document escapes employee-supplied text', () => {
  const hostile = {
    ...dossier,
    employee: { ...dossier.employee, name: '<script>alert(1)</script>' },
  };
  const html = buildEvidenceDocumentHtml({ dossier: hostile, contract: CONTRACT });

  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('the document lists every date, recorded or not', () => {
  const html = buildEvidenceDocumentHtml({ dossier, contract: CONTRACT });
  assert.ok(html.includes('13 Jul 2026'));
  assert.ok(html.includes('14 Jul 2026'));
  assert.ok(html.includes('Tidak ada catatan'));
  assert.ok(html.includes('Kantor Proyek ISWMP Padang'));
  assert.ok(html.includes('a'.repeat(64)), 'sidik SHA-256 tercantum');
});

test('photos appear only when the bundle provides them', () => {
  const without = buildEvidenceDocumentHtml({ dossier, contract: CONTRACT, photoSrc: null });
  assert.ok(!without.includes('<img class="proof"'));
  assert.ok(without.includes('Foto tidak disertakan'));

  const withPhotos = buildEvidenceDocumentHtml({
    dossier,
    contract: CONTRACT,
    photoSrc: (dateKey, action) => `foto/${getPhotoFileName(dateKey, action)}`,
  });
  assert.ok(withPhotos.includes('src="foto/2026-07-13_check-in.jpg"'));
  assert.ok(withPhotos.includes('src="foto/2026-07-13_check-out.jpg"'));
});

test('the csv keeps every date and neutralises spreadsheet formulas', () => {
  const injected = {
    ...dossier,
    days: [{
      ...dossier.days[0],
      checkIn: side('checkIn', { locationName: '=cmd|calc' }),
    }, dossier.days[1]],
  };
  const csv = buildEvidenceCsv(injected);
  const lines = csv.trim().split('\r\n');

  assert.equal(lines.length, 3, 'header + dua tanggal');
  assert.ok(lines[0].includes('SHA-256 Foto Check In'));
  assert.ok(csv.startsWith('﻿'), 'BOM UTF-8 untuk Excel');
  assert.ok(!lines[1].includes('"=cmd'), 'rumus dinetralkan');
  assert.ok(lines[2].includes('2026-07-14'));
});

test('the manifest records server hashes and what was actually included', () => {
  const manifest = buildEvidenceManifest({
    dossier,
    contract: CONTRACT,
    includedPhotos: [{ date: '2026-07-13', action: 'checkIn' }],
  });

  assert.equal(manifest.foto.length, 2);
  assert.equal(manifest.fotoDisertakan, 1);

  const included = manifest.foto.find((photo) => photo.aksi === 'checkIn');
  assert.equal(included.disertakan, true);
  assert.equal(included.berkas, 'foto/2026-07-13_check-in.jpg');
  assert.equal(included.sha256Server, 'a'.repeat(64));
  assert.equal(included.jalurObjek, 'attendanceProofs/emp-1/checkIn');

  const excluded = manifest.foto.find((photo) => photo.aksi === 'checkOut');
  assert.equal(excluded.disertakan, false);
  assert.equal(excluded.berkas, null);
  assert.equal(excluded.sha256Server, 'e'.repeat(64), 'sidik tetap dapat diverifikasi');

  assert.equal(manifest.periode.indeks, 1);
  assert.equal(manifest.kontrak.durasiHari, CONTRACT.durationDays);
});

test('a bundle without photos is still complete and zips cleanly', () => {
  const entries = buildEvidenceBundleEntries({ dossier, contract: CONTRACT, photos: [] });
  const names = entries.map((entry) => entry.name);
  const root = getEvidenceBundleName(dossier);

  assert.deepEqual(names, [
    `${root}/index.html`,
    `${root}/rekap-harian.csv`,
    `${root}/manifes.json`,
    `${root}/BACA-DULU.txt`,
  ]);

  const readme = entries.find((entry) => entry.name.endsWith('BACA-DULU.txt')).data;
  assert.ok(readme.includes('foto tidak disertakan'));
  assert.ok(readme.includes('sha256sum'));

  assert.doesNotThrow(() => createZipArchive(entries));
});

test('a bundle with photos carries the jpeg entries and marks them included', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const entries = buildEvidenceBundleEntries({
    dossier,
    contract: CONTRACT,
    photos: [
      { date: '2026-07-13', action: 'checkIn', bytes },
      { date: '2026-07-13', action: 'checkOut', bytes },
      { date: '2026-07-13', action: 'checkOut', bytes: new Uint8Array(0) },
    ],
  });
  const root = getEvidenceBundleName(dossier);
  const names = entries.map((entry) => entry.name);

  assert.ok(names.includes(`${root}/foto/2026-07-13_check-in.jpg`));
  assert.ok(names.includes(`${root}/foto/2026-07-13_check-out.jpg`));
  assert.equal(new Set(names).size, names.length, 'foto kosong tidak membuat entri ganda');

  const manifest = JSON.parse(
    entries.find((entry) => entry.name.endsWith('manifes.json')).data
  );
  assert.equal(manifest.fotoDisertakan, 2);

  const zip = createZipArchive(entries);
  assert.ok(zip.length > 0);
});
