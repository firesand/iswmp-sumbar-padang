#!/usr/bin/env node

/**
 * Configure Firebase App Check enforcement for the two client data services.
 * Defaults to a read-only UNENFORCED preview. ENFORCED additionally requires
 * a fresh, internally consistent field-smoke report and live metric checks.
 *
 * A SHA-256 report digest detects corruption only; it is not an authorization
 * signature. The gate therefore also checks local file safety and re-queries
 * App Check/Cloud Monitoring before changing production state.
 */

import authModule from 'firebase-tools/lib/auth.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { readLiveHostingEvidence } from './lib/hosting-deployment-evidence.mjs';

const PROJECT_ID = 'iswmp-sumbar-padang';
const PROJECT_NUMBER = '1079074812491';
const WEB_APP_ID = '1:1079074812491:web:28a1a3fa33933c5ca9d3ce';
const BUCKET = 'iswmp-sumbar-padang.firebasestorage.app';
const REGION = 'asia-southeast2';
const RUNTIME_SERVICE_ACCOUNT =
  `attendance-runtime@${PROJECT_ID}.iam.gserviceaccount.com`;
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
const REPORT_TYPE = 'attendance-security-smoke';
const REPORT_SCHEMA_VERSION = 3;
const REPORT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const REPORT_MTIME_TOLERANCE_MS = 10 * 60 * 1000;
const MAX_REPORT_BYTES = 512 * 1024;
const SERVICES = [
  'firestore.googleapis.com',
  'firebasestorage.googleapis.com',
];
const ALLOWED_MODES = new Set(['UNENFORCED', 'ENFORCED']);
const REQUIRED_ACTIONS = new Set(['checkIn', 'checkOut']);
const REQUIRED_CHECK_IDS = new Set([
  'wib_smoke_window',
  'active_canonical_employee_and_geofence',
  'project_policy_v2',
  'functions_deployment',
  'deployed_security_rules',
  'hosting_deployment',
  'app_check_monitoring_mode',
  'completed_v2_attendance',
  'distinct_consumed_flows',
  'immutable_storage_objects',
  'replay_indexes_and_guards',
  'structured_success_telemetry',
  'app_check_valid_allow_metrics',
]);
const REPORT_ROOT_KEYS = new Set([
  'schemaVersion',
  'reportType',
  'projectId',
  'projectNumber',
  'webAppId',
  'phase',
  'generatedAt',
  'startedAt',
  'outcome',
  'readiness',
  'employeeFingerprint',
  'geofenceFingerprint',
  'checks',
  'summary',
  'enforcementGate',
  'reportDigest',
]);

const VALUE_ARGUMENTS = new Set([
  '--mode',
  '--smoke-report',
  '--confirm-production-enforcement',
  '--confirm-production-monitoring',
]);
const args = new Map();
for (const argument of process.argv.slice(2)) {
  if (argument === '--apply') {
    if (args.has('--apply')) throw new Error('--apply tidak boleh diulang.');
    args.set('--apply', true);
    continue;
  }
  const separator = argument.indexOf('=');
  const key = separator > 0 ? argument.slice(0, separator) : argument;
  const value = separator > 0 ? argument.slice(separator + 1) : '';
  if (key === '--apply') {
    throw new Error('--apply adalah flag tanpa nilai; bentuk --apply=... ditolak.');
  }
  if (!VALUE_ARGUMENTS.has(key) || separator < 0) {
    throw new Error(`Argumen tidak dikenal atau tidak lengkap: ${argument}`);
  }
  if (!value) throw new Error(`${key} wajib memiliki nilai.`);
  if (args.has(key)) throw new Error(`${key} tidak boleh diulang.`);
  args.set(key, value);
}
const apply = args.get('--apply') === true;
const mode = String(args.get('--mode') || 'UNENFORCED').toUpperCase();

if (!ALLOWED_MODES.has(mode)) {
  throw new Error('--mode harus UNENFORCED atau ENFORCED.');
}
if (apply && !args.has('--mode')) {
  throw new Error('Mode --apply wajib menyebut --mode secara eksplisit.');
}
if (mode !== 'ENFORCED' && args.has('--smoke-report')) {
  throw new Error('--smoke-report hanya berlaku untuk mode ENFORCED.');
}
if (apply && mode === 'ENFORCED' &&
    args.get('--confirm-production-enforcement') !== 'VALID_TOKENS_VERIFIED') {
  throw new Error(
    'ENFORCED memerlukan --confirm-production-enforcement=VALID_TOKENS_VERIFIED.'
  );
}
if ((!apply || mode !== 'ENFORCED') &&
    args.has('--confirm-production-enforcement')) {
  throw new Error('Konfirmasi enforcement hanya berlaku untuk --apply ENFORCED.');
}
if (apply && mode === 'UNENFORCED' &&
    args.get('--confirm-production-monitoring') !== 'MONITORING_MODE_CONFIRMED') {
  throw new Error(
    'UNENFORCED --apply memerlukan ' +
    '--confirm-production-monitoring=MONITORING_MODE_CONFIRMED.'
  );
}
if ((!apply || mode !== 'UNENFORCED') &&
    args.has('--confirm-production-monitoring')) {
  throw new Error('Konfirmasi monitoring hanya berlaku untuk --apply UNENFORCED.');
}

