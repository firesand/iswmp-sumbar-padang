"use strict";

/**
 * GPS signal-signature verification for attendance submissions.
 *
 * A single browser coordinate is one number the client claims. A mock-location
 * app produces such a number for free. This module instead evaluates a short
 * series of fixes plus client environment evidence, and looks for the
 * statistical fingerprints that consumer spoofing tools leave behind: frozen
 * coordinates, constant accuracy, zero jitter, machine-uniform sample cadence,
 * teleports, and interpolated routes.
 *
 * Honest scope. Every input below is still client-reported, so this module
 * raises the cost of spoofing and produces reviewable evidence. It is NOT
 * sensor attestation and NOT proof of physical presence. Only an OS-level
 * mock-location flag plus device attestation (native app) can claim that.
 *
 * The module is deliberately pure: no Firestore, no network, no clock reads
 * beyond the caller-supplied nowMs, so every verdict is unit-testable.
 */

const crypto = require("node:crypto");
const core = require("./attendance-core");

const GPS_TRACE_SCHEMA_VERSION = 1;
const GPS_INTEGRITY_POLICY_VERSION = 1;
const GPS_INTEGRITY_MODE_OBSERVE = "observe";
const GPS_INTEGRITY_MODE_ENFORCE = "enforce";
const GPS_INTEGRITY_MODES = Object.freeze([
  GPS_INTEGRITY_MODE_OBSERVE,
  GPS_INTEGRITY_MODE_ENFORCE,
]);
const DEFAULT_MINIMUM_SCORE = 50;
const SUSPECT_SCORE = 85;

const MIN_TRACE_SAMPLES = 6;
const MIN_TRACE_SPAN_MS = 8 * 1000;
const MAX_TRACE_SAMPLES = 120;
const MAX_TRACE_DURATION_MS = 10 * 60 * 1000;
const MAX_TRACE_AGE_MS = 3 * 60 * 1000;
const MAX_TRACE_FUTURE_SKEW_MS = 10 * 1000;
const MAX_SAMPLE_ACCURACY_METERS = 10000;
const MAX_PLAUSIBLE_SPEED_MPS = 55;
const MIN_STATIONARY_SPREAD_METERS = 0.5;
const MIN_JITTER_REFERENCE_ACCURACY_METERS = 3;
const MAX_UNIFORM_INTERVAL_STDDEV_MS = 15;
const MIN_UNIFORM_INTERVAL_MS = 400;
const MIN_UNIFORM_INTERVAL_COUNT = 5;
const MIN_LINEAR_TRACK_SAMPLES = 8;
const MAX_LINEAR_TRACK_BEARING_SPREAD_DEGREES = 2;
const MAX_LINEAR_TRACK_SPEED_VARIATION = 0.05;
const MIN_LINEAR_TRACK_SPEED_MPS = 0.5;
const MAX_SPREAD_ACCURACY_RATIO = 6;
const MAX_CLIENT_CLOCK_SKEW_MS = 120 * 1000;
const EXPECTED_TIME_ZONE = core.WIB_TIME_ZONE;
const ROUND_ACCURACY_VALUES = new Set([1, 3, 5, 10, 15, 20, 25, 30, 50, 100]);

const SAMPLE_KEYS = Object.freeze([
  "timestamp",
  "lat",
  "lng",
  "accuracy",
  "altitude",
  "altitudeAccuracy",
  "speed",
  "heading",
]);
// Only the attested Android client can populate this: a browser has no way to
// read the OS mock-location flag. Absent means "not reported", never "clean".
const SAMPLE_OPTIONAL_KEYS = Object.freeze(["mock"]);
const DEVICE_INTEGRITY_KEYS = Object.freeze([
  "version",
  "platform",
  "appVersion",
  "mockLocationDetected",
  "mockLocationCapableAppsDetected",
  "developerOptionsEnabled",
  "locationProvider",
  "satellitesUsed",
]);
const DEVICE_INTEGRITY_SCHEMA_VERSION = 1;
const DEVICE_PLATFORM_ANDROID = "android";
const DEVICE_PLATFORMS = new Set([DEVICE_PLATFORM_ANDROID]);
const LOCATION_PROVIDERS = new Set([
  "gps",
  "fused",
  "network",
  "passive",
  "unknown",
]);
const APP_VERSION_PATTERN = /^[A-Za-z0-9 ._+-]{1,40}$/;
const ANDROID_APP_ID_PATTERN = /^1:[0-9]{1,20}:android:[0-9a-f]{1,40}$/;
const MAX_ATTESTED_APP_IDS = 5;
const MAX_SATELLITES_USED = 64;
const SAMPLE_NULLABLE_KEYS = Object.freeze([
  "altitude",
  "altitudeAccuracy",
  "speed",
  "heading",
]);
const TRACE_KEYS = Object.freeze(["version", "samples", "environment"]);
const ENVIRONMENT_KEYS = Object.freeze([
  "geolocationNative",
  "positionPrototypeIntact",
  "coordsPrototypeIntact",
  "automationFlag",
  "highAccuracyRequested",
  "mobileHint",
  "touchPoints",
  "platformHint",
  "screenClass",
  "permissionState",
  "timeZone",
  "clientNow",
  "visibility",
  "watchDurationMs",
  "deliveredSamples",
]);
const SCREEN_CLASSES = new Set(["mobile", "tablet", "desktop", "unknown"]);
const PERMISSION_STATES = new Set([
  "granted",
  "prompt",
  "denied",
  "unsupported",
  "unknown",
]);
const VISIBILITY_STATES = new Set(["visible", "hidden", "unknown"]);
const PLATFORM_HINT_PATTERN = /^[A-Za-z0-9 ._-]{0,40}$/;
const TIME_ZONE_PATTERN = /^[A-Za-z0-9_+/-]{1,64}$/;

