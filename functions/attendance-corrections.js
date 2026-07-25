"use strict";

const crypto = require("node:crypto");
const {HttpsError} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const core = require("./attendance-core");

const PROPOSAL_COLLECTION = "attendanceCorrectionProposals";
const DECISION_COLLECTION = "attendanceCorrectionDecisions";
const EVENT_COLLECTION = "attendanceCorrectionEvents";
const EFFECTIVE_COLLECTION = "attendanceCorrectionEffectiveViews";
const OPEN_SHIFT_COLLECTION = "attendanceOpenShifts";
const CONFIG_COLLECTION = "projectConfig";
const CONFIG_DOCUMENT = "default";
const MAX_SHIFT_DURATION_FIELD = "maxAttendanceShiftDurationMinutes";
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_SHIFT_DURATION_MINUTES = 60;
const MAX_SHIFT_DURATION_MINUTES = 24 * 60;
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;
const SCHEMA_VERSION = 1;
const CORRECTION_SOURCE =
  "dual-approved-manual-missing-checkout-v1";
const ALLOWED_DECISIONS = new Set(["approve", "reject"]);

const PROPOSAL_FIELDS = new Set([
  "schemaVersion",
  "action",
  "proposalId",
  "status",
  "correctionType",
  "attendanceId",
  "userId",
  "workDate",
  "requestedCheckOut",
  "requestedCheckOutIso",
  "reason",
  "baseRevision",
  "baseFingerprint",
  "attendanceUpdateTime",
  "openShiftUpdateTime",
  "configUpdateTime",
  "maxShiftDurationMinutes",
  "source",
  "manualCorrection",
  "deviceVerified",
  "proposerUid",
  "proposerAccountFingerprint",
  "proposedAt",
  "expiresAt",
  "proposalFingerprint",
]);

function callableError(code, reason, message) {
  return new HttpsError(code, message, {reason});
}

function securityFingerprint(value) {
  if (typeof value !== "string" || !value) return undefined;
  return crypto.createHash("sha256")
      .update("attendance-correction-log-v1\u0000")
      .update(value)
      .digest("hex")
      .slice(0, 20);
}

function validDocumentId(value, maximumLength = 180) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9:_-]+$/.test(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function validProposalId(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(value);
}

function validWorkDate(value) {
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

function timestampMillis(value) {
  return value && typeof value.toMillis === "function" ?
    value.toMillis() : NaN;
}

function timestampIso(value, reason = "SOURCE_VERSION_INVALID") {
  if (!value || typeof value.toDate !== "function") {
    throw callableError(
        "failed-precondition",
        reason,
        "Versi sumber koreksi tidak dapat diverifikasi.",
    );
  }
  return value.toDate().toISOString();
}

function hashObject(domain, value) {
  return crypto.createHash("sha256")
      .update(domain)
      .update("\u0000")
      .update(JSON.stringify(value))
      .digest("hex");
}

function accountFingerprint(uid) {
  if (!validDocumentId(uid, 128)) {
    throw callableError(
        "failed-precondition",
        "ADMIN_IDENTITY_INVALID",
        "Identitas akun admin tidak valid.",
    );
  }
  return hashObject("firebase-auth-uid", uid);
}

function assertRequest(request, allowedFields) {
  if (!request.auth?.uid) {
    throw callableError(
        "unauthenticated",
        "AUTH_REQUIRED",
        "Login admin diperlukan.",
    );
  }
  if (!request.app) {
    throw callableError(
        "permission-denied",
        "APP_CHECK_REQUIRED",
        "Aplikasi admin tidak dapat diverifikasi.",
    );
  }
  if (request.app.alreadyConsumed === true) {
    throw callableError(
        "unauthenticated",
        "APP_CHECK_REPLAY",
        "Token keamanan sudah pernah digunakan.",
    );
  }
  if (!request.data || typeof request.data !== "object" ||
      Array.isArray(request.data) ||
      Object.keys(request.data).some((key) => !allowedFields.includes(key))) {
    throw callableError(
        "invalid-argument",
        "INVALID_REQUEST",
        "Payload koreksi absensi tidak valid.",
    );
  }
  return request.auth.uid;
}

function assertActiveAdmin(snapshot) {
  if (!snapshot?.exists) {
    throw callableError(
        "permission-denied",
        "ADMIN_REQUIRED",
        "Profil admin tidak ditemukan.",
    );
  }
  const user = snapshot.data();
  if (user.accountStatus !== "active" || user.isActive !== true ||
      user.mustChangePassword === true ||
      (user.role !== "admin" && user.isAdmin !== true)) {
    throw callableError(
        "permission-denied",
        "ADMIN_REQUIRED",
        "Hanya admin aktif yang dapat memproses koreksi absensi.",
    );
  }
  return user;
}

function assertIndependentReviewer(proposerUid, reviewerUid) {
  if (!validDocumentId(proposerUid, 128) ||
      !validDocumentId(reviewerUid, 128)) {
    throw callableError(
        "failed-precondition",
        "REVIEWER_IDENTITY_INVALID",
        "Identitas proposer atau reviewer tidak valid.",
    );
  }
  if (proposerUid === reviewerUid ||
      accountFingerprint(proposerUid) === accountFingerprint(reviewerUid)) {
    throw callableError(
        "permission-denied",
        "SAME_REVIEWER",
        "Koreksi wajib direview oleh akun admin kedua.",
    );
  }
}

function normalizeReason(value) {
  if (typeof value !== "string") {
    throw callableError(
        "invalid-argument",
        "REASON_INVALID",
        "Alasan koreksi wajib diisi.",
    );
  }
  const reason = value.trim();
  const hasForbiddenControlCharacter = [...reason].some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127;
  });
  if (reason.length < MIN_REASON_LENGTH ||
      reason.length > MAX_REASON_LENGTH ||
      hasForbiddenControlCharacter) {
    throw callableError(
        "invalid-argument",
        "REASON_INVALID",
        `Alasan koreksi harus ${MIN_REASON_LENGTH}-` +
          `${MAX_REASON_LENGTH} karakter.`,
    );
  }
  return reason;
}

