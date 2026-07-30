"use strict";

const crypto = require("node:crypto");
const {HttpsError} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const core = require("./attendance-core");
const gps = require("./gps-integrity");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_RATE_LIMIT_MS = 15 * 1000;
const MAX_DAILY_CHALLENGES = 20;
const SUBMIT_RATE_LIMIT_MS = 2 * 1000;
const MAX_CHALLENGE_SUBMISSIONS = 4;
const MAX_DAILY_SUBMISSIONS = 20;
const PHOTO_URL_TTL_MS = 5 * 60 * 1000;
const MAX_COPRESENCE_UNCERTAINTY_METERS = 100;
const PROJECT_CONFIG_PATH = "projectConfig/default";
const PERCEPTUAL_REPLAY_STATE_COLLECTION =
  "attendancePerceptualReplayStates";
const PERCEPTUAL_AUDIT_SCHEMA_VERSION = 3;
const OPEN_SHIFT_SCHEMA_VERSION = 1;
const MIN_SHIFT_DURATION_MINUTES = 60;
const MAX_SHIFT_DURATION_MINUTES = 24 * 60;
const EARLY_LEAVE_THRESHOLD_HOUR_WIB = 17;
const EARLY_LEAVE_REASON_MIN_LENGTH = 5;
const EARLY_LEAVE_REASON_MAX_LENGTH = 300;
const VERIFICATION_MODE_GEOFENCE_ONSITE = "geofence_onsite";
const VERIFICATION_MODE_LOCATION_PHOTO = "location_photo";
const LOCATION_PHOTO_MODE_POLICY_VERSION = 1;
const MAX_LOCATION_PHOTO_MODE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCATION_PHOTO_PROOF_REASON = "policy_location_photo";
const GPS_TRACE_COLLECTION = "attendanceGpsTraces";
const GPS_TRACE_DIGEST_COLLECTION = "attendanceGpsTraceDigests";
const GPS_TRACE_SCHEMA_VERSION = 1;

function callableError(code, reason, message) {
  return new HttpsError(code, message, {reason});
}

function securityFingerprint(value) {
  if (typeof value !== "string" || !value) return undefined;
  return crypto.createHash("sha256")
      .update("attendance-security-log-v1\u0000")
      .update(value)
      .digest("hex")
      .slice(0, 20);
}

function safeAttendanceAction(value) {
  return value === "checkIn" || value === "checkOut" ? value : undefined;
}

function logSecurityEvent(outcome, context, result, error) {
  const event = {
    schemaVersion: 1,
    event: "attendance_security_event",
    operation: context.operation,
    outcome,
    uidFingerprint: securityFingerprint(context.uid),
    appId: context.appId,
    action: safeAttendanceAction(result?.action || context.action),
    attendanceFingerprint: securityFingerprint(
        result?.attendanceId || context.attendanceId,
    ),
    challengeFingerprint: securityFingerprint(
        result?.challengeId || context.challengeId,
    ),
    geofenceFingerprint: securityFingerprint(
        result?.geofence?.id || context.geofenceId,
    ),
    // Signal quality only. Codes, verdict and score describe how the fix was
    // produced, never where it was produced.
    gpsIntegrityMode: context.gpsIntegrity?.mode,
    gpsIntegrityVerdict: context.gpsIntegrity?.verdict,
    gpsIntegrityScore: context.gpsIntegrity?.score,
    gpsIntegritySignals: context.gpsIntegrity?.signals,
    gpsIntegrityPlatform: context.gpsIntegrity?.platform,
    reason: error?.details?.reason || error?.code,
  };
  Object.keys(event).forEach((key) => {
    if (event[key] == null || event[key] === "") delete event[key];
  });
  if (outcome === "success") {
    logger.info("Attendance security event", event);
  } else {
    logger.warn("Attendance security event", event);
  }
}

function mapCoreError(error) {
  if (!(error instanceof core.AttendanceInputError)) return error;
  const invalidReasons = new Set([
    "INVALID_ACTION",
    "INVALID_CHALLENGE",
    "INVALID_LOCATION",
    "LOCATION_ACCURACY",
    "LOCATION_STALE",
    "INVALID_LOCATION_SOURCE",
    "PHOTO_SIZE",
    "PHOTO_DIMENSIONS",
    "PHOTO_INVALID",
    "PHOTO_LOW_INFORMATION",
    "PHOTO_METADATA",
    "PHOTO_BINDING",
    "PHOTO_STALE",
    "GPS_TRACE_INVALID",
    "GPS_TRACE_SCHEMA",
    "GPS_TRACE_STALE",
    "DEVICE_INTEGRITY_INVALID",
    "DEVICE_INTEGRITY_SCHEMA",
  ]);
  const permissionReasons = new Set([
    "ACCOUNT_INACTIVE",
    "ROLE_NOT_ALLOWED",
    "PASSWORD_CHANGE_REQUIRED",
  ]);
  let code = "failed-precondition";
  if (invalidReasons.has(error.reason)) code = "invalid-argument";
  if (permissionReasons.has(error.reason)) code = "permission-denied";
  return callableError(code, error.reason, error.message);
}

async function safelyRun(operation, context) {
  try {
    const result = await operation();
    logSecurityEvent("success", context, result, null);
    return result;
  } catch (error) {
    const mapped = mapCoreError(error);
    if (mapped instanceof HttpsError) {
      logSecurityEvent("denied", context, null, mapped);
      throw mapped;
    }
    logger.error("Attendance callable failed", {
      operation: context.operation,
      uidFingerprint: securityFingerprint(context.uid),
      errorType: error?.constructor?.name || "UnknownError",
    });
    const internal = callableError(
        "internal",
        "INTERNAL_ERROR",
        "Layanan absensi gagal memproses permintaan.",
    );
    logSecurityEvent("error", context, null, internal);
    throw internal;
  }
}

function assertCallableSecurity(request, consumeToken) {
  if (!request.auth || !request.auth.uid) {
    throw callableError(
        "unauthenticated",
        "AUTH_REQUIRED",
        "Login diperlukan untuk melakukan absensi.",
    );
  }
  if (!request.app) {
    throw callableError(
        "permission-denied",
        "APP_CHECK_REQUIRED",
        "Perangkat tidak dapat diverifikasi oleh App Check.",
    );
  }
  if (consumeToken && request.app.alreadyConsumed === true) {
    throw callableError(
        "unauthenticated",
        "APP_CHECK_REPLAY",
        "Token keamanan sudah pernah digunakan.",
    );
  }
  return request.auth.uid;
}

function assertOnlyKeys(data, keys) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw callableError(
        "invalid-argument",
        "INVALID_REQUEST",
        "Payload permintaan tidak valid.",
    );
  }
  if (Object.keys(data).some((key) => !keys.includes(key))) {
    throw callableError(
        "invalid-argument",
        "UNEXPECTED_FIELD",
        "Payload mengandung field yang tidak diizinkan.",
    );
  }
}

function isEarlyLeaveCheckout(nowMs, targetWorkDate) {
  if (!Number.isFinite(nowMs) || !isValidWorkDate(targetWorkDate)) {
    throw callableError(
        "failed-precondition",
        "EARLY_LEAVE_STATE_INVALID",
        "Waktu evaluasi pulang awal tidak valid.",
    );
  }
  const parts = core.wibParts(new Date(nowMs));
  return parts.date === targetWorkDate &&
    parts.hour < EARLY_LEAVE_THRESHOLD_HOUR_WIB;
}

function normalizeEarlyLeaveReason(value, required) {
  // A challenge created just before 17:00 can be submitted after 17:00.
  // In that case an already-entered reason is intentionally ignored because
  // the transaction's server time is authoritative.
  if (value == null) {
    if (!required) return null;
    throw callableError(
        "invalid-argument",
        "EARLY_LEAVE_REASON_REQUIRED",
        "Alasan pulang awal wajib diisi.",
    );
  }
  if (typeof value !== "string") {
    throw callableError(
        "invalid-argument",
        "EARLY_LEAVE_REASON_INVALID",
        "Alasan pulang awal harus 5-300 karakter.",
    );
  }
  const normalized = value.trim();
  const hasControlCharacters = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127;
  });
  if (normalized.length < EARLY_LEAVE_REASON_MIN_LENGTH ||
      normalized.length > EARLY_LEAVE_REASON_MAX_LENGTH ||
      hasControlCharacters) {
    throw callableError(
        "invalid-argument",
        "EARLY_LEAVE_REASON_INVALID",
        "Alasan pulang awal harus 5-300 karakter.",
    );
  }
  return required ? normalized : null;
}

function timestampMillis(value) {
  return value && typeof value.toMillis === "function" ?
    value.toMillis() : NaN;
}

