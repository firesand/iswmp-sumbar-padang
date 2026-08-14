import assert from 'node:assert/strict';
import test from 'node:test';

import { getContractPeriodByIndex } from './contractPeriods.js';
import {
  DAY_STATE,
  buildPeriodRecap,
  categorizeAttendanceLocation,
  formatMinutesOfDay,
  getRemunerationBasis,
  getWibMinutesOfDay,
} from './attendanceRecap.js';

const timestamp = (millis) => ({ toMillis: () => millis, toDate: () => new Date(millis) });

const challengeId = (seed) =>
  `${String(seed).repeat(8).slice(0, 8)}-1111-4111-8111-111111111111`;

/**
 * Record Verified v2 yang sah — struktur proof-nya harus utuh, kalau tidak
 * `isAttendanceWorkflowEligible` menolaknya dan rekap tidak menghitungnya.
 */
const verifiedRecord = ({
  userId,
  date,
  checkInIso,
  status = 'ontime',
  seed = 1,
  location = { collection: 'kantor', source: 'assignment', name: 'Kantor Proyek ISWMP' },
  earlyLeave = false,
}) => {
  const id = challengeId(seed);
  const checkInMs = Date.parse(checkInIso);
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
    checkOut: null,
    workHours: 0,
    earlyLeave,
    earlyLeaveReason: earlyLeave ? 'Izin keperluan keluarga mendesak' : null,
    challengeIds: { checkIn: id, checkOut: null },
    checkInPhotoPath: `attendanceProofs/${userId}/${id}`,
    checkInPhotoGeneration: '1',
    checkInPhotoHash: 'a'.repeat(64),
    checkInPhotoPerceptualHash: 'b'.repeat(36),
    presenceProof: {
      required: true,
      verified: true,
      counter: 100,
      issuedBy: 'admin-1',
      grantId: id,
      coPresence: {
        verified: true,
        distanceMeters: 10,
        uncertaintyAdjustedDistanceMeters: 30,
        maximumMeters: 100,
        verifierAccuracyMeters: 8,
      },
    },
    geofenceSnapshot: {
      verificationAuditId: `kelurahan_test_33333333-3333-4333-8333-333333333333`,
      verificationReviewedBy: 'Reviewer Lapangan',
      verificationReviewedAt: timestamp(checkInMs - 1),
      verificationOperator: 'c'.repeat(64),
      verificationReviewOperator: 'd'.repeat(64),
    },
    operationalLocationSnapshot: location,
  };
};

const employees = [
  { id: 'emp-1', name: 'Andi', department: 'Teknis', position: 'Fasilitator' },
  { id: 'emp-2', name: 'Budi', department: 'Teknis', position: 'Surveyor' },
];

const period1 = getContractPeriodByIndex(1);

test('WIB clock helpers convert timestamps to Jakarta wall time', () => {
  // 01:25Z = 08:25 WIB.
  assert.equal(getWibMinutesOfDay(new Date('2026-07-13T01:25:00Z')), 8 * 60 + 25);
  assert.equal(getWibMinutesOfDay(null), null);
  assert.equal(formatMinutesOfDay(8 * 60 + 25), '08:25');
  assert.equal(formatMinutesOfDay(null), '-');
});

test('attendance location falls into contract-relevant categories', () => {
  assert.equal(
    categorizeAttendanceLocation({
      operationalLocationSnapshot: { collection: 'kantor', source: 'assignment' },
    }),
    'kantor'
  );
  assert.equal(
    categorizeAttendanceLocation({
      operationalLocationSnapshot: { collection: 'kelurahan', source: 'assignment' },
    }),
    'kelurahan'
  );
  assert.equal(
    categorizeAttendanceLocation({
      operationalLocationSnapshot: { source: 'temporary', collection: null },
    }),
    'temporary'
  );
  assert.equal(
    categorizeAttendanceLocation({ assignmentSnapshot: { collection: 'kelurahan' } }),
    'kelurahan'
  );
  assert.equal(categorizeAttendanceLocation({}), 'lainnya');
});

test('recap counts presence, lateness and absence across the period', () => {
  const recap = buildPeriodRecap({
    employees,
    attendances: [
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-13',
        checkInIso: '2026-07-13T00:50:00Z', // 07:50 WIB
        seed: 1,
      }),
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-14',
        checkInIso: '2026-07-14T01:40:00Z', // 08:40 WIB
        status: 'late',
        seed: 2,
      }),
    ],
    period: period1,
    todayDateKey: '2026-07-15',
  });

  const andi = recap.employees.find((item) => item.id === 'emp-1');
  const budi = recap.employees.find((item) => item.id === 'emp-2');

  assert.equal(recap.workingDays, 23);
  assert.equal(recap.elapsedWorkingDays, 3); // 13, 14, 15 Juli — Senin s/d Rabu
  assert.equal(recap.isOngoing, true);

  assert.equal(andi.presentDays, 2);
  assert.equal(andi.onTimeDays, 1);
  assert.equal(andi.lateDays, 1);
  assert.equal(andi.absentDays, 1); // 15 Juli sudah lewat tanpa record
  assert.equal(andi.averageCheckInLabel, '08:15');
  assert.equal(Math.round(andi.attendanceRate), 67);
  assert.equal(Math.round(andi.punctualityRate), 50);

  assert.equal(budi.presentDays, 0);
  assert.equal(budi.absentDays, 3);
  assert.equal(budi.attendanceRate, 0);
});

