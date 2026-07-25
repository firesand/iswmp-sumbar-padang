#!/usr/bin/env node

/**
 * Read-only production security-state audit. It intentionally prints counts,
 * states, role bindings, and key IDs—not access tokens, key material, or user
 * profile data.
 */

import authModule from 'firebase-tools/lib/auth.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const attendanceCore = require('../functions/attendance-core.js');
const attendanceCorrections = require('../functions/attendance-corrections.js');

const PROJECT_ID = 'iswmp-sumbar-padang';
const PROJECT_NUMBER = '1079074812491';
const WEB_APP_ID = '1:1079074812491:web:28a1a3fa33933c5ca9d3ce';
const BUCKET = 'iswmp-sumbar-padang.firebasestorage.app';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RUNTIME_EMAIL =
  `attendance-runtime@${PROJECT_ID}.iam.gserviceaccount.com`;

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
  if (!response.ok) {
    const error = new Error(body?.error?.message || `${response.status} ${url}`);
    error.status = response.status;
    throw error;
  }
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
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, nested]) => [key, decodeValue(nested)])
    );
  }
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  return null;
};

const decodeDocument = document => ({
  id: document.name.split('/').pop(),
  createTime: document.createTime
    ? new Date(Date.parse(document.createTime)).toISOString()
    : null,
  updateTime: document.updateTime
    ? new Date(Date.parse(document.updateTime)).toISOString()
    : null,
  data: Object.fromEntries(
    Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)])
  ),
});

const listDocuments = async collectionId => {
  const documents = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ pageSize: '300', showMissing: 'false' });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await api(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collectionId}?${query}`
    );
    documents.push(...(result.documents || []).map(decodeDocument));
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return documents;
};

const safe = async operation => {
  try {
    return await operation();
  } catch (error) {
    return { auditError: error.message, status: error.status || null };
  }
};

const [users, kelurahan, kantor, attendances, projectConfig, proofHashes,
  perceptualProofHashes, perceptualReplayStates, attendanceOpenShifts,
  attendanceCorrectionEffectiveViews, attendanceChallenges,
  attendanceCorrectionProposals, attendanceCorrectionDecisions,
  attendanceCorrectionEvents, geofenceVerificationAudits, iamPolicy,
  appCheckServices, webAppCheck, functions, serviceAccountKeys, bucketIamPolicy,
  runtimeIamPolicy, rulesReleases] =
await Promise.all([
  listDocuments('users'),
  listDocuments('kelurahan'),
  listDocuments('kantor'),
  listDocuments('attendances'),
  listDocuments('projectConfig'),
  listDocuments('attendanceProofHashes'),
  listDocuments('attendanceProofPerceptualHashes'),
  listDocuments('attendancePerceptualReplayStates'),
  listDocuments('attendanceOpenShifts'),
  listDocuments('attendanceCorrectionEffectiveViews'),
  listDocuments('attendanceChallenges'),
  listDocuments('attendanceCorrectionProposals'),
  listDocuments('attendanceCorrectionDecisions'),
  listDocuments('attendanceCorrectionEvents'),
  listDocuments('geofenceVerificationAuditLogs'),
  safe(() => api(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}:getIamPolicy`,
    { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) }
  )),
  safe(() => api(
    `https://firebaseappcheck.googleapis.com/v1/projects/${PROJECT_NUMBER}/services`
  )),
  safe(() => api(
    `https://firebaseappcheck.googleapis.com/v1/projects/${PROJECT_NUMBER}/apps/${encodeURIComponent(WEB_APP_ID)}/recaptchaEnterpriseConfig`
  )),
  safe(() => api(
    `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT_ID}/locations/-/functions`
  )),
  safe(() => api(
    `https://iam.googleapis.com/v1/projects/${PROJECT_ID}/serviceAccounts/firebase-adminsdk-fbsvc%40${PROJECT_ID}.iam.gserviceaccount.com/keys`
  )),
  safe(() => api(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/iam`)),
  safe(() => api(
    `https://iam.googleapis.com/v1/projects/${PROJECT_ID}/serviceAccounts/` +
      `${encodeURIComponent(RUNTIME_EMAIL)}:getIamPolicy`,
    { method: 'POST', body: '{}' }
  )),
  safe(() => api(
    `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/releases`
  )),
]);

const rulesetForRelease = async releaseName => {
  const release = Array.isArray(rulesReleases.releases)
    ? rulesReleases.releases.find(item => item.name === releaseName)
    : null;
  if (!release?.rulesetName) {
    return { releaseName, auditError: 'Rules release tidak ditemukan.' };
  }
  const ruleset = await safe(() => api(
    `https://firebaserules.googleapis.com/v1/${release.rulesetName}`
  ));
  return { releaseName, release, ruleset };
};

const [firestoreRulesDeployment, storageRulesDeployment] = await Promise.all([
  rulesetForRelease(`projects/${PROJECT_ID}/releases/cloud.firestore`),
  rulesetForRelease(
    `projects/${PROJECT_ID}/releases/firebase.storage/${BUCKET}`
  ),
]);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const iamFingerprint = value => sha256(
  `attendance-iam-audit-v1\u0000${String(value)}`
).slice(0, 16);
const summarizeRulesDeployment = (deployment, localUrl) => {
  const deployedSource = deployment.ruleset?.source?.files?.[0]?.content;
  const localSource = readFileSync(localUrl, 'utf8');
  return {
    releaseName: deployment.releaseName,
    rulesetName: deployment.release?.rulesetName || null,
    updateTime: deployment.release?.updateTime || null,
    deployedSha256: typeof deployedSource === 'string'
      ? sha256(deployedSource)
      : null,
    localSha256: sha256(localSource),
    matchesLocal: typeof deployedSource === 'string'
      ? deployedSource === localSource
      : false,
    auditError: deployment.auditError || deployment.ruleset?.auditError || null,
  };
};

const canonicalAssignment = user => {
  if (user.assignmentType === 'kelurahan' && user.kelurahanId) return true;
  if (user.assignmentType === 'kantor' && user.kantorId) return true;
  return false;
};

const userSummary = users.reduce((summary, { data }) => {
  const role = data.role || (data.isAdmin === true ? 'admin' : 'unknown');
  summary.byRole[role] = (summary.byRole[role] || 0) + 1;
  if (data.accountStatus === 'active' && data.isActive === true) summary.active += 1;
  if (role !== 'admin' && data.isAdmin !== true && !canonicalAssignment(data)) {
    summary.nonAdminMissingCanonicalAssignment += 1;
  }
  if (!Object.hasOwn(data, 'mustChangePassword')) summary.missingPasswordFlag += 1;
  return summary;
}, {
  total: users.length,
  active: 0,
  byRole: {},
  nonAdminMissingCanonicalAssignment: 0,
  missingPasswordFlag: 0,
});

const timestampMillis = value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};
const fingerprintPattern = /^[0-9a-f]{64}$/u;
const validFingerprint = value =>
  typeof value === 'string' && fingerprintPattern.test(value);
const sameStringArray = (left, right) =>
  Array.isArray(left) && Array.isArray(right) &&
  left.length === right.length && left.every((value, index) => value === right[index]);
const hasExactKeys = (value, expectedKeys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};
const isValidWorkDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
};
const validAction = value => value === 'checkIn' || value === 'checkOut';
const validChallengeId = value =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
const validPerceptualHashes = hashes =>
  Array.isArray(hashes) &&
  hashes.length === attendanceCore.PERCEPTUAL_HASH_VIEW_COUNT &&
  hashes.every(hash =>
    new RegExp(
      `^[0-9a-f]{${attendanceCore.PERCEPTUAL_HASH_HEX_LENGTH}}$`
    ).test(hash)
  );