function attendanceVerificationPolicy(
    config,
    nowMs = Date.now(),
    options = {},
) {
  const mode = config?.attendanceVerificationMode == null ?
    VERIFICATION_MODE_GEOFENCE_ONSITE :
    config.attendanceVerificationMode;
  if (mode === VERIFICATION_MODE_GEOFENCE_ONSITE) {
    return {
      verificationMode: VERIFICATION_MODE_GEOFENCE_ONSITE,
      policySecurityVersion: 2,
      locationPhotoModePolicyVersion: null,
      enabledAtMs: null,
      expiresAtMs: null,
      checkoutGrace: false,
      allowedLocations: null,
      allowedLocationsVersion: null,
      allowedLocationsDigest: null,
    };
  }
  if (mode !== VERIFICATION_MODE_LOCATION_PHOTO) {
    throw callableError(
        "failed-precondition",
        "ATTENDANCE_VERIFICATION_POLICY_INVALID",
        "Mode verifikasi absensi tidak valid.",
    );
  }
  const enabledAtMs = timestampMillis(config.locationPhotoModeEnabledAt);
  const expiresAtMs = timestampMillis(config.locationPhotoModeExpiresAt);
  const maximumShiftDurationMs = options.maximumShiftDurationMs;
  const allowCheckoutGrace = options.allowCheckoutGrace === true &&
    Number.isFinite(maximumShiftDurationMs) &&
    maximumShiftDurationMs > 0;
  if (config.locationPhotoModePolicyVersion !==
        LOCATION_PHOTO_MODE_POLICY_VERSION ||
      !Number.isFinite(nowMs) ||
      !Number.isFinite(enabledAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      enabledAtMs <= 0 ||
      enabledAtMs > nowMs ||
      expiresAtMs <= enabledAtMs ||
      expiresAtMs - enabledAtMs > MAX_LOCATION_PHOTO_MODE_DURATION_MS) {
    throw callableError(
        "failed-precondition",
        "ATTENDANCE_VERIFICATION_POLICY_INVALID",
        "Kebijakan mode lokasi dan foto tidak valid.",
    );
  }
  let allowedLocations;
  let allowedLocationsDigest;
  try {
    const normalized = core.normalizeAllowedLocations(
        config.locationPhotoAllowedLocations == null ?
          [] : config.locationPhotoAllowedLocations,
        nowMs,
    );
    allowedLocations = normalized.locations;
    allowedLocationsDigest = normalized.digest;
  } catch (error) {
    if (error instanceof core.AttendanceInputError) {
      throw callableError(
          "failed-precondition",
          "ATTENDANCE_VERIFICATION_POLICY_INVALID",
          error.message,
      );
    }
    throw error;
  }
  const rawVersion = config.locationPhotoAllowedLocationsVersion;
  const allowedLocationsVersion = rawVersion == null ? 0 : rawVersion;
  if (!Number.isInteger(allowedLocationsVersion) ||
      allowedLocationsVersion < 0 ||
      (config.locationPhotoAllowedLocationsDigest != null &&
        config.locationPhotoAllowedLocationsDigest !==
          allowedLocationsDigest)) {
    throw callableError(
        "failed-precondition",
        "ATTENDANCE_VERIFICATION_POLICY_INVALID",
        "Daftar lokasi operasional sementara tidak valid.",
    );
  }
  const checkoutGrace = expiresAtMs <= nowMs &&
    allowCheckoutGrace &&
    nowMs <= expiresAtMs + maximumShiftDurationMs;
  if (expiresAtMs <= nowMs && !checkoutGrace) {
    throw callableError(
        "failed-precondition",
        "LOCATION_PHOTO_MODE_EXPIRED",
        "Masa berlaku mode lokasi dan foto telah berakhir.",
    );
  }
  return {
    verificationMode: VERIFICATION_MODE_LOCATION_PHOTO,
    policySecurityVersion: 2,
    locationPhotoModePolicyVersion: LOCATION_PHOTO_MODE_POLICY_VERSION,
    enabledAtMs,
    expiresAtMs,
    checkoutGrace,
    allowedLocations,
    allowedLocationsVersion,
    allowedLocationsDigest,
  };
}

function isValidWorkDate(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function maxShiftDurationMs(config, nowMs = Date.now()) {
  const cutoverMs = timestampMillis(
      config && config.attendanceSecurityCutoverAt,
  );
  if (!Number.isFinite(nowMs) ||
      config?.attendanceSecurityVersion !== 2 ||
      config?.geofenceTransitionMode !== false ||
      !Number.isFinite(cutoverMs) ||
      cutoverMs > nowMs) {
    throw callableError(
        "failed-precondition",
        "ATTENDANCE_SECURITY_POLICY_INACTIVE",
        "Kebijakan keamanan absensi v2 belum aktif secara canonical.",
    );
  }
  const minutes = config && config.maxAttendanceShiftDurationMinutes;
  if (!Number.isInteger(minutes) ||
      minutes < MIN_SHIFT_DURATION_MINUTES ||
      minutes > MAX_SHIFT_DURATION_MINUTES) {
    throw callableError(
        "failed-precondition",
        "SHIFT_POLICY_INVALID",
        "Batas durasi shift belum dikonfigurasi dengan aman.",
    );
  }
  return minutes * 60 * 1000;
}

function assertOpenShiftState(openShift, uid) {
  const checkInMs = timestampMillis(openShift && openShift.checkInAt);
  const closedAtMs = timestampMillis(openShift && openShift.closedAt);
  const workDate = openShift && openShift.workDate;
  const expectedAttendanceId = isValidWorkDate(workDate) ?
    `${uid}_${workDate}` : null;
  const statusValid = openShift &&
    (openShift.status === "open" || openShift.status === "closed");
  const closureValid = openShift?.status === "open" ?
    openShift.closedAt == null :
    Number.isFinite(closedAtMs) && closedAtMs >= checkInMs;
  if (!openShift ||
      openShift.schemaVersion !== OPEN_SHIFT_SCHEMA_VERSION ||
      openShift.uid !== uid ||
      !Number.isInteger(openShift.revision) ||
      openShift.revision < 1 ||
      !statusValid ||
      !expectedAttendanceId ||
      openShift.attendanceId !== expectedAttendanceId ||
      !Number.isFinite(checkInMs) ||
      !closureValid) {
    throw callableError(
        "failed-precondition",
        "OPEN_SHIFT_STATE_INVALID",
        "Status shift aktif tidak konsisten; hubungi operator.",
    );
  }
  return {
    attendanceId: openShift.attendanceId,
    checkInMs,
    revision: openShift.revision,
    status: openShift.status,
    workDate,
  };
}

function assertShiftCheckoutWindow(checkInMs, nowMs, durationMs) {
  if (!Number.isFinite(checkInMs) ||
      !Number.isFinite(nowMs) ||
      !Number.isFinite(durationMs) ||
      checkInMs > nowMs) {
    throw callableError(
        "failed-precondition",
        "OPEN_SHIFT_STATE_INVALID",
        "Waktu shift aktif tidak konsisten; hubungi operator.",
    );
  }
  if (nowMs - checkInMs > durationMs) {
    throw callableError(
        "failed-precondition",
        "OPEN_SHIFT_EXPIRED",
        "Shift melewati batas durasi dan memerlukan koreksi administratif.",
    );
  }
}

function assertChallengeTarget(challenge, uid, action) {
  const targetWorkDate = challenge && challenge.targetWorkDate;
  const expectedAttendanceId = isValidWorkDate(targetWorkDate) ?
    `${uid}_${targetWorkDate}` : null;
  if (!challenge ||
      !isValidWorkDate(challenge.requestDate) ||
      !expectedAttendanceId ||
      challenge.targetAttendanceId !== expectedAttendanceId ||
      !Number.isInteger(challenge.targetShiftRevision) ||
      challenge.targetShiftRevision < 1 ||
      (action === "checkIn" &&
        challenge.requestDate !== targetWorkDate)) {
    throw callableError(
        "failed-precondition",
        "CHALLENGE_TARGET_INVALID",
        "Target shift pada challenge tidak valid.",
    );
  }
  return {
    attendanceId: challenge.targetAttendanceId,
    revision: challenge.targetShiftRevision,
    requestDate: challenge.requestDate,
    workDate: targetWorkDate,
  };
}

async function verifiedGeofence(transaction, db, snapshot, collection) {
  if (!snapshot.exists) {
    throw callableError(
        "failed-precondition",
        "GEOFENCE_MISSING",
        "Geofence penugasan tidak ditemukan.",
    );
  }
  const data = snapshot.data();
  const geofence = core.normalizeGeofence(
      data,
      snapshot.id,
      timestampMillis(data.verifiedAt),
      timestampMillis(data.verificationReviewedAt),
  );
  const auditSnapshot = await transaction.get(
      db.collection("geofenceVerificationAuditLogs")
          .doc(geofence.verificationAuditId),
  );
  if (!auditSnapshot.exists) {
    throw callableError(
        "failed-precondition",
        "GEOFENCE_AUDIT_INVALID",
        "Dokumen audit verifikasi geofence tidak ditemukan.",
    );
  }
  core.assertGeofenceAudit(
      auditSnapshot.data(),
      {collection, ...geofence},
      timestampMillis(auditSnapshot.data().createdAt),
      timestampMillis(auditSnapshot.data().proposedAt),
  );
  return geofence;
}

function normalizedAssignmentSnapshot(snapshot, assignment) {
  if (!snapshot.exists) {
    throw callableError(
        "failed-precondition",
        "ASSIGNMENT_LOCATION_MISSING",
        "Lokasi penugasan tidak ditemukan.",
    );
  }
  const name = snapshot.data()?.nama;
  if (typeof name !== "string" ||
      name.trim().length < 1 ||
      name.trim().length > 200) {
    throw callableError(
        "failed-precondition",
        "ASSIGNMENT_LOCATION_INVALID",
        "Nama lokasi penugasan tidak valid.",
    );
  }
  return {
    collection: assignment.collection,
    id: assignment.id,
    name: name.trim(),
  };
}

/**
 * Build an operational candidate from the user's assignment document.
 * location_photo may use provisional coordinates; dual-control is not required.
 */
function assignmentOperationalCandidate(snapshot, assignment) {
  const assignmentSnapshot = normalizedAssignmentSnapshot(
      snapshot,
      assignment,
  );
  const data = snapshot.data() || {};
  const lat = Number(data.lat);
  const lng = Number(data.lng);
  const radius = Number(data.radius);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lng) || lng < -180 || lng > 180 ||
      (lat === 0 && lng === 0) ||
      !Number.isFinite(radius) || radius <= 0 ||
      radius > core.MAX_GEOFENCE_RADIUS_METERS) {
    throw callableError(
        "failed-precondition",
        "ASSIGNMENT_LOCATION_INVALID",
        "Koordinat lokasi penugasan tidak valid untuk mode operasional.",
    );
  }
  return {
    assignmentSnapshot,
    candidate: {
      id: `${assignment.collection}:${assignment.id}`,
      nama: assignmentSnapshot.name,
      lat,
      lng,
      radius,
      source: "assignment",
      collection: assignment.collection,
      assignmentId: assignment.id,
    },
  };
}

function buildOperationalCandidates(
    assignmentSnapshot,
    assignmentCandidate,
    temporaryLocations,
) {
  const candidates = [assignmentCandidate];
  const seen = new Set([assignmentCandidate.id]);
  for (const temporary of temporaryLocations || []) {
    if (seen.has(temporary.id)) continue;
    seen.add(temporary.id);
    candidates.push({
      id: temporary.id,
      nama: temporary.nama,
      lat: temporary.lat,
      lng: temporary.lng,
      radius: temporary.radius,
      source: "temporary",
    });
  }
  return {
    assignmentSnapshot,
    candidates,
    publicLocations: candidates.map((candidate) =>
      core.publicOperationalLocation(candidate),
    ),
  };
}

function operationalLocationSnapshotData(match) {
  if (!match || !match.location) return null;
  const location = match.location;
  return {
    id: location.id,
    name: location.nama || location.name,
    lat: location.lat,
    lng: location.lng,
    radius: location.radius,
    source: location.source || "temporary",
    collection: location.collection || null,
    assignmentId: location.assignmentId || null,
    distanceMeters: Math.round(match.distanceMeters),
    uncertaintyAdjustedDistanceMeters:
      Math.round(match.uncertaintyAdjustedDistanceMeters),
  };
}

function normalizedChallengePolicy(challenge) {
  const rawMode = challenge?.verificationMode;
  if (rawMode == null) {
    // A challenge issued before this field existed could only have used the
    // stronger geofence + onsite flow.
    if (challenge?.policySecurityVersion != null ||
        challenge?.locationPhotoModePolicyVersion != null ||
        challenge?.locationPhotoModeEnabledAt != null ||
        challenge?.locationPhotoModeExpiresAt != null ||
        challenge?.locationPhotoAllowedLocationsVersion != null ||
        challenge?.locationPhotoAllowedLocationsDigest != null) {
      throw callableError(
          "failed-precondition",
          "CHALLENGE_POLICY_INVALID",
          "Snapshot kebijakan challenge tidak valid.",
      );
    }
    return {
      verificationMode: VERIFICATION_MODE_GEOFENCE_ONSITE,
      policySecurityVersion: 2,
      locationPhotoModePolicyVersion: null,
      enabledAtMs: null,
      expiresAtMs: null,
      allowedLocationsVersion: null,
      allowedLocationsDigest: null,
    };
  }
  if (rawMode === VERIFICATION_MODE_GEOFENCE_ONSITE &&
      challenge.policySecurityVersion === 2 &&
      challenge.locationPhotoModePolicyVersion == null &&
      challenge.locationPhotoModeEnabledAt == null &&
      challenge.locationPhotoModeExpiresAt == null &&
      challenge.locationPhotoAllowedLocationsVersion == null &&
      challenge.locationPhotoAllowedLocationsDigest == null) {
    return {
      verificationMode: VERIFICATION_MODE_GEOFENCE_ONSITE,
      policySecurityVersion: 2,
      locationPhotoModePolicyVersion: null,
      enabledAtMs: null,
      expiresAtMs: null,
      allowedLocationsVersion: null,
      allowedLocationsDigest: null,
    };
  }
  const enabledAtMs = timestampMillis(challenge?.locationPhotoModeEnabledAt);
  const expiresAtMs = timestampMillis(challenge?.locationPhotoModeExpiresAt);
  const allowedLocationsVersion =
    challenge?.locationPhotoAllowedLocationsVersion;
  const allowedLocationsDigest =
    challenge?.locationPhotoAllowedLocationsDigest;
  if (rawMode !== VERIFICATION_MODE_LOCATION_PHOTO ||
      challenge.policySecurityVersion !== 2 ||
      challenge.locationPhotoModePolicyVersion !==
        LOCATION_PHOTO_MODE_POLICY_VERSION ||
      !Number.isFinite(enabledAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      enabledAtMs <= 0 ||
      expiresAtMs <= enabledAtMs ||
      expiresAtMs - enabledAtMs > MAX_LOCATION_PHOTO_MODE_DURATION_MS ||
      !Number.isInteger(allowedLocationsVersion) ||
      allowedLocationsVersion < 0 ||
      typeof allowedLocationsDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(allowedLocationsDigest)) {
    throw callableError(
        "failed-precondition",
        "CHALLENGE_POLICY_INVALID",
        "Snapshot kebijakan challenge tidak valid.",
    );
  }
  return {
    verificationMode: VERIFICATION_MODE_LOCATION_PHOTO,
    policySecurityVersion: 2,
    locationPhotoModePolicyVersion: LOCATION_PHOTO_MODE_POLICY_VERSION,
    enabledAtMs,
    expiresAtMs,
    allowedLocationsVersion,
    allowedLocationsDigest,
  };
}

function normalizedChallengeAssignment(challenge) {
  const collection = challenge?.assignmentCollection ??
    challenge?.geofenceCollection;
  const id = challenge?.assignmentId ?? challenge?.geofenceId;
  if ((collection !== "kelurahan" && collection !== "kantor") ||
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 180 ||
      (challenge?.assignmentCollection != null &&
        challenge.assignmentCollection !== challenge.geofenceCollection) ||
      (challenge?.assignmentId != null &&
        challenge.assignmentId !== challenge.geofenceId)) {
    throw callableError(
        "failed-precondition",
        "CHALLENGE_ASSIGNMENT_INVALID",
        "Snapshot penugasan challenge tidak valid.",
    );
  }
  return {collection, id};
}

function assertCurrentChallengePolicy(challenge, policy) {
  const snapshot = normalizedChallengePolicy(challenge);
  if (snapshot.verificationMode !== policy.verificationMode ||
      snapshot.policySecurityVersion !== policy.policySecurityVersion ||
      snapshot.locationPhotoModePolicyVersion !==
        policy.locationPhotoModePolicyVersion ||
      snapshot.enabledAtMs !== policy.enabledAtMs ||
      snapshot.expiresAtMs !== policy.expiresAtMs ||
      snapshot.allowedLocationsVersion !==
        policy.allowedLocationsVersion ||
      snapshot.allowedLocationsDigest !==
        policy.allowedLocationsDigest) {
    throw callableError(
        "failed-precondition",
        "ATTENDANCE_POLICY_CHANGED",
        "Kebijakan absensi berubah; minta challenge baru.",
    );
  }
  return snapshot;
}

function challengeUploadPath(uid, challengeId) {
  return `attendanceProofs/${uid}/${challengeId}`;
}

function replayStateError(reason = "PHOTO_REPLAY_STATE_INVALID") {
  const message = reason === "PHOTO_REPLAY_STATE_OVERFLOW" ?
    "Riwayat replay foto melebihi batas aman dan perlu diperiksa operator." :
    "Riwayat replay foto tidak valid dan perlu diperiksa operator.";
  return callableError(
      "failed-precondition",
      reason,
      message,
  );
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index]);
}