function normalizeRequestedCheckOut(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw callableError(
        "invalid-argument",
        "CHECKOUT_TIME_INVALID",
        "Waktu check-out harus berupa timestamp UTC RFC3339.",
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) ||
      new Date(milliseconds).toISOString() !== value) {
    throw callableError(
        "invalid-argument",
        "CHECKOUT_TIME_INVALID",
        "Waktu check-out tidak valid.",
    );
  }
  return {iso: value, milliseconds};
}

function assertConfiguredDuration(configSnapshot, nowMs = Date.now()) {
  if (!configSnapshot?.exists) {
    throw callableError(
        "failed-precondition",
        "SHIFT_POLICY_INVALID",
        "Batas durasi shift belum dikonfigurasi.",
    );
  }
  const config = configSnapshot.data();
  const cutoverMs = timestampMillis(config.attendanceSecurityCutoverAt);
  if (!Number.isFinite(nowMs) ||
      config.attendanceSecurityVersion !== 2 ||
      config.geofenceTransitionMode !== false ||
      !Number.isFinite(cutoverMs) ||
      cutoverMs > nowMs) {
    throw callableError(
        "failed-precondition",
        "ATTENDANCE_SECURITY_POLICY_INACTIVE",
        "Kebijakan keamanan absensi v2 belum aktif secara canonical.",
    );
  }
  const minutes = config[MAX_SHIFT_DURATION_FIELD];
  if (!Number.isInteger(minutes) ||
      minutes < MIN_SHIFT_DURATION_MINUTES ||
      minutes > MAX_SHIFT_DURATION_MINUTES) {
    throw callableError(
        "failed-precondition",
        "SHIFT_POLICY_INVALID",
        "Batas durasi shift belum dikonfigurasi dengan aman.",
    );
  }
  return {
    minutes,
    updateTime: timestampIso(
        configSnapshot.updateTime,
        "SHIFT_POLICY_VERSION_INVALID",
    ),
  };
}

function hasNoCheckoutEvidence(attendance) {
  const emptyFields = [
    "checkOut",
    "checkOutTime",
    "checkOutDateWib",
    "checkOutLocation",
    "checkOutPhoto",
    "checkOutPhotoPath",
    "checkOutPhotoGeneration",
    "checkOutPhotoHash",
    "checkOutPhotoPerceptualHash",
    "checkOutPhotoPerceptualHashes",
    "checkOutPhotoMd5Hash",
    "checkOutPhotoCrc32c",
    "checkOutDistanceFromGeofence",
    "checkOutGeofenceSnapshot",
    "checkOutPresenceProof",
    "checkOutVerificationMode",
    "checkOutVerificationStatus",
    "checkOutTransitionMode",
    "checkOutIsWithinRadius",
    "checkOutDeviceVerified",
    "checkOutAssignmentSnapshot",
  ];
  return emptyFields.every((field) => attendance[field] == null) &&
    attendance.challengeIds?.checkOut == null &&
    attendance.workHours === 0;
}

