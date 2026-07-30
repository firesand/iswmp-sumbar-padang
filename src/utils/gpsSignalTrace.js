// GPS signal trace collection — ISWMP SumBar-Padang
//
// One coordinate is a claim. A short series of fixes is a signature: real GNSS
// drifts, its accuracy fluctuates, and its delivery cadence is irregular. This
// module records that series plus a snapshot of the geolocation environment so
// the backend can judge it.
//
// The client never decides anything here. It collects; `submitAttendance`
// forwards; the callable is the only authority on whether the signature is
// acceptable. Nothing in this file should be treated as attestation: a
// determined attacker on their own device can lie about all of it. The point is
// to make a casual mock-location app fail, and to leave reviewable evidence
// behind when someone tries harder.

import {
  GeolocationRequiredError,
  MAX_GPS_ACCURACY_FOR_CHECKIN,
  getCurrentLocation,
  isValidGpsCoords,
} from './geolocation.js';

export const GPS_TRACE_VERSION = 1;
export const GPS_TRACE_MIN_SAMPLES = 6;
export const GPS_TRACE_MIN_SPAN_MS = 8000;
export const GPS_TRACE_MAX_SAMPLES = 120;

const DEFAULT_MAX_DURATION_MS = 30000;
const WATCH_TIMEOUT_MS = 15000;
const MAX_PLATFORM_HINT_LENGTH = 40;
const MAX_TIME_ZONE_LENGTH = 64;
const TIME_ZONE_PATTERN = /^[A-Za-z0-9_+/-]{1,64}$/;
const NATIVE_CODE_PATTERN = /\{\s*\[native code\]\s*\}\s*$/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Captured before any later script can swap them out.
const nativeFunctionToString = Function.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;

const isNativeFunction = (candidate) => {
  if (typeof candidate !== 'function') return false;
  try {
    return NATIVE_CODE_PATTERN.test(nativeFunctionToString.call(candidate));
  } catch {
    return false;
  }
};

const geolocationConstructors = (scope) => ({
  position: typeof scope.GeolocationPosition === 'function'
    ? scope.GeolocationPosition
    : (typeof scope.Position === 'function' ? scope.Position : null),
  coords: typeof scope.GeolocationCoordinates === 'function'
    ? scope.GeolocationCoordinates
    : (typeof scope.Coordinates === 'function' ? scope.Coordinates : null),
});

/**
 * Whether the delivered object really came from the browser's geolocation
 * implementation. A JS-level spoof (injected script, some extensions) hands
 * over a plain object or assigns own properties where the platform uses
 * prototype getters.
 *
 * When a browser does not expose the constructors at all the check is simply
 * unavailable and reports intact — it must not brand an honest old browser as
 * tampered. `platformHint` lets an operator see which case they are looking at.
 */
const inspectPositionShape = (scope, position) => {
  const constructors = geolocationConstructors(scope);
  let positionPrototypeIntact = true;
  let coordsPrototypeIntact = true;
  try {
    if (constructors.position) {
      positionPrototypeIntact =
        Object.getPrototypeOf(position) === constructors.position.prototype;
    }
    const coords = position?.coords;
    if (constructors.coords) {
      coordsPrototypeIntact =
        Object.getPrototypeOf(coords) === constructors.coords.prototype &&
        !hasOwn.call(coords, 'latitude') &&
        !hasOwn.call(coords, 'longitude') &&
        !hasOwn.call(coords, 'accuracy');
    } else if (coords && hasOwn.call(coords, 'latitude')) {
      // No constructor to compare against, but own data properties where the
      // spec defines readonly attributes is still worth recording.
      coordsPrototypeIntact = false;
    }
  } catch {
    positionPrototypeIntact = false;
    coordsPrototypeIntact = false;
  }
  return { positionPrototypeIntact, coordsPrototypeIntact };
};

const sanitizePlatformHint = (value) => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .slice(0, MAX_PLATFORM_HINT_LENGTH);
};

const resolveTimeZone = (scope) => {
  try {
    const zone = scope.Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone;
    if (typeof zone === 'string' &&
        zone.length <= MAX_TIME_ZONE_LENGTH &&
        TIME_ZONE_PATTERN.test(zone)) {
      return zone;
    }
  } catch {
    // fall through
  }
  return 'unknown';
};

