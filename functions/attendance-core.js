"use strict";

/* global BigInt */

const crypto = require("node:crypto");
const sharp = require("sharp");

const WIB_TIME_ZONE = "Asia/Jakarta";
const DEFAULT_DEADLINE = "08:00";
const MAX_LOCATION_AGE_MS = 2 * 60 * 1000;
const MAX_LOCATION_FUTURE_SKEW_MS = 10 * 1000;
const MAX_LOCATION_ACCURACY_METERS = 100;
const MAX_GEOFENCE_RADIUS_METERS = 500;
const MIN_JPEG_BYTES = 10 * 1024;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const MIN_IMAGE_SIDE = 240;
const MAX_IMAGE_SIDE = 4096;
const MAX_IMAGE_PIXELS = 12 * 1000 * 1000;
const ALLOWED_LOCATION_SOURCES = new Set(["gps-high", "gps-low"]);
const ALLOWED_ACTIONS = new Set(["checkIn", "checkOut"]);
// The single project office ("kantor proyek") field staff may additionally
// check in/out at, alongside their assigned kelurahan. Kept in sync with the
// client's KANTOR_DEFAULT_ID in src/services/geofenceService.js.
const PROJECT_OFFICE_KANTOR_ID = "kantor-padang-kota";
const ASSIGNMENT_CHOICE_COLLECTIONS = new Set(["kelurahan", "kantor"]);
const PRESENCE_CODE_PERIOD_SECONDS = 60;
const PERCEPTUAL_HASH_HEX_LENGTH = 36;
const PERCEPTUAL_HASH_BAND_COUNT = 7;
const PERCEPTUAL_HASH_VIEW_COUNT = 8;
const PERCEPTUAL_HASH_VERSION = "dh144mv2";
const PERCEPTUAL_REPLAY_MAX_DISTANCE = 6;
const PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION = 1;
const PERCEPTUAL_REPLAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PERCEPTUAL_REPLAY_MAX_ENTRIES = 64;
const PERCEPTUAL_CROP_RATIOS = Object.freeze([1, 0.96, 0.92, 0.88]);
const MIN_PHOTO_LUMA_STANDARD_DEVIATION = 10;
const MIN_PHOTO_LUMA_P90_SPAN = 25;
const MIN_PHOTO_EDGE_RMS = 4;
const MIN_PHOTO_LUMA_P95 = 25;
const MAX_PHOTO_LUMA_P05 = 230;
const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

class AttendanceInputError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "AttendanceInputError";
    this.reason = reason;
  }
}

function fail(reason, message) {
  throw new AttendanceInputError(reason, message);
}

function assertAction(action) {
  if (typeof action !== "string" || !ALLOWED_ACTIONS.has(action)) {
    fail("INVALID_ACTION", "Aksi absensi tidak valid.");
  }
  return action;
}

function assertChallengeId(challengeId) {
  const uuid = new RegExp(
      "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-" +
      "[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      "i",
  );
  if (typeof challengeId !== "string" || !uuid.test(challengeId)) {
    fail("INVALID_CHALLENGE", "Challenge absensi tidak valid.");
  }
  return challengeId;
}

function wibParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WIB_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function normalizeDeadline(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
    return DEFAULT_DEADLINE;
  }
  const [hour, minute] = value.split(":").map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return DEFAULT_DEADLINE;
  }
  return value;
}

