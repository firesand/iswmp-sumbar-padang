import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getVerifiedWorkHours,
  hasCanonicalAttendanceProof,
  isAttendanceWorkflowEligible,
  isCompletedLocationPhotoAttendance,
  isCompletedRecordedAttendance,
  isCompletedVerifiedAttendance,
  isLocationPhotoAttendance,
  isReviewableAttendancePhoto,
  isVerifiedAttendance,
} from './attendanceIntegrity.js';

const USER_ID = 'employee-1';
const CHECK_IN_CHALLENGE = '11111111-1111-4111-8111-111111111111';
const CHECK_OUT_CHALLENGE = '22222222-2222-4222-8222-222222222222';

const timestamp = millis => ({ toMillis: () => millis });

const completedRecord = (overrides = {}) => ({
  userId: USER_ID,
  integrityVersion: 2,
  proofVersion: 2,
  verificationStatus: 'verified',
  transitionMode: false,
  isWithinRadius: true,
  checkIn: timestamp(1_000),
  checkOut: timestamp(3_601_000),
  challengeIds: {
    checkIn: CHECK_IN_CHALLENGE,
    checkOut: CHECK_OUT_CHALLENGE,
  },
  checkInPhotoPath: `attendanceProofs/${USER_ID}/${CHECK_IN_CHALLENGE}`,
  checkInPhotoGeneration: '1001',
  checkInPhotoHash: 'a'.repeat(64),
  checkInPhotoPerceptualHash: 'c'.repeat(36),
  checkOutPhotoPath: `attendanceProofs/${USER_ID}/${CHECK_OUT_CHALLENGE}`,
  checkOutPhotoGeneration: '1002',
  checkOutPhotoHash: 'b'.repeat(64),
  checkOutPhotoPerceptualHash: 'd'.repeat(36),
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
  checkOutPresenceProof: {
    required: true,
    verified: true,
    counter: 101,
    issuedBy: 'admin-1',
    grantId: CHECK_OUT_CHALLENGE,
    coPresence: {
      verified: true,
      distanceMeters: 15,
      uncertaintyAdjustedDistanceMeters: 45,
      maximumMeters: 100,
      verifierAccuracyMeters: 12,
    },
  },
  geofenceSnapshot: {
    verificationAuditId:
      'kelurahan_kel-test_33333333-3333-4333-8333-333333333333',
    verificationReviewedBy: 'Reviewer Lapangan',
    verificationReviewedAt: timestamp(900),
    verificationOperator: '1'.repeat(64),
    verificationReviewOperator: '2'.repeat(64),
  },
  checkOutGeofenceSnapshot: {
    verificationAuditId:
      'kelurahan_kel-test_33333333-3333-4333-8333-333333333333',
    verificationReviewedBy: 'Reviewer Lapangan',
    verificationReviewedAt: timestamp(900),
    verificationOperator: '1'.repeat(64),
    verificationReviewOperator: '2'.repeat(64),
  },
  workHours: 1,
  ...overrides,
});