const SEVERITY_WEIGHTS = Object.freeze({
  critical: 100,
  high: 25,
  medium: 10,
  low: 3,
});

/** Ordered so a report always lists the most serious findings first. */
const SEVERITY_ORDER = Object.freeze(["critical", "high", "medium", "low"]);

function fail(reason, message) {
  throw new core.AttendanceInputError(reason, message);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function assertKeys(value, allowedKeys, reason, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(reason, message);
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    fail(reason, message);
  }
}

/**
 * Resolve the effective GPS integrity policy from projectConfig/default.
 *
 * An absent configuration means observe: this control is additive and must not
 * start rejecting live attendance the moment it is deployed. A *partial* or
 * malformed configuration is a different matter and fails closed, because a
 * half-written policy must never silently downgrade enforcement.
 *
 * @param {?object} config projectConfig/default document data.
 * @return {{mode: string, policyVersion: number, minimumScore: number,
 *   requireMobileDevice: boolean, configured: boolean}} Effective policy.
 */
function gpsIntegrityPolicy(config) {
  const raw = config && typeof config === "object" ? config : {};
  const fields = [
    "gpsIntegrityMode",
    "gpsIntegrityPolicyVersion",
    "gpsIntegrityMinimumScore",
    "gpsIntegrityRequireMobileDevice",
    "gpsIntegrityAttestedAppIds",
    "gpsIntegrityRequireAttestedApp",
  ];
  const configured = fields.some((field) => raw[field] != null);
  if (!configured) {
    return {
      mode: GPS_INTEGRITY_MODE_OBSERVE,
      policyVersion: GPS_INTEGRITY_POLICY_VERSION,
      minimumScore: DEFAULT_MINIMUM_SCORE,
      requireMobileDevice: false,
      attestedAppIds: [],
      requireAttestedApp: false,
      configured: false,
    };
  }
  if (raw.gpsIntegrityPolicyVersion !== GPS_INTEGRITY_POLICY_VERSION) {
    fail(
        "GPS_INTEGRITY_POLICY_INVALID",
        "Versi kebijakan integritas GPS tidak dikenali.",
    );
  }
  if (typeof raw.gpsIntegrityMode !== "string" ||
      !GPS_INTEGRITY_MODES.includes(raw.gpsIntegrityMode)) {
    fail(
        "GPS_INTEGRITY_POLICY_INVALID",
        "Mode integritas GPS tidak valid.",
    );
  }
  const minimumScore = raw.gpsIntegrityMinimumScore == null ?
    DEFAULT_MINIMUM_SCORE : raw.gpsIntegrityMinimumScore;
  if (!Number.isInteger(minimumScore) ||
      minimumScore < 0 || minimumScore > 100) {
    fail(
        "GPS_INTEGRITY_POLICY_INVALID",
        "Ambang skor integritas GPS tidak valid.",
    );
  }
  const requireMobileDevice = raw.gpsIntegrityRequireMobileDevice == null ?
    false : raw.gpsIntegrityRequireMobileDevice;
  if (typeof requireMobileDevice !== "boolean") {
    fail(
        "GPS_INTEGRITY_POLICY_INVALID",
        "Kebijakan perangkat mobile integritas GPS tidak valid.",
    );
  }
  const attestedAppIds = raw.gpsIntegrityAttestedAppIds == null ?
    [] : raw.gpsIntegrityAttestedAppIds;
  if (!Array.isArray(attestedAppIds) ||
      attestedAppIds.length > MAX_ATTESTED_APP_IDS ||
      attestedAppIds.some((appId) => typeof appId !== "string" ||
        !ANDROID_APP_ID_PATTERN.test(appId)) ||
      new Set(attestedAppIds).size !== attestedAppIds.length) {
    fail(
        "GPS_INTEGRITY_POLICY_INVALID",
        "Daftar application id attested tidak valid.",
    );
  }
  const requireAttestedApp = raw.gpsIntegrityRequireAttestedApp == null ?
    false : raw.gpsIntegrityRequireAttestedApp;
  if (typeof requireAttestedApp !== "boolean") {
    fail(
        "GPS_INTEGRITY_POLICY_INVALID",
        "Kebijakan aplikasi attested tidak valid.",
    );
  }
  if (requireAttestedApp && attestedAppIds.length === 0) {
    fail(
        "GPS_INTEGRITY_POLICY_INVALID",
        "Aplikasi attested diwajibkan tetapi allowlist-nya kosong.",
    );
  }
  return {
    mode: raw.gpsIntegrityMode,
    policyVersion: GPS_INTEGRITY_POLICY_VERSION,
    minimumScore,
    requireMobileDevice,
    attestedAppIds: [...attestedAppIds].sort(),
    requireAttestedApp,
    configured: true,
  };
}

