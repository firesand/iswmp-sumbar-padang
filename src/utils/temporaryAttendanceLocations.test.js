import assert from 'node:assert/strict';
import test from 'node:test';

import { TEMPORARY_ATTENDANCE_LOCATIONS } from '../data/temporaryAttendanceLocations.js';

test('temporary attendance locations include BimTek venue window', () => {
  assert.equal(TEMPORARY_ATTENDANCE_LOCATIONS.length, 1);
  const [venue] = TEMPORARY_ATTENDANCE_LOCATIONS;
  assert.equal(venue.id, 'bimtek-zhm-premiere-padang-2026-07');
  assert.match(venue.nama, /ZHM Premiere Padang/);
  assert.equal(venue.lat, -0.9546883);
  assert.equal(venue.lng, 100.3643174);
  assert.equal(venue.radius, 150);
  assert.equal(venue.validFrom, '2026-07-27T17:00:00.000Z');
  assert.equal(venue.validUntil, '2026-07-31T17:00:00.000Z');
  const windowMs = Date.parse(venue.validUntil) - Date.parse(venue.validFrom);
  assert.ok(windowMs > 0);
  assert.ok(windowMs <= 31 * 24 * 60 * 60 * 1000);
  assert.ok(venue.radius >= 50 && venue.radius <= 500);
});

test('temporary attendance locations are frozen master data', () => {
  assert.ok(Object.isFrozen(TEMPORARY_ATTENDANCE_LOCATIONS));
  assert.ok(Object.isFrozen(TEMPORARY_ATTENDANCE_LOCATIONS[0]));
  assert.throws(() => {
    TEMPORARY_ATTENDANCE_LOCATIONS.push({ id: 'forged' });
  });
});