test('days after the cutoff are pending, never counted as absent', () => {
  const recap = buildPeriodRecap({
    employees,
    attendances: [],
    period: period1,
    todayDateKey: '2026-07-15',
  });
  const andi = recap.employees[0];

  assert.equal(andi.dayStates['2026-07-15'], DAY_STATE.ABSENT);
  assert.equal(andi.dayStates['2026-07-16'], DAY_STATE.FUTURE);
  assert.equal(andi.dayStates['2026-07-18'], DAY_STATE.WEEKEND);
  assert.equal(andi.absentDays, 3);
  assert.equal(
    Object.keys(andi.dayStates).length,
    period1.totalDays,
    'setiap tanggal periode punya status'
  );
});

test('days before an employee joined are not counted as absence', () => {
  const recap = buildPeriodRecap({
    employees: [
      employees[0],
      // Bergabung Rabu 22 Juli 2026, di tengah periode pertama.
      { ...employees[1], createdAt: timestamp(Date.parse('2026-07-22T03:00:00Z')) },
    ],
    attendances: [],
    period: period1,
    todayDateKey: '2026-07-24',
  });

  const andi = recap.employees.find((item) => item.id === 'emp-1');
  const budi = recap.employees.find((item) => item.id === 'emp-2');

  assert.equal(andi.elapsedWorkingDays, 10); // 13–17, 20–24 Juli
  assert.equal(andi.absentDays, 10);

  assert.equal(budi.activeFromDateKey, '2026-07-22');
  assert.equal(budi.elapsedWorkingDays, 3); // 22, 23, 24 Juli
  assert.equal(budi.absentDays, 3);
  assert.equal(budi.dayStates['2026-07-21'], DAY_STATE.PRE_ACTIVE);
  assert.equal(budi.dayStates['2026-07-22'], DAY_STATE.ABSENT);

  // Kapasitas proyek menjumlahkan hari kerja tiap pegawai, bukan perkalian.
  assert.equal(recap.totals.manDaysCapacity, 13);
});

test('attendance rate never exceeds 100% when records outrun the clock', () => {
  // Jam perangkat tertinggal: ada record 20 Juli padahal "hari ini" 15 Juli.
  const recap = buildPeriodRecap({
    employees,
    attendances: [
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-20',
        checkInIso: '2026-07-20T00:50:00Z',
        seed: 1,
      }),
    ],
    period: period1,
    todayDateKey: '2026-07-15',
  });

  const andi = recap.employees.find((item) => item.id === 'emp-1');
  assert.equal(recap.cutoffDateKey, '2026-07-20');
  assert.equal(andi.presentDays, 1);
  assert.equal(andi.elapsedWorkingDays, 6); // 13–17, 20 Juli
  assert.ok(andi.attendanceRate <= 100);
  assert.ok(recap.totals.attendanceRate <= 100);
});

test('an employee with records before their account still stays within 100%', () => {
  const recap = buildPeriodRecap({
    employees: [
      // Akun dibuat 27 Juli, tetapi sudah absen sejak 14 Juli.
      { ...employees[0], createdAt: timestamp(Date.parse('2026-07-27T02:00:00Z')) },
    ],
    attendances: [
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-14',
        checkInIso: '2026-07-14T00:50:00Z',
        seed: 1,
      }),
    ],
    period: period1,
    todayDateKey: '2026-07-28',
  });

  const andi = recap.employees[0];
  assert.equal(andi.presentDays, 1);
  assert.ok(andi.elapsedWorkingDays >= andi.presentDays);
  assert.ok(andi.attendanceRate <= 100);
});

test('a finished period counts every working day', () => {
  const recap = buildPeriodRecap({
    employees,
    attendances: [],
    period: period1,
    todayDateKey: '2026-09-01',
  });
  assert.equal(recap.isOngoing, false);
  assert.equal(recap.elapsedWorkingDays, 23);
  assert.equal(recap.employees[0].absentDays, 23);
});

test('weekend attendance is tracked apart from working-day presence', () => {
  const recap = buildPeriodRecap({
    employees,
    attendances: [
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-18', // Sabtu
        checkInIso: '2026-07-18T01:00:00Z',
        seed: 3,
      }),
    ],
    period: period1,
    todayDateKey: '2026-07-20',
  });
  const andi = recap.employees.find((item) => item.id === 'emp-1');

  assert.equal(andi.weekendPresentDays, 1);
  assert.equal(andi.presentDays, 0);
  assert.equal(andi.dayStates['2026-07-18'], DAY_STATE.WEEKEND_PRESENT);
  // 13–17 Juli (Sen–Jum) + 20 Juli (Sen); Sabtu 18 Juli tidak menambah absen.
  assert.equal(andi.absentDays, 6);
  assert.equal(recap.totals.weekendPresentDays, 1);
});