function normalizeSample(raw, index) {
  const message = `Sampel GPS ke-${index + 1} tidak valid.`;
  assertKeys(
      raw,
      [...SAMPLE_KEYS, ...SAMPLE_OPTIONAL_KEYS],
      "GPS_TRACE_INVALID",
      message,
  );
  for (const key of SAMPLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      fail("GPS_TRACE_INVALID", message);
    }
  }
  if (raw.mock !== undefined && raw.mock !== null &&
      typeof raw.mock !== "boolean") {
    fail("GPS_TRACE_INVALID", message);
  }
  const {timestamp, lat, lng, accuracy} = raw;
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90 ||
      !isFiniteNumber(lng) || lng < -180 || lng > 180 ||
      (lat === 0 && lng === 0)) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (!isFiniteNumber(accuracy) || accuracy <= 0 ||
      accuracy > MAX_SAMPLE_ACCURACY_METERS) {
    fail("GPS_TRACE_INVALID", message);
  }
  const optional = {};
  for (const key of SAMPLE_NULLABLE_KEYS) {
    const value = raw[key];
    if (value === null) {
      optional[key] = null;
      continue;
    }
    if (!isFiniteNumber(value)) fail("GPS_TRACE_INVALID", message);
    optional[key] = value;
  }
  if (optional.altitudeAccuracy != null && optional.altitudeAccuracy < 0) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (optional.speed != null && optional.speed < 0) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (optional.heading != null &&
      (optional.heading < 0 || optional.heading >= 360)) {
    fail("GPS_TRACE_INVALID", message);
  }
  return {
    timestamp,
    lat,
    lng,
    accuracy,
    ...optional,
    mock: raw.mock === undefined ? null : raw.mock,
  };
}

/**
 * Validate the OS-level device evidence that only the attested Android client
 * can produce. Presence alone proves nothing — `analyzeGpsIntegrity` still
 * checks the App Check application id against the attested allowlist.
 *
 * @param {*} raw Untrusted request payload field.
 * @return {?object} Canonical device evidence, or null when absent.
 */
function normalizeDeviceIntegrity(raw) {
  if (raw == null) return null;
  const message = "Bukti integritas perangkat tidak valid.";
  assertKeys(raw, DEVICE_INTEGRITY_KEYS, "DEVICE_INTEGRITY_INVALID", message);
  for (const key of DEVICE_INTEGRITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      fail("DEVICE_INTEGRITY_INVALID", message);
    }
  }
  if (raw.version !== DEVICE_INTEGRITY_SCHEMA_VERSION) {
    fail(
        "DEVICE_INTEGRITY_SCHEMA",
        "Versi bukti integritas perangkat tidak didukung.",
    );
  }
  if (!DEVICE_PLATFORMS.has(raw.platform) ||
      typeof raw.appVersion !== "string" ||
      !APP_VERSION_PATTERN.test(raw.appVersion) ||
      typeof raw.mockLocationDetected !== "boolean" ||
      typeof raw.mockLocationCapableAppsDetected !== "boolean" ||
      typeof raw.developerOptionsEnabled !== "boolean" ||
      !LOCATION_PROVIDERS.has(raw.locationProvider) ||
      !Number.isInteger(raw.satellitesUsed) ||
      raw.satellitesUsed < 0 ||
      raw.satellitesUsed > MAX_SATELLITES_USED) {
    fail("DEVICE_INTEGRITY_INVALID", message);
  }
  return {
    version: DEVICE_INTEGRITY_SCHEMA_VERSION,
    platform: raw.platform,
    appVersion: raw.appVersion,
    mockLocationDetected: raw.mockLocationDetected,
    mockLocationCapableAppsDetected: raw.mockLocationCapableAppsDetected,
    developerOptionsEnabled: raw.developerOptionsEnabled,
    locationProvider: raw.locationProvider,
    satellitesUsed: raw.satellitesUsed,
  };
}

