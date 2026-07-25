"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const {
  EARLY_LEAVE_REASON_MAX_LENGTH,
  assertChallengeTarget,
  assertOpenShiftState,
  assertShiftCheckoutWindow,
  createAttendanceHandlers,
  isEarlyLeaveCheckout,
  maxShiftDurationMs,
  normalizeEarlyLeaveReason,
  VERIFICATION_MODE_LOCATION_PHOTO,
} = require("./attendance");
const core = require("./attendance-core");

const timestamp = (millis) => ({
  toMillis: () => millis,
  toDate: () => new Date(millis),
});
const uid = "employee-overnight";
const nowMs = Date.parse("2027-01-01T00:00:00.000Z");
const activePolicy = (overrides = {}) => ({
  attendanceSecurityVersion: 2,
  geofenceTransitionMode: false,
  attendanceSecurityCutoverAt: timestamp(nowMs - 60_000),
  maxAttendanceShiftDurationMinutes: 1440,
  ...overrides,
});

const EMPTY_ALLOWED_LOCATIONS_DIGEST =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

const locationPhotoPolicy = (fixtureNowMs, overrides = {}) => activePolicy({
  attendanceSecurityCutoverAt: timestamp(fixtureNowMs - 60_000),
  attendanceVerificationMode: VERIFICATION_MODE_LOCATION_PHOTO,
  locationPhotoModePolicyVersion: 1,
  locationPhotoModeEnabledAt: timestamp(fixtureNowMs - 60 * 60_000),
  locationPhotoModeExpiresAt: timestamp(fixtureNowMs + 24 * 60 * 60_000),
  locationPhotoAllowedLocations: [],
  locationPhotoAllowedLocationsVersion: 0,
  locationPhotoAllowedLocationsDigest: EMPTY_ALLOWED_LOCATIONS_DIGEST,
  ...overrides,
});

const provisionalAssignmentLocation = {
  nama: "Kelurahan Test",
  isActive: false,
  coordinateStatus: "provisional",
  lat: -6.2,
  lng: 106.8,
  radius: 300,
};

function openShift(overrides = {}) {
  return {
    schemaVersion: 1,
    uid,
    revision: 3,
    status: "open",
    attendanceId: `${uid}_2026-12-31`,
    workDate: "2026-12-31",
    checkInAt: timestamp(Date.parse("2026-12-31T16:55:00.000Z")),
    closedAt: null,
    ...overrides,
  };
}

function fakeAdmin(initialDocuments, bucket = null) {
  const documents = new Map(Object.entries(initialDocuments));
  const reference = (path) => ({
    id: path.split("/").pop(),
    path,
    get: async () => snapshot(path),
  });
  const snapshot = (path) => ({
    exists: documents.has(path),
    id: path.split("/").pop(),
    data: () => documents.get(path),
  });
  const db = {
    collection: (collectionName) => ({
      doc: (id) => reference(`${collectionName}/${id}`),
    }),
    doc: (path) => reference(path),
    runTransaction: async (operation) => {
      const writes = [];
      const transaction = {
        get: async (ref) => snapshot(ref.path),
        create: (ref, data) => writes.push({
          type: "create",
          path: ref.path,
          data,
        }),
        set: (ref, data) => writes.push({
          type: "set",
          path: ref.path,
          data,
        }),
        update: (ref, data) => writes.push({
          type: "update",
          path: ref.path,
          data,
        }),
      };
      const result = await operation(transaction);
      for (const write of writes) {
        const current = documents.get(write.path);
        if (write.type === "create" && current) {
          throw new Error(`document exists: ${write.path}`);
        }
        if (write.type === "update" && !current) {
          throw new Error(`document missing: ${write.path}`);
        }
        documents.set(
            write.path,
            write.type === "update" ? {...current, ...write.data} : write.data,
        );
      }
      return result;
    },
  };
  const firestore = () => db;
  firestore.Timestamp = {fromMillis: timestamp};
  return {
    admin: {
      firestore,
      storage: () => ({
        bucket: () => bucket,
      }),
    },
    data: (path) => documents.get(path),
    paths: (prefix) => [...documents.keys()]
        .filter((path) => path.startsWith(prefix)),
  };
}

function activeEmployee() {
  return {
    accountStatus: "active",
    isActive: true,
    mustChangePassword: false,
    role: "field_staff",
    assignmentType: "kelurahan",
    kelurahanId: "kel-test",
  };
}

function verifiedAttendance(checkInMs, workDate = "2026-12-31") {
  return {
    userId: uid,
    date: workDate,
    integrityVersion: 2,
    verificationStatus: "verified",
    transitionMode: false,
    proofVersion: 2,
    isWithinRadius: true,
    checkIn: timestamp(checkInMs),
    checkOut: null,
    challengeIds: {
      checkIn: "11111111-1111-4111-8111-111111111111",
      checkOut: null,
    },
    checkInPhotoPath: `attendanceProofs/${uid}/check-in-proof`,
    checkInPhotoGeneration: "1",
    checkInPhotoHash: "a".repeat(64),
    checkInPhotoPerceptualHash: "0".repeat(
        core.PERCEPTUAL_HASH_HEX_LENGTH,
    ),
    checkInPhotoPerceptualHashes: Array(
        core.PERCEPTUAL_HASH_VIEW_COUNT,
    ).fill("0".repeat(core.PERCEPTUAL_HASH_HEX_LENGTH)),
    presenceProof: {
      required: true,
      verified: true,
      grantId: "check-in-grant",
      coPresence: {verified: true},
    },
    geofenceSnapshot: {
      verificationAuditId: "verified-audit",
      verificationOperator: "1".repeat(64),
      verificationReviewOperator: "2".repeat(64),
    },
  };
}

const locationPhotoCheckInChallengeId =
  "44444444-4444-4444-8444-444444444444";