function assertCanonicalVerifiedOpenAttendance(
    attendanceSnapshot,
    attendanceId,
    nowMs,
) {
  if (!attendanceSnapshot?.exists) {
    throw callableError(
        "not-found",
        "ATTENDANCE_NOT_FOUND",
        "Data absensi tidak ditemukan.",
    );
  }
  const attendance = attendanceSnapshot.data();
  const checkInMs = timestampMillis(attendance?.checkIn);
  const userId = attendance?.userId;
  const workDate = attendance?.date;
  const challengeId = attendance?.challengeIds?.checkIn;
  let challengeValid = false;
  try {
    core.assertChallengeId(challengeId);
    challengeValid = true;
  } catch (_) {
    challengeValid = false;
  }
  const expectedPhotoPath = challengeValid && validDocumentId(userId, 128) ?
    `attendanceProofs/${userId}/${challengeId}` : null;
  const perceptualHashesValid =
    Array.isArray(attendance?.checkInPhotoPerceptualHashes) &&
    attendance.checkInPhotoPerceptualHashes.length ===
      core.PERCEPTUAL_HASH_VIEW_COUNT &&
    attendance.checkInPhotoPerceptualHashes.every((hash) =>
      typeof hash === "string" && /^[0-9a-f]{36}$/i.test(hash));
  const presence = attendance?.presenceProof;
  const geofence = attendance?.geofenceSnapshot;
  const canonicalDate = Number.isFinite(checkInMs) ?
    core.getServerAttendanceStamp(new Date(checkInMs)).date : null;
  const location = attendance?.checkInLocation;
  const assignment = attendance?.assignmentSnapshot;
  const locationServerReceivedAtMs =
    timestampMillis(location?.serverReceivedAt);
  const locationPhotoValid =
    attendance?.verificationMode === "location_photo" &&
    attendance?.verificationStatus === "location_photo_only" &&
    attendance?.transitionMode === true &&
    attendance?.isWithinRadius === null &&
    attendance?.distanceFromGeofence === null &&
    attendance?.deviceVerified === false &&
    hasExactKeys(presence, ["required", "verified", "reason"]) &&
    presence.required === false &&
    presence?.verified === false &&
    presence?.reason === "policy_location_photo" &&
    geofence == null &&
    hasExactKeys(location, [
      "lat",
      "lng",
      "accuracy",
      "capturedAt",
      "source",
      "serverReceivedAt",
    ]) &&
    Number.isFinite(location.lat) &&
    location.lat >= -90 && location.lat <= 90 &&
    Number.isFinite(location.lng) &&
    location.lng >= -180 && location.lng <= 180 &&
    !(location.lat === 0 && location.lng === 0) &&
    Number.isFinite(location.accuracy) &&
    location.accuracy > 0 &&
    location.accuracy <= core.MAX_LOCATION_ACCURACY_METERS &&
    Number.isInteger(location.capturedAt) &&
    locationServerReceivedAtMs === checkInMs &&
    location.capturedAt >= locationServerReceivedAtMs - 2 * 60 * 1000 &&
    location.capturedAt <= locationServerReceivedAtMs + 10 * 1000 &&
    new Set(["gps-high", "gps-low"]).has(location.source) &&
    hasExactKeys(assignment, ["collection", "id", "name"]) &&
    new Set(["kelurahan", "kantor"]).has(assignment.collection) &&
    validDocumentId(assignment.id, 180) &&
    typeof assignment.name === "string" &&
    assignment.name.trim() === assignment.name &&
    assignment.name.length >= 1 &&
    assignment.name.length <= 200;
  const verifiedGeofenceValid =
    attendance?.verificationStatus === "verified" &&
    attendance?.transitionMode === false &&
    attendance?.isWithinRadius === true &&
    presence?.required === true &&
    presence?.verified === true &&
    presence?.coPresence?.verified === true &&
    presence?.grantId === challengeId &&
    typeof geofence?.verificationAuditId === "string" &&
    Boolean(geofence.verificationAuditId) &&
    typeof geofence?.verificationOperator === "string" &&
    /^[0-9a-f]{64}$/i.test(geofence.verificationOperator) &&
    typeof geofence?.verificationReviewOperator === "string" &&
    /^[0-9a-f]{64}$/i.test(geofence.verificationReviewOperator) &&
    geofence.verificationOperator !==
      geofence.verificationReviewOperator;

  if (!attendance || !validDocumentId(userId, 128) ||
      !validWorkDate(workDate) ||
      attendanceId !== `${userId}_${workDate}` ||
      canonicalDate !== workDate ||
      attendance.integrityVersion !== 2 ||
      attendance.proofVersion !== 2 ||
      !Number.isFinite(checkInMs) || checkInMs > nowMs ||
      !challengeValid ||
      attendance.checkInPhotoPath !== expectedPhotoPath ||
      typeof attendance.checkInPhotoGeneration !== "string" ||
      !/^\d+$/.test(attendance.checkInPhotoGeneration) ||
      typeof attendance.checkInPhotoHash !== "string" ||
      !/^[0-9a-f]{64}$/i.test(attendance.checkInPhotoHash) ||
      typeof attendance.checkInPhotoPerceptualHash !== "string" ||
      !/^[0-9a-f]{36}$/i.test(attendance.checkInPhotoPerceptualHash) ||
      !perceptualHashesValid ||
      (!verifiedGeofenceValid && !locationPhotoValid) ||
      !hasNoCheckoutEvidence(attendance)) {
    throw callableError(
        "failed-precondition",
        "ATTENDANCE_NOT_ELIGIBLE",
        "Absensi bukan check-in v2 yang memenuhi kebijakan dan masih terbuka.",
    );
  }

  return {
    attendance,
    attendanceId,
    attendanceUpdateTime: timestampIso(
        attendanceSnapshot.updateTime,
        "ATTENDANCE_VERSION_INVALID",
    ),
    checkInMs,
    challengeId,
    userId,
    workDate,
  };
}

function assertOpenShift(openShiftSnapshot, attendanceSource) {
  if (!openShiftSnapshot?.exists) {
    throw callableError(
        "failed-precondition",
        "OPEN_SHIFT_CHANGED",
        "Pointer shift aktif tidak ditemukan.",
    );
  }
  const shift = openShiftSnapshot.data();
  const checkInMs = timestampMillis(shift?.checkInAt);
  if (!shift ||
      shift.schemaVersion !== 1 ||
      shift.uid !== attendanceSource.userId ||
      !Number.isInteger(shift.revision) ||
      shift.revision < 1 ||
      shift.status !== "open" ||
      shift.attendanceId !== attendanceSource.attendanceId ||
      shift.workDate !== attendanceSource.workDate ||
      checkInMs !== attendanceSource.checkInMs ||
      shift.closedAt != null ||
      !Number.isFinite(timestampMillis(shift.createdAt)) ||
      !Number.isFinite(timestampMillis(shift.updatedAt))) {
    throw callableError(
        "failed-precondition",
        "OPEN_SHIFT_CHANGED",
        "Pointer shift aktif tidak cocok dengan absensi.",
    );
  }
  return {
    shift,
    revision: shift.revision,
    updateTime: timestampIso(
        openShiftSnapshot.updateTime,
        "OPEN_SHIFT_VERSION_INVALID",
    ),
  };
}