function validPerceptualHashes(hashes) {
  try {
    core.minimumPerceptualHashDistance(hashes, hashes);
    return true;
  } catch (_) {
    return false;
  }
}

function replayEntryOrder(left, right) {
  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs - right.createdAtMs;
  }
  if (left.proofId < right.proofId) return -1;
  if (left.proofId > right.proofId) return 1;
  return 0;
}

function activePerceptualReplayEntries(state, expectedUid, nowMs) {
  if (state == null) return [];
  const stateFields = [
    "schemaVersion",
    "hashVersion",
    "uid",
    "windowMs",
    "maxEntries",
    "entries",
    "updatedAtMs",
  ];
  if (!hasExactKeys(state, stateFields) ||
      state.schemaVersion !==
        core.PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION ||
      state.hashVersion !== core.PERCEPTUAL_HASH_VERSION ||
      state.uid !== expectedUid ||
      state.windowMs !== core.PERCEPTUAL_REPLAY_WINDOW_MS ||
      state.maxEntries !== core.PERCEPTUAL_REPLAY_MAX_ENTRIES ||
      !Array.isArray(state.entries) ||
      !Number.isSafeInteger(state.updatedAtMs) ||
      state.updatedAtMs <= 0 || state.updatedAtMs > nowMs) {
    throw replayStateError();
  }
  if (state.entries.length > core.PERCEPTUAL_REPLAY_MAX_ENTRIES) {
    throw replayStateError("PHOTO_REPLAY_STATE_OVERFLOW");
  }
  if (state.entries.length === 0) {
    throw replayStateError();
  }

  const entryFields = ["proofId", "perceptualHashes", "createdAtMs"];
  const proofIds = new Set();
  let previousEntry = null;
  for (const entry of state.entries) {
    if (!hasExactKeys(entry, entryFields) ||
        typeof entry.proofId !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.proofId) ||
        proofIds.has(entry.proofId) ||
        !validPerceptualHashes(entry.perceptualHashes) ||
        !Number.isSafeInteger(entry.createdAtMs) ||
        entry.createdAtMs <= 0 || entry.createdAtMs > nowMs ||
        (previousEntry && replayEntryOrder(previousEntry, entry) >= 0)) {
      throw replayStateError();
    }
    proofIds.add(entry.proofId);
    previousEntry = entry;
  }
  if (state.updatedAtMs !== previousEntry.createdAtMs) {
    throw replayStateError();
  }

  const cutoffMs = nowMs - core.PERCEPTUAL_REPLAY_WINDOW_MS;
  return state.entries.filter((entry) => entry.createdAtMs > cutoffMs);
}

function reservePerceptualReplayState(state, expected, nowMs) {
  if (!expected || typeof expected.uid !== "string" ||
      expected.uid.length < 1 || expected.uid.length > 128 ||
      typeof expected.proofId !== "string" ||
      !/^[0-9a-f]{64}$/.test(expected.proofId) ||
      !validPerceptualHashes(expected.perceptualHashes) ||
      !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw replayStateError();
  }
  const activeEntries = activePerceptualReplayEntries(
      state,
      expected.uid,
      nowMs,
  );
  const nearReplay = activeEntries.some((entry) =>
    core.minimumPerceptualHashDistance(
        expected.perceptualHashes,
        entry.perceptualHashes,
    ) <= core.PERCEPTUAL_REPLAY_MAX_DISTANCE,
  );
  if (nearReplay) {
    return {
      nearReplay: true,
      activeEntryCount: activeEntries.length,
      nextState: null,
    };
  }
  if (activeEntries.length >= core.PERCEPTUAL_REPLAY_MAX_ENTRIES) {
    throw replayStateError("PHOTO_REPLAY_STATE_OVERFLOW");
  }

  const nextEntries = [
    ...activeEntries,
    {
      proofId: expected.proofId,
      perceptualHashes: [...expected.perceptualHashes],
      createdAtMs: nowMs,
    },
  ].sort(replayEntryOrder);
  return {
    nearReplay: false,
    activeEntryCount: nextEntries.length,
    nextState: {
      schemaVersion: core.PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION,
      hashVersion: core.PERCEPTUAL_HASH_VERSION,
      uid: expected.uid,
      windowMs: core.PERCEPTUAL_REPLAY_WINDOW_MS,
      maxEntries: core.PERCEPTUAL_REPLAY_MAX_ENTRIES,
      entries: nextEntries,
      updatedAtMs: nowMs,
    },
  };
}

function assertPhotoNotReplayed(exactDigestExists, nearPerceptualReplay) {
  if (exactDigestExists || nearPerceptualReplay) {
    throw callableError(
        "already-exists",
        "PHOTO_REPLAY",
        "Foto ini sudah pernah digunakan untuk absensi.",
    );
  }
}

function assertCoPresence(employeeLocation, verifierLocation, geofence) {
  const verifierDistance = core.calculateDistanceMeters(
      verifierLocation.lat,
      verifierLocation.lng,
      geofence.lat,
      geofence.lng,
  );
  const verifierUncertaintyAdjustedDistance = verifierDistance +
    verifierLocation.accuracy;
  if (!Number.isFinite(verifierDistance) ||
      !Number.isFinite(verifierUncertaintyAdjustedDistance) ||
      verifierUncertaintyAdjustedDistance > geofence.radius) {
    throw callableError(
        "failed-precondition",
        "VERIFIER_OUTSIDE_GEOFENCE",
        "Perangkat penerbit kode tidak lagi dapat diverifikasi di " +
          "dalam geofence.",
    );
  }
  const distance = core.calculateDistanceMeters(
      employeeLocation.lat,
      employeeLocation.lng,
      verifierLocation.lat,
      verifierLocation.lng,
  );
  const uncertaintyAdjustedDistance = distance +
    employeeLocation.accuracy + verifierLocation.accuracy;
  if (!Number.isFinite(distance) ||
      !Number.isFinite(uncertaintyAdjustedDistance) ||
      uncertaintyAdjustedDistance > MAX_COPRESENCE_UNCERTAINTY_METERS) {
    throw callableError(
        "failed-precondition",
        "COPRESENCE_UNCERTAIN",
        "Perangkat karyawan dan admin belum terverifikasi berada " +
          "berdekatan. Ambil ulang GPS di area terbuka.",
    );
  }
  return {
    distanceMeters: Math.round(distance),
    uncertaintyAdjustedDistanceMeters:
      Math.round(uncertaintyAdjustedDistance),
    maximumMeters: MAX_COPRESENCE_UNCERTAINTY_METERS,
    verifierAccuracyMeters: verifierLocation.accuracy,
  };
}

function assertChallengeState(challenge, expected, nowMs) {
  const challengePolicy = normalizedChallengePolicy(challenge);
  const challengeAssignment = normalizedChallengeAssignment(challenge);
  if (!challenge || challenge.uid !== expected.uid ||
      challenge.action !== expected.action ||
      challenge.photoPath !== expected.photoPath ||
      (expected.targetAttendanceId != null &&
        challenge.targetAttendanceId !== expected.targetAttendanceId) ||
      (expected.targetWorkDate != null &&
        challenge.targetWorkDate !== expected.targetWorkDate) ||
      (expected.targetShiftRevision != null &&
        challenge.targetShiftRevision !== expected.targetShiftRevision) ||
      (expected.requestDate != null &&
        challenge.requestDate !== expected.requestDate) ||
      (expected.verificationMode != null &&
        challengePolicy.verificationMode !== expected.verificationMode) ||
      (expected.policySecurityVersion != null &&
        challengePolicy.policySecurityVersion !==
          expected.policySecurityVersion) ||
      (expected.locationPhotoModePolicyVersion !== undefined &&
        challengePolicy.locationPhotoModePolicyVersion !==
          expected.locationPhotoModePolicyVersion) ||
      (expected.locationPhotoModeEnabledAtMs !== undefined &&
        challengePolicy.enabledAtMs !==
          expected.locationPhotoModeEnabledAtMs) ||
      (expected.locationPhotoModeExpiresAtMs !== undefined &&
        challengePolicy.expiresAtMs !==
          expected.locationPhotoModeExpiresAtMs) ||
      (expected.assignmentCollection != null &&
        challengeAssignment.collection !== expected.assignmentCollection) ||
      (expected.assignmentId != null &&
        challengeAssignment.id !== expected.assignmentId)) {
    throw callableError(
        "permission-denied",
        "CHALLENGE_MISMATCH",
        "Challenge tidak dimiliki pengguna ini.",
    );
  }
  if (challenge.status !== "pending" || challenge.consumedAt != null) {
    throw callableError(
        "failed-precondition",
        "CHALLENGE_CONSUMED",
        "Challenge sudah digunakan atau dibatalkan.",
    );
  }
  const createdAtMs = timestampMillis(challenge.createdAt);
  const expiresAtMs = timestampMillis(challenge.expiresAt);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) ||
      createdAtMs > nowMs || expiresAtMs <= nowMs) {
    throw callableError(
        "deadline-exceeded",
        "CHALLENGE_EXPIRED",
        "Challenge absensi sudah kedaluwarsa.",
    );
  }
  if (challenge.appId !== expected.appId) {
    throw callableError(
        "permission-denied",
        "APP_INSTANCE_MISMATCH",
        "Challenge berasal dari aplikasi Firebase yang berbeda.",
    );
  }
  return {createdAtMs, expiresAtMs};
}

function attendanceVerificationModeForAction(attendance, action) {
  const rawMode = action === "checkIn" ?
    attendance?.verificationMode :
    attendance?.checkOutVerificationMode;
  if (rawMode == null) {
    // All records written before verificationMode existed used the strong
    // geofence + onsite evidence contract.
    return VERIFICATION_MODE_GEOFENCE_ONSITE;
  }
  if (rawMode !== VERIFICATION_MODE_GEOFENCE_ONSITE &&
      rawMode !== VERIFICATION_MODE_LOCATION_PHOTO) {
    throw callableError(
        "failed-precondition",
        "ATTENDANCE_MODE_INVALID",
        "Mode bukti absensi tidak valid.",
    );
  }
  return rawMode;
}

function validStoredAssignmentSnapshot(value) {
  return hasExactKeys(value, ["collection", "id", "name"]) &&
    (value.collection === "kelurahan" || value.collection === "kantor") &&
    typeof value.id === "string" &&
    value.id.length >= 1 &&
    value.id.length <= 180 &&
    typeof value.name === "string" &&
    value.name.trim() === value.name &&
    value.name.length >= 1 &&
    value.name.length <= 200;
}

function validStoredLocation(value, serverReceivedAtMs) {
  const receivedAtMs = timestampMillis(value?.serverReceivedAt);
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isFinite(value.lat) &&
    value.lat >= -90 &&
    value.lat <= 90 &&
    Number.isFinite(value.lng) &&
    value.lng >= -180 &&
    value.lng <= 180 &&
    !(value.lat === 0 && value.lng === 0) &&
    Number.isFinite(value.accuracy) &&
    value.accuracy > 0 &&
    value.accuracy <= core.MAX_LOCATION_ACCURACY_METERS &&
    Number.isInteger(value.capturedAt) &&
    (value.source === "gps-high" || value.source === "gps-low") &&
    Number.isFinite(receivedAtMs) &&
    receivedAtMs === serverReceivedAtMs &&
    value.capturedAt >= receivedAtMs - 2 * 60 * 1000 &&
    value.capturedAt <= receivedAtMs + 10 * 1000;
}

function isLocationPhotoProof(proof) {
  return hasExactKeys(proof, ["required", "verified", "reason"]) &&
    proof.required === false &&
    proof.verified === false &&
    proof.reason === LOCATION_PHOTO_PROOF_REASON;
}