function normalizeEnvironment(raw) {
  const message = "Bukti lingkungan GPS klien tidak valid.";
  assertKeys(raw, ENVIRONMENT_KEYS, "GPS_TRACE_INVALID", message);
  const booleans = [
    "geolocationNative",
    "positionPrototypeIntact",
    "coordsPrototypeIntact",
    "automationFlag",
    "highAccuracyRequested",
  ];
  for (const key of booleans) {
    if (typeof raw[key] !== "boolean") fail("GPS_TRACE_INVALID", message);
  }
  if (raw.mobileHint !== null && typeof raw.mobileHint !== "boolean") {
    fail("GPS_TRACE_INVALID", message);
  }
  if (!Number.isInteger(raw.touchPoints) ||
      raw.touchPoints < 0 || raw.touchPoints > 32) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (typeof raw.platformHint !== "string" ||
      !PLATFORM_HINT_PATTERN.test(raw.platformHint)) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (!SCREEN_CLASSES.has(raw.screenClass) ||
      !PERMISSION_STATES.has(raw.permissionState) ||
      !VISIBILITY_STATES.has(raw.visibility)) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (typeof raw.timeZone !== "string" ||
      !TIME_ZONE_PATTERN.test(raw.timeZone)) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (!Number.isInteger(raw.clientNow) || raw.clientNow <= 0) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (!Number.isInteger(raw.watchDurationMs) ||
      raw.watchDurationMs < 0 ||
      raw.watchDurationMs > MAX_TRACE_DURATION_MS) {
    fail("GPS_TRACE_INVALID", message);
  }
  if (!Number.isInteger(raw.deliveredSamples) ||
      raw.deliveredSamples < 0 ||
      raw.deliveredSamples > MAX_TRACE_SAMPLES) {
    fail("GPS_TRACE_INVALID", message);
  }
  return {
    geolocationNative: raw.geolocationNative,
    positionPrototypeIntact: raw.positionPrototypeIntact,
    coordsPrototypeIntact: raw.coordsPrototypeIntact,
    automationFlag: raw.automationFlag,
    highAccuracyRequested: raw.highAccuracyRequested,
    mobileHint: raw.mobileHint,
    touchPoints: raw.touchPoints,
    platformHint: raw.platformHint,
    screenClass: raw.screenClass,
    permissionState: raw.permissionState,
    timeZone: raw.timeZone,
    clientNow: raw.clientNow,
    visibility: raw.visibility,
    watchDurationMs: raw.watchDurationMs,
    deliveredSamples: raw.deliveredSamples,
  };
}

/**
 * Validate and canonicalize a client GPS trace.
 *
 * A missing trace is legitimate (older client release, or a browser that never
 * delivered a second fix) and returns null so the caller can record the
 * TRACE_MISSING signal. A trace that is *present but malformed* is rejected
 * outright: a client that sends structured evidence must send valid evidence.
 *
 * @param {*} raw Untrusted request payload field.
 * @param {number} nowMs Server clock at request time.
 * @return {?object} Canonical trace, or null when absent.
 */
function normalizeLocationTrace(raw, nowMs) {
  if (raw == null) return null;
  assertKeys(
      raw,
      TRACE_KEYS,
      "GPS_TRACE_INVALID",
      "Struktur jejak GPS tidak valid.",
  );
  if (raw.version !== GPS_TRACE_SCHEMA_VERSION) {
    fail("GPS_TRACE_SCHEMA", "Versi jejak GPS tidak didukung.");
  }
  if (!Array.isArray(raw.samples) || raw.samples.length < 1 ||
      raw.samples.length > MAX_TRACE_SAMPLES) {
    fail("GPS_TRACE_INVALID", "Jumlah sampel GPS tidak valid.");
  }
  const samples = raw.samples.map(normalizeSample);
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].timestamp < samples[index - 1].timestamp) {
      fail(
          "GPS_TRACE_INVALID",
          "Urutan waktu sampel GPS tidak monoton.",
      );
    }
  }
  const startedAt = samples[0].timestamp;
  const endedAt = samples[samples.length - 1].timestamp;
  if (endedAt - startedAt > MAX_TRACE_DURATION_MS) {
    fail("GPS_TRACE_INVALID", "Durasi jejak GPS melebihi batas aman.");
  }
  if (!Number.isFinite(nowMs)) {
    fail("GPS_TRACE_INVALID", "Waktu server untuk jejak GPS tidak valid.");
  }
  if (endedAt > nowMs + MAX_TRACE_FUTURE_SKEW_MS) {
    fail("GPS_TRACE_STALE", "Jejak GPS berasal dari masa depan.");
  }
  const environment = normalizeEnvironment(raw.environment);
  return {
    version: GPS_TRACE_SCHEMA_VERSION,
    samples,
    environment,
    startedAt,
    endedAt,
  };
}

