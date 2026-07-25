#!/usr/bin/env node

/**
 * Idempotent, fail-closed production migration for the attendance v2 rollout.
 * Default mode is read-only. Pass --apply to write, using each document's
 * updateTime as a precondition so concurrent changes cannot be overwritten.
 */

import authModule from 'firebase-tools/lib/auth.js';
import { createHash } from 'node:crypto';

const PROJECT_ID = 'iswmp-sumbar-padang';
const APPLY = process.argv.includes('--apply');
const FIRESTORE_ROOT =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const PERCEPTUAL_HASH_VERSION = 'dh144mv2';
const PERCEPTUAL_REPLAY_SCHEMA_VERSION = 1;
const PERCEPTUAL_REPLAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PERCEPTUAL_REPLAY_MAX_ENTRIES = 64;
const PERCEPTUAL_HASH_VIEW_COUNT = 8;
const PERCEPTUAL_AUDIT_SCHEMA_VERSION = 3;
const OPEN_SHIFT_SCHEMA_VERSION = 1;
const ADMINISTRATIVE_COMPLETION_SOURCE =
  'dual-approved-manual-missing-checkout-v1';

const account = authModule.getGlobalDefaultAccount();
if (!account?.tokens?.refresh_token) {
  throw new Error('Firebase CLI belum login. Jalankan: npx firebase login');
}
authModule.setRefreshToken(account.tokens.refresh_token);
const tokenResult = await authModule.getAccessToken(account.tokens.refresh_token, []);
const accessToken = tokenResult?.access_token;
if (!accessToken) throw new Error('Tidak dapat memperoleh token Firebase CLI.');

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `${response.status} ${url}`);
  return body;
};

const decodeValue = value => {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(decodeValue);
  }
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(
        ([key, nested]) => [key, decodeValue(nested)]
      )
    );
  }
  return undefined;
};

const encodeValue = value => {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  throw new Error(`Tipe nilai migration tidak didukung: ${typeof value}`);
};

const listDocuments = async collectionId => {
  const documents = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ pageSize: '300', showMissing: 'false' });
    if (pageToken) params.set('pageToken', pageToken);
    const result = await api(`${FIRESTORE_ROOT}/${collectionId}?${params}`);
    documents.push(...(result.documents || []).map(document => ({
      name: document.name,
      id: document.name.split('/').pop(),
      updateTime: document.updateTime,
      data: Object.fromEntries(
        Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)])
      ),
    })));
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return documents;
};

