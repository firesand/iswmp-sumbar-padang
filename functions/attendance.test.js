"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./attendance-core");
const attendance = require("./attendance");
const logger = require("firebase-functions/logger");

function hashWithBits(bitIndexes) {
  const bits = Array(144).fill("0");
  bitIndexes.forEach((index) => {
    bits[index] = "1";
  });
  let result = "";
  for (let index = 0; index < bits.length; index += 4) {
    result += Number.parseInt(bits.slice(index, index + 4).join(""), 2)
        .toString(16);
  }
  return result;
}

const replayNowMs = Date.parse("2026-07-23T01:00:00.000Z");
const zeroHash = "0".repeat(core.PERCEPTUAL_HASH_HEX_LENGTH);
const farHash = "f".repeat(core.PERCEPTUAL_HASH_HEX_LENGTH);

function replayExpected(uid, proofId, hash = zeroHash) {
  return {
    uid,
    proofId,
    perceptualHashes: Array(core.PERCEPTUAL_HASH_VIEW_COUNT).fill(hash),
  };
}

test("global exact SHA replay remains a hard denial", () => {
  assert.throws(
      () => attendance.assertPhotoNotReplayed(true, false),
      (error) => error?.details?.reason === "PHOTO_REPLAY",
  );
  assert.doesNotThrow(
      () => attendance.assertPhotoNotReplayed(false, false),
  );
});

test("same-UID current perceptual replay is denied across all views", () => {
  const uid = "employee-a";
  const initial = attendance.reservePerceptualReplayState(
      null,
      replayExpected(uid, "1".repeat(64), farHash),
      replayNowMs,
  );
  const secondViewNearHash = hashWithBits([0, 7, 14, 21, 28, 35]);
  const submittedHashes = Array(
      core.PERCEPTUAL_HASH_VIEW_COUNT,
  ).fill(zeroHash);
  const storedHashes = [...initial.nextState.entries[0].perceptualHashes];
  storedHashes[7] = secondViewNearHash;
  initial.nextState.entries[0].perceptualHashes = storedHashes;

  const replay = attendance.reservePerceptualReplayState(
      initial.nextState,
      {
        uid,
        proofId: "2".repeat(64),
        perceptualHashes: submittedHashes,
      },
      replayNowMs + 1,
  );
  assert.equal(replay.nearReplay, true);
  assert.equal(replay.nextState, null);
  assert.throws(
      () => attendance.assertPhotoNotReplayed(false, replay.nearReplay),
      (error) => error?.details?.reason === "PHOTO_REPLAY",
  );
});

test("near perceptual match from another UID does not hard-lock", () => {
  const first = attendance.reservePerceptualReplayState(
      null,
      replayExpected("employee-a", "1".repeat(64)),
      replayNowMs,
  );
  assert.equal(first.nearReplay, false);

  // Production reads a state document keyed by the authenticated UID, so the
  // second employee starts from their own absent state.
  const second = attendance.reservePerceptualReplayState(
      null,
      replayExpected("employee-b", "2".repeat(64)),
      replayNowMs + 1,
  );
  assert.equal(second.nearReplay, false);
  assert.doesNotThrow(
      () => attendance.assertPhotoNotReplayed(false, second.nearReplay),
  );
  assert.throws(
      () => attendance.reservePerceptualReplayState(
          first.nextState,
          replayExpected("employee-b", "3".repeat(64)),
          replayNowMs + 1,
      ),
      (error) => error?.details?.reason ===
        "PHOTO_REPLAY_STATE_INVALID",
  );
});

test("perceptual replay expires exactly at the 30-day boundary", () => {
  const uid = "employee-boundary";
  const first = attendance.reservePerceptualReplayState(
      null,
      replayExpected(uid, "1".repeat(64)),
      replayNowMs,
  );
  const justInside = attendance.reservePerceptualReplayState(
      first.nextState,
      replayExpected(uid, "2".repeat(64)),
      replayNowMs + core.PERCEPTUAL_REPLAY_WINDOW_MS - 1,
  );
  assert.equal(justInside.nearReplay, true);

  const atBoundary = attendance.reservePerceptualReplayState(
      first.nextState,
      replayExpected(uid, "2".repeat(64)),
      replayNowMs + core.PERCEPTUAL_REPLAY_WINDOW_MS,
  );
  assert.equal(atBoundary.nearReplay, false);
  assert.equal(atBoundary.nextState.entries.length, 1);
  assert.equal(atBoundary.nextState.entries[0].proofId, "2".repeat(64));
});