/**
 * Stable digest over the sample series only. Environment evidence is excluded
 * so that replaying a previously accepted signal trace under a fresh
 * environment snapshot still collides.
 *
 * @param {object} trace Canonical trace from normalizeLocationTrace.
 * @return {string} Lowercase SHA-256 hex digest.
 */
function canonicalTraceDigest(trace) {
  const payload = {
    version: trace.version,
    samples: trace.samples.map((sample) => SAMPLE_KEYS.map(
        (key) => (sample[key] === undefined ? null : sample[key]),
    )),
  };
  return crypto.createHash("sha256")
      .update("attendance-gps-trace-v1 ")
      .update(JSON.stringify(payload))
      .digest("hex");
}

/** Median of a non-empty numeric array. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ?
    (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function standardDeviation(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce(
      (sum, value) => sum + (value - mean) * (value - mean),
      0,
  ) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function bearingDegrees(from, to) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const firstLat = toRadians(from.lat);
  const secondLat = toRadians(to.lat);
  const deltaLng = toRadians(to.lng - from.lng);
  const y = Math.sin(deltaLng) * Math.cos(secondLat);
  const x = Math.cos(firstLat) * Math.sin(secondLat) -
    Math.sin(firstLat) * Math.cos(secondLat) * Math.cos(deltaLng);
  const bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

function angularSpread(bearings) {
  if (bearings.length < 2) return 0;
  // Circular spread: compare every bearing to the first, wrapping at 180.
  const reference = bearings[0];
  const deltas = bearings.map((bearing) => {
    const delta = Math.abs(bearing - reference) % 360;
    return delta > 180 ? 360 - delta : delta;
  });
  return Math.max(...deltas);
}

/** Collapse fixes re-delivered under one timestamp; they are the same fix. */
function distinctByTimestamp(samples) {
  const seen = new Map();
  for (const sample of samples) {
    if (!seen.has(sample.timestamp)) seen.set(sample.timestamp, sample);
  }
  return [...seen.values()];
}

function traceMetrics(trace, nowMs) {
  const samples = distinctByTimestamp(trace.samples);
  const accuracies = samples.map((sample) => sample.accuracy);
  const intervals = [];
  for (let index = 1; index < samples.length; index += 1) {
    intervals.push(samples[index].timestamp - samples[index - 1].timestamp);
  }
  const coordinateKeys = new Set(
      samples.map((sample) => `${sample.lat}|${sample.lng}`),
  );
  let spread = 0;
  for (let outer = 0; outer < samples.length; outer += 1) {
    for (let inner = outer + 1; inner < samples.length; inner += 1) {
      const distance = core.calculateDistanceMeters(
          samples[outer].lat,
          samples[outer].lng,
          samples[inner].lat,
          samples[inner].lng,
      );
      if (Number.isFinite(distance) && distance > spread) spread = distance;
    }
  }
  let maxImpliedSpeed = 0;
  const segmentSpeeds = [];
  const segmentBearings = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const deltaMs = current.timestamp - previous.timestamp;
    if (deltaMs <= 0) continue;
    const distance = core.calculateDistanceMeters(
        previous.lat,
        previous.lng,
        current.lat,
        current.lng,
    );
    if (!Number.isFinite(distance)) continue;
    // Charge only displacement that both accuracy circles cannot explain.
    const unexplained = Math.max(
        0,
        distance - (previous.accuracy + current.accuracy),
    );
    const speed = unexplained / (deltaMs / 1000);
    if (speed > maxImpliedSpeed) maxImpliedSpeed = speed;
    segmentSpeeds.push(distance / (deltaMs / 1000));
    if (distance > 0) {
      segmentBearings.push(bearingDegrees(previous, current));
    }
  }
  const altitudes = samples
      .map((sample) => sample.altitude)
      .filter((value) => value != null);
  const medianSegmentSpeed = segmentSpeeds.length > 0 ?
    median(segmentSpeeds) : 0;
  const speedVariation = medianSegmentSpeed > 0 ?
    standardDeviation(segmentSpeeds) / medianSegmentSpeed : 0;
  return {
    sampleCount: trace.samples.length,
    distinctSampleCount: samples.length,
    spanMs: samples.length > 1 ?
      samples[samples.length - 1].timestamp - samples[0].timestamp : 0,
    traceAgeMs: Math.max(0, nowMs - trace.endedAt),
    medianIntervalMs: intervals.length > 0 ?
      Math.round(median(intervals)) : null,
    intervalStdDevMs: intervals.length > 0 ?
      Math.round(standardDeviation(intervals) * 100) / 100 : null,
    intervalCount: intervals.length,
    distinctCoordinateCount: coordinateKeys.size,
    distinctAccuracyCount: new Set(accuracies).size,
    positionSpreadMeters: Math.round(spread * 100) / 100,
    medianAccuracyMeters: Math.round(median(accuracies) * 100) / 100,
    minAccuracyMeters: Math.min(...accuracies),
    maxAccuracyMeters: Math.max(...accuracies),
    maxImpliedSpeedMps: Math.round(maxImpliedSpeed * 100) / 100,
    medianSegmentSpeedMps: Math.round(medianSegmentSpeed * 100) / 100,
    segmentSpeedVariation: Math.round(speedVariation * 1000) / 1000,
    bearingSpreadDegrees: segmentBearings.length >= 2 ?
      Math.round(angularSpread(segmentBearings) * 100) / 100 : null,
    altitudePresentCount: altitudes.length,
    altitudeAllZero: altitudes.length > 0 &&
      altitudes.every((value) => value === 0),
    speedPresentCount: samples
        .filter((sample) => sample.speed != null).length,
    headingPresentCount: samples
        .filter((sample) => sample.heading != null).length,
    clientClockSkewMs: trace.environment.clientNow - nowMs,
    roundAccuracyOnly: accuracies.every(
        (value) => Number.isInteger(value) && ROUND_ACCURACY_VALUES.has(value),
    ),
    mockFlaggedSampleCount: samples
        .filter((sample) => sample.mock === true).length,
    osMockFlagReportedCount: samples
        .filter((sample) => sample.mock != null).length,
    distinctSamples: samples,
  };
}

