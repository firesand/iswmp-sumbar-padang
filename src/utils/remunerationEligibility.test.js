import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePeriodRemunerationEligibility,
  getPeriodSpecificDeliverableConfigs,
  isDeliverableSubmitted,
} from './remunerationEligibility.js';

const timestamp = (millis) => ({ toMillis: () => millis });

const verifiedAttendance = ({
  id = 'att-1',
  userId = 'employee-1',
  date = '2026-08-14',
  status = 'ontime',
  seed = 1,
  overrides = {},
} = {}) => {
  const challengeId =
    `${String(seed).repeat(8).slice(0, 8)}-1111-4111-8111-111111111111`;
  const checkOutChallengeId =
    `${String(seed).repeat(8).slice(0, 8)}-2222-4222-8222-222222222222`;
  const checkInMillis = Date.parse(`${date}T01:00:00Z`);
  const checkOutMillis = checkInMillis + 8 * 60 * 60 * 1000;

  return {
    id,
    userId,
    date,
    status,
    integrityVersion: 2,
    proofVersion: 2,
    verificationStatus: 'verified',
    transitionMode: false,
    isWithinRadius: true,
    checkIn: timestamp(checkInMillis),
    checkOut: timestamp(checkOutMillis),
    workHours: 8,
    challengeIds: {
      checkIn: challengeId,
      checkOut: checkOutChallengeId,
    },
    checkInPhotoPath: `attendanceProofs/${userId}/${challengeId}`,
    checkInPhotoGeneration: '1',
    checkInPhotoHash: 'a'.repeat(64),
    checkInPhotoPerceptualHash: 'b'.repeat(36),
    checkOutPhotoPath: `attendanceProofs/${userId}/${checkOutChallengeId}`,
    checkOutPhotoGeneration: '2',
    checkOutPhotoHash: 'c'.repeat(64),
    checkOutPhotoPerceptualHash: 'd'.repeat(36),
    presenceProof: {
      required: true,
      verified: true,
      counter: 1,
      issuedBy: 'admin-1',
      grantId: challengeId,
      coPresence: {
        verified: true,
        distanceMeters: 10,
        uncertaintyAdjustedDistanceMeters: 20,
        maximumMeters: 100,
        verifierAccuracyMeters: 5,
      },
    },
    checkOutPresenceProof: {
      required: true,
      verified: true,
      counter: 2,
      issuedBy: 'admin-1',
      grantId: checkOutChallengeId,
      coPresence: {
        verified: true,
        distanceMeters: 12,
        uncertaintyAdjustedDistanceMeters: 22,
        maximumMeters: 100,
        verifierAccuracyMeters: 5,
      },
    },
    geofenceSnapshot: {
      verificationAuditId:
        'kantor_test_33333333-3333-4333-8333-333333333333',
      verificationReviewedBy: 'Reviewer Lapangan',
      verificationReviewedAt: timestamp(checkInMillis - 1),
      verificationOperator: 'c'.repeat(64),
      verificationReviewOperator: 'd'.repeat(64),
    },
    checkOutGeofenceSnapshot: {
      verificationAuditId:
        'kantor_test_44444444-4444-4444-8444-444444444444',
      verificationReviewedBy: 'Reviewer Lapangan',
      verificationReviewedAt: timestamp(checkInMillis - 1),
      verificationOperator: 'c'.repeat(64),
      verificationReviewOperator: 'd'.repeat(64),
    },
    ...overrides,
  };
};

test('remunerationEligibility: regular period (Period 2) is eligible when daily activity and monthly report are submitted', () => {
  const attendances = [
    verifiedAttendance(),
    verifiedAttendance({
      id: 'att-2',
      date: '2026-08-15',
      status: 'late',
      seed: 2,
    }),
  ];

  const deliverables = [
    {
      id: 'laporan_bulanan_02',
      submission: {
        status: 'submitted',
        files: [{ name: 'Laporan_Bulanan_2.pdf', size: 1024 }],
      },
    },
  ];

  const res = evaluatePeriodRemunerationEligibility({
    periodIndex: 2,
    attendances,
    deliverables,
  });

  assert.equal(res.isEligible, true);
  assert.equal(res.status, 'ELIGIBLE');
  assert.equal(res.completedCount, 2);
  assert.equal(res.totalRequirementsCount, 2);
  assert.equal(res.missingItems.length, 0);
  assert.ok(res.summaryMessage.includes('berhak untuk menerima pembayaran remunerasi'));
});

