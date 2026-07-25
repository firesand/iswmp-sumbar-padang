"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./attendance-core");
const corrections = require("./attendance-corrections");

const timestamp = (milliseconds) => ({
  toMillis: () => milliseconds,
  toDate: () => new Date(milliseconds),
});

function fakeFirestore(initialDocuments) {
  const documents = new Map();
  const baseVersionTime = Date.now() - 100_000;
  let nextVersion = 1;
  for (const [path, data] of Object.entries(initialDocuments)) {
    documents.set(path, {
      data,
      version: nextVersion,
      updateTime: timestamp(baseVersionTime + nextVersion),
    });
    nextVersion += 1;
  }

  const reference = (collectionName, id) => ({
    path: `${collectionName}/${id}`,
  });
  const makeSnapshot = (ref, stored) => ({
    exists: Boolean(stored),
    id: ref.path.split("/").pop(),
    updateTime: stored?.updateTime,
    data: () => stored?.data,
  });

  let commitTail = Promise.resolve();
  const commitAtomically = async (operation) => {
    let release;
    const previous = commitTail;
    commitTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  };

  const db = {
    collection: (collectionName) => ({
      doc: (id) => reference(collectionName, id),
    }),
    runTransaction: async (operation) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const reads = new Map();
        const writes = [];
        const transaction = {
          get: async (ref) => {
            const stored = documents.get(ref.path);
            reads.set(ref.path, stored?.version ?? null);
            return makeSnapshot(ref, stored);
          },
          create: (ref, data) => {
            writes.push({type: "create", ref, data});
          },
          set: (ref, data) => {
            writes.push({type: "set", ref, data});
          },
          update: (ref, data) => {
            writes.push({type: "update", ref, data});
          },
        };
        const result = await operation(transaction);
        const committed = await commitAtomically(() => {
          const staleRead = [...reads].some(([path, version]) =>
            (documents.get(path)?.version ?? null) !== version);
          if (staleRead) return false;

          for (const write of writes) {
            const existing = documents.get(write.ref.path);
            if (write.type === "create" && existing) return false;
            if (write.type === "update" && !existing) {
              throw new Error(`document missing: ${write.ref.path}`);
            }
          }
          for (const write of writes) {
            const existing = documents.get(write.ref.path);
            const data = write.type === "update" ?
              {...existing.data, ...write.data} : write.data;
            documents.set(write.ref.path, {
              data,
              version: nextVersion,
              updateTime: timestamp(baseVersionTime + nextVersion),
            });
            nextVersion += 1;
          }
          return true;
        });
        if (committed) return result;
      }
      throw new Error("transaction retry limit exceeded");
    },
  };

  return {
    db,
    count: (prefix) => [...documents.keys()]
        .filter((path) => path.startsWith(prefix)).length,
    data: (path) => documents.get(path)?.data,
    replace: (path, data) => {
      documents.set(path, {
        data,
        version: nextVersion,
        updateTime: timestamp(baseVersionTime + nextVersion),
      });
      nextVersion += 1;
    },
  };
}

function activeAdmin() {
  return {
    accountStatus: "active",
    isActive: true,
    role: "admin",
    mustChangePassword: false,
  };
}