test('duplicate records on one day are counted once', () => {
  const recap = buildPeriodRecap({
    employees,
    attendances: [
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-13',
        checkInIso: '2026-07-13T00:50:00Z',
        seed: 4,
      }),
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-13',
        checkInIso: '2026-07-13T02:50:00Z',
        status: 'late',
        seed: 5,
      }),
    ],
    period: period1,
    todayDateKey: '2026-07-13',
  });
  const andi = recap.employees.find((item) => item.id === 'emp-1');

  assert.equal(andi.presentDays, 1);
  assert.equal(andi.lateDays, 0);
  assert.equal(andi.records.length, 2, 'record kedua tetap tersimpan untuk detail');
});

test('location tally drives the monitoring breakdown', () => {
  const recap = buildPeriodRecap({
    employees,
    attendances: [
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-13',
        checkInIso: '2026-07-13T00:50:00Z',
        seed: 6,
        location: { collection: 'kantor', source: 'assignment', name: 'Kantor Proyek' },
      }),
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-14',
        checkInIso: '2026-07-14T00:50:00Z',
        seed: 7,
        location: { collection: 'kelurahan', source: 'assignment', name: 'Kelurahan Air Tawar' },
      }),
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-15',
        checkInIso: '2026-07-15T00:50:00Z',
        seed: 8,
        location: { collection: 'kelurahan', source: 'assignment', name: 'Kelurahan Air Tawar' },
      }),
    ],
    period: period1,
    todayDateKey: '2026-07-15',
  });
  const andi = recap.employees.find((item) => item.id === 'emp-1');

  assert.equal(andi.locationTally.kantor, 1);
  assert.equal(andi.locationTally.kelurahan, 2);
  assert.equal(andi.dominantLocation.key, 'kelurahan');
  assert.equal(andi.dominantLocation.days, 2);
  assert.deepEqual(andi.topLocationNames[0], { name: 'Kelurahan Air Tawar', days: 2 });
  assert.equal(recap.locationTotals.kelurahan, 2);
  assert.equal(recap.locationTotals.temporary, 0);
});

test('records failing integrity are excluded and reported, not silently dropped', () => {
  const broken = verifiedRecord({
    userId: 'emp-1',
    date: '2026-07-13',
    checkInIso: '2026-07-13T00:50:00Z',
    seed: 9,
  });
  broken.checkInPhotoHash = 'not-a-hash';

  const recap = buildPeriodRecap({
    employees,
    attendances: [broken],
    period: period1,
    todayDateKey: '2026-07-13',
  });

  assert.equal(recap.employees.find((item) => item.id === 'emp-1').presentDays, 0);
  assert.equal(recap.integrity.ineligibleRecords, 1);
  assert.equal(recap.integrity.eligibleRecords, 0);
  assert.equal(recap.integrity.totalRecords, 1);
});

test('records for unknown employees are reported separately', () => {
  const recap = buildPeriodRecap({
    employees,
    attendances: [
      verifiedRecord({
        userId: 'emp-nonaktif',
        date: '2026-07-13',
        checkInIso: '2026-07-13T00:50:00Z',
        seed: 1,
      }),
    ],
    period: period1,
    todayDateKey: '2026-07-13',
  });
  assert.equal(recap.integrity.unmatchedRecords, 1);
  assert.equal(recap.totals.presentDays, 0);
});

test('project totals aggregate the man-day capacity of the period', () => {
  const recap = buildPeriodRecap({
    employees,
    attendances: [
      verifiedRecord({
        userId: 'emp-1',
        date: '2026-07-13',
        checkInIso: '2026-07-13T00:50:00Z',
        seed: 1,
      }),
      verifiedRecord({
        userId: 'emp-2',
        date: '2026-07-13',
        checkInIso: '2026-07-13T01:40:00Z',
        status: 'late',
        seed: 2,
      }),
    ],
    period: period1,
    todayDateKey: '2026-07-13',
  });

  assert.equal(recap.totals.employees, 2);
  assert.equal(recap.totals.manDaysCapacity, 2);
  assert.equal(recap.totals.presentDays, 2);
  assert.equal(recap.totals.lateDays, 1);
  assert.equal(recap.totals.attendanceRate, 100);
  assert.equal(recap.totals.punctualityRate, 50);
  assert.equal(recap.dailyTrend[0].present, 2);
  assert.equal(recap.dailyTrend[0].late, 1);
});

test('remuneration basis exposes the raw figures, never a computed amount', () => {
  const basis = getRemunerationBasis({
    presentDays: 20,
    workingDays: 23,
    elapsedWorkingDays: 23,
    absentDays: 3,
    weekendPresentDays: 1,
    totalWorkHours: 160,
  });

  assert.equal(basis.presentDays, 20);
  assert.equal(basis.workingDays, 23);
  assert.equal(basis.totalWorkHours, 160);
  assert.equal(Number(basis.attendanceRatio.toFixed(4)), 0.8696);
  assert.equal(getRemunerationBasis(null), null);
});

test('a missing period yields no recap instead of throwing', () => {
  assert.equal(buildPeriodRecap({ employees, attendances: [], period: null }), null);
});
