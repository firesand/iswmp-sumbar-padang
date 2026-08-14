import assert from 'node:assert/strict';
import test from 'node:test';

import { getContractPeriodByIndex } from './contractPeriods.js';
import {
  buildEmployeeDossier,
  getCoordinates,
  getGoogleMapsUrl,
  getWeekdayNameId,
} from './attendanceDossier.js';

const timestamp = (millis) => ({
  toMillis: () => millis,
  toDate: () => new Date(millis),
});

const cid = (seed) => `${String(seed).padStart(8, '0')}-1111-4111-8111-111111111111`;

const employee = {
  id: 'emp-1',
  name: 'Andi Saputra',
  email: 'andi@iswmp.test',
  position: 'Fasilitator Lapangan',
  department: 'Teknis',
};

const period = getContractPeriodByIndex(1);

/** Record Verified v2 lengkap; proof-nya harus utuh agar foto dianggap layak tinjau. */
const verifiedRecord = ({
  date,
  checkInIso,
  checkOutIso = null,
  status = 'ontime',
  seed = 1,
  userId = 'emp-1',
}) => {
  const inId = cid(seed);
  const outId = cid(seed + 100);
  const checkInMs = Date.parse(checkInIso);
  const checkOutMs = checkOutIso ? Date.parse(checkOutIso) : null;
  const workHours = checkOutMs === null
    ? 0
    : Math.round(((checkOutMs - checkInMs) / 3_600_000) * 100) / 100;

  const presence = (grantId) => ({
    required: true,
    verified: true,
    counter: 100,
    issuedBy: 'admin-1',
    grantId,
    coPresence: {
      verified: true,
      distanceMeters: 10,
      uncertaintyAdjustedDistanceMeters: 30,
      maximumMeters: 100,
      verifierAccuracyMeters: 8,
    },
  });
  const geofence = (reviewedAtMs) => ({
    verificationAuditId: 'kelurahan_test_33333333-3333-4333-8333-333333333333',
    verificationReviewedBy: 'Reviewer Lapangan',
    verificationReviewedAt: timestamp(reviewedAtMs),
    verificationOperator: 'c'.repeat(64),
    verificationReviewOperator: 'd'.repeat(64),
  });

  return {
    id: `${userId}_${date}`,
    userId,
    date,
    status,
    integrityVersion: 2,
    proofVersion: 2,
    verificationStatus: 'verified',
    transitionMode: false,
    isWithinRadius: true,
    checkIn: timestamp(checkInMs),
    checkOut: checkOutMs === null ? null : timestamp(checkOutMs),
    workHours,
    earlyLeave: false,
    earlyLeaveReason: null,
    challengeIds: { checkIn: inId, checkOut: checkOutMs === null ? null : outId },
    checkInPhotoPath: `attendanceProofs/${userId}/${inId}`,
    checkInPhotoGeneration: '1',
    checkInPhotoHash: 'a'.repeat(64),
    checkInPhotoPerceptualHash: 'b'.repeat(36),
    checkOutPhotoPath: checkOutMs === null ? null : `attendanceProofs/${userId}/${outId}`,
    checkOutPhotoGeneration: checkOutMs === null ? null : '2',
    checkOutPhotoHash: checkOutMs === null ? null : 'e'.repeat(64),
    checkOutPhotoPerceptualHash: checkOutMs === null ? null : 'f'.repeat(36),
    presenceProof: presence(inId),
    checkOutPresenceProof: checkOutMs === null ? null : presence(outId),
    geofenceSnapshot: geofence(checkInMs - 1),
    checkOutGeofenceSnapshot: checkOutMs === null ? null : geofence(checkOutMs - 1),
    checkInLocation: { lat: -0.9546883, lng: 100.3643174, accuracy: 12.4 },
    checkOutLocation: checkOutMs === null
      ? null
      : { lat: -0.9550000, lng: 100.3650000, accuracy: 8.2 },
    operationalLocationSnapshot: {
      id: 'kantor:kantor-iswmp',
      name: 'Kantor Proyek ISWMP Padang',
      collection: 'kantor',
      source: 'assignment',
      distanceMeters: 23,
    },
    checkOutOperationalLocationSnapshot: checkOutMs === null
      ? null
      : {
        id: 'kantor:kantor-iswmp',
        name: 'Kantor Proyek ISWMP Padang',
        collection: 'kantor',
        source: 'assignment',
        distanceMeters: 41,
      },
    distanceFromGeofence: 23,
    locationAccuracy: 12.4,
  };
};