function assertCheckOutWithinPolicy(
    checkInMs,
    checkOutMs,
    nowMs,
    maximumMinutes,
) {
  const durationMs = maximumMinutes * 60 * 1000;
  if (!Number.isFinite(checkInMs) || !Number.isFinite(checkOutMs) ||
      !Number.isFinite(nowMs) ||
      checkOutMs <= checkInMs ||
      checkOutMs > nowMs ||
      checkOutMs - checkInMs > durationMs) {
    throw callableError(
        "failed-precondition",
        "CHECKOUT_TIME_OUT_OF_RANGE",
        "Waktu check-out harus sesudah check-in, tidak di masa depan, " +
          "dan masih dalam batas durasi shift.",
    );
  }
  return Math.round(((checkOutMs - checkInMs) / 3600000) * 100) / 100;
}

function attendanceFingerprintFields(source) {
  const attendance = source.attendance;
  if (attendance.verificationMode === "location_photo") {
    return {
      attendanceId: source.attendanceId,
      userId: source.userId,
      workDate: source.workDate,
      checkInMs: source.checkInMs,
      status: attendance.status ?? null,
      integrityVersion: attendance.integrityVersion,
      proofVersion: attendance.proofVersion,
      verificationMode: attendance.verificationMode,
      verificationStatus: attendance.verificationStatus,
      transitionMode: attendance.transitionMode,
      isWithinRadius: attendance.isWithinRadius,
      deviceVerified: attendance.deviceVerified,
      checkInChallengeId: source.challengeId,
      checkInPhotoPath: attendance.checkInPhotoPath,
      checkInPhotoGeneration: attendance.checkInPhotoGeneration,
      checkInPhotoHash: attendance.checkInPhotoHash,
      checkInPhotoPerceptualHash: attendance.checkInPhotoPerceptualHash,
      checkInPhotoPerceptualHashes:
        attendance.checkInPhotoPerceptualHashes,
      presenceReason: attendance.presenceProof.reason,
      assignmentCollection: attendance.assignmentSnapshot.collection,
      assignmentId: attendance.assignmentSnapshot.id,
      assignmentName: attendance.assignmentSnapshot.name,
      checkInLocation: {
        lat: attendance.checkInLocation.lat,
        lng: attendance.checkInLocation.lng,
        accuracy: attendance.checkInLocation.accuracy,
        capturedAt: attendance.checkInLocation.capturedAt,
        source: attendance.checkInLocation.source,
        serverReceivedAtMs:
          timestampMillis(attendance.checkInLocation.serverReceivedAt),
      },
      workHours: attendance.workHours,
      attendanceUpdateTime: source.attendanceUpdateTime,
    };
  }
  return {
    attendanceId: source.attendanceId,
    userId: source.userId,
    workDate: source.workDate,
    checkInMs: source.checkInMs,
    status: attendance.status ?? null,
    integrityVersion: attendance.integrityVersion,
    proofVersion: attendance.proofVersion,
    verificationStatus: attendance.verificationStatus,
    transitionMode: attendance.transitionMode,
    isWithinRadius: attendance.isWithinRadius,
    checkInChallengeId: source.challengeId,
    checkInPhotoPath: attendance.checkInPhotoPath,
    checkInPhotoGeneration: attendance.checkInPhotoGeneration,
    checkInPhotoHash: attendance.checkInPhotoHash,
    checkInPhotoPerceptualHash: attendance.checkInPhotoPerceptualHash,
    checkInPhotoPerceptualHashes:
      attendance.checkInPhotoPerceptualHashes,
    presenceGrantId: attendance.presenceProof.grantId,
    geofenceAuditId: attendance.geofenceSnapshot.verificationAuditId,
    geofenceOperator: attendance.geofenceSnapshot.verificationOperator,
    geofenceReviewOperator:
      attendance.geofenceSnapshot.verificationReviewOperator,
    workHours: attendance.workHours,
    attendanceUpdateTime: source.attendanceUpdateTime,
  };
}

function calculateBaseFingerprint(
    attendanceSource,
    openShiftSource,
    policy,
) {
  return hashObject("attendance-correction-base-v1", {
    attendance: attendanceFingerprintFields(attendanceSource),
    openShift: {
      schemaVersion: openShiftSource.shift.schemaVersion,
      uid: openShiftSource.shift.uid,
      revision: openShiftSource.revision,
      status: openShiftSource.shift.status,
      attendanceId: openShiftSource.shift.attendanceId,
      workDate: openShiftSource.shift.workDate,
      checkInAtMs: timestampMillis(openShiftSource.shift.checkInAt),
      closedAt: null,
      updateTime: openShiftSource.updateTime,
    },
    policy: {
      maximumMinutes: policy.minutes,
      updateTime: policy.updateTime,
    },
  });
}

