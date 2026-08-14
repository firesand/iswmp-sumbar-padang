"use strict";

const crypto = require("node:crypto");
const {HttpsError} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const core = require("./attendance-core");

const PROPOSAL_COLLECTION = "geofenceVerificationProposals";
const AUDIT_COLLECTION = "geofenceVerificationAuditLogs";
const LOCK_COLLECTION = "geofenceVerificationProposalLocks";
const RATE_COLLECTION = "geofenceVerificationRateLimits";
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DAILY_PROPOSALS = 10;
const MAX_DAILY_REVIEWS = 30;
const PROPOSAL_COOLDOWN_MS = 10 * 1000;
const REVIEW_COOLDOWN_MS = 2 * 1000;
const AUDIT_SCHEMA_VERSION = 2;
const PROPOSAL_SCHEMA_VERSION = 1;
const VERIFICATION_EVIDENCE = "dual-gps-callable-v1";
const ALLOWED_COLLECTIONS = new Set(["kelurahan", "kantor"]);
const ALLOWED_DECISIONS = new Set(["approve", "reject"]);

const PENDING_PROPOSAL_FIELDS = new Set([
  "schemaVersion",
  "action",
  "proposalId",
  "status",
  "geofenceCollection",
  "geofenceId",
  "previousLat",
  "previousLng",
  "previousRadius",
  "lat",
  "lng",
  "radius",
  "verifiedLat",
  "verifiedLng",
  "verifiedRadius",
  "verifiedBy",
  "evidence",
  "operator",
  "proposerUid",
  "operatorAccountFingerprint",
  "sourceUpdateTime",
  "proposalFingerprint",
  "proposerLocation",
  "proposedAt",
  "expiresAt",
]);

function callableError(code, reason, message) {
  return new HttpsError(code, message, {reason});
}

function securityFingerprint(value) {
  if (typeof value !== "string" || !value) return undefined;
  return crypto.createHash("sha256")
      .update("geofence-verification-log-v1\u0000")
      .update(value)
      .digest("hex")
      .slice(0, 20);
}

function accountFingerprint(uid) {
  if (!validDocumentId(uid)) {
    throw callableError(
        "failed-precondition",
        "ADMIN_IDENTITY_INVALID",
        "Identitas akun admin tidak valid.",
    );
  }
  return crypto.createHash("sha256")
      .update("firebase-auth-uid:\u0000")
      .update(uid)
      .digest("hex");
}

function operatorIdentity(uid) {
  return `firebase-auth:${uid}`;
}

function operatorLabel(uid) {
  return `admin-${accountFingerprint(uid).slice(0, 20)}`;
}

function validDocumentId(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function validProposalId(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9:_-]{1,180}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(value);
}

function timestampMillis(value) {
  return value && typeof value.toMillis === "function" ?
    value.toMillis() : NaN;
}

function timestampIso(value) {
  if (!value || typeof value.toDate !== "function") {
    throw callableError(
        "failed-precondition",
        "GEOFENCE_VERSION_INVALID",
        "Versi dokumen geofence tidak dapat diverifikasi.",
    );
  }
  return value.toDate().toISOString();
}

function assertExactFields(data, allowed, reason, message) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).length !== allowed.size ||
      Object.keys(data).some((key) => !allowed.has(key))) {
    throw callableError("failed-precondition", reason, message);
  }
}

function assertRequest(request, keys) {
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
      Object.keys(request.data).some((key) => !keys.includes(key))) {
    throw callableError(
        "invalid-argument",
        "INVALID_REQUEST",
        "Payload verifikasi geofence tidak valid.",
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
      (user.role !== "admin" && user.isAdmin !== true) ||
      user.adminRole === "viewer" || user.adminRole === "monitor" ||
      user.isViewer === true ||
      user.role === "admin_viewer" || user.role === "viewer") {
    throw callableError(
        "permission-denied",
        "ADMIN_REQUIRED",
        "Hanya admin pengelola aktif yang dapat memverifikasi geofence.",
    );
  }
  return user;
}