function canonicalOpenAttendance(checkInMs, userId = "employee-1") {
  const challengeId = "550e8400-e29b-41d4-a716-446655440000";
  const workDate =
    core.getServerAttendanceStamp(new Date(checkInMs)).date;
  return {
    attendanceId: `${userId}_${workDate}`,
    data: {
      userId,
      userName: "Employee Test",
      date: workDate,
      checkIn: timestamp(checkInMs),
      checkInTime: new Date(checkInMs).toISOString(),
      checkInLocation: {
        lat: -0.9471,
        lng: 100.4172,
        accuracy: 10,
        capturedAt: checkInMs,
        source: "gps-high",
      },
      checkInPhoto: null,
      checkInPhotoPath: `attendanceProofs/${userId}/${challengeId}`,
      checkInPhotoGeneration: "123456789",
      checkInPhotoHash: "a".repeat(64),
      checkInPhotoPerceptualHash: "b".repeat(36),
      checkInPhotoPerceptualHashes:
        Array.from({length: core.PERCEPTUAL_HASH_VIEW_COUNT},
            (_, index) => index.toString(16).repeat(36)),
      checkInPhotoMd5Hash: "test-md5",
      checkInPhotoCrc32c: "test-crc32c",
      status: "ontime",
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
      workHours: 0,
      transitionMode: false,
      isWithinRadius: true,
      integrityVersion: 2,
      verificationStatus: "verified",
      proofVersion: 2,
      presenceProof: {
        required: true,
        verified: true,
        grantId: challengeId,
        coPresence: {verified: true},
      },
      geofenceSnapshot: {
        verificationAuditId:
          "kelurahan_test_550e8400-e29b-41d4-a716-446655440001",
        verificationOperator: "c".repeat(64),
        verificationReviewOperator: "d".repeat(64),
      },
      challengeIds: {checkIn: challengeId, checkOut: null},
      createdAt: timestamp(checkInMs),
      updatedAt: timestamp(checkInMs),
    },
  };
}

function correctionFixture({locationPhoto = false} = {}) {
  const nowMs = Date.now();
  const checkInMs = nowMs - 2 * 60 * 60 * 1000;
  const requestedCheckOutMs = nowMs - 60 * 60 * 1000;
  const attendance = canonicalOpenAttendance(checkInMs);
  if (locationPhoto) {
    attendance.data = {
      ...attendance.data,
      checkInLocation: {
        ...attendance.data.checkInLocation,
        serverReceivedAt: timestamp(checkInMs),
      },
      verificationMode: "location_photo",
      verificationStatus: "location_photo_only",
      transitionMode: true,
      isWithinRadius: null,
      deviceVerified: false,
      distanceFromGeofence: null,
      presenceProof: {
        required: false,
        verified: false,
        reason: "policy_location_photo",
      },
      geofenceSnapshot: null,
      assignmentSnapshot: {
        collection: "kantor",
        id: "kantor-padang-kota",
        name: "Kantor Proyek",
      },
    };
  }
  const documents = {
    "users/admin-proposer": activeAdmin(),
    "users/admin-reviewer-a": activeAdmin(),
    "users/admin-reviewer-b": activeAdmin(),
    [`attendances/${attendance.attendanceId}`]: attendance.data,
    [`attendanceOpenShifts/${attendance.data.userId}`]: {
      schemaVersion: 1,
      uid: attendance.data.userId,
      revision: 3,
      status: "open",
      attendanceId: attendance.attendanceId,
      workDate: attendance.data.date,
      checkInAt: attendance.data.checkIn,
      closedAt: null,
      createdAt: timestamp(checkInMs),
      updatedAt: timestamp(checkInMs),
    },
    "projectConfig/default": {
      jamCheckInDeadline: "08:00",
      attendanceSecurityVersion: 2,
      geofenceTransitionMode: false,
      attendanceSecurityCutoverAt: timestamp(nowMs - 60_000),
      maxAttendanceShiftDurationMinutes: 1440,
    },
  };
  const store = fakeFirestore(documents);
  const firestore = () => store.db;
  firestore.Timestamp = {fromMillis: timestamp};
  return {
    attendance,
    checkInMs,
    handlers: corrections.createAttendanceCorrectionHandlers({firestore}),
    requestedCheckOutIso: new Date(requestedCheckOutMs).toISOString(),
    requestedCheckOutMs,
    store,
  };
}

async function propose(fixture, overrides = {}) {
  return fixture.handlers.proposeMissingCheckoutCorrection({
    auth: {uid: "admin-proposer"},
    app: {appId: "test-app", alreadyConsumed: false},
    data: {
      attendanceId: fixture.attendance.attendanceId,
      checkOutAt: fixture.requestedCheckOutIso,
      reason: "Perangkat mati saat jadwal check-out.",
      ...overrides,
    },
  });
}

