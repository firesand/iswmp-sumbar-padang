import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeFreshVerificationLocation,
  normalizeGeofenceProposalInput,
  normalizePendingGeofenceProposal,
  normalizeReviewDecision,
} from './geofenceVerification.js';

test('pending proposal exposes only review material and strips operator identity', () => {
  const proposal = normalizePendingGeofenceProposal('proposal-1', {
    status: 'pending',
    collection: 'kelurahan',
    geofenceId: 'kel-test',
    lat: -1,
    lng: 100,
    radius: 75,
    proposedAt: 1_000,
    proposerUid: 'hidden-user',
    proposerEmail: 'hidden@example.invalid',
    proposerAccountFingerprint: 'a'.repeat(64),
    location: { lat: -1, lng: 100 },
  });

  assert.deepEqual(Object.keys(proposal).sort(), [
    'collection',
    'createdAtMs',
    'geofenceId',
    'lat',
    'lng',
    'proposalId',
    'radius',
    'valid',
  ]);
  assert.equal(proposal.valid, true);
  assert.equal(JSON.stringify(proposal).includes('hidden'), false);
  assert.equal(JSON.stringify(proposal).includes('fingerprint'), false);
  assert.equal(JSON.stringify(proposal).includes('location'), false);
});

test('proposal input and review decision are strict', () => {
  assert.deepEqual(normalizeGeofenceProposalInput({
    collection: 'kantor',
    geofenceId: 'kantor-test',
    lat: '-1.25',
    lng: '100.25',
    radius: '100',
  }), {
    collection: 'kantor',
    geofenceId: 'kantor-test',
    lat: -1.25,
    lng: 100.25,
    radius: 100,
  });
  assert.deepEqual(normalizeReviewDecision('proposal-1', 'approve'), {
    proposalId: 'proposal-1',
    decision: 'approve',
  });
  assert.throws(
    () => normalizeReviewDecision('proposal-1', 'approved'),
    /keputusan review tidak valid/
  );
  assert.throws(
    () => normalizeGeofenceProposalInput({
      collection: 'kelurahan',
      geofenceId: 'kel-test',
      lat: 0,
      lng: 0,
      radius: 50,
    }),
    /Pusat geofence/
  );
});

test('verification GPS must be recent, accurate, and sourced from GPS', () => {
  const nowMs = 10_000;
  const location = normalizeFreshVerificationLocation({
    lat: -1,
    lng: 100,
    accuracy: 12,
    capturedAt: nowMs,
    source: 'gps-high',
    ignored: 'not-forwarded',
  }, nowMs);

  assert.deepEqual(location, {
    lat: -1,
    lng: 100,
    accuracy: 12,
    capturedAt: nowMs,
    source: 'gps-high',
  });
  assert.throws(
    () => normalizeFreshVerificationLocation({
      ...location,
      source: 'manual',
    }, nowMs),
    /GPS belum fresh/
  );
  assert.throws(
    () => normalizeFreshVerificationLocation({
      ...location,
      accuracy: 101,
    }, nowMs),
    /GPS belum fresh/
  );
});