const auditsById = new Map(geofenceVerificationAudits.map(item => [item.id, item]));
const allGeofences = [
  ...kelurahan.map(item => ({ ...item, type: 'kelurahan' })),
  ...kantor.map(item => ({ ...item, type: 'kantor' })),
];

const geofenceAssessments = allGeofences.map(({ id, data, type }) => {
  const auditId = typeof data.verificationAuditId === 'string'
    ? data.verificationAuditId
    : null;
  const auditDocument = auditId ? auditsById.get(auditId) : null;
  const audit = auditDocument?.data;
  const operatorFingerprintValid = validFingerprint(data.verificationOperator);
  const reviewerFingerprintValid = validFingerprint(
    data.verificationReviewOperator
  );
  const operatorFingerprintsDistinct = operatorFingerprintValid &&
    reviewerFingerprintValid &&
    data.verificationOperator !== data.verificationReviewOperator;
  const auditSchemaV2Approved = audit?.schemaVersion === 2 &&
    audit?.action === 'geofence_physical_verification' &&
    audit?.status === 'approved';
  const auditTargetMatches = Boolean(auditDocument) &&
    auditDocument.id === auditId && audit.auditId === auditId &&
    audit.geofenceCollection === type && audit.geofenceId === id;

  let auditRelationshipValid = false;
  try {
    const normalized = attendanceCore.normalizeGeofence(
      data,
      id,
      timestampMillis(data.verifiedAt),
      timestampMillis(data.verificationReviewedAt),
    );
    attendanceCore.assertGeofenceAudit(
      audit,
      { collection: type, ...normalized },
      timestampMillis(audit?.createdAt),
      timestampMillis(audit?.proposedAt),
    );
    auditRelationshipValid = true;
  } catch {
    auditRelationshipValid = false;
  }

  return {
    auditId,
    auditRelationshipValid,
    output: {
      type,
      id,
      active: data.isActive === true,
      coordinateStatus: data.coordinateStatus || null,
      verifiedAt: data.verifiedAt || null,
      presenceProofRequired: data.presenceProofRequired === true,
      dualControlAudit: {
        referencedAuditFound: Boolean(auditDocument),
        schemaV2Approved: auditSchemaV2Approved,
        operatorFingerprintValid,
        reviewerFingerprintValid,
        operatorFingerprintsDistinct,
        targetMatchesGeofence: auditTargetMatches,
        relationshipValid: auditRelationshipValid,
      },
      securityReady: data.isActive === true && auditRelationshipValid,
    },
  };
});

const geofenceSummary = geofenceAssessments.map(item => item.output);
const referencedAuditIds = new Set(
  geofenceAssessments.map(item => item.auditId).filter(Boolean)
);
const approvedAudit = ({ data }) =>
  data.schemaVersion === 2 &&
  data.action === 'geofence_physical_verification' &&
  data.status === 'approved';
const distinctAuditAccounts = ({ data }) =>
  validFingerprint(data.operatorAccountFingerprint) &&
  validFingerprint(data.reviewOperatorAccountFingerprint) &&
  data.operatorAccountFingerprint !== data.reviewOperatorAccountFingerprint;

const geofenceAuditSummary = {
  total: geofenceVerificationAudits.length,
  schemaV2: geofenceVerificationAudits.filter(({ data }) =>
    data.schemaVersion === 2).length,
  statusPending: geofenceVerificationAudits.filter(({ data }) =>
    data.status === 'pending').length,
  statusApproved: geofenceVerificationAudits.filter(({ data }) =>
    data.status === 'approved').length,
  schemaV2Approved: geofenceVerificationAudits.filter(approvedAudit).length,
  schemaV2ApprovedWithDistinctOperatorFingerprints:
    geofenceVerificationAudits.filter(item =>
      approvedAudit(item) && distinctAuditAccounts(item)).length,
  referencedByGeofence: geofenceVerificationAudits.filter(item =>
    referencedAuditIds.has(item.id)).length,
  approvedButUnreferenced: geofenceVerificationAudits.filter(item =>
    approvedAudit(item) && !referencedAuditIds.has(item.id)).length,
  validGeofenceRelationships: geofenceAssessments.filter(item =>
    item.auditRelationshipValid).length,
};

const geofenceReadinessSummary = {
  total: geofenceAssessments.length,
  active: geofenceAssessments.filter(item => item.output.active).length,
  dualControlSecurityReady: geofenceAssessments.filter(item =>
    item.output.securityReady).length,
  activeButNotSecurityReady: geofenceAssessments.filter(item =>
    item.output.active && !item.output.securityReady).length,
};

const attendanceSummary = attendances.reduce((summary, { data }) => {
  let key = 'legacyOrUnverified';
  if (data.integrityVersion === 2 && data.proofVersion === 2 &&
      data.verificationStatus === 'verified') {
    key = 'claimsV2Verified';
  } else if (
    data.integrityVersion === 2 &&
    data.proofVersion === 2 &&
    data.verificationMode === 'location_photo' &&
    data.verificationStatus === 'location_photo_only' &&
    data.transitionMode === true &&
    data.isWithinRadius === null &&
    data.deviceVerified === false
  ) {
    key = 'locationPhotoOnly';
  }
  summary[key] += 1;
  if (data.transitionMode === true) summary.transitionMode += 1;
  return summary;
}, {
  total: attendances.length,
  claimsV2Verified: 0,
  locationPhotoOnly: 0,
  legacyOrUnverified: 0,
  transitionMode: 0,
});

