"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./attendance-core");
const gps = require("./gps-integrity");

const NOW = 1_785_000_000_000;

/** Environment evidence produced by an untampered mobile browser. */
function cleanEnvironment(overrides = {}) {
  return {
    geolocationNative: true,
    positionPrototypeIntact: true,
    coordsPrototypeIntact: true,
    automationFlag: false,
    highAccuracyRequested: true,
    mobileHint: true,
    touchPoints: 5,
    platformHint: "Android",
    screenClass: "mobile",
    permissionState: "granted",
    timeZone: "Asia/Jakarta",
    clientNow: NOW - 500,
    visibility: "visible",
    watchDurationMs: 20_000,
    deliveredSamples: 10,
    ...overrides,
  };
}

/**
 * Synthesize a plausible stationary GNSS trace: irregular cadence, drifting
 * coordinates, varying accuracy, altitude present.
 */
function realisticTrace(overrides = {}) {
  const count = overrides.count ?? 10;
  const startAt = overrides.startAt ?? NOW - 22_000;
  const jitter = [
    [0.0000041, -0.0000067, 12.4, 8.1],
    [-0.0000112, 0.0000038, 9.7, 7.4],
    [0.0000073, 0.0000121, 14.2, 9.6],
    [-0.0000029, -0.0000094, 8.3, 6.2],
    [0.0000138, 0.0000017, 11.9, 10.4],
    [-0.0000067, 0.0000082, 7.6, 5.8],
    [0.0000024, -0.0000131, 13.1, 8.9],
    [-0.0000096, 0.0000049, 10.2, 7.1],
    [0.0000117, 0.0000093, 6.9, 6.6],
    [-0.0000042, -0.0000021, 9.1, 8.4],
  ];
  const cadence = [1730, 2210, 1880, 2640, 1520, 2380, 1960, 2110, 2470, 1810];
  const samples = [];
  let timestamp = startAt;
  for (let index = 0; index < count; index += 1) {
    const [deltaLat, deltaLng, accuracy, altitudeAccuracy] =
      jitter[index % jitter.length];
    samples.push({
      timestamp,
      lat: -0.9546883 + deltaLat,
      lng: 100.3643174 + deltaLng,
      accuracy,
      altitude: 12.4 + (index % 3) * 0.7,
      altitudeAccuracy,
      speed: index % 2 === 0 ? 0.21 : null,
      heading: null,
    });
    timestamp += cadence[index % cadence.length];
  }
  return {
    version: 1,
    samples,
    environment: cleanEnvironment(overrides.environment),
  };
}

/** A typical consumer mock-location app: frozen point, fixed cadence. */
function mockAppTrace(overrides = {}) {
  const samples = [];
  let timestamp = overrides.startAt ?? NOW - 20_000;
  for (let index = 0; index < (overrides.count ?? 10); index += 1) {
    samples.push({
      timestamp,
      lat: -0.9546883,
      lng: 100.3643174,
      accuracy: 5,
      altitude: null,
      altitudeAccuracy: null,
      speed: null,
      heading: null,
    });
    timestamp += 1000;
  }
  return {
    version: 1,
    samples,
    environment: cleanEnvironment(overrides.environment),
  };
}

function submittedLocation(trace, index = -1) {
  const samples = trace.samples;
  const sample = samples.at(index);
  return {
    lat: sample.lat,
    lng: sample.lng,
    accuracy: sample.accuracy,
    capturedAt: sample.timestamp,
    source: "gps-high",
  };
}

function analyze(rawTrace, options = {}) {
  const policy = gps.gpsIntegrityPolicy(options.config ?? null);
  const trace = gps.normalizeLocationTrace(rawTrace, options.nowMs ?? NOW);
  return gps.analyzeGpsIntegrity({
    trace,
    location: options.location ??
      (rawTrace ? submittedLocation(rawTrace) : null),
    nowMs: options.nowMs ?? NOW,
    policy,
    traceReplayed: options.traceReplayed === true,
  });
}

function codes(report) {
  return report.signals.map((signal) => signal.code);
}

test("absent configuration defaults to observe without enforcing", () => {
  const policy = gps.gpsIntegrityPolicy(null);
  assert.equal(policy.mode, gps.GPS_INTEGRITY_MODE_OBSERVE);
  assert.equal(policy.configured, false);
  assert.equal(policy.minimumScore, gps.DEFAULT_MINIMUM_SCORE);
  assert.equal(policy.requireMobileDevice, false);
});