test("malformed or overflowing perceptual replay state fails closed", () => {
  const uid = "employee-corrupt";
  const valid = attendance.reservePerceptualReplayState(
      null,
      replayExpected(uid, "1".repeat(64)),
      replayNowMs,
  ).nextState;
  assert.throws(
      () => attendance.reservePerceptualReplayState(
          {...valid, unexpected: true},
          replayExpected(uid, "2".repeat(64), farHash),
          replayNowMs + 1,
      ),
      (error) => error?.details?.reason ===
        "PHOTO_REPLAY_STATE_INVALID",
  );

  const entries = Array.from(
      {length: core.PERCEPTUAL_REPLAY_MAX_ENTRIES + 1},
      (_, index) => ({
        proofId: index.toString(16).padStart(64, "0"),
        perceptualHashes: Array(
            core.PERCEPTUAL_HASH_VIEW_COUNT,
        ).fill(zeroHash),
        createdAtMs: replayNowMs - 1000 + index,
      }),
  );
  const overflow = {
    schemaVersion: core.PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION,
    hashVersion: core.PERCEPTUAL_HASH_VERSION,
    uid,
    windowMs: core.PERCEPTUAL_REPLAY_WINDOW_MS,
    maxEntries: core.PERCEPTUAL_REPLAY_MAX_ENTRIES,
    entries,
    updatedAtMs: entries.at(-1).createdAtMs,
  };
  assert.throws(
      () => attendance.reservePerceptualReplayState(
          overflow,
          replayExpected(uid, "f".repeat(64), farHash),
          replayNowMs + 1,
      ),
      (error) => error?.details?.reason ===
        "PHOTO_REPLAY_STATE_OVERFLOW",
  );
});

test("full active replay state rejects a new entry without truncation", () => {
  const uid = "employee-full";
  const entries = Array.from(
      {length: core.PERCEPTUAL_REPLAY_MAX_ENTRIES},
      (_, index) => ({
        proofId: index.toString(16).padStart(64, "0"),
        perceptualHashes: Array(
            core.PERCEPTUAL_HASH_VIEW_COUNT,
        ).fill(zeroHash),
        createdAtMs: replayNowMs - 1000 + index,
      }),
  );
  const full = {
    schemaVersion: core.PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION,
    hashVersion: core.PERCEPTUAL_HASH_VERSION,
    uid,
    windowMs: core.PERCEPTUAL_REPLAY_WINDOW_MS,
    maxEntries: core.PERCEPTUAL_REPLAY_MAX_ENTRIES,
    entries,
    updatedAtMs: entries.at(-1).createdAtMs,
  };
  assert.throws(
      () => attendance.reservePerceptualReplayState(
          full,
          replayExpected(uid, "f".repeat(64), farHash),
          replayNowMs + 1,
      ),
      (error) => error?.details?.reason ===
        "PHOTO_REPLAY_STATE_OVERFLOW",
  );
});

test("thirty-day window has headroom for a legitimate sixty-first proof", () => {
  const uid = "employee-thirty-one-dates";
  const entries = Array.from({length: 60}, (_, index) => ({
    proofId: index.toString(16).padStart(64, "0"),
    perceptualHashes: Array(core.PERCEPTUAL_HASH_VIEW_COUNT).fill(zeroHash),
    createdAtMs:
      replayNowMs - core.PERCEPTUAL_REPLAY_WINDOW_MS + 1 + index,
  }));
  const state = {
    schemaVersion: core.PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION,
    hashVersion: core.PERCEPTUAL_HASH_VERSION,
    uid,
    windowMs: core.PERCEPTUAL_REPLAY_WINDOW_MS,
    maxEntries: core.PERCEPTUAL_REPLAY_MAX_ENTRIES,
    entries,
    updatedAtMs: entries.at(-1).createdAtMs,
  };

  const result = attendance.reservePerceptualReplayState(
      state,
      replayExpected(uid, "f".repeat(64), farHash),
      replayNowMs,
  );

  assert.equal(result.nearReplay, false);
  assert.equal(result.nextState.entries.length, 61);
});

test("perceptual distance boundary remains strict at six bits", () => {
  const zeroHash = "0".repeat(core.PERCEPTUAL_HASH_HEX_LENGTH);
  const distanceSixHash = hashWithBits([0, 7, 14, 21, 28, 35]);
  const distanceSevenHash = hashWithBits([0, 7, 14, 21, 28, 35, 42]);
  assert.equal(
      core.perceptualHashDistance(zeroHash, distanceSixHash),
      core.PERCEPTUAL_REPLAY_MAX_DISTANCE,
  );
  assert.equal(
      core.perceptualHashDistance(zeroHash, distanceSevenHash),
      core.PERCEPTUAL_REPLAY_MAX_DISTANCE + 1,
  );
});

