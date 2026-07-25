"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const logger = require("firebase-functions/logger");
const core = require("./attendance-core");
const verification = require("./geofence-verification");

const timestamp = (milliseconds) => ({
  toMillis: () => milliseconds,
  toDate: () => new Date(milliseconds),
});

function fakeFirestore(initialDocuments) {
  const documents = new Map();
  let version = Date.now() - 10_000;
  for (const [path, data] of Object.entries(initialDocuments)) {
    documents.set(path, {data, updateTime: timestamp(version++)});
  }
  const reference = (collectionName, id) => ({
    path: `${collectionName}/${id}`,
  });
  const snapshot = (ref) => {
    const stored = documents.get(ref.path);
    return {
      exists: Boolean(stored),
      id: ref.path.split("/").pop(),
      updateTime: stored?.updateTime,
      data: () => stored?.data,
    };
  };
  const db = {
    collection: (collectionName) => ({
      doc: (id) => reference(collectionName, id),
    }),
    runTransaction: async (operation) => {
      const writes = [];
      const transaction = {
        get: async (ref) => snapshot(ref),
        create: (ref, data) => writes.push({type: "create", ref, data}),
        set: (ref, data) => writes.push({type: "set", ref, data}),
        update: (ref, data) => writes.push({type: "update", ref, data}),
      };
      const result = await operation(transaction);
      for (const write of writes) {
        const existing = documents.get(write.ref.path);
        if (write.type === "create" && existing) {
          throw new Error(`document exists: ${write.ref.path}`);
        }
        if (write.type === "update" && !existing) {
          throw new Error(`document missing: ${write.ref.path}`);
        }
        documents.set(write.ref.path, {
          data: write.type === "update" ?
            {...existing.data, ...write.data} : write.data,
          updateTime: timestamp(version++),
        });
      }
      return result;
    },
  };
  return {
    db,
    data: (path) => documents.get(path)?.data,
  };
}

const activeAdmin = () => ({
  accountStatus: "active",
  isActive: true,
  role: "admin",
  mustChangePassword: false,
});

function pendingProposal(overrides = {}) {
  const proposedAtMs = 1_750_000_000_000;
  const proposerUid = "admin-proposer-1";
  const proposalId =
    "kelurahan_kel-test_550e8400-e29b-41d4-a716-446655440000";
  const proposal = {
    schemaVersion: 1,
    action: "geofence_physical_verification",
    proposalId,
    status: "pending",
    geofenceCollection: "kelurahan",
    geofenceId: "kel-test",
    previousLat: -0.95,
    previousLng: 100.4,
    previousRadius: 100,
    lat: -0.9471,
    lng: 100.4172,
    radius: 100,
    verifiedLat: -0.9471,
    verifiedLng: 100.4172,
    verifiedRadius: 100,
    verifiedBy: verification.operatorLabel(proposerUid),
    evidence: "dual-gps-callable-v1",
    operator: verification.operatorIdentity(proposerUid),
    proposerUid,
    operatorAccountFingerprint:
      verification.accountFingerprint(proposerUid),
    sourceUpdateTime: "2025-06-15T15:05:00.000Z",
    proposerLocation: {
      lat: -0.9471,
      lng: 100.4172,
      accuracy: 10,
      capturedAt: proposedAtMs - 1000,
      source: "gps-high",
      distanceMeters: 0,
      uncertaintyAdjustedDistanceMeters: 10,
      serverReceivedAt: timestamp(proposedAtMs),
    },
    proposedAt: timestamp(proposedAtMs),
    expiresAt: timestamp(proposedAtMs + verification.PROPOSAL_TTL_MS),
  };
  Object.assign(proposal, overrides);
  proposal.proposalFingerprint =
    verification.calculateProposalFingerprint(proposal);
  if (Object.hasOwn(overrides, "proposalFingerprint")) {
    proposal.proposalFingerprint = overrides.proposalFingerprint;
  }
  return proposal;
}