function assertVerifiedCheckIn(attendance, uid, date, nowMs) {
  const checkInMs = timestampMillis(attendance && attendance.checkIn);
  let challengeIdValid = false;
  try {
    core.assertChallengeId(attendance && attendance.challengeIds &&
      attendance.challengeIds.checkIn);
    challengeIdValid = true;
  } catch (_) {
    challengeIdValid = false;
  }
  const expectedPhotoPrefix = `attendanceProofs/${uid}/`;
  const mode = attendanceVerificationModeForAction(attendance, "checkIn");
  if (!attendance || attendance.userId !== uid || attendance.date !== date ||
      attendance.integrityVersion !== 2 ||
      attendance.proofVersion !== 2 ||
      !challengeIdValid ||
      !Number.isFinite(checkInMs) || checkInMs > nowMs ||
      typeof attendance.checkInPhotoPath !== "string" ||
      !attendance.checkInPhotoPath.startsWith(expectedPhotoPrefix) ||
      !attendance.checkInPhotoGeneration ||
      typeof attendance.checkInPhotoHash !== "string" ||
      typeof attendance.checkInPhotoPerceptualHash !== "string" ||
      !Array.isArray(attendance.checkInPhotoPerceptualHashes) ||
      attendance.checkInPhotoPerceptualHashes.length !==
        core.PERCEPTUAL_HASH_VIEW_COUNT) {
    throw callableError(
        "failed-precondition",
        "UNVERIFIED_CHECK_IN",
        "Check-in lama atau belum terverifikasi tidak dapat di-check-out.",
    );
  }
  const strongEvidenceValid =
    attendance.verificationStatus === "verified" &&
    attendance.transitionMode === false &&
    attendance.isWithinRadius === true &&
    attendance.presenceProof?.required === true &&
    attendance.presenceProof?.verified === true &&
    attendance.presenceProof?.coPresence?.verified === true &&
    typeof attendance.presenceProof?.grantId === "string" &&
    typeof attendance.geofenceSnapshot?.verificationAuditId === "string" &&
    typeof attendance.geofenceSnapshot?.verificationOperator === "string" &&
    typeof attendance.geofenceSnapshot?.verificationReviewOperator ===
      "string" &&
    attendance.geofenceSnapshot.verificationOperator !==
      attendance.geofenceSnapshot.verificationReviewOperator;
  const locationPhotoEvidenceValid =
    attendance.verificationMode === VERIFICATION_MODE_LOCATION_PHOTO &&
    attendance.verificationStatus === "location_photo_only" &&
    attendance.transitionMode === true &&
    attendance.isWithinRadius === null &&
    attendance.deviceVerified === false &&
    attendance.distanceFromGeofence === null &&
    attendance.geofenceSnapshot === null &&
    isLocationPhotoProof(attendance.presenceProof) &&
    validStoredAssignmentSnapshot(attendance.assignmentSnapshot) &&
    validStoredLocation(attendance.checkInLocation, checkInMs);
  if ((mode === VERIFICATION_MODE_GEOFENCE_ONSITE &&
        !strongEvidenceValid) ||
      (mode === VERIFICATION_MODE_LOCATION_PHOTO &&
        !locationPhotoEvidenceValid)) {
    throw callableError(
        "failed-precondition",
        "UNVERIFIED_CHECK_IN",
        "Check-in lama atau belum terverifikasi tidak dapat di-check-out.",
    );
  }
  return checkInMs;
}

async function verifyPhoto(bucket, challenge, expected, nowMs) {
  const file = bucket.file(expected.photoPath);
  let metadata;
  try {
    [metadata] = await file.getMetadata();
  } catch (error) {
    if (error && Number(error.code) === 404) {
      throw callableError(
          "failed-precondition",
          "PHOTO_MISSING",
          "Foto bukti belum diunggah.",
      );
    }
    throw error;
  }

  const challengeTimes = assertChallengeState(challenge, expected, nowMs);
  core.validatePhotoMetadata(metadata, {
    ...expected,
    challengeCreatedAtMs: challengeTimes.createdAtMs,
    challengeExpiresAtMs: challengeTimes.expiresAtMs,
  }, nowMs);

  const versionedFile = bucket.file(expected.photoPath, {
    generation: metadata.generation,
  });
  const [buffer] = await versionedFile.download({validation: "crc32c"});
  const photo = await core.validatePhotoBytes(buffer);
  if (Number(metadata.size) !== photo.size) {
    throw callableError(
        "failed-precondition",
        "PHOTO_CHANGED",
        "Ukuran foto berubah saat diverifikasi.",
    );
  }

  const [confirmed] = await versionedFile.getMetadata();
  if (String(confirmed.generation) !== String(metadata.generation) ||
      !confirmed.md5Hash || !confirmed.crc32c ||
      confirmed.md5Hash !== metadata.md5Hash ||
      confirmed.crc32c !== metadata.crc32c) {
    throw callableError(
        "failed-precondition",
        "PHOTO_CHANGED",
        "Foto berubah saat diverifikasi.",
    );
  }
  core.validatePhotoMetadata(confirmed, {
    ...expected,
    challengeCreatedAtMs: challengeTimes.createdAtMs,
    challengeExpiresAtMs: challengeTimes.expiresAtMs,
  }, nowMs);

  return {
    ...photo,
    path: expected.photoPath,
    generation: String(confirmed.generation),
    metageneration: String(confirmed.metageneration),
    md5Hash: confirmed.md5Hash,
    crc32c: confirmed.crc32c,
  };
}

function assignmentAndRef(db, user) {
  const assignment = core.resolveAssignment(user);
  return {
    assignment,
    ref: db.collection(assignment.collection).doc(assignment.id),
  };
}

function publicGeofence(geofence) {
  return {
    id: geofence.id,
    name: geofence.name,
    lat: geofence.lat,
    lng: geofence.lng,
    radius: geofence.radius,
    presenceProofRequired: geofence.presenceProofRequired,
  };
}

function presenceSecretRef(db, assignment) {
  return db.collection("geofencePresenceSecrets")
      .doc(`${assignment.collection}_${assignment.id}`);
}

function presenceGrantRef(db, challengeId) {
  return db.collection("attendancePresenceGrants").doc(challengeId);
}

function presenceCodeContext(assignment, uid, challengeId) {
  return [assignment.collection, assignment.id, uid, challengeId].join(":");
}

async function verifyPresenceProof(
    transaction,
    db,
    assignment,
    geofence,
    presenceCode,
    expected,
    nowMs,
) {
  if (typeof presenceCode !== "string" || !/^\d{6}$/.test(presenceCode)) {
    throw callableError(
        "invalid-argument",
        "PRESENCE_CODE_REQUIRED",
        "Kode kehadiran onsite 6 digit wajib diisi.",
    );
  }
  const grantRef = presenceGrantRef(db, expected.challengeId);
  const [secretSnapshot, grantSnapshot] = await Promise.all([
    transaction.get(presenceSecretRef(db, assignment)),
    transaction.get(grantRef),
  ]);
  const secret = secretSnapshot.exists ? secretSnapshot.data() : null;
  if (!secret || secret.enabled !== true ||
      secret.geofenceType !== assignment.collection ||
      secret.geofenceId !== assignment.id) {
    throw callableError(
        "failed-precondition",
        "PRESENCE_CODE_UNAVAILABLE",
        "Kode kehadiran onsite belum dikonfigurasi admin.",
    );
  }
  const counter = core.verifyPresenceCode(
      secret.secret,
      presenceCode,
      nowMs,
      presenceCodeContext(
          assignment,
          expected.uid,
          expected.challengeId,
      ),
  );
  if (counter == null) {
    throw callableError(
        "permission-denied",
        "PRESENCE_CODE_INVALID",
        "Kode kehadiran onsite salah atau sudah kedaluwarsa.",
    );
  }
  const grant = grantSnapshot.exists ? grantSnapshot.data() : null;
  const issuedAtMs = timestampMillis(grant && grant.issuedAt);
  const displayExpiresAtMs = timestampMillis(
      grant && grant.displayExpiresAt,
  );
  const grantExpiresAtMs = timestampMillis(grant && grant.expiresAt);
  const expectedDisplayExpiresAtMs = (counter + 1) *
    core.PRESENCE_CODE_PERIOD_SECONDS * 1000;
  const expectedGrantExpiresAtMs = (counter + 2) *
    core.PRESENCE_CODE_PERIOD_SECONDS * 1000;
  if (!grant || grant.status !== "active" || grant.consumedAt != null ||
      grant.attendanceId != null ||
      grant.uid !== expected.uid || grant.action !== expected.action ||
      grant.challengeId !== expected.challengeId ||
      grant.geofenceCollection !== assignment.collection ||
      grant.geofenceId !== assignment.id || grant.counter !== counter ||
      !Number.isFinite(issuedAtMs) || issuedAtMs > nowMs ||
      displayExpiresAtMs !== expectedDisplayExpiresAtMs ||
      grantExpiresAtMs !== expectedGrantExpiresAtMs ||
      grantExpiresAtMs <= nowMs) {
    throw callableError(
        "permission-denied",
        "PRESENCE_GRANT_INVALID",
        "Kode onsite tidak diterbitkan untuk challenge pengguna ini.",
    );
  }
  let verifierLocation;
  try {
    verifierLocation = core.normalizeLocation(
        grant.verifierLocation,
        nowMs,
        [
          "distanceMeters",
          "uncertaintyAdjustedDistanceMeters",
          "serverReceivedAt",
        ],
    );
  } catch (_) {
    throw callableError(
        "failed-precondition",
        "VERIFIER_LOCATION_INVALID",
        "Lokasi perangkat penerbit kode tidak lagi valid.",
    );
  }
  if (typeof grant.issuedBy !== "string" ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(grant.issuedBy) ||
      !Number.isInteger(grant.verifierLocation?.distanceMeters) ||
      grant.verifierLocation.distanceMeters < 0 ||
      !Number.isInteger(
          grant.verifierLocation?.uncertaintyAdjustedDistanceMeters,
      ) ||
      grant.verifierLocation.uncertaintyAdjustedDistanceMeters <
        grant.verifierLocation.distanceMeters ||
      !Number.isFinite(timestampMillis(
          grant.verifierLocation?.serverReceivedAt,
      )) ||
      timestampMillis(grant.verifierLocation.serverReceivedAt) !==
        issuedAtMs) {
    throw callableError(
        "failed-precondition",
        "VERIFIER_LOCATION_INVALID",
        "Bukti lokasi penerbit kode tidak lengkap.",
    );
  }
  const verifierDistance = core.calculateDistanceMeters(
      verifierLocation.lat,
      verifierLocation.lng,
      geofence.lat,
      geofence.lng,
  );
  if (!Number.isFinite(verifierDistance) ||
      grant.verifierLocation.distanceMeters !==
        Math.round(verifierDistance) ||
      grant.verifierLocation.uncertaintyAdjustedDistanceMeters !==
        Math.round(verifierDistance + verifierLocation.accuracy) ||
      verifierDistance + verifierLocation.accuracy > geofence.radius) {
    throw callableError(
        "failed-precondition",
        "VERIFIER_LOCATION_INVALID",
        "Bukti jarak perangkat penerbit kode tidak konsisten.",
    );
  }
  const issuerSnapshot = await transaction.get(
      db.collection("users").doc(grant.issuedBy),
  );
  const issuer = issuerSnapshot.exists ? issuerSnapshot.data() : null;
  if (!issuer || issuer.accountStatus !== "active" ||
      issuer.isActive !== true || issuer.mustChangePassword === true ||
      (issuer.role !== "admin" && issuer.isAdmin !== true)) {
    throw callableError(
        "permission-denied",
        "PRESENCE_ISSUER_INACTIVE",
        "Admin penerbit kode tidak lagi aktif.",
    );
  }
  return {
    proof: {
      required: true,
      verified: true,
      counter,
      issuedBy: grant.issuedBy,
      grantId: grantSnapshot.id,
    },
    grantRef,
    verifierLocation,
  };
}

