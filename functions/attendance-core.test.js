"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const core = require("./attendance-core");

function malformedJpegBuffer(width = 640, height = 480,
    size = 12 * 1024) {
  const buffer = Buffer.alloc(size);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[buffer.length - 2] = 0xff;
  buffer[buffer.length - 1] = 0xd9;
  return buffer;
}

async function jpegBuffer(width = 640, height = 480) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const block = ((Math.floor(x / 40) + Math.floor(y / 32)) % 2) * 55;
      pixels[index] = (35 + Math.floor(x / width * 130) + block) % 256;
      pixels[index + 1] = (25 + Math.floor(y / height * 150) + block) % 256;
      pixels[index + 2] =
        (50 + Math.floor((x + y) / (width + height) * 120) + block) % 256;
    }
  }
  return sharp(pixels, {raw: {width, height, channels: 3}})
      .jpeg({quality: 100, chromaSubsampling: "4:4:4"})
      .toBuffer();
}

test("server stamp uses WIB date and canonical deadline", () => {
  const beforeDeadline = new Date("2026-07-23T00:59:59.000Z");
  const atDeadline = new Date("2026-07-23T01:00:00.000Z");
  assert.deepEqual(core.getServerAttendanceStamp(beforeDeadline, "08:00"), {
    date: "2026-07-23",
    status: "ontime",
    deadline: "08:00",
    timeZone: "Asia/Jakarta",
  });
  assert.equal(
      core.getServerAttendanceStamp(atDeadline, "08:00").status,
      "late",
  );
  assert.equal(
      core.getServerAttendanceStamp(atDeadline, "not-a-time").deadline,
      "08:00",
  );
});

test("WIB date rolls over seven hours ahead of UTC", () => {
  const stamp = core.getServerAttendanceStamp(
      new Date("2026-07-22T17:30:00.000Z"),
      "08:00",
  );
  assert.equal(stamp.date, "2026-07-23");
});

test("challenge UUID and actions are strict", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(core.assertChallengeId(uuid), uuid);
  assert.equal(core.assertAction("checkIn"), "checkIn");
  assert.throws(() => core.assertChallengeId("../../escape"));
  assert.throws(() => core.assertAction("delete"));
});

test("location must be fresh, accurate, and GPS sourced", () => {
  const now = 2_000_000;
  const valid = {
    lat: -0.95,
    lng: 100.36,
    accuracy: 12,
    capturedAt: now - 1000,
    source: "gps-high",
  };
  assert.deepEqual(core.normalizeLocation(valid, now), valid);
  assert.throws(() => core.normalizeLocation({
    ...valid,
    accuracy: 101,
  }, now), /Akurasi GPS/);
  assert.throws(() => core.normalizeLocation({
    ...valid,
    capturedAt: now - 130_000,
  }, now), /kedaluwarsa/);
  assert.throws(() => core.normalizeLocation({
    ...valid,
    source: "manual",
  }, now), /Sumber lokasi/);
  assert.throws(() => core.normalizeLocation({
    ...valid,
    forgedAccuracyFlag: true,
  }, now), /field yang tidak diizinkan/);
});