test("proposed geofence input is numeric, bounded, and canonical", () => {
  assert.deepEqual(verification.normalizeProposedGeofence({
    collection: "kelurahan",
    geofenceId: "kel-test",
    lat: -0.9471,
    lng: 100.4172,
    radius: 100,
  }), {
    collection: "kelurahan",
    id: "kel-test",
    lat: -0.9471,
    lng: 100.4172,
    radius: 100,
  });
  assert.throws(() => verification.normalizeProposedGeofence({
    collection: "kelurahan",
    geofenceId: "kel-test",
    lat: "-0.9471",
    lng: 100.4172,
    radius: 100,
  }), (error) => error?.details?.reason === "GEOFENCE_INVALID");
  assert.throws(() => verification.normalizeProposedGeofence({
    collection: "kantor",
    geofenceId: "kantor-test",
    lat: -0.9471,
    lng: 100.4172,
    radius: 501,
  }), (error) => error?.details?.reason === "GEOFENCE_INVALID");
});

test("both operators must provide fresh accurate GPS inside proposed radius", () => {
  const nowMs = 1_750_000_000_000;
  const geofence = {lat: -0.9471, lng: 100.4172, radius: 100};
  const accepted = verification.assertPhysicalLocation({
    lat: -0.9472,
    lng: 100.4172,
    accuracy: 12,
    capturedAt: nowMs - 1000,
    source: "gps-high",
  }, nowMs, geofence);
  assert.ok(accepted.uncertaintyAdjustedDistanceMeters <= 100);

  assert.throws(() => verification.assertPhysicalLocation({
    lat: -0.9463,
    lng: 100.4172,
    accuracy: 20,
    capturedAt: nowMs,
    source: "gps-high",
  }, nowMs, geofence), (error) =>
    error?.details?.reason === "VERIFIER_OUTSIDE_GEOFENCE");
  assert.throws(() => verification.assertPhysicalLocation({
    lat: -0.9471,
    lng: 100.4172,
    accuracy: 10,
    capturedAt: nowMs - 121_000,
    source: "gps-high",
  }, nowMs, geofence), (error) => error?.reason === "LOCATION_STALE");
});

test("reviewer must use a different Firebase Auth UID", () => {
  assert.equal(verification.assertIndependentReviewer(
      "admin-proposer-1",
      "admin-reviewer-2",
  ), true);
  assert.throws(() => verification.assertIndependentReviewer(
      "admin-proposer-1",
      "admin-proposer-1",
  ), (error) => error?.details?.reason === "SAME_REVIEWER");
  assert.notEqual(
      verification.accountFingerprint("admin-proposer-1"),
      verification.accountFingerprint("admin-reviewer-2"),
  );
});

test("pending proposal is strict, fingerprint-bound, and GPS-bound", () => {
  const proposal = pendingProposal();
  const nowMs = proposal.proposedAt.toMillis() + 60_000;
  const checked = verification.assertPendingProposal(
      proposal,
      proposal.proposalId,
      nowMs,
  );
  assert.equal(checked.expiresAtMs,
      proposal.proposedAt.toMillis() + verification.PROPOSAL_TTL_MS);

  const tamperedCoordinates = pendingProposal({lat: -0.8, verifiedLat: -0.8});
  tamperedCoordinates.proposalFingerprint = proposal.proposalFingerprint;
  assert.throws(() => verification.assertPendingProposal(
      tamperedCoordinates,
      tamperedCoordinates.proposalId,
      nowMs,
  ), (error) =>
    error?.details?.reason === "PROPOSAL_FINGERPRINT_INVALID");

  const unexpectedField = pendingProposal();
  unexpectedField.attackerControlled = true;
  assert.throws(() => verification.assertPendingProposal(
      unexpectedField,
      unexpectedField.proposalId,
      nowMs,
  ), (error) => error?.details?.reason === "PROPOSAL_STATE_INVALID");
});