function locationPhotoAttendance(checkInMs, workDate = "2026-12-31") {
  return {
    userId: uid,
    date: workDate,
    integrityVersion: 2,
    proofVersion: 2,
    verificationMode: VERIFICATION_MODE_LOCATION_PHOTO,
    verificationStatus: "location_photo_only",
    transitionMode: true,
    isWithinRadius: null,
    deviceVerified: false,
    distanceFromGeofence: null,
    geofenceSnapshot: null,
    assignmentSnapshot: {
      collection: "kelurahan",
      id: "kel-test",
      name: "Kelurahan Test",
    },
    checkIn: timestamp(checkInMs),
    checkInLocation: {
      lat: -6.2,
      lng: 106.8,
      accuracy: 12,
      capturedAt: checkInMs,
      source: "gps-high",
      serverReceivedAt: timestamp(checkInMs),
    },
    checkOut: null,
    challengeIds: {
      checkIn: locationPhotoCheckInChallengeId,
      checkOut: null,
    },
    checkInPhotoPath:
      `attendanceProofs/${uid}/${locationPhotoCheckInChallengeId}`,
    checkInPhotoGeneration: "1",
    checkInPhotoHash: "a".repeat(64),
    checkInPhotoPerceptualHash: "0".repeat(
        core.PERCEPTUAL_HASH_HEX_LENGTH,
    ),
    checkInPhotoPerceptualHashes: Array(
        core.PERCEPTUAL_HASH_VIEW_COUNT,
    ).fill("0".repeat(core.PERCEPTUAL_HASH_HEX_LENGTH)),
    checkInPhotoMd5Hash: "test-md5",
    checkInPhotoCrc32c: "test-crc32c",
    presenceProof: {
      required: false,
      verified: false,
      reason: "policy_location_photo",
    },
    status: "ontime",
    workHours: 0,
  };
}

function verifiedGeofenceDocuments(verifiedAtMs) {
  const auditId =
    "kelurahan_kel-test_22222222-2222-4222-8222-222222222222";
  const geofence = {
    isActive: true,
    coordinateStatus: "verified",
    lat: -0.95,
    lng: 100.36,
    radius: 300,
    nama: "Kelurahan Test",
    presenceProofRequired: true,
    verifiedAt: timestamp(verifiedAtMs),
    verifiedBy: "Petugas Lapangan",
    verificationReviewedAt: timestamp(verifiedAtMs),
    verificationReviewedBy: "Reviewer Lapangan",
    verificationEvidence: "BA pemeriksaan lapangan 001",
    verificationOperator: "1".repeat(64),
    verificationReviewOperator: "2".repeat(64),
    verificationAuditId: auditId,
  };
  const audit = {
    schemaVersion: 2,
    action: "geofence_physical_verification",
    auditId,
    status: "approved",
    geofenceCollection: "kelurahan",
    geofenceId: "kel-test",
    verifiedLat: geofence.lat,
    verifiedLng: geofence.lng,
    verifiedRadius: geofence.radius,
    verifiedBy: geofence.verifiedBy,
    reviewedBy: geofence.verificationReviewedBy,
    evidence: geofence.verificationEvidence,
    operator: "security.operator@example.test",
    reviewOperator: "review.operator@example.test",
    operatorAccountFingerprint: geofence.verificationOperator,
    reviewOperatorAccountFingerprint:
      geofence.verificationReviewOperator,
    proposedAt: timestamp(verifiedAtMs - 1000),
    createdAt: timestamp(verifiedAtMs),
  };
  return {
    "kelurahan/kel-test": geofence,
    [`geofenceVerificationAuditLogs/${auditId}`]: audit,
  };
}

const checkoutChallengeId = "33333333-3333-4333-8333-333333333333";

function pendingCheckoutChallenge(fixtureNowMs, overrides = {}) {
  const workDate = "2026-12-31";
  return {
    uid,
    action: "checkOut",
    status: "pending",
    photoPath: `attendanceProofs/${uid}/${checkoutChallengeId}`,
    createdAt: timestamp(fixtureNowMs - 60_000),
    expiresAt: timestamp(fixtureNowMs + 4 * 60_000),
    consumedAt: null,
    attendanceId: null,
    requestDate: "2027-01-01",
    targetAttendanceId: `${uid}_${workDate}`,
    targetWorkDate: workDate,
    targetShiftRevision: 3,
    submitAttempts: 0,
    lastSubmitAttemptAt: null,
    geofenceCollection: "kelurahan",
    geofenceId: "kel-test",
    presenceProofRequired: true,
    appId: "test-app",
    ...overrides,
  };
}

function locationPhotoPolicyChallengeFields(fixtureNowMs) {
  return {
    verificationMode: VERIFICATION_MODE_LOCATION_PHOTO,
    policySecurityVersion: 2,
    locationPhotoModePolicyVersion: 1,
    locationPhotoModeEnabledAt: timestamp(fixtureNowMs - 60 * 60_000),
    locationPhotoModeExpiresAt:
      timestamp(fixtureNowMs + 24 * 60 * 60_000),
    locationPhotoAllowedLocationsVersion: 0,
    locationPhotoAllowedLocationsDigest: EMPTY_ALLOWED_LOCATIONS_DIGEST,
    assignmentCollection: "kelurahan",
    assignmentId: "kel-test",
    presenceProofRequired: false,
  };
}

function pendingLocationPhotoCheckInChallenge(fixtureNowMs) {
  const workDate = "2027-01-01";
  return {
    uid,
    action: "checkIn",
    status: "pending",
    photoPath:
      `attendanceProofs/${uid}/${locationPhotoCheckInChallengeId}`,
    createdAt: timestamp(fixtureNowMs - 60_000),
    expiresAt: timestamp(fixtureNowMs + 4 * 60_000),
    consumedAt: null,
    attendanceId: null,
    requestDate: workDate,
    targetAttendanceId: `${uid}_${workDate}`,
    targetWorkDate: workDate,
    targetShiftRevision: 1,
    submitAttempts: 0,
    lastSubmitAttemptAt: null,
    geofenceCollection: "kelurahan",
    geofenceId: "kel-test",
    appId: "test-app",
    ...locationPhotoPolicyChallengeFields(fixtureNowMs),
  };
}

function matchingChallengeLock(challenge) {
  return {
    uid,
    action: "checkOut",
    challengeId: checkoutChallengeId,
    status: "pending",
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
  };
}

function matchingCheckInChallengeLock(challenge) {
  return {
    uid,
    action: "checkIn",
    challengeId: locationPhotoCheckInChallengeId,
    status: "pending",
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
  };
}