test("employee and code issuer must be verifiably co-present", () => {
  const geofence = {lat: -0.95, lng: 100.36, radius: 300};
  const employee = {lat: -0.95, lng: 100.36, accuracy: 12};
  const verifier = {lat: -0.9501, lng: 100.36, accuracy: 15};
  const result = attendance.assertCoPresence(
      employee,
      verifier,
      geofence,
  );
  assert.ok(result.distanceMeters > 0);
  assert.ok(result.uncertaintyAdjustedDistanceMeters <= 100);

  assert.throws(() => attendance.assertCoPresence(
      employee,
      {lat: -0.951, lng: 100.36, accuracy: 10},
      geofence,
  ), (error) => error?.details?.reason === "COPRESENCE_UNCERTAIN");

  assert.throws(() => attendance.assertCoPresence(
      employee,
      {lat: -0.947, lng: 100.36, accuracy: 10},
      geofence,
  ), (error) => error?.details?.reason === "VERIFIER_OUTSIDE_GEOFENCE");
});

test("location-photo policy is explicit, bounded, and expires fail-closed", () => {
  const timestamp = (value) => ({toMillis: () => value});
  const now = Date.parse("2026-07-23T02:00:00.000Z");
  assert.equal(
      attendance.attendanceVerificationPolicy({}, now).verificationMode,
      attendance.VERIFICATION_MODE_GEOFENCE_ONSITE,
  );

  const config = {
    attendanceVerificationMode:
      attendance.VERIFICATION_MODE_LOCATION_PHOTO,
    locationPhotoModePolicyVersion:
      attendance.LOCATION_PHOTO_MODE_POLICY_VERSION,
    locationPhotoModeEnabledAt: timestamp(now - 60_000),
    locationPhotoModeExpiresAt: timestamp(now + 60_000),
  };
  const policy = attendance.attendanceVerificationPolicy(config, now);
  assert.equal(
      policy.verificationMode,
      attendance.VERIFICATION_MODE_LOCATION_PHOTO,
  );
  assert.equal(policy.checkoutGrace, false);

  assert.throws(
      () => attendance.attendanceVerificationPolicy({
        ...config,
        locationPhotoModeExpiresAt: timestamp(
            now - 60_000 +
            attendance.MAX_LOCATION_PHOTO_MODE_DURATION_MS + 1,
        ),
      }, now),
      (error) => error?.details?.reason ===
        "ATTENDANCE_VERIFICATION_POLICY_INVALID",
  );
  // A time-boxed policy must not carry a permanent risk acceptance.
  assert.throws(
      () => attendance.attendanceVerificationPolicy({
        ...config,
        locationPhotoModePermanent: {
          acceptedBy: "Pemilik Proyek",
          acceptedAt: timestamp(now - 60_000),
          reason: "Alasan penerimaan risiko.",
        },
      }, now),
      (error) => error?.details?.reason ===
        "ATTENDANCE_VERIFICATION_POLICY_INVALID",
  );
  const expired = {
    ...config,
    locationPhotoModeEnabledAt: timestamp(now - 120_000),
    locationPhotoModeExpiresAt: timestamp(now - 1),
  };
  assert.throws(
      () => attendance.attendanceVerificationPolicy(expired, now),
      (error) => error?.details?.reason === "LOCATION_PHOTO_MODE_EXPIRED",
  );
  assert.equal(
      attendance.attendanceVerificationPolicy(expired, now, {
        allowCheckoutGrace: true,
        maximumShiftDurationMs: 60_000,
      }).checkoutGrace,
      true,
  );
});