test("approved callable audit remains compatible with attendance invariant", () => {
  const proposal = pendingProposal();
  const reviewedAtMs = proposal.proposedAt.toMillis() + 60_000;
  const reviewerUid = "admin-reviewer-2";
  const geofenceData = {
    isActive: true,
    coordinateStatus: "verified",
    nama: "Kelurahan Test",
    lat: proposal.verifiedLat,
    lng: proposal.verifiedLng,
    radius: proposal.verifiedRadius,
    verifiedBy: proposal.verifiedBy,
    verificationEvidence: proposal.evidence,
    verificationOperator: proposal.operatorAccountFingerprint,
    verificationReviewedBy: verification.operatorLabel(reviewerUid),
    verificationReviewOperator:
      verification.accountFingerprint(reviewerUid),
    verificationAuditId: proposal.proposalId,
    presenceProofRequired: true,
  };
  const geofence = core.normalizeGeofence(
      geofenceData,
      proposal.geofenceId,
      reviewedAtMs,
      reviewedAtMs,
  );
  const audit = {
    schemaVersion: 2,
    action: "geofence_physical_verification",
    auditId: proposal.proposalId,
    status: "approved",
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
    proposalFingerprint: proposal.proposalFingerprint,
    proposedAt: proposal.proposedAt,
    reviewedBy: verification.operatorLabel(reviewerUid),
    reviewOperator: verification.operatorIdentity(reviewerUid),
    reviewOperatorAccountFingerprint:
      verification.accountFingerprint(reviewerUid),
    createdAt: timestamp(reviewedAtMs),
  };
  assert.equal(core.assertGeofenceAudit(
      audit,
      {collection: proposal.geofenceCollection, ...geofence},
      reviewedAtMs,
      proposal.proposedAt.toMillis(),
  ), true);
});

test("two callable handlers approve atomically with two active admin UIDs", async () => {
  const store = fakeFirestore({
    "users/admin-proposer-1": activeAdmin(),
    "users/admin-reviewer-2": activeAdmin(),
    "kelurahan/kel-test": {
      nama: "Kelurahan Test",
      lat: -0.95,
      lng: 100.4,
      radius: 100,
      isActive: false,
      coordinateStatus: "provisional",
    },
  });
  const firestore = () => store.db;
  firestore.Timestamp = {fromMillis: timestamp};
  const handlers = verification.createGeofenceVerificationHandlers({
    firestore,
  });
  const proposeNow = Date.now();
  const proposed = await handlers.proposeGeofenceVerification({
    auth: {uid: "admin-proposer-1"},
    app: {appId: "test-app", alreadyConsumed: false},
    data: {
      collection: "kelurahan",
      geofenceId: "kel-test",
      lat: -0.9471,
      lng: 100.4172,
      radius: 100,
      location: {
        lat: -0.9471,
        lng: 100.4172,
        accuracy: 10,
        capturedAt: proposeNow,
        source: "gps-high",
      },
    },
  });
  assert.equal(proposed.status, "pending");
  assert.match(proposed.proposalId, /^[A-Za-z0-9:_-]{1,128}$/);
  assert.equal(store.data("kelurahan/kel-test").isActive, false);
  const pendingPath =
    `geofenceVerificationProposals/${proposed.proposalId}`;
  assert.equal(store.data(pendingPath).lat, -0.9471);
  assert.equal(store.data(pendingPath).status, "pending");
  assert.equal(store.data(
      `geofenceVerificationAuditLogs/${proposed.proposalId}`,
  ), undefined);

  const reviewNow = Date.now();
  const reviewed = await handlers.reviewGeofenceVerification({
    auth: {uid: "admin-reviewer-2"},
    app: {appId: "test-app", alreadyConsumed: false},
    data: {
      proposalId: proposed.proposalId,
      decision: "approve",
      location: {
        lat: -0.9471,
        lng: 100.4172,
        accuracy: 9,
        capturedAt: reviewNow,
        source: "gps-high",
      },
    },
  });
  assert.equal(reviewed.status, "approved");
  assert.equal(reviewed.geofenceActivated, true);
  const active = store.data("kelurahan/kel-test");
  assert.equal(active.isActive, true);
  assert.equal(active.coordinateStatus, "verified");
  assert.notEqual(
      active.verificationOperator,
      active.verificationReviewOperator,
  );
  assert.equal(store.data(pendingPath).status, "approved");
  const audit = store.data(
      `geofenceVerificationAuditLogs/${proposed.proposalId}`,
  );
  assert.equal(audit.status, "approved");
  assert.equal(audit.auditId, proposed.proposalId);
  assert.equal(timestampMillisForTest(active.verifiedAt),
      timestampMillisForTest(audit.createdAt));
});