test("partial or malformed policy fails closed", () => {
  const cases = [
    {gpsIntegrityMode: "enforce"},
    {gpsIntegrityMode: "enforce", gpsIntegrityPolicyVersion: 2},
    {gpsIntegrityMode: "silent", gpsIntegrityPolicyVersion: 1},
    {
      gpsIntegrityMode: "observe",
      gpsIntegrityPolicyVersion: 1,
      gpsIntegrityMinimumScore: 140,
    },
    {
      gpsIntegrityMode: "observe",
      gpsIntegrityPolicyVersion: 1,
      gpsIntegrityRequireMobileDevice: "yes",
    },
  ];
  for (const config of cases) {
    assert.throws(
        () => gps.gpsIntegrityPolicy(config),
        (error) => error instanceof core.AttendanceInputError &&
          error.reason === "GPS_INTEGRITY_POLICY_INVALID",
        `policy should fail closed for ${JSON.stringify(config)}`,
    );
  }
});

test("realistic stationary trace passes", () => {
  const report = analyze(realisticTrace());
  assert.equal(report.verdict, "pass", codes(report).join(","));
  assert.equal(report.score, 100);
  assert.deepEqual(codes(report), []);
  assert.equal(report.blocking, false);
});

test("frozen coordinates and constant accuracy are rejected", () => {
  const report = analyze(mockAppTrace());
  assert.equal(report.verdict, "reject");
  const found = codes(report);
  assert.ok(found.includes("COORDINATE_FROZEN"), found.join(","));
  assert.ok(found.includes("ACCURACY_CONSTANT"), found.join(","));
  assert.ok(found.includes("SAMPLE_INTERVAL_UNIFORM"), found.join(","));
  assert.ok(found.includes("ALTITUDE_ABSENT"), found.join(","));
  assert.equal(report.score, 0);
});

test("observe mode records a rejection verdict without blocking", () => {
  const report = analyze(mockAppTrace(), {
    config: {gpsIntegrityMode: "observe", gpsIntegrityPolicyVersion: 1},
  });
  assert.equal(report.verdict, "reject");
  assert.equal(report.blocking, false);
});

test("enforce mode blocks the same rejection", () => {
  const report = analyze(mockAppTrace(), {
    config: {gpsIntegrityMode: "enforce", gpsIntegrityPolicyVersion: 1},
  });
  assert.equal(report.verdict, "reject");
  assert.equal(report.blocking, true);
});

test("missing trace is critical but only blocks under enforce", () => {
  const observed = analyze(null, {
    location: {
      lat: -0.9546883,
      lng: 100.3643174,
      accuracy: 12,
      capturedAt: NOW - 1000,
      source: "gps-high",
    },
  });
  assert.deepEqual(codes(observed), ["TRACE_MISSING"]);
  assert.equal(observed.verdict, "reject");
  assert.equal(observed.blocking, false);
  assert.equal(observed.metrics, null);
  assert.equal(observed.traceDigest, null);

  const enforced = analyze(null, {
    config: {gpsIntegrityMode: "enforce", gpsIntegrityPolicyVersion: 1},
    location: {
      lat: -0.9546883,
      lng: 100.3643174,
      accuracy: 12,
      capturedAt: NOW - 1000,
      source: "gps-high",
    },
  });
  assert.equal(enforced.blocking, true);
});

test("submitted location must be one of the traced fixes", () => {
  const trace = realisticTrace();
  const report = analyze(trace, {
    location: {
      lat: -0.9546883,
      lng: 100.3643174,
      accuracy: 12.4,
      capturedAt: NOW - 1000,
      source: "gps-high",
    },
  });
  assert.ok(codes(report).includes("TRACE_LOCATION_MISMATCH"));
  assert.equal(report.verdict, "reject");
});

test("a monkey-patched geolocation API is critical", () => {
  const trace = realisticTrace({environment: {geolocationNative: false}});
  const report = analyze(trace);
  assert.ok(codes(report).includes("GEOLOCATION_API_PATCHED"));
  assert.equal(report.verdict, "reject");

  const spoofedPosition = realisticTrace({
    environment: {coordsPrototypeIntact: false},
  });
  assert.ok(
      codes(analyze(spoofedPosition)).includes("GEOLOCATION_API_PATCHED"),
  );
});