function getServerAttendanceStamp(date, deadlineValue) {
  const parts = wibParts(date);
  const deadline = normalizeDeadline(deadlineValue);
  const [deadlineHour, deadlineMinute] = deadline.split(":").map(Number);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const deadlineMinutes = deadlineHour * 60 + deadlineMinute;
  return {
    date: parts.date,
    status: currentMinutes >= deadlineMinutes ? "late" : "ontime",
    deadline,
    timeZone: WIB_TIME_ZONE,
  };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeLocation(raw, nowMs, permittedExtraKeys = []) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("INVALID_LOCATION", "Data GPS wajib disertakan.");
  }
  const allowedKeys = new Set([
    "lat",
    "lng",
    "accuracy",
    "capturedAt",
    "source",
    ...permittedExtraKeys,
  ]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
    fail("INVALID_LOCATION", "Data GPS mengandung field yang tidak diizinkan.");
  }
  const {lat, lng, accuracy, capturedAt, source} = raw;
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90 ||
      !isFiniteNumber(lng) || lng < -180 || lng > 180 ||
      (lat === 0 && lng === 0)) {
    fail("INVALID_LOCATION", "Koordinat GPS tidak valid.");
  }
  if (!isFiniteNumber(accuracy) || accuracy <= 0 ||
      accuracy > MAX_LOCATION_ACCURACY_METERS) {
    fail(
        "LOCATION_ACCURACY",
        "Akurasi GPS harus " + MAX_LOCATION_ACCURACY_METERS +
        " meter atau lebih baik.",
    );
  }
  if (!Number.isInteger(capturedAt)) {
    fail("LOCATION_STALE", "Waktu pengambilan GPS tidak valid.");
  }
  if (capturedAt < nowMs - MAX_LOCATION_AGE_MS ||
      capturedAt > nowMs + MAX_LOCATION_FUTURE_SKEW_MS) {
    fail("LOCATION_STALE", "Lokasi GPS sudah kedaluwarsa.");
  }
  if (!ALLOWED_LOCATION_SOURCES.has(source)) {
    fail("INVALID_LOCATION_SOURCE", "Sumber lokasi GPS tidak valid.");
  }
  return {lat, lng, accuracy, capturedAt, source};
}

function calculateDistanceMeters(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const firstLat = toRadians(lat1);
  const secondLat = toRadians(lat2);
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);
  const haversine = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(firstLat) * Math.cos(secondLat) *
    Math.sin(deltaLng / 2) ** 2;
  // Near-antipodal points can round just above 1. Clamp so the result never
  // becomes NaN and bypasses a later fail-closed radius comparison.
  const boundedHaversine = Math.min(1, Math.max(0, haversine));
  return earthRadius * 2 * Math.atan2(
      Math.sqrt(boundedHaversine),
      Math.sqrt(1 - boundedHaversine),
  );
}

function normalizeGeofence(data, id, verifiedAtMs, reviewedAtMs) {
  if (!data || data.isActive !== true ||
      data.coordinateStatus !== "verified") {
    fail(
        "GEOFENCE_INACTIVE",
        "Geofence penugasan belum aktif dan terverifikasi.",
    );
  }
  if (!Number.isFinite(verifiedAtMs) || verifiedAtMs <= 0) {
    fail(
        "GEOFENCE_UNVERIFIED",
        "Geofence penugasan belum memiliki verifikasi lapangan.",
    );
  }
  const validAuditId = typeof data.verificationAuditId === "string" &&
    /^[A-Za-z0-9:_-]{1,180}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(data.verificationAuditId);
  if (typeof data.verifiedBy !== "string" ||
      data.verifiedBy.trim().length < 3 ||
      data.verifiedBy.trim().length > 120 ||
      typeof data.verificationEvidence !== "string" ||
      data.verificationEvidence.trim().length < 8 ||
      data.verificationEvidence.trim().length > 500 ||
      typeof data.verificationOperator !== "string" ||
      !/^[0-9a-f]{64}$/.test(data.verificationOperator) || !validAuditId) {
    fail(
        "GEOFENCE_AUDIT_MISSING",
        "Bukti audit verifikasi lapangan geofence belum lengkap.",
    );
  }
  if (typeof data.verificationReviewedBy !== "string" ||
      data.verificationReviewedBy.trim().length < 3 ||
      data.verificationReviewedBy.trim().length > 120 ||
      data.verificationReviewedBy.trim().toLocaleLowerCase("id-ID") ===
        data.verifiedBy.trim().toLocaleLowerCase("id-ID") ||
      !Number.isFinite(reviewedAtMs) || reviewedAtMs <= 0) {
    fail(
        "GEOFENCE_REVIEW_MISSING",
        "Review petugas kedua untuk geofence belum lengkap.",
    );
  }
  if (typeof data.verificationReviewOperator !== "string" ||
      !/^[0-9a-f]{64}$/.test(data.verificationReviewOperator) ||
      data.verificationReviewOperator === data.verificationOperator) {
    fail(
        "GEOFENCE_REVIEW_MISSING",
        "Review geofence wajib dilakukan akun operator kedua.",
    );
  }
  if (data.presenceProofRequired !== true) {
    fail(
        "PRESENCE_PROOF_REQUIRED",
        "Geofence wajib menggunakan bukti kehadiran onsite.",
    );
  }
  const lat = Number(data.lat);
  const lng = Number(data.lng);
  const radius = Number(data.radius);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lng) || lng < -180 || lng > 180 ||
      (lat === 0 && lng === 0) ||
      !Number.isFinite(radius) || radius <= 0 ||
      radius > MAX_GEOFENCE_RADIUS_METERS) {
    fail("GEOFENCE_INVALID", "Konfigurasi geofence tidak valid.");
  }
  return {
    id,
    name: typeof data.nama === "string" && data.nama.trim() ?
      data.nama.trim() : id,
    lat,
    lng,
    radius,
    verifiedAtMs,
    verifiedBy: data.verifiedBy.trim(),
    reviewedAtMs,
    reviewedBy: data.verificationReviewedBy.trim(),
    verificationOperator: data.verificationOperator,
    verificationReviewOperator: data.verificationReviewOperator,
    verificationAuditId: data.verificationAuditId,
    verificationEvidence: data.verificationEvidence.trim(),
    presenceProofRequired: true,
  };
}