async function review(fixture, proposalId, reviewerUid, decision = "approve") {
  return fixture.handlers.reviewAttendanceCorrection({
    auth: {uid: reviewerUid},
    app: {appId: "test-app", alreadyConsumed: false},
    data: {proposalId, decision},
  });
}

test("normalizers enforce a narrow reason and UTC timestamp contract", () => {
  assert.equal(
      corrections.normalizeReason("  Perangkat pegawai mati.  "),
      "Perangkat pegawai mati.",
  );
  assert.throws(
      () => corrections.normalizeReason("singkat"),
      (error) => error?.details?.reason === "REASON_INVALID",
  );
  assert.throws(
      () => corrections.normalizeRequestedCheckOut(
          "2026-07-23T17:00:00+07:00",
      ),
      (error) => error?.details?.reason === "CHECKOUT_TIME_INVALID",
  );
  assert.deepEqual(
      corrections.normalizeRequestedCheckOut(
          "2026-07-23T10:00:00.000Z",
      ),
      {
        iso: "2026-07-23T10:00:00.000Z",
        milliseconds: Date.parse("2026-07-23T10:00:00.000Z"),
      },
  );
});

test("dual approval creates append-only manual artifacts and closes pointer", async () => {
  const fixture = correctionFixture();
  const attendancePath =
    `attendances/${fixture.attendance.attendanceId}`;
  const attendanceBefore = fixture.store.data(attendancePath);
  const proposed = await propose(fixture);
  const proposalPath =
    `attendanceCorrectionProposals/${proposed.proposalId}`;
  const proposalBefore = fixture.store.data(proposalPath);

  assert.equal(proposed.status, "pending");
  assert.equal(proposed.deviceVerified, false);
  assert.equal(proposalBefore.baseRevision, 3);
  assert.equal(proposalBefore.manualCorrection, true);
  assert.equal(proposalBefore.deviceVerified, false);
  assert.match(proposalBefore.baseFingerprint, /^[0-9a-f]{64}$/);

  const approved = await review(
      fixture,
      proposed.proposalId,
      "admin-reviewer-a",
  );
  assert.equal(approved.status, "approved");
  assert.equal(approved.deviceVerified, false);
  assert.equal(approved.canonicalAttendanceChanged, false);
  assert.deepEqual(fixture.store.data(proposalPath), proposalBefore);
  assert.deepEqual(fixture.store.data(attendancePath), attendanceBefore);

  const event = fixture.store.data(
      `attendanceCorrectionEvents/${proposed.proposalId}`,
  );
  assert.equal(event.action, "attendance_missing_checkout_corrected");
  assert.equal(event.manualCorrection, true);
  assert.equal(event.deviceVerified, false);
  assert.equal(event.canonicalAttendanceChanged, false);
  assert.equal(event.revision, 1);
  assert.equal(event.baseShiftRevision, 3);

  const effective = fixture.store.data(
      `attendanceCorrectionEffectiveViews/${fixture.attendance.attendanceId}`,
  );
  assert.equal(effective.completionSource, corrections.CORRECTION_SOURCE);
  assert.equal(effective.manualCorrection, true);
  assert.equal(effective.deviceVerified, false);
  assert.equal(effective.effectiveCheckOut.toMillis(),
      fixture.requestedCheckOutMs);
  assert.equal(Object.hasOwn(effective, "reason"), false);
  assert.equal(Object.hasOwn(effective, "reviewerUid"), false);
  assert.equal(Object.hasOwn(effective, "verificationStatus"), false);

  const pointer = fixture.store.data(
      `attendanceOpenShifts/${fixture.attendance.data.userId}`,
  );
  assert.equal(pointer.status, "closed");
  assert.equal(pointer.revision, 3);
  assert.equal(pointer.closedAt.toMillis(), fixture.requestedCheckOutMs);
  assert.equal(pointer.closureSource, "administrative-correction");
  assert.equal(pointer.correctionId, proposed.proposalId);
});