async function reserveSubmitAttempt(db, Timestamp, challengeRef, expected,
    nowMs) {
  const stamp = core.getServerAttendanceStamp(new Date(nowMs));
  const rateRef = db.collection("attendanceSubmitRateLimits")
      .doc(`${expected.uid}_${stamp.date}`);
  const now = Timestamp.fromMillis(nowMs);

  await db.runTransaction(async (transaction) => {
    const [challengeSnapshot, rateSnapshot] = await Promise.all([
      transaction.get(challengeRef),
      transaction.get(rateRef),
    ]);
    if (!challengeSnapshot.exists) {
      throw callableError(
          "not-found",
          "CHALLENGE_NOT_FOUND",
          "Challenge absensi tidak ditemukan.",
      );
    }
    const challenge = challengeSnapshot.data();
    assertChallengeState(challenge, expected, nowMs);
    const challengeAttempts = challenge.submitAttempts == null ?
      0 : challenge.submitAttempts;
    if (!Number.isInteger(challengeAttempts) || challengeAttempts < 0) {
      throw callableError(
          "failed-precondition",
          "SUBMIT_RATE_STATE_INVALID",
          "Status percobaan absensi tidak valid.",
      );
    }
    if (challengeAttempts >= MAX_CHALLENGE_SUBMISSIONS) {
      throw callableError(
          "resource-exhausted",
          "CHALLENGE_SUBMIT_LIMIT",
          "Batas percobaan challenge ini telah tercapai.",
      );
    }
    const lastAttemptAtMs = timestampMillis(challenge.lastSubmitAttemptAt);
    if (Number.isFinite(lastAttemptAtMs) &&
        lastAttemptAtMs > nowMs - SUBMIT_RATE_LIMIT_MS) {
      throw callableError(
          "resource-exhausted",
          "SUBMIT_RATE_LIMIT",
          "Tunggu sebentar sebelum mencoba kembali.",
      );
    }

    let dailyAttempts = 0;
    if (rateSnapshot.exists) {
      const rate = rateSnapshot.data();
      if (rate.date !== stamp.date || !Number.isInteger(rate.attemptCount) ||
          rate.attemptCount < 0) {
        throw callableError(
            "failed-precondition",
            "SUBMIT_RATE_STATE_INVALID",
            "Status pembatasan absensi harian tidak valid.",
        );
      }
      dailyAttempts = rate.attemptCount;
    }
    if (dailyAttempts >= MAX_DAILY_SUBMISSIONS) {
      throw callableError(
          "resource-exhausted",
          "DAILY_SUBMIT_LIMIT",
          "Batas percobaan absensi harian telah tercapai.",
      );
    }
    transaction.update(challengeRef, {
      submitAttempts: challengeAttempts + 1,
      lastSubmitAttemptAt: now,
    });
    transaction.set(rateRef, {
      uid: expected.uid,
      date: stamp.date,
      attemptCount: dailyAttempts + 1,
      lastAttemptAt: now,
    });
  });
}