function assertGeofenceAudit(audit, expected, createdAtMs, proposedAtMs) {
  if (!audit || audit.schemaVersion !== 2 ||
      audit.action !== "geofence_physical_verification" ||
      audit.status !== "approved" ||
      audit.auditId !== expected.verificationAuditId ||
      audit.geofenceCollection !== expected.collection ||
      audit.geofenceId !== expected.id ||
      audit.verifiedLat !== expected.lat ||
      audit.verifiedLng !== expected.lng ||
      audit.verifiedRadius !== expected.radius ||
      audit.verifiedBy !== expected.verifiedBy ||
      audit.reviewedBy !== expected.reviewedBy ||
      audit.evidence !== expected.verificationEvidence ||
      typeof audit.operator !== "string" ||
      audit.operator.length < 3 || audit.operator.length > 320 ||
      typeof audit.reviewOperator !== "string" ||
      audit.reviewOperator.length < 3 || audit.reviewOperator.length > 320 ||
      audit.reviewOperator.toLocaleLowerCase("id-ID") ===
        audit.operator.toLocaleLowerCase("id-ID") ||
      typeof audit.operatorAccountFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(audit.operatorAccountFingerprint) ||
      audit.operatorAccountFingerprint !== expected.verificationOperator ||
      typeof audit.reviewOperatorAccountFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(audit.reviewOperatorAccountFingerprint) ||
      audit.reviewOperatorAccountFingerprint !==
        expected.verificationReviewOperator ||
      audit.operatorAccountFingerprint ===
        audit.reviewOperatorAccountFingerprint ||
      !Number.isFinite(proposedAtMs) || proposedAtMs <= 0 ||
      !Number.isFinite(createdAtMs) || createdAtMs <= 0 ||
      proposedAtMs > createdAtMs ||
      Math.abs(createdAtMs - expected.verifiedAtMs) > 1000 ||
      Math.abs(createdAtMs - expected.reviewedAtMs) > 1000) {
    fail(
        "GEOFENCE_AUDIT_INVALID",
        "Dokumen audit verifikasi geofence tidak cocok.",
    );
  }
  return true;
}

function resolveAssignment(user) {
  if (!user || typeof user !== "object") {
    fail("PROFILE_MISSING", "Profil pengguna tidak ditemukan.");
  }
  if (user.assignmentType === "kelurahan" || user.role === "field_staff") {
    if (typeof user.kelurahanId !== "string" || !user.kelurahanId) {
      fail("ASSIGNMENT_MISSING", "Penugasan kelurahan belum dikonfigurasi.");
    }
    return {collection: "kelurahan", id: user.kelurahanId};
  }
  if (user.assignmentType === "kantor" || user.role === "office_staff") {
    if (typeof user.kantorId !== "string" || !user.kantorId) {
      fail("ASSIGNMENT_MISSING", "Penugasan kantor belum dikonfigurasi.");
    }
    return {collection: "kantor", id: user.kantorId};
  }
  fail("ASSIGNMENT_MISSING", "Penugasan pengguna belum dikonfigurasi.");
}

/**
 * Ordered list of geofences a user is allowed to check in/out at. The first
 * entry is always the canonical `resolveAssignment` result (used whenever no
 * explicit choice is made). Field staff normally work out of their assigned
 * kelurahan, but may also attend the project office in person (e.g. training,
 * coordination meetings), so the project kantor is appended as a second,
 * equally-enforced candidate. Office staff are unaffected: their only
 * candidate remains their own kantor.
 */