/** True when the submitted location is exactly one of the traced fixes. */
function traceContainsLocation(samples, location) {
  if (!location) return false;
  return samples.some((sample) =>
    sample.lat === location.lat &&
    sample.lng === location.lng &&
    sample.accuracy === location.accuracy &&
    sample.timestamp === location.capturedAt,
  );
}

/**
 * Findings derived from OS-level device evidence. Evaluated for every
 * submission, including one that carries no trace at all.
 *
 * @param {object} options Analysis options.
 * @param {number} mockFlaggedSampleCount Samples Android flagged as mocked.
 * @return {Array<{code: string, severity: string}>} Device findings.
 */
function collectDeviceSignals(options, mockFlaggedSampleCount) {
  const signals = [];
  const add = (code, severity) => signals.push({code, severity});
  const {policy, device, deviceAttested} = options;

  // OS-level evidence outranks every statistical heuristic: Android itself
  // reported that the fix came from a mock provider.
  if (mockFlaggedSampleCount > 0 || device?.mockLocationDetected === true) {
    add("OS_MOCK_LOCATION", "critical");
  }
  if (device && !deviceAttested) {
    // A browser cannot read the OS mock flag, so device evidence arriving from
    // an application id outside the attested allowlist is a forgery.
    add("DEVICE_INTEGRITY_UNVERIFIED", "critical");
  }
  if (deviceAttested && !device) {
    // Closes the obvious evasion: install the attested app, then deny it the
    // location permission so the OS mock flag is never reported. An attested
    // application id without OS evidence is suppressed evidence, not a browser.
    add("DEVICE_EVIDENCE_MISSING", "critical");
  }
  if (policy.requireAttestedApp && !deviceAttested) {
    add("ATTESTED_APP_REQUIRED", "critical");
  }
  if (device?.mockLocationCapableAppsDetected === true) {
    add("MOCK_LOCATION_APPS_PRESENT", "medium");
  }
  if (device?.developerOptionsEnabled === true) {
    add("DEVELOPER_OPTIONS_ENABLED", "low");
  }
  if (device && device.locationProvider === "gps" &&
      device.satellitesUsed === 0) {
    add("NO_SATELLITES_USED", "low");
  }
  return signals;
}