test('weekday names come from the calendar date, not the host timezone', () => {
  assert.equal(getWeekdayNameId('2026-07-13'), 'Senin');
  assert.equal(getWeekdayNameId('2026-07-18'), 'Sabtu');
  assert.equal(getWeekdayNameId('2026-07-19'), 'Minggu');
  assert.equal(getWeekdayNameId(null), '-');
});

test('coordinates are validated before a maps link is offered', () => {
  assert.deepEqual(getCoordinates({ lat: -0.95, lng: 100.36 }), { lat: -0.95, lng: 100.36 });
  assert.equal(getCoordinates({ lat: 0, lng: 0 }), null);
  assert.equal(getCoordinates({ lat: 'x', lng: 100 }), null);
  assert.equal(getCoordinates(null), null);
  assert.match(getGoogleMapsUrl({ lat: -0.95, lng: 100.36 }), /^https:\/\/www\.google\.com\/maps\?q=/);
  assert.equal(getGoogleMapsUrl({ lat: 0, lng: 0 }), null);
});

test('the dossier covers every date in the period, including empty days', () => {
  const dossier = buildEmployeeDossier({
    employee,
    attendances: [
      verifiedRecord({
        date: '2026-07-13',
        checkInIso: '2026-07-13T00:50:00Z',
        checkOutIso: '2026-07-13T10:05:00Z',
      }),
    ],
    period,
    cutoffDateKey: '2026-07-20',
  });

  assert.equal(dossier.days.length, period.totalDays);
  assert.equal(dossier.days[0].date, '2026-07-13');
  assert.equal(dossier.days[dossier.days.length - 1].date, '2026-08-12');

  const empty = dossier.days.find((day) => day.date === '2026-07-14');
  assert.equal(empty.hasRecord, false);
  assert.equal(empty.statusLabel, 'Tidak ada catatan');
  assert.equal(empty.checkIn, null);

  const weekend = dossier.days.find((day) => day.date === '2026-07-18');
  assert.equal(weekend.isWeekend, true);
  assert.equal(weekend.statusLabel, 'Akhir pekan');

  const pending = dossier.days.find((day) => day.date === '2026-07-27');
  assert.equal(pending.isPending, true);
  assert.equal(pending.statusLabel, 'Belum berjalan');
});

test('a complete day carries both sides with location and photo availability', () => {
  const dossier = buildEmployeeDossier({
    employee,
    attendances: [
      verifiedRecord({
        date: '2026-07-13',
        checkInIso: '2026-07-13T00:50:00Z', // 07:50 WIB
        checkOutIso: '2026-07-13T10:05:00Z', // 17:05 WIB
      }),
    ],
    period,
    cutoffDateKey: '2026-08-12',
  });
  const day = dossier.days.find((entry) => entry.date === '2026-07-13');

  assert.equal(day.hasRecord, true);
  assert.equal(day.statusLabel, 'Tepat waktu');
  assert.equal(day.checkIn.timeLabel, '07.50 WIB');
  assert.equal(day.checkIn.locationName, 'Kantor Proyek ISWMP Padang');
  assert.equal(day.checkIn.locationCategoryLabel, 'Kantor Proyek');
  assert.equal(day.checkIn.coordinatesLabel, '-0.954688, 100.364317');
  assert.equal(day.checkIn.accuracyMeters, 12);
  assert.equal(day.checkIn.distanceMeters, 23);
  assert.equal(day.checkIn.hasPhoto, true);
  assert.match(day.checkIn.mapsUrl, /maps\?q=-0\.9546883%2C100\.3643174/);

  assert.equal(day.checkOut.timeLabel, '17.05 WIB');
  assert.equal(day.checkOut.distanceMeters, 41);
  assert.equal(day.checkOut.accuracyMeters, 8);
  assert.equal(day.checkOut.hasPhoto, true);
  assert.equal(day.checkOut.isEffective, false);

  assert.equal(day.workHours, 9.25);
  assert.equal(day.assuranceLabel, 'Verified v2 (perangkat terverifikasi)');
});