function resolveAssignmentCandidates(user) {
  const primary = resolveAssignment(user);
  if (primary.collection === "kelurahan") {
    return [primary, {collection: "kantor", id: PROJECT_OFFICE_KANTOR_ID}];
  }
  return [primary];
}

/**
 * Validates an optional client-supplied choice of which candidate geofence
 * (from resolveAssignmentCandidates) a check-in/out challenge should target.
 * Returns null when the caller wants the default (primary) assignment.
 */
function assertAssignmentChoice(value) {
  if (value == null) return null;
  if (!ASSIGNMENT_CHOICE_COLLECTIONS.has(value)) {
    fail("ASSIGNMENT_CHOICE_INVALID", "Pilihan lokasi absensi tidak valid.");
  }
  return value;
}

const MAX_OPERATIONAL_LOCATIONS = 8;
const MIN_OPERATIONAL_RADIUS_METERS = 50;
const MAX_OPERATIONAL_LOCATION_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const OPERATIONAL_LOCATION_KEYS = Object.freeze([
  "id",
  "nama",
  "lat",
  "lng",
  "radius",
  "validFrom",
  "validUntil",
]);

function timestampMillisLoose(value) {
  if (value == null) return NaN;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  if (typeof value.toMillis === "function") {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : NaN;
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : NaN;
  }
  return NaN;
}

/**
 * Operator-declared temporary location for location_photo mode.
 * Deliberately weaker than normalizeGeofence: no dual-control audit.
 */
function normalizeOperationalLocation(data, fallbackId = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail("OPERATIONAL_LOCATION_INVALID", "Lokasi operasional tidak valid.");
  }
  const unknownKeys = Object.keys(data).filter(
      (key) => !OPERATIONAL_LOCATION_KEYS.includes(key) &&
        !["alamat", "coordinateSource", "coordinateSourceUrl", "catatan"]
            .includes(key),
  );
  if (unknownKeys.length > 0) {
    fail(
        "OPERATIONAL_LOCATION_INVALID",
        "Lokasi operasional mengandung field yang tidak diizinkan.",
    );
  }
  const id = typeof data.id === "string" && data.id.trim() ?
    data.id.trim() :
    (typeof fallbackId === "string" ? fallbackId.trim() : "");
  if (!id || id.length > 120 || !/^[A-Za-z0-9:_-]{1,120}$/.test(id)) {
    fail("OPERATIONAL_LOCATION_INVALID", "ID lokasi operasional tidak valid.");
  }
  const nama = typeof data.nama === "string" ? data.nama.trim() : "";
  if (!nama || nama.length > 200) {
    fail(
        "OPERATIONAL_LOCATION_INVALID",
        "Nama lokasi operasional tidak valid.",
    );
  }
  const lat = Number(data.lat);
  const lng = Number(data.lng);
  const radius = Number(data.radius);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lng) || lng < -180 || lng > 180 ||
      (lat === 0 && lng === 0) ||
      !Number.isFinite(radius) ||
      radius < MIN_OPERATIONAL_RADIUS_METERS ||
      radius > MAX_GEOFENCE_RADIUS_METERS) {
    fail(
        "OPERATIONAL_LOCATION_INVALID",
        "Koordinat atau radius lokasi operasional tidak valid.",
    );
  }
  const validFromMs = timestampMillisLoose(data.validFrom);
  const validUntilMs = timestampMillisLoose(data.validUntil);
  if (!Number.isFinite(validFromMs) || !Number.isFinite(validUntilMs) ||
      validUntilMs <= validFromMs ||
      validUntilMs - validFromMs > MAX_OPERATIONAL_LOCATION_WINDOW_MS) {
    fail(
        "OPERATIONAL_LOCATION_INVALID",
        "Jendela waktu lokasi operasional tidak valid.",
    );
  }
  return {
    id,
    nama,
    lat,
    lng,
    radius,
    validFromMs,
    validUntilMs,
  };
}

function canonicalAllowedLocationsPayload(locations) {
  return locations.map((location) => ({
    id: location.id,
    nama: location.nama,
    lat: location.lat,
    lng: location.lng,
    radius: location.radius,
    validFrom: new Date(location.validFromMs).toISOString(),
    validUntil: new Date(location.validUntilMs).toISOString(),
  }));
}

function digestAllowedLocations(locations) {
  const payload = canonicalAllowedLocationsPayload(locations);
  return crypto.createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
}

/**
 * Normalize the configured temporary-location list, optionally filtering to
 * entries whose window contains nowMs. Returns active entries plus a digest
 * over the full normalized list (not only the filtered subset) so challenge
 * snapshots stay stable when windows expire mid-challenge.
 */
