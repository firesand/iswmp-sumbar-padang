import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GPS_TRACE_MIN_SAMPLES,
  GPS_TRACE_VERSION,
  captureGpsSignalTrace,
} from './gpsSignalTrace.js';

/** Minimal stand-ins for the platform classes the collector inspects. */
class FakeGeolocationCoordinates {
  constructor(values) {
    Object.defineProperties(this, {
      _values: { value: values, enumerable: false },
    });
  }
  get latitude() {
    return this._values.latitude;
  }
  get longitude() {
    return this._values.longitude;
  }
  get accuracy() {
    return this._values.accuracy;
  }
  get altitude() {
    return this._values.altitude ?? null;
  }
  get altitudeAccuracy() {
    return this._values.altitudeAccuracy ?? null;
  }
  get speed() {
    return this._values.speed ?? null;
  }
  get heading() {
    return this._values.heading ?? null;
  }
}

class FakeGeolocationPosition {
  constructor(coords, timestamp) {
    Object.defineProperties(this, {
      _coords: { value: coords, enumerable: false },
      _timestamp: { value: timestamp, enumerable: false },
    });
  }
  get coords() {
    return this._coords;
  }
  get timestamp() {
    return this._timestamp;
  }
}

// A bound function has no source text, so Function.prototype.toString reports
// it as native code. Overriding `toString` on the stub would not work: the
// collector deliberately calls the pristine Function.prototype.toString.
const asNative = (implementation) => implementation.bind(null);

function fakeScope(options = {}) {
  const now = options.now ?? Date.now();
  const fixes = options.fixes ?? [
    { lat: -0.9546, lng: 100.3643, accuracy: 13.4, offset: -18000 },
    { lat: -0.95461, lng: 100.36432, accuracy: 9.8, offset: -15600 },
    { lat: -0.954605, lng: 100.364285, accuracy: 11.2, offset: -12800 },
    { lat: -0.954592, lng: 100.364318, accuracy: 8.1, offset: -9900 },
    { lat: -0.954603, lng: 100.364302, accuracy: 12.6, offset: -6700 },
    { lat: -0.954598, lng: 100.364311, accuracy: 10.4, offset: -3500 },
    { lat: -0.954601, lng: 100.364306, accuracy: 7.9, offset: -800 },
  ];
  const timers = [];
  const intervals = [];
  const positions = fixes.map((fix) => new FakeGeolocationPosition(
    new FakeGeolocationCoordinates({
      latitude: fix.lat,
      longitude: fix.lng,
      accuracy: fix.accuracy,
      altitude: fix.altitude ?? 11.5,
      altitudeAccuracy: 6.4,
      speed: fix.speed ?? null,
      heading: null,
    }),
    now + fix.offset
  ));
  let cleared = 0;
  const geolocation = {
    getCurrentPosition: asNative(() => {}),
    watchPosition: asNative((onPosition, onError) => {
      if (options.watchError) {
        setTimeout(() => onError(options.watchError), 0);
        return 1;
      }
      positions.forEach((position, index) => {
        setTimeout(() => onPosition(position), index);
      });
      return 42;
    }),
    clearWatch: asNative(() => {
      cleared += 1;
    }),
  };

  const scope = {
    GeolocationPosition: FakeGeolocationPosition,
    GeolocationCoordinates: FakeGeolocationCoordinates,
    navigator: {
      geolocation,
      maxTouchPoints: options.maxTouchPoints ?? 5,
      webdriver: options.webdriver ?? false,
      platform: 'Linux armv8l',
      userAgentData: options.userAgentData ?? {
        mobile: true,
        platform: 'Android',
      },
      permissions: {
        query: async () => ({ state: options.permissionState ?? 'granted' }),
      },
    },
    screen: options.screen ?? { width: 412, height: 915 },
    matchMedia: () => ({ matches: options.coarsePointer ?? true }),
    document: { visibilityState: 'visible' },
    Intl: {
      DateTimeFormat: () => ({
        resolvedOptions: () => ({
          timeZone: options.timeZone ?? 'Asia/Jakarta',
        }),
      }),
    },
    setTimeout: (handler, delay) => {
      const id = setTimeout(handler, delay);
      timers.push(id);
      return id;
    },
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (handler, delay) => {
      const id = setInterval(handler, delay);
      intervals.push(id);
      return id;
    },
    clearInterval: (id) => clearInterval(id),
  };
  return {
    scope,
    clearedCount: () => cleared,
    cleanup: () => {
      timers.forEach((id) => clearTimeout(id));
      intervals.forEach((id) => clearInterval(id));
    },
  };
}

