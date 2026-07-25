import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADMINISTRATIVE_COMPLETION_SOURCE,
  attachEffectiveAttendanceCorrection,
  resolveAttendanceCompletion,
} from './attendanceCorrection.js';
import {
  classifyAttendanceCheckout,
  isCrossDayAttendance,
} from './attendanceDisplay.js';
import {
  isCompletedVerifiedAttendance,
} from './attendanceIntegrity.js';

const uid = 'employee-corrected';
const attendanceId = `${uid}_2026-07-23`;
const checkInMs = Date.parse('2026-07-23T16:30:00.000Z');
const checkOutMs = Date.parse('2026-07-23T18:00:00.000Z');
const timestamp = (millis) => ({toMillis: () => millis});

const attendance = {
  id: attendanceId,
  userId: uid,
  date: '2026-07-23',
  integrityVersion: 2,
  proofVersion: 2,
  verificationStatus: 'verified',
  transitionMode: false,
  isWithinRadius: true,
  checkIn: timestamp(checkInMs),
  checkOut: null,
  challengeIds: {
    checkIn: '11111111-1111-4111-8111-111111111111',
    checkOut: null,
  },
  checkInPhotoPath:
    `attendanceProofs/${uid}/11111111-1111-4111-8111-111111111111`,
  checkInPhotoGeneration: '1',
  checkInPhotoHash: 'a'.repeat(64),
  checkInPhotoPerceptualHash: 'b'.repeat(36),
  presenceProof: {
    required: true,
    verified: true,
    counter: 100,
    issuedBy: 'admin-1',
    grantId: '11111111-1111-4111-8111-111111111111',
    coPresence: {
      verified: true,
      distanceMeters: 10,
      uncertaintyAdjustedDistanceMeters: 30,
      maximumMeters: 100,
      verifierAccuracyMeters: 8,
    },
  },
  geofenceSnapshot: {
    verificationAuditId:
      'kelurahan_test_33333333-3333-4333-8333-333333333333',
    verificationReviewedBy: 'Reviewer Lapangan',
    verificationReviewedAt: timestamp(checkInMs - 1),
    verificationOperator: 'c'.repeat(64),
    verificationReviewOperator: 'd'.repeat(64),
  },
  workHours: 0,
};

const projection = {
  schemaVersion: 1,
  attendanceId,
  userId: uid,
  workDate: '2026-07-23',
  correctionType: 'missing_checkout',
  revision: 1,
  baseShiftRevision: 2,
  proposalId: '22222222-2222-4222-8222-222222222222',
  correctionEventId: '22222222-2222-4222-8222-222222222222',
  originalCheckIn: timestamp(checkInMs),
  effectiveCheckOut: timestamp(checkOutMs),
  effectiveWorkHours: 1.5,
  completionSource: ADMINISTRATIVE_COMPLETION_SOURCE,
  manualCorrection: true,
  deviceVerified: false,
  canonicalAttendanceChanged: false,
  approvedAt: timestamp(checkOutMs + 60_000),
};

test('valid sidecar completes reporting without mutating canonical proof', () => {
  const resolved = attachEffectiveAttendanceCorrection(
    attendance,
    projection
  );
  const completion = resolveAttendanceCompletion(resolved);

  assert.equal(attendance.checkOut, null);
  assert.equal(resolved.administrativeCorrection.manualCorrection, true);
  assert.equal(completion.isComplete, true);
  assert.equal(completion.deviceVerified, false);
  assert.equal(completion.manualCorrection, true);
  assert.equal(
    completion.completionSource,
    ADMINISTRATIVE_COMPLETION_SOURCE
  );
  assert.equal(completion.workHours, 1.5);
  assert.equal(isCompletedVerifiedAttendance(resolved), false);
});

test('manual overnight completion stays separate from canonical metrics', () => {
  const resolved = attachEffectiveAttendanceCorrection(
    attendance,
    projection
  );
  const completion = resolveAttendanceCompletion(resolved);
  const effectiveRecord = {
    ...resolved,
    checkOut: completion.checkOut,
    workHours: completion.workHours,
  };

  assert.equal(resolved.checkOut, null);
  assert.equal(isCrossDayAttendance(effectiveRecord), true);
  assert.deepEqual(classifyAttendanceCheckout(effectiveRecord), {
    crossDay: true,
    earlyLeave: false,
    overtime: false,
  });
});

test('tampered sidecar fails closed and leaves the shift open', () => {
  const resolved = attachEffectiveAttendanceCorrection(
    attendance,
    {...projection, deviceVerified: true}
  );
  const completion = resolveAttendanceCompletion(resolved);

  assert.equal(resolved.administrativeCorrection, null);
  assert.equal(resolved.correctionProjectionInvalid, true);
  assert.equal(completion.isComplete, false);
});

test('completed location+photo shift is reported separately from Verified v2', () => {
  const locationPhoto = {
    ...attendance,
    verificationMode: 'location_photo',
    checkOutVerificationMode: 'location_photo',
    checkOutVerificationStatus: 'location_photo_only',
    checkOutTransitionMode: true,
    checkOutIsWithinRadius: null,
    checkOutDeviceVerified: false,
    verificationStatus: 'location_photo_only',
    transitionMode: true,
    isWithinRadius: null,
    deviceVerified: false,
    distanceFromGeofence: null,
    checkOutDistanceFromGeofence: null,
    checkOut: timestamp(checkOutMs),
    challengeIds: {
      checkIn: '11111111-1111-4111-8111-111111111111',
      checkOut: '33333333-3333-4333-8333-333333333333',
    },
    checkOutPhotoPath:
      `attendanceProofs/${uid}/33333333-3333-4333-8333-333333333333`,
    checkOutPhotoGeneration: '2',
    checkOutPhotoHash: 'e'.repeat(64),
    checkOutPhotoPerceptualHash: 'f'.repeat(36),
    checkInLocation: {
      lat: -0.86,
      lng: 100.33,
      accuracy: 10,
      capturedAt: checkInMs,
      source: 'gps-high',
      serverReceivedAt: timestamp(checkInMs),
    },
    checkOutLocation: {
      lat: -0.861,
      lng: 100.331,
      accuracy: 12,
      capturedAt: checkOutMs,
      source: 'gps-high',
      serverReceivedAt: timestamp(checkOutMs),
    },
    assignmentSnapshot: {
      collection: 'kantor',
      id: 'kantor-padang-kota',
      name: 'Kantor Proyek',
    },
    checkOutAssignmentSnapshot: {
      collection: 'kantor',
      id: 'kantor-padang-kota',
      name: 'Kantor Proyek',
    },
    presenceProof: {
      required: false,
      verified: false,
      reason: 'policy_location_photo',
    },
    checkOutPresenceProof: {
      required: false,
      verified: false,
      reason: 'policy_location_photo',
    },
    geofenceSnapshot: null,
    checkOutGeofenceSnapshot: null,
    workHours: 1.5,
  };

  const completion = resolveAttendanceCompletion(locationPhoto);

  assert.equal(completion.isComplete, true);
  assert.equal(completion.completionSource, 'location-photo');
  assert.equal(completion.deviceRecorded, true);
  assert.equal(completion.deviceVerified, false);
  assert.equal(completion.locationPhotoOnly, true);
  assert.equal(completion.manualCorrection, false);
  assert.equal(isCompletedVerifiedAttendance(locationPhoto), false);
});