function normalizeAllowedLocations(list, nowMs = null) {
  if (list == null) {
    return {locations: [], digest: digestAllowedLocations([])};
  }
  if (!Array.isArray(list)) {
    fail(
        "OPERATIONAL_LOCATION_INVALID",
        "Daftar lokasi operasional harus berupa array.",
    );
  }
  if (list.length > MAX_OPERATIONAL_LOCATIONS) {
    fail(
        "OPERATIONAL_LOCATION_INVALID",
        "Daftar lokasi operasional melebihi batas aman.",
    );
  }
  const normalized = [];
  const seenIds = new Set();
  for (const entry of list) {
    const location = normalizeOperationalLocation(entry);
    if (seenIds.has(location.id)) {
      fail(
          "OPERATIONAL_LOCATION_INVALID",
          "ID lokasi operasional duplikat.",
      );
    }
    seenIds.add(location.id);
    normalized.push(location);
  }
  normalized.sort((left, right) => left.id.localeCompare(right.id));
  const digest = digestAllowedLocations(normalized);
  if (!Number.isFinite(nowMs)) {
    return {locations: normalized, digest};
  }
  const active = normalized.filter((location) =>
    location.validFromMs <= nowMs && nowMs < location.validUntilMs,
  );
  return {locations: active, digest, all: normalized};
}

function publicOperationalLocation(location) {
  return {
    id: location.id,
    name: location.nama || location.name,
    lat: location.lat,
    lng: location.lng,
    radius: location.radius,
    source: location.source || "temporary",
  };
}

function matchOperationalLocation(location, candidates) {
  if (!location || !Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  let best = null;
  for (const candidate of candidates) {
    const distance = calculateDistanceMeters(
        location.lat,
        location.lng,
        candidate.lat,
        candidate.lng,
    );
    const uncertaintyAdjustedDistance = distance + location.accuracy;
    if (!Number.isFinite(distance) ||
        !Number.isFinite(uncertaintyAdjustedDistance) ||
        uncertaintyAdjustedDistance > candidate.radius) {
      continue;
    }
    if (!best || distance < best.distanceMeters) {
      best = {
        location: candidate,
        distanceMeters: distance,
        uncertaintyAdjustedDistanceMeters: uncertaintyAdjustedDistance,
      };
    }
  }
  return best;
}

function assertActiveEmployee(user) {
  if (!user || user.accountStatus !== "active" || user.isActive !== true) {
    fail("ACCOUNT_INACTIVE", "Akun pengguna tidak aktif.");
  }
  if (user.role === "admin" || user.isAdmin === true) {
    fail("ROLE_NOT_ALLOWED", "Akun admin tidak dapat melakukan absensi.");
  }
  if (user.mustChangePassword === true) {
    fail(
        "PASSWORD_CHANGE_REQUIRED",
        "Password sementara harus diganti sebelum melakukan absensi.",
    );
  }
  return user;
}

function parseJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 ||
      buffer[0] !== 0xff || buffer[1] !== 0xd8 ||
      buffer[buffer.length - 2] !== 0xff ||
      buffer[buffer.length - 1] !== 0xd9) {
    fail("PHOTO_INVALID", "Berkas bukti bukan JPEG yang valid.");
  }

  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0xff ||
        (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      break;
    }
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  fail("PHOTO_INVALID", "Dimensi JPEG tidak dapat diverifikasi.");
}

function perceptualFingerprint(data, width, height) {
  if (!Buffer.isBuffer(data) || width !== 9 || height !== 9 ||
      data.length !== width * height) {
    fail("PHOTO_INVALID", "Foto bukti tidak dapat dinormalisasi.");
  }
  const bits = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      bits.push(data[y * width + x] >= data[y * width + x + 1]);
    }
  }
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      bits.push(data[y * width + x] >= data[(y + 1) * width + x]);
    }
  }
  let result = "";
  for (let index = 0; index < bits.length; index += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      nibble = (nibble << 1) | (bits[index + bit] ? 1 : 0);
    }
    result += nibble.toString(16);
  }
  return result;
}

function mirroredPerceptualGrid(data, width, height) {
  const mirrored = Buffer.alloc(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      mirrored[y * width + x] = data[y * width + (width - 1 - x)];
    }
  }
  return mirrored;
}