function collectSignals(metrics, environment, options) {
  const signals = collectDeviceSignals(
      options,
      metrics.mockFlaggedSampleCount,
  );
  const add = (code, severity) => signals.push({code, severity});
  const {policy, traceReplayed, locationBound} = options;

  if (!environment.geolocationNative ||
      !environment.positionPrototypeIntact ||
      !environment.coordsPrototypeIntact) {
    add("GEOLOCATION_API_PATCHED", "critical");
  }
  if (environment.automationFlag) add("AUTOMATION_FLAG", "critical");
  if (traceReplayed) add("TRACE_REPLAYED", "critical");
  if (!locationBound) add("TRACE_LOCATION_MISMATCH", "critical");

  const frozen = metrics.distinctCoordinateCount === 1 &&
    metrics.distinctSampleCount >= MIN_TRACE_SAMPLES;
  if (frozen) add("COORDINATE_FROZEN", "critical");
  if (metrics.maxImpliedSpeedMps > MAX_PLAUSIBLE_SPEED_MPS) {
    add("IMPLAUSIBLE_SPEED", "critical");
  }

  const nonMobile = environment.mobileHint === false ||
    environment.screenClass === "desktop";
  if (nonMobile) {
    add(
        "NON_MOBILE_DEVICE",
        policy.requireMobileDevice ? "critical" : "medium",
    );
  }

  if (metrics.distinctSampleCount < MIN_TRACE_SAMPLES ||
      metrics.spanMs < MIN_TRACE_SPAN_MS) {
    add("TRACE_TOO_SHORT", "high");
  }
  if (!frozen &&
      metrics.distinctCoordinateCount <
        Math.ceil(metrics.distinctSampleCount / 2)) {
    add("COORDINATE_REPETITION", "high");
  }
  if (metrics.distinctAccuracyCount === 1 &&
      metrics.distinctSampleCount >= MIN_TRACE_SAMPLES) {
    add("ACCURACY_CONSTANT", "high");
  }
  if (!frozen &&
      metrics.spanMs >= MIN_TRACE_SPAN_MS &&
      metrics.positionSpreadMeters < MIN_STATIONARY_SPREAD_METERS &&
      metrics.medianAccuracyMeters >=
        MIN_JITTER_REFERENCE_ACCURACY_METERS) {
    add("STATIONARY_SPREAD_ZERO", "high");
  }
  if (metrics.distinctSampleCount >= MIN_LINEAR_TRACK_SAMPLES &&
      metrics.bearingSpreadDegrees != null &&
      metrics.bearingSpreadDegrees <=
        MAX_LINEAR_TRACK_BEARING_SPREAD_DEGREES &&
      metrics.segmentSpeedVariation <= MAX_LINEAR_TRACK_SPEED_VARIATION &&
      metrics.medianSegmentSpeedMps >= MIN_LINEAR_TRACK_SPEED_MPS) {
    add("LINEAR_TRACK_SIMULATION", "high");
  }
  if (metrics.traceAgeMs > MAX_TRACE_AGE_MS) add("TRACE_STALE", "high");

  if (metrics.intervalCount >= MIN_UNIFORM_INTERVAL_COUNT &&
      metrics.intervalStdDevMs != null &&
      metrics.intervalStdDevMs < MAX_UNIFORM_INTERVAL_STDDEV_MS &&
      metrics.medianIntervalMs >= MIN_UNIFORM_INTERVAL_MS) {
    add("SAMPLE_INTERVAL_UNIFORM", "medium");
  }
  if (metrics.maxImpliedSpeedMps <= MAX_PLAUSIBLE_SPEED_MPS &&
      metrics.positionSpreadMeters >
        MAX_SPREAD_ACCURACY_RATIO * metrics.medianAccuracyMeters) {
    add("SPREAD_ACCURACY_INCONSISTENT", "medium");
  }
  if (metrics.altitudeAllZero) add("ALTITUDE_CONSTANT_ZERO", "medium");
  if (Math.abs(metrics.clientClockSkewMs) > MAX_CLIENT_CLOCK_SKEW_MS) {
    add("CLIENT_CLOCK_SKEW", "medium");
  }

  if (metrics.altitudePresentCount === 0) add("ALTITUDE_ABSENT", "low");
  if (metrics.speedPresentCount === 0 && metrics.headingPresentCount === 0) {
    add("SPEED_HEADING_ABSENT", "low");
  }
  if (metrics.roundAccuracyOnly &&
      metrics.distinctSampleCount >= MIN_TRACE_SAMPLES) {
    add("ACCURACY_ROUND_VALUES", "low");
  }
  if (environment.permissionState !== "granted") {
    add("PERMISSION_STATE_UNEXPECTED", "low");
  }
  if (environment.timeZone !== EXPECTED_TIME_ZONE) {
    add("TIME_ZONE_MISMATCH", "low");
  }
  if (environment.visibility === "hidden") add("PAGE_HIDDEN", "low");

  return signals;
}

function scoreSignals(signals) {
  const penalty = signals.reduce(
      (sum, signal) => sum + SEVERITY_WEIGHTS[signal.severity],
      0,
  );
  return Math.max(0, Math.min(100, 100 - penalty));
}

function sortSignals(signals) {
  return [...signals].sort((left, right) => {
    const bySeverity = SEVERITY_ORDER.indexOf(left.severity) -
      SEVERITY_ORDER.indexOf(right.severity);
    return bySeverity !== 0 ?
      bySeverity : left.code.localeCompare(right.code);
  });
}