function proposalFingerprintFields(proposal) {
  return {
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
    proposedAtMs: timestampMillis(proposal.proposedAt),
    expiresAtMs: timestampMillis(proposal.expiresAt),
  };
}

function calculateProposalFingerprint(proposal) {
  return hashObject(
      "attendance-correction-proposal-v1",
      proposalFingerprintFields(proposal),
  );
}

function assertExactProposal(proposal, proposalId, nowMs) {
  if (!proposal || typeof proposal !== "object" ||
      Array.isArray(proposal) ||
      Object.keys(proposal).length !== PROPOSAL_FIELDS.size ||
      Object.keys(proposal).some((key) => !PROPOSAL_FIELDS.has(key))) {
    throw callableError(
        "failed-precondition",
        "PROPOSAL_STATE_INVALID",
        "Struktur proposal koreksi tidak valid.",
    );
  }
  const proposedAtMs = timestampMillis(proposal.proposedAt);
  const expiresAtMs = timestampMillis(proposal.expiresAt);
  const requestedCheckOutMs = timestampMillis(proposal.requestedCheckOut);
  let normalizedReason;
  try {
    normalizedReason = normalizeReason(proposal.reason);
  } catch (_) {
    normalizedReason = null;
  }
  if (proposal.schemaVersion !== SCHEMA_VERSION ||
      proposal.action !== "attendance_missing_checkout_correction" ||
      proposal.proposalId !== proposalId ||
      !validProposalId(proposalId) ||
      proposal.status !== "pending" ||
      proposal.correctionType !== "missing_checkout" ||
      !validDocumentId(proposal.attendanceId) ||
      !validDocumentId(proposal.userId, 128) ||
      !validWorkDate(proposal.workDate) ||
      proposal.attendanceId !==
        `${proposal.userId}_${proposal.workDate}` ||
      typeof proposal.requestedCheckOutIso !== "string" ||
      Date.parse(proposal.requestedCheckOutIso) !== requestedCheckOutMs ||
      new Date(requestedCheckOutMs).toISOString() !==
        proposal.requestedCheckOutIso ||
      normalizedReason !== proposal.reason ||
      !Number.isInteger(proposal.baseRevision) ||
      proposal.baseRevision < 1 ||
      typeof proposal.baseFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(proposal.baseFingerprint) ||
      typeof proposal.attendanceUpdateTime !== "string" ||
      !Number.isFinite(Date.parse(proposal.attendanceUpdateTime)) ||
      typeof proposal.openShiftUpdateTime !== "string" ||
      !Number.isFinite(Date.parse(proposal.openShiftUpdateTime)) ||
      typeof proposal.configUpdateTime !== "string" ||
      !Number.isFinite(Date.parse(proposal.configUpdateTime)) ||
      !Number.isInteger(proposal.maxShiftDurationMinutes) ||
      proposal.maxShiftDurationMinutes < MIN_SHIFT_DURATION_MINUTES ||
      proposal.maxShiftDurationMinutes > MAX_SHIFT_DURATION_MINUTES ||
      proposal.source !== CORRECTION_SOURCE ||
      proposal.manualCorrection !== true ||
      proposal.deviceVerified !== false ||
      !validDocumentId(proposal.proposerUid, 128) ||
      proposal.proposerAccountFingerprint !==
        accountFingerprint(proposal.proposerUid) ||
      !Number.isFinite(proposedAtMs) ||
      proposedAtMs > nowMs ||
      expiresAtMs !== proposedAtMs + PROPOSAL_TTL_MS ||
      typeof proposal.proposalFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(proposal.proposalFingerprint) ||
      calculateProposalFingerprint(proposal) !==
        proposal.proposalFingerprint) {
    throw callableError(
        "failed-precondition",
        "PROPOSAL_STATE_INVALID",
        "Proposal koreksi gagal diverifikasi.",
    );
  }
  return {
    expiresAtMs,
    proposedAtMs,
    requestedCheckOutMs,
  };
}

function logSecurityEvent(outcome, context, result, error) {
  const decision = result?.decision || context.decision;
  const event = {
    schemaVersion: 1,
    event: "attendance_correction_security_event",
    operation: context.operation,
    outcome,
    actorFingerprint: securityFingerprint(context.uid),
    appId: context.appId,
    proposalFingerprint: securityFingerprint(
        result?.proposalId || context.proposalId,
    ),
    attendanceFingerprint: securityFingerprint(
        result?.attendanceId || context.attendanceId,
    ),
    decision: ALLOWED_DECISIONS.has(decision) ? decision : undefined,
    reason: error?.details?.reason || error?.code,
  };
  Object.keys(event).forEach((key) => {
    if (event[key] == null || event[key] === "") delete event[key];
  });
  if (outcome === "success") {
    logger.info("Attendance correction security event", event);
  } else {
    logger.warn("Attendance correction security event", event);
  }
}

function mapError(error) {
  if (error instanceof HttpsError) return error;
  return callableError(
      "internal",
      "INTERNAL_ERROR",
      "Koreksi absensi gagal diproses.",
  );
}

