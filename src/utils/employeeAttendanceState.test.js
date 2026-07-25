import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attendanceShiftDurationMs,
  formatAttendanceShiftDuration,
  resolveEmployeeAttendanceState,
} from './employeeAttendanceState.js';

const USER_ID = 'employee-overnight';
const CHECK_IN_CHALLENGE = '11111111-1111-4111-8111-111111111111';
const MAXIMUM_24_HOUR_SHIFT_MS = attendanceShiftDurationMs(1440);
const timestamp = (millis) => ({ toMillis: () => millis });

const verifiedOpenAttendance = ({
  id,
  date,
  checkInMillis,
  ...overrides
}) => ({
  id,
  userId: USER_ID,
  date,
  integrityVersion: 2,
  proofVersion: 2,
  verificationStatus: 'verified',
  transitionMode: false,
  isWithinRadius: true,
  checkIn: timestamp(checkInMillis),
  checkOut: null,
  challengeIds: {
    checkIn: CHECK_IN_CHALLENGE,
  },
  checkInPhotoPath:
    `attendanceProofs/${USER_ID}/${CHECK_IN_CHALLENGE}`,
  checkInPhotoGeneration: '1001',
  checkInPhotoHash: 'a'.repeat(64),
  checkInPhotoPerceptualHash: 'c'.repeat(36),
  presenceProof: {
    required: true,
    verified: true,
    counter: 100,
    issuedBy: 'admin-1',
    grantId: CHECK_IN_CHALLENGE,
    coPresence: {
      verified: true,
      distanceMeters: 12,
      uncertaintyAdjustedDistanceMeters: 40,
      maximumMeters: 100,
      verifierAccuracyMeters: 10,
    },
  },
  geofenceSnapshot: {
    verificationAuditId:
      'kelurahan_kel-test_33333333-3333-4333-8333-333333333333',
    verificationReviewedBy: 'Reviewer Lapangan',
    verificationReviewedAt: timestamp(checkInMillis - 1),
    verificationOperator: '1'.repeat(64),
    verificationReviewOperator: '2'.repeat(64),
  },
  ...overrides,
});

const locationPhotoOpenAttendance = (input) => {
  const record = verifiedOpenAttendance(input);
  const checkInMillis = record.checkIn.toMillis();
  return {
    ...record,
    verificationMode: 'location_photo',
    verificationStatus: 'location_photo_only',
    transitionMode: true,
    isWithinRadius: null,
    deviceVerified: false,
    distanceFromGeofence: null,
    checkInLocation: {
      lat: -0.86,
      lng: 100.33,
      accuracy: 12,
      capturedAt: checkInMillis,
      source: 'gps-high',
      serverReceivedAt: timestamp(checkInMillis),
    },
    assignmentSnapshot: {
      collection: 'kantor',
      id: 'kantor-padang-kota',
      name: 'Kantor Proyek',
    },
    presenceProof: {
      required: false,
      verified: false,
      reason: 'policy_location_photo',
    },
    geofenceSnapshot: null,
  };
};

test('selects a verified previous-WIB-day shift after midnight', () => {
  const now = new Date('2026-07-24T00:30:00+07:00');
  const previousShift = verifiedOpenAttendance({
    id: `${USER_ID}_2026-07-23`,
    date: '2026-07-23',
    checkInMillis: Date.parse('2026-07-23T23:30:00+07:00'),
  });
  const unverifiedToday = {
    ...verifiedOpenAttendance({
      id: `${USER_ID}_2026-07-24`,
      date: '2026-07-24',
      checkInMillis: Date.parse('2026-07-24T00:10:00+07:00'),
    }),
    verificationStatus: 'legacy',
  };

  const state = resolveEmployeeAttendanceState(
    [unverifiedToday, previousShift],
    now,
    USER_ID,
    MAXIMUM_24_HOUR_SHIFT_MS
  );

  assert.equal(state.todayAttendance.id, unverifiedToday.id);
  assert.equal(state.activeAttendance.id, previousShift.id);
  assert.equal(state.expiredOpenAttendance, null);
});

test('does not treat unverified legacy data as an active shift', () => {
  const now = new Date('2026-07-24T00:30:00+07:00');
  const legacyShift = {
    ...verifiedOpenAttendance({
      id: `${USER_ID}_2026-07-23`,
      date: '2026-07-23',
      checkInMillis: Date.parse('2026-07-23T23:30:00+07:00'),
    }),
    proofVersion: 1,
  };

  const state = resolveEmployeeAttendanceState(
    [legacyShift],
    now,
    USER_ID,
    MAXIMUM_24_HOUR_SHIFT_MS
  );

  assert.equal(state.activeAttendance, null);
  assert.equal(state.expiredOpenAttendance, null);
});

test('keeps the exact 24-hour boundary active and expires one millisecond later', () => {
  const now = new Date('2026-07-24T12:00:00+07:00');
  const exactBoundary = verifiedOpenAttendance({
    id: `${USER_ID}_2026-07-23`,
    date: '2026-07-23',
    checkInMillis: now.getTime() - MAXIMUM_24_HOUR_SHIFT_MS,
  });
  const activeState = resolveEmployeeAttendanceState(
    [exactBoundary],
    now,
    USER_ID,
    MAXIMUM_24_HOUR_SHIFT_MS
  );

  assert.equal(activeState.activeAttendance.id, exactBoundary.id);

  const expired = {
    ...exactBoundary,
    checkIn: timestamp(
      now.getTime() - MAXIMUM_24_HOUR_SHIFT_MS - 1
    ),
  };
  const expiredState = resolveEmployeeAttendanceState(
    [expired],
    now,
    USER_ID,
    MAXIMUM_24_HOUR_SHIFT_MS
  );

  assert.equal(expiredState.activeAttendance, null);
  assert.equal(expiredState.expiredOpenAttendance.id, expired.id);
});