test("geofence must be active and field-verified", () => {
  const data = {
    isActive: true,
    coordinateStatus: "verified",
    lat: -0.95,
    lng: 100.36,
    radius: 300,
    nama: "Kelurahan Test",
    presenceProofRequired: true,
    verifiedBy: "Petugas Lapangan",
    verificationReviewedBy: "Reviewer Lapangan",
    verificationEvidence: "BA pemeriksaan lapangan 001",
    verificationOperator: "1".repeat(64),
    verificationReviewOperator: "2".repeat(64),
    verificationAuditId:
      "kelurahan_kel-test_11111111-1111-4111-8111-111111111111",
  };
  const geofence = core.normalizeGeofence(data, "kel-test", 1234, 1235);
  assert.equal(geofence.presenceProofRequired, true);
  assert.equal(core.assertGeofenceAudit({
    schemaVersion: 2,
    action: "geofence_physical_verification",
    auditId: data.verificationAuditId,
    status: "approved",
    geofenceCollection: "kelurahan",
    geofenceId: "kel-test",
    verifiedLat: data.lat,
    verifiedLng: data.lng,
    verifiedRadius: data.radius,
    verifiedBy: data.verifiedBy,
    reviewedBy: data.verificationReviewedBy,
    evidence: data.verificationEvidence,
    operator: "security.operator@example.test",
    reviewOperator: "review.operator@example.test",
    operatorAccountFingerprint: data.verificationOperator,
    reviewOperatorAccountFingerprint: data.verificationReviewOperator,
  }, {collection: "kelurahan", ...geofence}, 1234, 1200), true);
  assert.throws(() => core.assertGeofenceAudit({
    schemaVersion: 2,
    action: "geofence_physical_verification",
    auditId: data.verificationAuditId,
    status: "approved",
    geofenceCollection: "kelurahan",
    geofenceId: "kel-test",
    verifiedLat: data.lat + 0.01,
    verifiedLng: data.lng,
    verifiedRadius: data.radius,
    verifiedBy: data.verifiedBy,
    reviewedBy: data.verificationReviewedBy,
    evidence: data.verificationEvidence,
    operator: "security.operator@example.test",
    reviewOperator: "review.operator@example.test",
    operatorAccountFingerprint: data.verificationOperator,
    reviewOperatorAccountFingerprint: data.verificationReviewOperator,
  }, {collection: "kelurahan", ...geofence}, 1234, 1200), /tidak cocok/);
  assert.throws(() => core.assertGeofenceAudit({
    schemaVersion: 2,
    action: "geofence_physical_verification",
    auditId: data.verificationAuditId,
    status: "approved",
    geofenceCollection: "kelurahan",
    geofenceId: "kel-test",
    verifiedLat: data.lat,
    verifiedLng: data.lng,
    verifiedRadius: data.radius,
    verifiedBy: data.verifiedBy,
    reviewedBy: data.verificationReviewedBy,
    evidence: data.verificationEvidence,
    operator: "different.operator@example.test",
    reviewOperator: "review.operator@example.test",
    operatorAccountFingerprint: "3".repeat(64),
    reviewOperatorAccountFingerprint: data.verificationReviewOperator,
  }, {collection: "kelurahan", ...geofence}, 1234, 1200), /tidak cocok/);
  assert.throws(() => core.normalizeGeofence({
    ...data,
    coordinateStatus: "provisional",
  }, "kel-test", 1234, 1235), /belum aktif/);
  assert.throws(() => core.normalizeGeofence(data, "kel-test", NaN, 1235),
      /verifikasi lapangan/);
  const withoutPolicy = {...data};
  delete withoutPolicy.presenceProofRequired;
  assert.throws(() => core.normalizeGeofence(
      withoutPolicy,
      "kel-test",
      1234,
      1235,
  ), /bukti kehadiran onsite/);
  assert.throws(() => core.normalizeGeofence({
    ...data,
    presenceProofRequired: false,
  }, "kel-test", 1234, 1235), /bukti kehadiran onsite/);
  assert.throws(() => core.normalizeGeofence({
    ...data,
    radius: 501,
  }, "kel-test", 1234, 1235), /Konfigurasi geofence/);
  assert.throws(() => core.normalizeGeofence({
    ...data,
    verificationEvidence: "",
  }, "kel-test", 1234, 1235), /Bukti audit/);
  assert.throws(() => core.normalizeGeofence({
    ...data,
    verificationReviewedBy: data.verifiedBy,
  }, "kel-test", 1234, 1235), /Review petugas kedua/);
  assert.throws(() => core.normalizeGeofence({
    ...data,
    verificationReviewOperator: data.verificationOperator,
  }, "kel-test", 1234, 1235), /akun operator kedua/);
});

test("distance is calculated server-side in meters", () => {
  assert.equal(core.calculateDistanceMeters(0, 0, 0, 0), 0);
  const distance = core.calculateDistanceMeters(0, 0, 0, 0.001);
  assert.ok(distance > 111 && distance < 112);
});

test("distance stays finite for near-antipodal coordinates", () => {
  const distance = core.calculateDistanceMeters(
      -0.95,
      100.36,
      0.949999622230706,
      -79.63999998280809,
  );
  assert.ok(Number.isFinite(distance));
  assert.ok(distance > 20_000_000 && distance < 20_020_000);
});

test("active employee and canonical assignment are required", () => {
  const user = {
    accountStatus: "active",
    isActive: true,
    role: "field_staff",
    assignmentType: "kelurahan",
    kelurahanId: "kel-test",
  };
  assert.equal(core.assertActiveEmployee(user), user);
  assert.deepEqual(core.resolveAssignment(user), {
    collection: "kelurahan",
    id: "kel-test",
  });
  assert.throws(() => core.assertActiveEmployee({
    ...user,
    isActive: false,
  }), /tidak aktif/);
  assert.throws(() => core.assertActiveEmployee({
    ...user,
    mustChangePassword: true,
  }), /Password sementara/);
  assert.throws(() => core.resolveAssignment({
    ...user,
    kelurahanId: "",
  }), /belum dikonfigurasi/);
});

