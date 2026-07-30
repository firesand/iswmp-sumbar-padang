// OS-level device evidence bridge — ISWMP SumBar-Padang
//
// A browser cannot read Android's mock-location flag. The attested Android
// wrapper can, and it exposes that through a Capacitor plugin. This module is
// the only place the web bundle talks to it, so the exact same bundle runs
// unchanged in a plain browser (plugin absent, evidence null) and inside the
// attested APK (plugin present, evidence attached to the submission).
//
// The evidence is only meaningful because the backend cross-checks the App
// Check application id against its attested allowlist. Sending this object from
// a browser build does not grant assurance — the server treats an unattested
// claim as a forgery signal.

export const DEVICE_INTEGRITY_VERSION = 1;
export const DEVICE_INTEGRITY_PLUGIN = 'IswmpLocationIntegrity';

const LOCATION_PROVIDERS = new Set([
  'gps',
  'fused',
  'network',
  'passive',
  'unknown',
]);
const APP_VERSION_PATTERN = /^[A-Za-z0-9 ._+-]{1,40}$/;
const MAX_SATELLITES_USED = 64;

const resolvePlugin = (scope) => {
  const plugin = scope?.Capacitor?.Plugins?.[DEVICE_INTEGRITY_PLUGIN];
  return plugin && typeof plugin === 'object' ? plugin : null;
};

/**
 * Ask the native layer to start observing OS location metadata.
 *
 * Called before the GPS trace begins so the plugin's own listener covers the
 * same window. Never throws: in a browser there is nothing to start, and a
 * plugin failure must not stop an employee from attending.
 *
 * @param {object} [scope] Global object (injected for tests).
 * @returns {Promise<boolean>} Whether observation actually started.
 */
export async function beginDeviceObservation(scope = globalThis) {
  const plugin = resolvePlugin(scope);
  if (!plugin || typeof plugin.beginObservation !== 'function') return false;
  try {
    await plugin.beginObservation();
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a plugin response into exactly the backend contract.
 *
 * Anything unexpected returns null rather than a partial object: submitting
 * malformed evidence would fail the whole attendance with
 * DEVICE_INTEGRITY_INVALID, and a plugin bug must not cost an employee their
 * check-in. A null result simply means "no OS evidence", which the backend
 * already handles honestly.
 *
 * @param {*} raw Untrusted plugin response.
 * @returns {?object} Canonical evidence, or null when unusable.
 */
export function normalizeDeviceIntegrityResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const appVersion = typeof raw.appVersion === 'string' ? raw.appVersion : '';
  const provider = typeof raw.locationProvider === 'string'
    ? raw.locationProvider
    : 'unknown';
  const satellites = Number(raw.satellitesUsed);
  if (
    raw.platform !== 'android' ||
    !APP_VERSION_PATTERN.test(appVersion) ||
    typeof raw.mockLocationDetected !== 'boolean' ||
    typeof raw.mockLocationCapableAppsDetected !== 'boolean' ||
    typeof raw.developerOptionsEnabled !== 'boolean' ||
    !LOCATION_PROVIDERS.has(provider) ||
    !Number.isInteger(satellites) ||
    satellites < 0 ||
    satellites > MAX_SATELLITES_USED
  ) {
    return null;
  }
  return {
    version: DEVICE_INTEGRITY_VERSION,
    platform: 'android',
    appVersion,
    mockLocationDetected: raw.mockLocationDetected,
    mockLocationCapableAppsDetected: raw.mockLocationCapableAppsDetected,
    developerOptionsEnabled: raw.developerOptionsEnabled,
    locationProvider: provider,
    satellitesUsed: satellites,
  };
}

/**
 * Collect OS-level evidence for the observation window just recorded.
 *
 * @param {object} [scope] Global object (injected for tests).
 * @returns {Promise<?object>} Canonical evidence, or null outside the wrapper.
 */
export async function collectDeviceIntegrity(scope = globalThis) {
  const plugin = resolvePlugin(scope);
  if (!plugin || typeof plugin.getDeviceIntegrity !== 'function') return null;
  try {
    return normalizeDeviceIntegrityResponse(await plugin.getDeviceIntegrity());
  } catch {
    return null;
  }
}

/** True when the bundle is running inside the attested Android wrapper. */
export const isAttestedClientAvailable = (scope = globalThis) =>
  resolvePlugin(scope) !== null;