test('remunerationEligibility: period 1 requires Inception Report (Laporan Pendahuluan)', () => {
  const attendances = [verifiedAttendance({ date: '2026-07-20' })];

  // Case A: Only monthly report is submitted, Inception report is missing
  const deliverablesA = [
    {
      id: 'laporan_bulanan_01',
      submission: { status: 'submitted', files: [{ name: 'LB1.pdf' }] },
    },
    {
      id: 'laporan_pendahuluan',
      submission: { status: 'draft', files: [] },
    },
  ];

  const resA = evaluatePeriodRemunerationEligibility({
    periodIndex: 1,
    attendances,
    deliverables: deliverablesA,
  });

  assert.equal(resA.isEligible, false);
  assert.equal(resA.status, 'INCOMPLETE');
  assert.equal(resA.totalRequirementsCount, 3); // Daily activity, LB-01, LP
  assert.ok(resA.missingItems.some((m) => m.includes('Laporan Pendahuluan')));

  // Case B: Inception report is also submitted
  const deliverablesB = [
    {
      id: 'laporan_bulanan_01',
      submission: { status: 'submitted', files: [{ name: 'LB1.pdf' }] },
    },
    {
      id: 'laporan_pendahuluan',
      submission: { status: 'approved', files: [{ name: 'Inception_Report.pdf' }] },
    },
  ];

  const resB = evaluatePeriodRemunerationEligibility({
    periodIndex: 1,
    attendances,
    deliverables: deliverablesB,
  });

  assert.equal(resB.isEligible, true);
  assert.equal(resB.status, 'ELIGIBLE');
  assert.equal(resB.completedCount, 3);
  assert.equal(resB.missingItems.length, 0);
});

test('remunerationEligibility: period 3 requires Quarterly Report I (LTW-01)', () => {
  const specificConfigs = getPeriodSpecificDeliverableConfigs(3);
  assert.equal(specificConfigs.length, 1);
  assert.equal(specificConfigs[0].id, 'laporan_triwulan_01');

  const attendances = [verifiedAttendance()];
  const deliverables = [
    {
      id: 'laporan_bulanan_03',
      submission: { status: 'submitted', files: [{ name: 'LB3.pdf' }] },
    },
    {
      id: 'laporan_triwulan_01',
      submission: {
        status: 'submitted',
        files: [{ name: 'LTW1.pdf' }, { name: 'Presentasi_BPBPK.pptx' }],
      },
    },
  ];

  const res = evaluatePeriodRemunerationEligibility({
    periodIndex: 3,
    attendances,
    deliverables,
  });

  assert.equal(res.isEligible, true);
  assert.equal(res.status, 'ELIGIBLE');
  assert.equal(res.completedCount, 3);
});

test('remunerationEligibility: period 10 requires Final Report (LA-FINAL)', () => {
  const specificConfigs = getPeriodSpecificDeliverableConfigs(10);
  assert.equal(specificConfigs.length, 1);
  assert.equal(specificConfigs[0].id, 'laporan_akhir');

  const attendances = [verifiedAttendance()];
  const deliverables = [
    {
      id: 'laporan_bulanan_10',
      submission: { status: 'submitted', files: [{ name: 'LB10.pdf' }] },
    },
    {
      id: 'laporan_akhir',
      submission: {
        status: 'submitted',
        files: [{ name: 'Laporan_Akhir.pdf' }, { name: 'BNBA.xlsx' }],
      },
    },
  ];

  const res = evaluatePeriodRemunerationEligibility({
    periodIndex: 10,
    attendances,
    deliverables,
  });

  assert.equal(res.isEligible, true);
  assert.equal(res.status, 'ELIGIBLE');
});

test('remunerationEligibility: a draft with uploaded files is not submitted', () => {
  const draft = {
    submission: {
      status: 'draft',
      files: [{ name: 'partial.pdf' }],
    },
  };

  assert.equal(isDeliverableSubmitted(draft), false);
  assert.equal(isDeliverableSubmitted({
    submission: { status: 'submitted', files: [] },
  }), true);

  const result = evaluatePeriodRemunerationEligibility({
    periodIndex: 2,
    attendances: [verifiedAttendance()],
    deliverables: [{ id: 'laporan_bulanan_02', ...draft }],
  });

  assert.equal(result.isEligible, false);
  assert.ok(result.missingItems.includes('Laporan Bulanan Ke-2'));
});

test('remunerationEligibility: raw or unverified check-ins do not satisfy daily activity', () => {
  const result = evaluatePeriodRemunerationEligibility({
    periodIndex: 2,
    attendances: [{
      id: 'legacy-attendance',
      userId: 'employee-1',
      date: '2026-08-14',
      status: 'present',
      checkIn: timestamp(Date.parse('2026-08-14T01:00:00Z')),
    }],
    deliverables: [{
      id: 'laporan_bulanan_02',
      submission: { status: 'submitted', files: [{ name: 'LB2.pdf' }] },
    }],
  });

  assert.equal(result.isEligible, false);
  assert.equal(result.checklist.find((item) => item.id === 'daily_activity').fulfilled, false);
  assert.ok(result.missingItems.includes(
    'Laporan Daily Activity / Rekap Kehadiran Harian'
  ));
});

test('remunerationEligibility: verified check-in without a completed shift does not qualify', () => {
  const incomplete = verifiedAttendance({
    overrides: {
      checkOut: null,
      workHours: null,
      checkOutPhotoPath: null,
      checkOutPhotoGeneration: null,
      checkOutPhotoHash: null,
      checkOutPhotoPerceptualHash: null,
      checkOutPresenceProof: null,
      checkOutGeofenceSnapshot: null,
    },
  });

  const result = evaluatePeriodRemunerationEligibility({
    periodIndex: 2,
    attendances: [incomplete],
    deliverables: [{
      id: 'laporan_bulanan_02',
      submission: { status: 'submitted', files: [{ name: 'LB2.pdf' }] },
    }],
  });

  assert.equal(result.isEligible, false);
  assert.equal(
    result.checklist.find((item) => item.id === 'daily_activity').fulfilled,
    false
  );
});