const attendanceById = new Map(attendances.map(item => [item.id, item]));
const attendanceChallengeById = new Map(
  attendanceChallenges.map(item => [item.id, item])
);
const usersById = new Map(users.map(item => [item.id, item]));
const correctionProposalById = new Map(
  attendanceCorrectionProposals.map(item => [item.id, item])
);
const correctionDecisionById = new Map(
  attendanceCorrectionDecisions.map(item => [item.id, item])
);
const correctionEventById = new Map(
  attendanceCorrectionEvents.map(item => [item.id, item])
);
const correctionEffectiveByAttendanceId = new Map(
  attendanceCorrectionEffectiveViews.map(item => [item.id, item])
);
const correctionCompletionSource =
  'dual-approved-manual-missing-checkout-v1';
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
const correctionEffectiveFields = [
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
const activeAdmin = uid => {
  const user = usersById.get(uid)?.data;
  return Boolean(user) &&
    user.accountStatus === 'active' &&
    user.isActive === true &&
    user.mustChangePassword !== true &&
    (user.role === 'admin' || user.isAdmin === true);
};
const correctionAccountFingerprint = uid => {
  try {
    return attendanceCorrections.accountFingerprint(uid);
  } catch {
    return null;
  }
};
const correctionTimestamp = milliseconds => ({
  toMillis: () => milliseconds,
});
const validCorrectionProposal = (
  document,
  attendanceDocument,
  { requireCurrentSource = false } = {},
) => {
  const proposal = document?.data;
  const attendance = attendanceDocument?.data;
  const checkInMs = timestampMillis(attendance?.checkIn);
  const requestedCheckOutMs = timestampMillis(proposal?.requestedCheckOut);
  const proposedAtMs = timestampMillis(proposal?.proposedAt);
  const expiresAtMs = timestampMillis(proposal?.expiresAt);
  let normalizedReason = null;
  let expectedProposalFingerprint = null;
  let expectedBaseFingerprint = null;
  try {
    normalizedReason = attendanceCorrections.normalizeReason(proposal?.reason);
    expectedProposalFingerprint =
      attendanceCorrections.calculateProposalFingerprint({
        ...proposal,
        proposedAt: correctionTimestamp(proposedAtMs),
        expiresAt: correctionTimestamp(expiresAtMs),
      });
    if (requireCurrentSource) {
      expectedBaseFingerprint = attendanceCorrections.calculateBaseFingerprint(
        {
          attendance,
          attendanceId: proposal.attendanceId,
          userId: proposal.userId,
          workDate: proposal.workDate,
          checkInMs,
          challengeId: attendance?.challengeIds?.checkIn,
          attendanceUpdateTime: proposal.attendanceUpdateTime,
        },
        {
          shift: {
            schemaVersion: 1,
            uid: proposal.userId,
            revision: proposal.baseRevision,
            status: 'open',
            attendanceId: proposal.attendanceId,
            workDate: proposal.workDate,
            checkInAt: correctionTimestamp(checkInMs),
            closedAt: null,
          },
          revision: proposal.baseRevision,
          updateTime: proposal.openShiftUpdateTime,
        },
        {
          minutes: proposal.maxShiftDurationMinutes,
          updateTime: proposal.configUpdateTime,
        },
      );
    }
  } catch {
    return false;
  }
  return Boolean(document) && Boolean(attendanceDocument) &&
    document.id === proposal.proposalId &&
    hasExactKeys(proposal, correctionProposalFields) &&
    validChallengeId(proposal.proposalId) &&
    proposal.schemaVersion === 1 &&
    proposal.action === 'attendance_missing_checkout_correction' &&
    proposal.status === 'pending' &&
    proposal.correctionType === 'missing_checkout' &&
    proposal.attendanceId === attendanceDocument.id &&
    proposal.userId === attendance.userId &&
    proposal.workDate === attendance.date &&
    proposal.attendanceId === `${proposal.userId}_${proposal.workDate}` &&
    Number.isFinite(requestedCheckOutMs) &&
    proposal.requestedCheckOutIso ===
      new Date(requestedCheckOutMs).toISOString() &&
    requestedCheckOutMs > checkInMs &&
    requestedCheckOutMs <= proposedAtMs &&
    normalizedReason === proposal.reason &&
    Number.isInteger(proposal.baseRevision) &&
    proposal.baseRevision >= 1 &&
    /^[0-9a-f]{64}$/.test(proposal.baseFingerprint || '') &&
    (!requireCurrentSource ||
      proposal.baseFingerprint === expectedBaseFingerprint) &&
    (!requireCurrentSource ||
      proposal.attendanceUpdateTime === attendanceDocument.updateTime) &&
    typeof proposal.openShiftUpdateTime === 'string' &&
    Number.isFinite(Date.parse(proposal.openShiftUpdateTime)) &&
    typeof proposal.configUpdateTime === 'string' &&
    Number.isFinite(Date.parse(proposal.configUpdateTime)) &&
    Number.isInteger(proposal.maxShiftDurationMinutes) &&
    proposal.maxShiftDurationMinutes >= 60 &&
    proposal.maxShiftDurationMinutes <= 1440 &&
    proposal.source === correctionCompletionSource &&
    proposal.manualCorrection === true &&
    proposal.deviceVerified === false &&
    activeAdmin(proposal.proposerUid) &&
    proposal.proposerAccountFingerprint ===
      correctionAccountFingerprint(proposal.proposerUid) &&
    Number.isFinite(proposedAtMs) &&
    expiresAtMs === proposedAtMs + attendanceCorrections.PROPOSAL_TTL_MS &&
    proposal.proposalFingerprint === expectedProposalFingerprint;
};
const validCorrectionDecision = (document, proposalDocument) => {
  const decision = document?.data;
  const proposal = proposalDocument?.data;
  const reviewedAtMs = timestampMillis(decision?.reviewedAt);
  const proposedAtMs = timestampMillis(proposal?.proposedAt);
  const expiresAtMs = timestampMillis(proposal?.expiresAt);
  const approved = decision?.decision === 'approve';
  return Boolean(document) && Boolean(proposalDocument) &&
    document.id === proposalDocument.id &&
    hasExactKeys(decision, correctionDecisionFields) &&
    decision.schemaVersion === 1 &&
    decision.action ===
      'attendance_missing_checkout_correction_review' &&
    decision.decisionId === document.id &&
    decision.proposalId === document.id &&
    decision.proposalFingerprint === proposal.proposalFingerprint &&
    decision.attendanceId === proposal.attendanceId &&
    decision.userId === proposal.userId &&
    decision.workDate === proposal.workDate &&
    decision.correctionType === proposal.correctionType &&
    (decision.decision === 'approve' || decision.decision === 'reject') &&
    decision.status === (approved ? 'approved' : 'rejected') &&
    decision.source === correctionCompletionSource &&
    decision.manualCorrection === true &&
    decision.deviceVerified === false &&
    decision.proposerUid === proposal.proposerUid &&
    decision.proposerAccountFingerprint ===
      proposal.proposerAccountFingerprint &&
    activeAdmin(decision.proposerUid) &&
    activeAdmin(decision.reviewerUid) &&
    decision.reviewerUid !== decision.proposerUid &&
    decision.reviewerAccountFingerprint ===
      correctionAccountFingerprint(decision.reviewerUid) &&
    decision.reviewerAccountFingerprint !==
      decision.proposerAccountFingerprint &&
    decision.correctionEventId === (approved ? document.id : null) &&
    decision.effectiveProjectionId ===
      (approved ? proposal.attendanceId : null) &&
    Number.isFinite(reviewedAtMs) &&
    reviewedAtMs >= proposedAtMs &&
    (!approved || reviewedAtMs < expiresAtMs);
};
const validCorrectionEffectiveView = (document, attendanceDocument) => {
  const effective = document?.data;
  const attendance = attendanceDocument?.data;
  const proposalDocument = correctionProposalById.get(effective?.proposalId);
  const proposal = proposalDocument?.data;
  const decisionDocument = correctionDecisionById.get(effective?.proposalId);
  const decision = decisionDocument?.data;
  const eventDocument = correctionEventById.get(effective?.proposalId);
  const event = eventDocument?.data;
  const checkInMs = timestampMillis(attendance?.checkIn);
  const effectiveCheckOutMs = timestampMillis(effective?.effectiveCheckOut);
  const approvedAtMs = timestampMillis(effective?.approvedAt);
  const checkInChallengeId = attendance?.challengeIds?.checkIn;
  const checkInChallenge = attendanceChallengeById.get(
    checkInChallengeId
  )?.data;
  const correctionSourceModeValid =
    (
      attendance?.verificationStatus === 'verified' &&
      attendance?.transitionMode === false
    ) ||
    (
      attendance?.verificationMode === 'location_photo' &&
      attendance?.verificationStatus === 'location_photo_only' &&
      attendance?.transitionMode === true &&
      attendance?.isWithinRadius === null &&
      attendance?.distanceFromGeofence === null &&
      attendance?.deviceVerified === false &&
      attendance?.presenceProof?.required === false &&
      attendance?.presenceProof?.verified === false &&
      attendance?.presenceProof?.reason === 'policy_location_photo' &&
      attendance?.geofenceSnapshot === null &&
      ['kelurahan', 'kantor'].includes(
        attendance?.assignmentSnapshot?.collection
      ) &&
      typeof attendance?.assignmentSnapshot?.id === 'string' &&
      typeof attendance?.assignmentSnapshot?.name === 'string'
    );
  return Boolean(document) && Boolean(attendanceDocument) &&
    document.id === attendanceDocument.id &&
    hasExactKeys(effective, correctionEffectiveFields) &&
    effective.schemaVersion === 1 &&
    effective.attendanceId === document.id &&
    effective.userId === attendance.userId &&
    effective.workDate === attendance.date &&
    effective.correctionType === 'missing_checkout' &&
    effective.revision === 1 &&
    Number.isInteger(effective.baseShiftRevision) &&
    effective.baseShiftRevision >= 1 &&
    validChallengeId(checkInChallengeId) &&
    checkInChallenge?.uid === attendance.userId &&
    checkInChallenge.action === 'checkIn' &&
    checkInChallenge.status === 'consumed' &&
    checkInChallenge.attendanceId === document.id &&
    checkInChallenge.targetAttendanceId === document.id &&
    checkInChallenge.targetWorkDate === attendance.date &&
    checkInChallenge.targetShiftRevision === effective.baseShiftRevision &&
    checkInChallenge.requestDate === attendance.date &&
    timestampMillis(checkInChallenge.consumedAt) === checkInMs &&
    attendance.integrityVersion === 2 &&
    attendance.proofVersion === 2 &&
    correctionSourceModeValid &&
    attendanceCore.wibParts(new Date(checkInMs)).date === attendance.date &&
    timestampMillis(attendance.createdAt) === checkInMs &&
    validChallengeId(effective.proposalId) &&
    effective.correctionEventId === effective.proposalId &&
    validCorrectionProposal(
      proposalDocument,
      attendanceDocument,
      { requireCurrentSource: true },
    ) &&
    validCorrectionDecision(decisionDocument, proposalDocument) &&
    decision.decision === 'approve' &&
    Boolean(eventDocument) &&
    eventDocument.id === effective.proposalId &&
    hasExactKeys(event, correctionEventFields) &&
    event.schemaVersion === 1 &&
    event.action === 'attendance_missing_checkout_corrected' &&
    event.eventId === effective.proposalId &&
    event.proposalId === effective.proposalId &&
    event.decisionId === effective.proposalId &&
    event.attendanceId === effective.attendanceId &&
    event.userId === effective.userId &&
    event.workDate === effective.workDate &&
    event.correctionType === effective.correctionType &&
    event.revision === effective.revision &&
    event.baseRevision === effective.baseShiftRevision &&
    event.baseShiftRevision === effective.baseShiftRevision &&
    event.baseFingerprint === proposal.baseFingerprint &&
    event.attendanceUpdateTime === proposal.attendanceUpdateTime &&
    event.openShiftUpdateTime === proposal.openShiftUpdateTime &&
    event.configUpdateTime === proposal.configUpdateTime &&
    event.maxShiftDurationMinutes ===
      proposal.maxShiftDurationMinutes &&
    timestampMillis(effective.originalCheckIn) === checkInMs &&
    timestampMillis(event.originalCheckIn) === checkInMs &&
    Number.isFinite(effectiveCheckOutMs) &&
    effectiveCheckOutMs > checkInMs &&
    timestampMillis(event.effectiveCheckOut) === effectiveCheckOutMs &&
    Number.isFinite(approvedAtMs) &&
    approvedAtMs >= effectiveCheckOutMs &&
    timestampMillis(event.approvedAt) === approvedAtMs &&
    timestampMillis(decision.reviewedAt) === approvedAtMs &&
    timestampMillis(event.proposedAt) ===
      timestampMillis(proposal.proposedAt) &&
    effective.effectiveWorkHours ===
      attendanceCore.calculateWorkHours(checkInMs, effectiveCheckOutMs) &&
    event.effectiveWorkHours === effective.effectiveWorkHours &&
    event.reason === proposal.reason &&
    event.source === correctionCompletionSource &&
    event.manualCorrection === true &&
    event.deviceVerified === false &&
    event.canonicalAttendanceChanged === false &&
    event.proposerUid === proposal.proposerUid &&
    event.proposerAccountFingerprint ===
      proposal.proposerAccountFingerprint &&
    event.reviewerUid === decision.reviewerUid &&
    event.reviewerAccountFingerprint ===
      decision.reviewerAccountFingerprint &&
    effective.completionSource === correctionCompletionSource &&
    effective.manualCorrection === true &&
    effective.deviceVerified === false &&
    effective.canonicalAttendanceChanged === false &&
    attendance.checkOut == null;
};
const proposalAssessments = attendanceCorrectionProposals.map(document => ({
  id: document.id,
  valid: validCorrectionProposal(
    document,
    attendanceById.get(document.data.attendanceId),
  ),
}));
const decisionAssessments = attendanceCorrectionDecisions.map(document => ({
  id: document.id,
  valid: validCorrectionDecision(
    document,
    correctionProposalById.get(document.id),
  ),
}));
const correctionEffectiveAssessments =
  attendanceCorrectionEffectiveViews.map(document => ({
    id: document.id,
    valid: validCorrectionEffectiveView(
      document,
      attendanceById.get(document.id),
    ),
  }));
const validEffectiveIds = new Set(
  correctionEffectiveAssessments.filter(item => item.valid).map(item => {
    const effective = correctionEffectiveByAttendanceId.get(item.id)?.data;
    return effective?.proposalId;
  })
);
const eventAssessments = attendanceCorrectionEvents.map(document => ({
  id: document.id,
  valid: validEffectiveIds.has(document.id),
}));
const approvedDecisionIds = new Set(
  attendanceCorrectionDecisions
    .filter(({ data }) => data.decision === 'approve')
    .map(item => item.id)
);
const correctionAuditSummary = {
  proposals: attendanceCorrectionProposals.length,
  validProposals: proposalAssessments.filter(item => item.valid).length,
  decisions: attendanceCorrectionDecisions.length,
  validDecisions: decisionAssessments.filter(item => item.valid).length,
  approvedDecisions: approvedDecisionIds.size,
  immutableEvents: attendanceCorrectionEvents.length,
  validImmutableEvents: eventAssessments.filter(item => item.valid).length,
  effectiveViews: attendanceCorrectionEffectiveViews.length,
  validEffectiveViews:
    correctionEffectiveAssessments.filter(item => item.valid).length,
  approvedDecisionsWithoutCompleteChain: [...approvedDecisionIds].filter(
    id => !validEffectiveIds.has(id)
  ).length,
  hasRuntimeEvidence: correctionEffectiveAssessments.length > 0,
  securityReady:
    proposalAssessments.every(item => item.valid) &&
    decisionAssessments.every(item => item.valid) &&
    eventAssessments.every(item => item.valid) &&
    correctionEffectiveAssessments.every(item => item.valid) &&
    [...approvedDecisionIds].every(id => validEffectiveIds.has(id)),
};
const correctionEffectiveAssessmentByAttendanceId = new Map(
  correctionEffectiveAssessments.map(item => [item.id, item])
);
const openShiftBaseFields = [
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
const validTargetChallenge = ({
  challengeId,
  uid,
  action,
  attendanceId,
  workDate,
  revision,
  actionMs,
}) => {
  const challenge = attendanceChallengeById.get(challengeId)?.data;
  const attendance = attendanceById.get(attendanceId)?.data;
  const createdAtMs = timestampMillis(challenge?.createdAt);
  const expiresAtMs = timestampMillis(challenge?.expiresAt);
  const lastSubmitAttemptAtMs = timestampMillis(
    challenge?.lastSubmitAttemptAt
  );
  return validChallengeId(challengeId) &&
    challenge?.uid === uid &&
    challenge.action === action &&
    challenge.status === 'consumed' &&
    challenge.attendanceId === attendanceId &&
    challenge.targetAttendanceId === attendanceId &&
    challenge.targetWorkDate === workDate &&
    challenge.targetShiftRevision === revision &&
    isValidWorkDate(challenge.requestDate) &&
    Number.isFinite(createdAtMs) &&
    challenge.requestDate ===
      attendanceCore.wibParts(new Date(createdAtMs)).date &&
    (action !== 'checkIn' || challenge.requestDate === workDate) &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs - createdAtMs === CHALLENGE_TTL_MS &&
    Number.isFinite(lastSubmitAttemptAtMs) &&
    createdAtMs <= lastSubmitAttemptAtMs &&
    lastSubmitAttemptAtMs <= actionMs &&
    createdAtMs <= actionMs && actionMs < expiresAtMs &&
    timestampMillis(challenge.consumedAt) === actionMs &&
    challenge.appId === WEB_APP_ID &&
    Number.isInteger(challenge.submitAttempts) &&
    challenge.submitAttempts >= 1 && challenge.submitAttempts <= 4 &&
    challenge.photoPath === attendance?.[`${action}PhotoPath`] &&
    challenge.photoGeneration ===
      attendance?.[`${action}PhotoGeneration`] &&
    challenge.photoHash === attendance?.[`${action}PhotoHash`] &&
    challenge.photoPerceptualHash ===
      attendance?.[`${action}PhotoPerceptualHash`] &&
    sameStringArray(
      challenge.photoPerceptualHashes,
      attendance?.[`${action}PhotoPerceptualHashes`],
    );
};
const assessOpenShift = document => {
  const shift = document.data;
  let expectedKeys = openShiftBaseFields;
  if (shift?.status === 'closed' &&
      shift.closureSource === 'verified-checkout') {
    expectedKeys = [
      ...openShiftBaseFields,
      'closureSource',
      'checkOutChallengeId',
    ];
  } else if (shift?.status === 'closed' &&
      shift.closureSource === 'location-photo-checkout') {
    expectedKeys = [
      ...openShiftBaseFields,
      'closureSource',
      'checkOutChallengeId',
    ];
  } else if (shift?.status === 'closed' &&
      shift.closureSource === 'administrative-correction') {
    expectedKeys = [...openShiftBaseFields, 'closureSource', 'correctionId'];
  }
  const checkInMs = timestampMillis(shift?.checkInAt);
  const closedAtMs = timestampMillis(shift?.closedAt);
  const createdAtMs = timestampMillis(shift?.createdAt);
  const updatedAtMs = timestampMillis(shift?.updatedAt);
  const expectedAttendanceId = isValidWorkDate(shift?.workDate)
    ? `${document.id}_${shift.workDate}`
    : null;
  const attendance = attendanceById.get(shift?.attendanceId)?.data;
  const correction = correctionEffectiveByAttendanceId.get(
    shift?.attendanceId
  );
  const strongAttendanceBindingValid = Boolean(attendance) &&
    attendance.userId === document.id &&
    attendance.date === shift.workDate &&
    attendance.integrityVersion === 2 &&
    attendance.proofVersion === 2 &&
    attendance.verificationStatus === 'verified' &&
    attendance.transitionMode === false &&
    (Number.isFinite(checkInMs)
      ? attendanceCore.wibParts(new Date(checkInMs)).date === shift.workDate
      : false) &&
    timestampMillis(attendance.checkIn) === checkInMs &&
    timestampMillis(attendance.createdAt) === checkInMs;
  const locationPhotoAttendanceBindingValid = Boolean(attendance) &&
    attendance.userId === document.id &&
    attendance.date === shift.workDate &&
    attendance.integrityVersion === 2 &&
    attendance.proofVersion === 2 &&
    attendance.verificationMode === 'location_photo' &&
    attendance.verificationStatus === 'location_photo_only' &&
    attendance.transitionMode === true &&
    attendance.isWithinRadius === null &&
    attendance.deviceVerified === false &&
    attendance.distanceFromGeofence === null &&
    attendance.presenceProof?.required === false &&
    attendance.presenceProof?.verified === false &&
    attendance.presenceProof?.reason === 'policy_location_photo' &&
    attendance.geofenceSnapshot === null &&
    ['kelurahan', 'kantor'].includes(
      attendance.assignmentSnapshot?.collection
    ) &&
    typeof attendance.assignmentSnapshot?.id === 'string' &&
    typeof attendance.assignmentSnapshot?.name === 'string' &&
    (Number.isFinite(checkInMs)
      ? attendanceCore.wibParts(new Date(checkInMs)).date === shift.workDate
      : false) &&
    timestampMillis(attendance.checkIn) === checkInMs &&
    timestampMillis(attendance.createdAt) === checkInMs;
  const attendanceBindingValid =
    strongAttendanceBindingValid || locationPhotoAttendanceBindingValid;
  const checkInTargetValid = validTargetChallenge({
    challengeId: attendance?.challengeIds?.checkIn,
    uid: document.id,
    action: 'checkIn',
    attendanceId: shift?.attendanceId,
    workDate: shift?.workDate,
    revision: shift?.revision,
    actionMs: checkInMs,
  });
  const checkOutTargetValid = validTargetChallenge({
    challengeId: attendance?.challengeIds?.checkOut,
    uid: document.id,
    action: 'checkOut',
    attendanceId: shift?.attendanceId,
    workDate: shift?.workDate,
    revision: shift?.revision,
    actionMs: closedAtMs,
  });
  const verifiedClosureValid =
    shift?.status === 'closed' &&
    shift.closureSource === 'verified-checkout' &&
    strongAttendanceBindingValid &&
    attendance?.checkOutVerificationMode !== 'location_photo' &&
    Number.isFinite(closedAtMs) && closedAtMs >= checkInMs &&
    updatedAtMs === closedAtMs &&
    validChallengeId(shift.checkOutChallengeId) &&
    attendance?.challengeIds?.checkOut === shift.checkOutChallengeId &&
    timestampMillis(attendance?.checkOut) === closedAtMs &&
    timestampMillis(attendance?.updatedAt) === closedAtMs &&
    checkOutTargetValid;
  const administrativeClosureValid =
    shift?.status === 'closed' &&
    shift.closureSource === 'administrative-correction' &&
    Number.isFinite(closedAtMs) && closedAtMs > checkInMs &&
    updatedAtMs >= closedAtMs &&
    typeof shift.correctionId === 'string' &&
    validCorrectionEffectiveView(
      correction,
      attendanceById.get(shift.attendanceId),
    ) &&
    correction.data.baseShiftRevision === shift.revision &&
    correction.data.proposalId === shift.correctionId &&
    timestampMillis(correction.data.effectiveCheckOut) === closedAtMs &&
    timestampMillis(correction.data.approvedAt) === updatedAtMs;
  const locationPhotoClosureValid =
    shift?.status === 'closed' &&
    shift.closureSource === 'location-photo-checkout' &&
    locationPhotoAttendanceBindingValid &&
    attendance?.checkOutVerificationMode === 'location_photo' &&
    attendance?.checkOutVerificationStatus === 'location_photo_only' &&
    attendance?.checkOutTransitionMode === true &&
    attendance?.checkOutIsWithinRadius === null &&
    attendance?.checkOutDeviceVerified === false &&
    attendance?.checkOutDistanceFromGeofence === null &&
    attendance?.checkOutPresenceProof?.required === false &&
    attendance?.checkOutPresenceProof?.verified === false &&
    attendance?.checkOutPresenceProof?.reason === 'policy_location_photo' &&
    attendance?.checkOutGeofenceSnapshot === null &&
    Number.isFinite(closedAtMs) && closedAtMs >= checkInMs &&
    updatedAtMs === closedAtMs &&
    validChallengeId(shift.checkOutChallengeId) &&
    attendance?.challengeIds?.checkOut === shift.checkOutChallengeId &&
    timestampMillis(attendance?.checkOut) === closedAtMs &&
    timestampMillis(attendance?.updatedAt) === closedAtMs &&
    checkOutTargetValid;
  const closureValid = shift?.status === 'open'
    ? shift.closedAt === null && updatedAtMs === checkInMs &&
      attendance?.checkOut == null
    : verifiedClosureValid || locationPhotoClosureValid ||
      administrativeClosureValid;
  const valid = hasExactKeys(shift, expectedKeys) &&
    shift.schemaVersion === 1 &&
    shift.uid === document.id &&
    Number.isInteger(shift.revision) && shift.revision >= 1 &&
    (shift.status === 'open' || shift.status === 'closed') &&
    expectedAttendanceId !== null &&
    shift.attendanceId === expectedAttendanceId &&
    Number.isFinite(checkInMs) && createdAtMs === checkInMs &&
    Number.isFinite(updatedAtMs) &&
    attendanceBindingValid && checkInTargetValid && closureValid;
  return {
    valid,
    status: shift?.status,
    closureSource: shift?.closureSource || null,
  };
};
const openShiftAssessments = attendanceOpenShifts.map(assessOpenShift);
const openShiftByUid = new Map(attendanceOpenShifts.map(item => [item.id, item]));
const openAttendanceWithoutMatchingShift = attendances.filter(({ id, data }) => {
  const pointer = openShiftByUid.get(data.userId)?.data;
  const matchesOpenPointer = pointer?.status === 'open' &&
    pointer.attendanceId === id;
  const hasValidAdministrativeCompletion =
    correctionEffectiveAssessmentByAttendanceId.get(id)?.valid === true;
  const operationalCheckIn =
    data.integrityVersion === 2 &&
    data.proofVersion === 2 &&
    (data.verificationStatus === 'verified' ||
      (data.verificationMode === 'location_photo' &&
        data.verificationStatus === 'location_photo_only'));
  return (
  operationalCheckIn &&
  Number.isFinite(timestampMillis(data.checkIn)) &&
  data.checkOut == null &&
  !matchesOpenPointer &&
  !hasValidAdministrativeCompletion
  );
}).length;
const openShiftSummary = {
  total: attendanceOpenShifts.length,
  open: openShiftAssessments.filter(item => item.status === 'open').length,
  closed: openShiftAssessments.filter(item => item.status === 'closed').length,
  closedByVerifiedCheckout: openShiftAssessments.filter(item =>
    item.closureSource === 'verified-checkout').length,
  closedByLocationPhotoCheckout: openShiftAssessments.filter(item =>
    item.closureSource === 'location-photo-checkout').length,
  closedByAdministrativeCorrection: openShiftAssessments.filter(item =>
    item.closureSource === 'administrative-correction').length,
  administrativeEffectiveViews: attendanceCorrectionEffectiveViews.length,
  validAdministrativeEffectiveViews:
    correctionEffectiveAssessments.filter(item => item.valid).length,
  currentAndStructurallyValid: openShiftAssessments.filter(item => item.valid).length,
  invalidOrInconsistent:
    openShiftAssessments.filter(item => !item.valid).length,
  openVerifiedAttendanceWithoutMatchingShift:
    openAttendanceWithoutMatchingShift,
  hasRuntimeEvidence: attendanceOpenShifts.length > 0,
  securityReady: openShiftAssessments.every(item => item.valid) &&
    correctionEffectiveAssessments.every(item => item.valid) &&
    correctionAuditSummary.securityReady &&
    openAttendanceWithoutMatchingShift === 0,
};

const defaultProjectConfig = projectConfig.find(item => item.id === 'default')?.data;
const replayPolicyConfigured = defaultProjectConfig?.attendanceSecurityVersion === 2 &&
  defaultProjectConfig?.geofenceTransitionMode === false &&
  attendanceCore.PERCEPTUAL_HASH_VERSION === 'dh144mv2';
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
const exactHashById = new Map(proofHashes.map(item => [item.id, item]));
const perceptualAuditById = new Map(
  perceptualProofHashes.map(item => [item.id, item])
);
const validExactHash = ({ id, data }) => {
  const attendance = attendanceById.get(data.attendanceId)?.data;
  const challenge = attendanceChallengeById.get(data.challengeId)?.data;
  const pairedAction = data.action === 'checkIn' ? 'checkOut' : 'checkIn';
  const pairedChallengeId = attendance?.challengeIds?.[pairedAction];
  const pairedChallenge = attendanceChallengeById.get(pairedChallengeId)?.data;
  const pairedTargetValid = pairedChallengeId == null ||
    (validChallengeId(pairedChallengeId) &&
      pairedChallenge?.uid === data.uid &&
      pairedChallenge.action === pairedAction &&
      pairedChallenge.status === 'consumed' &&
      pairedChallenge.attendanceId === data.attendanceId &&
      pairedChallenge.targetAttendanceId === data.attendanceId &&
      pairedChallenge.targetWorkDate === attendance?.date &&
      pairedChallenge.targetShiftRevision ===
        challenge?.targetShiftRevision);
  return /^[0-9a-f]{64}$/.test(id) &&
    hasExactKeys(data, exactHashFields) &&
    data.sha256 === id &&
    typeof data.uid === 'string' && data.uid.length > 0 &&
    validAction(data.action) &&
    typeof data.attendanceId === 'string' && data.attendanceId.length > 0 &&
    validChallengeId(data.challengeId) &&
    data.photoPath ===
      `attendanceProofs/${data.uid}/${data.challengeId}` &&
    typeof data.generation === 'string' && /^\d+$/.test(data.generation) &&
    data.perceptualHashes?.[0] === data.perceptualHash &&
    validPerceptualHashes(data.perceptualHashes) &&
    typeof data.md5Hash === 'string' && data.md5Hash.length > 0 &&
    typeof data.crc32c === 'string' && data.crc32c.length > 0 &&
    Number.isFinite(timestampMillis(data.createdAt)) &&
    Boolean(attendance) &&
    attendance.userId === data.uid &&
    attendance.challengeIds?.[data.action] === data.challengeId &&
    validTargetChallenge({
      challengeId: data.challengeId,
      uid: data.uid,
      action: data.action,
      attendanceId: data.attendanceId,
      workDate: attendance.date,
      revision: challenge?.targetShiftRevision,
      actionMs: timestampMillis(data.createdAt),
    }) &&
    challenge?.uid === data.uid &&
    challenge.action === data.action &&
    challenge.status === 'consumed' &&
    challenge.attendanceId === data.attendanceId &&
    challenge.targetAttendanceId === data.attendanceId &&
    challenge.targetWorkDate === attendance.date &&
    Number.isInteger(challenge.targetShiftRevision) &&
    challenge.targetShiftRevision >= 1 &&
    isValidWorkDate(challenge.requestDate) &&
    (data.action !== 'checkIn' ||
      challenge.requestDate === attendance.date) &&
    challenge.photoPath === data.photoPath &&
    challenge.photoGeneration === data.generation &&
    challenge.photoHash === data.sha256 &&
    challenge.photoPerceptualHash === data.perceptualHash &&
    sameStringArray(
      challenge.photoPerceptualHashes,
      data.perceptualHashes,
    ) &&
    timestampMillis(challenge.consumedAt) ===
      timestampMillis(data.createdAt) &&
    pairedTargetValid &&
    attendance[`${data.action}PhotoPath`] === data.photoPath &&
    attendance[`${data.action}PhotoGeneration`] === data.generation &&
    attendance[`${data.action}PhotoHash`] === data.sha256 &&
    attendance[`${data.action}PhotoPerceptualHash`] ===
      data.perceptualHash &&
    sameStringArray(
      attendance[`${data.action}PhotoPerceptualHashes`],
      data.perceptualHashes,
    ) &&
    attendance[`${data.action}PhotoMd5Hash`] === data.md5Hash &&
    attendance[`${data.action}PhotoCrc32c`] === data.crc32c &&
    timestampMillis(attendance[data.action]) ===
      timestampMillis(data.createdAt);
};
const replayBindingMatches = (exact, audit) =>
  exact.uid === audit.uid &&
  exact.action === audit.action &&
  exact.attendanceId === audit.attendanceId &&
  exact.challengeId === audit.challengeId &&
  exact.photoPath === audit.photoPath &&
  exact.sha256 === audit.sha256 &&
  exact.perceptualHash === audit.perceptualHash &&
  sameStringArray(exact.perceptualHashes, audit.perceptualHashes) &&
  timestampMillis(exact.createdAt) === timestampMillis(audit.createdAt);
const validPerceptualAudit = ({ id, data }) => {
  const exact = exactHashById.get(id);
  return data.schemaVersion === 3 &&
    /^[0-9a-f]{64}$/.test(id) &&
    hasExactKeys(data, perceptualAuditFields) &&
    data.proofId === id &&
    data.sha256 === id &&
    typeof data.uid === 'string' && data.uid.length > 0 &&
    validAction(data.action) &&
    typeof data.attendanceId === 'string' && data.attendanceId.length > 0 &&
    typeof data.challengeId === 'string' && data.challengeId.length > 0 &&
    typeof data.photoPath === 'string' && data.photoPath.length > 0 &&
    typeof data.generation === 'string' &&
    /^\d+$/.test(data.generation) &&
    data.hashVersion === attendanceCore.PERCEPTUAL_HASH_VERSION &&
    data.perceptualHashes?.[0] === data.perceptualHash &&
    validPerceptualHashes(data.perceptualHashes) &&
    Number.isFinite(timestampMillis(data.createdAt)) &&
    Boolean(exact) && validExactHash(exact) &&
    data.generation === exact.data.generation &&
    replayBindingMatches(exact.data, data);
};
const schemaV3PerceptualAudits = perceptualProofHashes.filter(
  ({ data }) => data.schemaVersion === 3
);
const validSchemaV3PerceptualAudits = schemaV3PerceptualAudits.filter(
  validPerceptualAudit
);
const auditedAtMs = Date.now();
const replayCutoffMs = auditedAtMs - attendanceCore.PERCEPTUAL_REPLAY_WINDOW_MS;
const compareReplayEntries = (left, right) =>
  left.createdAtMs === right.createdAtMs
    ? left.proofId.localeCompare(right.proofId)
    : left.createdAtMs - right.createdAtMs;
const assessReplayState = ({ id, data }) => {
  let structurallyValid = hasExactKeys(data, replayStateFields) &&
    data.schemaVersion === attendanceCore.PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION &&
    data.hashVersion === attendanceCore.PERCEPTUAL_HASH_VERSION &&
    data.uid === id &&
    data.windowMs === attendanceCore.PERCEPTUAL_REPLAY_WINDOW_MS &&
    data.maxEntries === attendanceCore.PERCEPTUAL_REPLAY_MAX_ENTRIES &&
    Array.isArray(data.entries) &&
    data.entries.length >= 1 &&
    data.entries.length <= attendanceCore.PERCEPTUAL_REPLAY_MAX_ENTRIES &&
    Number.isSafeInteger(data.updatedAtMs) &&
    data.updatedAtMs > 0 && data.updatedAtMs <= auditedAtMs;
  const proofIds = new Set();
  let previousEntry = null;
  let entriesWithMatchingAudit = 0;
  let activeEntries = 0;
  let expiredEntries = 0;
  const validatedEntries = [];
  if (Array.isArray(data.entries)) {
    for (const entry of data.entries) {
      const audit = perceptualAuditById.get(entry?.proofId);
      const auditMatches = Boolean(audit) &&
        validPerceptualAudit(audit) &&
        audit.data.uid === id &&
        sameStringArray(audit.data.perceptualHashes, entry?.perceptualHashes) &&
        timestampMillis(audit.data.createdAt) === entry?.createdAtMs;
      const entryValid = hasExactKeys(entry, replayEntryFields) &&
        /^[0-9a-f]{64}$/.test(entry?.proofId || '') &&
        !proofIds.has(entry.proofId) &&
        validPerceptualHashes(entry.perceptualHashes) &&
        Number.isSafeInteger(entry.createdAtMs) &&
        entry.createdAtMs > 0 &&
        entry.createdAtMs <= data.updatedAtMs &&
        (!previousEntry || compareReplayEntries(previousEntry, entry) < 0);
      if (!entryValid || !auditMatches) structurallyValid = false;
      if (entryValid) {
        proofIds.add(entry.proofId);
        previousEntry = entry;
        validatedEntries.push(entry);
        if (entry.createdAtMs > replayCutoffMs) activeEntries += 1;
        else expiredEntries += 1;
      }
      if (auditMatches) entriesWithMatchingAudit += 1;
    }
  }
  for (let leftIndex = 0; leftIndex < validatedEntries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1;
      rightIndex < validatedEntries.length;
      rightIndex += 1) {
      const distance = attendanceCore.minimumPerceptualHashDistance(
        validatedEntries[leftIndex].perceptualHashes,
        validatedEntries[rightIndex].perceptualHashes,
      );
      if (distance <= attendanceCore.PERCEPTUAL_REPLAY_MAX_DISTANCE) {
        structurallyValid = false;
      }
    }
  }
  if (!previousEntry || data.updatedAtMs !== previousEntry.createdAtMs) {
    structurallyValid = false;
  }
  return {
    id,
    structurallyValid,
    entriesWithMatchingAudit,
    entryCount: Array.isArray(data.entries) ? data.entries.length : 0,
    activeEntries,
    expiredEntries,
    proofIds,
  };
};
const replayStateAssessments = perceptualReplayStates.map(assessReplayState);
const replayStateByUid = new Map(
  replayStateAssessments.map(item => [item.id, item])
);
const activeValidAudits = validSchemaV3PerceptualAudits.filter(
  ({ data }) => timestampMillis(data.createdAt) > replayCutoffMs
);
const activeAuditsMissingFromState = activeValidAudits.filter(({ id, data }) =>
  !replayStateByUid.get(data.uid)?.proofIds.has(id)
).length;
const activeExactHashesMissingSchemaV3Audit = proofHashes.filter(item =>
  validExactHash(item) &&
  timestampMillis(item.data.createdAt) > replayCutoffMs &&
  !validPerceptualAudit(perceptualAuditById.get(item.id) || {
    id: '',
    data: {},
  })
).length;
const activeLegacyPerceptualAudits = perceptualProofHashes.filter(({ data }) =>
  data.schemaVersion !== 3 &&
  timestampMillis(data.createdAt) > replayCutoffMs
).length;
const validReplayStates = replayStateAssessments.filter(
  item => item.structurallyValid
);
const replayIndexesReady =
  proofHashes.every(validExactHash) &&
  validSchemaV3PerceptualAudits.length === schemaV3PerceptualAudits.length &&
  validReplayStates.length === perceptualReplayStates.length &&
  activeAuditsMissingFromState === 0 &&
  activeExactHashesMissingSchemaV3Audit === 0 &&
  activeLegacyPerceptualAudits === 0;
const replayHasRuntimeEvidence =
  validSchemaV3PerceptualAudits.length > 0 && validReplayStates.length > 0;
const replayIndexSummary = {
  expectedHashVersion: attendanceCore.PERCEPTUAL_HASH_VERSION,
  expectedViewCount: attendanceCore.PERCEPTUAL_HASH_VIEW_COUNT,
  maximumReplayDistanceBits: attendanceCore.PERCEPTUAL_REPLAY_MAX_DISTANCE,
  replayWindowDays:
    attendanceCore.PERCEPTUAL_REPLAY_WINDOW_MS / (24 * 60 * 60 * 1000),
  maximumEntriesPerUid: attendanceCore.PERCEPTUAL_REPLAY_MAX_ENTRIES,
  exactHashDocuments: proofHashes.length,
  validExactHashDocuments: proofHashes.filter(validExactHash).length,
  perceptualAuditDocuments: perceptualProofHashes.length,
  schemaV3PerceptualAuditDocuments: schemaV3PerceptualAudits.length,
  validSchemaV3PerceptualAuditDocuments:
    validSchemaV3PerceptualAudits.length,
  legacyPerceptualAuditDocuments:
    perceptualProofHashes.length - schemaV3PerceptualAudits.length,
  activeLegacyPerceptualAuditDocuments: activeLegacyPerceptualAudits,
  sameUidReplayStates: perceptualReplayStates.length,
  validSameUidReplayStates: validReplayStates.length,
  replayStateEntries: replayStateAssessments.reduce(
    (total, item) => total + item.entryCount,
    0,
  ),
  activeReplayStateEntries: replayStateAssessments.reduce(
    (total, item) => total + item.activeEntries,
    0,
  ),
  expiredEntriesAwaitingPrune: replayStateAssessments.reduce(
    (total, item) => total + item.expiredEntries,
    0,
  ),
  stateEntriesWithMatchingImmutableAudit: replayStateAssessments.reduce(
    (total, item) => total + item.entriesWithMatchingAudit,
    0,
  ),
  activeAuditDocumentsMissingFromState: activeAuditsMissingFromState,
  activeExactHashesMissingSchemaV3Audit:
    activeExactHashesMissingSchemaV3Audit,
  hasRuntimeEvidence: replayHasRuntimeEvidence,
  policyConfigured: replayPolicyConfigured,
  policyReady: replayPolicyConfigured && replayIndexesReady,
  runtimeReady:
    replayPolicyConfigured && replayIndexesReady && replayHasRuntimeEvidence,
};

const interestingRoles = new Set([
  'roles/datastore.user',
  'roles/firebaseauth.admin',
  'roles/firebaseappcheck.tokenVerifier',
  'roles/firebaserules.firestoreServiceAgent',
  'roles/iam.serviceAccountTokenCreator',
  'roles/storage.objectViewer',
]);
const iamBindings = Array.isArray(iamPolicy.bindings) ? iamPolicy.bindings : [];
const roleNames = [...new Set(iamBindings.map(binding => binding.role))];
const roleDefinitions = await Promise.all(roleNames.map(async role => ({
  role,
  definition: await safe(() => api(`https://iam.googleapis.com/v1/${role}`)),
})));
const firestoreMutationPermissions = new Set([
  'datastore.entities.create',
  'datastore.entities.delete',
  'datastore.entities.update',
]);
const mutationRoles = new Set(roleDefinitions
  .filter(({ definition }) =>
    Array.isArray(definition.includedPermissions) &&
    definition.includedPermissions.some(permission =>
      firestoreMutationPermissions.has(permission)
    )
  )
  .map(({ role }) => role));
const unresolvedRoles = roleDefinitions.filter(({ definition }) =>
  !Array.isArray(definition.includedPermissions)
).map(({ role }) => role);
const principalType = member => {
  if (member === `serviceAccount:${RUNTIME_EMAIL}`) return 'attendance-runtime';
  if (member.startsWith('user:') || member.startsWith('group:') ||
      member.startsWith('domain:')) return 'human';
  if (member === 'allUsers' || member === 'allAuthenticatedUsers') return 'public';
  if (member.startsWith('serviceAccount:')) {
    const email = member.slice('serviceAccount:'.length);
    if (email.includes('@gcp-sa-') ||
        email.endsWith('@cloudservices.gserviceaccount.com')) {
      return 'google-managed-service';
    }
    return 'project-service-account';
  }
  return 'other';
};
const rawFirestoreWriteBindings = iamBindings
  .filter(binding => mutationRoles.has(binding.role))
  .flatMap(binding => (binding.members || []).map(member => ({
    role: binding.role,
    principalType: principalType(member),
    principalFingerprint: iamFingerprint(member),
    conditional: Boolean(binding.condition),
  })));
const uniqueRawWriters = new Map(rawFirestoreWriteBindings.map(item => [
  item.principalFingerprint,
  item.principalType,
]));
const rawWriterTypes = [...uniqueRawWriters.values()].reduce((summary, type) => {
  summary[type] = (summary[type] || 0) + 1;
  return summary;
}, {});
const relevantDataWriteConfigs = Array.isArray(iamPolicy.auditConfigs)
  ? iamPolicy.auditConfigs.flatMap(config => {
    if (!['allServices', 'datastore.googleapis.com'].includes(config.service)) {
      return [];
    }
    return (config.auditLogConfigs || []).filter(item =>
      item.logType === 'DATA_WRITE'
    );
  })
  : [];
const dataWriteAuditSummary = {
  configured: relevantDataWriteConfigs.length > 0,
  relevantConfigCount: relevantDataWriteConfigs.length,
  exemptionCount: relevantDataWriteConfigs.reduce(
    (total, config) => total + (config.exemptedMembers?.length || 0),
    0
  ),
};
const iamSummary = Array.isArray(iamPolicy.bindings)
  ? iamPolicy.bindings
    .filter(binding => interestingRoles.has(binding.role))
    .map(binding => ({
      role: binding.role,
      memberCount: binding.members?.length || 0,
      members: (binding.members || []).map(member => ({
        principalType: principalType(member),
        principalFingerprint: iamFingerprint(member),
      })),
      conditional: Boolean(binding.condition),
    }))
  : iamPolicy;

const keySummary = Array.isArray(serviceAccountKeys.keys)
  ? serviceAccountKeys.keys.map(key => ({
    id: key.name.split('/').pop(),
    keyType: key.keyType,
    disabled: key.disabled === true,
    disableReason: key.disableReason || null,
    validAfterTime: key.validAfterTime,
    validBeforeTime: key.validBeforeTime,
  }))
  : serviceAccountKeys;

const summarizePolicy = (policy, roles) => Array.isArray(policy.bindings)
  ? policy.bindings
    .filter(binding => roles.has(binding.role))
    .map(binding => ({ role: binding.role, members: binding.members || [] }))
  : policy;

console.log(JSON.stringify({
  auditedAt: new Date(auditedAtMs).toISOString(),
  project: { id: PROJECT_ID, number: PROJECT_NUMBER },
  users: userSummary,
  geofences: geofenceSummary,
  geofenceReadiness: geofenceReadinessSummary,
  geofenceVerificationAudits: geofenceAuditSummary,
  attendances: attendanceSummary,
  attendanceCorrections: correctionAuditSummary,
  attendanceOpenShifts: openShiftSummary,
  attendanceReplayIndexes: replayIndexSummary,
  deployedRules: {
    firestore: summarizeRulesDeployment(
      firestoreRulesDeployment,
      new URL('../firestore.rules', import.meta.url),
    ),
    storage: summarizeRulesDeployment(
      storageRulesDeployment,
      new URL('../storage.rules', import.meta.url),
    ),
  },
  projectConfig: projectConfig.map(({ id, data }) => ({ id, data })),
  iam: iamSummary,
  firestoreIamBypass: {
    mutationRoleCount: mutationRoles.size,
    bindingCount: rawFirestoreWriteBindings.length,
    uniquePrincipalCount: uniqueRawWriters.size,
    principalTypes: rawWriterTypes,
    humanOrPublicPrincipalCount: [...uniqueRawWriters.values()].filter(type =>
      type === 'human' || type === 'public'
    ).length,
    unresolvedRoleCount: unresolvedRoles.length,
    bindings: rawFirestoreWriteBindings,
    projectIamWritersRemainTrusted: rawFirestoreWriteBindings.length > 0,
  },
  firestoreDataWriteAudit: dataWriteAuditSummary,
  bucketIam: summarizePolicy(bucketIamPolicy, new Set(['roles/storage.objectViewer'])),
  runtimeServiceAccountIam: summarizePolicy(
    runtimeIamPolicy,
    new Set(['roles/iam.serviceAccountTokenCreator'])
  ),
  appCheckServices,
  webAppCheck,
  deployedFunctions: Array.isArray(functions.functions)
    ? functions.functions.map(item => ({
      name: item.name,
      state: item.state || null,
      runtime: item.buildConfig?.runtime || null,
      sourceHash: item.labels?.['firebase-functions-hash'] || null,
      serviceAccountEmail: item.serviceConfig?.serviceAccountEmail || null,
      updateTime: item.updateTime || null,
    }))
    : functions,
  serviceAccountKeys: keySummary,
}, null, 2));