test("independent rejection closes proposal without activating geofence", async () => {
  const store = fakeFirestore({
    "users/admin-proposer-1": activeAdmin(),
    "users/admin-reviewer-2": activeAdmin(),
    "kantor/kantor-test": {
      nama: "Kantor Test",
      lat: -0.9471,
      lng: 100.4172,
      radius: 100,
      isActive: false,
      coordinateStatus: "provisional",
    },
  });
  const firestore = () => store.db;
  firestore.Timestamp = {fromMillis: timestamp};
  const handlers = verification.createGeofenceVerificationHandlers({
    firestore,
  });
  const proposed = await handlers.proposeGeofenceVerification({
    auth: {uid: "admin-proposer-1"},
    app: {appId: "test-app", alreadyConsumed: false},
    data: {
      collection: "kantor",
      geofenceId: "kantor-test",
      lat: -0.9471,
      lng: 100.4172,
      radius: 100,
      location: {
        lat: -0.9471,
        lng: 100.4172,
        accuracy: 8,
        capturedAt: Date.now(),
        source: "gps-high",
      },
    },
  });
  const rejected = await handlers.reviewGeofenceVerification({
    auth: {uid: "admin-reviewer-2"},
    app: {appId: "test-app", alreadyConsumed: false},
    data: {
      proposalId: proposed.proposalId,
      decision: "reject",
      location: {
        lat: -0.9471,
        lng: 100.4172,
        accuracy: 8,
        capturedAt: Date.now(),
        source: "gps-high",
      },
    },
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.geofenceActivated, false);
  assert.equal(store.data("kantor/kantor-test").isActive, false);
  assert.equal(store.data(
      `geofenceVerificationProposals/${proposed.proposalId}`,
  ).status, "rejected");
  assert.equal(store.data(
      `geofenceVerificationAuditLogs/${proposed.proposalId}`,
  ).status, "rejected");
});

function timestampMillisForTest(value) {
  return value?.toMillis();
}

test("App Check rejection telemetry never logs raw IDs or coordinates", async () => {
  const firestore = () => ({});
  firestore.Timestamp = {};
  const handlers = verification.createGeofenceVerificationHandlers({
    firestore,
  });
  const originalWarn = logger.warn;
  let event;
  logger.warn = (_message, payload) => {
    event = payload;
  };
  try {
    await assert.rejects(handlers.proposeGeofenceVerification({
      auth: {uid: "admin-sensitive-uid"},
      data: {
        collection: "kelurahan",
        geofenceId: "sensitive-geofence-id",
        lat: -0.9471,
        lng: 100.4172,
        radius: 100,
        location: {lat: -0.9471, lng: 100.4172},
      },
    }), (error) => error?.details?.reason === "APP_CHECK_REQUIRED");
  } finally {
    logger.warn = originalWarn;
  }
  const serialized = JSON.stringify(event);
  assert.equal(event.event, "geofence_verification_security_event");
  assert.equal(event.reason, "APP_CHECK_REQUIRED");
  assert.match(event.actorFingerprint, /^[0-9a-f]{20}$/);
  assert.match(event.geofenceFingerprint, /^[0-9a-f]{20}$/);
  assert.equal(serialized.includes("admin-sensitive-uid"), false);
  assert.equal(serialized.includes("sensitive-geofence-id"), false);
  assert.equal(serialized.includes("-0.9471"), false);
});