const completedLocationPhotoRecord = (overrides = {}) => ({
  ...completedRecord(),
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
  checkInLocation: {
    lat: -0.86,
    lng: 100.33,
    accuracy: 12,
    capturedAt: 1_000,
    source: 'gps-high',
    serverReceivedAt: timestamp(1_000),
  },
  checkOutLocation: {
    lat: -0.861,
    lng: 100.331,
    accuracy: 15,
    capturedAt: 3_600_900,
    source: 'gps-high',
    serverReceivedAt: timestamp(3_601_000),
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
  ...overrides,
});

test('accepts only exact v2 canonical proof metadata', () => {
  const record = completedRecord();
  assert.equal(isVerifiedAttendance(record), true);
  assert.equal(hasCanonicalAttendanceProof(record, 'checkIn'), true);
  assert.equal(isCompletedVerifiedAttendance(record), true);
  assert.equal(getVerifiedWorkHours(record), 1);

  assert.equal(isVerifiedAttendance(completedRecord({ integrityVersion: 3 })), false);
  assert.equal(isVerifiedAttendance(completedRecord({ integrityVersion: '2' })), false);
  assert.equal(isVerifiedAttendance(completedRecord({ proofVersion: 1 })), false);
  assert.equal(isVerifiedAttendance(completedRecord({ transitionMode: true })), false);
  assert.equal(isVerifiedAttendance(completedRecord({ isWithinRadius: false })), false);
});

test('does not treat a check-in-only record as payroll eligible', () => {
  const record = completedRecord({
    checkOut: null,
    checkOutPhotoPath: null,
    checkOutPhotoGeneration: null,
    checkOutPhotoHash: null,
    checkOutPhotoPerceptualHash: null,
    checkOutPresenceProof: null,
    workHours: 8,
  });

  assert.equal(isVerifiedAttendance(record), true);
  assert.equal(isCompletedVerifiedAttendance(record), false);
  assert.equal(getVerifiedWorkHours(record), 0);
});

test('legacy URLs cannot replace either canonical proof', () => {
  const record = completedRecord({
    checkOutPhoto: 'https://attacker.example/old-photo.jpg',
    checkOutPhotoPath: null,
    checkOutPhotoGeneration: null,
    checkOutPhotoHash: null,
    checkOutPhotoPerceptualHash: null,
  });

  assert.equal(hasCanonicalAttendanceProof(record, 'checkOut'), false);
  assert.equal(isCompletedVerifiedAttendance(record), false);
});

test('rejects mismatched paths, malformed generations, hashes, and time order', () => {
  assert.equal(
    hasCanonicalAttendanceProof(
      completedRecord({ checkInPhotoPath: `attendanceProofs/other/${CHECK_IN_CHALLENGE}` }),
      'checkIn'
    ),
    false
  );
  assert.equal(
    hasCanonicalAttendanceProof(completedRecord({ checkInPhotoGeneration: 1001 }), 'checkIn'),
    false
  );
  assert.equal(
    hasCanonicalAttendanceProof(completedRecord({ checkInPhotoHash: 'not-a-sha256' }), 'checkIn'),
    false
  );
  assert.equal(
    hasCanonicalAttendanceProof(
      completedRecord({ checkInPhotoPerceptualHash: 'not-a-perceptual-hash' }),
      'checkIn'
    ),
    false
  );
  assert.equal(
    isVerifiedAttendance(completedRecord({ presenceProof: { required: true, verified: true } })),
    false
  );
  assert.equal(
    isCompletedVerifiedAttendance(completedRecord({ checkOut: timestamp(999) })),
    false
  );
  assert.equal(isCompletedVerifiedAttendance(completedRecord({ workHours: 8 })), false);
  assert.equal(isCompletedVerifiedAttendance(completedRecord({ workHours: '1' })), false);
});

test('keeps location+photo records operational without claiming Verified v2', () => {
  const record = completedLocationPhotoRecord();

  assert.equal(isLocationPhotoAttendance(record), true);
  assert.equal(isAttendanceWorkflowEligible(record), true);
  assert.equal(isCompletedLocationPhotoAttendance(record), true);
  assert.equal(isCompletedRecordedAttendance(record), true);
  assert.equal(isVerifiedAttendance(record), false);
  assert.equal(isCompletedVerifiedAttendance(record), false);
  assert.equal(getVerifiedWorkHours(record), 0);
  assert.equal(isReviewableAttendancePhoto(record, 'checkIn'), true);
  assert.equal(isReviewableAttendancePhoto(record, 'checkOut'), true);
});

test('location+photo classifier fails closed on missing GPS or false assurance', () => {
  assert.equal(
    isLocationPhotoAttendance(
      completedLocationPhotoRecord({ checkInLocation: null })
    ),
    false
  );
  assert.equal(
    isLocationPhotoAttendance(
      completedLocationPhotoRecord({ isWithinRadius: true })
    ),
    false
  );
  assert.equal(
    isLocationPhotoAttendance(completedLocationPhotoRecord({
      checkInLocation: {
        ...completedLocationPhotoRecord().checkInLocation,
        source: 'gps',
      },
    })),
    false
  );
  assert.equal(
    isLocationPhotoAttendance(completedLocationPhotoRecord({
      checkInLocation: {
        ...completedLocationPhotoRecord().checkInLocation,
        serverReceivedAt: timestamp(1_001),
      },
    })),
    false
  );
  assert.equal(
    isLocationPhotoAttendance(completedLocationPhotoRecord({
      assignmentSnapshot: {
        ...completedLocationPhotoRecord().assignmentSnapshot,
        unexpected: true,
      },
    })),
    false
  );
  assert.equal(
    isLocationPhotoAttendance(
      completedLocationPhotoRecord({ deviceVerified: true })
    ),
    false
  );
  assert.equal(
    isCompletedLocationPhotoAttendance(
      completedLocationPhotoRecord({
        checkOutPresenceProof: {
          required: false,
          verified: true,
          reason: 'policy_location_photo',
        },
      })
    ),
    false
  );
});