let photoBufferPromise;
function validPhotoBuffer() {
  if (!photoBufferPromise) {
    const width = 640;
    const height = 480;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 3;
        const block =
          ((Math.floor(x / 40) + Math.floor(y / 32)) % 2) * 55;
        pixels[index] = (35 + Math.floor(x / width * 130) + block) % 256;
        pixels[index + 1] =
          (25 + Math.floor(y / height * 150) + block) % 256;
        pixels[index + 2] =
          (50 + Math.floor((x + y) / (width + height) * 120) +
            block) % 256;
      }
    }
    photoBufferPromise = sharp(pixels, {
      raw: {width, height, channels: 3},
    }).jpeg({quality: 100, chromaSubsampling: "4:4:4"}).toBuffer();
  }
  return photoBufferPromise;
}

async function fakePhotoBucket(fixtureNowMs, options = {}) {
  const buffer = await validPhotoBuffer();
  const challengeId = options.challengeId || checkoutChallengeId;
  const action = options.action || "checkOut";
  return {
    file: (path) => {
      const metadata = {
        name: path,
        contentType: "image/jpeg",
        metadata: {
          challengeId,
          uid,
          action,
        },
        timeCreated: new Date(fixtureNowMs - 30_000).toISOString(),
        generation: "1",
        metageneration: "1",
        size: String(buffer.length),
        md5Hash: "test-md5",
        crc32c: "test-crc32c",
      };
      return {
        getMetadata: async () => [metadata],
        download: async () => [buffer],
        getSignedUrl: async () => [
          `https://storage.example.test/${encodeURIComponent(path)}`,
        ],
      };
    },
  };
}

function submitFixtureDocuments(fixtureNowMs, overrides = {}) {
  const challenge = pendingCheckoutChallenge(fixtureNowMs);
  const checkInMs = fixtureNowMs - 10 * 60_000;
  return {
    [`attendanceChallenges/${checkoutChallengeId}`]: challenge,
    [`attendanceChallengeLocks/${uid}_checkOut`]:
      matchingChallengeLock(challenge),
    [`users/${uid}`]: activeEmployee(),
    "projectConfig/default": activePolicy({
      attendanceSecurityCutoverAt: timestamp(fixtureNowMs - 60_000),
    }),
    [`attendanceOpenShifts/${uid}`]: openShift({
      checkInAt: timestamp(checkInMs),
    }),
    ...overrides,
  };
}

function checkoutRequest(fixtureNowMs, presenceCode = "123456") {
  return {
    auth: {uid},
    app: {appId: "test-app", alreadyConsumed: false},
    data: {
      challengeId: checkoutChallengeId,
      location: {
        lat: -0.95,
        lng: 100.36,
        accuracy: 10,
        capturedAt: fixtureNowMs,
        source: "gps-high",
      },
      presenceCode,
    },
  };
}

function locationPhotoRequest(
    fixtureNowMs,
    action = "checkOut",
    challengeId = checkoutChallengeId,
    earlyLeaveReason,
) {
  const request = {
    auth: {uid},
    app: {appId: "test-app", alreadyConsumed: false},
    data: {
      challengeId,
      location: {
        lat: -6.2,
        lng: 106.8,
        accuracy: 10,
        capturedAt: fixtureNowMs,
        source: "gps-high",
      },
    },
    expectedAction: action,
  };
  if (earlyLeaveReason !== undefined) {
    request.data.earlyLeaveReason = earlyLeaveReason;
  }
  return request;
}

async function locationPhotoCheckoutFixture(
    fixtureNowMs,
    earlyLeaveReason,
) {
  const checkInMs = fixtureNowMs - 2 * 60 * 60_000;
  const requestDate = core.getServerAttendanceStamp(
      new Date(fixtureNowMs),
  ).date;
  const challenge = pendingCheckoutChallenge(fixtureNowMs, {
    ...locationPhotoPolicyChallengeFields(fixtureNowMs),
    requestDate,
  });
  const documents = {
    [`attendanceChallenges/${checkoutChallengeId}`]: challenge,
    [`attendanceChallengeLocks/${uid}_checkOut`]:
      matchingChallengeLock(challenge),
    [`users/${uid}`]: activeEmployee(),
    "projectConfig/default": locationPhotoPolicy(fixtureNowMs),
    [`attendanceOpenShifts/${uid}`]: openShift({
      checkInAt: timestamp(checkInMs),
    }),
    [`attendances/${uid}_2026-12-31`]:
      locationPhotoAttendance(checkInMs),
    "kelurahan/kel-test": provisionalAssignmentLocation,
  };
  const bucket = await fakePhotoBucket(fixtureNowMs);
  const fake = fakeAdmin(documents, bucket);
  const handlers = createAttendanceHandlers(fake.admin);
  const request = locationPhotoRequest(
      fixtureNowMs,
      "checkOut",
      checkoutChallengeId,
      earlyLeaveReason,
  );
  return {fake, handlers, request};
}

async function withFixedNow(fixtureNowMs, operation) {
  const originalNow = Date.now;
  Date.now = () => fixtureNowMs;
  try {
    return await operation();
  } finally {
    Date.now = originalNow;
  }
}

test("shift policy is explicit and bounded to 1-24 hours", () => {
  assert.equal(
      maxShiftDurationMs(activePolicy(), nowMs),
      24 * 60 * 60 * 1000,
  );
  assert.throws(
      () => maxShiftDurationMs(
          activePolicy({attendanceSecurityVersion: 1}),
          nowMs,
      ),
      (error) =>
        error?.details?.reason === "ATTENDANCE_SECURITY_POLICY_INACTIVE",
  );
  assert.throws(
      () => maxShiftDurationMs(
          activePolicy({maxAttendanceShiftDurationMinutes: 1441}),
          nowMs,
      ),
      (error) => error?.details?.reason === "SHIFT_POLICY_INVALID",
  );
  assert.throws(
      () => maxShiftDurationMs(
          activePolicy({
            attendanceSecurityCutoverAt: timestamp(nowMs + 1),
          }),
          nowMs,
      ),
      (error) =>
        error?.details?.reason === "ATTENDANCE_SECURITY_POLICY_INACTIVE",
  );
});