function assertPerceptualHash(value) {
  const pattern = new RegExp(
      `^[0-9a-f]{${PERCEPTUAL_HASH_HEX_LENGTH}}$`,
  );
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("PHOTO_INVALID", "Sidik visual foto tidak valid.");
  }
  return value;
}

function perceptualHashDistance(left, right) {
  const normalizedLeft = assertPerceptualHash(left);
  const normalizedRight = assertPerceptualHash(right);
  let distance = 0;
  for (let index = 0; index < PERCEPTUAL_HASH_HEX_LENGTH; index += 1) {
    const xor = Number.parseInt(normalizedLeft[index], 16) ^
      Number.parseInt(normalizedRight[index], 16);
    distance += NIBBLE_POPCOUNT[xor];
  }
  return distance;
}

// Seven interleaved bands guarantee that fingerprints within the six-bit
// replay threshold share at least one exact band (pigeonhole principle).
// Interleaving makes each band sample the whole image. The backend still
// compares the full fingerprint, so a band collision alone never rejects an
// unrelated photo.
function perceptualHashBands(value) {
  const hash = assertPerceptualHash(value);
  const bandBits = Array.from(
      {length: PERCEPTUAL_HASH_BAND_COUNT},
      () => [],
  );
  let bitIndex = 0;
  for (const character of hash) {
    const nibble = Number.parseInt(character, 16)
        .toString(2)
        .padStart(4, "0");
    for (const bit of nibble) {
      bandBits[bitIndex % PERCEPTUAL_HASH_BAND_COUNT].push(bit);
      bitIndex += 1;
    }
  }
  return bandBits.map((bits, bandIndex) => {
    let bandHex = "";
    for (let offset = 0; offset < bits.length; offset += 4) {
      bandHex += Number.parseInt(
          bits.slice(offset, offset + 4).join(""),
          2,
      ).toString(16);
    }
    return `${PERCEPTUAL_HASH_VERSION}_b${bandIndex}_${bandHex}`;
  });
}

function assertPerceptualHashes(values) {
  if (!Array.isArray(values) ||
      values.length !== PERCEPTUAL_HASH_VIEW_COUNT) {
    fail("PHOTO_INVALID", "Kumpulan sidik visual foto tidak valid.");
  }
  return values.map(assertPerceptualHash);
}

function perceptualHashBandsForHashes(values) {
  const hashes = assertPerceptualHashes(values);
  return [...new Set(hashes.flatMap(perceptualHashBands))];
}

function minimumPerceptualHashDistance(leftValues, rightValues) {
  const left = assertPerceptualHashes(leftValues);
  const right = assertPerceptualHashes(rightValues);
  let minimum = Number.POSITIVE_INFINITY;
  for (const leftHash of left) {
    for (const rightHash of right) {
      minimum = Math.min(
          minimum,
          perceptualHashDistance(leftHash, rightHash),
      );
    }
  }
  return minimum;
}

function photoQualityMetrics(data, width, height) {
  if (!Buffer.isBuffer(data) || data.length !== width * height ||
      !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 2 || height < 2) {
    fail("PHOTO_INVALID", "Foto bukti tidak dapat dianalisis.");
  }
  let sum = 0;
  let sumSquares = 0;
  let edgeSquares = 0;
  let edgeCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = data[index];
      sum += value;
      sumSquares += value * value;
      if (x + 1 < width) {
        const difference = value - data[index + 1];
        edgeSquares += difference * difference;
        edgeCount += 1;
      }
      if (y + 1 < height) {
        const difference = value - data[index + width];
        edgeSquares += difference * difference;
        edgeCount += 1;
      }
    }
  }
  const count = data.length;
  const mean = sum / count;
  const variance = Math.max(0, sumSquares / count - mean * mean);
  const sorted = Uint8Array.from(data).sort();
  const percentile = ratio => sorted[Math.floor((count - 1) * ratio)];
  const p05 = percentile(0.05);
  const p95 = percentile(0.95);
  return {
    standardDeviation: Math.sqrt(variance),
    p05,
    p95,
    p90Span: p95 - p05,
    edgeRms: Math.sqrt(edgeSquares / edgeCount),
  };
}