test("JPEG bytes are fully decoded, dimension checked, and hashed", async () => {
  const photo = await jpegBuffer();
  const result = await core.validatePhotoBytes(photo);
  assert.equal(result.width, 640);
  assert.equal(result.height, 480);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.perceptualHash, /^[0-9a-f]{36}$/);
  assert.equal(result.perceptualHashes.length, 8);
  assert.equal(result.perceptualHashes[0], result.perceptualHash);
  assert.ok(result.perceptualHashes.every((hash) =>
    /^[0-9a-f]{36}$/.test(hash),
  ));
  await assert.rejects(
      core.validatePhotoBytes(await jpegBuffer(120, 120)),
      /Ukuran foto|Dimensi foto/,
  );
  await assert.rejects(
      core.validatePhotoBytes(malformedJpegBuffer()),
      /rusak|didekode/,
  );
});

test("blank and low-information JPEG proofs are rejected", async () => {
  const width = 1024;
  const height = 768;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    const value = 120 + ((index / 3) % 2);
    pixels[index] = value;
    pixels[index + 1] = value;
    pixels[index + 2] = value;
  }
  const flat = await sharp(pixels, {
    raw: {width, height, channels: 3},
  }).jpeg({quality: 100, chromaSubsampling: "4:4:4"}).toBuffer();
  assert.ok(flat.length >= 10 * 1024);
  await assert.rejects(
      core.validatePhotoBytes(flat),
      (error) => error?.reason === "PHOTO_LOW_INFORMATION",
  );
});

test("perceptual replay distance has a strict six-bit threshold", async () => {
  const zeroHash = "0".repeat(36);
  const sixChangedBands = `fc${"0".repeat(34)}`;
  const sevenChangedBands = `fe${"0".repeat(34)}`;

  assert.equal(core.perceptualHashDistance(zeroHash, sixChangedBands), 6);
  assert.equal(core.perceptualHashDistance(zeroHash, sevenChangedBands), 7);
  assert.equal(core.PERCEPTUAL_REPLAY_MAX_DISTANCE, 6);
  assert.equal(core.PERCEPTUAL_REPLAY_WINDOW_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(core.PERCEPTUAL_REPLAY_MAX_ENTRIES, 64);
  assert.equal(core.PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION, 1);
  assert.throws(() => core.perceptualHashDistance("invalid", zeroHash));
});

test("high-quality JPEG re-encoding stays inside replay threshold", async () => {
  const width = 640;
  const height = 480;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = 60 + Math.floor((x / width) * 140);
      pixels[index + 1] = 50 + Math.floor((y / height) * 130);
      pixels[index + 2] = 90 +
        Math.floor(((x + y) / (width + height)) * 100);
      if ((Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0) {
        pixels[index] = Math.min(255, pixels[index] + 50);
        pixels[index + 1] = Math.min(255, pixels[index + 1] + 50);
        pixels[index + 2] = Math.min(255, pixels[index + 2] + 50);
      }
    }
  }
  const original = await sharp(pixels, {
    raw: {width, height, channels: 3},
  }).jpeg({quality: 95}).toBuffer();
  const reencoded = await sharp(original).jpeg({quality: 90}).toBuffer();
  const originalProof = await core.validatePhotoBytes(original);
  const reencodedProof = await core.validatePhotoBytes(reencoded);
  const distance = core.minimumPerceptualHashDistance(
      originalProof.perceptualHashes,
      reencodedProof.perceptualHashes,
  );

  assert.notEqual(originalProof.sha256, reencodedProof.sha256);
  assert.ok(distance <= core.PERCEPTUAL_REPLAY_MAX_DISTANCE);
});

test("multi-view replay hash catches mirror, crop, border, and rotation", async () => {
  const width = 640;
  const height = 480;
  const original = await jpegBuffer(width, height);
  const variants = [
    await sharp(original).flop().jpeg({quality: 94}).toBuffer(),
    await sharp(original)
        .extract({left: 6, top: 5, width: 628, height: 470})
        .resize(width, height)
        .jpeg({quality: 94})
        .toBuffer(),
    await sharp(original)
        .composite([{
          input: {create: {
            width: 3,
            height,
            channels: 3,
            background: "white",
          }},
          left: 0,
          top: 0,
        }])
        .jpeg({quality: 94})
        .toBuffer(),
    await sharp(original)
        .rotate(1, {background: "white"})
        .jpeg({quality: 94})
        .toBuffer(),
  ];
  const originalProof = await core.validatePhotoBytes(original);

  for (const variant of variants) {
    const variantProof = await core.validatePhotoBytes(variant);
    const distance = core.minimumPerceptualHashDistance(
        originalProof.perceptualHashes,
        variantProof.perceptualHashes,
    );
    assert.ok(
        distance <= core.PERCEPTUAL_REPLAY_MAX_DISTANCE,
        `variant distance ${distance} exceeded replay threshold`,
    );
  }
});