test("location-photo challenge accepts an inactive assigned location only",
    async () => {
      const fixtureNowMs = nowMs;
      const documents = {
        [`users/${uid}`]: activeEmployee(),
        "projectConfig/default": locationPhotoPolicy(fixtureNowMs),
        "kelurahan/kel-test": provisionalAssignmentLocation,
      };
      const fake = fakeAdmin(documents);
      const handlers = createAttendanceHandlers(fake.admin);

      const result = await withFixedNow(
          fixtureNowMs,
          () => handlers.createAttendanceChallenge({
            auth: {uid},
            app: {appId: "test-app"},
            data: {action: "checkIn"},
          }),
      );

      assert.equal(result.verificationMode, VERIFICATION_MODE_LOCATION_PHOTO);
      assert.equal(result.presenceProofRequired, false);
      assert.equal(result.geofence, null);
      assert.deepEqual(result.assignment, {
        collection: "kelurahan",
        id: "kel-test",
        name: "Kelurahan Test",
      });
      assert.ok(Date.parse(result.verificationModeExpiresAt) > fixtureNowMs);
      const challengePath = fake.paths("attendanceChallenges/")[0];
      const challenge = fake.data(challengePath);
      assert.equal(challenge.verificationMode,
          VERIFICATION_MODE_LOCATION_PHOTO);
      assert.equal(challenge.policySecurityVersion, 2);
      assert.equal(challenge.locationPhotoModePolicyVersion, 1);
      assert.equal(challenge.assignmentCollection, "kelurahan");
      assert.equal(challenge.assignmentId, "kel-test");
      assert.equal(challenge.presenceProofRequired, false);
      assert.equal(
          fake.paths("geofenceVerificationAuditLogs/").length,
          0,
      );
    });

test("expired location-photo policy rejects a new check-in challenge",
    async () => {
      const fixtureNowMs = nowMs;
      const documents = {
        [`users/${uid}`]: activeEmployee(),
        "projectConfig/default": locationPhotoPolicy(fixtureNowMs, {
          locationPhotoModeEnabledAt:
            timestamp(fixtureNowMs - 2 * 60 * 60_000),
          locationPhotoModeExpiresAt: timestamp(fixtureNowMs - 1),
        }),
        "kelurahan/kel-test": provisionalAssignmentLocation,
      };
      const fake = fakeAdmin(documents);
      const handlers = createAttendanceHandlers(fake.admin);

      await assert.rejects(
          withFixedNow(
              fixtureNowMs,
              () => handlers.createAttendanceChallenge({
                auth: {uid},
                app: {appId: "test-app"},
                data: {action: "checkIn"},
              }),
          ),
          (error) => error?.details?.reason ===
            "LOCATION_PHOTO_MODE_EXPIRED",
      );
      assert.equal(fake.paths("attendanceChallenges/").length, 0);
    });

test("location-photo challenge still requires the assigned document",
    async () => {
      const fixtureNowMs = nowMs;
      const fake = fakeAdmin({
        [`users/${uid}`]: activeEmployee(),
        "projectConfig/default": locationPhotoPolicy(fixtureNowMs),
      });
      const handlers = createAttendanceHandlers(fake.admin);

      await assert.rejects(
          withFixedNow(
              fixtureNowMs,
              () => handlers.createAttendanceChallenge({
                auth: {uid},
                app: {appId: "test-app"},
                data: {action: "checkIn"},
              }),
          ),
          (error) => error?.details?.reason ===
            "ASSIGNMENT_LOCATION_MISSING",
      );
      assert.equal(fake.paths("attendanceChallenges/").length, 0);
    });

test("checkout challenge rejects a mode different from its check-in",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T17:05:00.000Z");
      const checkInMs =
        Date.parse("2026-12-31T16:55:00.000Z");
      const fake = fakeAdmin({
        [`users/${uid}`]: activeEmployee(),
        "projectConfig/default": activePolicy({
          attendanceSecurityCutoverAt:
            timestamp(fixtureNowMs - 60_000),
          attendanceVerificationMode: "geofence_onsite",
        }),
        [`attendanceOpenShifts/${uid}`]: openShift({
          checkInAt: timestamp(checkInMs),
        }),
        [`attendances/${uid}_2026-12-31`]:
          locationPhotoAttendance(checkInMs),
        ...verifiedGeofenceDocuments(fixtureNowMs - 60 * 60_000),
      });
      const handlers = createAttendanceHandlers(fake.admin);

      await assert.rejects(
          withFixedNow(
              fixtureNowMs,
              () => handlers.createAttendanceChallenge({
                auth: {uid},
                app: {appId: "test-app"},
                data: {action: "checkOut"},
              }),
          ),
          (error) => error?.details?.reason ===
            "ATTENDANCE_POLICY_CHANGED",
      );
      assert.equal(fake.paths("attendanceChallenges/").length, 0);
    });

test("location-photo checkout challenge exposes the full expiry grace",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T17:05:00.000Z");
      const checkInMs =
        Date.parse("2026-12-31T16:55:00.000Z");
      const policyExpiresAtMs = fixtureNowMs + 1_000;
      const fake = fakeAdmin({
        [`users/${uid}`]: activeEmployee(),
        "projectConfig/default": locationPhotoPolicy(fixtureNowMs, {
          locationPhotoModeExpiresAt: timestamp(policyExpiresAtMs),
        }),
        [`attendanceOpenShifts/${uid}`]: openShift({
          checkInAt: timestamp(checkInMs),
        }),
        [`attendances/${uid}_2026-12-31`]:
          locationPhotoAttendance(checkInMs),
        "kelurahan/kel-test": provisionalAssignmentLocation,
      });
      const handlers = createAttendanceHandlers(fake.admin);

      const result = await withFixedNow(
          fixtureNowMs,
          () => handlers.createAttendanceChallenge({
            auth: {uid},
            app: {appId: "test-app"},
            data: {action: "checkOut"},
          }),
      );

      assert.equal(
          Date.parse(result.verificationModeExpiresAt),
          policyExpiresAtMs + 24 * 60 * 60_000,
      );
      assert.ok(Date.parse(result.expiresAt) < policyExpiresAtMs +
        24 * 60 * 60_000);
    });