function assertPhotoQuality(data, width, height) {
  const metrics = photoQualityMetrics(data, width, height);
  if (metrics.standardDeviation < MIN_PHOTO_LUMA_STANDARD_DEVIATION ||
      metrics.p90Span < MIN_PHOTO_LUMA_P90_SPAN ||
      metrics.edgeRms < MIN_PHOTO_EDGE_RMS ||
      metrics.p95 < MIN_PHOTO_LUMA_P95 ||
      metrics.p05 > MAX_PHOTO_LUMA_P05) {
    fail(
        "PHOTO_LOW_INFORMATION",
        "Foto bukti terlalu gelap, terang, polos, atau minim detail.",
    );
  }
  return metrics;
}

async function validatePhotoBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_JPEG_BYTES ||
      buffer.length > MAX_JPEG_BYTES) {
    fail(
        "PHOTO_SIZE",
        "Ukuran foto harus antara 10 KB dan 2 MB.",
    );
  }
  // Header parsing alone is insufficient: a fabricated SOI/SOF/EOI sequence
  // can claim valid dimensions without containing a decodable image. Sharp is
  // deliberately asked to decode every pixel before the proof is accepted.
  let metadata;
  let normalizedSource;
  try {
    const decoder = sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true,
    });
    metadata = await decoder.metadata();
    if (metadata.format !== "jpeg" || metadata.pages > 1 ||
        !Number.isInteger(metadata.width) ||
        !Number.isInteger(metadata.height)) {
      fail("PHOTO_INVALID", "Berkas bukti bukan JPEG tunggal yang valid.");
    }
    normalizedSource = await decoder
        .clone()
        .rotate()
        .flatten({background: "white"})
        .greyscale()
        .resize(256, 256, {fit: "fill"})
        .raw()
        .toBuffer({resolveWithObject: true});
  } catch (error) {
    if (error instanceof AttendanceInputError) throw error;
    fail("PHOTO_INVALID", "Berkas JPEG rusak atau tidak dapat didekode.");
  }
  const dimensions = {
    width: metadata.width,
    height: metadata.height,
  };
  if (dimensions.width < MIN_IMAGE_SIDE ||
      dimensions.height < MIN_IMAGE_SIDE ||
      dimensions.width > MAX_IMAGE_SIDE ||
      dimensions.height > MAX_IMAGE_SIDE ||
      dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    fail("PHOTO_DIMENSIONS", "Dimensi foto bukti tidak memenuhi syarat.");
  }
  assertPhotoQuality(
      normalizedSource.data,
      normalizedSource.info.width,
      normalizedSource.info.height,
  );
  const perceptualHashes = [];
  for (const cropRatio of PERCEPTUAL_CROP_RATIOS) {
    const cropSide = Math.max(
        9,
        Math.min(256, Math.floor(256 * cropRatio)),
    );
    const cropOffset = Math.floor((256 - cropSide) / 2);
    const normalized = await sharp(normalizedSource.data, {
      raw: normalizedSource.info,
    })
        .extract({
          left: cropOffset,
          top: cropOffset,
          width: cropSide,
          height: cropSide,
        })
        .resize(9, 9, {fit: "fill"})
        .greyscale()
        .raw()
        .toBuffer({resolveWithObject: true});
    perceptualHashes.push(perceptualFingerprint(
        normalized.data,
        normalized.info.width,
        normalized.info.height,
    ));
    const mirrored = mirroredPerceptualGrid(
        normalized.data,
        normalized.info.width,
        normalized.info.height,
    );
    perceptualHashes.push(perceptualFingerprint(
        mirrored,
        normalized.info.width,
        normalized.info.height,
    ));
  }
  return {
    ...dimensions,
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    perceptualHash: perceptualHashes[0],
    perceptualHashes,
  };
}

function validatePhotoMetadata(metadata, expected, nowMs) {
  if (!metadata || metadata.name !== expected.photoPath ||
      metadata.contentType !== "image/jpeg") {
    fail("PHOTO_METADATA", "Metadata foto bukti tidak valid.");
  }
  const custom = metadata.metadata || {};
  if (custom.challengeId !== expected.challengeId ||
      custom.uid !== expected.uid || custom.action !== expected.action) {
    fail("PHOTO_BINDING", "Foto tidak terikat ke challenge absensi ini.");
  }
  const permittedKeys = new Set([
    "challengeId",
    "uid",
    "action",
    "firebaseStorageDownloadTokens",
  ]);
  if (Object.keys(custom).some((key) => !permittedKeys.has(key))) {
    fail("PHOTO_METADATA", "Metadata tambahan foto tidak diizinkan.");
  }
  const createdAtMs = Date.parse(metadata.timeCreated);
  if (!Number.isFinite(createdAtMs) ||
      createdAtMs < expected.challengeCreatedAtMs - 5000 ||
      createdAtMs > nowMs + MAX_LOCATION_FUTURE_SKEW_MS ||
      createdAtMs > expected.challengeExpiresAtMs) {
    fail("PHOTO_STALE", "Foto tidak diambil selama challenge aktif.");
  }
  if (!metadata.generation || !metadata.metageneration) {
    fail("PHOTO_METADATA", "Versi objek foto tidak dapat diverifikasi.");
  }
  return {custom, createdAtMs};
}

