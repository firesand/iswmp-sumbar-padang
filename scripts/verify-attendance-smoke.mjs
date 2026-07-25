#!/usr/bin/env node

/**
 * Read-only production smoke verifier for the server-authoritative attendance
 * flow. It never downloads proof images and never prints raw UIDs, locations,
 * names, email addresses, challenge IDs, photo hashes, tokens, or onsite codes.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  createFirebaseCliApi,
  decodeFirestoreDocument,
} from './lib/firebase-cli-api.mjs';
import {
  HostingEvidenceMismatch,
  readLiveHostingEvidence,
} from './lib/hosting-deployment-evidence.mjs';

const require = createRequire(import.meta.url);
const core = require('../functions/attendance-core.js');

const PROJECT_ID = 'iswmp-sumbar-padang';
const PROJECT_NUMBER = '1079074812491';
const WEB_APP_ID = '1:1079074812491:web:28a1a3fa33933c5ca9d3ce';
const REPORT_SCHEMA_VERSION = 3;
const CHECKIN_REPORT_SCHEMA_VERSION = 1;
const CHECKIN_REPORT_TYPE = 'attendance-security-smoke-checkin';
const BUCKET = 'iswmp-sumbar-padang.firebasestorage.app';
const REGION = 'asia-southeast2';
const RUNTIME_SERVICE_ACCOUNT =
  `attendance-runtime@${PROJECT_ID}.iam.gserviceaccount.com`;
const FIRESTORE_ROOT =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
  '/databases/(default)/documents';
const EXPECTED_FUNCTIONS = [
  'adminArchiveEmployee',
  'adminResetUserPassword',
  'changeTemporaryPassword',
  'createAttendanceChallenge',
  'getAttendancePhotoUrl',
  'getOnsitePresenceCode',
  'proposeGeofenceVerification',
  'proposeMissingCheckoutCorrection',
  'reviewAttendanceCorrection',
  'reviewGeofenceVerification',
  'submitAttendance',
];
const MAX_REPORT_AGE_MS = 6 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const OPEN_SHIFT_SCHEMA_VERSION = 1;
const MAX_CHECKIN_REPORT_BYTES = 256 * 1024;
const CHECKIN_REPORT_MTIME_TOLERANCE_MS = 10 * 60 * 1000;
const CHECKIN_REPORT_CHECK_IDS = new Set([
  'wib_checkin_window',
  'active_canonical_employee_and_geofence',
  'open_shift_after_checkin',
  'checkin_consumed_flow',
  'checkin_immutable_storage_object',
  'checkin_replay_state',
]);
const CHECKIN_REPORT_ROOT_KEYS = [
  'schemaVersion',
  'reportType',
  'phase',
  'projectId',
  'projectNumber',
  'webAppId',
  'generatedAt',
  'startedAt',
  'employeeFingerprint',
  'attendanceFingerprint',
  'shiftBindingFingerprint',
  'outcome',
  'readiness',
  'checks',
  'reportDigest',
];
const APP_CHECK_METRIC =
  'firebaseappcheck.googleapis.com/services/verification_count';

class CheckError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const fail = code => {
  throw new CheckError('FAIL', code);
};
const inconclusive = code => {
  throw new CheckError('INCONCLUSIVE', code);
};

const args = new Map(process.argv.slice(2).map(argument => {
  const [key, ...parts] = argument.split('=');
  return [key, parts.length ? parts.join('=') : true];
}));
const phase = String(args.get('--phase') || '').toLowerCase();
const employeeUid = String(args.get('--employee-uid') || '');

if (!['preflight', 'checkin', 'verify'].includes(phase)) {
  throw new Error('--phase harus preflight, checkin, atau verify.');
}
if (!/^[A-Za-z0-9:_-]{1,128}$/.test(employeeUid)) {
  throw new Error('--employee-uid wajib berupa UID Firebase yang valid.');
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => sha256(
  `attendance-smoke-v1\u0000${String(value)}`
).slice(0, 20);
const securityLogFingerprint = value => sha256(
  `attendance-security-log-v1\u0000${String(value)}`
).slice(0, 20);

const canonicalValue = value => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalValue(value[key])])
    );
  }
  return value;
};
const canonicalJson = value => JSON.stringify(canonicalValue(value));
const shiftBindingFingerprint = shift => fingerprint(canonicalJson({
  attendanceId: shift.attendanceId,
  workDate: shift.workDate,
  revision: shift.revision,
  checkInMs: shift.checkInMs,
}));
const canonicalIamBindings = bindings => (bindings || []).map(binding => ({
  role: binding.role,
  members: [...(binding.members || [])].sort(),
  ...(binding.condition ? { condition: binding.condition } : {}),
})).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));

const timestampMs = value => {
  if (typeof value !== 'string') return NaN;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : NaN;
};
const hasExactKeys = (value, expectedKeys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index]);
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
const OPEN_SHIFT_BASE_FIELDS = [
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
const validateOpenShiftDocument = (
  document,
  expectedUid,
  expectedStatus = null,
  expectedClosureSource = null,
) => {
  if (!document || document.id !== expectedUid) fail('OPEN_SHIFT_STATE_INVALID');
  const shift = document.data;
  let expectedKeys = OPEN_SHIFT_BASE_FIELDS;
  if (shift?.status === 'closed' &&
      shift.closureSource === 'verified-checkout') {
    expectedKeys = [
      ...OPEN_SHIFT_BASE_FIELDS,
      'closureSource',
      'checkOutChallengeId',
    ];
  } else if (shift?.status === 'closed' &&
      shift.closureSource === 'administrative-correction') {
    expectedKeys = [...OPEN_SHIFT_BASE_FIELDS, 'closureSource', 'correctionId'];
  }
  const checkInMs = timestampMs(shift?.checkInAt);
  const closedAtMs = timestampMs(shift?.closedAt);
  const createdAtMs = timestampMs(shift?.createdAt);
  const updatedAtMs = timestampMs(shift?.updatedAt);
  const validStatus = shift?.status === 'open' || shift?.status === 'closed';
  const expectedAttendanceId = isValidWorkDate(shift?.workDate)
    ? `${expectedUid}_${shift.workDate}`
    : null;
  const verifiedClosureValid = shift?.closureSource === 'verified-checkout' &&
    Number.isFinite(closedAtMs) && closedAtMs >= checkInMs &&
      updatedAtMs === closedAtMs &&
      typeof shift.checkOutChallengeId === 'string';
  const administrativeClosureValid =
    shift?.closureSource === 'administrative-correction' &&
    Number.isFinite(closedAtMs) && closedAtMs > checkInMs &&
    updatedAtMs >= closedAtMs &&
    typeof shift.correctionId === 'string';
  const validClosure = shift?.status === 'open'
    ? shift.closedAt === null && updatedAtMs === checkInMs
    : verifiedClosureValid || administrativeClosureValid;
  if (!hasExactKeys(shift, expectedKeys) ||
      shift.schemaVersion !== OPEN_SHIFT_SCHEMA_VERSION ||
      shift.uid !== expectedUid ||
      !Number.isInteger(shift.revision) || shift.revision < 1 ||
      !validStatus || (expectedStatus && shift.status !== expectedStatus) ||
      (expectedClosureSource &&
        shift.closureSource !== expectedClosureSource) ||
      !expectedAttendanceId || shift.attendanceId !== expectedAttendanceId ||
      !Number.isFinite(checkInMs) || createdAtMs !== checkInMs ||
      !Number.isFinite(updatedAtMs) || !validClosure) {
    fail('OPEN_SHIFT_STATE_INVALID');
  }
  if (shift.closureSource === 'verified-checkout') {
    safeCore(() => core.assertChallengeId(shift.checkOutChallengeId));
  } else if (shift.closureSource === 'administrative-correction') {
    safeCore(() => core.assertChallengeId(shift.correctionId));
  }
  return { ...shift, checkInMs, closedAtMs, createdAtMs, updatedAtMs };
};

const wibParts = date => Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value])
);
const wibDate = date => {
  const parts = wibParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const runCheck = async (checks, id, operation) => {
  try {
    const evidence = await operation();
    const check = { id, status: 'PASS' };
    if (evidence && Object.keys(evidence).length) check.evidence = evidence;
    checks.push(check);
    return evidence;
  } catch (error) {
    const status = error instanceof CheckError ? error.status : 'INCONCLUSIVE';
    const reasonCode = error instanceof CheckError
      ? error.code
      : `${id.toUpperCase()}_API_UNAVAILABLE`;
    checks.push({ id, status, reasonCode });
    return null;
  }
};

const api = await createFirebaseCliApi();

const getDocument = async (collection, id, required = true) => {
  try {
    const document = await api(
      `${FIRESTORE_ROOT}/${encodeURIComponent(collection)}/` +
      encodeURIComponent(id)
    );
    return decodeFirestoreDocument(document);
  } catch (error) {
    if (error.status === 404) {
      if (!required) return null;
      fail('REQUIRED_DOCUMENT_MISSING');
    }
    throw error;
  }
};

const safeCore = operation => {
  try {
    return operation();
  } catch (error) {
    fail(error?.reason || 'SECURITY_INVARIANT_INVALID');
  }
};

const validateEmployee = userDocument => {
  if (!userDocument) fail('EMPLOYEE_NOT_FOUND');
  const employee = safeCore(() => core.assertActiveEmployee(userDocument.data));
  const assignment = safeCore(() => core.resolveAssignment(employee));
  return { employee, assignment };
};

const validateGeofence = (document, collection) => {
  if (!document) fail('GEOFENCE_NOT_FOUND');
  const data = document.data;
  const geofence = safeCore(() => core.normalizeGeofence(
    data,
    document.id,
    timestampMs(data.verifiedAt),
    timestampMs(data.verificationReviewedAt),
  ));
  return getDocument(
    'geofenceVerificationAuditLogs',
    geofence.verificationAuditId,
  ).then(auditDocument => {
    safeCore(() => core.assertGeofenceAudit(
      auditDocument.data,
      { collection, ...geofence },
      timestampMs(auditDocument.data.createdAt),
      timestampMs(auditDocument.data.proposedAt),
    ));
    return geofence;
  });
};

const getRuleDeployment = async (releaseName, localUrl) => {
  const releases = await api(
    `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/releases`
  );
  const release = (releases.releases || [])
    .find(item => item.name === releaseName);
  if (!release?.rulesetName) fail('RULES_RELEASE_MISSING');
  const [ruleset, { readFile }] = await Promise.all([
    api(`https://firebaserules.googleapis.com/v1/${release.rulesetName}`),
    import('node:fs/promises'),
  ]);
  const deployed = ruleset.source?.files?.[0]?.content;
  const local = await readFile(localUrl, 'utf8');
  if (typeof deployed !== 'string' || deployed !== local) {
    fail('DEPLOYED_RULES_DO_NOT_MATCH_LOCAL');
  }
  return {
    rulesetFingerprint: fingerprint(release.rulesetName),
    sourceFingerprint: sha256(deployed).slice(0, 20),
  };
};

const checkProjectPolicy = async checks => runCheck(
  checks,
  'project_policy_v2',
  async () => {
    const [config, iamPolicy] = await Promise.all([
      getDocument('projectConfig', 'default'),
      api(
        `https://cloudresourcemanager.googleapis.com/v1/projects/` +
        `${PROJECT_ID}:getIamPolicy`,
        {
          method: 'POST',
          body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
        },
      ),
    ]);
    if (config.data.attendanceSecurityVersion !== 2 ||
        config.data.geofenceTransitionMode !== false) {
      fail('PROJECT_POLICY_NOT_V2');
    }
    const dataWriteConfigs = (iamPolicy.auditConfigs || []).flatMap(item => {
      if (!['allServices', 'datastore.googleapis.com'].includes(item.service)) {
        return [];
      }
      return (item.auditLogConfigs || []).filter(logConfig =>
        logConfig.logType === 'DATA_WRITE'
      );
    });
    const auditExemptionCount = dataWriteConfigs.reduce(
      (total, item) => total + (item.exemptedMembers?.length || 0),
      0
    );
    if (dataWriteConfigs.length === 0 || auditExemptionCount !== 0) {
      fail('FIRESTORE_DATA_WRITE_AUDIT_DISABLED');
    }
    return {
      attendanceSecurityVersion: 2,
      transitionMode: false,
      firestoreDataWriteAudit: true,
      auditExemptionCount,
      iamBindingsFingerprint: fingerprint(canonicalJson(
        canonicalIamBindings(iamPolicy.bindings)
      )),
    };
  }
);

const checkFunctionDeployment = async checks => runCheck(
  checks,
  'functions_deployment',
  async () => {
    const result = await api(
      `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT_ID}/` +
      `locations/${REGION}/functions`
    );
    const functions = result.functions || [];
    const names = functions.map(item => item.name.split('/').pop()).sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_FUNCTIONS)) {
      fail('FUNCTION_SET_MISMATCH');
    }
    for (const deployedFunction of functions) {
      if (deployedFunction.state !== 'ACTIVE' ||
          deployedFunction.buildConfig?.runtime !== 'nodejs22' ||
          deployedFunction.serviceConfig?.serviceAccountEmail !==
            RUNTIME_SERVICE_ACCOUNT) {
        fail('FUNCTION_RUNTIME_MISMATCH');
      }
    }
    const sourceHashes = [...new Set(functions.map(item =>
      item.labels?.['firebase-functions-hash']
    ).filter(Boolean))];
    if (sourceHashes.length !== 1) fail('FUNCTION_SOURCE_HASH_MISMATCH');
    return {
      activeCount: functions.length,
      runtime: 'nodejs22',
      sourceFingerprint: fingerprint(sourceHashes[0]),
    };
  }
);

const checkRules = async checks => runCheck(
  checks,
  'deployed_security_rules',
  async () => {
    const [firestore, storage] = await Promise.all([
      getRuleDeployment(
        `projects/${PROJECT_ID}/releases/cloud.firestore`,
        new URL('../firestore.rules', import.meta.url),
      ),
      getRuleDeployment(
        `projects/${PROJECT_ID}/releases/firebase.storage/${BUCKET}`,
        new URL('../storage.rules', import.meta.url),
      ),
    ]);
    return { firestore, storage };
  }
);

const checkHostingDeployment = async checks => runCheck(
  checks,
  'hosting_deployment',
  async () => {
    try {
      return await readLiveHostingEvidence({ api, projectId: PROJECT_ID });
    } catch (error) {
      if (error instanceof HostingEvidenceMismatch) fail(error.code);
      throw error;
    }
  }
);

const appCheckModes = async () => {
  const [servicesResult, provider] = await Promise.all([
    api(
      `https://firebaseappcheck.googleapis.com/v1/projects/` +
      `${PROJECT_NUMBER}/services`
    ),
    api(
      `https://firebaseappcheck.googleapis.com/v1/projects/` +
      `${PROJECT_NUMBER}/apps/${encodeURIComponent(WEB_APP_ID)}/` +
      'recaptchaEnterpriseConfig'
    ),
  ]);
  const expectedProviderName =
    `projects/${PROJECT_NUMBER}/apps/${WEB_APP_ID}/recaptchaEnterpriseConfig`;
  if (provider.name !== expectedProviderName ||
      typeof provider.siteKey !== 'string' || !provider.siteKey) {
    fail('APP_CHECK_PROVIDER_MISSING');
  }
  const modes = Object.fromEntries((servicesResult.services || []).map(service => [
    service.name.split('/').pop(),
    service.enforcementMode || 'NOT_CONFIGURED',
  ]));
  for (const serviceId of ['firestore.googleapis.com', 'firebasestorage.googleapis.com']) {
    if (modes[serviceId] !== 'UNENFORCED') {
      fail('APP_CHECK_NOT_IN_MONITORING_MODE');
    }
  }
  const providerConfigFingerprint = fingerprint(canonicalJson({
    name: provider.name,
    siteKey: provider.siteKey,
    tokenTtl: provider.tokenTtl || null,
    minValidScore: provider.riskAnalysis?.minValidScore ?? null,
  }));
  return { modes, providerConfigFingerprint };
};

const checkAppCheckMonitoring = async checks => runCheck(
  checks,
  'app_check_monitoring_mode',
  async () => {
    const { modes, providerConfigFingerprint } = await appCheckModes();
    return {
      firestore: modes['firestore.googleapis.com'],
      storage: modes['firebasestorage.googleapis.com'],
      providerConfigured: true,
      providerConfigFingerprint,
    };
  }
);

const preflight = async () => {
  const checks = [];
  const now = new Date();
  const startedAt = now.toISOString();
  const collection = String(args.get('--collection') || '');
  const geofenceId = String(args.get('--geofence-id') || '');
  if (!['kelurahan', 'kantor'].includes(collection) ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(geofenceId)) {
    throw new Error(
      'Preflight membutuhkan --collection=kelurahan|kantor dan --geofence-id=ID.'
    );
  }
  const date = wibDate(now);
  const state = {};

  await runCheck(checks, 'wib_time_window', async () => {
    return {
      requestDate: date,
      crossMidnightCheckoutSupported: true,
    };
  });
  await runCheck(checks, 'active_canonical_employee', async () => {
    const userDocument = await getDocument('users', employeeUid);
    state.user = validateEmployee(userDocument);
    if (state.user.assignment.collection !== collection ||
        state.user.assignment.id !== geofenceId) {
      fail('EMPLOYEE_ASSIGNMENT_MISMATCH');
    }
    return { assignmentType: collection };
  });
  await runCheck(checks, 'no_attendance_today', async () => {
    const [attendance, openShiftDocument] = await Promise.all([
      getDocument('attendances', `${employeeUid}_${date}`, false),
      getDocument('attendanceOpenShifts', employeeUid, false),
    ]);
    if (attendance) fail('ATTENDANCE_ALREADY_EXISTS');
    let nextShiftRevision = 1;
    if (openShiftDocument) {
      const priorShift = validateOpenShiftDocument(
        openShiftDocument,
        employeeUid,
      );
      if (priorShift.status === 'open') fail('OPEN_SHIFT_EXISTS');
      nextShiftRevision = priorShift.revision + 1;
    }
    state.nextShiftRevision = nextShiftRevision;
    return {
      attendanceAbsent: true,
      openShiftAbsent: !openShiftDocument,
      noActiveOpenShift: true,
      nextShiftRevision,
    };
  });
  await runCheck(checks, 'challenge_and_rate_capacity', async () => {
    const [checkInLock, checkOutLock, challengeRate, submitRate] =
      await Promise.all([
        getDocument('attendanceChallengeLocks', `${employeeUid}_checkIn`, false),
        getDocument('attendanceChallengeLocks', `${employeeUid}_checkOut`, false),
        getDocument('attendanceChallengeRateLimits', `${employeeUid}_${date}`, false),
        getDocument('attendanceSubmitRateLimits', `${employeeUid}_${date}`, false),
      ]);
    const nowMs = now.getTime();
    for (const lock of [checkInLock, checkOutLock].filter(Boolean)) {
      if (lock.data.status === 'pending' &&
          timestampMs(lock.data.expiresAt) > nowMs) {
        fail('ACTIVE_CHALLENGE_LOCK');
      }
    }
    const challengeCount = challengeRate?.data.challengeCount || 0;
    const submitCount = submitRate?.data.attemptCount || 0;
    if (!Number.isInteger(challengeCount) || challengeCount < 0 ||
        challengeCount > 18 || !Number.isInteger(submitCount) ||
        submitCount < 0 || submitCount > 18) {
      fail('INSUFFICIENT_DAILY_RATE_CAPACITY');
    }
    if (timestampMs(challengeRate?.data.lastCreatedAt) > nowMs - 15_000 ||
        timestampMs(submitRate?.data.lastAttemptAt) > nowMs - 2_000) {
      fail('RATE_COOLDOWN_ACTIVE');
    }
    return {
      remainingChallengeCapacity: 20 - challengeCount,
      remainingSubmitCapacity: 20 - submitCount,
    };
  });
  await runCheck(checks, 'physically_reviewed_geofence', async () => {
    const document = await getDocument(collection, geofenceId);
    await validateGeofence(document, collection);
    return { secondPersonReview: true, immutableAuditMatched: true };
  });
  await checkProjectPolicy(checks);
  await checkFunctionDeployment(checks);
  await checkRules(checks);
  await checkHostingDeployment(checks);
  await checkAppCheckMonitoring(checks);

  const outcome = checks.some(check => check.status === 'FAIL')
    ? 'FAIL'
    : checks.some(check => check.status === 'INCONCLUSIVE')
      ? 'INCONCLUSIVE'
      : 'PASS';
  const output = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportType: 'attendance-security-smoke-preflight',
    phase: 'preflight',
    projectId: PROJECT_ID,
    generatedAt: startedAt,
    startedAt,
    employeeFingerprint: fingerprint(employeeUid),
    geofenceFingerprint: fingerprint(`${collection}/${geofenceId}`),
    outcome,
    readiness: outcome === 'PASS' ? 'READY_FOR_DEVICE_SMOKE' : 'NOT_READY',
    checks,
    nextStep: outcome === 'PASS'
      ? 'Lakukan check-in pada perangkat nyata, lalu jalankan phase checkin dengan startedAt ini sebelum melakukan check-out.'
      : 'Perbaiki check yang gagal atau tidak konklusif sebelum uji perangkat.',
  };
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = outcome === 'PASS' ? 0 : outcome === 'FAIL' ? 2 : 3;
};

const assertSame = (actual, expected, code) => {
  if (actual !== expected) fail(code);
};
const assertIntegerAtLeast = (value, minimum, code) => {
  if (!Number.isInteger(value) || value < minimum) fail(code);
};
const sameStringArray = (actual, expected) =>
  Array.isArray(actual) && actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

const validateLocationAtSubmission = (location, actionMs) => {
  const receivedAtMs = timestampMs(location?.serverReceivedAt);
  if (!Number.isFinite(receivedAtMs) || Math.abs(receivedAtMs - actionMs) > 1000) {
    fail('EMPLOYEE_LOCATION_TIME_MISMATCH');
  }
  return safeCore(() => core.normalizeLocation(
    location,
    receivedAtMs,
    ['serverReceivedAt'],
  ));
};

const verifyFlow = async ({
  action,
  attendance,
  uid,
  attendanceId,
  geofence,
  geofenceCollection,
  shift,
}) => {
  const prefix = action === 'checkIn' ? 'checkIn' : 'checkOut';
  const challengeId = safeCore(() => core.assertChallengeId(
    attendance.challengeIds?.[prefix]
  ));
  const actionMs = timestampMs(attendance[prefix]);
  if (!Number.isFinite(actionMs)) fail('ATTENDANCE_TIMESTAMP_INVALID');
  const path = attendance[`${prefix}PhotoPath`];
  const generation = String(attendance[`${prefix}PhotoGeneration`] || '');
  const sha = attendance[`${prefix}PhotoHash`];
  const perceptualHash = attendance[`${prefix}PhotoPerceptualHash`];
  const perceptualHashes = attendance[`${prefix}PhotoPerceptualHashes`];
  const md5Hash = attendance[`${prefix}PhotoMd5Hash`];
  const crc32c = attendance[`${prefix}PhotoCrc32c`];
  const location = attendance[`${prefix}Location`];
  const presence = action === 'checkIn'
    ? attendance.presenceProof
    : attendance.checkOutPresenceProof;
  const geofenceSnapshot = action === 'checkIn'
    ? attendance.geofenceSnapshot
    : attendance.checkOutGeofenceSnapshot;
  if (path !== `attendanceProofs/${uid}/${challengeId}` ||
      !/^\d+$/.test(generation) || !/^[0-9a-f]{64}$/.test(sha || '') ||
      !new RegExp(`^[0-9a-f]{${core.PERCEPTUAL_HASH_HEX_LENGTH}}$`)
        .test(perceptualHash || '') ||
      !Array.isArray(perceptualHashes) ||
      perceptualHashes.length !== core.PERCEPTUAL_HASH_VIEW_COUNT ||
      perceptualHashes[0] !== perceptualHash ||
      perceptualHashes.some(hash =>
        !new RegExp(`^[0-9a-f]{${core.PERCEPTUAL_HASH_HEX_LENGTH}}$`).test(hash)
      ) || typeof md5Hash !== 'string' || typeof crc32c !== 'string') {
    fail('ATTENDANCE_PHOTO_BINDING_INVALID');
  }
  if (presence?.required !== true || presence?.verified !== true ||
      presence?.grantId !== challengeId ||
      presence?.coPresence?.verified !== true) {
    fail('PRESENCE_PROOF_INVALID');
  }

  const [challenge, grant, lock] = await Promise.all([
    getDocument('attendanceChallenges', challengeId),
    getDocument('attendancePresenceGrants', challengeId),
    getDocument('attendanceChallengeLocks', `${uid}_${action}`),
  ]);
  const challengeData = challenge.data;
  const grantData = grant.data;
  const challengeCreatedAtMs = timestampMs(challengeData.createdAt);
  const challengeExpiresAtMs = timestampMs(challengeData.expiresAt);
  const challengeLastAttemptAtMs = timestampMs(challengeData.lastSubmitAttemptAt);
  if (challengeData.uid !== uid || challengeData.action !== action ||
      challengeData.status !== 'consumed' || challengeData.attendanceId !== attendanceId ||
      !isValidWorkDate(challengeData.requestDate) ||
      challengeData.targetAttendanceId !== attendanceId ||
      challengeData.targetWorkDate !== attendance.date ||
      challengeData.targetShiftRevision !== shift.revision ||
      (action === 'checkIn' && challengeData.requestDate !== attendance.date) ||
      challengeData.photoPath !== path || challengeData.appId !== WEB_APP_ID ||
      challengeData.photoGeneration !== generation ||
      challengeData.photoHash !== sha ||
      challengeData.photoPerceptualHash !== perceptualHash ||
      !sameStringArray(challengeData.photoPerceptualHashes, perceptualHashes) ||
      challengeData.geofenceCollection !== geofenceCollection ||
      challengeData.geofenceId !== geofence.id ||
      challengeData.presenceProofRequired !== true ||
      !Number.isInteger(challengeData.submitAttempts) ||
      challengeData.submitAttempts < 1 || challengeData.submitAttempts > 4 ||
      !Number.isFinite(challengeCreatedAtMs) ||
      !Number.isFinite(challengeExpiresAtMs) ||
      !Number.isFinite(challengeLastAttemptAtMs) ||
      challengeExpiresAtMs - challengeCreatedAtMs !== CHALLENGE_TTL_MS ||
      challengeCreatedAtMs > challengeLastAttemptAtMs ||
      challengeLastAttemptAtMs > actionMs || challengeCreatedAtMs > actionMs ||
      challengeExpiresAtMs <= actionMs ||
      Math.abs(timestampMs(challengeData.consumedAt) - actionMs) > 1000) {
    fail('CONSUMED_CHALLENGE_INVALID');
  }
  if (challengeData.requestDate !==
      wibDate(new Date(challengeCreatedAtMs))) {
    fail('CHALLENGE_REQUEST_DATE_INVALID');
  }
  if (grantData.challengeId !== challengeId || grantData.uid !== uid ||
      grantData.action !== action || grantData.status !== 'consumed' ||
      grantData.attendanceId !== attendanceId || grantData.issuedBy !== presence.issuedBy ||
      grantData.geofenceCollection !== geofenceCollection ||
      grantData.geofenceId !== geofence.id ||
      Math.abs(timestampMs(grantData.consumedAt) - actionMs) > 1000) {
    fail('CONSUMED_GRANT_INVALID');
  }
  if (lock.data.uid !== uid || lock.data.action !== action ||
      lock.data.challengeId !== challengeId || lock.data.status !== 'consumed' ||
      lock.data.attendanceId !== attendanceId ||
      timestampMs(lock.data.createdAt) !== timestampMs(challengeData.createdAt) ||
      timestampMs(lock.data.expiresAt) !== timestampMs(challengeData.expiresAt) ||
      Math.abs(timestampMs(lock.data.consumedAt) - actionMs) > 1000) {
    fail('CONSUMED_CHALLENGE_LOCK_INVALID');
  }
  const issuedAtMs = timestampMs(grantData.issuedAt);
  const displayExpiresAtMs = timestampMs(grantData.displayExpiresAt);
  const grantExpiresAtMs = timestampMs(grantData.expiresAt);
  if (!Number.isSafeInteger(grantData.counter) || grantData.counter < 0 ||
      presence.counter !== grantData.counter ||
      displayExpiresAtMs !== (grantData.counter + 1) *
        core.PRESENCE_CODE_PERIOD_SECONDS * 1000 ||
      grantExpiresAtMs !== (grantData.counter + 2) *
        core.PRESENCE_CODE_PERIOD_SECONDS * 1000 ||
      !Number.isFinite(issuedAtMs) || issuedAtMs < challengeCreatedAtMs ||
      issuedAtMs > actionMs || displayExpiresAtMs <= issuedAtMs ||
      grantExpiresAtMs <= actionMs) {
    fail('PRESENCE_GRANT_TIME_INVALID');
  }
  const issuer = await getDocument('users', grantData.issuedBy);
  if (issuer.data.accountStatus !== 'active' || issuer.data.isActive !== true ||
      issuer.data.mustChangePassword === true ||
      (issuer.data.role !== 'admin' && issuer.data.isAdmin !== true)) {
    fail('GRANT_ISSUER_NOT_ACTIVE_ADMIN');
  }

  const employeeLocation = validateLocationAtSubmission(location, actionMs);
  const verifierReceivedAt = timestampMs(grantData.verifierLocation?.serverReceivedAt);
  const verifierLocation = safeCore(() =>
    core.normalizeLocation(
      grantData.verifierLocation,
      verifierReceivedAt,
      [
        'distanceMeters',
        'uncertaintyAdjustedDistanceMeters',
        'serverReceivedAt',
      ],
    )
  );
  if (!Number.isFinite(verifierReceivedAt)) fail('VERIFIER_LOCATION_INVALID');
  if (verifierReceivedAt !== issuedAtMs) fail('VERIFIER_LOCATION_TIME_MISMATCH');
  const employeeDistance = core.calculateDistanceMeters(
    employeeLocation.lat, employeeLocation.lng, geofence.lat, geofence.lng
  );
  const verifierDistance = core.calculateDistanceMeters(
    verifierLocation.lat, verifierLocation.lng, geofence.lat, geofence.lng
  );
  const coPresenceDistance = core.calculateDistanceMeters(
    employeeLocation.lat,
    employeeLocation.lng,
    verifierLocation.lat,
    verifierLocation.lng,
  );
  const uncertainty = coPresenceDistance + employeeLocation.accuracy +
    verifierLocation.accuracy;
  if (![employeeDistance, verifierDistance, coPresenceDistance, uncertainty]
      .every(Number.isFinite) ||
      employeeDistance + employeeLocation.accuracy > geofence.radius ||
      verifierDistance + verifierLocation.accuracy > geofence.radius ||
      uncertainty > 100 ||
      presence.coPresence.maximumMeters !== 100 ||
      Math.abs(presence.coPresence.distanceMeters - Math.round(coPresenceDistance)) > 1 ||
      Math.abs(
        presence.coPresence.uncertaintyAdjustedDistanceMeters -
        Math.round(uncertainty)
      ) > 1 || presence.coPresence.verifierAccuracyMeters !== verifierLocation.accuracy) {
    fail('COPRESENCE_RECOMPUTATION_FAILED');
  }
  if (grantData.verifierLocation.distanceMeters !== Math.round(verifierDistance) ||
      grantData.verifierLocation.uncertaintyAdjustedDistanceMeters !==
        Math.round(verifierDistance + verifierLocation.accuracy)) {
    fail('VERIFIER_DISTANCE_BINDING_INVALID');
  }
  if (geofenceSnapshot?.id !== geofence.id ||
      geofenceSnapshot?.collection !== grantData.geofenceCollection ||
      geofenceSnapshot?.lat !== geofence.lat ||
      geofenceSnapshot?.lng !== geofence.lng ||
      geofenceSnapshot?.radius !== geofence.radius ||
      geofenceSnapshot?.verificationAuditId !== geofence.verificationAuditId ||
      geofenceSnapshot?.verificationReviewedBy !== geofence.reviewedBy ||
      geofenceSnapshot?.verificationOperator !== geofence.verificationOperator ||
      geofenceSnapshot?.verificationReviewOperator !==
        geofence.verificationReviewOperator ||
      Math.abs(timestampMs(geofenceSnapshot?.verifiedAt) - geofence.verifiedAtMs) > 1000 ||
      Math.abs(
        timestampMs(geofenceSnapshot?.verificationReviewedAt) -
        geofence.reviewedAtMs
      ) > 1000 ||
      Math.abs(geofenceSnapshot?.distanceMeters - Math.round(employeeDistance)) > 1 ||
      Math.abs(
        geofenceSnapshot?.uncertaintyAdjustedDistanceMeters -
        Math.round(employeeDistance + employeeLocation.accuracy)
      ) > 1) {
    fail('GEOFENCE_SNAPSHOT_INVALID');
  }

  return {
    action,
    actionMs,
    challengeId,
    path,
    generation,
    sha,
    perceptualHash,
    perceptualHashes,
    md5Hash,
    crc32c,
    challenge: challengeData,
    targetShiftRevision: challengeData.targetShiftRevision,
    targetWorkDate: challengeData.targetWorkDate,
  };
};

const verifyStorageObject = async flow => {
  const query = new URLSearchParams({ generation: flow.generation });
  const metadata = await api(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}` +
    `/o/${encodeURIComponent(flow.path)}?${query}`
  );
  const keys = Object.keys(metadata.metadata || {}).sort();
  if (metadata.name !== flow.path || String(metadata.generation) !== flow.generation ||
      metadata.contentType !== 'image/jpeg' || metadata.md5Hash !== flow.md5Hash ||
      metadata.crc32c !== flow.crc32c ||
      metadata.metadata?.uid !== employeeUid ||
      metadata.metadata?.challengeId !== flow.challengeId ||
      metadata.metadata?.action !== flow.action ||
      JSON.stringify(keys) !== JSON.stringify(['action', 'challengeId', 'uid']) ||
      Number(metadata.size) < 10 * 1024 || Number(metadata.size) > 2 * 1024 * 1024) {
    fail('STORAGE_OBJECT_BINDING_INVALID');
  }
  const createdAtMs = timestampMs(metadata.timeCreated);
  if (!Number.isFinite(createdAtMs) ||
      createdAtMs < timestampMs(flow.challenge.createdAt) - 1000 ||
      createdAtMs > timestampMs(flow.challenge.expiresAt) + 1000) {
    fail('STORAGE_OBJECT_TIME_INVALID');
  }
};

const verifyReplayIndexes = async (flows, attendanceId) => {
  if (flows.length < 1 ||
      new Set(flows.map(flow => flow.sha)).size !== flows.length) {
    fail('DISTINCT_PHOTO_PROOFS_REQUIRED');
  }
  const exactFields = [
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
  for (const flow of flows) {
    const [exact, perceptualAudit] = await Promise.all([
      getDocument('attendanceProofHashes', flow.sha),
      getDocument('attendanceProofPerceptualHashes', flow.sha),
    ]);
    if (exact.id !== flow.sha || perceptualAudit.id !== flow.sha ||
        !hasExactKeys(exact.data, exactFields) ||
        !hasExactKeys(perceptualAudit.data, perceptualAuditFields)) {
      fail('REPLAY_INDEX_SCHEMA_INVALID');
    }
    const exactCreatedAtMs = timestampMs(exact.data.createdAt);
    const auditCreatedAtMs = timestampMs(perceptualAudit.data.createdAt);
    for (const index of [exact.data, perceptualAudit.data]) {
      if (index.uid !== employeeUid || index.action !== flow.action ||
          index.attendanceId !== attendanceId ||
          index.challengeId !== flow.challengeId || index.photoPath !== flow.path ||
          index.sha256 !== flow.sha || index.perceptualHash !== flow.perceptualHash ||
          !sameStringArray(index.perceptualHashes, flow.perceptualHashes) ||
          timestampMs(index.createdAt) !== flow.actionMs) {
        fail('REPLAY_INDEX_BINDING_INVALID');
      }
    }
    if (exactCreatedAtMs !== auditCreatedAtMs) {
      fail('REPLAY_INDEX_TIMESTAMP_INVALID');
    }
    if (exact.data.generation !== flow.generation ||
        exact.data.md5Hash !== flow.md5Hash || exact.data.crc32c !== flow.crc32c ||
        perceptualAudit.data.schemaVersion !== 3 ||
        perceptualAudit.data.proofId !== flow.sha ||
        perceptualAudit.data.generation !== flow.generation ||
        perceptualAudit.data.hashVersion !== core.PERCEPTUAL_HASH_VERSION) {
      fail('REPLAY_INDEX_METADATA_INVALID');
    }
  }

  const replayStateDocument = await getDocument(
    'attendancePerceptualReplayStates',
    employeeUid,
  );
  const replayState = replayStateDocument.data;
  const stateFields = [
    'schemaVersion',
    'hashVersion',
    'uid',
    'windowMs',
    'maxEntries',
    'entries',
    'updatedAtMs',
  ];
  if (replayStateDocument.id !== employeeUid ||
      !hasExactKeys(replayState, stateFields) ||
      replayState.schemaVersion !== core.PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION ||
      replayState.hashVersion !== core.PERCEPTUAL_HASH_VERSION ||
      replayState.uid !== employeeUid ||
      replayState.windowMs !== core.PERCEPTUAL_REPLAY_WINDOW_MS ||
      replayState.maxEntries !== core.PERCEPTUAL_REPLAY_MAX_ENTRIES ||
      !Array.isArray(replayState.entries) ||
      replayState.entries.length < flows.length ||
      replayState.entries.length > core.PERCEPTUAL_REPLAY_MAX_ENTRIES ||
      !Number.isSafeInteger(replayState.updatedAtMs) ||
      replayState.updatedAtMs <= 0 ||
      replayState.updatedAtMs > Date.now() + 1000) {
    fail('REPLAY_STATE_SCHEMA_INVALID');
  }

  const entryFields = ['proofId', 'perceptualHashes', 'createdAtMs'];
  const proofIds = new Set();
  let previousEntry = null;
  const compareEntries = (left, right) =>
    left.createdAtMs === right.createdAtMs
      ? left.proofId.localeCompare(right.proofId)
      : left.createdAtMs - right.createdAtMs;
  for (const entry of replayState.entries) {
    const hashesValid = Array.isArray(entry?.perceptualHashes) &&
      entry.perceptualHashes.length === core.PERCEPTUAL_HASH_VIEW_COUNT &&
      entry.perceptualHashes.every(hash =>
        new RegExp(`^[0-9a-f]{${core.PERCEPTUAL_HASH_HEX_LENGTH}}$`).test(hash)
      );
    if (!hasExactKeys(entry, entryFields) ||
        !/^[0-9a-f]{64}$/.test(entry.proofId || '') ||
        proofIds.has(entry.proofId) || !hashesValid ||
        !Number.isSafeInteger(entry.createdAtMs) || entry.createdAtMs <= 0 ||
        entry.createdAtMs > replayState.updatedAtMs ||
        entry.createdAtMs <=
          replayState.updatedAtMs - core.PERCEPTUAL_REPLAY_WINDOW_MS ||
        (previousEntry && compareEntries(previousEntry, entry) >= 0)) {
      fail('REPLAY_STATE_ENTRY_INVALID');
    }
    proofIds.add(entry.proofId);
    previousEntry = entry;
  }
  for (let leftIndex = 0; leftIndex < replayState.entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1;
      rightIndex < replayState.entries.length;
      rightIndex += 1) {
      const distance = safeCore(() => core.minimumPerceptualHashDistance(
        replayState.entries[leftIndex].perceptualHashes,
        replayState.entries[rightIndex].perceptualHashes,
      ));
      if (distance <= core.PERCEPTUAL_REPLAY_MAX_DISTANCE) {
        fail('REPLAY_STATE_NEAR_DUPLICATE');
      }
    }
  }
  if (replayState.updatedAtMs !== previousEntry?.createdAtMs ||
      replayState.updatedAtMs !== Math.max(...flows.map(flow => flow.actionMs))) {
    fail('REPLAY_STATE_TIMESTAMP_INVALID');
  }
  for (const flow of flows) {
    const matchingEntries = replayState.entries.filter(
      entry => entry.proofId === flow.sha
    );
    if (matchingEntries.length !== 1 ||
        matchingEntries[0].createdAtMs !== flow.actionMs ||
        !sameStringArray(
          matchingEntries[0].perceptualHashes,
          flow.perceptualHashes,
        )) {
      fail('REPLAY_STATE_FLOW_BINDING_INVALID');
    }
  }
  return {
    exactDocumentsVerified: flows.length,
    perceptualAuditDocumentsVerified: flows.length,
    replayStateEntries: replayState.entries.length,
    currentFlowEntriesVerified: flows.length,
    replayWindowDays:
      core.PERCEPTUAL_REPLAY_WINDOW_MS / (24 * 60 * 60 * 1000),
    maximumEntriesPerUid: core.PERCEPTUAL_REPLAY_MAX_ENTRIES,
  };
};

const appCheckMetricCount = async (serviceId, startTime, endTime) => {
  const filter = [
    `metric.type = "${APP_CHECK_METRIC}"`,
    'resource.type = "firebaseappcheck.googleapis.com/Service"',
    `resource.labels.service_id = "${serviceId}"`,
    'metric.labels.result = "ALLOW"',
    'metric.labels.security = "VALID"',
    `metric.labels.app_id = "${WEB_APP_ID}"`,
  ].join(' AND ');
  let pageToken = '';
  let total = 0;
  do {
    const query = new URLSearchParams({
      filter,
      'interval.startTime': startTime,
      'interval.endTime': endTime,
      view: 'FULL',
      pageSize: '1000',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await api(
      `https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/timeSeries?${query}`
    );
    for (const series of result.timeSeries || []) {
      for (const point of series.points || []) {
        const value = Number(point.value?.int64Value || 0);
        if (!Number.isSafeInteger(value) || value < 0) {
          inconclusive('APP_CHECK_METRIC_INVALID');
        }
        total += value;
      }
    }
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return total;
};

const structuredSuccessLogs = async (
  uid,
  attendanceId,
  flows,
  startTime,
  endTime,
) => {
  const uidFingerprint = securityLogFingerprint(uid);
  const attendanceFingerprint = securityLogFingerprint(attendanceId);
  const filter = [
    `timestamp>="${startTime}"`,
    `timestamp<="${endTime}"`,
    'jsonPayload.event="attendance_security_event"',
    'jsonPayload.operation="submitAttendance"',
    'jsonPayload.outcome="success"',
    `jsonPayload.uidFingerprint="${uidFingerprint}"`,
    `jsonPayload.attendanceFingerprint="${attendanceFingerprint}"`,
    `jsonPayload.appId="${WEB_APP_ID}"`,
  ].join(' AND ');
  const result = await api('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST',
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT_ID}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize: 100,
    }),
  });
  const expectedChallenges = new Map(flows.map(flow => [
    flow.action,
    securityLogFingerprint(flow.challengeId),
  ]));
  return (result.entries || []).filter(entry => {
    const payload = entry.jsonPayload;
    return expectedChallenges.get(payload?.action) === payload?.challengeFingerprint &&
      payload?.attendanceFingerprint === attendanceFingerprint;
  });
};

const writeReport = async report => {
  const requested = args.get('--report');
  const reportPrefix = report.phase === 'checkin'
    ? 'attendance-smoke-checkin-report'
    : 'attendance-smoke-report';
  const defaultName = `.firebase/${reportPrefix}-${
    report.generatedAt.replaceAll(/[:.]/g, '-')
  }.json`;
  const filePath = resolve(String(requested || defaultName));
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  return filePath;
};

const secureReadCheckinReport = async reportArgument => {
  if (typeof reportArgument !== 'string' || reportArgument.trim() === '') {
    throw new Error(
      'Fase verify memerlukan --checkin-report=/path/report-checkin.json.'
    );
  }
  const reportPath = resolve(reportArgument);
  const pathStat = await lstat(reportPath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1) {
    throw new Error(
      'Report check-in harus regular file, bukan link, dan hanya punya satu hard link.'
    );
  }
  if ((pathStat.mode & 0o022) !== 0) {
    throw new Error('Report check-in tidak boleh group/world-writable.');
  }
  if (typeof process.getuid === 'function' && pathStat.uid !== process.getuid()) {
    throw new Error('Report check-in harus dimiliki user yang menjalankan verifier.');
  }
  if (pathStat.size <= 0 || pathStat.size > MAX_CHECKIN_REPORT_BYTES) {
    throw new Error(
      `Ukuran report check-in harus 1-${MAX_CHECKIN_REPORT_BYTES} byte.`
    );
  }

  const handle = await open(
    reportPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
  );
  try {
    const openedStat = await handle.stat();
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error('Report check-in berubah saat dibuka.');
    }
    const raw = await handle.readFile('utf8');
    const afterReadStat = await handle.stat();
    if (afterReadStat.size !== openedStat.size ||
        afterReadStat.mtimeMs !== openedStat.mtimeMs ||
        afterReadStat.ctimeMs !== openedStat.ctimeMs) {
      throw new Error('Report check-in berubah saat dibaca.');
    }
    return { raw, stat: afterReadStat };
  } finally {
    await handle.close();
  }
};

const validateCheckinReport = async ({
  reportArgument,
  expectedStartedAt,
  expectedUid,
  nowMs,
}) => {
  const { raw, stat } = await secureReadCheckinReport(reportArgument);
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error('Report check-in bukan JSON valid.');
  }
  if (!hasExactKeys(report, CHECKIN_REPORT_ROOT_KEYS) ||
      report.schemaVersion !== CHECKIN_REPORT_SCHEMA_VERSION ||
      report.reportType !== CHECKIN_REPORT_TYPE ||
      report.phase !== 'checkin' ||
      report.projectId !== PROJECT_ID ||
      report.projectNumber !== PROJECT_NUMBER ||
      report.webAppId !== WEB_APP_ID ||
      report.outcome !== 'PASS' ||
      report.readiness !== 'READY_FOR_CHECKOUT' ||
      report.startedAt !== expectedStartedAt ||
      report.employeeFingerprint !== fingerprint(expectedUid) ||
      !/^[0-9a-f]{20}$/.test(report.attendanceFingerprint || '') ||
      !/^[0-9a-f]{20}$/.test(report.shiftBindingFingerprint || '') ||
      !/^[0-9a-f]{64}$/.test(report.reportDigest || '')) {
    throw new Error('Identitas atau schema report check-in tidak valid.');
  }
  const generatedAtMs = timestampMs(report.generatedAt);
  const startedAtMs = timestampMs(report.startedAt);
  if (!Number.isFinite(generatedAtMs) ||
      !Number.isFinite(startedAtMs) ||
      generatedAtMs < startedAtMs ||
      generatedAtMs > nowMs + 1000 ||
      nowMs - generatedAtMs > MAX_REPORT_AGE_MS ||
      Math.abs(stat.mtimeMs - generatedAtMs) >
        CHECKIN_REPORT_MTIME_TOLERANCE_MS) {
    throw new Error('Window waktu atau mtime report check-in tidak valid.');
  }
  if (!Array.isArray(report.checks) ||
      report.checks.length !== CHECKIN_REPORT_CHECK_IDS.size) {
    throw new Error('Daftar check pada report check-in tidak lengkap.');
  }
  const checkIds = new Set();
  for (const check of report.checks) {
    if (!check || typeof check !== 'object' ||
        typeof check.id !== 'string' ||
        !CHECKIN_REPORT_CHECK_IDS.has(check.id) ||
        check.status !== 'PASS' ||
        checkIds.has(check.id)) {
      throw new Error('Report check-in memiliki check invalid atau duplikat.');
    }
    checkIds.add(check.id);
  }
  const unsignedReport = { ...report };
  delete unsignedReport.reportDigest;
  if (sha256(canonicalJson(unsignedReport)) !== report.reportDigest) {
    throw new Error('Digest report check-in tidak cocok.');
  }
  return report;
};

const verifyCheckIn = async () => {
  const checks = [];
  const now = new Date();
  const startedAt = String(args.get('--started-at') || '');
  const startedAtMs = timestampMs(startedAt);
  if (!Number.isFinite(startedAtMs) ||
      startedAt !== new Date(startedAtMs).toISOString()) {
    throw new Error(
      'Fase checkin membutuhkan --started-at=RFC3339 persis dari preflight.'
    );
  }
  const state = { flows: [] };

  await runCheck(checks, 'wib_checkin_window', async () => {
    if (startedAtMs > now.getTime() ||
        now.getTime() - startedAtMs > MAX_REPORT_AGE_MS) {
      fail('CHECKIN_SMOKE_WINDOW_INVALID');
    }
    return {
      startedRequestDate: wibDate(new Date(startedAtMs)),
      observedDate: wibDate(now),
      maximumAgeHours: MAX_REPORT_AGE_MS / 3_600_000,
    };
  });
  await runCheck(
    checks,
    'active_canonical_employee_and_geofence',
    async () => {
      const userDocument = await getDocument('users', employeeUid);
      state.user = validateEmployee(userDocument);
      const geofenceDocument = await getDocument(
        state.user.assignment.collection,
        state.user.assignment.id,
      );
      state.geofence = await validateGeofence(
        geofenceDocument,
        state.user.assignment.collection,
      );
      return {
        assignmentType: state.user.assignment.collection,
        secondPersonReview: true,
      };
    },
  );
  await runCheck(checks, 'open_shift_after_checkin', async () => {
    const openShiftDocument = await getDocument(
      'attendanceOpenShifts',
      employeeUid,
    );
    const shift = validateOpenShiftDocument(
      openShiftDocument,
      employeeUid,
      'open',
    );
    const attendanceDocument = await getDocument(
      'attendances',
      shift.attendanceId,
    );
    const attendance = attendanceDocument.data;
    if (attendance.userId !== employeeUid ||
        attendance.date !== shift.workDate ||
        attendance.date !== wibDate(new Date(shift.checkInMs)) ||
        attendance.integrityVersion !== 2 ||
        attendance.proofVersion !== 2 ||
        attendance.verificationStatus !== 'verified' ||
        attendance.transitionMode !== false ||
        attendance.isWithinRadius !== true ||
        timestampMs(attendance.checkIn) !== shift.checkInMs ||
        timestampMs(attendance.createdAt) !== shift.checkInMs ||
        timestampMs(attendance.updatedAt) !== shift.checkInMs ||
        shift.checkInMs < startedAtMs ||
        shift.checkInMs > now.getTime() + 1000 ||
        attendance.checkOut !== null ||
        attendance.challengeIds?.checkOut !== null ||
        attendance.checkOutPhotoPath !== null ||
        attendance.workHours !== 0) {
      fail('OPEN_SHIFT_CHECKIN_INVARIANT_FAILED');
    }
    state.openShift = shift;
    state.attendanceDocument = attendanceDocument;
    return {
      status: 'open',
      targetWorkDate: shift.workDate,
      targetShiftRevision: shift.revision,
      attendanceFingerprint: fingerprint(attendanceDocument.id),
      shiftBindingFingerprint: shiftBindingFingerprint(shift),
    };
  });
  await runCheck(checks, 'checkin_consumed_flow', async () => {
    if (!state.openShift || !state.attendanceDocument ||
        !state.geofence || !state.user) {
      fail('CHECKIN_FLOW_PREREQUISITE_FAILED');
    }
    const flow = await verifyFlow({
      action: 'checkIn',
      attendance: state.attendanceDocument.data,
      uid: employeeUid,
      attendanceId: state.attendanceDocument.id,
      geofence: state.geofence,
      geofenceCollection: state.user.assignment.collection,
      shift: state.openShift,
    });
    state.flows = [flow];
    return {
      completedAction: 'checkIn',
      targetWorkDate: flow.targetWorkDate,
      targetShiftRevision: flow.targetShiftRevision,
      challengeFingerprint: fingerprint(flow.challengeId),
    };
  });
  await runCheck(checks, 'checkin_immutable_storage_object', async () => {
    if (state.flows.length !== 1) fail('CHECKIN_FLOW_PREREQUISITE_FAILED');
    await verifyStorageObject(state.flows[0]);
    return { objectsVerified: 1, bytesDownloaded: 0 };
  });
  await runCheck(checks, 'checkin_replay_state', async () => {
    if (state.flows.length !== 1 || !state.attendanceDocument) {
      fail('CHECKIN_FLOW_PREREQUISITE_FAILED');
    }
    const evidence = await verifyReplayIndexes(
      state.flows,
      state.attendanceDocument.id,
    );
    return {
      exactIndexesVerified: 1,
      perceptualAuditDocumentsVerified: 1,
      rollingStateVerified: true,
      hashVersion: core.PERCEPTUAL_HASH_VERSION,
      ...evidence,
    };
  });

  const outcome = checks.some(check => check.status === 'FAIL')
    ? 'FAIL'
    : checks.some(check => check.status === 'INCONCLUSIVE')
      ? 'INCONCLUSIVE'
      : 'PASS';
  const generatedAt = new Date().toISOString();
  const attendanceId = state.attendanceDocument?.id || 'unresolved';
  const report = {
    schemaVersion: CHECKIN_REPORT_SCHEMA_VERSION,
    reportType: CHECKIN_REPORT_TYPE,
    phase: 'checkin',
    projectId: PROJECT_ID,
    projectNumber: PROJECT_NUMBER,
    webAppId: WEB_APP_ID,
    generatedAt,
    startedAt,
    employeeFingerprint: fingerprint(employeeUid),
    attendanceFingerprint: fingerprint(attendanceId),
    shiftBindingFingerprint: state.openShift
      ? shiftBindingFingerprint(state.openShift)
      : fingerprint('unresolved'),
    outcome,
    readiness: outcome === 'PASS' ? 'READY_FOR_CHECKOUT' : 'NOT_READY',
    checks,
  };
  report.reportDigest = sha256(canonicalJson(report));
  const reportPath = await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
  console.error(`Report check-in tersimpan aman: ${reportPath}`);
  if (outcome === 'PASS') {
    console.error(
      'Lakukan check-out, lalu jalankan phase verify dengan --checkin-report=' +
      reportPath,
    );
  }
  process.exitCode = outcome === 'PASS' ? 0 : outcome === 'FAIL' ? 2 : 3;
};

const verify = async () => {
  const checks = [];
  const now = new Date();
  const endTime = now.toISOString();
  const startedAt = String(args.get('--started-at') || '');
  const startedAtMs = timestampMs(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new Error('Fase verify membutuhkan --started-at=RFC3339 dari preflight.');
  }
  const canonicalStartedAt = new Date(startedAtMs).toISOString();
  if (startedAt !== canonicalStartedAt) {
    throw new Error('--started-at harus timestamp ISO persis dari output preflight.');
  }
  const checkinReport = await validateCheckinReport({
    reportArgument: args.get('--checkin-report'),
    expectedStartedAt: canonicalStartedAt,
    expectedUid: employeeUid,
    nowMs: now.getTime(),
  });
  const state = {
    checkinReport,
    flows: [],
    metrics: { firestore: 0, storage: 0 },
    logs: 0,
  };
  const date = wibDate(now);

  await runCheck(checks, 'wib_smoke_window', async () => {
    if (startedAtMs > now.getTime() ||
        now.getTime() - startedAtMs > MAX_REPORT_AGE_MS) {
      fail('SMOKE_WINDOW_INVALID');
    }
    return {
      startedRequestDate: wibDate(new Date(startedAtMs)),
      verificationDate: date,
      maximumAgeHours: MAX_REPORT_AGE_MS / 3_600_000,
      crossMidnightCheckoutSupported: true,
    };
  });
  await runCheck(checks, 'active_canonical_employee_and_geofence', async () => {
    const userDocument = await getDocument('users', employeeUid);
    state.user = validateEmployee(userDocument);
    const geofenceDocument = await getDocument(
      state.user.assignment.collection,
      state.user.assignment.id,
    );
    state.geofence = await validateGeofence(
      geofenceDocument,
      state.user.assignment.collection,
    );
    return {
      assignmentType: state.user.assignment.collection,
      secondPersonReview: true,
    };
  });
  await checkProjectPolicy(checks);
  await checkFunctionDeployment(checks);
  await checkRules(checks);
  await checkHostingDeployment(checks);
  await checkAppCheckMonitoring(checks);

  await runCheck(checks, 'completed_v2_attendance', async () => {
    const openShiftDocument = await getDocument(
      'attendanceOpenShifts',
      employeeUid,
    );
    const shift = validateOpenShiftDocument(
      openShiftDocument,
      employeeUid,
      'closed',
      'verified-checkout',
    );
    const attendanceDocument = await getDocument(
      'attendances',
      shift.attendanceId,
    );
    const attendance = attendanceDocument.data;
    if (attendanceDocument.id !== shift.attendanceId ||
        attendance.userId !== employeeUid || attendance.date !== shift.workDate ||
        attendance.integrityVersion !== 2 || attendance.proofVersion !== 2 ||
        attendance.verificationStatus !== 'verified' ||
        attendance.transitionMode !== false || attendance.isWithinRadius !== true ||
        !Number.isFinite(timestampMs(attendance.checkIn)) ||
        !Number.isFinite(timestampMs(attendance.checkOut)) ||
        timestampMs(attendance.createdAt) !== shift.checkInMs ||
        timestampMs(attendance.updatedAt) !== shift.closedAtMs ||
        timestampMs(attendance.checkIn) !== shift.checkInMs ||
        timestampMs(attendance.checkOut) !== shift.closedAtMs ||
        attendance.date !== wibDate(new Date(shift.checkInMs)) ||
        attendance.challengeIds?.checkOut !== shift.checkOutChallengeId ||
        attendance.checkOutDateWib !== wibDate(new Date(shift.closedAtMs)) ||
        checkinReport.attendanceFingerprint !==
          fingerprint(attendanceDocument.id) ||
        checkinReport.shiftBindingFingerprint !==
          shiftBindingFingerprint(shift) ||
        timestampMs(checkinReport.generatedAt) < shift.checkInMs ||
        timestampMs(checkinReport.generatedAt) > shift.closedAtMs ||
        timestampMs(attendance.checkIn) < startedAtMs ||
        timestampMs(attendance.checkOut) < timestampMs(attendance.checkIn) ||
        timestampMs(attendance.checkOut) > now.getTime() + 1000) {
      fail('ATTENDANCE_V2_INVARIANT_FAILED');
    }
    state.openShift = shift;
    state.attendanceDocument = attendanceDocument;
    return {
      completeActions: 2,
      integrityVersion: 2,
      proofVersion: 2,
      openShiftStatus: 'closed',
      checkInOpenShiftObserved: true,
      checkinReportFingerprint: fingerprint(checkinReport.reportDigest),
      targetWorkDate: shift.workDate,
      targetShiftRevision: shift.revision,
    };
  });

  await runCheck(checks, 'distinct_consumed_flows', async () => {
    if (!state.attendanceDocument || !state.geofence || !state.openShift) {
      fail('ATTENDANCE_PREREQUISITE_FAILED');
    }
    const attendance = state.attendanceDocument.data;
    const attendanceId = state.attendanceDocument.id;
    state.flows = await Promise.all(['checkIn', 'checkOut'].map(action =>
      verifyFlow({
        action,
        attendance,
        uid: employeeUid,
        attendanceId,
        geofence: state.geofence,
        geofenceCollection: state.user.assignment.collection,
        shift: state.openShift,
      })
    ));
    if (new Set(state.flows.map(flow => flow.challengeId)).size !== 2 ||
        new Set(state.flows.map(flow => flow.path)).size !== 2 ||
        state.openShift.checkOutChallengeId !==
          state.flows.find(flow => flow.action === 'checkOut')?.challengeId ||
        state.flows.some(flow =>
          flow.targetWorkDate !== state.openShift.workDate ||
          flow.targetShiftRevision !== state.openShift.revision
        )) {
      fail('FLOW_PROOFS_NOT_DISTINCT');
    }
    return {
      completedActions: ['checkIn', 'checkOut'],
      distinctChallenges: 2,
      attendanceFingerprint: fingerprint(attendanceId),
      challengeFingerprints: state.flows.map(flow => fingerprint(flow.challengeId)),
    };
  });

  await runCheck(checks, 'immutable_storage_objects', async () => {
    if (state.flows.length !== 2) fail('FLOW_PREREQUISITE_FAILED');
    await Promise.all(state.flows.map(verifyStorageObject));
    return {
      objectsVerified: 2,
      bytesDownloaded: 0,
      generationsDistinct: new Set(state.flows.map(flow => flow.generation)).size,
    };
  });

  // The v3 enforcement gate consumes this stable check ID. The evidence now
  // verifies SHA-keyed immutable audits plus the per-UID rolling state; legacy
  // perceptual band guards are intentionally neither read nor trusted.
  await runCheck(checks, 'replay_indexes_and_guards', async () => {
    if (state.flows.length !== 2 || !state.attendanceDocument) {
      fail('FLOW_PREREQUISITE_FAILED');
    }
    const replayEvidence = await verifyReplayIndexes(
      state.flows,
      state.attendanceDocument.id,
    );
    return {
      exactIndexesVerified: 2,
      perceptualAuditDocumentsVerified: 2,
      rollingStateVerified: true,
      hashVersion: core.PERCEPTUAL_HASH_VERSION,
      ...replayEvidence,
    };
  });

  await runCheck(checks, 'structured_success_telemetry', async () => {
    if (state.flows.length !== 2 || !state.attendanceDocument) {
      fail('FLOW_PREREQUISITE_FAILED');
    }
    const entries = await structuredSuccessLogs(
      employeeUid,
      state.attendanceDocument.id,
      state.flows,
      canonicalStartedAt,
      endTime,
    );
    const actions = new Set(entries.map(entry => entry.jsonPayload?.action));
    state.logs = entries.length;
    if (!actions.has('checkIn') || !actions.has('checkOut')) {
      inconclusive('STRUCTURED_LOGS_NOT_YET_INGESTED');
    }
    return {
      successEvents: entries.length,
      distinctActions: actions.size,
      challengeBoundFlows: actions.size,
    };
  });

  await runCheck(checks, 'app_check_valid_allow_metrics', async () => {
    const [firestore, storage] = await Promise.all([
      appCheckMetricCount('firestore.googleapis.com', canonicalStartedAt, endTime),
      appCheckMetricCount('firebasestorage.googleapis.com', canonicalStartedAt, endTime),
    ]);
    state.metrics = { firestore, storage };
    if (firestore <= 0 || storage <= 0) {
      inconclusive('APP_CHECK_VALID_ALLOW_METRICS_MISSING');
    }
    return {
      firestoreValidAllow: firestore,
      storageValidAllow: storage,
      scope: 'web-app-service-window',
    };
  });

  const outcome = checks.some(check => check.status === 'FAIL')
    ? 'FAIL'
    : checks.some(check => check.status === 'INCONCLUSIVE')
      ? 'INCONCLUSIVE'
      : 'PASS';
  const completedActions = state.flows.length === 2
    ? ['checkIn', 'checkOut']
    : [];
  const distinctChallengeCount = new Set(
    state.flows.map(flow => flow.challengeId)
  ).size;
  const geofenceKey = state.user
    ? `${state.user.assignment.collection}/${state.user.assignment.id}`
    : 'unresolved';
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportType: 'attendance-security-smoke',
    projectId: PROJECT_ID,
    projectNumber: PROJECT_NUMBER,
    webAppId: WEB_APP_ID,
    phase: 'verify',
    generatedAt: endTime,
    startedAt: canonicalStartedAt,
    employeeFingerprint: fingerprint(employeeUid),
    geofenceFingerprint: fingerprint(geofenceKey),
    outcome,
    readiness: outcome === 'PASS' ? 'READY' : 'NOT_READY',
    checks,
    summary: {
      verifiedAttendanceFlows: state.flows.length,
      distinctConsumedChallenges: distinctChallengeCount,
      firestoreValidAllowCount: state.metrics.firestore,
      storageValidAllowCount: state.metrics.storage,
      structuredSuccessEventCount: state.logs,
    },
    enforcementGate: {
      eligible: outcome === 'PASS',
      completedActions,
      distinctChallengeCount,
      firestoreValidAllowCount: state.metrics.firestore,
      storageValidAllowCount: state.metrics.storage,
    },
  };
  report.reportDigest = sha256(canonicalJson(report));
  const reportPath = await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
  console.error(`Laporan smoke tersimpan aman: ${reportPath}`);
  process.exitCode = outcome === 'PASS' ? 0 : outcome === 'FAIL' ? 2 : 3;
};

if (phase === 'preflight') {
  await preflight();
} else if (phase === 'checkin') {
  await verifyCheckIn();
} else {
  await verify();
}