test("open shift preserves the check-in work date across a year boundary", () => {
  const normalized = assertOpenShiftState(openShift(), uid);
  assert.deepEqual(normalized, {
    attendanceId: `${uid}_2026-12-31`,
    checkInMs: Date.parse("2026-12-31T16:55:00.000Z"),
    revision: 3,
    status: "open",
    workDate: "2026-12-31",
  });

  assert.throws(
      () => assertOpenShiftState(
          openShift({attendanceId: `${uid}_2027-01-01`}),
          uid,
      ),
      (error) => error?.details?.reason === "OPEN_SHIFT_STATE_INVALID",
  );
});

test("closed shift state requires a monotonic closure timestamp", () => {
  const checkInMs = Date.parse("2026-12-31T16:55:00.000Z");
  const closed = assertOpenShiftState(openShift({
    status: "closed",
    closedAt: timestamp(checkInMs + 60_000),
  }), uid);
  assert.equal(closed.status, "closed");

  assert.throws(
      () => assertOpenShiftState(openShift({
        status: "closed",
        closedAt: timestamp(checkInMs - 1),
      }), uid),
      (error) => error?.details?.reason === "OPEN_SHIFT_STATE_INVALID",
  );
});

test("checkout window accepts the exact cap and rejects one millisecond over", () => {
  const checkInMs = Date.parse("2026-12-31T16:55:00.000Z");
  const durationMs = 24 * 60 * 60 * 1000;
  assert.doesNotThrow(
      () => assertShiftCheckoutWindow(
          checkInMs,
          checkInMs + durationMs,
          durationMs,
      ),
  );
  assert.throws(
      () => assertShiftCheckoutWindow(
          checkInMs,
          checkInMs + durationMs + 1,
          durationMs,
      ),
      (error) => error?.details?.reason === "OPEN_SHIFT_EXPIRED",
  );
});

test("early-leave boundary uses the same work date and server WIB time", () => {
  const workDate = "2026-12-31";
  assert.equal(
      isEarlyLeaveCheckout(
          Date.parse("2026-12-31T09:59:59.999Z"),
          workDate,
      ),
      true,
  );
  assert.equal(
      isEarlyLeaveCheckout(
          Date.parse("2026-12-31T10:00:00.000Z"),
          workDate,
      ),
      false,
  );
  assert.equal(
      isEarlyLeaveCheckout(
          Date.parse("2026-12-31T18:00:00.000Z"),
          workDate,
      ),
      false,
  );
});

test("early-leave reason is trimmed and has a narrow payload contract", () => {
  assert.equal(
      normalizeEarlyLeaveReason("  Ada keperluan keluarga  ", true),
      "Ada keperluan keluarga",
  );
  assert.equal(
      normalizeEarlyLeaveReason("Baris satu\nBaris dua", true),
      "Baris satu\nBaris dua",
  );
  assert.equal(
      normalizeEarlyLeaveReason("reason supplied before boundary", false),
      null,
  );
  assert.throws(
      () => normalizeEarlyLeaveReason("abc", false),
      (error) => error?.details?.reason === "EARLY_LEAVE_REASON_INVALID",
  );
  assert.throws(
      () => normalizeEarlyLeaveReason({reason: "forged"}, false),
      (error) => error?.details?.reason === "EARLY_LEAVE_REASON_INVALID",
  );
  assert.throws(
      () => normalizeEarlyLeaveReason(undefined, true),
      (error) => error?.details?.reason === "EARLY_LEAVE_REASON_REQUIRED",
  );
  assert.throws(
      () => normalizeEarlyLeaveReason("  abc  ", true),
      (error) => error?.details?.reason === "EARLY_LEAVE_REASON_INVALID",
  );
  assert.throws(
      () => normalizeEarlyLeaveReason(
          "a".repeat(EARLY_LEAVE_REASON_MAX_LENGTH + 1),
          true,
      ),
      (error) => error?.details?.reason === "EARLY_LEAVE_REASON_INVALID",
  );
  assert.throws(
      () => normalizeEarlyLeaveReason("Alasan\u0000tidak valid", true),
      (error) => error?.details?.reason === "EARLY_LEAVE_REASON_INVALID",
  );
});

test("checkout challenge remains bound to its original work date", () => {
  const target = assertChallengeTarget({
    requestDate: "2027-01-01",
    targetAttendanceId: `${uid}_2026-12-31`,
    targetWorkDate: "2026-12-31",
    targetShiftRevision: 3,
  }, uid, "checkOut");
  assert.equal(target.workDate, "2026-12-31");
  assert.equal(target.requestDate, "2027-01-01");

  assert.throws(
      () => assertChallengeTarget({
        requestDate: "2026-12-31",
        targetAttendanceId: `${uid}_2027-01-01`,
        targetWorkDate: "2027-01-01",
        targetShiftRevision: 3,
      }, uid, "checkIn"),
      (error) => error?.details?.reason === "CHALLENGE_TARGET_INVALID",
  );
});