const isPlainObject = value => value !== null &&
  typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Canonical JSON: recursively sorted object keys; array order is preserved. */
const canonicalJson = value => {
  if (value === null || typeof value === 'boolean' ||
      typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Laporan berisi angka non-finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  throw new Error('Laporan berisi tipe data yang tidak didukung.');
};

const sha256 = value => createHash('sha256').update(value).digest('hex');
const smokeFingerprint = value => sha256(
  `attendance-smoke-v1\u0000${String(value)}`
).slice(0, 20);
const canonicalIamBindings = bindings => (bindings || []).map(binding => ({
  role: binding.role,
  members: [...(binding.members || [])].sort(),
  ...(binding.condition ? { condition: binding.condition } : {}),
})).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));

const assertExactKeys = (value, allowedKeys, label) => {
  const unknown = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} memiliki field tidak dikenal: ${unknown.join(', ')}.`);
  }
};

const assertSafeInteger = (value, label, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} harus integer aman >= ${minimum}.`);
  }
};

const parseRfc3339 = (value, label) => {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label} harus timestamp RFC3339.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} tidak valid.`);
  }
  return milliseconds;
};

const secureReadReport = reportArgument => {
  if (typeof reportArgument !== 'string' || reportArgument.trim() === '') {
    throw new Error('ENFORCED memerlukan --smoke-report=/path/report.json.');
  }

  const reportPath = resolve(reportArgument);
  const pathStat = lstatSync(reportPath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error('Smoke report harus regular file dan bukan symbolic link.');
  }
  if (pathStat.nlink !== 1) {
    throw new Error('Smoke report dengan hard link ditolak.');
  }
  if ((pathStat.mode & 0o022) !== 0) {
    throw new Error('Smoke report tidak boleh group/world-writable.');
  }
  if (typeof process.getuid === 'function' && pathStat.uid !== process.getuid()) {
    throw new Error('Smoke report harus dimiliki oleh user yang menjalankan gate.');
  }
  if (pathStat.size <= 0 || pathStat.size > MAX_REPORT_BYTES) {
    throw new Error(`Ukuran smoke report harus 1-${MAX_REPORT_BYTES} byte.`);
  }

  const descriptor = openSync(
    reportPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
  );
  try {
    const openedStat = fstatSync(descriptor);
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error('Smoke report berubah saat dibuka.');
    }
    const raw = readFileSync(descriptor, 'utf8');
    const afterReadStat = fstatSync(descriptor);
    if (afterReadStat.size !== openedStat.size ||
        afterReadStat.mtimeMs !== openedStat.mtimeMs ||
        afterReadStat.ctimeMs !== openedStat.ctimeMs) {
      throw new Error('Smoke report berubah saat dibaca.');
    }
    return { reportPath, raw, stat: afterReadStat };
  } finally {
    closeSync(descriptor);
  }
};

const validateSmokeReport = reportArgument => {
  const { reportPath, raw, stat } = secureReadReport(reportArgument);
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error('Smoke report bukan JSON valid.');
  }
  if (!isPlainObject(report)) throw new Error('Root smoke report harus object.');
  assertExactKeys(report, REPORT_ROOT_KEYS, 'Smoke report');

  if (report.schemaVersion !== REPORT_SCHEMA_VERSION ||
      report.reportType !== REPORT_TYPE || report.phase !== 'verify') {
    throw new Error('Schema/type/phase smoke report tidak sesuai gate v3.');
  }
  if (report.projectId !== PROJECT_ID || report.projectNumber !== PROJECT_NUMBER ||
      report.webAppId !== WEB_APP_ID) {
    throw new Error('Project ID, project number, atau Web App ID pada report tidak cocok.');
  }
  if (report.outcome !== 'PASS' || report.readiness !== 'READY') {
    throw new Error('Smoke report belum berstatus PASS dan READY.');
  }
  if (!/^[a-f0-9]{20}$/.test(report.employeeFingerprint || '') ||
      !/^[a-f0-9]{20}$/.test(report.geofenceFingerprint || '')) {
    throw new Error('Fingerprint employee/geofence pada report tidak valid.');
  }

  const now = Date.now();
  const generatedAtMs = parseRfc3339(report.generatedAt, 'generatedAt');
  const startedAtMs = parseRfc3339(report.startedAt, 'startedAt');
  if (generatedAtMs > now + CLOCK_SKEW_MS || startedAtMs > now + CLOCK_SKEW_MS) {
    throw new Error('Timestamp smoke report berada terlalu jauh di masa depan.');
  }
  if (now - generatedAtMs > REPORT_MAX_AGE_MS ||
      now - startedAtMs > REPORT_MAX_AGE_MS) {
    throw new Error('Smoke report atau window pengujiannya lebih tua dari 6 jam.');
  }
  if (startedAtMs > generatedAtMs || generatedAtMs - startedAtMs > REPORT_MAX_AGE_MS) {
    throw new Error('Window smoke report tidak valid atau lebih panjang dari 6 jam.');
  }
  if (Math.abs(stat.mtimeMs - generatedAtMs) > REPORT_MTIME_TOLERANCE_MS) {
    throw new Error('mtime file tidak konsisten dengan generatedAt smoke report.');
  }

  if (!Array.isArray(report.checks) || report.checks.length === 0) {
    throw new Error('Smoke report tidak memiliki checks.');
  }
  const checkIds = new Set();
  const checksById = new Map();
  for (const check of report.checks) {
    if (!isPlainObject(check) || typeof check.id !== 'string' ||
        !/^[a-zA-Z0-9._:-]{1,100}$/.test(check.id) || check.status !== 'PASS') {
      throw new Error('Semua smoke check harus memiliki id valid dan status PASS.');
    }
    if (checkIds.has(check.id)) throw new Error(`Smoke check duplikat: ${check.id}.`);
    checkIds.add(check.id);
    checksById.set(check.id, check);
  }
  if (checkIds.size !== REQUIRED_CHECK_IDS.size ||
      [...REQUIRED_CHECK_IDS].some(id => !checkIds.has(id))) {
    throw new Error('Daftar smoke check tidak lengkap atau tidak sesuai schema v3.');
  }

  const summary = report.summary;
  if (!isPlainObject(summary)) throw new Error('summary smoke report tidak valid.');
  assertSafeInteger(summary.verifiedAttendanceFlows, 'verifiedAttendanceFlows', 2);
  assertSafeInteger(summary.distinctConsumedChallenges, 'distinctConsumedChallenges', 2);
  assertSafeInteger(summary.firestoreValidAllowCount, 'firestoreValidAllowCount', 1);
  assertSafeInteger(summary.storageValidAllowCount, 'storageValidAllowCount', 1);
  assertSafeInteger(summary.structuredSuccessEventCount, 'structuredSuccessEventCount', 2);
  if (summary.verifiedAttendanceFlows !== 2 ||
      summary.distinctConsumedChallenges !== 2) {
    throw new Error('Report harus membuktikan tepat dua flow dan dua challenge berbeda.');
  }

  const completedEvidence = checksById.get('completed_v2_attendance')?.evidence;
  if (!isPlainObject(completedEvidence)) {
    throw new Error('Evidence attendance v2 lengkap tidak valid.');
  }
  assertExactKeys(completedEvidence, new Set([
    'completeActions',
    'integrityVersion',
    'proofVersion',
    'openShiftStatus',
    'checkInOpenShiftObserved',
    'checkinReportFingerprint',
    'targetWorkDate',
    'targetShiftRevision',
  ]), 'Evidence attendance v2');
  if (
      completedEvidence.completeActions !== 2 ||
      completedEvidence.integrityVersion !== 2 ||
      completedEvidence.proofVersion !== 2 ||
      completedEvidence.openShiftStatus !== 'closed' ||
      completedEvidence.checkInOpenShiftObserved !== true ||
      !/^[a-f0-9]{20}$/.test(
        completedEvidence.checkinReportFingerprint || ''
      ) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(
        completedEvidence.targetWorkDate || ''
      ) ||
      !Number.isSafeInteger(completedEvidence.targetShiftRevision) ||
      completedEvidence.targetShiftRevision < 1) {
    throw new Error('Evidence attendance v2 lengkap tidak valid.');
  }
  const projectPolicyEvidence = checksById.get('project_policy_v2')?.evidence;
  if (!isPlainObject(projectPolicyEvidence) ||
      projectPolicyEvidence.attendanceSecurityVersion !== 2 ||
      projectPolicyEvidence.transitionMode !== false ||
      projectPolicyEvidence.firestoreDataWriteAudit !== true ||
      projectPolicyEvidence.auditExemptionCount !== 0 ||
      !/^[a-f0-9]{20}$/.test(
        projectPolicyEvidence.iamBindingsFingerprint || ''
      )) {
    throw new Error('Evidence policy project/audit DATA_WRITE tidak valid.');
  }
  const flowEvidence = checksById.get('distinct_consumed_flows')?.evidence;
  if (!isPlainObject(flowEvidence) ||
      !Array.isArray(flowEvidence.completedActions) ||
      flowEvidence.completedActions.length !== 2 ||
      new Set(flowEvidence.completedActions).size !== 2 ||
      flowEvidence.completedActions.some(action => !REQUIRED_ACTIONS.has(action)) ||
      !/^[a-f0-9]{20}$/.test(flowEvidence.attendanceFingerprint || '') ||
      !Array.isArray(flowEvidence.challengeFingerprints) ||
      flowEvidence.challengeFingerprints.length !== 2 ||
      new Set(flowEvidence.challengeFingerprints).size !== 2 ||
      flowEvidence.challengeFingerprints.some(value => !/^[a-f0-9]{20}$/.test(value))) {
    throw new Error('Evidence dua attendance flow/challenge berbeda tidak valid.');
  }
  const appCheckEvidence = checksById.get('app_check_monitoring_mode')?.evidence;
  if (!isPlainObject(appCheckEvidence) ||
      appCheckEvidence.firestore !== 'UNENFORCED' ||
      appCheckEvidence.storage !== 'UNENFORCED' ||
      appCheckEvidence.providerConfigured !== true ||
      !/^[a-f0-9]{20}$/.test(appCheckEvidence.providerConfigFingerprint || '')) {
    throw new Error('Evidence konfigurasi App Check monitoring tidak valid.');
  }
  const storageEvidence = checksById.get('immutable_storage_objects')?.evidence;
  if (!isPlainObject(storageEvidence) || storageEvidence.objectsVerified !== 2 ||
      storageEvidence.bytesDownloaded !== 0 ||
      !Number.isSafeInteger(storageEvidence.generationsDistinct) ||
      storageEvidence.generationsDistinct < 1 ||
      storageEvidence.generationsDistinct > 2) {
    throw new Error('Evidence dua object Storage immutable tidak valid.');
  }
  const replayEvidence = checksById.get('replay_indexes_and_guards')?.evidence;
  if (!isPlainObject(replayEvidence)) {
    throw new Error('Evidence replay exact/perceptual/rolling-state tidak valid.');
  }
  assertExactKeys(replayEvidence, new Set([
    'exactIndexesVerified',
    'perceptualAuditDocumentsVerified',
    'rollingStateVerified',
    'hashVersion',
    'exactDocumentsVerified',
    'replayStateEntries',
    'currentFlowEntriesVerified',
    'replayWindowDays',
    'maximumEntriesPerUid',
  ]), 'Evidence replay');
  if (replayEvidence.exactIndexesVerified !== 2 ||
      replayEvidence.perceptualAuditDocumentsVerified !== 2 ||
      replayEvidence.rollingStateVerified !== true ||
      replayEvidence.hashVersion !== 'dh144mv2' ||
      replayEvidence.exactDocumentsVerified !== 2 ||
      replayEvidence.currentFlowEntriesVerified !== 2 ||
      replayEvidence.replayWindowDays !== 30 ||
      replayEvidence.maximumEntriesPerUid !== 64 ||
      !Number.isSafeInteger(replayEvidence.replayStateEntries) ||
      replayEvidence.replayStateEntries < 2 ||
      replayEvidence.replayStateEntries >
        replayEvidence.maximumEntriesPerUid) {
    throw new Error('Evidence replay exact/perceptual/rolling-state tidak valid.');
  }
  const hostingEvidence = checksById.get('hosting_deployment')?.evidence;
  const hostingFingerprintKeys = [
    'versionFingerprint',
    'releaseFingerprint',
    'deploymentConfigFingerprint',
    'publicManifestFingerprint',
    'deployedManifestFingerprint',
    'indexFingerprint',
    'entryScriptFingerprint',
    'serviceWorkerFingerprint',
  ];
  if (!isPlainObject(hostingEvidence)) {
    throw new Error('Evidence deployment Hosting tidak valid.');
  }
  assertExactKeys(hostingEvidence, new Set([
    ...hostingFingerprintKeys,
    'verifiedPublicFiles',
    'hostingFileCount',
    'internalHostingFiles',
    'strictScriptCsp',
  ]), 'Evidence deployment Hosting');
  if (hostingFingerprintKeys.some(key =>
    !/^[a-f0-9]{20}$/.test(hostingEvidence[key] || '')
  )) {
    throw new Error('Fingerprint deployment Hosting tidak valid.');
  }
  assertSafeInteger(hostingEvidence.verifiedPublicFiles, 'verifiedPublicFiles', 1);
  assertSafeInteger(hostingEvidence.hostingFileCount, 'hostingFileCount', 1);
  assertSafeInteger(hostingEvidence.internalHostingFiles, 'internalHostingFiles', 0);
  if (hostingEvidence.hostingFileCount !==
        hostingEvidence.verifiedPublicFiles + hostingEvidence.internalHostingFiles ||
      hostingEvidence.internalHostingFiles !== 2 ||
      hostingEvidence.strictScriptCsp !== true) {
    throw new Error('Jumlah file atau status CSP Hosting tidak konsisten.');
  }
  const telemetryEvidence = checksById.get('structured_success_telemetry')?.evidence;
  if (!isPlainObject(telemetryEvidence) ||
      telemetryEvidence.successEvents !== summary.structuredSuccessEventCount ||
      telemetryEvidence.distinctActions !== 2 ||
      telemetryEvidence.challengeBoundFlows !== 2) {
    throw new Error('Evidence telemetry sukses tidak konsisten dengan summary.');
  }
  const metricEvidence = checksById.get('app_check_valid_allow_metrics')?.evidence;
  if (!isPlainObject(metricEvidence) ||
      metricEvidence.firestoreValidAllow !== summary.firestoreValidAllowCount ||
      metricEvidence.storageValidAllow !== summary.storageValidAllowCount ||
      metricEvidence.scope !== 'web-app-service-window') {
    throw new Error('Evidence metric App Check tidak konsisten dengan summary.');
  }

  const gate = report.enforcementGate;
  if (!isPlainObject(gate) || gate.eligible !== true) {
    throw new Error('enforcementGate belum eligible.');
  }
  if (!Array.isArray(gate.completedActions) || gate.completedActions.length !== 2 ||
      new Set(gate.completedActions).size !== 2 ||
      gate.completedActions.some(action => !REQUIRED_ACTIONS.has(action))) {
    throw new Error('completedActions harus tepat checkIn dan checkOut tanpa duplikat.');
  }
  assertSafeInteger(gate.distinctChallengeCount, 'distinctChallengeCount', 2);
  assertSafeInteger(gate.firestoreValidAllowCount, 'gate firestoreValidAllowCount', 1);
  assertSafeInteger(gate.storageValidAllowCount, 'gate storageValidAllowCount', 1);
  if (gate.distinctChallengeCount !== 2 ||
      gate.firestoreValidAllowCount !== summary.firestoreValidAllowCount ||
      gate.storageValidAllowCount !== summary.storageValidAllowCount) {
    throw new Error('Ringkasan enforcementGate tidak konsisten dengan summary.');
  }

  if (!/^[a-f0-9]{64}$/.test(report.reportDigest || '')) {
    throw new Error('reportDigest harus SHA-256 hex lowercase.');
  }
  const { reportDigest, ...unsignedReport } = report;
  const expectedDigest = sha256(canonicalJson(unsignedReport));
  const actualBuffer = Buffer.from(reportDigest, 'hex');
  const expectedBuffer = Buffer.from(expectedDigest, 'hex');
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('reportDigest tidak cocok; report mungkin berubah setelah dibuat.');
  }

  return {
    report,
    reportPath,
    generatedAtMs,
    startedAtMs,
    digest: expectedDigest,
  };
};

let smokeValidation = null;
if (mode === 'ENFORCED') {
  smokeValidation = validateSmokeReport(args.get('--smoke-report'));
}

const account = authModule.getGlobalDefaultAccount();
if (!account?.tokens?.refresh_token) {
  throw new Error('Firebase CLI belum login. Jalankan: npx firebase login');
}
authModule.setRefreshToken(account.tokens.refresh_token);
const tokenResult = await authModule.getAccessToken(account.tokens.refresh_token, []);
const accessToken = tokenResult?.access_token;
if (!accessToken) throw new Error('Tidak dapat memperoleh token Firebase CLI.');

const api = async (url, options = {}, allowNotFound = false) => {
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
    if (allowNotFound && response.status === 404) return null;
    const error = new Error(body?.error?.message || `${response.status} ${url}`);
    error.status = response.status;
    throw error;
  }
  return body;
};

const serviceName = serviceId =>
  `projects/${PROJECT_NUMBER}/services/${serviceId}`;
const serviceUrl = serviceId =>
  `https://firebaseappcheck.googleapis.com/v1/${serviceName(serviceId)}`;