test("location-photo open shift remains eligible for dual-admin correction", async () => {
  const fixture = correctionFixture({locationPhoto: true});
  const proposed = await propose(fixture);
  const approved = await review(
      fixture,
      proposed.proposalId,
      "admin-reviewer-a",
  );

  assert.equal(approved.status, "approved");
  assert.equal(approved.deviceVerified, false);
  const pointer = fixture.store.data(
      `attendanceOpenShifts/${fixture.attendance.data.userId}`,
  );
  assert.equal(pointer.status, "closed");
  assert.equal(pointer.closureSource, "administrative-correction");
  const effective = fixture.store.data(
      `attendanceCorrectionEffectiveViews/${fixture.attendance.attendanceId}`,
  );
  assert.equal(effective.deviceVerified, false);
  assert.equal(effective.canonicalAttendanceChanged, false);
});

test("proposer cannot approve or reject their own proposal", async () => {
  const fixture = correctionFixture();
  const proposed = await propose(fixture);
  await assert.rejects(
      review(fixture, proposed.proposalId, "admin-proposer"),
      (error) => error?.details?.reason === "SAME_REVIEWER",
  );
  assert.equal(fixture.store.data(
      `attendanceCorrectionDecisions/${proposed.proposalId}`,
  ), undefined);
  assert.equal(fixture.store.data(
      `attendanceOpenShifts/${fixture.attendance.data.userId}`,
  ).status, "open");
});

test("two concurrent reviewers can produce only one decision", async () => {
  const fixture = correctionFixture();
  const proposed = await propose(fixture);
  const outcomes = await Promise.allSettled([
    review(fixture, proposed.proposalId, "admin-reviewer-a"),
    review(fixture, proposed.proposalId, "admin-reviewer-b"),
  ]);
  assert.equal(outcomes.filter((outcome) =>
    outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) =>
    outcome.status === "rejected" &&
    outcome.reason?.details?.reason ===
      "PROPOSAL_ALREADY_REVIEWED").length, 1);
  assert.equal(fixture.store.count("attendanceCorrectionDecisions/"), 1);
  assert.equal(fixture.store.count("attendanceCorrectionEvents/"), 1);
  assert.equal(fixture.store.count("attendanceCorrectionEffectiveViews/"), 1);
});

test("approval fails stale when canonical attendance changes", async () => {
  const fixture = correctionFixture();
  const proposed = await propose(fixture);
  const attendancePath =
    `attendances/${fixture.attendance.attendanceId}`;
  fixture.store.replace(attendancePath, {
    ...fixture.store.data(attendancePath),
    updatedAt: timestamp(Date.now()),
  });
  await assert.rejects(
      review(fixture, proposed.proposalId, "admin-reviewer-a"),
      (error) => error?.details?.reason === "ATTENDANCE_CHANGED",
  );
  assert.equal(fixture.store.count("attendanceCorrectionDecisions/"), 0);
  assert.equal(fixture.store.count("attendanceCorrectionEvents/"), 0);
});

test("approval fails stale when open shift revision changes", async () => {
  const fixture = correctionFixture();
  const proposed = await propose(fixture);
  const pointerPath =
    `attendanceOpenShifts/${fixture.attendance.data.userId}`;
  fixture.store.replace(pointerPath, {
    ...fixture.store.data(pointerPath),
    revision: 4,
  });
  await assert.rejects(
      review(fixture, proposed.proposalId, "admin-reviewer-a"),
      (error) => error?.details?.reason === "OPEN_SHIFT_CHANGED",
  );
  assert.equal(fixture.store.count("attendanceCorrectionDecisions/"), 0);
  assert.equal(fixture.store.data(pointerPath).status, "open");
});

test("forbidden request fields cannot forge verification semantics", async () => {
  const fixture = correctionFixture();
  await assert.rejects(
      propose(fixture, {verificationStatus: "verified"}),
      (error) => error?.details?.reason === "INVALID_REQUEST",
  );
  assert.equal(fixture.store.count("attendanceCorrectionProposals/"), 0);
  assert.equal(fixture.store.count("attendanceCorrectionEvents/"), 0);
});