test("location-photo check-in stores canonical GPS and photo evidence",
    async () => {
      const fixtureNowMs = nowMs;
      const challenge =
        pendingLocationPhotoCheckInChallenge(fixtureNowMs);
      const otherUid = "employee-other";
      const documents = {
        [`attendanceChallenges/${locationPhotoCheckInChallengeId}`]:
          challenge,
        [`attendanceChallengeLocks/${uid}_checkIn`]:
          matchingCheckInChallengeLock(challenge),
        [`users/${uid}`]: activeEmployee(),
        [`users/${otherUid}`]: {
          ...activeEmployee(),
          kelurahanId: "kel-other",
        },
        "projectConfig/default": locationPhotoPolicy(fixtureNowMs),
        "kelurahan/kel-test": provisionalAssignmentLocation,
      };
      const bucket = await fakePhotoBucket(fixtureNowMs, {
        challengeId: locationPhotoCheckInChallengeId,
        action: "checkIn",
      });
      const fake = fakeAdmin(documents, bucket);
      const handlers = createAttendanceHandlers(fake.admin);

      const result = await withFixedNow(
          fixtureNowMs,
          () => handlers.submitAttendance(
              locationPhotoRequest(
                  fixtureNowMs,
                  "checkIn",
                  locationPhotoCheckInChallengeId,
              ),
          ),
      );

      const attendancePath = `attendances/${uid}_2027-01-01`;
      const recorded = fake.data(attendancePath);
      assert.equal(result.success, true);
      assert.equal(result.verificationMode, VERIFICATION_MODE_LOCATION_PHOTO);
      assert.equal(result.geofence, null);
      assert.equal(recorded.verificationMode,
          VERIFICATION_MODE_LOCATION_PHOTO);
      assert.equal(recorded.verificationStatus, "location_photo_only");
      assert.equal(recorded.transitionMode, true);
      assert.equal(recorded.isWithinRadius, null);
      assert.equal(recorded.deviceVerified, false);
      assert.equal(recorded.distanceFromGeofence, null);
      assert.equal(recorded.geofenceSnapshot, null);
      assert.deepEqual(recorded.assignmentSnapshot, {
        collection: "kelurahan",
        id: "kel-test",
        name: "Kelurahan Test",
      });
      assert.deepEqual(recorded.presenceProof, {
        required: false,
        verified: false,
        reason: "policy_location_photo",
      });
      assert.equal(recorded.checkInLocation.lat, -6.2);
      assert.equal(recorded.checkInLocation.lng, 106.8);
      assert.equal(recorded.checkInLocation.accuracy, 10);
      assert.equal(recorded.checkInLocation.serverReceivedAt.toMillis(),
          fixtureNowMs);
      assert.equal(typeof recorded.checkInPhotoHash, "string");
      assert.match(recorded.checkInPhotoHash, /^[0-9a-f]{64}$/);
      assert.equal(
          fake.data(`attendanceOpenShifts/${uid}`).status,
          "open",
      );
      assert.equal(
          fake.paths("attendancePresenceGrants/").length,
          0,
      );

      const photo = await withFixedNow(
          fixtureNowMs,
          () => handlers.getAttendancePhotoUrl({
            auth: {uid},
            app: {appId: "test-app"},
            data: {
              attendanceId: `${uid}_2027-01-01`,
              action: "checkIn",
            },
          }),
      );
      assert.match(photo.url, /^https:\/\/storage\.example\.test\//);
      await assert.rejects(
          withFixedNow(
              fixtureNowMs,
              () => handlers.getAttendancePhotoUrl({
                auth: {uid: otherUid},
                app: {appId: "test-app"},
                data: {
                  attendanceId: `${uid}_2027-01-01`,
                  action: "checkIn",
                },
              }),
          ),
          (error) => error?.details?.reason === "PHOTO_ACCESS_DENIED",
      );
    });

test("checkout challenge tells the UI when an early-leave reason is required",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T09:59:00.000Z");
      const checkInMs = fixtureNowMs - 2 * 60 * 60_000;
      const documents = {
        [`users/${uid}`]: activeEmployee(),
        "projectConfig/default": locationPhotoPolicy(fixtureNowMs),
        [`attendanceOpenShifts/${uid}`]: openShift({
          checkInAt: timestamp(checkInMs),
        }),
        [`attendances/${uid}_2026-12-31`]:
          locationPhotoAttendance(checkInMs),
        "kelurahan/kel-test": provisionalAssignmentLocation,
      };
      const fake = fakeAdmin(documents);
      const handlers = createAttendanceHandlers(fake.admin);

      const result = await withFixedNow(
          fixtureNowMs,
          () => handlers.createAttendanceChallenge({
            auth: {uid},
            app: {appId: "test-app"},
            data: {action: "checkOut"},
          }),
      );

      assert.equal(result.earlyLeaveReasonRequired, true);
      assert.equal(result.earlyLeaveThresholdHourWib, 17);
    });

test("checkout before 17:00 WIB rejects a missing reason", async () => {
  const fixtureNowMs =
    Date.parse("2026-12-31T09:59:00.000Z");
  const fixture = await locationPhotoCheckoutFixture(fixtureNowMs);

  await assert.rejects(
      withFixedNow(
          fixtureNowMs,
          () => fixture.handlers.submitAttendance(fixture.request),
      ),
      (error) => error?.details?.reason === "EARLY_LEAVE_REASON_REQUIRED",
  );
  assert.equal(
      fixture.fake.data(`attendances/${uid}_2026-12-31`).checkOut,
      null,
  );
  assert.equal(
      fixture.fake.data(`attendanceOpenShifts/${uid}`).status,
      "open",
  );
});

test("checkout before 17:00 WIB stores a canonical early-leave marker",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T09:59:00.000Z");
      const fixture = await locationPhotoCheckoutFixture(
          fixtureNowMs,
          "  Ada keperluan keluarga  ",
      );

      const result = await withFixedNow(
          fixtureNowMs,
          () => fixture.handlers.submitAttendance(fixture.request),
      );

      const recorded =
        fixture.fake.data(`attendances/${uid}_2026-12-31`);
      assert.equal(result.success, true);
      assert.equal(result.earlyLeave, true);
      assert.equal(recorded.earlyLeave, true);
      assert.equal(recorded.earlyLeaveReason, "Ada keperluan keluarga");
      assert.equal(recorded.earlyLeaveThresholdHourWib, 17);
      assert.ok(recorded.checkOut);
      assert.ok(recorded.checkOutLocation);
      assert.equal(typeof recorded.checkOutPhotoHash, "string");
      assert.equal(
          fixture.fake.data(`attendanceOpenShifts/${uid}`).status,
          "closed",
      );
    });

test("checkout at 17:00 WIB does not require an early-leave reason",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T10:00:00.000Z");
      const fixture = await locationPhotoCheckoutFixture(fixtureNowMs);

      const result = await withFixedNow(
          fixtureNowMs,
          () => fixture.handlers.submitAttendance(fixture.request),
      );

      const recorded =
        fixture.fake.data(`attendances/${uid}_2026-12-31`);
      assert.equal(result.success, true);
      assert.equal(result.earlyLeave, false);
      assert.equal(recorded.earlyLeave, false);
      assert.equal(recorded.earlyLeaveReason, null);
      assert.equal(recorded.earlyLeaveThresholdHourWib, 17);
    });