test('captures a trace bound to the submitted fix', async () => {
  const harness = fakeScope();
  try {
    const { location, trace } = await captureGpsSignalTrace({
      scope: harness.scope,
    });

    assert.equal(trace.version, GPS_TRACE_VERSION);
    assert.ok(trace.samples.length >= GPS_TRACE_MIN_SAMPLES);
    // The submitted fix must be present in the series verbatim.
    const bound = trace.samples.some((sample) =>
      sample.lat === location.lat &&
      sample.lng === location.lng &&
      sample.accuracy === location.accuracy &&
      sample.timestamp === location.capturedAt
    );
    assert.ok(bound, 'submitted location must be one of the traced samples');
    // The watch stops as soon as the minimum series is satisfied, so the best
    // accuracy among the first six fixes (8.1 m) is the one submitted.
    assert.equal(location.accuracy, 8.1);
    assert.equal(location.source, 'gps-high');
    assert.equal(harness.clearedCount(), 1, 'watch must be released');
  } finally {
    harness.cleanup();
  }
});

test('samples stay monotonic and carry the optional GNSS fields', async () => {
  const harness = fakeScope();
  try {
    const { trace } = await captureGpsSignalTrace({ scope: harness.scope });
    for (let index = 1; index < trace.samples.length; index += 1) {
      assert.ok(
        trace.samples[index].timestamp >= trace.samples[index - 1].timestamp
      );
    }
    assert.equal(trace.samples[0].altitude, 11.5);
    assert.equal(trace.samples[0].altitudeAccuracy, 6.4);
    assert.equal(trace.samples[0].speed, null);
    assert.equal(trace.samples[0].heading, null);
  } finally {
    harness.cleanup();
  }
});

test('environment evidence reports an untampered mobile browser', async () => {
  const harness = fakeScope();
  try {
    const { trace } = await captureGpsSignalTrace({ scope: harness.scope });
    const environment = trace.environment;
    assert.equal(environment.geolocationNative, true);
    assert.equal(environment.positionPrototypeIntact, true);
    assert.equal(environment.coordsPrototypeIntact, true);
    assert.equal(environment.automationFlag, false);
    assert.equal(environment.mobileHint, true);
    assert.equal(environment.screenClass, 'mobile');
    assert.equal(environment.permissionState, 'granted');
    assert.equal(environment.timeZone, 'Asia/Jakarta');
    assert.equal(environment.platformHint, 'Android');
    assert.equal(environment.visibility, 'visible');
    assert.equal(environment.deliveredSamples, trace.samples.length);
    assert.ok(environment.watchDurationMs >= 0);
  } finally {
    harness.cleanup();
  }
});

test('a patched geolocation function is reported, not silently accepted',
  async () => {
    const harness = fakeScope();
    harness.scope.navigator.geolocation.getCurrentPosition = () => {};
    try {
      const { trace } = await captureGpsSignalTrace({ scope: harness.scope });
      assert.equal(trace.environment.geolocationNative, false);
    } finally {
      harness.cleanup();
    }
  });

test('plain-object positions are reported as a broken prototype', async () => {
  const harness = fakeScope();
  const now = Date.now();
  harness.scope.navigator.geolocation.watchPosition = ((onPosition) => {
      for (let index = 0; index < 7; index += 1) {
        const injected = {
          coords: {
            latitude: -0.9546,
            longitude: 100.3643,
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            speed: null,
            heading: null,
          },
          timestamp: now - 18000 + index * 3000,
        };
        setTimeout(() => onPosition(injected), index);
      }
      return 7;
  }).bind(null);
  try {
    const { trace } = await captureGpsSignalTrace({ scope: harness.scope });
    assert.equal(trace.environment.positionPrototypeIntact, false);
    assert.equal(trace.environment.coordsPrototypeIntact, false);
  } finally {
    harness.cleanup();
  }
});