async function run(operation, context) {
  try {
    const result = await operation();
    logSecurityEvent("success", context, result, null);
    return result;
  } catch (error) {
    const mapped = mapError(error);
    if (!(error instanceof HttpsError)) {
      logger.error("Attendance correction operation failed", {
        operation: context.operation,
        actorFingerprint: securityFingerprint(context.uid),
        errorType: error?.constructor?.name || "UnknownError",
      });
    }
    logSecurityEvent(
        mapped.code === "internal" ? "error" : "denied",
        context,
        null,
        mapped,
    );
    throw mapped;
  }
}

function assertSourceStillCurrent(
    attendanceSnapshot,
    openShiftSnapshot,
    configSnapshot,
    proposal,
    nowMs,
) {
  if (!attendanceSnapshot?.exists ||
      timestampIso(attendanceSnapshot.updateTime) !==
        proposal.attendanceUpdateTime) {
    throw callableError(
        "failed-precondition",
        "ATTENDANCE_CHANGED",
        "Absensi berubah setelah proposal dibuat.",
    );
  }
  const attendanceSource = assertCanonicalVerifiedOpenAttendance(
      attendanceSnapshot,
      proposal.attendanceId,
      nowMs,
  );
  const openShiftSource = assertOpenShift(
      openShiftSnapshot,
      attendanceSource,
  );
  if (openShiftSource.revision !== proposal.baseRevision ||
      openShiftSource.updateTime !== proposal.openShiftUpdateTime) {
    throw callableError(
        "failed-precondition",
        "OPEN_SHIFT_CHANGED",
        "Pointer shift berubah setelah proposal dibuat.",
    );
  }
  const policy = assertConfiguredDuration(configSnapshot, nowMs);
  if (policy.minutes !== proposal.maxShiftDurationMinutes ||
      policy.updateTime !== proposal.configUpdateTime) {
    throw callableError(
        "failed-precondition",
        "CORRECTION_POLICY_CHANGED",
        "Kebijakan durasi shift berubah setelah proposal dibuat.",
    );
  }
  const baseFingerprint = calculateBaseFingerprint(
      attendanceSource,
      openShiftSource,
      policy,
  );
  if (baseFingerprint !== proposal.baseFingerprint) {
    throw callableError(
        "failed-precondition",
        "CORRECTION_BASE_CHANGED",
        "Fingerprint sumber koreksi telah berubah.",
    );
  }
  const effectiveWorkHours = assertCheckOutWithinPolicy(
      attendanceSource.checkInMs,
      timestampMillis(proposal.requestedCheckOut),
      nowMs,
      policy.minutes,
  );
  return {
    attendanceSource,
    effectiveWorkHours,
    openShiftSource,
    policy,
  };
}