test("reason entered before the boundary is ignored at 17:00 WIB",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T10:00:00.000Z");
      const fixture = await locationPhotoCheckoutFixture(
          fixtureNowMs,
          "Alasan diisi saat challenge masih menunjukkan pulang awal",
      );

      const result = await withFixedNow(
          fixtureNowMs,
          () => fixture.handlers.submitAttendance(fixture.request),
      );

      const recorded =
        fixture.fake.data(`attendances/${uid}_2026-12-31`);
      assert.equal(result.earlyLeave, false);
      assert.equal(recorded.earlyLeave, false);
      assert.equal(recorded.earlyLeaveReason, null);
    });

test("submit payload cannot forge the canonical early-leave marker",
    async () => {
      const fake = fakeAdmin({});
      const handlers = createAttendanceHandlers(fake.admin);
      const request = locationPhotoRequest(
          Date.parse("2026-12-31T09:59:00.000Z"),
      );
      request.data.earlyLeave = true;

      await assert.rejects(
          handlers.submitAttendance(request),
          (error) => error?.details?.reason === "UNEXPECTED_FIELD",
      );
    });

test("location-photo checkout closes an overnight shift without presence",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T17:05:00.000Z");
      const checkInMs =
        Date.parse("2026-12-31T16:55:00.000Z");
      const challenge = pendingCheckoutChallenge(fixtureNowMs, {
        ...locationPhotoPolicyChallengeFields(fixtureNowMs),
      });
      const documents = {
        [`attendanceChallenges/${checkoutChallengeId}`]: challenge,
        [`attendanceChallengeLocks/${uid}_checkOut`]:
          matchingChallengeLock(challenge),
        [`users/${uid}`]: activeEmployee(),
        "projectConfig/default": locationPhotoPolicy(fixtureNowMs),
        [`attendanceOpenShifts/${uid}`]: openShift({
          checkInAt: timestamp(checkInMs),
        }),
        [`attendances/${uid}_2026-12-31`]:
          locationPhotoAttendance(checkInMs),
        "kelurahan/kel-test": provisionalAssignmentLocation,
      };
      const bucket = await fakePhotoBucket(fixtureNowMs);
      const fake = fakeAdmin(documents, bucket);
      const handlers = createAttendanceHandlers(fake.admin);

      const result = await withFixedNow(
          fixtureNowMs,
          () => handlers.submitAttendance(
              locationPhotoRequest(fixtureNowMs),
          ),
      );

      const recorded = fake.data(`attendances/${uid}_2026-12-31`);
      assert.equal(result.success, true);
      assert.equal(result.earlyLeave, false);
      assert.equal(result.date, "2026-12-31");
      assert.equal(result.verificationMode, VERIFICATION_MODE_LOCATION_PHOTO);
      assert.equal(recorded.checkOutDateWib, "2027-01-01");
      assert.equal(recorded.checkOutVerificationMode,
          VERIFICATION_MODE_LOCATION_PHOTO);
      assert.equal(recorded.checkOutVerificationStatus,
          "location_photo_only");
      assert.equal(recorded.checkOutDistanceFromGeofence, null);
      assert.equal(recorded.checkOutGeofenceSnapshot, null);
      assert.deepEqual(recorded.checkOutAssignmentSnapshot, {
        collection: "kelurahan",
        id: "kel-test",
        name: "Kelurahan Test",
      });
      assert.deepEqual(recorded.checkOutPresenceProof, {
        required: false,
        verified: false,
        reason: "policy_location_photo",
      });
      assert.equal(recorded.earlyLeave, false);
      assert.equal(recorded.earlyLeaveReason, null);
      assert.equal(recorded.earlyLeaveThresholdHourWib, 17);
      assert.equal(
          fake.data(`attendanceOpenShifts/${uid}`).closureSource,
          "location-photo-checkout",
      );
      assert.equal(
          fake.paths("attendancePresenceGrants/").length,
          0,
      );
    });

test("location-photo submit rejects a policy mode switch", async () => {
  const fixtureNowMs =
    Date.parse("2026-12-31T17:05:00.000Z");
  const checkInMs = fixtureNowMs - 10 * 60_000;
  const challenge = pendingCheckoutChallenge(fixtureNowMs, {
    ...locationPhotoPolicyChallengeFields(fixtureNowMs),
  });
  const documents = {
    [`attendanceChallenges/${checkoutChallengeId}`]: challenge,
    [`attendanceChallengeLocks/${uid}_checkOut`]:
      matchingChallengeLock(challenge),
    [`users/${uid}`]: activeEmployee(),
    "projectConfig/default": activePolicy({
      attendanceSecurityCutoverAt: timestamp(fixtureNowMs - 60_000),
      attendanceVerificationMode: "geofence_onsite",
    }),
    [`attendanceOpenShifts/${uid}`]: openShift({
      checkInAt: timestamp(checkInMs),
    }),
    [`attendances/${uid}_2026-12-31`]:
      locationPhotoAttendance(checkInMs),
    "kelurahan/kel-test": provisionalAssignmentLocation,
  };
  const bucket = await fakePhotoBucket(fixtureNowMs);
  const fake = fakeAdmin(documents, bucket);
  const handlers = createAttendanceHandlers(fake.admin);

  await assert.rejects(
      withFixedNow(
          fixtureNowMs,
          () => handlers.submitAttendance(
              locationPhotoRequest(fixtureNowMs),
          ),
      ),
      (error) => error?.details?.reason === "ATTENDANCE_POLICY_CHANGED",
  );
  assert.equal(
      fake.data(`attendances/${uid}_2026-12-31`).checkOut,
      null,
  );
});