function normalizeProposedGeofence(data) {
  if (!ALLOWED_COLLECTIONS.has(data.collection) ||
      !validDocumentId(data.geofenceId) ||
      typeof data.lat !== "number" || !Number.isFinite(data.lat) ||
      data.lat < -90 || data.lat > 90 ||
      typeof data.lng !== "number" || !Number.isFinite(data.lng) ||
      data.lng < -180 || data.lng > 180 ||
      (data.lat === 0 && data.lng === 0) ||
      typeof data.radius !== "number" || !Number.isFinite(data.radius) ||
      data.radius <= 0 || data.radius > 500) {
    throw callableError(
        "invalid-argument",
        "GEOFENCE_INVALID",
        "Koleksi, ID, koordinat, atau radius geofence tidak valid.",
    );
  }
  return {
    collection: data.collection,
    id: data.geofenceId,
    lat: data.lat,
    lng: data.lng,
    radius: data.radius,
  };
}

function assertPhysicalLocation(rawLocation, nowMs, proposedGeofence,
    outsideReason = "VERIFIER_OUTSIDE_GEOFENCE") {
  const location = core.normalizeLocation(rawLocation, nowMs);
  const distance = core.calculateDistanceMeters(
      location.lat,
      location.lng,
      proposedGeofence.lat,
      proposedGeofence.lng,
  );
  const uncertaintyAdjustedDistance = distance + location.accuracy;
  if (!Number.isFinite(distance) ||
      !Number.isFinite(uncertaintyAdjustedDistance) ||
      uncertaintyAdjustedDistance > proposedGeofence.radius) {
    throw callableError(
        "failed-precondition",
        outsideReason,
        "Lokasi admin, termasuk ketidakpastian GPS, berada di luar " +
          "radius geofence yang diusulkan.",
    );
  }
  return {
    ...location,
    distanceMeters: Math.round(distance),
    uncertaintyAdjustedDistanceMeters:
      Math.round(uncertaintyAdjustedDistance),
  };
}

function previousNumber(value, label) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw callableError(
        "failed-precondition",
        "GEOFENCE_SOURCE_INVALID",
        `Nilai ${label} geofence saat ini tidak valid.`,
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

function auditStableFields(proposal) {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    action: "geofence_physical_verification",
    auditId: proposal.proposalId,
    geofenceCollection: proposal.geofenceCollection,
    geofenceId: proposal.geofenceId,
    previousLat: proposal.previousLat,
    previousLng: proposal.previousLng,
    previousRadius: proposal.previousRadius,
    verifiedLat: proposal.verifiedLat,
    verifiedLng: proposal.verifiedLng,
    verifiedRadius: proposal.verifiedRadius,
    verifiedBy: proposal.verifiedBy,
    evidence: proposal.evidence,
    operator: proposal.operator,
    operatorAccountFingerprint: proposal.operatorAccountFingerprint,
    sourceUpdateTime: proposal.sourceUpdateTime,
  };
}

function calculateProposalFingerprint(proposal) {
  return crypto.createHash("sha256")
      .update(JSON.stringify(auditStableFields(proposal)))
      .digest("hex");
}

function assertStoredPhysicalLocation(raw, receivedAtMs, geofence) {
  let normalized;
  try {
    normalized = core.normalizeLocation(raw, receivedAtMs, [
      "distanceMeters",
      "uncertaintyAdjustedDistanceMeters",
      "serverReceivedAt",
    ]);
  } catch (_) {
    throw callableError(
        "failed-precondition",
        "PROPOSAL_LOCATION_INVALID",
        "Bukti GPS proposal tidak valid.",
    );
  }
  const serverReceivedAtMs = timestampMillis(raw.serverReceivedAt);
  const distance = core.calculateDistanceMeters(
      normalized.lat,
      normalized.lng,
      geofence.lat,
      geofence.lng,
  );
  const adjusted = distance + normalized.accuracy;
  if (serverReceivedAtMs !== receivedAtMs ||
      raw.distanceMeters !== Math.round(distance) ||
      raw.uncertaintyAdjustedDistanceMeters !== Math.round(adjusted) ||
      !Number.isFinite(adjusted) || adjusted > geofence.radius) {
    throw callableError(
        "failed-precondition",
        "PROPOSAL_LOCATION_INVALID",
        "Bukti GPS proposal tidak konsisten.",
    );
  }
  return normalized;
}