function createAttendanceCorrectionHandlers(admin) {
  const db = admin.firestore();
  const Timestamp = admin.firestore.Timestamp;

  async function proposeMissingCheckoutCorrection(request) {
    const context = {
      operation: "proposeMissingCheckoutCorrection",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      attendanceId: request.data?.attendanceId,
    };
    return run(async () => {
      const proposerUid = assertRequest(request, [
        "attendanceId",
        "checkOutAt",
        "reason",
      ]);
      context.uid = proposerUid;
      const attendanceId = request.data.attendanceId;
      if (!validDocumentId(attendanceId)) {
        throw callableError(
            "invalid-argument",
            "ATTENDANCE_ID_INVALID",
            "ID absensi tidak valid.",
        );
      }
      context.attendanceId = attendanceId;
      const requestedCheckOut = normalizeRequestedCheckOut(
          request.data.checkOutAt,
      );
      const reason = normalizeReason(request.data.reason);
      const nowMs = Date.now();
      const now = Timestamp.fromMillis(nowMs);
      const expiresAt = Timestamp.fromMillis(nowMs + PROPOSAL_TTL_MS);
      const proposalId = crypto.randomUUID();
      const adminRef = db.collection("users").doc(proposerUid);
      const attendanceRef = db.collection("attendances").doc(attendanceId);
      const configRef = db.collection(CONFIG_COLLECTION).doc(CONFIG_DOCUMENT);
      const proposalRef = db.collection(PROPOSAL_COLLECTION).doc(proposalId);

      const result = await db.runTransaction(async (transaction) => {
        const [adminSnapshot, attendanceSnapshot, configSnapshot] =
          await Promise.all([
            transaction.get(adminRef),
            transaction.get(attendanceRef),
            transaction.get(configRef),
          ]);
        assertActiveAdmin(adminSnapshot);
        const attendanceSource = assertCanonicalVerifiedOpenAttendance(
            attendanceSnapshot,
            attendanceId,
            nowMs,
        );
        const openShiftRef = db.collection(OPEN_SHIFT_COLLECTION)
            .doc(attendanceSource.userId);
        const effectiveRef = db.collection(EFFECTIVE_COLLECTION)
            .doc(attendanceId);
        const [openShiftSnapshot, effectiveSnapshot] = await Promise.all([
          transaction.get(openShiftRef),
          transaction.get(effectiveRef),
        ]);
        if (effectiveSnapshot.exists) {
          throw callableError(
              "already-exists",
              "ATTENDANCE_ALREADY_CORRECTED",
              "Absensi sudah memiliki koreksi yang disetujui.",
          );
        }
        const policy = assertConfiguredDuration(configSnapshot, nowMs);
        const openShiftSource = assertOpenShift(
            openShiftSnapshot,
            attendanceSource,
        );
        const effectiveWorkHours = assertCheckOutWithinPolicy(
            attendanceSource.checkInMs,
            requestedCheckOut.milliseconds,
            nowMs,
            policy.minutes,
        );
        const proposal = {
          schemaVersion: SCHEMA_VERSION,
          action: "attendance_missing_checkout_correction",
          proposalId,
          status: "pending",
          correctionType: "missing_checkout",
          attendanceId,
          userId: attendanceSource.userId,
          workDate: attendanceSource.workDate,
          requestedCheckOut:
            Timestamp.fromMillis(requestedCheckOut.milliseconds),
          requestedCheckOutIso: requestedCheckOut.iso,
          reason,
          baseRevision: openShiftSource.revision,
          baseFingerprint: calculateBaseFingerprint(
              attendanceSource,
              openShiftSource,
              policy,
          ),
          attendanceUpdateTime: attendanceSource.attendanceUpdateTime,
          openShiftUpdateTime: openShiftSource.updateTime,
          configUpdateTime: policy.updateTime,
          maxShiftDurationMinutes: policy.minutes,
          source: CORRECTION_SOURCE,
          manualCorrection: true,
          deviceVerified: false,
          proposerUid,
          proposerAccountFingerprint: accountFingerprint(proposerUid),
          proposedAt: now,
          expiresAt,
        };
        proposal.proposalFingerprint =
          calculateProposalFingerprint(proposal);
        transaction.create(proposalRef, proposal);
        return {
          effectiveWorkHours,
          userId: attendanceSource.userId,
        };
      });

      return {
        success: true,
        proposalId,
        attendanceId,
        status: "pending",
        correctionType: "missing_checkout",
        checkOutAt: requestedCheckOut.iso,
        effectiveWorkHours: result.effectiveWorkHours,
        deviceVerified: false,
        expiresAt: new Date(nowMs + PROPOSAL_TTL_MS).toISOString(),
      };
    }, context);
  }

  async function reviewAttendanceCorrection(request) {
    const context = {
      operation: "reviewAttendanceCorrection",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      proposalId: request.data?.proposalId,
      decision: request.data?.decision,
    };
    return run(async () => {
      const reviewerUid = assertRequest(request, [
        "proposalId",
        "decision",
      ]);
      context.uid = reviewerUid;
      const {proposalId, decision} = request.data;
      if (!validProposalId(proposalId) ||
          !ALLOWED_DECISIONS.has(decision)) {
        throw callableError(
            "invalid-argument",
            "INVALID_REVIEW_REQUEST",
            "ID proposal atau keputusan review tidak valid.",
        );
      }
      context.proposalId = proposalId;
      context.decision = decision;
      const nowMs = Date.now();
      const now = Timestamp.fromMillis(nowMs);
      const proposalRef = db.collection(PROPOSAL_COLLECTION).doc(proposalId);
      const decisionRef = db.collection(DECISION_COLLECTION).doc(proposalId);
      const eventRef = db.collection(EVENT_COLLECTION).doc(proposalId);
      const reviewerRef = db.collection("users").doc(reviewerUid);

      const result = await db.runTransaction(async (transaction) => {
        const [proposalSnapshot, decisionSnapshot, reviewerSnapshot] =
          await Promise.all([
            transaction.get(proposalRef),
            transaction.get(decisionRef),
            transaction.get(reviewerRef),
          ]);
        if (!proposalSnapshot.exists) {
          throw callableError(
              "not-found",
              "PROPOSAL_NOT_FOUND",
              "Proposal koreksi tidak ditemukan.",
          );
        }
        if (decisionSnapshot.exists) {
          throw callableError(
              "failed-precondition",
              "PROPOSAL_ALREADY_REVIEWED",
              "Proposal koreksi sudah pernah direview.",
          );
        }
        const proposal = proposalSnapshot.data();
        const checked = assertExactProposal(proposal, proposalId, nowMs);
        context.attendanceId = proposal.attendanceId;
        assertIndependentReviewer(proposal.proposerUid, reviewerUid);
        assertActiveAdmin(reviewerSnapshot);

        const attendanceRef = db.collection("attendances")
            .doc(proposal.attendanceId);
        const openShiftRef = db.collection(OPEN_SHIFT_COLLECTION)
            .doc(proposal.userId);
        const configRef = db.collection(CONFIG_COLLECTION).doc(CONFIG_DOCUMENT);
        const proposerRef = db.collection("users").doc(proposal.proposerUid);
        const effectiveRef = db.collection(EFFECTIVE_COLLECTION)
            .doc(proposal.attendanceId);
        const [attendanceSnapshot, openShiftSnapshot, configSnapshot,
          proposerSnapshot, effectiveSnapshot, eventSnapshot] =
          await Promise.all([
            transaction.get(attendanceRef),
            transaction.get(openShiftRef),
            transaction.get(configRef),
            transaction.get(proposerRef),
            transaction.get(effectiveRef),
            transaction.get(eventRef),
          ]);

        if (decision === "approve") {
          assertActiveAdmin(proposerSnapshot);
          if (checked.expiresAtMs <= nowMs) {
            throw callableError(
                "deadline-exceeded",
                "PROPOSAL_EXPIRED",
                "Proposal koreksi sudah kedaluwarsa.",
            );
          }
          if (effectiveSnapshot.exists || eventSnapshot.exists) {
            throw callableError(
                "already-exists",
                "ATTENDANCE_ALREADY_CORRECTED",
                "Absensi sudah memiliki koreksi yang disetujui.",
            );
          }
        }

        let approvedState = null;
        if (decision === "approve") {
          approvedState = assertSourceStillCurrent(
              attendanceSnapshot,
              openShiftSnapshot,
              configSnapshot,
              proposal,
              nowMs,
          );
        }
        const status = decision === "approve" ? "approved" : "rejected";
        const reviewerAccountFingerprint =
          accountFingerprint(reviewerUid);
        const decisionDocument = {
          schemaVersion: SCHEMA_VERSION,
          action: "attendance_missing_checkout_correction_review",
          decisionId: proposalId,
          proposalId,
          proposalFingerprint: proposal.proposalFingerprint,
          attendanceId: proposal.attendanceId,
          userId: proposal.userId,
          workDate: proposal.workDate,
          correctionType: proposal.correctionType,
          decision,
          status,
          source: CORRECTION_SOURCE,
          manualCorrection: true,
          deviceVerified: false,
          proposerUid: proposal.proposerUid,
          proposerAccountFingerprint:
            proposal.proposerAccountFingerprint,
          reviewerUid,
          reviewerAccountFingerprint,
          correctionEventId: decision === "approve" ? proposalId : null,
          effectiveProjectionId:
            decision === "approve" ? proposal.attendanceId : null,
          reviewedAt: now,
        };
        transaction.create(decisionRef, decisionDocument);

        if (decision === "approve") {
          const correctionEvent = {
            schemaVersion: SCHEMA_VERSION,
            action: "attendance_missing_checkout_corrected",
            eventId: proposalId,
            proposalId,
            decisionId: proposalId,
            attendanceId: proposal.attendanceId,
            userId: proposal.userId,
            workDate: proposal.workDate,
            correctionType: proposal.correctionType,
            revision: 1,
            baseRevision: proposal.baseRevision,
            baseShiftRevision: proposal.baseRevision,
            baseFingerprint: proposal.baseFingerprint,
            attendanceUpdateTime: proposal.attendanceUpdateTime,
            openShiftUpdateTime: proposal.openShiftUpdateTime,
            configUpdateTime: proposal.configUpdateTime,
            maxShiftDurationMinutes:
              proposal.maxShiftDurationMinutes,
            originalCheckIn:
              approvedState.attendanceSource.attendance.checkIn,
            effectiveCheckOut: proposal.requestedCheckOut,
            effectiveWorkHours: approvedState.effectiveWorkHours,
            reason: proposal.reason,
            source: CORRECTION_SOURCE,
            manualCorrection: true,
            deviceVerified: false,
            canonicalAttendanceChanged: false,
            proposerUid: proposal.proposerUid,
            proposerAccountFingerprint:
              proposal.proposerAccountFingerprint,
            reviewerUid,
            reviewerAccountFingerprint,
            proposedAt: proposal.proposedAt,
            approvedAt: now,
          };
          const effectiveProjection = {
            schemaVersion: SCHEMA_VERSION,
            attendanceId: proposal.attendanceId,
            userId: proposal.userId,
            workDate: proposal.workDate,
            correctionType: proposal.correctionType,
            revision: 1,
            baseShiftRevision: proposal.baseRevision,
            proposalId,
            correctionEventId: proposalId,
            originalCheckIn:
              approvedState.attendanceSource.attendance.checkIn,
            effectiveCheckOut: proposal.requestedCheckOut,
            effectiveWorkHours: approvedState.effectiveWorkHours,
            completionSource: CORRECTION_SOURCE,
            manualCorrection: true,
            deviceVerified: false,
            canonicalAttendanceChanged: false,
            approvedAt: now,
          };
          transaction.create(eventRef, correctionEvent);
          transaction.create(effectiveRef, effectiveProjection);
          transaction.update(openShiftRef, {
            status: "closed",
            closedAt: proposal.requestedCheckOut,
            updatedAt: now,
            closureSource: "administrative-correction",
            correctionId: proposalId,
          });
        }

        return {
          attendanceId: proposal.attendanceId,
          decision,
          status,
          effectiveWorkHours: approvedState?.effectiveWorkHours,
        };
      });

      return {
        success: true,
        proposalId,
        attendanceId: result.attendanceId,
        decision,
        status: result.status,
        correctionEventId: decision === "approve" ? proposalId : null,
        effectiveProjectionId:
          decision === "approve" ? result.attendanceId : null,
        effectiveWorkHours: result.effectiveWorkHours ?? null,
        deviceVerified: false,
        canonicalAttendanceChanged: false,
      };
    }, context);
  }

  return {
    proposeMissingCheckoutCorrection,
    reviewAttendanceCorrection,
  };
}

module.exports = {
  CORRECTION_SOURCE,
  EFFECTIVE_COLLECTION,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  PROPOSAL_TTL_MS,
  accountFingerprint,
  assertCanonicalVerifiedOpenAttendance,
  assertCheckOutWithinPolicy,
  assertExactProposal,
  assertIndependentReviewer,
  calculateBaseFingerprint,
  calculateProposalFingerprint,
  createAttendanceCorrectionHandlers,
  normalizeReason,
  normalizeRequestedCheckOut,
};