test("automation flag is critical", () => {
  const report = analyze(realisticTrace({environment: {automationFlag: true}}));
  assert.ok(codes(report).includes("AUTOMATION_FLAG"));
  assert.equal(report.verdict, "reject");
});

test("teleport between consecutive fixes is critical", () => {
  const trace = realisticTrace();
  trace.samples[5].lat = -0.8000000;
  const location = submittedLocation(trace);
  const report = analyze(trace, {location});
  assert.ok(codes(report).includes("IMPLAUSIBLE_SPEED"), codes(report).join());
  assert.equal(report.verdict, "reject");
});

test("interpolated route simulation is detected", () => {
  const samples = [];
  let timestamp = NOW - 24_000;
  for (let index = 0; index < 12; index += 1) {
    samples.push({
      timestamp,
      // Constant northward step at constant cadence: a simulated route.
      lat: -0.9546883 + index * 0.000045,
      lng: 100.3643174,
      accuracy: 8 + (index % 3) * 0.5,
      altitude: 12 + index * 0.1,
      altitudeAccuracy: 6,
      speed: 2.5,
      heading: 0,
    });
    timestamp += 2000;
  }
  const trace = {version: 1, samples, environment: cleanEnvironment()};
  const report = analyze(trace);
  const found = codes(report);
  assert.ok(found.includes("LINEAR_TRACK_SIMULATION"), found.join(","));
});

test("too few samples or too short a span is high severity", () => {
  const report = analyze(realisticTrace({count: 3}));
  assert.ok(codes(report).includes("TRACE_TOO_SHORT"));
  assert.equal(report.verdict, "suspect");
});

test("sub-centimetre synthetic noise still fails the jitter floor", () => {
  // A spoofer who adds cosmetic noise defeats COORDINATE_FROZEN but not the
  // physics: a real 10 m-accuracy GNSS fix never drifts by only millimetres.
  const trace = realisticTrace();
  trace.samples.forEach((sample, index) => {
    sample.lat = trace.samples[0].lat + index * 0.0000001;
    sample.lng = trace.samples[0].lng - index * 0.0000001;
  });
  const report = analyze(trace);
  const found = codes(report);
  assert.equal(report.metrics.distinctCoordinateCount, 10);
  assert.ok(!found.includes("COORDINATE_FROZEN"), found.join(","));
  assert.ok(found.includes("STATIONARY_SPREAD_ZERO"), found.join(","));
  assert.equal(report.verdict, "suspect");
});

test("a fully frozen point outranks the weaker repetition findings", () => {
  const trace = realisticTrace();
  trace.samples.forEach((sample) => {
    sample.lat = trace.samples[0].lat;
    sample.lng = trace.samples[0].lng;
  });
  const report = analyze(trace, {location: submittedLocation(trace, 0)});
  const found = codes(report);
  assert.ok(found.includes("COORDINATE_FROZEN"), found.join(","));
  assert.ok(!found.includes("COORDINATE_REPETITION"), found.join(","));
  assert.ok(!found.includes("STATIONARY_SPREAD_ZERO"), found.join(","));
});

test("stale trace is high severity", () => {
  const report = analyze(realisticTrace({startAt: NOW - 400_000}));
  assert.ok(codes(report).includes("TRACE_STALE"));
});

test("future-dated trace is rejected outright", () => {
  assert.throws(
      () => analyze(realisticTrace({startAt: NOW + 60_000})),
      (error) => error instanceof core.AttendanceInputError &&
        error.reason === "GPS_TRACE_STALE",
  );
});

test("replayed trace digest is critical", () => {
  const report = analyze(realisticTrace(), {traceReplayed: true});
  assert.ok(codes(report).includes("TRACE_REPLAYED"));
  assert.equal(report.verdict, "reject");
});

