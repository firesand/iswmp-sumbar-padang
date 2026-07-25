"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const operations = require("./admin-operations");
const logger = require("firebase-functions/logger");

test("temporary passwords and replacement passwords meet policy", () => {
  const temporary = operations.generateTemporaryPassword();
  assert.ok(temporary.length >= 12);
  assert.equal(operations.assertStrongPassword("Safe-Password9!"),
      "Safe-Password9!");
  assert.throws(() => operations.assertStrongPassword("short"));
  assert.throws(() => operations.assertStrongPassword("NoSymbols1234"));
});

test("onsite code verifier must provide fresh accurate GPS inside geofence", () => {
  const nowMs = 1_750_000_000_000;
  const geofence = {
    lat: -0.9471,
    lng: 100.4172,
    radius: 100,
  };
  const inside = operations.assertVerifierLocation({
    lat: -0.9472,
    lng: 100.4172,
    accuracy: 12,
    capturedAt: nowMs - 1_000,
    source: "gps-high",
  }, nowMs, geofence);
  assert.ok(inside.distanceMeters > 0 && inside.distanceMeters < 100);
  assert.equal(
      inside.uncertaintyAdjustedDistanceMeters,
      inside.distanceMeters + 12,
  );
  assert.equal(inside.location.accuracy, 12);

  assert.throws(() => operations.assertVerifierLocation({
    lat: -0.93,
    lng: 100.4172,
    accuracy: 10,
    capturedAt: nowMs,
    source: "gps-high",
  }, nowMs, geofence), (error) =>
    error?.details?.reason === "VERIFIER_OUTSIDE_GEOFENCE");

  assert.throws(() => operations.assertVerifierLocation({
    lat: -0.9472,
    lng: 100.4172,
    accuracy: 150,
    capturedAt: nowMs,
    source: "gps-high",
  }, nowMs, geofence), (error) =>
    error?.reason === "LOCATION_ACCURACY");

  assert.throws(() => operations.assertVerifierLocation({
    lat: -0.9472,
    lng: 100.4172,
    accuracy: 10,
    capturedAt: nowMs - 121_000,
    source: "gps-high",
  }, nowMs, geofence), (error) =>
    error?.reason === "LOCATION_STALE");
});

test("password change requires a recent, unrevoked post-reset login", async () => {
  let checkRevoked = null;
  const admin = {
    auth: () => ({
      verifyIdToken: async (_token, shouldCheckRevoked) => {
        checkRevoked = shouldCheckRevoked;
        return {uid: "employee-1", auth_time: 1_000};
      },
    }),
  };
  const request = {
    rawRequest: {headers: {authorization: "Bearer valid.id.token"}},
  };
  await operations.assertRecentUnrevokedAuth(
      admin,
      request,
      "employee-1",
      999_500,
      1_100_000,
  );
  assert.equal(checkRevoked, true);

  await assert.rejects(
      operations.assertRecentUnrevokedAuth(
          admin,
          request,
          "employee-1",
          1_001_000,
          1_100_000,
      ),
      /password sementara/i,
  );

  const revokedAdmin = {
    auth: () => ({
      verifyIdToken: async () => {
        throw new Error("revoked");
      },
    }),
  };
  await assert.rejects(
      operations.assertRecentUnrevokedAuth(
          revokedAdmin,
          request,
          "employee-1",
          900_000,
          1_100_000,
      ),
      /password sementara/i,
  );
});

test("admin App Check denials log only fingerprints", async () => {
  const firestore = () => ({});
  firestore.Timestamp = {};
  firestore.FieldValue = {};
  const handlers = operations.createAdminHandlers({
    firestore,
    auth: () => ({}),
  });
  const originalWarn = logger.warn;
  let event;
  logger.warn = (_message, payload) => {
    event = payload;
  };
  try {
    await assert.rejects(handlers.getOnsitePresenceCode({
      auth: {uid: "admin-sensitive-id"},
      data: {
        geofenceType: "kelurahan",
        geofenceId: "geofence-sensitive-id",
        employeeUid: "employee-sensitive-id",
        location: {lat: 1, lng: 1},
      },
    }), (error) => error?.details?.reason === "APP_CHECK_REQUIRED");
  } finally {
    logger.warn = originalWarn;
  }
  assert.equal(event.event, "attendance_admin_security_event");
  assert.equal(event.reason, "APP_CHECK_REQUIRED");
  assert.match(event.actorFingerprint, /^[0-9a-f]{20}$/);
  assert.match(event.employeeFingerprint, /^[0-9a-f]{20}$/);
  assert.match(event.geofenceFingerprint, /^[0-9a-f]{20}$/);
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("admin-sensitive-id"), false);
  assert.equal(serialized.includes("employee-sensitive-id"), false);
  assert.equal(serialized.includes("geofence-sensitive-id"), false);
  assert.equal(serialized.includes("\"lat\""), false);
});