test("permanent location-photo policy needs explicit recorded acceptance", () => {
  const timestamp = (value) => ({toMillis: () => value});
  const now = Date.parse("2026-08-06T02:00:00.000Z");
  const config = {
    attendanceVerificationMode:
      attendance.VERIFICATION_MODE_LOCATION_PHOTO,
    locationPhotoModePolicyVersion:
      attendance.LOCATION_PHOTO_MODE_PERMANENT_POLICY_VERSION,
    locationPhotoModeEnabledAt: timestamp(now - 60_000),
    locationPhotoModePermanent: {
      acceptedBy: "Pemilik Proyek ISWMP",
      acceptedAt: timestamp(now - 60_000),
      reason: "Admin kedua tidak di Padang; dual-control tidak mungkin.",
    },
  };
  const policy = attendance.attendanceVerificationPolicy(config, now);
  assert.equal(
      policy.verificationMode,
      attendance.VERIFICATION_MODE_LOCATION_PHOTO,
  );
  assert.equal(
      policy.locationPhotoModePolicyVersion,
      attendance.LOCATION_PHOTO_MODE_PERMANENT_POLICY_VERSION,
  );
  assert.equal(policy.expiresAtMs, null);
  assert.equal(policy.checkoutGrace, false);

  // The permanent policy never expires and never enters checkout grace, even
  // long after enablement.
  const later = attendance.attendanceVerificationPolicy(
      config,
      now + 365 * 24 * 60 * 60 * 1000,
      {allowCheckoutGrace: true, maximumShiftDurationMs: 60_000},
  );
  assert.equal(later.checkoutGrace, false);

  const invalid = (overrides) => assert.throws(
      () => attendance.attendanceVerificationPolicy(
          {...config, ...overrides},
          now,
      ),
      (error) => error?.details?.reason ===
        "ATTENDANCE_VERIFICATION_POLICY_INVALID",
  );

  // An expiry must not coexist with a permanent acceptance.
  invalid({locationPhotoModeExpiresAt: timestamp(now + 60_000)});
  invalid({locationPhotoModePermanent: null});
  invalid({locationPhotoModePermanent: "accepted"});
  invalid({locationPhotoModePermanent: {
    ...config.locationPhotoModePermanent,
    acceptedBy: "ab",
  }});
  invalid({locationPhotoModePermanent: {
    ...config.locationPhotoModePermanent,
    acceptedBy: 42,
  }});
  invalid({locationPhotoModePermanent: {
    ...config.locationPhotoModePermanent,
    reason: "pendek",
  }});
  // Acceptance cannot predate the mode it accepts, nor be in the future.
  invalid({locationPhotoModePermanent: {
    ...config.locationPhotoModePermanent,
    acceptedAt: timestamp(now - 120_000),
  }});
  invalid({locationPhotoModePermanent: {
    ...config.locationPhotoModePermanent,
    acceptedAt: timestamp(now + 60_000),
  }});
  invalid({locationPhotoModeEnabledAt: timestamp(now + 60_000)});
  // Unknown policy versions still fail closed.
  invalid({locationPhotoModePolicyVersion: 3});
});

test("location-photo policy carries allowed-location digest and version", () => {
  const timestamp = (value) => ({toMillis: () => value});
  const now = Date.parse("2026-07-28T02:00:00.000Z");
  const locations = [{
    id: "bimtek-test",
    nama: "BimTek Venue",
    lat: -0.9546883,
    lng: 100.3643174,
    radius: 150,
    validFrom: "2026-07-27T17:00:00.000Z",
    validUntil: "2026-07-31T17:00:00.000Z",
  }];
  const digest = require("./attendance-core")
      .normalizeAllowedLocations(locations).digest;
  const config = {
    attendanceVerificationMode:
      attendance.VERIFICATION_MODE_LOCATION_PHOTO,
    locationPhotoModePolicyVersion:
      attendance.LOCATION_PHOTO_MODE_POLICY_VERSION,
    locationPhotoModeEnabledAt: timestamp(
        Date.parse("2026-07-27T10:00:00.000Z"),
    ),
    locationPhotoModeExpiresAt: timestamp(
        Date.parse("2026-08-01T01:00:00.000Z"),
    ),
    locationPhotoAllowedLocations: locations,
    locationPhotoAllowedLocationsVersion: 3,
    locationPhotoAllowedLocationsDigest: digest,
  };
  const policy = attendance.attendanceVerificationPolicy(config, now);
  assert.equal(policy.allowedLocations.length, 1);
  assert.equal(policy.allowedLocationsVersion, 3);
  assert.equal(policy.allowedLocationsDigest, digest);

  assert.throws(
      () => attendance.attendanceVerificationPolicy({
        ...config,
        locationPhotoAllowedLocationsDigest: "0".repeat(64),
      }, now),
      (error) => error?.details?.reason ===
        "ATTENDANCE_VERIFICATION_POLICY_INVALID",
  );

  const beforeWindow = attendance.attendanceVerificationPolicy(
      config,
      Date.parse("2026-07-27T16:00:00.000Z"),
  );
  assert.equal(beforeWindow.allowedLocations.length, 0);
  assert.equal(beforeWindow.allowedLocationsDigest, digest);
});

test("auth and App Check denials are logged without raw request data", async () => {
  const firestore = () => ({});
  firestore.Timestamp = {};
  const handlers = attendance.createAttendanceHandlers({
    firestore,
    storage: () => ({}),
  });
  const originalWarn = logger.warn;
  let event;
  logger.warn = (_message, payload) => {
    event = payload;
  };
  try {
    await assert.rejects(handlers.createAttendanceChallenge({
      auth: {uid: "employee-sensitive-id"},
      data: {action: "untrusted-secret-action"},
    }), (error) => error?.details?.reason === "APP_CHECK_REQUIRED");
  } finally {
    logger.warn = originalWarn;
  }
  assert.equal(event.event, "attendance_security_event");
  assert.equal(event.operation, "createChallenge");
  assert.equal(event.reason, "APP_CHECK_REQUIRED");
  assert.match(event.uidFingerprint, /^[0-9a-f]{20}$/);
  assert.equal(event.action, undefined);
  assert.equal(JSON.stringify(event).includes("employee-sensitive-id"), false);
  assert.equal(JSON.stringify(event).includes("untrusted-secret-action"), false);
});