function calculateWorkHours(checkInMs, checkOutMs) {
  if (!Number.isFinite(checkInMs) || !Number.isFinite(checkOutMs) ||
      checkOutMs < checkInMs) {
    fail("INVALID_ATTENDANCE_TIME", "Waktu absensi tidak konsisten.");
  }
  const hours = (checkOutMs - checkInMs) / 3600000;
  return Math.round(hours * 100) / 100;
}

function presenceCounter(nowMs) {
  return Math.floor(nowMs / (PRESENCE_CODE_PERIOD_SECONDS * 1000));
}

function presenceContext(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    fail("PRESENCE_CONFIG_INVALID", "Konteks kode kehadiran tidak valid.");
  }
  return value;
}

function createPresenceCode(secretBase64, counter, context) {
  if (typeof secretBase64 !== "string" || !secretBase64 ||
      !Number.isSafeInteger(counter) || counter < 0) {
    fail("PRESENCE_CONFIG_INVALID", "Konfigurasi kode kehadiran tidak valid.");
  }
  const secret = Buffer.from(secretBase64, "base64");
  if (secret.length < 32) {
    fail("PRESENCE_CONFIG_INVALID", "Secret kode kehadiran tidak valid.");
  }
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha256", secret)
      .update(counterBuffer)
      .update("\u0000")
      .update(presenceContext(context))
      .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(binary).padStart(6, "0");
}

function verifyPresenceCode(secretBase64, value, nowMs, context) {
  if (typeof value !== "string" || !/^\d{6}$/.test(value)) return null;
  const counter = presenceCounter(nowMs);
  for (const candidateCounter of [counter, counter - 1]) {
    if (candidateCounter < 0) continue;
    const candidate = createPresenceCode(
        secretBase64,
        candidateCounter,
        context,
    );
    const matches = crypto.timingSafeEqual(
        Buffer.from(candidate),
        Buffer.from(value),
    );
    if (matches) return candidateCounter;
  }
  return null;
}

module.exports = {
  ALLOWED_ACTIONS,
  AttendanceInputError,
  DEFAULT_DEADLINE,
  MAX_GEOFENCE_RADIUS_METERS,
  MAX_LOCATION_ACCURACY_METERS,
  MAX_OPERATIONAL_LOCATIONS,
  MAX_OPERATIONAL_LOCATION_WINDOW_MS,
  MIN_OPERATIONAL_RADIUS_METERS,
  PROJECT_OFFICE_KANTOR_ID,
  PERCEPTUAL_HASH_HEX_LENGTH,
  PERCEPTUAL_HASH_VIEW_COUNT,
  PERCEPTUAL_HASH_VERSION,
  PERCEPTUAL_REPLAY_MAX_ENTRIES,
  PERCEPTUAL_REPLAY_MAX_DISTANCE,
  PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION,
  PERCEPTUAL_REPLAY_WINDOW_MS,
  PRESENCE_CODE_PERIOD_SECONDS,
  WIB_TIME_ZONE,
  assertAction,
  assertActiveEmployee,
  assertAssignmentChoice,
  assertChallengeId,
  assertGeofenceAudit,
  calculateDistanceMeters,
  calculateWorkHours,
  createPresenceCode,
  digestAllowedLocations,
  getServerAttendanceStamp,
  matchOperationalLocation,
  normalizeAllowedLocations,
  normalizeDeadline,
  normalizeGeofence,
  normalizeLocation,
  normalizeOperationalLocation,
  parseJpegDimensions,
  perceptualFingerprint,
  perceptualHashBands,
  perceptualHashBandsForHashes,
  perceptualHashDistance,
  minimumPerceptualHashDistance,
  photoQualityMetrics,
  presenceCounter,
  publicOperationalLocation,
  resolveAssignment,
  resolveAssignmentCandidates,
  validatePhotoBytes,
  validatePhotoMetadata,
  verifyPresenceCode,
  wibParts,
};