test("digest is stable and sample-bound", () => {
  const first = gps.normalizeLocationTrace(realisticTrace(), NOW);
  const second = gps.normalizeLocationTrace(realisticTrace(), NOW);
  assert.equal(
      gps.canonicalTraceDigest(first),
      gps.canonicalTraceDigest(second),
  );

  const differentEnvironment = gps.normalizeLocationTrace(
      realisticTrace({environment: {platformHint: "Linux"}}),
      NOW,
  );
  assert.equal(
      gps.canonicalTraceDigest(first),
      gps.canonicalTraceDigest(differentEnvironment),
      "environment must not change the trace identity",
  );

  const moved = realisticTrace();
  moved.samples[2].lat += 0.00001;
  assert.notEqual(
      gps.canonicalTraceDigest(first),
      gps.canonicalTraceDigest(gps.normalizeLocationTrace(moved, NOW)),
  );
});

test("non-mobile device is medium by default and critical when required", () => {
  const trace = realisticTrace({
    environment: {mobileHint: false, screenClass: "desktop", touchPoints: 0},
  });
  const observed = analyze(trace);
  assert.ok(codes(observed).includes("NON_MOBILE_DEVICE"));
  assert.equal(observed.verdict, "suspect");

  const required = analyze(trace, {
    config: {
      gpsIntegrityMode: "enforce",
      gpsIntegrityPolicyVersion: 1,
      gpsIntegrityRequireMobileDevice: true,
    },
  });
  assert.equal(required.verdict, "reject");
  assert.equal(required.blocking, true);
});

test("re-delivered identical fixes are collapsed, not counted as jitter", () => {
  const trace = realisticTrace();
  const duplicated = {
    version: 1,
    samples: trace.samples.flatMap((sample) => [sample, {...sample}]),
    environment: trace.environment,
  };
  const report = analyze(duplicated, {
    location: submittedLocation(duplicated),
  });
  assert.equal(report.metrics.sampleCount, 20);
  assert.equal(report.metrics.distinctSampleCount, 10);
  assert.equal(report.verdict, "pass", codes(report).join(","));
});

test("malformed traces are rejected before analysis", () => {
  const invalidCases = [
    {version: 2, samples: [], environment: cleanEnvironment()},
    {version: 1, samples: [], environment: cleanEnvironment()},
    {version: 1, samples: [{timestamp: NOW}], environment: cleanEnvironment()},
    {
      version: 1,
      samples: [{
        timestamp: NOW - 1000,
        lat: 0,
        lng: 0,
        accuracy: 10,
        altitude: null,
        altitudeAccuracy: null,
        speed: null,
        heading: null,
      }],
      environment: cleanEnvironment(),
    },
    {
      version: 1,
      samples: realisticTrace().samples,
      environment: cleanEnvironment({screenClass: "watch"}),
    },
    {
      version: 1,
      samples: realisticTrace().samples,
      environment: cleanEnvironment({platformHint: "a".repeat(41)}),
    },
    {
      version: 1,
      samples: realisticTrace().samples,
      environment: {...cleanEnvironment(), unexpected: true},
    },
    {
      version: 1,
      samples: realisticTrace().samples,
      unexpected: true,
      environment: cleanEnvironment(),
    },
  ];
  for (const candidate of invalidCases) {
    assert.throws(
        () => gps.normalizeLocationTrace(candidate, NOW),
        (error) => error instanceof core.AttendanceInputError &&
          ["GPS_TRACE_INVALID", "GPS_TRACE_SCHEMA"].includes(error.reason),
        `should reject ${JSON.stringify(candidate).slice(0, 90)}`,
    );
  }
});

test("non-monotonic sample order is rejected", () => {
  const trace = realisticTrace();
  const swapped = {
    ...trace,
    samples: [trace.samples[1], trace.samples[0], ...trace.samples.slice(2)],
  };
  assert.throws(
      () => gps.normalizeLocationTrace(swapped, NOW),
      (error) => error.reason === "GPS_TRACE_INVALID",
  );
});

test("summary excludes coordinates and keeps signal evidence", () => {
  const report = analyze(mockAppTrace());
  const summary = gps.gpsIntegritySummary(report);
  assert.equal(summary.verdict, "reject");
  assert.equal(summary.mode, "observe");
  assert.equal(summary.enforced, false);
  assert.ok(summary.signals.includes("COORDINATE_FROZEN"));
  assert.ok(summary.signalCounts.critical >= 1);
  assert.equal(typeof summary.traceDigest, "string");
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes("100.364"), "must not carry a longitude");
  assert.ok(!serialized.includes("-0.954"), "must not carry a latitude");
});