const resolveScreenClass = (scope) => {
  const screen = scope.screen;
  const width = Number(screen?.width);
  const height = Number(screen?.height);
  const coarsePointer =
    scope.matchMedia?.('(pointer: coarse)')?.matches === true;
  const touchPoints = Number(scope.navigator?.maxTouchPoints) || 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0) {
    return coarsePointer || touchPoints > 0 ? 'unknown' : 'desktop';
  }
  const shortSide = Math.min(width, height);
  if (!coarsePointer && touchPoints === 0) return 'desktop';
  if (shortSide <= 480) return 'mobile';
  if (shortSide <= 900) return 'tablet';
  return 'desktop';
};

const resolvePermissionState = async (scope) => {
  const permissions = scope.navigator?.permissions;
  if (!permissions || typeof permissions.query !== 'function') {
    return 'unsupported';
  }
  try {
    const status = await permissions.query({ name: 'geolocation' });
    const state = status?.state;
    return ['granted', 'prompt', 'denied'].includes(state) ? state : 'unknown';
  } catch {
    return 'unknown';
  }
};

/**
 * Snapshot of the geolocation environment, taken once per capture.
 *
 * @param {object} scope Global object (injected for tests).
 * @param {object} shape Prototype findings from the delivered positions.
 * @param {object} timing Watch duration and delivered sample count.
 * @param {string} permissionState Resolved geolocation permission state.
 * @returns {object} Environment evidence matching the backend contract.
 */
const buildEnvironment = (scope, shape, timing, permissionState) => {
  const navigatorRef = scope.navigator || {};
  const geolocation = navigatorRef.geolocation;
  const uaData = navigatorRef.userAgentData;
  return {
    geolocationNative: Boolean(geolocation) &&
      isNativeFunction(geolocation.getCurrentPosition) &&
      isNativeFunction(geolocation.watchPosition) &&
      isNativeFunction(geolocation.clearWatch),
    positionPrototypeIntact: shape.positionPrototypeIntact,
    coordsPrototypeIntact: shape.coordsPrototypeIntact,
    automationFlag: navigatorRef.webdriver === true,
    highAccuracyRequested: true,
    mobileHint: typeof uaData?.mobile === 'boolean' ? uaData.mobile : null,
    touchPoints: Math.min(32, Math.max(
      0,
      Math.trunc(Number(navigatorRef.maxTouchPoints) || 0)
    )),
    platformHint: sanitizePlatformHint(
      uaData?.platform || navigatorRef.platform || ''
    ),
    screenClass: resolveScreenClass(scope),
    permissionState,
    timeZone: resolveTimeZone(scope),
    clientNow: Date.now(),
    visibility: ['visible', 'hidden'].includes(scope.document?.visibilityState)
      ? scope.document.visibilityState
      : 'unknown',
    watchDurationMs: timing.watchDurationMs,
    deliveredSamples: timing.deliveredSamples,
  };
};

const plausibleEpochMs = (value, nowMs) =>
  Number.isFinite(value) &&
  value > nowMs - ONE_DAY_MS &&
  value < nowMs + 60000;

const toSample = (position, arrivedAtMs) => {
  const coords = position?.coords;
  const latitude = Number(coords?.latitude);
  const longitude = Number(coords?.longitude);
  const accuracy = Number(coords?.accuracy);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      !Number.isFinite(accuracy) || accuracy <= 0) {
    return null;
  }
  const reported = Number(position?.timestamp);
  // `Number(null)` is 0, so a null altitude must be filtered before coercion:
  // recording 0 would fabricate a sea-level reading the device never reported.
  const optional = (value) => {
    if (value == null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  return {
    // Some engines report a monotonic clock here instead of epoch time; fall
    // back to arrival time so the trace stays comparable with server time.
    timestamp: Math.round(
      plausibleEpochMs(reported, arrivedAtMs) ? reported : arrivedAtMs
    ),
    lat: latitude,
    lng: longitude,
    accuracy,
    altitude: optional(coords?.altitude),
    altitudeAccuracy: optional(coords?.altitudeAccuracy),
    speed: optional(coords?.speed),
    heading: optional(coords?.heading),
  };
};

const spanOf = (samples) => (samples.length < 2
  ? 0
  : samples[samples.length - 1].timestamp - samples[0].timestamp);

/** Best accuracy first, most recent fix as the tie-break. */
const pickSubmittedSample = (samples) => {
  const eligible = samples.filter(
    (sample) => sample.accuracy <= MAX_GPS_ACCURACY_FOR_CHECKIN
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, candidate) => {
    if (candidate.accuracy < best.accuracy) return candidate;
    if (candidate.accuracy === best.accuracy &&
        candidate.timestamp > best.timestamp) {
      return candidate;
    }
    return best;
  }, eligible[0]);
};