test("proposal requires App Check and an active administrator", async () => {
  const fixture = correctionFixture();
  await assert.rejects(
      fixture.handlers.proposeMissingCheckoutCorrection({
        auth: {uid: "admin-proposer"},
        data: {
          attendanceId: fixture.attendance.attendanceId,
          checkOutAt: fixture.requestedCheckOutIso,
          reason: "Perangkat mati saat jadwal check-out.",
        },
      }),
      (error) => error?.details?.reason === "APP_CHECK_REQUIRED",
  );
  fixture.store.replace("users/admin-proposer", {
    ...activeAdmin(),
    isActive: false,
  });
  await assert.rejects(
      propose(fixture),
      (error) => error?.details?.reason === "ADMIN_REQUIRED",
  );
  assert.equal(fixture.store.count("attendanceCorrectionProposals/"), 0);
});

test("missing or unsafe shared duration configuration fails closed", async () => {
  const fixture = correctionFixture();
  fixture.store.replace("projectConfig/default", {
    ...fixture.store.data("projectConfig/default"),
    maxAttendanceShiftDurationMinutes: 1441,
  });
  await assert.rejects(
      propose(fixture),
      (error) => error?.details?.reason === "SHIFT_POLICY_INVALID",
  );
  assert.equal(fixture.store.count("attendanceCorrectionProposals/"), 0);
});

test("inactive attendance security cutover blocks corrections", async () => {
  const fixture = correctionFixture();
  fixture.store.replace("projectConfig/default", {
    ...fixture.store.data("projectConfig/default"),
    geofenceTransitionMode: true,
  });
  await assert.rejects(
      propose(fixture),
      (error) =>
        error?.details?.reason === "ATTENDANCE_SECURITY_POLICY_INACTIVE",
  );
  assert.equal(fixture.store.count("attendanceCorrectionProposals/"), 0);
});

test("requested checkout must be within configured shift duration", async () => {
  const fixture = correctionFixture();
  const beyondMaximum = new Date(
      fixture.checkInMs + (1440 * 60 * 1000) + 1,
  ).toISOString();
  await assert.rejects(
      propose(fixture, {checkOutAt: beyondMaximum}),
      (error) =>
        error?.details?.reason === "CHECKOUT_TIME_OUT_OF_RANGE",
  );
  assert.equal(fixture.store.count("attendanceCorrectionProposals/"), 0);
});

test("rejection is final but never creates an effective correction", async () => {
  const fixture = correctionFixture();
  const proposed = await propose(fixture);
  const rejected = await review(
      fixture,
      proposed.proposalId,
      "admin-reviewer-a",
      "reject",
  );
  assert.equal(rejected.status, "rejected");
  await assert.rejects(
      review(fixture, proposed.proposalId, "admin-reviewer-b"),
      (error) =>
        error?.details?.reason === "PROPOSAL_ALREADY_REVIEWED",
  );
  assert.equal(fixture.store.count("attendanceCorrectionDecisions/"), 1);
  assert.equal(fixture.store.count("attendanceCorrectionEvents/"), 0);
  assert.equal(fixture.store.count("attendanceCorrectionEffectiveViews/"), 0);
  assert.equal(fixture.store.data(
      `attendanceOpenShifts/${fixture.attendance.data.userId}`,
  ).status, "open");
});

test("tampered immutable proposal is rejected before approval", async () => {
  const fixture = correctionFixture();
  const proposed = await propose(fixture);
  const proposalPath =
    `attendanceCorrectionProposals/${proposed.proposalId}`;
  fixture.store.replace(proposalPath, {
    ...fixture.store.data(proposalPath),
    deviceVerified: true,
  });
  await assert.rejects(
      review(fixture, proposed.proposalId, "admin-reviewer-a"),
      (error) => error?.details?.reason === "PROPOSAL_STATE_INVALID",
  );
  assert.equal(fixture.store.count("attendanceCorrectionDecisions/"), 0);
});