test("clock skew and time zone anomalies are recorded", () => {
  const report = analyze(realisticTrace({
    environment: {clientNow: NOW - 600_000, timeZone: "Europe/Amsterdam"},
  }));
  const found = codes(report);
  assert.ok(found.includes("CLIENT_CLOCK_SKEW"), found.join(","));
  assert.ok(found.includes("TIME_ZONE_MISMATCH"), found.join(","));
});

const ANDROID_APP_ID = '1:1234567890:android:abcdef0123456789';
const WEB_APP_ID = '1:1234567890:web:abcdef0123456789';

function deviceEvidence(overrides = {}) {
  return {
    version: 1,
    platform: 'android',
    appVersion: '1.0.0',
    mockLocationDetected: false,
    mockLocationCapableAppsDetected: false,
    developerOptionsEnabled: false,
    locationProvider: 'gps',
    satellitesUsed: 11,
    ...overrides,
  };
}

const attestedConfig = (overrides = {}) => ({
  gpsIntegrityMode: 'enforce',
  gpsIntegrityPolicyVersion: 1,
  gpsIntegrityAttestedAppIds: [ANDROID_APP_ID],
  ...overrides,
});

function analyzeWithDevice(rawTrace, options = {}) {
  const policy = gps.gpsIntegrityPolicy(options.config ?? null);
  const trace = gps.normalizeLocationTrace(rawTrace, NOW);
  return gps.analyzeGpsIntegrity({
    trace,
    location: options.location ??
      (rawTrace ? submittedLocation(rawTrace) : null),
    nowMs: NOW,
    policy,
    device: options.device === undefined
      ? gps.normalizeDeviceIntegrity(deviceEvidence())
      : (options.device === null
        ? null
        : gps.normalizeDeviceIntegrity(options.device)),
    appId: options.appId ?? ANDROID_APP_ID,
  });
}

test('attested android submission is recognised as such', () => {
  const report = analyzeWithDevice(realisticTrace(), {
    config: attestedConfig(),
  });
  assert.equal(report.deviceAttested, true);
  assert.equal(report.platform, 'android-app');
  assert.equal(report.verdict, 'pass', codes(report).join(','));
  const summary = gps.gpsIntegritySummary(report);
  assert.equal(summary.deviceAttested, true);
  assert.equal(summary.device.satellitesUsed, 11);
});

test('OS mock-location flag rejects even a statistically clean trace', () => {
  const report = analyzeWithDevice(realisticTrace(), {
    config: attestedConfig(),
    device: deviceEvidence({ mockLocationDetected: true }),
  });
  assert.ok(codes(report).includes('OS_MOCK_LOCATION'));
  assert.equal(report.verdict, 'reject');
  assert.equal(report.blocking, true);
});

test('a per-sample mock flag rejects the trace', () => {
  const trace = realisticTrace();
  trace.samples[3].mock = true;
  const report = analyzeWithDevice(trace, {
    config: attestedConfig(),
    location: submittedLocation(trace),
  });
  assert.ok(codes(report).includes('OS_MOCK_LOCATION'));
  assert.equal(report.metrics.mockFlaggedSampleCount, 1);
  assert.equal(report.verdict, 'reject');
});

test('device evidence from an unattested app id is treated as forgery', () => {
  const report = analyzeWithDevice(realisticTrace(), {
    config: attestedConfig(),
    appId: WEB_APP_ID,
  });
  assert.ok(codes(report).includes('DEVICE_INTEGRITY_UNVERIFIED'));
  assert.equal(report.deviceAttested, false);
  assert.equal(report.platform, 'unattested-claim');
  assert.equal(report.verdict, 'reject');
});

test('requiring the attested app blocks the plain web client', () => {
  const report = analyzeWithDevice(realisticTrace(), {
    config: attestedConfig({ gpsIntegrityRequireAttestedApp: true }),
    device: null,
    appId: WEB_APP_ID,
  });
  assert.ok(codes(report).includes('ATTESTED_APP_REQUIRED'));
  assert.equal(report.platform, 'web');
  assert.equal(report.verdict, 'reject');
});

test('web client stays acceptable while the attested app is optional', () => {
  const report = analyzeWithDevice(realisticTrace(), {
    config: attestedConfig(),
    device: null,
    appId: WEB_APP_ID,
  });
  assert.equal(report.platform, 'web');
  assert.equal(report.deviceAttested, false);
  assert.equal(report.verdict, 'pass', codes(report).join(','));
});