function assertPendingProposal(data, proposalId, nowMs) {
  assertExactFields(
      data,
      PENDING_PROPOSAL_FIELDS,
      "PROPOSAL_STATE_INVALID",
      "Status proposal geofence tidak valid.",
  );
  const proposedAtMs = timestampMillis(data.proposedAt);
  const expiresAtMs = timestampMillis(data.expiresAt);
  const proposedGeofence = {
    lat: data.verifiedLat,
    lng: data.verifiedLng,
    radius: data.verifiedRadius,
  };
  if (data.schemaVersion !== PROPOSAL_SCHEMA_VERSION ||
      data.action !== "geofence_physical_verification" ||
      data.proposalId !== proposalId || !validProposalId(proposalId) ||
      data.status !== "pending" ||
      !ALLOWED_COLLECTIONS.has(data.geofenceCollection) ||
      !validDocumentId(data.geofenceId) ||
      typeof data.verifiedLat !== "number" ||
      !Number.isFinite(data.verifiedLat) ||
      data.verifiedLat < -90 || data.verifiedLat > 90 ||
      typeof data.verifiedLng !== "number" ||
      !Number.isFinite(data.verifiedLng) ||
      data.verifiedLng < -180 || data.verifiedLng > 180 ||
      (data.verifiedLat === 0 && data.verifiedLng === 0) ||
      typeof data.verifiedRadius !== "number" ||
      !Number.isFinite(data.verifiedRadius) ||
      data.verifiedRadius <= 0 || data.verifiedRadius > 500 ||
      data.lat !== data.verifiedLat || data.lng !== data.verifiedLng ||
      data.radius !== data.verifiedRadius ||
      !validDocumentId(data.proposerUid) ||
      data.operator !== operatorIdentity(data.proposerUid) ||
      data.operatorAccountFingerprint !==
        accountFingerprint(data.proposerUid) ||
      data.verifiedBy !== operatorLabel(data.proposerUid) ||
      data.evidence !== VERIFICATION_EVIDENCE ||
      typeof data.sourceUpdateTime !== "string" ||
      !Number.isFinite(Date.parse(data.sourceUpdateTime)) ||
      typeof data.proposalFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(data.proposalFingerprint) ||
      !Number.isFinite(proposedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      proposedAtMs > nowMs ||
      expiresAtMs !== proposedAtMs + PROPOSAL_TTL_MS) {
    throw callableError(
        "failed-precondition",
        "PROPOSAL_STATE_INVALID",
        "Status proposal geofence tidak valid.",
    );
  }
  previousNumber(data.previousLat, "latitude lama");
  previousNumber(data.previousLng, "longitude lama");
  previousNumber(data.previousRadius, "radius lama");
  if (calculateProposalFingerprint(data) !== data.proposalFingerprint) {
    throw callableError(
        "failed-precondition",
        "PROPOSAL_FINGERPRINT_INVALID",
        "Fingerprint proposal geofence tidak cocok.",
    );
  }
  assertStoredPhysicalLocation(
      data.proposerLocation,
      proposedAtMs,
      proposedGeofence,
  );
  return {proposedAtMs, expiresAtMs, proposedGeofence};
}

function assertIndependentReviewer(proposerUid, reviewerUid) {
  if (!validDocumentId(proposerUid) || !validDocumentId(reviewerUid)) {
    throw callableError(
        "failed-precondition",
        "REVIEWER_NOT_INDEPENDENT",
        "Identitas proposer atau reviewer tidak valid.",
    );
  }
  if (proposerUid === reviewerUid ||
      accountFingerprint(proposerUid) === accountFingerprint(reviewerUid)) {
    throw callableError(
        "permission-denied",
        "SAME_REVIEWER",
        "Proposal wajib direview oleh akun admin kedua.",
    );
  }
  return true;
}

function rateState(data, uid, date) {
  if (!data) {
    return {
      uid,
      date,
      proposalCount: 0,
      reviewCount: 0,
      lastProposalAt: null,
      lastReviewAt: null,
    };
  }
  if (data.uid !== uid || data.date !== date ||
      !Number.isInteger(data.proposalCount) || data.proposalCount < 0 ||
      !Number.isInteger(data.reviewCount) || data.reviewCount < 0) {
    throw callableError(
        "failed-precondition",
        "GEOFENCE_RATE_STATE_INVALID",
        "Status pembatasan verifikasi geofence tidak valid.",
    );
  }
  return data;
}

function consumeRate(data, uid, date, operation, nowMs, now) {
  const state = rateState(data, uid, date);
  const isProposal = operation === "proposal";
  const countKey = isProposal ? "proposalCount" : "reviewCount";
  const lastKey = isProposal ? "lastProposalAt" : "lastReviewAt";
  const maximum = isProposal ? MAX_DAILY_PROPOSALS : MAX_DAILY_REVIEWS;
  const cooldown = isProposal ? PROPOSAL_COOLDOWN_MS : REVIEW_COOLDOWN_MS;
  if (state[countKey] >= maximum) {
    throw callableError(
        "resource-exhausted",
        isProposal ? "DAILY_PROPOSAL_LIMIT" : "DAILY_REVIEW_LIMIT",
        "Batas verifikasi geofence harian telah tercapai.",
    );
  }
  const lastAtMs = timestampMillis(state[lastKey]);
  if (Number.isFinite(lastAtMs) && lastAtMs > nowMs - cooldown) {
    throw callableError(
        "resource-exhausted",
        "GEOFENCE_RATE_LIMIT",
        "Tunggu sebentar sebelum mengulangi operasi geofence.",
    );
  }
  return {
    uid,
    date,
    proposalCount: state.proposalCount + (isProposal ? 1 : 0),
    reviewCount: state.reviewCount + (isProposal ? 0 : 1),
    lastProposalAt: isProposal ? now : state.lastProposalAt,
    lastReviewAt: isProposal ? state.lastReviewAt : now,
  };
}

function logSecurityEvent(outcome, context, result, error) {
  const decision = result?.decision || context.decision;
  const event = {
    schemaVersion: 1,
    event: "geofence_verification_security_event",
    operation: context.operation,
    outcome,
    actorFingerprint: securityFingerprint(context.uid),
    appId: context.appId,
    proposalFingerprint: securityFingerprint(
        result?.proposalId || context.proposalId,
    ),
    geofenceFingerprint: securityFingerprint(
        result?.geofenceKey || context.geofenceKey,
    ),
    decision: ALLOWED_DECISIONS.has(decision) ? decision : undefined,
    reason: error?.details?.reason || error?.code,
  };
  Object.keys(event).forEach((key) => {
    if (event[key] == null || event[key] === "") delete event[key];
  });
  if (outcome === "success") {
    logger.info("Geofence verification security event", event);
  } else {
    logger.warn("Geofence verification security event", event);
  }
}

function mapError(error) {
  if (error instanceof HttpsError) return error;
  if (error instanceof core.AttendanceInputError) {
    return callableError(
        "invalid-argument",
        error.reason,
        error.message,
    );
  }
  return callableError(
      "internal",
      "INTERNAL_ERROR",
      "Verifikasi geofence gagal diproses.",
  );
}

async function run(operation, context) {
  try {
    const result = await operation();
    logSecurityEvent("success", context, result, null);
    return result;
  } catch (error) {
    const mapped = mapError(error);
    if (!(error instanceof HttpsError) &&
        !(error instanceof core.AttendanceInputError)) {
      logger.error("Geofence verification operation failed", {
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

function createGeofenceVerificationHandlers(admin) {
  const db = admin.firestore();
  const Timestamp = admin.firestore.Timestamp;

  async function proposeGeofenceVerification(request) {
    const context = {
      operation: "proposeGeofenceVerification",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      geofenceKey: request.data?.collection && request.data?.geofenceId ?
        `${request.data.collection}/${request.data.geofenceId}` : undefined,
    };
    return run(async () => {
      const uid = assertRequest(request, [
        "collection",
        "geofenceId",
        "lat",
        "lng",
        "radius",
        "location",
      ]);
      context.uid = uid;
      const proposed = normalizeProposedGeofence(request.data);
      context.geofenceKey = `${proposed.collection}/${proposed.id}`;
      const nowMs = Date.now();
      const now = Timestamp.fromMillis(nowMs);
      const expiresAt = Timestamp.fromMillis(nowMs + PROPOSAL_TTL_MS);
      const verifierLocation = assertPhysicalLocation(
          request.data.location,
          nowMs,
          proposed,
          "VERIFIER_OUTSIDE_GEOFENCE",
      );
      const proposalId = `${proposed.collection}_` +
        `${securityFingerprint(proposed.id)}_` +
        crypto.randomUUID();
      context.proposalId = proposalId;
      if (!validProposalId(proposalId)) {
        throw callableError(
            "failed-precondition",
            "PROPOSAL_ID_INVALID",
            "ID proposal geofence tidak valid.",
        );
      }
      const adminRef = db.collection("users").doc(uid);
      const geofenceRef = db.collection(proposed.collection).doc(proposed.id);
      const proposalRef = db.collection(PROPOSAL_COLLECTION).doc(proposalId);
      const lockRef = db.collection(LOCK_COLLECTION)
          .doc(`${proposed.collection}_${proposed.id}`);
      const date = core.getServerAttendanceStamp(new Date(nowMs)).date;
      const rateRef = db.collection(RATE_COLLECTION).doc(`${uid}_${date}`);

      const result = await db.runTransaction(async (transaction) => {
        const [adminSnapshot, geofenceSnapshot, lockSnapshot, rateSnapshot] =
          await Promise.all([
            transaction.get(adminRef),
            transaction.get(geofenceRef),
            transaction.get(lockRef),
            transaction.get(rateRef),
          ]);
        assertActiveAdmin(adminSnapshot);
        if (!geofenceSnapshot.exists) {
          throw callableError(
              "not-found",
              "GEOFENCE_NOT_FOUND",
              "Geofence tidak ditemukan.",
          );
        }
        let staleProposalRef = null;
        if (lockSnapshot.exists) {
          const lock = lockSnapshot.data();
          const lockExpiresAtMs = timestampMillis(lock.expiresAt);
          if (!validProposalId(lock.proposalId) ||
              !new Set(["pending", "approved", "rejected"])
                  .has(lock.status) ||
              !Number.isFinite(lockExpiresAtMs)) {
            throw callableError(
                "failed-precondition",
                "PROPOSAL_LOCK_INVALID",
                "Status lock proposal geofence tidak valid.",
            );
          }
          if (lock.status === "pending" && lockExpiresAtMs > nowMs) {
            throw callableError(
                "already-exists",
                "GEOFENCE_PROPOSAL_EXISTS",
                "Geofence masih memiliki proposal aktif.",
            );
          }
          if (lock.status === "pending") {
            const candidateRef = db.collection(PROPOSAL_COLLECTION)
                .doc(lock.proposalId);
            const candidateSnapshot = await transaction.get(candidateRef);
            if (candidateSnapshot.exists &&
                candidateSnapshot.data().proposalId === lock.proposalId &&
                candidateSnapshot.data().status === "pending") {
              staleProposalRef = candidateRef;
            }
          }
        }
        const source = geofenceSnapshot.data();
        const proposal = {
          schemaVersion: PROPOSAL_SCHEMA_VERSION,
          action: "geofence_physical_verification",
          proposalId,
          status: "pending",
          geofenceCollection: proposed.collection,
          geofenceId: proposed.id,
          previousLat: previousNumber(source.lat, "latitude lama"),
          previousLng: previousNumber(source.lng, "longitude lama"),
          previousRadius: previousNumber(source.radius, "radius lama"),
          lat: proposed.lat,
          lng: proposed.lng,
          radius: proposed.radius,
          verifiedLat: proposed.lat,
          verifiedLng: proposed.lng,
          verifiedRadius: proposed.radius,
          verifiedBy: operatorLabel(uid),
          evidence: VERIFICATION_EVIDENCE,
          operator: operatorIdentity(uid),
          proposerUid: uid,
          operatorAccountFingerprint: accountFingerprint(uid),
          sourceUpdateTime: timestampIso(geofenceSnapshot.updateTime),
        };
        proposal.proposalFingerprint = calculateProposalFingerprint(proposal);
        proposal.proposerLocation = {
          ...verifierLocation,
          serverReceivedAt: now,
        };
        proposal.proposedAt = now;
        proposal.expiresAt = expiresAt;
        const nextRate = consumeRate(
            rateSnapshot.exists ? rateSnapshot.data() : null,
            uid,
            date,
            "proposal",
            nowMs,
            now,
        );

        if (staleProposalRef) {
          transaction.update(staleProposalRef, {
            status: "expired",
            expiredAt: now,
          });
        }
        transaction.create(proposalRef, proposal);
        transaction.set(lockRef, {
          geofenceCollection: proposed.collection,
          geofenceId: proposed.id,
          proposalId,
          proposerUid: uid,
          status: "pending",
          createdAt: now,
          expiresAt,
        });
        transaction.set(rateRef, nextRate);
        return {proposalFingerprint: proposal.proposalFingerprint};
      });

      return {
        success: true,
        proposalId,
        status: "pending",
        proposalFingerprint: result.proposalFingerprint,
        expiresAt: new Date(nowMs + PROPOSAL_TTL_MS).toISOString(),
        geofenceKey: context.geofenceKey,
        verifier: {
          distanceMeters: verifierLocation.distanceMeters,
          accuracyMeters: verifierLocation.accuracy,
          uncertaintyAdjustedDistanceMeters:
            verifierLocation.uncertaintyAdjustedDistanceMeters,
        },
      };
    }, context);
  }

  async function reviewGeofenceVerification(request) {
    const context = {
      operation: "reviewGeofenceVerification",
      uid: request.auth?.uid,
      appId: request.app?.appId,
      proposalId: request.data?.proposalId,
      decision: request.data?.decision,
    };
    return run(async () => {
      const reviewerUid = assertRequest(request, [
        "proposalId",
        "decision",
        "location",
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
      const auditRef = db.collection(AUDIT_COLLECTION).doc(proposalId);
      const reviewerRef = db.collection("users").doc(reviewerUid);
      const date = core.getServerAttendanceStamp(new Date(nowMs)).date;
      const rateRef = db.collection(RATE_COLLECTION)
          .doc(`${reviewerUid}_${date}`);

      const result = await db.runTransaction(async (transaction) => {
        const proposalSnapshot = await transaction.get(proposalRef);
        if (!proposalSnapshot.exists) {
          throw callableError(
              "not-found",
              "PROPOSAL_NOT_FOUND",
              "Proposal geofence tidak ditemukan.",
          );
        }
        const proposal = proposalSnapshot.data();
        if (proposal?.status !== "pending") {
          throw callableError(
              "failed-precondition",
              "PROPOSAL_NOT_PENDING",
              "Proposal geofence sudah pernah direview.",
          );
        }
        const checked = assertPendingProposal(proposal, proposalId, nowMs);
        assertIndependentReviewer(proposal.proposerUid, reviewerUid);
        context.geofenceKey =
          `${proposal.geofenceCollection}/${proposal.geofenceId}`;
        const geofenceRef = db.collection(proposal.geofenceCollection)
            .doc(proposal.geofenceId);
        const proposerRef = db.collection("users").doc(proposal.proposerUid);
        const lockRef = db.collection(LOCK_COLLECTION)
            .doc(`${proposal.geofenceCollection}_${proposal.geofenceId}`);
        const [reviewerSnapshot, proposerSnapshot, geofenceSnapshot,
          lockSnapshot, rateSnapshot, auditSnapshot] = await Promise.all([
          transaction.get(reviewerRef),
          transaction.get(proposerRef),
          transaction.get(geofenceRef),
          transaction.get(lockRef),
          transaction.get(rateRef),
          transaction.get(auditRef),
        ]);
        assertActiveAdmin(reviewerSnapshot);
        if (decision === "approve") assertActiveAdmin(proposerSnapshot);
        if (!geofenceSnapshot.exists) {
          throw callableError(
              "not-found",
              "GEOFENCE_NOT_FOUND",
              "Geofence tidak ditemukan.",
          );
        }
        if (auditSnapshot.exists) {
          throw callableError(
              "failed-precondition",
              "AUDIT_ALREADY_EXISTS",
              "Audit proposal ini sudah tercatat.",
          );
        }
        const lock = lockSnapshot.exists ? lockSnapshot.data() : null;
        if (!lock || lock.proposalId !== proposalId ||
            lock.proposerUid !== proposal.proposerUid ||
            lock.geofenceCollection !== proposal.geofenceCollection ||
            lock.geofenceId !== proposal.geofenceId ||
            lock.status !== "pending" ||
            timestampMillis(lock.createdAt) !== checked.proposedAtMs ||
            timestampMillis(lock.expiresAt) !== checked.expiresAtMs) {
          throw callableError(
              "failed-precondition",
              "PROPOSAL_LOCK_INVALID",
              "Status lock proposal geofence tidak valid.",
          );
        }
        if (decision === "approve" && checked.expiresAtMs <= nowMs) {
          throw callableError(
              "deadline-exceeded",
              "PROPOSAL_EXPIRED",
              "Proposal geofence sudah kedaluwarsa.",
          );
        }
        const reviewerLocation = assertPhysicalLocation(
            request.data.location,
            nowMs,
            checked.proposedGeofence,
            "REVIEWER_OUTSIDE_GEOFENCE",
        );
        if (decision === "approve" &&
            timestampIso(geofenceSnapshot.updateTime) !==
              proposal.sourceUpdateTime) {
          throw callableError(
              "failed-precondition",
              "GEOFENCE_CHANGED",
              "Geofence berubah setelah proposal dibuat.",
          );
        }
        const nextRate = consumeRate(
            rateSnapshot.exists ? rateSnapshot.data() : null,
            reviewerUid,
            date,
            "review",
            nowMs,
            now,
        );
        const reviewedBy = operatorLabel(reviewerUid);
        const reviewOperator = operatorIdentity(reviewerUid);
        const reviewFingerprint = accountFingerprint(reviewerUid);
        const status = decision === "approve" ? "approved" : "rejected";
        const audit = {
          ...auditStableFields(proposal),
          status,
          proposalFingerprint: proposal.proposalFingerprint,
          proposedAt: proposal.proposedAt,
          reviewedBy,
          reviewOperator,
          reviewOperatorAccountFingerprint: reviewFingerprint,
          createdAt: now,
        };

        transaction.create(auditRef, audit);
        transaction.update(proposalRef, {
          status,
          decision,
          reviewedBy,
          reviewOperator,
          reviewerUid,
          reviewOperatorAccountFingerprint: reviewFingerprint,
          reviewerLocation: {
            ...reviewerLocation,
            serverReceivedAt: now,
          },
          reviewedAt: now,
          auditId: proposalId,
        });
        transaction.update(lockRef, {
          status,
          decision,
          reviewerUid,
          reviewedAt: now,
          auditId: proposalId,
        });
        transaction.set(rateRef, nextRate);
        if (decision === "approve") {
          transaction.update(geofenceRef, {
            lat: proposal.verifiedLat,
            lng: proposal.verifiedLng,
            radius: proposal.verifiedRadius,
            isActive: true,
            coordinateStatus: "verified",
            verifiedAt: now,
            verifiedBy: proposal.verifiedBy,
            verificationReviewedAt: now,
            verificationReviewedBy: reviewedBy,
            verificationEvidence: proposal.evidence,
            verificationOperator: proposal.operatorAccountFingerprint,
            verificationReviewOperator: reviewFingerprint,
            verificationAuditId: proposalId,
            presenceProofRequired: true,
            securityPolicyUpdatedAt: now,
          });
        }
        return {
          status,
          reviewerLocation,
          geofenceKey: context.geofenceKey,
        };
      });

      return {
        success: true,
        proposalId,
        auditId: proposalId,
        decision,
        status: result.status,
        geofenceActivated: decision === "approve",
        geofenceKey: result.geofenceKey,
        verifier: {
          distanceMeters: result.reviewerLocation.distanceMeters,
          accuracyMeters: result.reviewerLocation.accuracy,
          uncertaintyAdjustedDistanceMeters:
            result.reviewerLocation.uncertaintyAdjustedDistanceMeters,
        },
      };
    }, context);
  }

  return {
    proposeGeofenceVerification,
    reviewGeofenceVerification,
  };
}

module.exports = {
  PROPOSAL_TTL_MS,
  accountFingerprint,
  assertIndependentReviewer,
  assertPendingProposal,
  assertPhysicalLocation,
  calculateProposalFingerprint,
  createGeofenceVerificationHandlers,
  normalizeProposedGeofence,
  operatorIdentity,
  operatorLabel,
};