const readServiceModes = async () => Promise.all(SERVICES.map(async serviceId => {
  const current = await api(serviceUrl(serviceId), {}, true);
  return {
    serviceId,
    enforcementMode: current?.enforcementMode || 'NOT_CONFIGURED',
  };
}));

const patchServiceMode = (serviceId, enforcementMode) => api(
  `${serviceUrl(serviceId)}?updateMask=enforcementMode`,
  {
    method: 'PATCH',
    body: JSON.stringify({
      name: serviceName(serviceId),
      enforcementMode,
    }),
  }
);

const monitoringFilter = serviceId => [
  'metric.type = "firebaseappcheck.googleapis.com/services/verification_count"',
  'resource.type = "firebaseappcheck.googleapis.com/Service"',
  `resource.labels.service_id = "${serviceId}"`,
  'metric.labels.result = "ALLOW"',
  'metric.labels.security = "VALID"',
  `metric.labels.app_id = "${WEB_APP_ID}"`,
].join(' AND ');

const readValidAllowMetric = async (serviceId, startTime, endTime) => {
  let pageToken = '';
  let pageCount = 0;
  let total = 0n;
  let pointCount = 0;
  let seriesCount = 0;
  do {
    if (++pageCount > 100) throw new Error(`Pagination metric ${serviceId} berlebihan.`);
    const query = new URLSearchParams({
      filter: monitoringFilter(serviceId),
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
      seriesCount += 1;
      for (const point of series.points || []) {
        const rawValue = point?.value?.int64Value;
        if (typeof rawValue !== 'string' || !/^\d+$/.test(rawValue)) {
          throw new Error(`Point metric ${serviceId} memiliki nilai tidak valid.`);
        }
        total += BigInt(rawValue);
        pointCount += 1;
      }
    }
    pageToken = result.nextPageToken || '';
  } while (pageToken);

  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Total metric ${serviceId} melampaui integer aman.`);
  }
  return { serviceId, total: Number(total), pointCount, seriesCount };
};

const reportEvidence = (validation, checkId) =>
  validation.report.checks.find(check => check.id === checkId)?.evidence;

const readLiveFunctionEvidence = async () => {
  const result = await api(
    `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT_ID}/` +
      `locations/${REGION}/functions`
  );
  const functions = result.functions || [];
  const names = functions.map(item => item.name.split('/').pop()).sort();
  if (canonicalJson(names) !== canonicalJson(EXPECTED_FUNCTIONS)) {
    throw new Error('Set Functions live berubah sejak smoke test.');
  }
  for (const deployedFunction of functions) {
    if (deployedFunction.state !== 'ACTIVE' ||
        deployedFunction.buildConfig?.runtime !== 'nodejs22' ||
        deployedFunction.serviceConfig?.serviceAccountEmail !==
          RUNTIME_SERVICE_ACCOUNT) {
      throw new Error('Runtime atau service account Functions live tidak sesuai.');
    }
  }
  const sourceHashes = [...new Set(functions.map(item =>
    item.labels?.['firebase-functions-hash']
  ).filter(Boolean))];
  if (sourceHashes.length !== 1) {
    throw new Error('Source hash Functions live tidak tunggal atau tidak tersedia.');
  }
  return {
    activeCount: functions.length,
    runtime: 'nodejs22',
    sourceFingerprint: smokeFingerprint(sourceHashes[0]),
  };
};

const readLiveRulesEvidence = async () => {
  const releases = await api(
    `https://firebaserules.googleapis.com/v1/projects/${PROJECT_ID}/releases`
  );
  const readOne = async (releaseName, localUrl) => {
    const release = (releases.releases || [])
      .find(item => item.name === releaseName);
    if (!release?.rulesetName) {
      throw new Error(`Rules release live tidak ditemukan: ${releaseName}.`);
    }
    const ruleset = await api(
      `https://firebaserules.googleapis.com/v1/${release.rulesetName}`
    );
    const deployed = ruleset.source?.files?.[0]?.content;
    const local = readFileSync(localUrl, 'utf8');
    if (typeof deployed !== 'string' || deployed !== local) {
      throw new Error(`Rules live tidak cocok dengan source lokal: ${releaseName}.`);
    }
    return {
      rulesetFingerprint: smokeFingerprint(release.rulesetName),
      sourceFingerprint: sha256(deployed).slice(0, 20),
    };
  };
  const [firestore, storage] = await Promise.all([
    readOne(
      `projects/${PROJECT_ID}/releases/cloud.firestore`,
      new URL('../firestore.rules', import.meta.url),
    ),
    readOne(
      `projects/${PROJECT_ID}/releases/firebase.storage/${BUCKET}`,
      new URL('../storage.rules', import.meta.url),
    ),
  ]);
  return { firestore, storage };
};