test('installed mock apps and developer options are scored, not fatal', () => {
  const report = analyzeWithDevice(realisticTrace(), {
    config: attestedConfig(),
    device: deviceEvidence({
      mockLocationCapableAppsDetected: true,
      developerOptionsEnabled: true,
      satellitesUsed: 0,
    }),
  });
  const found = codes(report);
  assert.ok(found.includes('MOCK_LOCATION_APPS_PRESENT'), found.join(','));
  assert.ok(found.includes('DEVELOPER_OPTIONS_ENABLED'), found.join(','));
  assert.ok(found.includes('NO_SATELLITES_USED'), found.join(','));
  assert.equal(report.verdict, 'suspect');
  assert.equal(report.blocking, false);
});

test('device signals are still evaluated when no trace was sent', () => {
  const policy = gps.gpsIntegrityPolicy(
    attestedConfig({ gpsIntegrityRequireAttestedApp: true })
  );
  const report = gps.analyzeGpsIntegrity({
    trace: null,
    location: null,
    nowMs: NOW,
    policy,
    device: null,
    appId: WEB_APP_ID,
  });
  const found = codes(report);
  assert.ok(found.includes('TRACE_MISSING'), found.join(','));
  assert.ok(found.includes('ATTESTED_APP_REQUIRED'), found.join(','));
  assert.equal(report.blocking, true);
});

test('malformed device evidence is rejected outright', () => {
  const invalid = [
    { ...deviceEvidence(), version: 2 },
    { ...deviceEvidence(), platform: 'ios' },
    { ...deviceEvidence(), locationProvider: 'satellite' },
    { ...deviceEvidence(), satellitesUsed: -1 },
    { ...deviceEvidence(), satellitesUsed: 1.5 },
    { ...deviceEvidence(), mockLocationDetected: 'false' },
    { ...deviceEvidence(), appVersion: 'a'.repeat(41) },
    { ...deviceEvidence(), extra: true },
  ];
  for (const candidate of invalid) {
    assert.throws(
        () => gps.normalizeDeviceIntegrity(candidate),
        (error) => error instanceof core.AttendanceInputError &&
          ['DEVICE_INTEGRITY_INVALID', 'DEVICE_INTEGRITY_SCHEMA']
              .includes(error.reason),
        `should reject ${JSON.stringify(candidate).slice(0, 80)}`,
    );
  }
  const incomplete = { ...deviceEvidence() };
  delete incomplete.satellitesUsed;
  assert.throws(
      () => gps.normalizeDeviceIntegrity(incomplete),
      (error) => error.reason === 'DEVICE_INTEGRITY_INVALID',
  );
  assert.equal(gps.normalizeDeviceIntegrity(null), null);
});

test('attested app id allowlist is validated strictly', () => {
  const invalid = [
    { gpsIntegrityAttestedAppIds: [WEB_APP_ID] },
    { gpsIntegrityAttestedAppIds: [ANDROID_APP_ID, ANDROID_APP_ID] },
    { gpsIntegrityAttestedAppIds: 'not-an-array' },
    { gpsIntegrityRequireAttestedApp: true },
  ];
  for (const overrides of invalid) {
    assert.throws(
        () => gps.gpsIntegrityPolicy({
          gpsIntegrityMode: 'enforce',
          gpsIntegrityPolicyVersion: 1,
          ...overrides,
        }),
        (error) => error.reason === 'GPS_INTEGRITY_POLICY_INVALID',
        `should reject ${JSON.stringify(overrides)}`,
    );
  }
});

test('an out-of-range per-sample mock flag is rejected', () => {
  const trace = realisticTrace();
  trace.samples[0].mock = 'yes';
  assert.throws(
      () => gps.normalizeLocationTrace(trace, NOW),
      (error) => error.reason === 'GPS_TRACE_INVALID',
  );
});

test("an attested app id without OS evidence is treated as suppression", () => {
  const report = analyzeWithDevice(realisticTrace(), {
    config: attestedConfig(),
    device: null,
    appId: ANDROID_APP_ID,
  });
  const found = codes(report);
  assert.ok(found.includes("DEVICE_EVIDENCE_MISSING"), found.join(","));
  assert.equal(report.deviceAttested, true);
  assert.equal(report.verdict, "reject");
  assert.equal(report.blocking, true);
});