test("photo metadata is challenge-bound and fresh", () => {
  const now = Date.parse("2026-07-23T01:00:00.000Z");
  const expected = {
    uid: "user-1",
    action: "checkIn",
    challengeId: "550e8400-e29b-41d4-a716-446655440000",
    photoPath:
      "attendanceProofs/user-1/550e8400-e29b-41d4-a716-446655440000",
    challengeCreatedAtMs: now - 20_000,
    challengeExpiresAtMs: now + 200_000,
  };
  const metadata = {
    name: expected.photoPath,
    contentType: "image/jpeg",
    generation: "10",
    metageneration: "1",
    timeCreated: new Date(now - 10_000).toISOString(),
    metadata: {
      uid: expected.uid,
      action: expected.action,
      challengeId: expected.challengeId,
    },
  };
  assert.doesNotThrow(() => {
    core.validatePhotoMetadata(metadata, expected, now);
  });
  assert.throws(() => core.validatePhotoMetadata({
    ...metadata,
    metadata: {...metadata.metadata, uid: "attacker"},
  }, expected, now), /tidak terikat/);
  assert.throws(() => core.validatePhotoMetadata({
    ...metadata,
    timeCreated: new Date(now - 300_000).toISOString(),
  }, expected, now), /tidak diambil/);
});

test("presence code rotates and accepts only current grace window", () => {
  const secret = Buffer.alloc(32, 7).toString("base64");
  const now = 1_800_000;
  const counter = core.presenceCounter(now);
  const context = "kelurahan:kel-test:user-1:challenge-1";
  const current = core.createPresenceCode(secret, counter, context);
  const previous = core.createPresenceCode(secret, counter - 1, context);
  assert.match(current, /^\d{6}$/);
  assert.equal(
      core.verifyPresenceCode(secret, current, now, context),
      counter,
  );
  assert.equal(
      core.verifyPresenceCode(secret, previous, now, context),
      counter - 1,
  );
  assert.equal(core.verifyPresenceCode(secret, "abcdef", now, context), null);
  assert.equal(
      core.verifyPresenceCode(secret, current, now, `${context}:attacker`),
      null,
  );
});

test("work hours are computed from server timestamps", () => {
  assert.equal(core.calculateWorkHours(0, 8.555 * 3600000), 8.56);
  assert.throws(() => core.calculateWorkHours(100, 99), /tidak konsisten/);
});

test("operational locations normalize, filter by window, and digest stably", () => {
  const entry = {
    id: "bimtek-test",
    nama: "BimTek Test Venue",
    lat: -0.9546883,
    lng: 100.3643174,
    radius: 150,
    validFrom: "2026-07-27T17:00:00.000Z",
    validUntil: "2026-07-31T17:00:00.000Z",
  };
  const normalized = core.normalizeOperationalLocation(entry);
  assert.equal(normalized.id, "bimtek-test");
  assert.equal(normalized.radius, 150);
  assert.equal(normalized.validFromMs, Date.parse(entry.validFrom));

  assert.throws(() => core.normalizeOperationalLocation({
    ...entry,
    radius: 40,
  }), /tidak valid/);
  assert.throws(() => core.normalizeOperationalLocation({
    ...entry,
    forged: true,
  }), /tidak diizinkan/);

  const before = core.normalizeAllowedLocations(
      [entry],
      Date.parse("2026-07-27T16:59:59.000Z"),
  );
  assert.equal(before.locations.length, 0);
  assert.match(before.digest, /^[0-9a-f]{64}$/);

  const inside = core.normalizeAllowedLocations(
      [entry],
      Date.parse("2026-07-28T01:00:00.000Z"),
  );
  assert.equal(inside.locations.length, 1);
  assert.equal(inside.digest, before.digest);

  const after = core.normalizeAllowedLocations(
      [entry],
      Date.parse("2026-07-31T17:00:00.000Z"),
  );
  assert.equal(after.locations.length, 0);
  assert.equal(after.digest, before.digest);
});

test("matchOperationalLocation accepts nearest in-radius candidate", () => {
  const gps = {
    lat: -0.9546883,
    lng: 100.3643174,
    accuracy: 20,
  };
  const assignment = {
    id: "kelurahan:kel-test",
    nama: "Kelurahan Test",
    lat: -0.9528483,
    lng: 100.3646431,
    radius: 300,
    source: "assignment",
  };
  const venue = {
    id: "bimtek-test",
    nama: "BimTek Venue",
    lat: -0.9546883,
    lng: 100.3643174,
    radius: 150,
    source: "temporary",
  };
  const match = core.matchOperationalLocation(gps, [assignment, venue]);
  assert.equal(match.location.id, "bimtek-test");
  assert.ok(match.uncertaintyAdjustedDistanceMeters <= 150);

  const outside = core.matchOperationalLocation({
    lat: -0.90,
    lng: 100.30,
    accuracy: 10,
  }, [assignment, venue]);
  assert.equal(outside, null);
});