const patchDocument = async (document, fields) => {
  const params = new URLSearchParams();
  Object.keys(fields).forEach(field => params.append('updateMask.fieldPaths', field));
  params.set('currentDocument.updateTime', document.updateTime);
  await api(`https://firestore.googleapis.com/v1/${document.name}?${params}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: document.name,
      fields: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, encodeValue(value)])
      ),
    }),
  });
};

const [
  users,
  kelurahan,
  kantor,
  attendances,
  projectConfig,
  openShifts,
  replayStates,
  exactProofHashes,
  perceptualProofAudits,
  correctionEffectiveViews,
  correctionProposals,
  correctionDecisions,
  correctionEvents,
] = await Promise.all([
  listDocuments('users'),
  listDocuments('kelurahan'),
  listDocuments('kantor'),
  listDocuments('attendances'),
  listDocuments('projectConfig'),
  listDocuments('attendanceOpenShifts'),
  listDocuments('attendancePerceptualReplayStates'),
  listDocuments('attendanceProofHashes'),
  listDocuments('attendanceProofPerceptualHashes'),
  listDocuments('attendanceCorrectionEffectiveViews'),
  listDocuments('attendanceCorrectionProposals'),
  listDocuments('attendanceCorrectionDecisions'),
  listDocuments('attendanceCorrectionEvents'),
]);

const migrationTime = new Date();
const operations = [];
const locationPhotoRecords = attendances.filter(({ data }) =>
  data.verificationMode === 'location_photo' ||
  data.verificationStatus === 'location_photo_only' ||
  data.checkOutVerificationMode === 'location_photo'
);
if (locationPhotoRecords.length > 0) {
  throw new Error(
    'Preflight gagal: migration v2 tidak boleh dijalankan setelah record ' +
    'location_photo terbentuk. Gunakan audit-security-state.mjs; tidak ada write.'
  );
}
const defaultConfig = projectConfig.find(item => item.id === 'default');
if (!defaultConfig) throw new Error('projectConfig/default tidak ditemukan.');
const configuredSecurityVersion =
  defaultConfig.data.attendanceSecurityVersion;
if (
  configuredSecurityVersion != null &&
  (!Number.isInteger(configuredSecurityVersion) ||
    configuredSecurityVersion < 1 ||
    configuredSecurityVersion > 2)
) {
  throw new Error(
    'Preflight gagal: attendanceSecurityVersion tidak didukung; tidak ada write.'
  );
}
const existingCutoverMs = Date.parse(
  defaultConfig.data.attendanceSecurityCutoverAt || ''
);
if (
  Number.isFinite(existingCutoverMs) &&
  existingCutoverMs > migrationTime.getTime()
) {
  throw new Error(
    'Preflight gagal: timestamp cutover berada di masa depan; tidak ada write.'
  );
}
if (
  configuredSecurityVersion === 2 &&
  defaultConfig.data.geofenceTransitionMode === false &&
  !Number.isFinite(existingCutoverMs)
) {
  throw new Error(
    'Preflight gagal: cutover v2 aktif tanpa timestamp canonical; tidak ada write.'
  );
}
const configuredShiftDuration =
  defaultConfig.data.maxAttendanceShiftDurationMinutes;
if (
  configuredShiftDuration != null &&
  (!Number.isInteger(configuredShiftDuration) ||
    configuredShiftDuration < 60 ||
    configuredShiftDuration > 1440)
) {
  throw new Error(
    'Preflight gagal: batas durasi shift di luar 60-1440 menit; tidak ada write.'
  );
}
const existingSecurityCutoverTrusted =
  configuredSecurityVersion === 2 &&
  defaultConfig.data.geofenceTransitionMode === false &&
  Number.isFinite(existingCutoverMs) &&
  existingCutoverMs <= migrationTime.getTime();
const authoritativeV2Attendances = [];

for (const user of users) {
  if (!Object.hasOwn(user.data, 'mustChangePassword')) {
    operations.push({
      kind: 'user-security-default',
      document: user,
      fields: {
        mustChangePassword: false,
        securityProfileUpdatedAt: migrationTime,
      },
    });
  }
}

for (const geofence of [...kelurahan, ...kantor]) {
  if (geofence.data.presenceProofRequired !== true) {
    operations.push({
      kind: 'geofence-onsite-required',
      document: geofence,
      fields: {
        presenceProofRequired: true,
        securityPolicyUpdatedAt: migrationTime,
      },
    });
  }
}

for (const attendance of attendances) {
  const isLegacy =
    attendance.data.verificationStatus === 'unverified_legacy' &&
    attendance.data.integrityVersion === 1 &&
    attendance.data.proofVersion === 0;
  const createdMs = Date.parse(
    attendance.data.createdAt || attendance.data.checkIn || ''
  );
  const isCanonicalPostCutoverV2 =
    existingSecurityCutoverTrusted &&
    Number.isFinite(createdMs) &&
    createdMs >= existingCutoverMs &&
    attendance.id ===
      `${attendance.data.userId}_${attendance.data.date}` &&
    attendance.data.verificationStatus === 'verified' &&
    attendance.data.integrityVersion === 2 &&
    attendance.data.proofVersion === 2;

  // Re-runs must never downgrade records created by the authoritative v2
  // backend after cutover. Everything else that is not already classified
  // remains audit-only legacy evidence.
  if (!isLegacy && !isCanonicalPostCutoverV2) {
    operations.push({
      kind: 'attendance-legacy-classification',
      document: attendance,
      fields: {
        verificationStatus: 'unverified_legacy',
        integrityVersion: 1,
        proofVersion: 0,
        legacyClassifiedAt: migrationTime,
        legacyClassifiedReason: 'predates_server_authoritative_v2_cutover',
      },
    });
  } else if (isCanonicalPostCutoverV2) {
    authoritativeV2Attendances.push(attendance);
  }
}

const hasExactKeys = (value, expectedKeys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

const timestampMs = value => {
  const milliseconds = Date.parse(value || '');
  return Number.isFinite(milliseconds) ? milliseconds : null;
};

const validSha256 = value =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const validPerceptualHash = value =>
  typeof value === 'string' && /^[0-9a-f]{36}$/.test(value);
const validPerceptualHashes = value =>
  Array.isArray(value) &&
  value.length === PERCEPTUAL_HASH_VIEW_COUNT &&
  value.every(validPerceptualHash);
const validUuid = value =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
const validUid = value =>
  typeof value === 'string' && value.length >= 1 && value.length <= 128;

const failPreflight = (reason, id = '') => {
  const suffix = id ? ` (${id})` : '';
  throw new Error(`Preflight keamanan gagal: ${reason}${suffix}; tidak ada write.`);
};

const byId = documents =>
  new Map(documents.map(document => [document.id, document]));
const v2ById = byId(authoritativeV2Attendances);
const openShiftByUid = byId(openShifts);
const replayStateByUid = byId(replayStates);
const exactHashById = byId(exactProofHashes);
const perceptualAuditById = byId(perceptualProofAudits);
const effectiveViewById = byId(correctionEffectiveViews);
const correctionProposalById = byId(correctionProposals);
const correctionDecisionById = byId(correctionDecisions);
const correctionEventById = byId(correctionEvents);

const accountFingerprint = uid => createHash('sha256')
  .update('firebase-auth-uid')
  .update('\u0000')
  .update(JSON.stringify(uid))
  .digest('hex');
const hashObject = (domain, value) => createHash('sha256')
  .update(domain)
  .update('\u0000')
  .update(JSON.stringify(value))
  .digest('hex');

const emptyCheckoutFields = [
  'checkOut',
  'checkOutTime',
  'checkOutDateWib',
  'checkOutLocation',
  'checkOutPhoto',
  'checkOutPhotoPath',
  'checkOutPhotoGeneration',
  'checkOutPhotoHash',
  'checkOutPhotoPerceptualHash',
  'checkOutPhotoPerceptualHashes',
  'checkOutPhotoMd5Hash',
  'checkOutPhotoCrc32c',
  'checkOutDistanceFromGeofence',
  'checkOutGeofenceSnapshot',
  'checkOutPresenceProof',
];
const hasNoCheckoutEvidence = attendance =>
  emptyCheckoutFields.every(field => attendance[field] == null) &&
  attendance.challengeIds?.checkOut == null &&
  attendance.workHours === 0;

const getWibDate = milliseconds => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(milliseconds));
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const hasStrictDeviceCheckoutEvidence = attendance => {
  const checkInMs = timestampMs(attendance.checkIn);
  const checkOutMs = timestampMs(attendance.checkOut);
  const expectedWorkHours =
    checkInMs != null && checkOutMs != null
      ? Math.round(((checkOutMs - checkInMs) / 3_600_000) * 100) / 100
      : null;
  return checkInMs != null &&
    checkOutMs != null &&
    checkOutMs >= checkInMs &&
    attendance.checkOutTime === new Date(checkOutMs).toISOString() &&
    attendance.checkOutDateWib === getWibDate(checkOutMs) &&
    attendance.checkOutLocation &&
    typeof attendance.checkOutLocation === 'object' &&
    !Array.isArray(attendance.checkOutLocation) &&
    attendance.checkOutPhoto === null &&
    typeof attendance.checkOutPhotoPath === 'string' &&
    typeof attendance.checkOutPhotoGeneration === 'string' &&
    validSha256(attendance.checkOutPhotoHash) &&
    validPerceptualHash(attendance.checkOutPhotoPerceptualHash) &&
    validPerceptualHashes(attendance.checkOutPhotoPerceptualHashes) &&
    typeof attendance.checkOutPhotoMd5Hash === 'string' &&
    attendance.checkOutPhotoMd5Hash.length > 0 &&
    typeof attendance.checkOutPhotoCrc32c === 'string' &&
    attendance.checkOutPhotoCrc32c.length > 0 &&
    Number.isFinite(attendance.checkOutDistanceFromGeofence) &&
    attendance.checkOutDistanceFromGeofence >= 0 &&
    attendance.checkOutGeofenceSnapshot &&
    typeof attendance.checkOutGeofenceSnapshot === 'object' &&
    attendance.checkOutPresenceProof &&
    typeof attendance.checkOutPresenceProof === 'object' &&
    validUuid(attendance.challengeIds?.checkOut) &&
    attendance.workHours === expectedWorkHours;
};

const projectionFields = [
  'schemaVersion',
  'attendanceId',
  'userId',
  'workDate',
  'correctionType',
  'revision',
  'baseShiftRevision',
  'proposalId',
  'correctionEventId',
  'originalCheckIn',
  'effectiveCheckOut',
  'effectiveWorkHours',
  'completionSource',
  'manualCorrection',
  'deviceVerified',
  'canonicalAttendanceChanged',
  'approvedAt',
];
const correctionProposalFields = [
  'schemaVersion',
  'action',
  'proposalId',
  'status',
  'correctionType',
  'attendanceId',
  'userId',
  'workDate',
  'requestedCheckOut',
  'requestedCheckOutIso',
  'reason',
  'baseRevision',
  'baseFingerprint',
  'attendanceUpdateTime',
  'openShiftUpdateTime',
  'configUpdateTime',
  'maxShiftDurationMinutes',
  'source',
  'manualCorrection',
  'deviceVerified',
  'proposerUid',
  'proposerAccountFingerprint',
  'proposedAt',
  'expiresAt',
  'proposalFingerprint',
];
const correctionDecisionFields = [
  'schemaVersion',
  'action',
  'decisionId',
  'proposalId',
  'proposalFingerprint',
  'attendanceId',
  'userId',
  'workDate',
  'correctionType',
  'decision',
  'status',
  'source',
  'manualCorrection',
  'deviceVerified',
  'proposerUid',
  'proposerAccountFingerprint',
  'reviewerUid',
  'reviewerAccountFingerprint',
  'correctionEventId',
  'effectiveProjectionId',
  'reviewedAt',
];
const correctionEventFields = [
  'schemaVersion',
  'action',
  'eventId',
  'proposalId',
  'decisionId',
  'attendanceId',
  'userId',
  'workDate',
  'correctionType',
  'revision',
  'baseRevision',
  'baseShiftRevision',
  'baseFingerprint',
  'attendanceUpdateTime',
  'openShiftUpdateTime',
  'configUpdateTime',
  'maxShiftDurationMinutes',
  'originalCheckIn',
  'effectiveCheckOut',
  'effectiveWorkHours',
  'reason',
  'source',
  'manualCorrection',
  'deviceVerified',
  'canonicalAttendanceChanged',
  'proposerUid',
  'proposerAccountFingerprint',
  'reviewerUid',
  'reviewerAccountFingerprint',
  'proposedAt',
  'approvedAt',
];

const calculateCorrectionProposalFingerprint = proposal =>
  hashObject('attendance-correction-proposal-v1', {
    schemaVersion: proposal.schemaVersion,
    action: proposal.action,
    proposalId: proposal.proposalId,
    status: proposal.status,
    correctionType: proposal.correctionType,
    attendanceId: proposal.attendanceId,
    userId: proposal.userId,
    workDate: proposal.workDate,
    requestedCheckOutIso: proposal.requestedCheckOutIso,
    reason: proposal.reason,
    baseRevision: proposal.baseRevision,
    baseFingerprint: proposal.baseFingerprint,
    attendanceUpdateTime: proposal.attendanceUpdateTime,
    openShiftUpdateTime: proposal.openShiftUpdateTime,
    configUpdateTime: proposal.configUpdateTime,
    maxShiftDurationMinutes: proposal.maxShiftDurationMinutes,
    source: proposal.source,
    manualCorrection: proposal.manualCorrection,
    deviceVerified: proposal.deviceVerified,
    proposerUid: proposal.proposerUid,
    proposerAccountFingerprint: proposal.proposerAccountFingerprint,
    proposedAtMs: timestampMs(proposal.proposedAt),
    expiresAtMs: timestampMs(proposal.expiresAt),
  });

const calculateCorrectionBaseFingerprint = (
  attendanceDocument,
  proposal
) => {
  const attendance = attendanceDocument.data;
  return hashObject('attendance-correction-base-v1', {
    attendance: {
      attendanceId: attendanceDocument.id,
      userId: attendance.userId,
      workDate: attendance.date,
      checkInMs: timestampMs(attendance.checkIn),
      status: attendance.status ?? null,
      integrityVersion: attendance.integrityVersion,
      proofVersion: attendance.proofVersion,
      verificationStatus: attendance.verificationStatus,
      transitionMode: attendance.transitionMode,
      isWithinRadius: attendance.isWithinRadius,
      checkInChallengeId: attendance.challengeIds?.checkIn,
      checkInPhotoPath: attendance.checkInPhotoPath,
      checkInPhotoGeneration: attendance.checkInPhotoGeneration,
      checkInPhotoHash: attendance.checkInPhotoHash,
      checkInPhotoPerceptualHash:
        attendance.checkInPhotoPerceptualHash,
      checkInPhotoPerceptualHashes:
        attendance.checkInPhotoPerceptualHashes,
      presenceGrantId: attendance.presenceProof?.grantId,
      geofenceAuditId:
        attendance.geofenceSnapshot?.verificationAuditId,
      geofenceOperator:
        attendance.geofenceSnapshot?.verificationOperator,
      geofenceReviewOperator:
        attendance.geofenceSnapshot?.verificationReviewOperator,
      workHours: attendance.workHours,
      attendanceUpdateTime: proposal.attendanceUpdateTime,
    },
    openShift: {
      schemaVersion: OPEN_SHIFT_SCHEMA_VERSION,
      uid: attendance.userId,
      revision: proposal.baseRevision,
      status: 'open',
      attendanceId: attendanceDocument.id,
      workDate: attendance.date,
      checkInAtMs: timestampMs(attendance.checkIn),
      closedAt: null,
      updateTime: proposal.openShiftUpdateTime,
    },
    policy: {
      maximumMinutes: proposal.maxShiftDurationMinutes,
      updateTime: proposal.configUpdateTime,
    },
  });
};

const validateCorrectionChain = attendanceDocument => {
  const attendance = attendanceDocument.data;
  const projectionDocument = effectiveViewById.get(attendanceDocument.id);
  if (!projectionDocument) return null;
  const projection = projectionDocument.data;
  const checkInMs = timestampMs(attendance.checkIn);
  const effectiveCheckOutMs = timestampMs(projection.effectiveCheckOut);
  const approvedAtMs = timestampMs(projection.approvedAt);
  const expectedHours =
    checkInMs != null && effectiveCheckOutMs != null
      ? Math.round(((effectiveCheckOutMs - checkInMs) / 3_600_000) * 100) / 100
      : null;
  if (
    !hasExactKeys(projection, projectionFields) ||
    projection.schemaVersion !== 1 ||
    projection.attendanceId !== attendanceDocument.id ||
    projection.userId !== attendance.userId ||
    projection.workDate !== attendance.date ||
    projection.correctionType !== 'missing_checkout' ||
    projection.revision !== 1 ||
    !Number.isInteger(projection.baseShiftRevision) ||
    projection.baseShiftRevision < 1 ||
    !validUuid(projection.proposalId) ||
    projection.correctionEventId !== projection.proposalId ||
    projection.completionSource !== ADMINISTRATIVE_COMPLETION_SOURCE ||
    projection.manualCorrection !== true ||
    projection.deviceVerified !== false ||
    projection.canonicalAttendanceChanged !== false ||
    timestampMs(projection.originalCheckIn) !== checkInMs ||
    effectiveCheckOutMs == null ||
    effectiveCheckOutMs <= checkInMs ||
    effectiveCheckOutMs - checkInMs > 1440 * 60 * 1000 ||
    approvedAtMs == null ||
    approvedAtMs < effectiveCheckOutMs ||
    projection.effectiveWorkHours !== expectedHours ||
    !hasNoCheckoutEvidence(attendance)
  ) {
    failPreflight('effective correction tidak canonical', attendanceDocument.id);
  }

  const proposal =
    correctionProposalById.get(projection.proposalId)?.data;
  const decision =
    correctionDecisionById.get(projection.proposalId)?.data;
  const event =
    correctionEventById.get(projection.correctionEventId)?.data;
  const requestedCheckOutMs = timestampMs(proposal?.requestedCheckOut);
  const proposedAtMs = timestampMs(proposal?.proposedAt);
  const expiresAtMs = timestampMs(proposal?.expiresAt);
  const reviewedAtMs = timestampMs(decision?.reviewedAt);
  if (
    !proposal ||
    !decision ||
    !event ||
    !hasExactKeys(proposal, correctionProposalFields) ||
    !hasExactKeys(decision, correctionDecisionFields) ||
    !hasExactKeys(event, correctionEventFields) ||
    proposal.schemaVersion !== 1 ||
    proposal.action !== 'attendance_missing_checkout_correction' ||
    proposal.proposalId !== projection.proposalId ||
    proposal.status !== 'pending' ||
    proposal.correctionType !== 'missing_checkout' ||
    proposal.attendanceId !== attendanceDocument.id ||
    proposal.userId !== attendance.userId ||
    proposal.workDate !== attendance.date ||
    requestedCheckOutMs !== effectiveCheckOutMs ||
    proposal.requestedCheckOutIso !==
      new Date(effectiveCheckOutMs).toISOString() ||
    typeof proposal.reason !== 'string' ||
    proposal.reason !== proposal.reason.trim() ||
    proposal.reason.length < 10 ||
    proposal.reason.length > 500 ||
    !Number.isInteger(proposal.baseRevision) ||
    proposal.baseRevision !== projection.baseShiftRevision ||
    !validSha256(proposal.baseFingerprint) ||
    proposal.baseFingerprint !==
      calculateCorrectionBaseFingerprint(attendanceDocument, proposal) ||
    timestampMs(proposal.attendanceUpdateTime) !==
      timestampMs(attendanceDocument.updateTime) ||
    timestampMs(proposal.attendanceUpdateTime) == null ||
    timestampMs(proposal.openShiftUpdateTime) == null ||
    timestampMs(proposal.configUpdateTime) == null ||
    !Number.isInteger(proposal.maxShiftDurationMinutes) ||
    proposal.maxShiftDurationMinutes < 60 ||
    proposal.maxShiftDurationMinutes > 1440 ||
    effectiveCheckOutMs - checkInMs >
      proposal.maxShiftDurationMinutes * 60 * 1000 ||
    proposal.source !== ADMINISTRATIVE_COMPLETION_SOURCE ||
    proposal.manualCorrection !== true ||
    proposal.deviceVerified !== false ||
    !validUid(proposal.proposerUid) ||
    proposal.proposerUid !== decision.proposerUid ||
    proposal.proposerAccountFingerprint !==
      accountFingerprint(proposal.proposerUid) ||
    proposedAtMs == null ||
    effectiveCheckOutMs > proposedAtMs ||
    expiresAtMs !== proposedAtMs + 24 * 60 * 60 * 1000 ||
    approvedAtMs < proposedAtMs ||
    approvedAtMs >= expiresAtMs ||
    !validSha256(proposal.proposalFingerprint) ||
    proposal.proposalFingerprint !==
      calculateCorrectionProposalFingerprint(proposal) ||
    decision.schemaVersion !== 1 ||
    decision.action !== 'attendance_missing_checkout_correction_review' ||
    decision.decisionId !== projection.proposalId ||
    decision.proposalId !== projection.proposalId ||
    decision.proposalFingerprint !== proposal.proposalFingerprint ||
    decision.attendanceId !== attendanceDocument.id ||
    decision.userId !== attendance.userId ||
    decision.workDate !== attendance.date ||
    decision.correctionType !== 'missing_checkout' ||
    decision.decision !== 'approve' ||
    decision.status !== 'approved' ||
    decision.correctionEventId !== projection.correctionEventId ||
    decision.effectiveProjectionId !== attendanceDocument.id ||
    decision.source !== ADMINISTRATIVE_COMPLETION_SOURCE ||
    decision.manualCorrection !== true ||
    decision.deviceVerified !== false ||
    !validUid(decision.reviewerUid) ||
    decision.reviewerUid === proposal.proposerUid ||
    decision.proposerAccountFingerprint !==
      accountFingerprint(proposal.proposerUid) ||
    decision.reviewerAccountFingerprint !==
      accountFingerprint(decision.reviewerUid) ||
    reviewedAtMs !== approvedAtMs ||
    event.schemaVersion !== 1 ||
    event.action !== 'attendance_missing_checkout_corrected' ||
    event.eventId !== projection.correctionEventId ||
    event.proposalId !== projection.proposalId ||
    event.decisionId !== projection.proposalId ||
    event.attendanceId !== attendanceDocument.id ||
    event.userId !== attendance.userId ||
    event.workDate !== attendance.date ||
    event.correctionType !== 'missing_checkout' ||
    event.revision !== 1 ||
    event.baseRevision !== proposal.baseRevision ||
    event.baseShiftRevision !== proposal.baseRevision ||
    event.baseFingerprint !== proposal.baseFingerprint ||
    event.attendanceUpdateTime !== proposal.attendanceUpdateTime ||
    event.openShiftUpdateTime !== proposal.openShiftUpdateTime ||
    event.configUpdateTime !== proposal.configUpdateTime ||
    event.maxShiftDurationMinutes !==
      proposal.maxShiftDurationMinutes ||
    event.reason !== proposal.reason ||
    event.proposerUid !== proposal.proposerUid ||
    event.reviewerUid !== decision.reviewerUid ||
    event.proposerAccountFingerprint !==
      accountFingerprint(proposal.proposerUid) ||
    event.reviewerAccountFingerprint !==
      accountFingerprint(decision.reviewerUid) ||
    event.source !== ADMINISTRATIVE_COMPLETION_SOURCE ||
    event.manualCorrection !== true ||
    event.deviceVerified !== false ||
    event.canonicalAttendanceChanged !== false ||
    timestampMs(event.proposedAt) !== proposedAtMs ||
    timestampMs(event.originalCheckIn) !== checkInMs ||
    timestampMs(event.effectiveCheckOut) !== effectiveCheckOutMs ||
    event.effectiveWorkHours !== expectedHours ||
    timestampMs(event.approvedAt) !== approvedAtMs
  ) {
    failPreflight('chain dual-control correction tidak lengkap', attendanceDocument.id);
  }
  return projection;
};

const hasForbiddenControlCharacter = value =>
  [...value].some(character => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127;
  });

const validateCorrectionProposalDocument = proposalDocument => {
  const proposal = proposalDocument.data;
  const attendanceDocument = v2ById.get(proposal.attendanceId);
  const checkInMs = timestampMs(attendanceDocument?.data?.checkIn);
  const requestedCheckOutMs = timestampMs(proposal.requestedCheckOut);
  const proposedAtMs = timestampMs(proposal.proposedAt);
  const expiresAtMs = timestampMs(proposal.expiresAt);
  if (
    !hasExactKeys(proposal, correctionProposalFields) ||
    !validUuid(proposalDocument.id) ||
    proposal.proposalId !== proposalDocument.id ||
    proposal.schemaVersion !== 1 ||
    proposal.action !== 'attendance_missing_checkout_correction' ||
    proposal.status !== 'pending' ||
    proposal.correctionType !== 'missing_checkout' ||
    !attendanceDocument ||
    proposal.attendanceId !== attendanceDocument.id ||
    proposal.userId !== attendanceDocument.data.userId ||
    proposal.workDate !== attendanceDocument.data.date ||
    requestedCheckOutMs == null ||
    proposal.requestedCheckOutIso !==
      new Date(requestedCheckOutMs).toISOString() ||
    typeof proposal.reason !== 'string' ||
    proposal.reason !== proposal.reason.trim() ||
    proposal.reason.length < 10 ||
    proposal.reason.length > 500 ||
    hasForbiddenControlCharacter(proposal.reason) ||
    !Number.isInteger(proposal.baseRevision) ||
    proposal.baseRevision < 1 ||
    !validSha256(proposal.baseFingerprint) ||
    timestampMs(proposal.attendanceUpdateTime) == null ||
    timestampMs(proposal.openShiftUpdateTime) == null ||
    timestampMs(proposal.configUpdateTime) == null ||
    !Number.isInteger(proposal.maxShiftDurationMinutes) ||
    proposal.maxShiftDurationMinutes < 60 ||
    proposal.maxShiftDurationMinutes > 1440 ||
    checkInMs == null ||
    requestedCheckOutMs <= checkInMs ||
    requestedCheckOutMs - checkInMs >
      proposal.maxShiftDurationMinutes * 60 * 1000 ||
    proposedAtMs == null ||
    requestedCheckOutMs > proposedAtMs ||
    expiresAtMs !== proposedAtMs + 24 * 60 * 60 * 1000 ||
    timestampMs(proposal.attendanceUpdateTime) > proposedAtMs ||
    timestampMs(proposal.openShiftUpdateTime) > proposedAtMs ||
    timestampMs(proposal.configUpdateTime) > proposedAtMs ||
    proposal.source !== ADMINISTRATIVE_COMPLETION_SOURCE ||
    proposal.manualCorrection !== true ||
    proposal.deviceVerified !== false ||
    !validUid(proposal.proposerUid) ||
    proposal.proposerAccountFingerprint !==
      accountFingerprint(proposal.proposerUid) ||
    !validSha256(proposal.proposalFingerprint) ||
    proposal.proposalFingerprint !==
      calculateCorrectionProposalFingerprint(proposal)
  ) {
    failPreflight(
      'proposal correction tidak canonical',
      proposalDocument.id
    );
  }
  return proposal;
};

const validateCorrectionDecisionDocument = decisionDocument => {
  const decision = decisionDocument.data;
  const proposalDocument =
    correctionProposalById.get(decisionDocument.id);
  const proposal = proposalDocument?.data;
  const reviewedAtMs = timestampMs(decision.reviewedAt);
  const proposedAtMs = timestampMs(proposal?.proposedAt);
  const approved = decision.decision === 'approve';
  const rejected = decision.decision === 'reject';
  const validApprovedProjection =
    validCorrectionByAttendanceId.get(decision.attendanceId);
  if (
    !hasExactKeys(decision, correctionDecisionFields) ||
    !validUuid(decisionDocument.id) ||
    decision.schemaVersion !== 1 ||
    decision.action !==
      'attendance_missing_checkout_correction_review' ||
    decision.decisionId !== decisionDocument.id ||
    decision.proposalId !== decisionDocument.id ||
    !proposal ||
    decision.proposalFingerprint !== proposal.proposalFingerprint ||
    decision.attendanceId !== proposal.attendanceId ||
    decision.userId !== proposal.userId ||
    decision.workDate !== proposal.workDate ||
    decision.correctionType !== proposal.correctionType ||
    (!approved && !rejected) ||
    decision.status !== (approved ? 'approved' : 'rejected') ||
    decision.source !== ADMINISTRATIVE_COMPLETION_SOURCE ||
    decision.manualCorrection !== true ||
    decision.deviceVerified !== false ||
    decision.proposerUid !== proposal.proposerUid ||
    decision.proposerAccountFingerprint !==
      accountFingerprint(proposal.proposerUid) ||
    !validUid(decision.reviewerUid) ||
    decision.reviewerUid === proposal.proposerUid ||
    decision.reviewerAccountFingerprint !==
      accountFingerprint(decision.reviewerUid) ||
    reviewedAtMs == null ||
    proposedAtMs == null ||
    reviewedAtMs < proposedAtMs ||
    (approved &&
      (decision.correctionEventId !== decisionDocument.id ||
        decision.effectiveProjectionId !== proposal.attendanceId ||
        validApprovedProjection?.proposalId !== decisionDocument.id)) ||
    (rejected &&
      (decision.correctionEventId != null ||
        decision.effectiveProjectionId != null ||
        correctionEventById.has(decisionDocument.id)))
  ) {
    failPreflight(
      'decision correction tidak canonical atau orphan',
      decisionDocument.id
    );
  }
};

const proofFields = action => ({
  challengeId: action === 'checkIn'
    ? 'checkIn'
    : 'checkOut',
  timestamp: action,
  path: `${action}PhotoPath`,
  generation: `${action}PhotoGeneration`,
  sha256: `${action}PhotoHash`,
  perceptualHash: `${action}PhotoPerceptualHash`,
  perceptualHashes: `${action}PhotoPerceptualHashes`,
  md5Hash: `${action}PhotoMd5Hash`,
  crc32c: `${action}PhotoCrc32c`,
});

const proofsByHash = new Map();
for (const attendanceDocument of authoritativeV2Attendances) {
  const attendance = attendanceDocument.data;
  for (const action of ['checkIn', 'checkOut']) {
    const fields = proofFields(action);
    const actionMs = timestampMs(attendance[fields.timestamp]);
    if (action === 'checkOut' && actionMs == null) continue;
    const challengeId = attendance.challengeIds?.[fields.challengeId];
    const sha256 = attendance[fields.sha256];
    const path = attendance[fields.path];
    const generation = attendance[fields.generation];
    const perceptualHash = attendance[fields.perceptualHash];
    const perceptualHashes = attendance[fields.perceptualHashes];
    if (
      actionMs == null ||
      !validUuid(challengeId) ||
      path !== `attendanceProofs/${attendance.userId}/${challengeId}` ||
      typeof generation !== 'string' ||
      !/^\d+$/.test(generation) ||
      !validSha256(sha256) ||
      !validPerceptualHash(perceptualHash) ||
      !validPerceptualHashes(perceptualHashes) ||
      perceptualHashes[0] !== perceptualHash
    ) {
      failPreflight(`proof ${action} v2 tidak canonical`, attendanceDocument.id);
    }
    if (proofsByHash.has(sha256)) {
      failPreflight('SHA proof v2 terduplikasi', sha256);
    }
    proofsByHash.set(sha256, {
      action,
      attendanceId: attendanceDocument.id,
      challengeId,
      createdAtMs: actionMs,
      crc32c: attendance[fields.crc32c],
      generation,
      md5Hash: attendance[fields.md5Hash],
      path,
      perceptualHash,
      perceptualHashes,
      sha256,
      uid: attendance.userId,
    });
  }
}

const exactHashFields = [
  'uid',
  'action',
  'attendanceId',
  'challengeId',
  'photoPath',
  'generation',
  'sha256',
  'perceptualHash',
  'perceptualHashes',
  'md5Hash',
  'crc32c',
  'createdAt',
];
const perceptualAuditFields = [
  'schemaVersion',
  'proofId',
  'uid',
  'action',
  'attendanceId',
  'challengeId',
  'photoPath',
  'generation',
  'sha256',
  'perceptualHash',
  'perceptualHashes',
  'hashVersion',
  'createdAt',
];

for (const [sha256, proof] of proofsByHash) {
  const exact = exactHashById.get(sha256)?.data;
  const audit = perceptualAuditById.get(sha256)?.data;
  if (
    !exact ||
    !hasExactKeys(exact, exactHashFields) ||
    exact.uid !== proof.uid ||
    exact.action !== proof.action ||
    exact.attendanceId !== proof.attendanceId ||
    exact.challengeId !== proof.challengeId ||
    exact.photoPath !== proof.path ||
    exact.generation !== proof.generation ||
    exact.sha256 !== proof.sha256 ||
    exact.perceptualHash !== proof.perceptualHash ||
    JSON.stringify(exact.perceptualHashes) !==
      JSON.stringify(proof.perceptualHashes) ||
    exact.md5Hash !== proof.md5Hash ||
    exact.crc32c !== proof.crc32c ||
    timestampMs(exact.createdAt) !== proof.createdAtMs
  ) {
    failPreflight('exact replay index tidak cocok', sha256);
  }
  if (
    !audit ||
    !hasExactKeys(audit, perceptualAuditFields) ||
    audit.schemaVersion !== PERCEPTUAL_AUDIT_SCHEMA_VERSION ||
    audit.proofId !== sha256 ||
    audit.uid !== proof.uid ||
    audit.action !== proof.action ||
    audit.attendanceId !== proof.attendanceId ||
    audit.challengeId !== proof.challengeId ||
    audit.photoPath !== proof.path ||
    audit.generation !== proof.generation ||
    audit.sha256 !== proof.sha256 ||
    audit.perceptualHash !== proof.perceptualHash ||
    JSON.stringify(audit.perceptualHashes) !==
      JSON.stringify(proof.perceptualHashes) ||
    audit.hashVersion !== PERCEPTUAL_HASH_VERSION ||
    timestampMs(audit.createdAt) !== proof.createdAtMs
  ) {
    failPreflight('perceptual replay audit tidak cocok', sha256);
  }
}

for (const document of exactProofHashes) {
  if (!proofsByHash.has(document.id)) {
    failPreflight('orphan exact replay index', document.id);
  }
}
for (const document of perceptualProofAudits) {
  if (!proofsByHash.has(document.id)) {
    failPreflight('orphan perceptual replay audit', document.id);
  }
}

const nibbleBits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
const hashDistance = (left, right) => {
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    distance += nibbleBits[
      Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16)
    ];
  }
  return distance;
};
const minimumViewDistance = (left, right) =>
  Math.min(...left.flatMap(leftHash =>
    right.map(rightHash => hashDistance(leftHash, rightHash))
  ));
const replayStateFields = [
  'schemaVersion',
  'hashVersion',
  'uid',
  'windowMs',
  'maxEntries',
  'entries',
  'updatedAtMs',
];
const replayEntryFields = ['proofId', 'perceptualHashes', 'createdAtMs'];
const activeCutoffMs = migrationTime.getTime() - PERCEPTUAL_REPLAY_WINDOW_MS;

for (const stateDocument of replayStates) {
  const state = stateDocument.data;
  const legacyCapacity = state.maxEntries === 60;
  if (
    !hasExactKeys(state, replayStateFields) ||
    state.schemaVersion !== PERCEPTUAL_REPLAY_SCHEMA_VERSION ||
    state.hashVersion !== PERCEPTUAL_HASH_VERSION ||
    state.uid !== stateDocument.id ||
    state.windowMs !== PERCEPTUAL_REPLAY_WINDOW_MS ||
    (!legacyCapacity &&
      state.maxEntries !== PERCEPTUAL_REPLAY_MAX_ENTRIES) ||
    !Array.isArray(state.entries) ||
    state.entries.length < 1 ||
    state.entries.length > state.maxEntries ||
    !Number.isSafeInteger(state.updatedAtMs)
  ) {
    failPreflight('rolling replay state tidak canonical', stateDocument.id);
  }
  let prior = null;
  const seenProofIds = new Set();
  for (const entry of state.entries) {
    const proof = proofsByHash.get(entry.proofId);
    if (
      !hasExactKeys(entry, replayEntryFields) ||
      !proof ||
      proof.uid !== stateDocument.id ||
      !validPerceptualHashes(entry.perceptualHashes) ||
      JSON.stringify(entry.perceptualHashes) !==
        JSON.stringify(proof.perceptualHashes) ||
      entry.createdAtMs !== proof.createdAtMs ||
      seenProofIds.has(entry.proofId) ||
      (prior &&
        (prior.createdAtMs > entry.createdAtMs ||
          (prior.createdAtMs === entry.createdAtMs &&
            prior.proofId >= entry.proofId)))
    ) {
      failPreflight('rolling replay entry tidak canonical', stateDocument.id);
    }
    seenProofIds.add(entry.proofId);
    prior = entry;
  }
  if (state.updatedAtMs !== prior.createdAtMs) {
    failPreflight('rolling replay updatedAt tidak canonical', stateDocument.id);
  }
  for (let left = 0; left < state.entries.length; left++) {
    for (let right = left + 1; right < state.entries.length; right++) {
      if (minimumViewDistance(
        state.entries[left].perceptualHashes,
        state.entries[right].perceptualHashes
      ) <= 6) {
        failPreflight('near-duplicate internal pada replay state', stateDocument.id);
      }
    }
  }
  if (legacyCapacity) {
    operations.push({
      kind: 'replay-state-capacity-upgrade',
      document: stateDocument,
      fields: { maxEntries: PERCEPTUAL_REPLAY_MAX_ENTRIES },
    });
  }
}

for (const proof of proofsByHash.values()) {
  if (proof.createdAtMs <= activeCutoffMs) continue;
  const state = replayStateByUid.get(proof.uid)?.data;
  const entry = state?.entries?.find(item => item.proofId === proof.sha256);
  if (
    !entry ||
    entry.createdAtMs !== proof.createdAtMs ||
    JSON.stringify(entry.perceptualHashes) !==
      JSON.stringify(proof.perceptualHashes)
  ) {
    failPreflight('proof aktif tidak tercakup rolling replay state', proof.sha256);
  }
}

const pointerBaseFields = [
  'schemaVersion',
  'uid',
  'revision',
  'status',
  'attendanceId',
  'workDate',
  'checkInAt',
  'closedAt',
  'createdAt',
  'updatedAt',
];
const unresolvedByUid = new Map();
const validCorrectionByAttendanceId = new Map();
const authoritativeAttendancesByUid = new Map();
for (const attendanceDocument of authoritativeV2Attendances) {
  const attendance = attendanceDocument.data;
  const userAttendances =
    authoritativeAttendancesByUid.get(attendance.userId) || [];
  userAttendances.push(attendanceDocument);
  authoritativeAttendancesByUid.set(attendance.userId, userAttendances);
  const correction = validateCorrectionChain(attendanceDocument);
  const strictOpen = hasNoCheckoutEvidence(attendance) && !correction;
  const strictDeviceComplete =
    hasStrictDeviceCheckoutEvidence(attendance) && !correction;
  const strictManualCorrected =
    hasNoCheckoutEvidence(attendance) && Boolean(correction);
  const stateCount = [
    strictOpen,
    strictDeviceComplete,
    strictManualCorrected,
  ].filter(Boolean).length;
  if (stateCount !== 1) {
    failPreflight(
      'attendance v2 bukan strict-open/device-complete/manual-corrected',
      attendanceDocument.id
    );
  }
  if (correction) {
    validCorrectionByAttendanceId.set(attendanceDocument.id, correction);
  }
  if (strictOpen) {
    if (unresolvedByUid.has(attendance.userId)) {
      failPreflight('lebih dari satu attendance v2 terbuka', attendance.userId);
    }
    unresolvedByUid.set(attendance.userId, attendanceDocument);
  }
}

for (const projectionDocument of correctionEffectiveViews) {
  if (!v2ById.has(projectionDocument.id)) {
    failPreflight('orphan correction effective view', projectionDocument.id);
  }
}
for (const proposalDocument of correctionProposals) {
  validateCorrectionProposalDocument(proposalDocument);
}
for (const decisionDocument of correctionDecisions) {
  validateCorrectionDecisionDocument(decisionDocument);
}
for (const eventDocument of correctionEvents) {
  const event = eventDocument.data;
  const projection = validCorrectionByAttendanceId.get(event.attendanceId);
  if (
    eventDocument.id !== event.eventId ||
    projection?.proposalId !== eventDocument.id
  ) {
    failPreflight('orphan attendance correction event', eventDocument.id);
  }
}

for (const pointerDocument of openShifts) {
  const pointer = pointerDocument.data;
  const attendanceDocument = v2ById.get(pointer.attendanceId);
  const extraFields = pointer.status === 'open'
    ? []
    : pointer.status === 'closed'
      ? pointer.closureSource === 'verified-checkout'
        ? ['closureSource', 'checkOutChallengeId']
        : pointer.closureSource === 'administrative-correction'
          ? ['closureSource', 'correctionId']
          : null
      : null;
  const pointerCheckInMs = timestampMs(pointer.checkInAt);
  const pointerCreatedAtMs = timestampMs(pointer.createdAt);
  const pointerUpdatedAtMs = timestampMs(pointer.updatedAt);
  const pointerClosedAtMs = timestampMs(pointer.closedAt);
  if (
    extraFields == null ||
    !hasExactKeys(pointer, [...pointerBaseFields, ...extraFields]) ||
    pointer.schemaVersion !== OPEN_SHIFT_SCHEMA_VERSION ||
    pointer.uid !== pointerDocument.id ||
    pointer.uid !== attendanceDocument?.data?.userId ||
    !Number.isInteger(pointer.revision) ||
    pointer.revision < 1 ||
    !attendanceDocument ||
    pointer.attendanceId !== attendanceDocument.id ||
    pointer.workDate !== attendanceDocument.data.date ||
    pointerCheckInMs !== timestampMs(attendanceDocument.data.checkIn) ||
    pointerCreatedAtMs !== pointerCheckInMs ||
    pointerUpdatedAtMs == null ||
    pointerUpdatedAtMs < pointerCreatedAtMs ||
    (pointer.status === 'closed' &&
      (pointerClosedAtMs == null ||
        pointerClosedAtMs < pointerCheckInMs ||
        pointerUpdatedAtMs < pointerClosedAtMs))
  ) {
    failPreflight('open-shift pointer tidak canonical', pointerDocument.id);
  }
  const attendance = attendanceDocument.data;
  if (pointer.status === 'open') {
    if (
      pointer.closedAt != null ||
      !hasNoCheckoutEvidence(attendance) ||
      validCorrectionByAttendanceId.has(attendanceDocument.id) ||
      unresolvedByUid.get(pointer.uid)?.id !== attendanceDocument.id
    ) {
      failPreflight('pointer open tidak cocok dua arah', pointerDocument.id);
    }
  } else if (pointer.closureSource === 'verified-checkout') {
    if (
      timestampMs(attendance.checkOut) == null ||
      !hasStrictDeviceCheckoutEvidence(attendance) ||
      timestampMs(pointer.closedAt) !== timestampMs(attendance.checkOut) ||
      pointer.checkOutChallengeId !== attendance.challengeIds?.checkOut
    ) {
      failPreflight('pointer verified-checkout tidak cocok', pointerDocument.id);
    }
  } else {
    const correction =
      validCorrectionByAttendanceId.get(attendanceDocument.id);
    if (
      !correction ||
      !hasNoCheckoutEvidence(attendance) ||
      pointer.correctionId !== correction.proposalId ||
      timestampMs(pointer.closedAt) !==
        timestampMs(correction.effectiveCheckOut)
    ) {
      failPreflight('pointer administrative-correction tidak cocok', pointerDocument.id);
    }
  }
}

for (const [uid, userAttendances] of authoritativeAttendancesByUid) {
  const ordered = [...userAttendances].sort((left, right) => {
    const timeOrder =
      timestampMs(right.data.checkIn) - timestampMs(left.data.checkIn);
    return timeOrder || right.id.localeCompare(left.id);
  });
  const latestAttendance = ordered[0];
  const pointer = openShiftByUid.get(uid)?.data;
  if (
    !pointer ||
    pointer.attendanceId !== latestAttendance.id ||
    pointer.revision !== ordered.length
  ) {
    failPreflight(
      'pointer wajib menunjuk attendance v2 terbaru dengan revision utuh',
      uid
    );
  }
}

for (const [uid, attendanceDocument] of unresolvedByUid) {
  const pointer = openShiftByUid.get(uid)?.data;
  if (
    !pointer ||
    pointer.status !== 'open' ||
    pointer.attendanceId !== attendanceDocument.id
  ) {
    failPreflight('attendance v2 terbuka tidak punya pointer', attendanceDocument.id);
  }
}

const needsSecurityCutover =
  defaultConfig.data.geofenceTransitionMode !== false ||
  defaultConfig.data.attendanceSecurityVersion !== 2;
if (needsSecurityCutover) {
  const shiftDuration =
    configuredShiftDuration == null ? 1440 : configuredShiftDuration;
  const cutoverFields = {
    geofenceTransitionMode: false,
    attendanceSecurityVersion: 2,
    maxAttendanceShiftDurationMinutes: shiftDuration,
  };
  if (!existingSecurityCutoverTrusted) {
    cutoverFields.attendanceSecurityCutoverAt = migrationTime;
  }
  operations.push({
    kind: 'project-security-cutover',
    document: defaultConfig,
    fields: cutoverFields,
  });
} else if (configuredShiftDuration == null) {
  operations.push({
    kind: 'project-shift-policy',
    document: defaultConfig,
    fields: {
      maxAttendanceShiftDurationMinutes: 1440,
    },
  });
}

const counts = operations.reduce((result, operation) => {
  result[operation.kind] = (result[operation.kind] || 0) + 1;
  return result;
}, {});
const cutoverOperations = operations.filter(
  operation => operation.kind === 'project-security-cutover'
);
if (cutoverOperations.length > 1) {
  failPreflight('lebih dari satu operasi aktivasi cutover');
}
const preparatoryOperations = operations.filter(
  operation => operation.kind !== 'project-security-cutover'
);
console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'dry-run',
  preflight: {
    authoritativeV2Attendances: authoritativeV2Attendances.length,
    canonicalProofs: proofsByHash.size,
    exactReplayIndexes: exactProofHashes.length,
    perceptualReplayAudits: perceptualProofAudits.length,
    rollingReplayStates: replayStates.length,
    openShiftPointers: openShifts.length,
    effectiveCorrections: correctionEffectiveViews.length,
    blockers: 0,
  },
  operations: counts,
  cutover: {
    planned: cutoverOperations.length === 1,
    requiresSeparateApply:
      cutoverOperations.length === 1 && preparatoryOperations.length > 0,
  },
}, null, 2));

if (!APPLY) {
  console.log('Tidak ada data yang ditulis. Jalankan ulang dengan --apply setelah review.');
  process.exit(0);
}

const applyOperations = async pendingOperations => {
  for (let index = 0; index < pendingOperations.length; index += 10) {
    await Promise.all(
      pendingOperations.slice(index, index + 10).map(operation =>
        patchDocument(operation.document, operation.fields)
      )
    );
  }
};

await applyOperations(preparatoryOperations);

if (cutoverOperations.length === 1 && preparatoryOperations.length > 0) {
  console.log(
    'Write persiapan selesai, tetapi cutover belum diaktifkan. ' +
    'Jalankan ulang --apply agar seluruh preflight dibaca ulang dan ' +
    'cutover menjadi satu-satunya write pada proses berikutnya.'
  );
  process.exit(0);
}

if (cutoverOperations.length === 1) {
  const originalCollections = [
    ['users', users],
    ['kelurahan', kelurahan],
    ['kantor', kantor],
    ['attendances', attendances],
    ['projectConfig', projectConfig],
    ['attendanceOpenShifts', openShifts],
    ['attendancePerceptualReplayStates', replayStates],
    ['attendanceProofHashes', exactProofHashes],
    ['attendanceProofPerceptualHashes', perceptualProofAudits],
    ['attendanceCorrectionEffectiveViews', correctionEffectiveViews],
    ['attendanceCorrectionProposals', correctionProposals],
    ['attendanceCorrectionDecisions', correctionDecisions],
    ['attendanceCorrectionEvents', correctionEvents],
  ];
  const snapshotFingerprint = documents =>
    documents
      .map(document => `${document.id}\u0000${document.updateTime}`)
      .sort()
      .join('\u0001');
  const refreshedCollections = await Promise.all(
    originalCollections.map(([collectionId]) =>
      listDocuments(collectionId)
    )
  );
  originalCollections.forEach(([collectionId, original], index) => {
    if (
      snapshotFingerprint(original) !==
      snapshotFingerprint(refreshedCollections[index])
    ) {
      failPreflight(
        'data berubah setelah preflight; cutover dibatalkan',
        collectionId
      );
    }
  });
  await Promise.all(
    cutoverOperations.map(operation =>
      patchDocument(operation.document, operation.fields)
    )
  );
}

console.log(
  `Migration selesai: ${operations.length} document diperbarui secara fail-closed.`
);