test('automation and desktop hints are recorded verbatim', async () => {
  const harness = fakeScope({
    webdriver: true,
    userAgentData: { mobile: false, platform: 'Linux' },
    screen: { width: 1920, height: 1080 },
    coarsePointer: false,
    maxTouchPoints: 0,
    permissionState: 'prompt',
    timeZone: 'Europe/Amsterdam',
  });
  try {
    const { trace } = await captureGpsSignalTrace({ scope: harness.scope });
    assert.equal(trace.environment.automationFlag, true);
    assert.equal(trace.environment.mobileHint, false);
    assert.equal(trace.environment.screenClass, 'desktop');
    assert.equal(trace.environment.permissionState, 'prompt');
    assert.equal(trace.environment.timeZone, 'Europe/Amsterdam');
    assert.equal(trace.environment.touchPoints, 0);
  } finally {
    harness.cleanup();
  }
});

test('a non-epoch position clock falls back to arrival time', async () => {
  const harness = fakeScope({
    fixes: Array.from({ length: 7 }, (unused, index) => ({
      lat: -0.9546 + index * 0.000004,
      lng: 100.3643 - index * 0.000003,
      accuracy: 9 + (index % 3),
      // Monotonic-clock style value, far from epoch milliseconds.
      offset: -Date.now() + 5000 + index * 40,
    })),
  });
  try {
    const { trace, location } = await captureGpsSignalTrace({
      scope: harness.scope,
      minSpanMs: 1000,
      maxDurationMs: 3000,
    });
    const nowMs = Date.now();
    for (const sample of trace.samples) {
      assert.ok(
        Math.abs(sample.timestamp - nowMs) < 60000,
        'timestamps must be rebased onto server-comparable epoch time'
      );
    }
    assert.ok(Number.isInteger(location.capturedAt));
  } finally {
    harness.cleanup();
  }
});

test('an accuracy above the check-in ceiling is refused', async () => {
  const harness = fakeScope({
    fixes: Array.from({ length: 7 }, (unused, index) => ({
      lat: -0.9546 + index * 0.00001,
      lng: 100.3643,
      accuracy: 400 + index,
      offset: -18000 + index * 3000,
    })),
  });
  try {
    await assert.rejects(
      captureGpsSignalTrace({
        scope: harness.scope,
        minSpanMs: 1000,
        maxDurationMs: 3000,
      }),
      (error) => error.code === 'GPS_UNSUPPORTED' ||
        error.code === 'GPS_ACCURACY',
      'a trace without any usable fix must not silently submit'
    );
  } finally {
    harness.cleanup();
  }
});

test('a device without geolocation fails closed', async () => {
  await assert.rejects(
    captureGpsSignalTrace({ scope: { navigator: {} } }),
    (error) => error.code === 'GPS_UNSUPPORTED'
  );
});

test('progress is reported while recording and stops once settled', async () => {
  const harness = fakeScope();
  const updates = [];
  try {
    await captureGpsSignalTrace({
      scope: harness.scope,
      onProgress: (progress) => updates.push(progress),
    });
    const settledCount = updates.length;

    assert.ok(settledCount >= 2, 'progress must be reported more than once');
    assert.equal(updates[0].samples, 0, 'first tick fires before any fix');
    assert.ok(
      updates[updates.length - 1].samples >= GPS_TRACE_MIN_SAMPLES,
      'the final tick reflects the collected series'
    );
    for (let index = 1; index < updates.length; index += 1) {
      assert.ok(
        updates[index].samples >= updates[index - 1].samples,
        'sample count must never go backwards'
      );
      assert.ok(Number.isFinite(updates[index].elapsedMs));
      assert.ok(updates[index].remainingMs >= 0);
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      updates.length,
      settledCount,
      'no progress may be reported after the capture settled'
    );
  } finally {
    harness.cleanup();
  }
});

test('a throwing progress renderer never breaks the capture', async () => {
  const harness = fakeScope();
  try {
    const { location } = await captureGpsSignalTrace({
      scope: harness.scope,
      onProgress: () => {
        throw new Error('render failure');
      },
    });
    assert.equal(location.accuracy, 8.1);
  } finally {
    harness.cleanup();
  }
});