test('uses the configured shift duration instead of a hardcoded 24 hours', () => {
  const now = new Date('2026-07-24T00:30:00+07:00');
  const maximumAgeMs = attendanceShiftDurationMs(60);
  const exactBoundary = verifiedOpenAttendance({
    id: `${USER_ID}_2026-07-23`,
    date: '2026-07-23',
    checkInMillis: now.getTime() - maximumAgeMs,
  });

  const activeState = resolveEmployeeAttendanceState(
    [exactBoundary],
    now,
    USER_ID,
    maximumAgeMs
  );
  assert.equal(activeState.activeAttendance.id, exactBoundary.id);

  const expired = {
    ...exactBoundary,
    checkIn: timestamp(now.getTime() - maximumAgeMs - 1),
  };
  const expiredState = resolveEmployeeAttendanceState(
    [expired],
    now,
    USER_ID,
    maximumAgeMs
  );
  assert.equal(expiredState.activeAttendance, null);
  assert.equal(expiredState.expiredOpenAttendance.id, expired.id);
  assert.equal(formatAttendanceShiftDuration(60), '1 jam');
  assert.equal(formatAttendanceShiftDuration(90), '90 menit');
  assert.equal(formatAttendanceShiftDuration(59), 'batas durasi shift');
});

test('an approved administrative checkout is never offered as an open shift', () => {
  const now = new Date('2026-07-24T00:30:00+07:00');
  const corrected = verifiedOpenAttendance({
    id: `${USER_ID}_2026-07-23`,
    date: '2026-07-23',
    checkInMillis: Date.parse('2026-07-23T23:30:00+07:00'),
    administrativeCorrection: {
      checkOut: timestamp(Date.parse('2026-07-24T00:15:00+07:00')),
      completionSource: 'dual-approved-manual-missing-checkout-v1',
      deviceVerified: false,
      manualCorrection: true,
      workHours: 0.75,
    },
  });

  const state = resolveEmployeeAttendanceState(
    [corrected],
    now,
    USER_ID,
    MAXIMUM_24_HOUR_SHIFT_MS
  );

  assert.equal(state.activeAttendance, null);
  assert.equal(state.expiredOpenAttendance, null);
});

test('chooses the canonical current-day record deterministically', () => {
  const now = new Date('2026-07-24T10:00:00+07:00');
  const nonCanonical = {
    id: 'legacy-random-id',
    userId: USER_ID,
    date: '2026-07-24',
    checkIn: timestamp(Date.parse('2026-07-24T09:00:00+07:00')),
    checkOut: timestamp(Date.parse('2026-07-24T09:30:00+07:00')),
  };
  const canonical = {
    id: `${USER_ID}_2026-07-24`,
    userId: USER_ID,
    date: '2026-07-24',
    checkIn: timestamp(Date.parse('2026-07-24T08:00:00+07:00')),
    checkOut: timestamp(Date.parse('2026-07-24T08:30:00+07:00')),
  };
  const input = [nonCanonical, canonical];

  const state = resolveEmployeeAttendanceState(
    input,
    now,
    USER_ID,
    MAXIMUM_24_HOUR_SHIFT_MS
  );

  assert.equal(state.todayAttendance.id, canonical.id);
  assert.deepEqual(input, [nonCanonical, canonical]);
});

test('fails closed when the configured shift duration is absent', () => {
  const now = new Date('2026-07-24T00:30:00+07:00');
  const openShift = verifiedOpenAttendance({
    id: `${USER_ID}_2026-07-23`,
    date: '2026-07-23',
    checkInMillis: Date.parse('2026-07-23T23:30:00+07:00'),
  });

  const state = resolveEmployeeAttendanceState(
    [openShift],
    now,
    USER_ID
  );

  assert.equal(state.activeAttendance, null);
  assert.equal(state.expiredOpenAttendance, null);
});

test('offers a recognized location+photo shift for checkout across midnight', () => {
  const now = new Date('2026-07-24T00:30:00+07:00');
  const temporaryShift = locationPhotoOpenAttendance({
    id: `${USER_ID}_2026-07-23`,
    date: '2026-07-23',
    checkInMillis: Date.parse('2026-07-23T23:30:00+07:00'),
  });

  const state = resolveEmployeeAttendanceState(
    [temporaryShift],
    now,
    USER_ID,
    MAXIMUM_24_HOUR_SHIFT_MS
  );

  assert.equal(state.activeAttendance.id, temporaryShift.id);
  assert.equal(state.expiredOpenAttendance, null);
});

test('rejects a lookalike temporary shift without its server GPS marker', () => {
  const now = new Date('2026-07-24T00:30:00+07:00');
  const tampered = {
    ...locationPhotoOpenAttendance({
      id: `${USER_ID}_2026-07-23`,
      date: '2026-07-23',
      checkInMillis: Date.parse('2026-07-23T23:30:00+07:00'),
    }),
    checkInLocation: null,
  };

  const state = resolveEmployeeAttendanceState(
    [tampered],
    now,
    USER_ID,
    MAXIMUM_24_HOUR_SHIFT_MS
  );

  assert.equal(state.activeAttendance, null);
  assert.equal(state.expiredOpenAttendance, null);
});