const readLiveProjectPolicyEvidence = async () => {
  const [policy, configDocument] = await Promise.all([
    api(
      `https://cloudresourcemanager.googleapis.com/v1/projects/` +
        `${PROJECT_ID}:getIamPolicy`,
      {
        method: 'POST',
        body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
      },
    ),
    api(
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
        'databases/(default)/documents/projectConfig/default'
    ),
  ]);
  if (configDocument.fields?.attendanceSecurityVersion?.integerValue !== '2' ||
      configDocument.fields?.geofenceTransitionMode?.booleanValue !== false) {
    throw new Error('Policy absensi v2 live berubah sejak smoke report dibuat.');
  }
  const dataWriteConfigs = (policy.auditConfigs || []).flatMap(item => {
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
    throw new Error('Firestore DATA_WRITE audit live tidak aktif tanpa exemption.');
  }
  return {
    attendanceSecurityVersion: 2,
    transitionMode: false,
    firestoreDataWriteAudit: true,
    auditExemptionCount,
    iamBindingsFingerprint: smokeFingerprint(canonicalJson(
      canonicalIamBindings(policy.bindings)
    )),
  };
};

const validateLiveEnforcementEvidence = async validation => {
  const expectedConfigName =
    `projects/${PROJECT_NUMBER}/apps/${WEB_APP_ID}/recaptchaEnterpriseConfig`;
  const startTime = new Date(validation.startedAtMs).toISOString();
  const endTime = new Date().toISOString();
  const [appConfig, functionEvidence, rulesEvidence, hostingEvidence,
    projectPolicyEvidence, liveMetrics] =
    await Promise.all([
      api(
        `https://firebaseappcheck.googleapis.com/v1/projects/${PROJECT_NUMBER}/apps/` +
          `${encodeURIComponent(WEB_APP_ID)}/recaptchaEnterpriseConfig`
      ),
      readLiveFunctionEvidence(),
      readLiveRulesEvidence(),
      readLiveHostingEvidence({ api, projectId: PROJECT_ID }),
      readLiveProjectPolicyEvidence(),
      Promise.all(SERVICES.map(serviceId =>
        readValidAllowMetric(serviceId, startTime, endTime)
      )),
    ]);
  if (appConfig.name !== expectedConfigName ||
      typeof appConfig.siteKey !== 'string' || !appConfig.siteKey.trim()) {
    throw new Error('Konfigurasi App Check live tidak cocok dengan Web App ID target.');
  }
  const providerConfigFingerprint = smokeFingerprint(canonicalJson({
    name: appConfig.name,
    siteKey: appConfig.siteKey,
    tokenTtl: appConfig.tokenTtl || null,
    minValidScore: appConfig.riskAnalysis?.minValidScore ?? null,
  }));
  const reportedProviderFingerprint = reportEvidence(
    validation,
    'app_check_monitoring_mode',
  )?.providerConfigFingerprint;
  if (providerConfigFingerprint !== reportedProviderFingerprint) {
    throw new Error('Konfigurasi provider App Check berubah sejak smoke report dibuat.');
  }
  if (canonicalJson(functionEvidence) !==
      canonicalJson(reportEvidence(validation, 'functions_deployment'))) {
    throw new Error('Deployment Functions berubah sejak smoke report dibuat.');
  }
  if (canonicalJson(rulesEvidence) !==
      canonicalJson(reportEvidence(validation, 'deployed_security_rules'))) {
    throw new Error('Deployment security rules berubah sejak smoke report dibuat.');
  }
  if (canonicalJson(hostingEvidence) !==
      canonicalJson(reportEvidence(validation, 'hosting_deployment'))) {
    throw new Error('Deployment Hosting berubah sejak smoke report dibuat.');
  }
  if (canonicalJson(projectPolicyEvidence) !==
      canonicalJson(reportEvidence(validation, 'project_policy_v2'))) {
    throw new Error('Policy project atau DATA_WRITE audit berubah sejak smoke report.');
  }
  const reportCounts = new Map([
    ['firestore.googleapis.com', validation.report.summary.firestoreValidAllowCount],
    ['firebasestorage.googleapis.com', validation.report.summary.storageValidAllowCount],
  ]);
  for (const metric of liveMetrics) {
    const reported = reportCounts.get(metric.serviceId);
    if (metric.total <= 0 || metric.total < reported) {
      throw new Error(
        `Metric live VALID/ALLOW ${metric.serviceId} (${metric.total}) ` +
        `tidak mendukung report (${reported}).`
      );
    }
  }
  return {
    startTime,
    endTime,
    providerConfigured: true,
    providerConfigFingerprint,
    functions: functionEvidence,
    rules: rulesEvidence,
    hosting: hostingEvidence,
    projectPolicy: projectPolicyEvidence,
    services: liveMetrics,
  };
};

const before = await readServiceModes();
let liveEvidence = null;
if (smokeValidation) {
  liveEvidence = await validateLiveEnforcementEvidence(smokeValidation);
}

console.log(JSON.stringify({
  operation: apply ? 'apply' : 'dry-run',
  requestedMode: mode,
  services: before,
  smokeReport: smokeValidation ? {
    file: basename(smokeValidation.reportPath),
    digest: smokeValidation.digest,
    generatedAt: smokeValidation.report.generatedAt,
    outcome: smokeValidation.report.outcome,
    readiness: smokeValidation.report.readiness,
  } : null,
  liveValidAllowMetrics: liveEvidence,
}, null, 2));

if (!apply) {
  console.log('Tidak ada perubahan. Tambahkan --apply untuk menjalankan konfigurasi.');
  process.exit(0);
}

const wait = milliseconds => new Promise(resolveWait =>
  setTimeout(resolveWait, milliseconds)
);

const snapshotExpectedMode = snapshotMode =>
  ALLOWED_MODES.has(snapshotMode) ? snapshotMode : 'UNENFORCED';

const modesMatchSnapshot = (actual, snapshot) => snapshot.every(original => {
  const current = actual.find(item => item.serviceId === original.serviceId);
  if (!current) return false;
  if (original.enforcementMode === 'NOT_CONFIGURED') {
    return current.enforcementMode === 'NOT_CONFIGURED' ||
      current.enforcementMode === 'UNENFORCED';
  }
  return current.enforcementMode === original.enforcementMode;
});

const readUntil = async predicate => {
  let current = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    current = await readServiceModes();
    if (predicate(current)) return current;
    if (attempt < 3) await wait(750);
  }
  return current;
};