test("checkout handler targets the prior work date after WIB midnight",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T17:05:00.000Z");
      const checkInMs =
        Date.parse("2026-12-31T16:55:00.000Z");
      const verifiedAtMs = fixtureNowMs - 60 * 60_000;
      const documents = {
        [`users/${uid}`]: activeEmployee(),
        "projectConfig/default": activePolicy({
          attendanceSecurityCutoverAt: timestamp(fixtureNowMs - 60_000),
        }),
        [`attendanceOpenShifts/${uid}`]: openShift({
          checkInAt: timestamp(checkInMs),
        }),
        [`attendances/${uid}_2026-12-31`]:
          verifiedAttendance(checkInMs),
        ...verifiedGeofenceDocuments(verifiedAtMs),
      };
      const fake = fakeAdmin(documents);
      const handlers = createAttendanceHandlers(fake.admin);

      const result = await withFixedNow(
          fixtureNowMs,
          () => handlers.createAttendanceChallenge({
            auth: {uid},
            app: {appId: "test-app"},
            data: {action: "checkOut"},
          }),
      );

      assert.equal(result.attendanceId, `${uid}_2026-12-31`);
      assert.equal(result.workDate, "2026-12-31");
      const challengePaths = fake.paths("attendanceChallenges/");
      assert.equal(challengePaths.length, 1);
      const challenge = fake.data(challengePaths[0]);
      assert.equal(challenge.requestDate, "2027-01-01");
      assert.equal(challenge.targetAttendanceId, `${uid}_2026-12-31`);
      assert.equal(challenge.targetWorkDate, "2026-12-31");
      assert.equal(challenge.targetShiftRevision, 3);
    });

test("submit handler rejects an overnight challenge after pointer revision",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T17:05:00.000Z");
      const checkInMs = fixtureNowMs - 10 * 60_000;
      const documents = submitFixtureDocuments(fixtureNowMs, {
        [`attendanceOpenShifts/${uid}`]: openShift({
          revision: 4,
          checkInAt: timestamp(checkInMs),
        }),
      });
      const bucket = await fakePhotoBucket(fixtureNowMs);
      const fake = fakeAdmin(documents, bucket);
      const handlers = createAttendanceHandlers(fake.admin);

      await assert.rejects(
          withFixedNow(
              fixtureNowMs,
              () => handlers.submitAttendance(
                  checkoutRequest(fixtureNowMs),
              ),
          ),
          (error) => error?.details?.reason === "CHALLENGE_TARGET_STALE",
      );
      assert.equal(
          fake.data(`attendanceOpenShifts/${uid}`).revision,
          4,
      );
      assert.equal(
          fake.data(`attendanceOpenShifts/${uid}`).status,
          "open",
      );
    });

test("submit handler closes the prior-date shift after WIB midnight",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T17:05:00.000Z");
      const checkInMs = fixtureNowMs - 10 * 60_000;
      const verifiedAtMs = fixtureNowMs - 60 * 60_000;
      const issuerUid = "admin-code-issuer";
      const secret = Buffer.alloc(32, 7).toString("base64");
      const counter = core.presenceCounter(fixtureNowMs);
      const presenceContext =
        `kelurahan:kel-test:${uid}:${checkoutChallengeId}`;
      const presenceCode = core.createPresenceCode(
          secret,
          counter,
          presenceContext,
      );
      const issuedAtMs = fixtureNowMs - 1000;
      const documents = submitFixtureDocuments(fixtureNowMs, {
        [`attendances/${uid}_2026-12-31`]:
          verifiedAttendance(checkInMs),
        [`geofencePresenceSecrets/kelurahan_kel-test`]: {
          enabled: true,
          geofenceType: "kelurahan",
          geofenceId: "kel-test",
          secret,
        },
        [`attendancePresenceGrants/${checkoutChallengeId}`]: {
          status: "active",
          consumedAt: null,
          attendanceId: null,
          uid,
          action: "checkOut",
          challengeId: checkoutChallengeId,
          geofenceCollection: "kelurahan",
          geofenceId: "kel-test",
          counter,
          issuedAt: timestamp(issuedAtMs),
          displayExpiresAt: timestamp((counter + 1) * 60_000),
          expiresAt: timestamp((counter + 2) * 60_000),
          issuedBy: issuerUid,
          verifierLocation: {
            lat: -0.95,
            lng: 100.36,
            accuracy: 10,
            capturedAt: issuedAtMs,
            source: "gps-high",
            distanceMeters: 0,
            uncertaintyAdjustedDistanceMeters: 10,
            serverReceivedAt: timestamp(issuedAtMs),
          },
        },
        [`users/${issuerUid}`]: {
          accountStatus: "active",
          isActive: true,
          mustChangePassword: false,
          role: "admin",
        },
        ...verifiedGeofenceDocuments(verifiedAtMs),
      });
      const bucket = await fakePhotoBucket(fixtureNowMs);
      const fake = fakeAdmin(documents, bucket);
      const handlers = createAttendanceHandlers(fake.admin);

      const result = await withFixedNow(
          fixtureNowMs,
          () => handlers.submitAttendance(
              checkoutRequest(fixtureNowMs, presenceCode),
          ),
      );

      assert.equal(result.success, true);
      assert.equal(result.attendanceId, `${uid}_2026-12-31`);
      assert.equal(result.date, "2026-12-31");
      assert.equal(
          fake.data(`attendances/${uid}_2026-12-31`).checkOutDateWib,
          "2027-01-01",
      );
      assert.equal(
          fake.data(`attendanceOpenShifts/${uid}`).status,
          "closed",
      );
    });

test("submit handler re-applies a tightened shift duration policy",
    async () => {
      const fixtureNowMs =
        Date.parse("2026-12-31T17:05:00.000Z");
      const checkInMs = fixtureNowMs - 61 * 60_000;
      const documents = submitFixtureDocuments(fixtureNowMs, {
        "projectConfig/default": activePolicy({
          attendanceSecurityCutoverAt: timestamp(fixtureNowMs - 60_000),
          maxAttendanceShiftDurationMinutes: 60,
        }),
        [`attendanceOpenShifts/${uid}`]: openShift({
          checkInAt: timestamp(checkInMs),
        }),
      });
      const bucket = await fakePhotoBucket(fixtureNowMs);
      const fake = fakeAdmin(documents, bucket);
      const handlers = createAttendanceHandlers(fake.admin);

      await assert.rejects(
          withFixedNow(
              fixtureNowMs,
              () => handlers.submitAttendance(
                  checkoutRequest(fixtureNowMs),
              ),
          ),
          (error) => error?.details?.reason === "OPEN_SHIFT_EXPIRED",
      );
      assert.equal(
          fake.data(`attendanceOpenShifts/${uid}`).status,
          "open",
      );
    });