/**
 * Evaluate a submission's GPS signal signature.
 *
 * The verdict is computed independently of the enforcement mode so observe
 * runs produce exactly the evidence a later enforce decision needs.
 *
 * @param {object} input Analysis input.
 * @param {?object} input.trace Canonical trace, or null when absent.
 * @param {object} input.location Normalized submitted location.
 * @param {number} input.nowMs Server clock.
 * @param {object} input.policy Effective policy from gpsIntegrityPolicy.
 * @param {boolean} [input.traceReplayed] Digest already seen before.
 * @param {?object} [input.device] Canonical device evidence, when supplied.
 * @param {?string} [input.appId] App Check application id of the caller.
 * @return {object} Report with verdict, score, signals and metrics.
 */
function analyzeGpsIntegrity(input) {
  const {trace, location, nowMs, policy} = input;
  const traceReplayed = input.traceReplayed === true;
  const device = input.device == null ? null : input.device;
  const appId = typeof input.appId === "string" ? input.appId : null;
  // Attestation is not something the payload can assert. It is decided by which
  // App Check application id the request actually arrived on.
  const deviceAttested = appId != null &&
    policy.attestedAppIds.includes(appId);
  const options = {policy, traceReplayed, device, deviceAttested};
  const platform = deviceAttested && device ?
    "android-app" : (device ? "unattested-claim" : "web");
  if (trace == null) {
    const signals = sortSignals([
      {code: "TRACE_MISSING", severity: "critical"},
      ...collectDeviceSignals(options, 0),
    ]);
    return {
      policyVersion: policy.policyVersion,
      traceVersion: null,
      mode: policy.mode,
      evaluatedAtMs: nowMs,
      verdict: "reject",
      score: scoreSignals(signals),
      signals,
      metrics: null,
      traceDigest: null,
      device,
      deviceAttested,
      platform,
      blocking: policy.mode === GPS_INTEGRITY_MODE_ENFORCE,
    };
  }
  const metrics = traceMetrics(trace, nowMs);
  const {distinctSamples, ...publicMetrics} = metrics;
  const signals = sortSignals(collectSignals(metrics, trace.environment, {
    ...options,
    locationBound: traceContainsLocation(distinctSamples, location),
  }));
  const score = scoreSignals(signals);
  const hasCritical = signals.some((signal) => signal.severity === "critical");
  // A single high or medium finding is not disqualifying, but it must never be
  // reported as a clean pass: "suspect" is what an operator reviews.
  const hasReviewable = signals.some((signal) =>
    signal.severity === "high" || signal.severity === "medium",
  );
  let verdict = "pass";
  if (hasCritical || score < policy.minimumScore) {
    verdict = "reject";
  } else if (hasReviewable || score < SUSPECT_SCORE) {
    verdict = "suspect";
  }
  return {
    policyVersion: policy.policyVersion,
    traceVersion: trace.version,
    mode: policy.mode,
    evaluatedAtMs: nowMs,
    verdict,
    score,
    signals,
    metrics: publicMetrics,
    traceDigest: canonicalTraceDigest(trace),
    device,
    deviceAttested,
    platform,
    blocking: verdict === "reject" &&
      policy.mode === GPS_INTEGRITY_MODE_ENFORCE,
  };
}

/**
 * Firestore-safe projection of a report.
 *
 * Deliberately excludes coordinates: spreads, speeds and accuracies describe
 * signal quality, not where the employee is. The canonical location fields on
 * the attendance document remain the single place holding position data.
 *
 * @param {object} report Result of analyzeGpsIntegrity.
 * @return {object} Summary suitable for the attendance document.
 */
function gpsIntegritySummary(report) {
  const counts = {critical: 0, high: 0, medium: 0, low: 0};
  for (const signal of report.signals) counts[signal.severity] += 1;
  return {
    policyVersion: report.policyVersion,
    traceVersion: report.traceVersion,
    mode: report.mode,
    verdict: report.verdict,
    score: report.score,
    enforced: report.blocking,
    signals: report.signals.map((signal) => signal.code),
    signalCounts: counts,
    traceDigest: report.traceDigest,
    metrics: report.metrics,
    platform: report.platform,
    deviceAttested: report.deviceAttested,
    device: report.device,
  };
}

module.exports = {
  DEFAULT_MINIMUM_SCORE,
  DEVICE_INTEGRITY_SCHEMA_VERSION,
  DEVICE_PLATFORM_ANDROID,
  GPS_INTEGRITY_MODES,
  GPS_INTEGRITY_MODE_ENFORCE,
  GPS_INTEGRITY_MODE_OBSERVE,
  GPS_INTEGRITY_POLICY_VERSION,
  GPS_TRACE_SCHEMA_VERSION,
  MAX_TRACE_SAMPLES,
  MIN_TRACE_SAMPLES,
  MIN_TRACE_SPAN_MS,
  SUSPECT_SCORE,
  analyzeGpsIntegrity,
  canonicalTraceDigest,
  gpsIntegrityPolicy,
  gpsIntegritySummary,
  normalizeDeviceIntegrity,
  normalizeLocationTrace,
};
