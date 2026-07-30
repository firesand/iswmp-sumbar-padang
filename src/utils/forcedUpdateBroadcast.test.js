import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORCE_RELOAD_MARKER_KEY,
  FORCE_RELOAD_MAX_AGE_MS,
  broadcastMillis,
  shouldForceReload,
} from './forcedUpdateBroadcast.js';

const APP_VERSION = '1.0.4';
const NOW = Date.parse('2026-07-31T02:00:00.000Z');

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
};

const throwingStorage = () => ({
  getItem: () => {
    throw new Error('storage disabled');
  },
  setItem: () => {
    throw new Error('storage disabled');
  },
});

const evaluate = (notification, overrides = {}) =>
  shouldForceReload(notification, {
    appVersion: APP_VERSION,
    nowMs: NOW,
    storage: memoryStorage(),
    ...overrides,
  });

const freshBroadcast = (overrides = {}) => ({
  active: true,
  type: 'update',
  forced: true,
  version: '1.0.5',
  timestamp: new Date(NOW - 60 * 1000),
  expiresAt: new Date(NOW + 10 * 60 * 1000),
  action: 'reload',
  ...overrides,
});

test('the 31 Jul 2026 outage document never reloads a client', () => {
  // Verbatim shape of notifications/global as written by the old forceUpdate():
  // no version, no expiry. It reloaded every client on every load, forever.
  const outage = {
    active: true,
    type: 'update',
    title: 'Force Update',
    message: 'Admin has forced an update for all users',
    timestamp: new Date('2026-07-30T18:16:02.483Z'),
    forced: true,
    action: 'reload',
  };

  assert.equal(evaluate(outage), false);
});

test('a broadcast naming a different version reloads once', () => {
  const storage = memoryStorage();
  const broadcast = freshBroadcast();

  assert.equal(evaluate(broadcast, { storage }), true);
  assert.equal(
    storage.getItem(FORCE_RELOAD_MARKER_KEY),
    `1.0.5:${NOW - 60 * 1000}`,
  );
});

test('the same broadcast never reloads twice in one tab', () => {
  const storage = memoryStorage();
  const broadcast = freshBroadcast();

  assert.equal(evaluate(broadcast, { storage }), true);
  assert.equal(evaluate(broadcast, { storage }), false);
  assert.equal(evaluate(broadcast, { storage }), false);
});

test('a later broadcast is honoured after an earlier one', () => {
  const storage = memoryStorage();

  assert.equal(evaluate(freshBroadcast(), { storage }), true);
  assert.equal(
    evaluate(
      freshBroadcast({ version: '1.0.6', timestamp: new Date(NOW - 30 * 1000) }),
      { storage },
    ),
    true,
  );
});

test('a broadcast demanding the running version is ignored', () => {
  assert.equal(evaluate(freshBroadcast({ version: APP_VERSION })), false);
});

test('a broadcast without a target version is ignored', () => {
  assert.equal(evaluate(freshBroadcast({ version: undefined })), false);
  assert.equal(evaluate(freshBroadcast({ version: '' })), false);
  assert.equal(evaluate(freshBroadcast({ version: 12 })), false);
});

test('the latest field is accepted as the target version', () => {
  assert.equal(
    evaluate(freshBroadcast({ version: undefined, latest: '1.0.5' })),
    true,
  );
});

test('a non-forced broadcast never reloads', () => {
  assert.equal(evaluate(freshBroadcast({ forced: false })), false);
  assert.equal(evaluate(freshBroadcast({ forced: undefined })), false);
  assert.equal(evaluate(freshBroadcast({ forced: 'true' })), false);
});

test('an expired broadcast is ignored', () => {
  assert.equal(
    evaluate(freshBroadcast({ expiresAt: new Date(NOW - 1) })),
    false,
  );
  assert.equal(evaluate(freshBroadcast({ expiresAt: new Date(NOW) })), false);
});

test('a legacy broadcast without expiry ages out', () => {
  const stale = freshBroadcast({
    expiresAt: undefined,
    timestamp: new Date(NOW - FORCE_RELOAD_MAX_AGE_MS - 1),
  });
  assert.equal(evaluate(stale), false);

  const recent = freshBroadcast({
    expiresAt: undefined,
    timestamp: new Date(NOW - FORCE_RELOAD_MAX_AGE_MS + 1000),
  });
  assert.equal(evaluate(recent), true);
});

test('a broadcast timestamped in the future is ignored', () => {
  assert.equal(
    evaluate(
      freshBroadcast({ expiresAt: undefined, timestamp: new Date(NOW + 1000) }),
    ),
    false,
  );
});

test('an unparseable timestamp without expiry is ignored', () => {
  assert.equal(
    evaluate(freshBroadcast({ expiresAt: undefined, timestamp: 'kemarin' })),
    false,
  );
  assert.equal(
    evaluate(freshBroadcast({ expiresAt: undefined, timestamp: undefined })),
    false,
  );
});

test('unusable storage fails closed instead of looping', () => {
  assert.equal(evaluate(freshBroadcast(), { storage: throwingStorage() }), false);
  assert.equal(evaluate(freshBroadcast(), { storage: null }), false);
});

test('a missing app version fails closed', () => {
  assert.equal(evaluate(freshBroadcast(), { appVersion: undefined }), false);
  assert.equal(evaluate(freshBroadcast(), { appVersion: '' }), false);
});

test('firestore timestamp objects are understood', () => {
  const asTimestamp = (millis) => ({ toMillis: () => millis });

  assert.equal(
    evaluate(
      freshBroadcast({
        timestamp: asTimestamp(NOW - 60 * 1000),
        expiresAt: asTimestamp(NOW + 60 * 1000),
      }),
    ),
    true,
  );
  assert.equal(
    evaluate(
      freshBroadcast({
        timestamp: asTimestamp(NOW - 60 * 1000),
        expiresAt: asTimestamp(NOW - 1),
      }),
    ),
    false,
  );
});

test('broadcastMillis rejects values it cannot read', () => {
  assert.ok(Number.isNaN(broadcastMillis(null)));
  assert.ok(Number.isNaN(broadcastMillis(undefined)));
  assert.ok(Number.isNaN(broadcastMillis({})));
  assert.ok(Number.isNaN(broadcastMillis('bukan tanggal')));
  assert.ok(Number.isNaN(broadcastMillis({ toMillis: () => 'x' })));
  assert.equal(broadcastMillis(new Date(NOW)), NOW);
  assert.equal(broadcastMillis(NOW), NOW);
  assert.equal(broadcastMillis('2026-07-31T02:00:00.000Z'), NOW);
});

test('a null or malformed notification is ignored', () => {
  assert.equal(evaluate(null), false);
  assert.equal(evaluate(undefined), false);
  assert.equal(evaluate({}), false);
});