/**
 * Watch the device position until the trace is good enough or time runs out.
 *
 * @param {object} scope Global object (injected for tests).
 * @param {object} options Collection options.
 * @returns {Promise<object>} Samples, prototype findings and timing.
 */
const watchSamples = (scope, options) => new Promise((resolve) => {
  const geolocation = scope.navigator?.geolocation;
  const samples = [];
  const shape = {
    positionPrototypeIntact: true,
    coordsPrototypeIntact: true,
  };
  const startedAtMs = Date.now();
  let deliveredSamples = 0;
  let watchId = null;
  let timeoutId = null;
  let tickId = null;
  let settled = false;
  let lastError = null;

  // Recording takes several seconds of an apparently idle screen. Without a
  // moving indicator a user reads that as a frozen app and starts tapping.
  const reportProgress = () => {
    if (settled || typeof options.onProgress !== 'function') return;
    const elapsedMs = Math.max(0, Date.now() - startedAtMs);
    try {
      options.onProgress({
        samples: samples.length,
        minSamples: options.minSamples,
        elapsedMs,
        remainingMs: Math.max(0, options.maxDurationMs - elapsedMs),
        bestAccuracy: samples.length === 0
          ? null
          : Math.min(...samples.map((sample) => sample.accuracy)),
      });
    } catch {
      // A failing progress renderer must never abort a check-in.
    }
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    if (timeoutId != null) scope.clearTimeout(timeoutId);
    if (tickId != null) scope.clearInterval(tickId);
    if (watchId != null) {
      try {
        geolocation.clearWatch(watchId);
      } catch {
        // A cleared watch that throws must not fail the capture.
      }
    }
    resolve({
      samples,
      shape,
      lastError,
      timing: {
        watchDurationMs: Math.min(
          options.maxDurationMs,
          Math.max(0, Date.now() - startedAtMs)
        ),
        deliveredSamples: Math.min(GPS_TRACE_MAX_SAMPLES, deliveredSamples),
      },
    });
  };

  const onPosition = (position) => {
    deliveredSamples += 1;
    const inspected = inspectPositionShape(scope, position);
    // Once any delivered position looks tampered, the whole capture is marked.
    shape.positionPrototypeIntact = shape.positionPrototypeIntact &&
      inspected.positionPrototypeIntact;
    shape.coordsPrototypeIntact = shape.coordsPrototypeIntact &&
      inspected.coordsPrototypeIntact;
    const sample = toSample(position, Date.now());
    if (sample && samples.length < GPS_TRACE_MAX_SAMPLES) {
      const previous = samples[samples.length - 1];
      // Keep the series monotonic; drop rather than rewrite out-of-order fixes.
      if (!previous || sample.timestamp >= previous.timestamp) {
        samples.push(sample);
      }
    }
    // Reported after the push so the final update the user sees includes the
    // fix that completed the series.
    reportProgress();
    const best = pickSubmittedSample(samples);
    if (samples.length >= options.minSamples &&
        spanOf(samples) >= options.minSpanMs &&
        best !== null) {
      finish();
      return;
    }
    if (samples.length >= GPS_TRACE_MAX_SAMPLES) finish();
  };

  const onError = (error) => {
    lastError = error;
    finish();
  };

  if (!geolocation || typeof geolocation.watchPosition !== 'function') {
    finish();
    return;
  }

  timeoutId = scope.setTimeout(finish, options.maxDurationMs);
  if (typeof options.onProgress === 'function' &&
      typeof scope.setInterval === 'function') {
    // Ticks even while the device delivers no fix, which is exactly the case
    // where a user most needs to see that something is still happening.
    tickId = scope.setInterval(reportProgress, 1000);
  }
  reportProgress();
  try {
    watchId = geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: WATCH_TIMEOUT_MS,
      maximumAge: 0,
    });
  } catch (error) {
    lastError = error;
    finish();
  }
});