function createAttendanceHandlers(admin) {
  const db = admin.firestore();
  const getBucket = () => admin.storage().bucket();
  const Timestamp = admin.firestore.Timestamp;

  async function createAttendanceChallenge(request) {
    const context = {
      operation: "createChallenge",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      action: safeAttendanceAction(request.data?.action),
    };
    return safelyRun(async () => {
      const uid = assertCallableSecurity(request, false);
      context.uid = uid;
      assertOnlyKeys(request.data, ["action"]);
      const action = core.assertAction(request.data.action);
      context.action = action;
      const challengeId = crypto.randomUUID();
      context.challengeId = challengeId;
      const photoPath = challengeUploadPath(uid, challengeId);
      const nowMs = Date.now();
      const now = Timestamp.fromMillis(nowMs);
      const expiresAt = Timestamp.fromMillis(nowMs + CHALLENGE_TTL_MS);
      const stamp = core.getServerAttendanceStamp(new Date(nowMs));
      const currentAttendanceId = `${uid}_${stamp.date}`;
      const userRef = db.collection("users").doc(uid);
      const currentAttendanceRef = db.collection("attendances")
          .doc(currentAttendanceId);
      const openShiftRef = db.collection("attendanceOpenShifts").doc(uid);
      const configRef = db.doc(PROJECT_CONFIG_PATH);
      const challengeRef = db.collection("attendanceChallenges")
          .doc(challengeId);
      const lockRef = db.collection("attendanceChallengeLocks")
          .doc(`${uid}_${action}`);
      const rateRef = db.collection("attendanceChallengeRateLimits")
          .doc(`${uid}_${stamp.date}`);

      const result = await db.runTransaction(async (transaction) => {
        const userSnapshot = await transaction.get(userRef);
        if (!userSnapshot.exists) core.assertActiveEmployee(null);
        const user = core.assertActiveEmployee(userSnapshot.data());
        const assignmentResult = assignmentAndRef(db, user);
        context.geofenceId =
          `${assignmentResult.assignment.collection}/` +
          assignmentResult.assignment.id;
        const [geofenceSnapshot, currentAttendanceSnapshot, openShiftSnapshot,
          configSnapshot, lockSnapshot, rateSnapshot] =
          await Promise.all([
            transaction.get(assignmentResult.ref),
            transaction.get(currentAttendanceRef),
            transaction.get(openShiftRef),
            transaction.get(configRef),
            transaction.get(lockRef),
            transaction.get(rateRef),
          ]);
        const config = configSnapshot.exists ? configSnapshot.data() : null;
        const configuredShiftDurationMs = maxShiftDurationMs(
            config,
            nowMs,
        );
        const verificationPolicy = attendanceVerificationPolicy(
            config,
            nowMs,
            {
              allowCheckoutGrace: action === "checkOut",
              maximumShiftDurationMs: configuredShiftDurationMs,
            },
        );
        // Surface a misconfigured policy now rather than after the selfie.
        const gpsPolicy = gps.gpsIntegrityPolicy(config);
        let geofence = null;
        let assignmentSnapshot = null;
        let allowedLocationsPublic = null;
        if (verificationPolicy.verificationMode ===
            VERIFICATION_MODE_GEOFENCE_ONSITE) {
          geofence = await verifiedGeofence(
              transaction,
              db,
              geofenceSnapshot,
              assignmentResult.assignment.collection,
          );
        } else {
          const assignmentOperational = assignmentOperationalCandidate(
              geofenceSnapshot,
              assignmentResult.assignment,
          );
          const operational = buildOperationalCandidates(
              assignmentOperational.assignmentSnapshot,
              assignmentOperational.candidate,
              verificationPolicy.allowedLocations,
          );
          assignmentSnapshot = operational.assignmentSnapshot;
          allowedLocationsPublic = operational.publicLocations;
          if (allowedLocationsPublic.length < 1) {
            throw callableError(
                "failed-precondition",
                "OPERATIONAL_LOCATION_UNAVAILABLE",
                "Tidak ada lokasi operasional yang dapat dipakai untuk absensi.",
            );
          }
        }

        const existingShift = openShiftSnapshot.exists ?
          assertOpenShiftState(openShiftSnapshot.data(), uid) : null;
        let targetAttendanceId = currentAttendanceId;
        let targetAttendanceRef = currentAttendanceRef;
        let targetAttendanceSnapshot = currentAttendanceSnapshot;
        let targetShiftRevision = existingShift ?
          existingShift.revision + 1 : 1;
        let targetWorkDate = stamp.date;

        if (action === "checkIn") {
          if (currentAttendanceSnapshot.exists) {
            throw callableError(
                "already-exists",
                "ALREADY_CHECKED_IN",
                "Check-in hari ini sudah tercatat.",
            );
          }
          if (existingShift?.status === "open") {
            throw callableError(
                "failed-precondition",
                "OPEN_SHIFT_EXISTS",
                "Shift sebelumnya masih terbuka dan harus di-check-out.",
            );
          }
        } else {
          if (!existingShift || existingShift.status !== "open") {
            throw callableError(
                "failed-precondition",
                "CHECK_IN_REQUIRED",
                "Tidak ada shift aktif yang dapat di-check-out.",
            );
          }
          targetAttendanceId = existingShift.attendanceId;
          targetWorkDate = existingShift.workDate;
          targetShiftRevision = existingShift.revision;
          targetAttendanceRef = db.collection("attendances")
              .doc(targetAttendanceId);
          if (targetAttendanceId !== currentAttendanceId) {
            targetAttendanceSnapshot = await transaction.get(
                targetAttendanceRef,
            );
          }
          if (!targetAttendanceSnapshot.exists) {
            throw callableError(
                "failed-precondition",
                "OPEN_SHIFT_STATE_INVALID",
                "Data absensi untuk shift aktif tidak ditemukan.",
            );
          }
          const targetAttendance = targetAttendanceSnapshot.data();
          if (targetAttendance.checkOut != null) {
            throw callableError(
                "already-exists",
                "ALREADY_CHECKED_OUT",
                "Shift aktif sudah memiliki check-out.",
            );
          }
          const checkInMs = assertVerifiedCheckIn(
              targetAttendance,
              uid,
              targetWorkDate,
              nowMs,
          );
          const checkInVerificationMode =
            attendanceVerificationModeForAction(
                targetAttendance,
                "checkIn",
            );
          if (checkInVerificationMode !==
              verificationPolicy.verificationMode) {
            throw callableError(
                "failed-precondition",
                "ATTENDANCE_POLICY_CHANGED",
                "Mode check-out harus sama dengan mode check-in.",
            );
          }
          if (verificationPolicy.checkoutGrace === true &&
              checkInVerificationMode !==
                VERIFICATION_MODE_LOCATION_PHOTO) {
            throw callableError(
                "failed-precondition",
                "LOCATION_PHOTO_MODE_EXPIRED",
                "Masa berlaku mode lokasi dan foto telah berakhir.",
            );
          }
          if (checkInMs !== existingShift.checkInMs) {
            throw callableError(
                "failed-precondition",
                "OPEN_SHIFT_STATE_INVALID",
                "Pointer shift aktif tidak cocok dengan waktu check-in.",
            );
          }
          assertShiftCheckoutWindow(
              checkInMs,
              nowMs,
              configuredShiftDurationMs,
          );
        }
        let challengeCount = 0;
        if (rateSnapshot.exists) {
          const rate = rateSnapshot.data();
          if (rate.date !== stamp.date ||
              !Number.isInteger(rate.challengeCount) ||
              rate.challengeCount < 0) {
            throw callableError(
                "failed-precondition",
                "CHALLENGE_RATE_STATE_INVALID",
                "Status pembatasan challenge tidak valid.",
            );
          }
          challengeCount = rate.challengeCount;
        }
        if (challengeCount >= MAX_DAILY_CHALLENGES) {
          throw callableError(
              "resource-exhausted",
              "DAILY_CHALLENGE_LIMIT",
              "Batas challenge absensi harian telah tercapai.",
          );
        }
        if (lockSnapshot.exists) {
          const lock = lockSnapshot.data();
          const lastCreatedAt = timestampMillis(lock.createdAt);
          const lockExpiresAt = timestampMillis(lock.expiresAt);
          if (lock.uid !== uid || lock.action !== action ||
              !new Set(["pending", "consumed"]).has(lock.status) ||
              !Number.isFinite(lastCreatedAt) ||
              !Number.isFinite(lockExpiresAt) ||
              lockExpiresAt <= lastCreatedAt) {
            throw callableError(
                "failed-precondition",
                "CHALLENGE_LOCK_INVALID",
                "Status challenge pengguna tidak valid.",
            );
          }
          if (Number.isFinite(lastCreatedAt) &&
              lastCreatedAt > nowMs - CHALLENGE_RATE_LIMIT_MS) {
            throw callableError(
                "resource-exhausted",
                "CHALLENGE_RATE_LIMIT",
                "Tunggu sebentar sebelum meminta challenge baru.",
            );
          }
        }

        let previousChallengeRef = null;
        let previousChallengeSnapshot = null;
        if (lockSnapshot.exists && lockSnapshot.data().status === "pending") {
          const previousChallengeId = lockSnapshot.data().challengeId;
          try {
            core.assertChallengeId(previousChallengeId);
          } catch (_) {
            throw callableError(
                "failed-precondition",
                "CHALLENGE_LOCK_INVALID",
                "Status challenge pengguna tidak valid.",
            );
          }
          previousChallengeRef = db.collection("attendanceChallenges")
              .doc(previousChallengeId);
          previousChallengeSnapshot = await transaction.get(
              previousChallengeRef,
          );
        }

        const challenge = {
          uid,
          action,
          status: "pending",
          photoPath,
          createdAt: now,
          expiresAt,
          consumedAt: null,
          attendanceId: null,
          requestDate: stamp.date,
          targetAttendanceId,
          targetWorkDate,
          targetShiftRevision,
          submitAttempts: 0,
          lastSubmitAttemptAt: null,
          geofenceCollection: assignmentResult.assignment.collection,
          geofenceId: assignmentResult.assignment.id,
          assignmentCollection: assignmentResult.assignment.collection,
          assignmentId: assignmentResult.assignment.id,
          verificationMode: verificationPolicy.verificationMode,
          policySecurityVersion: verificationPolicy.policySecurityVersion,
          locationPhotoModePolicyVersion:
            verificationPolicy.locationPhotoModePolicyVersion,
          locationPhotoModeEnabledAt:
            verificationPolicy.enabledAtMs == null ?
              null : Timestamp.fromMillis(verificationPolicy.enabledAtMs),
          locationPhotoModeExpiresAt:
            verificationPolicy.expiresAtMs == null ?
              null : Timestamp.fromMillis(verificationPolicy.expiresAtMs),
          locationPhotoAllowedLocationsVersion:
            verificationPolicy.allowedLocationsVersion == null ?
              null : verificationPolicy.allowedLocationsVersion,
          locationPhotoAllowedLocationsDigest:
            verificationPolicy.allowedLocationsDigest == null ?
              null : verificationPolicy.allowedLocationsDigest,
          presenceProofRequired:
            verificationPolicy.verificationMode ===
              VERIFICATION_MODE_GEOFENCE_ONSITE,
          appId: request.app.appId,
        };
        transaction.create(challengeRef, challenge);
        transaction.set(lockRef, {
          uid,
          action,
          challengeId,
          status: "pending",
          createdAt: now,
          expiresAt,
        });
        transaction.set(rateRef, {
          uid,
          date: stamp.date,
          challengeCount: challengeCount + 1,
          lastCreatedAt: now,
        });
        if (previousChallengeRef && previousChallengeSnapshot.exists &&
            previousChallengeSnapshot.data().status === "pending") {
          transaction.update(previousChallengeRef, {
            status: "superseded",
            supersededAt: now,
            supersededBy: challengeId,
          });
        }
        return {
          verificationMode: verificationPolicy.verificationMode,
          presenceProofRequired:
            verificationPolicy.verificationMode ===
              VERIFICATION_MODE_GEOFENCE_ONSITE,
          geofence: geofence ? publicGeofence(geofence) : null,
          assignment: assignmentSnapshot || {
            collection: assignmentResult.assignment.collection,
            id: assignmentResult.assignment.id,
            name: geofence.name,
          },
          allowedLocations: allowedLocationsPublic,
          verificationModeExpiresAt:
            verificationPolicy.expiresAtMs == null ? null :
              verificationPolicy.expiresAtMs +
                (action === "checkOut" &&
                  verificationPolicy.verificationMode ===
                    VERIFICATION_MODE_LOCATION_PHOTO ?
                  configuredShiftDurationMs : 0),
          earlyLeaveReasonRequired:
            action === "checkOut" &&
              isEarlyLeaveCheckout(nowMs, targetWorkDate),
          targetAttendanceId,
          targetWorkDate,
          // Advisory collection instructions. A client that ignores them only
          // produces a weaker trace; the submit-time policy stays authoritative
          // and is therefore never derived from this response.
          gpsTracePolicy: {
            traceVersion: gps.GPS_TRACE_SCHEMA_VERSION,
            mode: gpsPolicy.mode,
            minSamples: gps.MIN_TRACE_SAMPLES,
            minSpanMs: gps.MIN_TRACE_SPAN_MS,
            maxSamples: gps.MAX_TRACE_SAMPLES,
            requireMobileDevice: gpsPolicy.requireMobileDevice,
          },
        };
      });

      return {
        challengeId,
        action,
        uploadPath: photoPath,
        expiresAt: new Date(nowMs + CHALLENGE_TTL_MS).toISOString(),
        attendanceId: result.targetAttendanceId,
        workDate: result.targetWorkDate,
        verificationMode: result.verificationMode,
        verificationModeExpiresAt:
          result.verificationModeExpiresAt == null ? null :
            new Date(result.verificationModeExpiresAt).toISOString(),
        presenceProofRequired: result.presenceProofRequired,
        earlyLeaveReasonRequired: result.earlyLeaveReasonRequired,
        earlyLeaveThresholdHourWib: EARLY_LEAVE_THRESHOLD_HOUR_WIB,
        assignment: result.assignment,
        geofence: result.geofence,
        allowedLocations: result.allowedLocations,
        gpsTracePolicy: result.gpsTracePolicy,
      };
    }, context);
  }

  async function submitAttendance(request) {
    const context = {
      operation: "submitAttendance",
      uid: request.auth?.uid,
      appId: request.app?.appId,
    };
    return safelyRun(async () => {
      const uid = assertCallableSecurity(request, true);
      context.uid = uid;
      assertOnlyKeys(
          request.data,
          [
            "challengeId",
            "location",
            "locationTrace",
            "deviceIntegrity",
            "presenceCode",
            "earlyLeaveReason",
          ],
      );
      const challengeId = core.assertChallengeId(request.data.challengeId);
      context.challengeId = challengeId;
      const requestNowMs = Date.now();
      core.normalizeLocation(request.data.location, requestNowMs);
      // Shape errors fail fast, before any photo download. Freshness is
      // re-evaluated inside the transaction with the transaction clock.
      const requestTrace = gps.normalizeLocationTrace(
          request.data.locationTrace,
          requestNowMs,
      );
      const traceDigest = requestTrace ?
        gps.canonicalTraceDigest(requestTrace) : null;
      const deviceIntegrity = gps.normalizeDeviceIntegrity(
          request.data.deviceIntegrity,
      );
      const challengeRef = db.collection("attendanceChallenges")
          .doc(challengeId);
      const initialChallengeSnapshot = await challengeRef.get();
      if (!initialChallengeSnapshot.exists) {
        throw callableError(
            "not-found",
            "CHALLENGE_NOT_FOUND",
            "Challenge absensi tidak ditemukan.",
        );
      }
      const challenge = initialChallengeSnapshot.data();
      const action = core.assertAction(challenge.action);
      if (action !== "checkOut" &&
          Object.prototype.hasOwnProperty.call(
              request.data,
              "earlyLeaveReason",
          )) {
        throw callableError(
            "invalid-argument",
            "EARLY_LEAVE_REASON_NOT_ALLOWED",
            "Alasan pulang awal hanya berlaku untuk check-out.",
        );
      }
      const target = assertChallengeTarget(challenge, uid, action);
      const challengePolicy = normalizedChallengePolicy(challenge);
      const challengeAssignment = normalizedChallengeAssignment(challenge);
      context.action = action;
      context.attendanceId = target.attendanceId;
      context.geofenceId =
        `${challengeAssignment.collection}/${challengeAssignment.id}`;
      const photoPath = challengeUploadPath(uid, challengeId);
      const expected = {
        uid,
        action,
        challengeId,
        photoPath,
        appId: request.app.appId,
        requestDate: target.requestDate,
        targetAttendanceId: target.attendanceId,
        targetWorkDate: target.workDate,
        targetShiftRevision: target.revision,
        verificationMode: challengePolicy.verificationMode,
        policySecurityVersion: challengePolicy.policySecurityVersion,
        locationPhotoModePolicyVersion:
          challengePolicy.locationPhotoModePolicyVersion,
        locationPhotoModeEnabledAtMs: challengePolicy.enabledAtMs,
        locationPhotoModeExpiresAtMs: challengePolicy.expiresAtMs,
        assignmentCollection: challengeAssignment.collection,
        assignmentId: challengeAssignment.id,
      };
      assertChallengeState(challenge, expected, requestNowMs);
      await reserveSubmitAttempt(
          db,
          Timestamp,
          challengeRef,
          expected,
          requestNowMs,
      );
      const photo = await verifyPhoto(
          getBucket(),
          challenge,
          expected,
          requestNowMs,
      );
      const userRef = db.collection("users").doc(uid);
      const configRef = db.doc(PROJECT_CONFIG_PATH);
      const lockRef = db.collection("attendanceChallengeLocks")
          .doc(`${uid}_${action}`);
      const digestRef = db.collection("attendanceProofHashes")
          .doc(photo.sha256);
      const perceptualAuditRef = db
          .collection("attendanceProofPerceptualHashes")
          .doc(photo.sha256);
      const perceptualReplayStateRef = db
          .collection(PERCEPTUAL_REPLAY_STATE_COLLECTION)
          .doc(uid);
      const openShiftRef = db.collection("attendanceOpenShifts").doc(uid);
      const traceDigestRef = traceDigest == null ? null :
        db.collection(GPS_TRACE_DIGEST_COLLECTION).doc(traceDigest);

      const result = await db.runTransaction(async (transaction) => {
        // Re-evaluate all freshness and expiry checks on every transaction
        // attempt. Photo download/decode and a Firestore retry must not extend
        // the effective lifetime of client location, challenge, lock, or grant.
        const transactionNowMs = Date.now();
        const now = Timestamp.fromMillis(transactionNowMs);
        const location = core.normalizeLocation(
            request.data.location,
            transactionNowMs,
        );
        const trace = gps.normalizeLocationTrace(
            request.data.locationTrace,
            transactionNowMs,
        );
        const transactionStamp = core.getServerAttendanceStamp(
            new Date(transactionNowMs),
        );
        const earlyLeave = action === "checkOut" &&
          isEarlyLeaveCheckout(transactionNowMs, target.workDate);
        const earlyLeaveReason = normalizeEarlyLeaveReason(
            request.data.earlyLeaveReason,
            earlyLeave,
        );
        if (action === "checkIn" &&
            transactionStamp.date !== target.requestDate) {
          throw callableError(
              "failed-precondition",
              "CHALLENGE_DAY_CHANGED",
              "Tanggal WIB berubah; minta challenge check-in baru.",
          );
        }
        const attendanceId = target.attendanceId;
        const attendanceRef = db.collection("attendances").doc(attendanceId);
        const initialSnapshots = await Promise.all([
          transaction.get(challengeRef),
          transaction.get(userRef),
          transaction.get(configRef),
          transaction.get(openShiftRef),
          transaction.get(lockRef),
          transaction.get(digestRef),
          transaction.get(perceptualAuditRef),
          transaction.get(perceptualReplayStateRef),
        ]);
        const [freshChallengeSnapshot, userSnapshot, configSnapshot,
          openShiftSnapshot, lockSnapshot, digestSnapshot,
          perceptualAuditSnapshot,
          perceptualReplayStateSnapshot] =
          initialSnapshots;
        if (!freshChallengeSnapshot.exists) {
          throw callableError(
              "not-found",
              "CHALLENGE_NOT_FOUND",
              "Challenge absensi tidak ditemukan.",
          );
        }
        const freshChallenge = freshChallengeSnapshot.data();
        assertChallengeState(freshChallenge, expected, transactionNowMs);
        assertChallengeTarget(freshChallenge, uid, action);
        if (!userSnapshot.exists) core.assertActiveEmployee(null);
        const user = core.assertActiveEmployee(userSnapshot.data());
        const assignmentResult = assignmentAndRef(db, user);
        const freshChallengeAssignment =
          normalizedChallengeAssignment(freshChallenge);
        if (freshChallengeAssignment.collection !==
              assignmentResult.assignment.collection ||
            freshChallengeAssignment.id !== assignmentResult.assignment.id) {
          throw callableError(
              "failed-precondition",
              "ASSIGNMENT_CHANGED",
              "Penugasan berubah; minta challenge baru.",
          );
        }
        if (!lockSnapshot.exists ||
            lockSnapshot.data().challengeId !== challengeId ||
            lockSnapshot.data().status !== "pending" ||
            lockSnapshot.data().uid !== uid ||
            lockSnapshot.data().action !== action ||
            timestampMillis(lockSnapshot.data().createdAt) !==
              timestampMillis(freshChallenge.createdAt) ||
            timestampMillis(lockSnapshot.data().expiresAt) !==
              timestampMillis(freshChallenge.expiresAt) ||
            timestampMillis(lockSnapshot.data().expiresAt) <= transactionNowMs) {
          throw callableError(
              "failed-precondition",
              "CHALLENGE_SUPERSEDED",
              "Challenge telah digantikan oleh challenge yang lebih baru.",
          );
        }
        const config = configSnapshot.exists ? configSnapshot.data() : null;
        const configuredShiftDurationMs = maxShiftDurationMs(
            config,
            transactionNowMs,
        );
        const verificationPolicy = attendanceVerificationPolicy(
            config,
            transactionNowMs,
            {
              allowCheckoutGrace: action === "checkOut",
              maximumShiftDurationMs: configuredShiftDurationMs,
            },
        );
        assertCurrentChallengePolicy(freshChallenge, verificationPolicy);
        const gpsPolicy = gps.gpsIntegrityPolicy(config);
        const existingShift = openShiftSnapshot.exists ?
          assertOpenShiftState(openShiftSnapshot.data(), uid) : null;
        if (action === "checkIn") {
          if (existingShift?.status === "open") {
            throw callableError(
                "failed-precondition",
                "OPEN_SHIFT_EXISTS",
                "Shift sebelumnya masih terbuka dan harus di-check-out.",
            );
          }
          const nextRevision = existingShift ?
            existingShift.revision + 1 : 1;
          if (nextRevision !== target.revision) {
            throw callableError(
                "failed-precondition",
                "CHALLENGE_TARGET_STALE",
                "Target check-in berubah; minta challenge baru.",
            );
          }
        } else {
          if (!existingShift || existingShift.status !== "open") {
            throw callableError(
                "failed-precondition",
                "CHECK_IN_REQUIRED",
                "Tidak ada shift aktif yang dapat di-check-out.",
            );
          }
          if (existingShift.attendanceId !== target.attendanceId ||
              existingShift.workDate !== target.workDate ||
              existingShift.revision !== target.revision) {
            throw callableError(
                "failed-precondition",
                "CHALLENGE_TARGET_STALE",
                "Target check-out tidak lagi cocok dengan shift aktif.",
            );
          }
          assertShiftCheckoutWindow(
              existingShift.checkInMs,
              transactionNowMs,
              configuredShiftDurationMs,
          );
        }
        assertPhotoNotReplayed(digestSnapshot.exists, false);
        if (perceptualAuditSnapshot.exists) {
          throw replayStateError();
        }
        const perceptualReplayReservation = reservePerceptualReplayState(
            perceptualReplayStateSnapshot.exists ?
              perceptualReplayStateSnapshot.data() : null,
            {
              uid,
              proofId: photo.sha256,
              perceptualHashes: photo.perceptualHashes,
            },
            transactionNowMs,
        );
        assertPhotoNotReplayed(
            false,
            perceptualReplayReservation.nearReplay,
        );

        const [assignmentLocationSnapshot, attendanceSnapshot,
          traceDigestSnapshot] =
          await Promise.all([
          transaction.get(assignmentResult.ref),
          transaction.get(attendanceRef),
          traceDigestRef ? transaction.get(traceDigestRef) : null,
        ]);

        // Signal-signature analysis of the GPS trace. The verdict is recorded
        // either way; only enforce mode turns it into a rejection.
        const gpsReport = gps.analyzeGpsIntegrity({
          trace,
          location,
          nowMs: transactionNowMs,
          policy: gpsPolicy,
          traceReplayed: traceDigestSnapshot?.exists === true,
          device: deviceIntegrity,
          // Attestation is decided by the App Check application id the request
          // arrived on, never by anything the payload claims.
          appId: expected.appId,
        });
        const gpsSummary = gps.gpsIntegritySummary(gpsReport);
        context.gpsIntegrity = {
          mode: gpsSummary.mode,
          verdict: gpsSummary.verdict,
          score: gpsSummary.score,
          signals: gpsSummary.signals,
          platform: gpsSummary.platform,
        };
        if (gpsReport.blocking) {
          throw callableError(
              "failed-precondition",
              "GPS_INTEGRITY_REJECTED",
              "Pola sinyal GPS tidak lolos pemeriksaan integritas. " +
                "Matikan aplikasi pemalsu lokasi, aktifkan GPS perangkat, " +
                "lalu ambil lokasi ulang di area terbuka.",
          );
        }
        let geofence = null;
        let assignmentSnapshotData = null;
        let presenceVerification;
        let distance = null;
        let uncertaintyAdjustedDistance = null;
        let operationalMatch = null;
        let operationalSnapshotData = null;
        if (verificationPolicy.verificationMode ===
            VERIFICATION_MODE_GEOFENCE_ONSITE) {
          geofence = await verifiedGeofence(
              transaction,
              db,
              assignmentLocationSnapshot,
              assignmentResult.assignment.collection,
          );
          if (freshChallenge.presenceProofRequired !==
              geofence.presenceProofRequired) {
            throw callableError(
                "failed-precondition",
                "PRESENCE_POLICY_CHANGED",
                "Kebijakan kode onsite berubah; minta challenge baru.",
            );
          }
          presenceVerification = await verifyPresenceProof(
              transaction,
              db,
              assignmentResult.assignment,
              geofence,
              request.data.presenceCode,
              expected,
              transactionNowMs,
          );
          distance = core.calculateDistanceMeters(
              location.lat,
              location.lng,
              geofence.lat,
              geofence.lng,
          );
          uncertaintyAdjustedDistance = distance + location.accuracy;
          if (!Number.isFinite(distance) ||
              !Number.isFinite(uncertaintyAdjustedDistance) ||
              uncertaintyAdjustedDistance > geofence.radius) {
            throw callableError(
                "failed-precondition",
                "OUTSIDE_GEOFENCE",
                Number.isFinite(distance) ?
                  `Lokasi berada ${Math.round(distance)} meter dari geofence ` +
                    `dengan akurasi ${Math.round(location.accuracy)} meter; ` +
                    `batasnya ${geofence.radius} meter.` :
                  "Jarak lokasi terhadap geofence tidak valid.",
            );
          }
          presenceVerification.proof.coPresence = {
            verified: true,
            ...assertCoPresence(
                location,
                presenceVerification.verifierLocation,
                geofence,
            ),
          };
        } else {
          if (freshChallenge.presenceProofRequired !== false) {
            throw callableError(
                "failed-precondition",
                "PRESENCE_POLICY_CHANGED",
                "Kebijakan bukti kehadiran berubah; minta challenge baru.",
            );
          }
          const assignmentOperational = assignmentOperationalCandidate(
              assignmentLocationSnapshot,
              assignmentResult.assignment,
          );
          const operational = buildOperationalCandidates(
              assignmentOperational.assignmentSnapshot,
              assignmentOperational.candidate,
              verificationPolicy.allowedLocations,
          );
          assignmentSnapshotData = operational.assignmentSnapshot;
          operationalMatch = core.matchOperationalLocation(
              location,
              operational.candidates,
          );
          if (!operationalMatch) {
            throw callableError(
                "failed-precondition",
                "OUTSIDE_OPERATIONAL_LOCATION",
                "Posisi GPS beserta margin akurasinya berada di luar " +
                  "lokasi operasional yang diizinkan.",
            );
          }
          operationalSnapshotData = operationalLocationSnapshotData(
              operationalMatch,
          );
          presenceVerification = {
            proof: {
              required: false,
              verified: false,
              reason: LOCATION_PHOTO_PROOF_REASON,
            },
            grantRef: null,
            verifierLocation: null,
          };
        }

        const stamp = core.getServerAttendanceStamp(
            new Date(transactionNowMs),
            config?.jamCheckInDeadline,
        );
        const baseLocation = {
          ...location,
          serverReceivedAt: now,
        };
        const gpsIntegrityRecord = {
          ...gpsSummary,
          evaluatedAt: now,
        };
        const geofenceSnapshotData = geofence ? {
          id: geofence.id,
          collection: assignmentResult.assignment.collection,
          name: geofence.name,
          lat: geofence.lat,
          lng: geofence.lng,
          radius: geofence.radius,
          verifiedAt: Timestamp.fromMillis(geofence.verifiedAtMs),
          verificationAuditId: geofence.verificationAuditId,
          verificationReviewedAt:
            Timestamp.fromMillis(geofence.reviewedAtMs),
          verificationReviewedBy: geofence.reviewedBy,
          verificationOperator: geofence.verificationOperator,
          verificationReviewOperator: geofence.verificationReviewOperator,
          distanceMeters: Math.round(distance),
          uncertaintyAdjustedDistanceMeters:
            Math.round(uncertaintyAdjustedDistance),
        } : null;
        let workHours = 0;
        let attendanceStatus = stamp.status;
        let checkInIso = null;
        let checkOutIso = null;
        const locationPhotoMode =
          verificationPolicy.verificationMode ===
            VERIFICATION_MODE_LOCATION_PHOTO;
        const verificationStatus = locationPhotoMode ?
          "location_photo_only" : "verified";
        const transitionMode = locationPhotoMode;
        const withinRadius = locationPhotoMode ? null : true;

        if (action === "checkIn") {
          if (attendanceSnapshot.exists) {
            throw callableError(
                "already-exists",
                "ALREADY_CHECKED_IN",
                "Check-in hari ini sudah tercatat.",
            );
          }
          checkInIso = new Date(transactionNowMs).toISOString();
          transaction.create(attendanceRef, {
            userId: uid,
            userName: typeof user.name === "string" ? user.name : "",
            date: target.workDate,
            checkIn: now,
            checkInTime: checkInIso,
            checkInLocation: baseLocation,
            checkInPhoto: null,
            checkInPhotoPath: photo.path,
            checkInPhotoGeneration: photo.generation,
            checkInPhotoHash: photo.sha256,
            checkInPhotoPerceptualHash: photo.perceptualHash,
            checkInPhotoPerceptualHashes: photo.perceptualHashes,
            checkInPhotoMd5Hash: photo.md5Hash,
            checkInPhotoCrc32c: photo.crc32c,
            status: stamp.status,
            checkOut: null,
            checkOutTime: null,
            checkOutLocation: null,
            checkOutPhoto: null,
            checkOutPhotoPath: null,
            checkOutPhotoGeneration: null,
            checkOutPhotoHash: null,
            checkOutPhotoPerceptualHash: null,
            checkOutPhotoPerceptualHashes: null,
            checkOutPhotoMd5Hash: null,
            checkOutPhotoCrc32c: null,
            checkOutVerificationMode: null,
            checkOutVerificationStatus: null,
            checkOutTransitionMode: null,
            checkOutIsWithinRadius: null,
            checkOutDeviceVerified: null,
            checkOutAssignmentSnapshot: null,
            gpsIntegrity: gpsIntegrityRecord,
            checkOutGpsIntegrity: null,
            earlyLeave: null,
            earlyLeaveReason: null,
            earlyLeaveThresholdHourWib: EARLY_LEAVE_THRESHOLD_HOUR_WIB,
            workHours: 0,
            locationSource: location.source,
            locationAccuracy: location.accuracy,
            distanceFromGeofence:
              locationPhotoMode ? null : Math.round(distance),
            geofenceId: locationPhotoMode ? null : geofence.id,
            geofenceName: locationPhotoMode ? null : geofence.name,
            geofenceSnapshot: geofenceSnapshotData,
            assignmentSnapshot: assignmentSnapshotData,
            operationalLocationSnapshot: operationalSnapshotData,
            verificationMode: verificationPolicy.verificationMode,
            transitionMode,
            isWithinRadius: withinRadius,
            deviceVerified: locationPhotoMode ? false : null,
            integrityVersion: 2,
            verificationStatus,
            presenceProof: presenceVerification.proof,
            userRole: user.role || null,
            assignmentType: user.assignmentType || null,
            challengeIds: {checkIn: challengeId, checkOut: null},
            proofVersion: 2,
            createdAt: now,
            updatedAt: now,
          });
          transaction.set(openShiftRef, {
            schemaVersion: OPEN_SHIFT_SCHEMA_VERSION,
            uid,
            revision: target.revision,
            status: "open",
            attendanceId,
            workDate: target.workDate,
            checkInAt: now,
            closedAt: null,
            createdAt: now,
            updatedAt: now,
          });
        } else {
          if (!attendanceSnapshot.exists) {
            throw callableError(
                "failed-precondition",
                "CHECK_IN_REQUIRED",
                "Data check-in untuk shift aktif tidak ditemukan.",
            );
          }
          const attendance = attendanceSnapshot.data();
          if (attendance.userId !== uid || attendance.checkOut != null) {
            throw callableError(
              "already-exists",
              "ALREADY_CHECKED_OUT",
              "Shift aktif sudah memiliki check-out.",
            );
          }
          const checkInMs = assertVerifiedCheckIn(
              attendance,
              uid,
              target.workDate,
              transactionNowMs,
          );
          const checkInVerificationMode =
            attendanceVerificationModeForAction(
                attendance,
                "checkIn",
            );
          if (checkInVerificationMode !==
              verificationPolicy.verificationMode) {
            throw callableError(
                "failed-precondition",
                "ATTENDANCE_POLICY_CHANGED",
                "Mode check-out harus sama dengan mode check-in.",
            );
          }
          if (verificationPolicy.checkoutGrace === true &&
              checkInVerificationMode !==
                VERIFICATION_MODE_LOCATION_PHOTO) {
            throw callableError(
                "failed-precondition",
                "LOCATION_PHOTO_MODE_EXPIRED",
                "Masa berlaku mode lokasi dan foto telah berakhir.",
            );
          }
          if (!existingShift || checkInMs !== existingShift.checkInMs) {
            throw callableError(
                "failed-precondition",
                "OPEN_SHIFT_STATE_INVALID",
                "Pointer shift aktif tidak cocok dengan waktu check-in.",
            );
          }
          assertShiftCheckoutWindow(
              checkInMs,
              transactionNowMs,
              configuredShiftDurationMs,
          );
          workHours = core.calculateWorkHours(checkInMs, transactionNowMs);
          attendanceStatus = attendance.status || null;
          checkInIso = new Date(checkInMs).toISOString();
          checkOutIso = new Date(transactionNowMs).toISOString();
          transaction.update(attendanceRef, {
            "checkOut": now,
            "checkOutTime": checkOutIso,
            "checkOutDateWib": transactionStamp.date,
            "checkOutLocation": baseLocation,
            "checkOutPhoto": null,
            "checkOutPhotoPath": photo.path,
            "checkOutPhotoGeneration": photo.generation,
            "checkOutPhotoHash": photo.sha256,
            "checkOutPhotoPerceptualHash": photo.perceptualHash,
            "checkOutPhotoPerceptualHashes": photo.perceptualHashes,
            "checkOutPhotoMd5Hash": photo.md5Hash,
            "checkOutPhotoCrc32c": photo.crc32c,
            workHours,
            "checkOutVerificationMode": verificationPolicy.verificationMode,
            "checkOutVerificationStatus": verificationStatus,
            "checkOutTransitionMode": transitionMode,
            "checkOutIsWithinRadius": withinRadius,
            "checkOutDeviceVerified": locationPhotoMode ? false : null,
            "checkOutDistanceFromGeofence":
              locationPhotoMode ? null : Math.round(distance),
            "checkOutGeofenceSnapshot": geofenceSnapshotData,
            "checkOutAssignmentSnapshot": assignmentSnapshotData,
            "checkOutOperationalLocationSnapshot": operationalSnapshotData,
            "checkOutPresenceProof": presenceVerification.proof,
            "checkOutGpsIntegrity": gpsIntegrityRecord,
            earlyLeave,
            earlyLeaveReason,
            earlyLeaveThresholdHourWib: EARLY_LEAVE_THRESHOLD_HOUR_WIB,
            "challengeIds.checkOut": challengeId,
            "updatedAt": now,
          });
          transaction.update(openShiftRef, {
            status: "closed",
            closedAt: now,
            updatedAt: now,
            closureSource: locationPhotoMode ?
              "location-photo-checkout" : "verified-checkout",
            checkOutChallengeId: challengeId,
          });
        }

        transaction.create(digestRef, {
          uid,
          action,
          attendanceId,
          challengeId,
          photoPath: photo.path,
          generation: photo.generation,
          sha256: photo.sha256,
          perceptualHash: photo.perceptualHash,
          perceptualHashes: photo.perceptualHashes,
          md5Hash: photo.md5Hash,
          crc32c: photo.crc32c,
          createdAt: now,
        });
        transaction.create(perceptualAuditRef, {
          schemaVersion: PERCEPTUAL_AUDIT_SCHEMA_VERSION,
          proofId: photo.sha256,
          uid,
          action,
          attendanceId,
          challengeId,
          photoPath: photo.path,
          generation: photo.generation,
          sha256: photo.sha256,
          perceptualHash: photo.perceptualHash,
          perceptualHashes: photo.perceptualHashes,
          hashVersion: core.PERCEPTUAL_HASH_VERSION,
          createdAt: now,
        });
        transaction.set(
            perceptualReplayStateRef,
            perceptualReplayReservation.nextState,
        );
        if (trace && traceDigestRef) {
          // Raw samples are kept out of the attendance document: they are
          // forensic evidence, not part of the presence record, and this
          // collection can be purged independently.
          transaction.create(
              db.collection(GPS_TRACE_COLLECTION)
                  .doc(`${attendanceId}_${action}`),
              {
                schemaVersion: GPS_TRACE_SCHEMA_VERSION,
                uid,
                action,
                attendanceId,
                challengeId,
                traceVersion: trace.version,
                traceDigest,
                startedAt: Timestamp.fromMillis(trace.startedAt),
                endedAt: Timestamp.fromMillis(trace.endedAt),
                samples: trace.samples,
                environment: trace.environment,
                analysis: gpsIntegrityRecord,
                createdAt: now,
              },
          );
          const existingDigest = traceDigestSnapshot?.exists ?
            traceDigestSnapshot.data() : null;
          const priorOccurrences =
            Number.isInteger(existingDigest?.occurrences) ?
              existingDigest.occurrences : 0;
          transaction.set(traceDigestRef, {
            digest: traceDigest,
            uid: existingDigest?.uid || uid,
            action: existingDigest?.action || action,
            attendanceId: existingDigest?.attendanceId || attendanceId,
            challengeId: existingDigest?.challengeId || challengeId,
            lastUid: uid,
            lastAction: action,
            lastAttendanceId: attendanceId,
            lastChallengeId: challengeId,
            occurrences: priorOccurrences + 1,
            firstSeenAt: existingDigest?.firstSeenAt || now,
            lastSeenAt: now,
          });
        }
        if (presenceVerification.grantRef) {
          transaction.update(presenceVerification.grantRef, {
            status: "consumed",
            consumedAt: now,
            attendanceId,
          });
        }
        transaction.update(challengeRef, {
          status: "consumed",
          consumedAt: now,
          attendanceId,
          photoGeneration: photo.generation,
          photoHash: photo.sha256,
          photoPerceptualHash: photo.perceptualHash,
          photoPerceptualHashes: photo.perceptualHashes,
        });
        transaction.update(lockRef, {
          status: "consumed",
          consumedAt: now,
          attendanceId,
        });

        return {
          attendanceId,
          geofence,
          assignment: assignmentSnapshotData || {
            collection: assignmentResult.assignment.collection,
            id: assignmentResult.assignment.id,
            name: geofence.name,
          },
          verificationMode: verificationPolicy.verificationMode,
          distance: locationPhotoMode ? null : Math.round(distance),
          stamp,
          workDate: target.workDate,
          status: attendanceStatus,
          workHours,
          checkIn: checkInIso,
          checkOut: checkOutIso,
          earlyLeave,
        };
      });

      return {
        success: true,
        attendanceId: result.attendanceId,
        action,
        date: result.workDate,
        status: result.status,
        checkIn: result.checkIn,
        checkOut: result.checkOut,
        earlyLeave: result.earlyLeave,
        workHours: result.workHours,
        verificationMode: result.verificationMode,
        assignment: result.assignment,
        geofence: result.geofence ? {
          id: result.geofence.id,
          name: result.geofence.name,
          radius: result.geofence.radius,
          distance: result.distance,
        } : null,
      };
    }, context);
  }

  async function getAttendancePhotoUrl(request) {
    const context = {
      operation: "getAttendancePhotoUrl",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      action: safeAttendanceAction(request.data?.action),
      attendanceId: request.data?.attendanceId,
    };
    return safelyRun(async () => {
      const uid = assertCallableSecurity(request, false);
      context.uid = uid;
      assertOnlyKeys(request.data, ["attendanceId", "action"]);
      const {attendanceId, action} = request.data;
      if (typeof attendanceId !== "string" ||
          !/^[A-Za-z0-9:_-]{1,180}$/.test(attendanceId)) {
        throw callableError(
            "invalid-argument",
            "INVALID_ATTENDANCE_ID",
            "ID absensi tidak valid.",
        );
      }
      core.assertAction(action);
      const [userSnapshot, attendanceSnapshot] = await Promise.all([
        db.collection("users").doc(uid).get(),
        db.collection("attendances").doc(attendanceId).get(),
      ]);
      if (!userSnapshot.exists ||
          userSnapshot.data().accountStatus !== "active" ||
          userSnapshot.data().isActive !== true ||
          userSnapshot.data().mustChangePassword === true) {
        throw callableError(
            "permission-denied",
            "ACCOUNT_INACTIVE",
            "Akun pengguna tidak aktif.",
        );
      }
      if (!attendanceSnapshot.exists) {
        throw callableError(
            "not-found",
            "ATTENDANCE_NOT_FOUND",
            "Data absensi tidak ditemukan.",
        );
      }
      const user = userSnapshot.data();
      const attendance = attendanceSnapshot.data();
      const isAdmin = user.role === "admin" || user.isAdmin === true;
      if (!isAdmin && attendance.userId !== uid) {
        throw callableError(
            "permission-denied",
            "PHOTO_ACCESS_DENIED",
            "Foto absensi ini bukan milik pengguna.",
        );
      }
      const prefix = action === "checkIn" ? "checkIn" : "checkOut";
      const presence = action === "checkIn" ?
        attendance.presenceProof : attendance.checkOutPresenceProof;
      let challengeId;
      try {
        challengeId = core.assertChallengeId(
            attendance.challengeIds && attendance.challengeIds[prefix],
        );
      } catch (_) {
        challengeId = null;
      }
      const photoPath = attendance[`${prefix}PhotoPath`];
      const generation = attendance[`${prefix}PhotoGeneration`];
      const sha256 = attendance[`${prefix}PhotoHash`];
      const perceptualHash = attendance[`${prefix}PhotoPerceptualHash`];
      const perceptualHashes =
        attendance[`${prefix}PhotoPerceptualHashes`];
      const md5Hash = attendance[`${prefix}PhotoMd5Hash`];
      const crc32c = attendance[`${prefix}PhotoCrc32c`];
      const expectedPath = challengeId ?
        `attendanceProofs/${attendance.userId}/${challengeId}` : null;
      let evidenceMode;
      try {
        evidenceMode = attendanceVerificationModeForAction(
            attendance,
            action,
        );
      } catch (_) {
        evidenceMode = null;
      }
      const actionTimestampMs = timestampMillis(attendance[prefix]);
      const actionVerificationStatus = action === "checkIn" ?
        attendance.verificationStatus :
        (attendance.checkOutVerificationStatus ??
          attendance.verificationStatus);
      const actionTransitionMode = action === "checkIn" ?
        attendance.transitionMode :
        (attendance.checkOutTransitionMode ?? attendance.transitionMode);
      const actionWithinRadius = action === "checkIn" ?
        attendance.isWithinRadius :
        (attendance.checkOutIsWithinRadius ?? attendance.isWithinRadius);
      const actionDeviceVerified = action === "checkIn" ?
        attendance.deviceVerified : attendance.checkOutDeviceVerified;
      const actionDistance = action === "checkIn" ?
        attendance.distanceFromGeofence :
        attendance.checkOutDistanceFromGeofence;
      const actionGeofence = action === "checkIn" ?
        attendance.geofenceSnapshot : attendance.checkOutGeofenceSnapshot;
      const actionAssignment = action === "checkIn" ?
        attendance.assignmentSnapshot : attendance.checkOutAssignmentSnapshot;
      const actionLocation = action === "checkIn" ?
        attendance.checkInLocation : attendance.checkOutLocation;
      const strongEvidenceValid =
        actionVerificationStatus === "verified" &&
        actionTransitionMode === false &&
        actionWithinRadius === true &&
        presence?.required === true &&
        presence?.verified === true &&
        presence?.coPresence?.verified === true &&
        typeof presence?.grantId === "string" &&
        typeof actionGeofence?.verificationAuditId === "string";
      const locationPhotoEvidenceValid =
        actionVerificationStatus === "location_photo_only" &&
        actionTransitionMode === true &&
        actionWithinRadius === null &&
        actionDeviceVerified === false &&
        actionDistance === null &&
        actionGeofence === null &&
        isLocationPhotoProof(presence) &&
        validStoredAssignmentSnapshot(actionAssignment) &&
        validStoredLocation(actionLocation, actionTimestampMs);
      if (attendance.integrityVersion !== 2 ||
          attendance.proofVersion !== 2 ||
          (evidenceMode === VERIFICATION_MODE_GEOFENCE_ONSITE &&
            !strongEvidenceValid) ||
          (evidenceMode === VERIFICATION_MODE_LOCATION_PHOTO &&
            !locationPhotoEvidenceValid) ||
          evidenceMode == null ||
          typeof photoPath !== "string" || photoPath !== expectedPath ||
          !generation || typeof sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(sha256) ||
          typeof perceptualHash !== "string" ||
          !/^[0-9a-f]{36}$/.test(perceptualHash) ||
          !Array.isArray(perceptualHashes) ||
          perceptualHashes.length !== core.PERCEPTUAL_HASH_VIEW_COUNT ||
          perceptualHashes[0] !== perceptualHash ||
          typeof md5Hash !== "string" || typeof crc32c !== "string") {
        throw callableError(
            "not-found",
            "PHOTO_NOT_FOUND",
            "Foto absensi terverifikasi tidak ditemukan.",
        );
      }
      const file = getBucket().file(photoPath, {generation});
      const [metadata] = await file.getMetadata();
      if (String(metadata.generation) !== String(generation) ||
          metadata.contentType !== "image/jpeg" ||
          metadata.md5Hash !== md5Hash || metadata.crc32c !== crc32c ||
          metadata.metadata?.uid !== attendance.userId ||
          metadata.metadata?.challengeId !== challengeId ||
          metadata.metadata?.action !== action) {
        throw callableError(
            "failed-precondition",
            "PHOTO_VERSION_MISMATCH",
            "Versi foto absensi tidak sesuai dengan catatan server.",
        );
      }
      const expiresAtMs = Date.now() + PHOTO_URL_TTL_MS;
      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "read",
        expires: expiresAtMs,
        responseType: "image/jpeg",
      });
      return {
        url,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    }, context);
  }

  return {
    createAttendanceChallenge,
    getAttendancePhotoUrl,
    submitAttendance,
  };
}

module.exports = {
  CHALLENGE_TTL_MS,
  EARLY_LEAVE_REASON_MAX_LENGTH,
  EARLY_LEAVE_REASON_MIN_LENGTH,
  EARLY_LEAVE_THRESHOLD_HOUR_WIB,
  LOCATION_PHOTO_MODE_POLICY_VERSION,
  MAX_LOCATION_PHOTO_MODE_DURATION_MS,
  VERIFICATION_MODE_GEOFENCE_ONSITE,
  VERIFICATION_MODE_LOCATION_PHOTO,
  assertChallengeTarget,
  assertPhotoNotReplayed,
  assertCoPresence,
  assertOpenShiftState,
  assertShiftCheckoutWindow,
  attendanceVerificationPolicy,
  createAttendanceHandlers,
  isEarlyLeaveCheckout,
  maxShiftDurationMs,
  normalizeEarlyLeaveReason,
  reservePerceptualReplayState,
};
