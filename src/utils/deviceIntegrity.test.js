import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEVICE_INTEGRITY_PLUGIN,
  beginDeviceObservation,
  collectDeviceIntegrity,
  isAttestedClientAvailable,
  normalizeDeviceIntegrityResponse,
} from './deviceIntegrity.js';

const validResponse = (overrides = {}) => ({
  platform: 'android',
  appVersion: '1.0.0',
  mockLocationDetected: false,
  mockLocationCapableAppsDetected: false,
  developerOptionsEnabled: false,
  locationProvider: 'gps',
  satellitesUsed: 11,
  ...overrides,
});

const pluginScope = (plugin) => ({
  Capacitor: { Plugins: { [DEVICE_INTEGRITY_PLUGIN]: plugin } },
});

test('a plain browser reports no plugin and no evidence', async () => {
  assert.equal(isAttestedClientAvailable({}), false);
  assert.equal(await beginDeviceObservation({}), false);
  assert.equal(await collectDeviceIntegrity({}), null);
});

test('a valid plugin response becomes canonical evidence', async () => {
  let began = 0;
  const scope = pluginScope({
    beginObservation: async () => {
      began += 1;
    },
    getDeviceIntegrity: async () => validResponse(),
  });

  assert.equal(isAttestedClientAvailable(scope), true);
  assert.equal(await beginDeviceObservation(scope), true);
  assert.equal(began, 1);
  assert.deepEqual(await collectDeviceIntegrity(scope), {
    version: 1,
    platform: 'android',
    appVersion: '1.0.0',
    mockLocationDetected: false,
    mockLocationCapableAppsDetected: false,
    developerOptionsEnabled: false,
    locationProvider: 'gps',
    satellitesUsed: 11,
  });
});

test('the mock-location verdict is carried through verbatim', async () => {
  const scope = pluginScope({
    getDeviceIntegrity: async () => validResponse({
      mockLocationDetected: true,
      mockLocationCapableAppsDetected: true,
      developerOptionsEnabled: true,
      locationProvider: 'fused',
      satellitesUsed: 0,
    }),
  });
  const evidence = await collectDeviceIntegrity(scope);
  assert.equal(evidence.mockLocationDetected, true);
  assert.equal(evidence.mockLocationCapableAppsDetected, true);
  assert.equal(evidence.developerOptionsEnabled, true);
  assert.equal(evidence.locationProvider, 'fused');
  assert.equal(evidence.satellitesUsed, 0);
});

test('a malformed response yields null instead of a rejected attendance',
  () => {
    const invalid = [
      null,
      'nope',
      [],
      validResponse({ platform: 'ios' }),
      validResponse({ mockLocationDetected: 'false' }),
      validResponse({ locationProvider: 'satellite' }),
      validResponse({ satellitesUsed: -1 }),
      validResponse({ satellitesUsed: 2.5 }),
      validResponse({ appVersion: '' }),
      validResponse({ appVersion: 'a'.repeat(41) }),
    ];
    for (const candidate of invalid) {
      assert.equal(
        normalizeDeviceIntegrityResponse(candidate),
        null,
        `should reject ${JSON.stringify(candidate)?.slice(0, 70)}`
      );
    }
  });

test('unknown extra fields are dropped, not forwarded', () => {
  const evidence = normalizeDeviceIntegrityResponse(
    validResponse({ rooted: true, imei: '123' })
  );
  assert.deepEqual(Object.keys(evidence).sort(), [
    'appVersion',
    'developerOptionsEnabled',
    'locationProvider',
    'mockLocationCapableAppsDetected',
    'mockLocationDetected',
    'platform',
    'satellitesUsed',
    'version',
  ]);
});

test('a throwing plugin degrades to no evidence', async () => {
  const scope = pluginScope({
    beginObservation: async () => {
      throw new Error('native failure');
    },
    getDeviceIntegrity: async () => {
      throw new Error('native failure');
    },
  });
  assert.equal(await beginDeviceObservation(scope), false);
  assert.equal(await collectDeviceIntegrity(scope), null);
});