test('an open shift exposes check-in only and is counted as open', () => {
  const dossier = buildEmployeeDossier({
    employee,
    attendances: [
      verifiedRecord({
        date: '2026-07-14',
        checkInIso: '2026-07-14T01:40:00Z',
        status: 'late',
        seed: 2,
      }),
    ],
    period,
    cutoffDateKey: '2026-08-12',
  });
  const day = dossier.days.find((entry) => entry.date === '2026-07-14');

  assert.equal(day.checkOut, null);
  assert.equal(day.statusLabel, 'Terlambat');
  assert.equal(day.workHours, 0);
  assert.equal(dossier.summary.openShiftDays, 1);
  assert.equal(dossier.summary.completeDays, 0);
  assert.equal(dossier.summary.lateDays, 1);
  assert.equal(dossier.summary.photoCount, 1);
});

test('records belonging to other employees never leak into a dossier', () => {
  const dossier = buildEmployeeDossier({
    employee,
    attendances: [
      verifiedRecord({
        date: '2026-07-13',
        checkInIso: '2026-07-13T00:50:00Z',
        userId: 'emp-2',
        seed: 3,
      }),
    ],
    period,
    cutoffDateKey: '2026-08-12',
  });

  assert.equal(dossier.summary.recordedDays, 0);
  assert.equal(dossier.days.find((day) => day.date === '2026-07-13').hasRecord, false);
});

test('duplicate records on one day are surfaced rather than hidden', () => {
  const first = verifiedRecord({ date: '2026-07-13', checkInIso: '2026-07-13T00:50:00Z', seed: 4 });
  const second = verifiedRecord({ date: '2026-07-13', checkInIso: '2026-07-13T02:50:00Z', seed: 5 });
  second.id = 'emp-1_2026-07-13_dup';

  const dossier = buildEmployeeDossier({
    employee,
    attendances: [first, second],
    period,
    cutoffDateKey: '2026-08-12',
  });
  const day = dossier.days.find((entry) => entry.date === '2026-07-13');

  assert.equal(day.recordId, 'emp-1_2026-07-13');
  assert.equal(day.extraRecords.length, 1);
  assert.equal(dossier.summary.duplicateRecords, 1);
  assert.equal(dossier.summary.recordedDays, 1);
});

test('an unverified record is labelled and offers no reviewable photo', () => {
  const broken = verifiedRecord({
    date: '2026-07-13',
    checkInIso: '2026-07-13T00:50:00Z',
    seed: 6,
  });
  broken.checkInPhotoHash = 'bukan-hash';

  const dossier = buildEmployeeDossier({
    employee,
    attendances: [broken],
    period,
    cutoffDateKey: '2026-08-12',
  });
  const day = dossier.days.find((entry) => entry.date === '2026-07-13');

  assert.equal(day.assuranceLabel, 'Tidak terverifikasi / legacy');
  assert.equal(day.checkIn.hasPhoto, false);
  assert.equal(dossier.summary.photoCount, 0);
});

test('a missing employee or period yields no dossier', () => {
  assert.equal(buildEmployeeDossier({ employee: null, period }), null);
  assert.equal(buildEmployeeDossier({ employee, period: null }), null);
});