/**
 * Capture a GPS signal trace and the fix that will be submitted with it.
 *
 * The returned location is always one of the traced samples, so the backend can
 * bind the submitted coordinate to the series. When the browser cannot deliver
 * a usable series the function falls back to a single fix and returns a null
 * trace: the backend records that honestly as TRACE_MISSING instead of
 * pretending a signature was verified.
 *
 * @param {object} [options] Collection options and injected scope.
 * @param {Function} [options.onProgress] Called about once per second with
 *   `{samples, minSamples, elapsedMs, remainingMs, bestAccuracy}` so the UI can
 *   show that recording is still running.
 * @returns {Promise<{location: object, trace: ?object}>} Fix and trace.
 */
export async function captureGpsSignalTrace(options = {}) {
  const scope = options.scope || globalThis;
  const minSamples = Number.isInteger(options.minSamples)
    ? Math.max(2, Math.min(GPS_TRACE_MAX_SAMPLES, options.minSamples))
    : GPS_TRACE_MIN_SAMPLES;
  const minSpanMs = Number.isInteger(options.minSpanMs)
    ? Math.max(1000, options.minSpanMs)
    : GPS_TRACE_MIN_SPAN_MS;
  const maxDurationMs = Number.isInteger(options.maxDurationMs)
    ? Math.max(minSpanMs + 2000, options.maxDurationMs)
    : Math.max(minSpanMs + 2000, DEFAULT_MAX_DURATION_MS);

  if (!scope.navigator?.geolocation) {
    throw new GeolocationRequiredError(
      'Perangkat tidak mendukung GPS. Absensi memerlukan lokasi aktual.',
      'GPS_UNSUPPORTED'
    );
  }

  const permissionState = await resolvePermissionState(scope);
  const collected = await watchSamples(scope, {
    minSamples,
    minSpanMs,
    maxDurationMs,
    onProgress: options.onProgress,
  });
  const submitted = pickSubmittedSample(collected.samples);

  if (!submitted) {
    // No usable fix from the watch. A single high-accuracy read still lets the
    // employee attend; the missing trace is recorded, not hidden.
    const fallback = await getCurrentLocation();
    return { location: fallback, trace: null };
  }

  const location = {
    lat: submitted.lat,
    lng: submitted.lng,
    accuracy: submitted.accuracy,
    source: 'gps-high',
    capturedAt: submitted.timestamp,
  };
  if (!isValidGpsCoords(location)) {
    throw new GeolocationRequiredError(
      `Akurasi GPS terlalu rendah (${Math.round(submitted.accuracy)}m). ` +
        'Pindah ke area terbuka lalu ulangi.',
      'GPS_ACCURACY'
    );
  }

  return {
    location,
    trace: {
      version: GPS_TRACE_VERSION,
      samples: collected.samples,
      environment: buildEnvironment(
        scope,
        collected.shape,
        collected.timing,
        permissionState
      ),
    },
  };
}

export const describeGpsTraceProgress = (trace) => {
  if (!trace || !Array.isArray(trace.samples)) {
    return 'Jejak sinyal GPS tidak tersedia pada perangkat ini.';
  }
  const span = Math.round(spanOf(trace.samples) / 1000);
  return `${trace.samples.length} sampel GPS dalam ${span} detik.`;
};

/**
 * Plain-language recording status. Written for users who will read a static
 * screen as a crash: it always shows a number that moves, and it says what to
 * do rather than what failed.
 *
 * @param {object} progress Payload from the onProgress callback.
 * @returns {string} Status line for the UI.
 */
export const describeGpsCaptureStatus = (progress) => {
  const seconds = Math.round((progress?.elapsedMs || 0) / 1000);
  const samples = progress?.samples || 0;
  const target = progress?.minSamples || GPS_TRACE_MIN_SAMPLES;
  if (samples === 0) {
    return `Merekam sinyal GPS… ${seconds} detik. ` +
      'Tetap di tempat terbuka, jangan tutup halaman ini.';
  }
  return `Merekam sinyal GPS… ${seconds} detik ` +
    `(${Math.min(samples, target)}/${target} sinyal diterima). ` +
    'Tetap diam sebentar, jangan tutup halaman ini.';
};
