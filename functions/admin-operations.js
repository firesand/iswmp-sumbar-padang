"use strict";

const crypto = require("node:crypto");
const {HttpsError} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const core = require("./attendance-core");

function callableError(code, reason, message) {
  return new HttpsError(code, message, {reason});
}

function assertRequest(request, keys) {
  if (!request.auth || !request.auth.uid) {
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
        "Perangkat admin tidak dapat diverifikasi.",
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
      Object.keys(request.data).some((key) => !keys.includes(key))) {
    throw callableError(
        "invalid-argument",
        "INVALID_REQUEST",
        "Payload permintaan tidak valid.",
    );
  }
  return request.auth.uid;
}

function assertActiveAdmin(snapshot) {
  if (!snapshot.exists) {
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
        "Hanya admin aktif yang dapat melakukan operasi ini.",
    );
  }
  return user;
}

function validDocumentId(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function timestampMillis(value) {
  return value && typeof value.toMillis === "function" ?
    value.toMillis() : NaN;
}

function presenceCodeContext(assignment, uid, challengeId) {
  return [assignment.collection, assignment.id, uid, challengeId].join(":");
}

function securityFingerprint(value) {
  if (typeof value !== "string" || !value) return undefined;
  return crypto.createHash("sha256")
      .update("attendance-admin-log-v1\u0000")
      .update(value)
      .digest("hex")
      .slice(0, 20);
}

function logSecurityEvent(outcome, context, result, error) {
  const event = {
    schemaVersion: 1,
    event: "attendance_admin_security_event",
    operation: context.operation,
    outcome,
    actorFingerprint: securityFingerprint(context.uid),
    appId: context.appId,
    challengeFingerprint: securityFingerprint(
        result?.challengeId || context.challengeId,
    ),
    employeeFingerprint: securityFingerprint(
        result?.employee?.uid || result?.targetUserId || context.employeeUid,
    ),
    geofenceFingerprint: securityFingerprint(
        result?.geofence?.id || context.geofenceId,
    ),
    reason: error?.details?.reason || error?.code,
  };
  Object.keys(event).forEach((key) => {
    if (event[key] == null || event[key] === "") delete event[key];
  });
  if (outcome === "success") {
    logger.info("Attendance admin security event", event);
  } else {
    logger.warn("Attendance admin security event", event);
  }
}

function mapUnexpected(error) {
  if (error instanceof HttpsError) return error;
  if (error instanceof core.AttendanceInputError) {
    const invalidLocationReasons = new Set([
      "INVALID_LOCATION",
      "LOCATION_ACCURACY",
      "LOCATION_STALE",
      "INVALID_LOCATION_SOURCE",
    ]);
    return callableError(
        invalidLocationReasons.has(error.reason) ?
          "invalid-argument" : "failed-precondition",
        error.reason,
        error.message,
    );
  }
  return callableError(
      "internal",
      "INTERNAL_ERROR",
      "Operasi admin gagal diproses.",
  );
}

async function run(operation, context) {
  try {
    const result = await operation();
    logSecurityEvent("success", context, result, null);
    return result;
  } catch (error) {
    const mapped = mapUnexpected(error);
    if (!(error instanceof HttpsError) &&
        !(error instanceof core.AttendanceInputError)) {
      logger.error("Admin security operation failed", {
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

function generateTemporaryPassword() {
  return `${crypto.randomBytes(18).toString("base64url")}aA1!`;
}

function assertVerifierLocation(rawLocation, nowMs, geofence) {
  const location = core.normalizeLocation(rawLocation, nowMs);
  const distance = core.calculateDistanceMeters(
      location.lat,
      location.lng,
      geofence.lat,
      geofence.lng,
  );
  const uncertaintyAdjustedDistance = distance + location.accuracy;
  if (!Number.isFinite(distance) ||
      !Number.isFinite(uncertaintyAdjustedDistance) ||
      uncertaintyAdjustedDistance > geofence.radius) {
    throw callableError(
        "failed-precondition",
        "VERIFIER_OUTSIDE_GEOFENCE",
        Number.isFinite(distance) ?
          `Perangkat admin berada ${Math.round(distance)} meter dari ` +
            `geofence dengan akurasi ${Math.round(location.accuracy)} ` +
            `meter; batasnya ${geofence.radius} meter.` :
          "Jarak perangkat admin terhadap geofence tidak valid.",
    );
  }
  return {
    location,
    distanceMeters: Math.round(distance),
    uncertaintyAdjustedDistanceMeters:
      Math.round(uncertaintyAdjustedDistance),
  };
}

function assertStrongPassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128 ||
      /\s/.test(value) || !/[a-z]/.test(value) || !/[A-Z]/.test(value) ||
      !/[0-9]/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    throw callableError(
        "invalid-argument",
        "WEAK_PASSWORD",
        "Password baru minimal 12 karakter dan harus memuat huruf besar, " +
        "huruf kecil, angka, serta simbol tanpa spasi.",
    );
  }
  return value;
}

function bearerIdToken(request) {
  const header = request.rawRequest?.headers?.authorization;
  const match = typeof header === "string" ?
    header.match(/^Bearer ([A-Za-z0-9._-]+)$/) : null;
  if (!match) {
    throw callableError(
        "unauthenticated",
        "RECENT_LOGIN_REQUIRED",
        "Login ulang dengan password sementara diperlukan.",
    );
  }
  return match[1];
}

async function assertRecentUnrevokedAuth(admin, request, uid,
    passwordResetAtMs, nowMs) {
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(
        bearerIdToken(request),
        true,
    );
  } catch (_) {
    throw callableError(
        "unauthenticated",
        "RECENT_LOGIN_REQUIRED",
        "Sesi harus diautentikasi ulang dengan password sementara.",
    );
  }
  const authTimeSeconds = Number(decoded.auth_time);
  const resetSeconds = Math.floor(passwordResetAtMs / 1000);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (decoded.uid !== uid || !Number.isInteger(authTimeSeconds) ||
      authTimeSeconds < resetSeconds ||
      authTimeSeconds < nowSeconds - 5 * 60 ||
      authTimeSeconds > nowSeconds + 30) {
    throw callableError(
        "unauthenticated",
        "RECENT_LOGIN_REQUIRED",
        "Login ulang dengan password sementara diperlukan.",
    );
  }
  return decoded;
}

function createAdminHandlers(admin) {
  const db = admin.firestore();
  const Timestamp = admin.firestore.Timestamp;
  const FieldValue = admin.firestore.FieldValue;

  async function getOnsitePresenceCode(request) {
    const context = {
      operation: "getOnsitePresenceCode",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      employeeUid: request.data?.employeeUid,
      geofenceId: request.data?.geofenceType && request.data?.geofenceId ?
        `${request.data.geofenceType}/${request.data.geofenceId}` : undefined,
    };
    return run(async () => {
      const uid = assertRequest(
          request,
          ["geofenceType", "geofenceId", "employeeUid", "location"],
      );
      context.uid = uid;
      const {geofenceType, geofenceId, employeeUid} = request.data;
      if (!new Set(["kelurahan", "kantor"]).has(geofenceType) ||
          !validDocumentId(geofenceId) || !validDocumentId(employeeUid)) {
        throw callableError(
            "invalid-argument",
            "INVALID_GEOFENCE",
            "Identitas geofence tidak valid.",
        );
      }
      const adminRef = db.collection("users").doc(uid);
      const employeeRef = db.collection("users").doc(employeeUid);
      const geofenceRef = db.collection(geofenceType).doc(geofenceId);
      const secretRef = db.collection("geofencePresenceSecrets")
          .doc(`${geofenceType}_${geofenceId}`);
      const generatedSecret = crypto.randomBytes(32).toString("base64");
      const nowMs = Date.now();
      const now = Timestamp.fromMillis(nowMs);
      const counter = core.presenceCounter(nowMs);
      const displayExpiresAtMs = (counter + 1) *
        core.PRESENCE_CODE_PERIOD_SECONDS * 1000;
      const grantExpiresAt = Timestamp.fromMillis(
          (counter + 2) * core.PRESENCE_CODE_PERIOD_SECONDS * 1000,
      );

      const result = await db.runTransaction(async (transaction) => {
        const checkInLockRef = db.collection("attendanceChallengeLocks")
            .doc(`${employeeUid}_checkIn`);
        const checkOutLockRef = db.collection("attendanceChallengeLocks")
            .doc(`${employeeUid}_checkOut`);
        const [adminSnapshot, employeeSnapshot, geofenceSnapshot,
          secretSnapshot, checkInLockSnapshot, checkOutLockSnapshot] =
          await Promise.all([
            transaction.get(adminRef),
            transaction.get(employeeRef),
            transaction.get(geofenceRef),
            transaction.get(secretRef),
            transaction.get(checkInLockRef),
            transaction.get(checkOutLockRef),
          ]);
        assertActiveAdmin(adminSnapshot);
        if (!employeeSnapshot.exists) {
          throw callableError(
              "not-found",
              "EMPLOYEE_NOT_FOUND",
              "Profil karyawan tidak ditemukan.",
          );
        }
        const employee = core.assertActiveEmployee(employeeSnapshot.data());
        // Field staff may be issued a code at either their kelurahan or the
        // project kantor, so membership in the full candidate set is
        // checked rather than equality with only the primary assignment.
        const assignment = core.resolveAssignmentCandidates(employee)
            .find((candidate) =>
              candidate.collection === geofenceType &&
              candidate.id === geofenceId);
        if (!assignment) {
          throw callableError(
              "failed-precondition",
              "EMPLOYEE_ASSIGNMENT_MISMATCH",
              "Karyawan tidak ditugaskan pada geofence yang dipilih.",
          );
        }
        if (!geofenceSnapshot.exists) {
          throw callableError(
              "not-found",
              "GEOFENCE_NOT_FOUND",
              "Geofence tidak ditemukan.",
          );
        }
        const geofenceData = geofenceSnapshot.data();
        const geofence = core.normalizeGeofence(
            geofenceData,
            geofenceSnapshot.id,
            timestampMillis(geofenceData.verifiedAt),
            timestampMillis(geofenceData.verificationReviewedAt),
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
            {collection: geofenceType, ...geofence},
            timestampMillis(auditSnapshot.data().createdAt),
            timestampMillis(auditSnapshot.data().proposedAt),
        );
        const verifierPosition = assertVerifierLocation(
            request.data.location,
            nowMs,
            geofence,
        );
        if (secretSnapshot.exists &&
            (secretSnapshot.data().enabled !== true ||
             secretSnapshot.data().geofenceType !== geofenceType ||
             secretSnapshot.data().geofenceId !== geofenceId)) {
          throw callableError(
              "failed-precondition",
              "PRESENCE_SECRET_DISABLED",
              "Secret kode onsite dinonaktifkan.",
          );
        }
        const lockCandidates = [
          {snapshot: checkInLockSnapshot, action: "checkIn"},
          {snapshot: checkOutLockSnapshot, action: "checkOut"},
        ];
        for (const candidate of lockCandidates) {
          if (!candidate.snapshot.exists) continue;
          const lock = candidate.snapshot.data();
          const createdAtMs = timestampMillis(lock.createdAt);
          const expiresAtMs = timestampMillis(lock.expiresAt);
          if (lock.uid !== employeeUid || lock.action !== candidate.action ||
              !new Set(["pending", "consumed"]).has(lock.status) ||
              !Number.isFinite(createdAtMs) ||
              !Number.isFinite(expiresAtMs) || expiresAtMs <= createdAtMs) {
            throw callableError(
                "failed-precondition",
                "PENDING_CHALLENGE_INVALID",
                "Status lock challenge karyawan tidak konsisten.",
            );
          }
        }
        const activeLocks = lockCandidates
            .map((candidate) => candidate.snapshot)
            .filter((snapshot) => {
              if (!snapshot.exists) return false;
              const lock = snapshot.data();
              return lock.status === "pending" &&
                timestampMillis(lock.expiresAt) > nowMs;
            });
        if (activeLocks.length !== 1) {
          throw callableError(
              "failed-precondition",
              "PENDING_CHALLENGE_REQUIRED",
              activeLocks.length === 0 ?
                "Karyawan harus memulai proses absensi terlebih dahulu." :
                "Status challenge karyawan tidak konsisten.",
          );
        }
        const lock = activeLocks[0].data();
        const challengeId = core.assertChallengeId(lock.challengeId);
        context.challengeId = challengeId;
        const challengeRef = db.collection("attendanceChallenges")
            .doc(challengeId);
        const grantRef = db.collection("attendancePresenceGrants")
            .doc(challengeId);
        const [challengeSnapshot, grantSnapshot] = await Promise.all([
          transaction.get(challengeRef),
          transaction.get(grantRef),
        ]);
        const challenge = challengeSnapshot.exists ?
          challengeSnapshot.data() : null;
        const targetWorkDate = challenge?.targetWorkDate;
        const targetAttendanceId = typeof targetWorkDate === "string" ?
          `${employeeUid}_${targetWorkDate}` : null;
        if (!challenge || challenge.uid !== employeeUid ||
            challenge.action !== lock.action ||
            challenge.status !== "pending" || challenge.consumedAt != null ||
            challenge.attendanceId != null ||
            !/^\d{4}-\d{2}-\d{2}$/.test(challenge.requestDate || "") ||
            !/^\d{4}-\d{2}-\d{2}$/.test(targetWorkDate || "") ||
            challenge.targetAttendanceId !== targetAttendanceId ||
            !Number.isInteger(challenge.targetShiftRevision) ||
            challenge.targetShiftRevision < 1 ||
            (challenge.action === "checkIn" &&
              challenge.requestDate !== targetWorkDate) ||
            challenge.photoPath !==
              `attendanceProofs/${employeeUid}/${challengeId}` ||
            challenge.appId !== request.app.appId ||
            challenge.geofenceCollection !== geofenceType ||
            challenge.geofenceId !== geofenceId ||
            challenge.presenceProofRequired !== true ||
            timestampMillis(challenge.createdAt) !==
              timestampMillis(lock.createdAt) ||
            timestampMillis(challenge.expiresAt) !==
              timestampMillis(lock.expiresAt) ||
            timestampMillis(challenge.expiresAt) <= nowMs) {
          throw callableError(
              "failed-precondition",
              "PENDING_CHALLENGE_INVALID",
              "Challenge absensi karyawan tidak lagi valid.",
          );
        }
        if (grantSnapshot.exists &&
            grantSnapshot.data().status === "consumed") {
          throw callableError(
              "failed-precondition",
              "PRESENCE_GRANT_CONSUMED",
              "Kode challenge ini sudah digunakan.",
          );
        }

        const presenceSecret = secretSnapshot.exists ?
          secretSnapshot.data().secret : generatedSecret;
        let code;
        try {
          code = core.createPresenceCode(
              presenceSecret,
              counter,
              presenceCodeContext(
                  assignment,
                  employeeUid,
                  challengeId,
              ),
          );
        } catch (_) {
          throw callableError(
              "failed-precondition",
              "PRESENCE_SECRET_DISABLED",
              "Secret kode onsite tidak valid.",
          );
        }

        if (!secretSnapshot.exists) {
          transaction.create(secretRef, {
            geofenceType,
            geofenceId,
            secret: generatedSecret,
            enabled: true,
            createdAt: now,
            createdBy: uid,
          });
        }
        transaction.set(grantRef, {
          challengeId,
          uid: employeeUid,
          action: challenge.action,
          geofenceCollection: geofenceType,
          geofenceId,
          counter,
          status: "active",
          issuedAt: now,
          issuedBy: uid,
          verifierLocation: {
            ...verifierPosition.location,
            distanceMeters: verifierPosition.distanceMeters,
            uncertaintyAdjustedDistanceMeters:
              verifierPosition.uncertaintyAdjustedDistanceMeters,
            serverReceivedAt: now,
          },
          expiresAt: grantExpiresAt,
          displayExpiresAt: Timestamp.fromMillis(displayExpiresAtMs),
          consumedAt: null,
          attendanceId: null,
        });
        return {
          geofence,
          code,
          assignment,
          challengeId,
          action: challenge.action,
          employeeName: typeof employee.name === "string" ?
            employee.name : employeeUid,
          verifierPosition,
        };
      });

      return {
        code: result.code,
        expiresAt: new Date(displayExpiresAtMs).toISOString(),
        periodSeconds: core.PRESENCE_CODE_PERIOD_SECONDS,
        challengeId: result.challengeId,
        action: result.action,
        employee: {uid: employeeUid, name: result.employeeName},
        geofence: {
          id: result.geofence.id,
          name: result.geofence.name,
        },
        verifier: {
          distanceMeters: result.verifierPosition.distanceMeters,
          accuracyMeters: result.verifierPosition.location.accuracy,
          uncertaintyAdjustedDistanceMeters:
            result.verifierPosition.uncertaintyAdjustedDistanceMeters,
        },
      };
    }, context);
  }

  async function adminResetUserPassword(request) {
    const context = {
      operation: "adminResetUserPassword",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      employeeUid: request.data?.targetUserId,
    };
    return run(async () => {
      const uid = assertRequest(
          request,
          ["targetUserId", "requestId", "temporaryPassword"],
      );
      context.uid = uid;
      const {targetUserId, requestId} = request.data;
      const temporaryPassword = assertStrongPassword(
          request.data.temporaryPassword,
      );
      if (!validDocumentId(targetUserId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
              .test(requestId)) {
        throw callableError(
            "invalid-argument",
            "INVALID_RESET_REQUEST",
            "Target atau ID permintaan reset tidak valid.",
        );
      }
      if (targetUserId === uid) {
        throw callableError(
            "failed-precondition",
            "SELF_RESET_FORBIDDEN",
            "Gunakan alur perubahan password untuk akun sendiri.",
        );
      }

      const adminRef = db.collection("users").doc(uid);
      const targetRef = db.collection("users").doc(targetUserId);
      const operationRef = db.collection("adminPasswordResetOperations")
          .doc(requestId);
      const nowMs = Date.now();
      const now = Timestamp.fromMillis(nowMs);

      const operationState = await db.runTransaction(async (transaction) => {
        const [adminSnapshot, targetSnapshot, operationSnapshot] =
        await Promise.all([
          transaction.get(adminRef),
          transaction.get(targetRef),
          transaction.get(operationRef),
        ]);
        assertActiveAdmin(adminSnapshot);
        if (!targetSnapshot.exists) {
          throw callableError(
              "not-found",
              "TARGET_NOT_FOUND",
              "Profil pengguna target tidak ditemukan.",
          );
        }
        const target = targetSnapshot.data();
        if (target.role === "admin" || target.isAdmin === true) {
          throw callableError(
              "permission-denied",
              "ADMIN_RESET_FORBIDDEN",
              "Reset akun admin harus dilakukan melalui Firebase Console.",
          );
        }
        if (operationSnapshot.exists) {
          const operation = operationSnapshot.data();
          if (operation.targetUserId !== targetUserId ||
              operation.requestedBy !== uid) {
            throw callableError(
                "permission-denied",
                "RESET_REQUEST_CONFLICT",
                "ID permintaan reset sudah digunakan untuk operasi lain.",
            );
          }
          if (operation.status === "completed") {
            return {
              completed: true,
              resetAtMs: timestampMillis(operation.completedAt),
            };
          }
          const startedAtMs = timestampMillis(operation.startedAt ||
            operation.createdAt);
          if (operation.status === "started" &&
              Number.isFinite(startedAtMs) &&
              startedAtMs > nowMs - 2 * 60 * 1000) {
            throw callableError(
                "aborted",
                "RESET_IN_PROGRESS",
                "Permintaan reset yang sama masih diproses.",
            );
          }
          transaction.update(operationRef, {
            status: "started",
            startedAt: now,
            retryCount: FieldValue.increment(1),
          });
        } else {
          transaction.create(operationRef, {
            operationId: requestId,
            status: "started",
            targetUserId,
            requestedBy: uid,
            createdAt: now,
            startedAt: now,
            retryCount: 0,
          });
        }
        return {completed: false};
      });

      if (operationState.completed) {
        return {
          success: true,
          requestId,
          resetAt: new Date(operationState.resetAtMs).toISOString(),
          idempotentReplay: true,
        };
      }

      try {
        await admin.auth().getUser(targetUserId);
        await admin.auth().updateUser(targetUserId, {
          password: temporaryPassword,
        });
        await admin.auth().revokeRefreshTokens(targetUserId);

        const batch = db.batch();
        batch.update(targetRef, {
          mustChangePassword: true,
          passwordResetAt: now,
          passwordResetBy: uid,
        });
        batch.update(operationRef, {
          status: "completed",
          completedAt: now,
        });
        batch.set(db.collection("adminAuditLogs").doc(requestId), {
          action: "password_reset",
          actorUserId: uid,
          targetUserId,
          createdAt: now,
          operationId: requestId,
        });
        await batch.commit();
      } catch (error) {
        await operationRef.update({
          status: "failed",
          failedAt: Timestamp.now(),
          errorCode: typeof error.code === "string" ?
            error.code.slice(0, 100) : "unknown",
        }).catch((writeError) => {
          logger.error("Failed to record password reset failure", {
            operationId: requestId,
            error: writeError.message,
          });
        });
        if (error && error.code === "auth/user-not-found") {
          throw callableError(
              "not-found",
              "AUTH_USER_NOT_FOUND",
              "Akun Firebase Authentication target tidak ditemukan.",
          );
        }
        throw error;
      }

      return {
        success: true,
        requestId,
        resetAt: new Date(nowMs).toISOString(),
      };
    }, context);
  }

  async function adminArchiveEmployee(request) {
    const context = {
      operation: "adminArchiveEmployee",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      employeeUid: request.data?.targetUserId,
    };
    return run(async () => {
      const uid = assertRequest(request, ["targetUserId", "reason"]);
      context.uid = uid;
      const {targetUserId, reason} = request.data;
      const normalizedReason = typeof reason === "string" ? reason.trim() : "";
      if (!validDocumentId(targetUserId) || normalizedReason.length < 10 ||
          normalizedReason.length > 500 || targetUserId === uid) {
        throw callableError(
            "invalid-argument",
            "INVALID_ARCHIVE_REQUEST",
            "Target dan alasan arsip tidak valid.",
        );
      }
      const operationId = crypto.randomUUID();
      const now = Timestamp.now();
      const adminRef = db.collection("users").doc(uid);
      const targetRef = db.collection("users").doc(targetUserId);
      const operationRef = db.collection("employeeArchiveOperations")
          .doc(operationId);

      await db.runTransaction(async (transaction) => {
        const [adminSnapshot, targetSnapshot] = await Promise.all([
          transaction.get(adminRef),
          transaction.get(targetRef),
        ]);
        assertActiveAdmin(adminSnapshot);
        if (!targetSnapshot.exists) {
          throw callableError(
              "not-found",
              "TARGET_NOT_FOUND",
              "Profil karyawan tidak ditemukan.",
          );
        }
        const target = targetSnapshot.data();
        if (target.role === "admin" || target.isAdmin === true) {
          throw callableError(
              "permission-denied",
              "ADMIN_ARCHIVE_FORBIDDEN",
              "Akun admin tidak dapat diarsipkan dari fitur ini.",
          );
        }
        if (target.accountStatus !== "suspended" ||
            target.isActive === true) {
          throw callableError(
              "failed-precondition",
              "SUSPEND_FIRST",
              "Karyawan harus dinonaktifkan dan berstatus suspended dahulu.",
          );
        }
        transaction.create(operationRef, {
          operationId,
          targetUserId,
          requestedBy: uid,
          reason: normalizedReason,
          status: "started",
          createdAt: now,
        });
      });

      try {
        await admin.auth().updateUser(targetUserId, {disabled: true});
        await admin.auth().revokeRefreshTokens(targetUserId);
        await db.runTransaction(async (transaction) => {
          const targetSnapshot = await transaction.get(targetRef);
          if (!targetSnapshot.exists) {
            throw callableError(
                "not-found",
                "TARGET_NOT_FOUND",
                "Profil karyawan tidak ditemukan.",
            );
          }
          const target = targetSnapshot.data();
          if (target.role === "admin" || target.isAdmin === true ||
              target.accountStatus !== "suspended" ||
              target.isActive === true) {
            throw callableError(
                "failed-precondition",
                "ARCHIVE_STATE_CHANGED",
                "Status karyawan berubah selama proses arsip.",
            );
          }
          transaction.update(targetRef, {
            accountStatus: "archived",
            isActive: false,
            archivedAt: now,
            archivedBy: uid,
            archiveReason: normalizedReason,
            updatedAt: now,
          });
          transaction.update(operationRef, {
            status: "completed",
            completedAt: now,
          });
          transaction.create(db.collection("deletionLogs").doc(operationId), {
            action: "employee_archived",
            employeeId: targetUserId,
            employeeName: typeof target.name === "string" ? target.name : "",
            employeeEmail: typeof target.email === "string" ?
              target.email : "",
            reason: normalizedReason,
            archivedAt: now,
            archivedBy: uid,
            operationId,
            evidencePreserved: true,
          });
        });
      } catch (error) {
        await operationRef.update({
          status: "failed",
          failedAt: Timestamp.now(),
          errorCode: typeof error.code === "string" ?
            error.code.slice(0, 100) : "unknown",
        }).catch((writeError) => {
          logger.error("Failed to record employee archive failure", {
            operationId,
            error: writeError.message,
          });
        });
        throw error;
      }

      return {
        success: true,
        targetUserId,
        operationId,
        evidencePreserved: true,
      };
    }, context);
  }

  async function changeTemporaryPassword(request) {
    const context = {
      operation: "changeTemporaryPassword",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      employeeUid: request.auth?.uid,
    };
    return run(async () => {
      const uid = assertRequest(request, ["newPassword"]);
      context.uid = uid;
      context.employeeUid = uid;
      const newPassword = assertStrongPassword(request.data.newPassword);
      const userRef = db.collection("users").doc(uid);
      const operationId = crypto.randomUUID();
      const operationRef = db.collection("passwordChangeOperations")
          .doc(operationId);
      const nowMs = Date.now();
      const now = Timestamp.fromMillis(nowMs);
      const initialProfileSnapshot = await userRef.get();
      if (!initialProfileSnapshot.exists) {
        throw callableError(
            "not-found",
            "PROFILE_NOT_FOUND",
            "Profil pengguna tidak ditemukan.",
        );
      }
      const initialProfile = initialProfileSnapshot.data();
      if (initialProfile.accountStatus !== "active" ||
          initialProfile.isActive !== true) {
        throw callableError(
            "permission-denied",
            "ACCOUNT_INACTIVE",
            "Akun pengguna tidak aktif.",
        );
      }
      if (initialProfile.mustChangePassword !== true) {
        throw callableError(
            "failed-precondition",
            "PASSWORD_CHANGE_NOT_REQUIRED",
            "Akun ini tidak sedang menggunakan password sementara.",
        );
      }
      const passwordResetAtMs = timestampMillis(
          initialProfile.passwordResetAt,
      );
      if (!Number.isFinite(passwordResetAtMs)) {
        throw callableError(
            "failed-precondition",
            "PASSWORD_RESET_STATE_INVALID",
            "Status reset password tidak valid.",
        );
      }
      await assertRecentUnrevokedAuth(
          admin,
          request,
          uid,
          passwordResetAtMs,
          nowMs,
      );

      await db.runTransaction(async (transaction) => {
        const profileSnapshot = await transaction.get(userRef);
        if (!profileSnapshot.exists) {
          throw callableError(
              "not-found",
              "PROFILE_NOT_FOUND",
              "Profil pengguna tidak ditemukan.",
          );
        }
        const profile = profileSnapshot.data();
        if (profile.accountStatus !== "active" || profile.isActive !== true) {
          throw callableError(
              "permission-denied",
              "ACCOUNT_INACTIVE",
              "Akun pengguna tidak aktif.",
          );
        }
        if (profile.mustChangePassword !== true) {
          throw callableError(
              "failed-precondition",
              "PASSWORD_CHANGE_NOT_REQUIRED",
              "Akun ini tidak sedang menggunakan password sementara.",
          );
        }
        if (timestampMillis(profile.passwordResetAt) !== passwordResetAtMs) {
          throw callableError(
              "failed-precondition",
              "PASSWORD_RESET_CHANGED",
              "Password sementara telah diganti oleh reset yang lebih baru.",
          );
        }
        if (profile.passwordChangeOperationId != null) {
          throw callableError(
              "aborted",
              "PASSWORD_CHANGE_IN_PROGRESS",
              "Perubahan password lain sedang diproses.",
          );
        }
        transaction.create(operationRef, {
          operationId,
          userId: uid,
          status: "started",
          createdAt: now,
        });
        transaction.update(userRef, {
          passwordChangeOperationId: operationId,
          passwordChangeStartedAt: now,
        });
      });

      try {
        await admin.auth().updateUser(uid, {password: newPassword});
        await admin.auth().revokeRefreshTokens(uid);

        const batch = db.batch();
        batch.update(userRef, {
          mustChangePassword: false,
          passwordChangedAt: now,
          updatedAt: now,
          passwordChangeOperationId: FieldValue.delete(),
          passwordChangeStartedAt: FieldValue.delete(),
        });
        batch.update(operationRef, {
          status: "completed",
          completedAt: now,
        });
        batch.create(db.collection("adminAuditLogs").doc(operationId), {
          action: "temporary_password_changed",
          actorUserId: uid,
          targetUserId: uid,
          createdAt: now,
          operationId,
        });
        await batch.commit();
      } catch (error) {
        await db.runTransaction(async (transaction) => {
          const profileSnapshot = await transaction.get(userRef);
          if (profileSnapshot.exists &&
              profileSnapshot.data().passwordChangeOperationId ===
                operationId) {
            transaction.update(userRef, {
              passwordChangeOperationId: FieldValue.delete(),
              passwordChangeStartedAt: FieldValue.delete(),
            });
          }
          transaction.update(operationRef, {
            status: "failed",
            failedAt: Timestamp.now(),
            errorCode: typeof error.code === "string" ?
              error.code.slice(0, 100) : "unknown",
          });
        }).catch((writeError) => {
          logger.error("Failed to record password change failure", {
            operationId,
            error: writeError.message,
          });
        });
        throw error;
      }

      return {success: true};
    }, context);
  }

  return {
    adminArchiveEmployee,
    adminResetUserPassword,
    changeTemporaryPassword,
    getOnsitePresenceCode,
  };
}

module.exports = {
  assertRecentUnrevokedAuth,
  assertStrongPassword,
  assertVerifierLocation,
  createAdminHandlers,
  generateTemporaryPassword,
};