const rollback = async (snapshot, attemptedServiceIds) => {
  const errors = [];
  for (const serviceId of [...attemptedServiceIds].reverse()) {
    const original = snapshot.find(item => item.serviceId === serviceId);
    const rollbackMode = snapshotExpectedMode(original?.enforcementMode);
    try {
      await patchServiceMode(serviceId, rollbackMode);
    } catch (error) {
      errors.push({ serviceId, error: error.message });
    }
  }
  let current = [];
  try {
    current = await readUntil(state => modesMatchSnapshot(state, snapshot));
  } catch (error) {
    errors.push({ serviceId: 'post-rollback-verification', error: error.message });
  }
  return {
    successful: errors.length === 0 && modesMatchSnapshot(current, snapshot),
    errors,
    services: current,
  };
};

// Live precondition snapshot is intentionally taken immediately before PATCH.
const prePatch = await readServiceModes();
if (prePatch.some(service =>
  !ALLOWED_MODES.has(service.enforcementMode) &&
  service.enforcementMode !== 'NOT_CONFIGURED')) {
  throw new Error('Mode App Check live tidak dikenal; perubahan dibatalkan.');
}

const attemptedServiceIds = [];
try {
  for (const { serviceId, enforcementMode } of prePatch) {
    if (enforcementMode === mode) continue;
    attemptedServiceIds.push(serviceId);
    await patchServiceMode(serviceId, mode);
  }

  const after = await readUntil(state => state.every(service =>
    service.enforcementMode === mode
  ));
  if (after.some(service => service.enforcementMode !== mode)) {
    throw new Error(`Verifikasi gagal: tidak semua service berada pada mode ${mode}.`);
  }

  console.log(JSON.stringify({
    appliedAt: new Date().toISOString(),
    prePatchServices: prePatch,
    verifiedServices: after,
  }, null, 2));
} catch (error) {
  const rollbackResult = await rollback(prePatch, attemptedServiceIds);
  throw new Error(
    `Perubahan App Check gagal: ${error.message}. ` +
    `Rollback ${rollbackResult.successful ? 'berhasil' : 'TIDAK LENGKAP'}: ` +
    JSON.stringify(rollbackResult)
  );
}
