#!/usr/bin/env node

/**
 * Firestore Emulator integration tests for transactional attendance replay:
 * - same-UID perceptual near-replay accepts exactly one concurrent proof;
 * - cross-UID near-replay proofs are both allowed;
 * - byte-identical SHA-256 proofs remain globally exclusive.
 *
 * The script refuses to run unless the Firestore emulator host is present.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST wajib; production ditolak.');
}

const requireFromFunctions = createRequire(
  new URL('../functions/index.js', import.meta.url)
);
const { initializeApp, deleteApp } = requireFromFunctions('firebase-admin/app');
const { getFirestore } = requireFromFunctions('firebase-admin/firestore');
const core = requireFromFunctions('./attendance-core');
const attendance = requireFromFunctions('./attendance');

const app = initializeApp({ projectId: 'demo-iswmp-security' });
const db = getFirestore(app);
const exactIndexes = db.collection('attendanceProofHashes');
const perceptualAudits = db.collection('attendanceProofPerceptualHashes');
const replayStates = db.collection('attendancePerceptualReplayStates');

const hashWithBits = bitIndexes => {
  const bits = Array(144).fill('0');
  bitIndexes.forEach(index => {
    bits[index] = '1';
  });
  let result = '';
  for (let index = 0; index < bits.length; index += 4) {
    result += Number.parseInt(bits.slice(index, index + 4).join(''), 2)
      .toString(16);
  }
  return result;
};

const proof = (key, uid, sha256, perceptualHash) => ({
  key,
  uid,
  sha256,
  perceptualHash,
  perceptualHashes: Array(core.PERCEPTUAL_HASH_VIEW_COUNT)
    .fill(perceptualHash),
});

const firstAttemptBarrier = expectedArrivals => {
  let arrivals = 0;
  let release;
  const ready = new Promise(resolve => {
    release = resolve;
  });
  const attempts = new Map();
  return async key => {
    const attempt = (attempts.get(key) || 0) + 1;
    attempts.set(key, attempt);
    if (attempt !== 1) return;
    arrivals += 1;
    if (arrivals === expectedArrivals) release();
    await ready;
  };
};

const reserve = (candidate, synchronize) => db.runTransaction(
  async transaction => {
    const exactRef = exactIndexes.doc(candidate.sha256);
    const auditRef = perceptualAudits.doc(candidate.sha256);
    const stateRef = replayStates.doc(candidate.uid);
    const [exactSnapshot, auditSnapshot, stateSnapshot] = await Promise.all([
      transaction.get(exactRef),
      transaction.get(auditRef),
      transaction.get(stateRef),
    ]);

    attendance.assertPhotoNotReplayed(exactSnapshot.exists, false);
    assert.equal(auditSnapshot.exists, false, 'audit proof ID harus immutable');
    const nowMs = Date.now();
    const reservation = attendance.reservePerceptualReplayState(
      stateSnapshot.exists ? stateSnapshot.data() : null,
      {
        uid: candidate.uid,
        proofId: candidate.sha256,
        perceptualHashes: candidate.perceptualHashes,
      },
      nowMs,
    );
    attendance.assertPhotoNotReplayed(false, reservation.nearReplay);

    await synchronize(candidate.key);
    transaction.create(exactRef, {
      uid: candidate.uid,
      sha256: candidate.sha256,
    });
    transaction.create(auditRef, {
      schemaVersion: 3,
      proofId: candidate.sha256,
      uid: candidate.uid,
      action: 'checkIn',
      attendanceId: `${candidate.uid}_2026-07-23`,
      challengeId: '11111111-1111-4111-8111-111111111111',
      photoPath:
        `attendanceProofs/${candidate.uid}/` +
        '11111111-1111-4111-8111-111111111111',
      generation: '1',
      sha256: candidate.sha256,
      perceptualHash: candidate.perceptualHash,
      perceptualHashes: candidate.perceptualHashes,
      hashVersion: core.PERCEPTUAL_HASH_VERSION,
    });
    transaction.set(stateRef, reservation.nextState);
    return candidate.key;
  }
);

const replayReason = result =>
  result.status === 'rejected' &&
  result.reason?.details?.reason === 'PHOTO_REPLAY';

const runPair = async (label, candidates, expectedAccepted) => {
  const synchronize = firstAttemptBarrier(candidates.length);
  const results = await Promise.allSettled(
    candidates.map(candidate => reserve(candidate, synchronize))
  );
  const accepted = results.filter(result => result.status === 'fulfilled');
  const replayed = results.filter(replayReason);
  assert.equal(accepted.length, expectedAccepted, `${label}: accepted`);
  assert.equal(
    replayed.length,
    candidates.length - expectedAccepted,
    `${label}: replay rejected`
  );
};

const zeroHash = '0'.repeat(core.PERCEPTUAL_HASH_HEX_LENGTH);
const nearHash = hashWithBits([0, 7, 14, 21, 28, 35]);

try {
  await runPair('same UID near replay', [
    proof('same-a', 'employee-same', 'a'.repeat(64), zeroHash),
    proof('same-b', 'employee-same', 'b'.repeat(64), nearHash),
  ], 1);

  await runPair('cross UID near replay', [
    proof('cross-a', 'employee-cross-a', 'c'.repeat(64), zeroHash),
    proof('cross-b', 'employee-cross-b', 'd'.repeat(64), nearHash),
  ], 2);

  await runPair('global exact SHA replay', [
    proof('exact-a', 'employee-exact-a', 'e'.repeat(64), zeroHash),
    proof('exact-b', 'employee-exact-b', 'e'.repeat(64), zeroHash),
  ], 1);

  const [exactStored, auditStored, stateStored] = await Promise.all([
    exactIndexes.get(),
    perceptualAudits.get(),
    replayStates.get(),
  ]);
  assert.equal(exactStored.size, 4);
  assert.equal(auditStored.size, 4);
  assert.equal(stateStored.size, 4);
  auditStored.docs.forEach(document => {
    const data = document.data();
    assert.match(document.id, /^[0-9a-f]{64}$/);
    assert.equal(data.schemaVersion, 3);
    assert.equal(data.proofId, document.id);
    assert.equal(data.generation, '1');
  });
  stateStored.docs.forEach(document => {
    const data = document.data();
    assert.equal(data.uid, document.id);
    assert.equal(
      data.schemaVersion,
      core.PERCEPTUAL_REPLAY_STATE_SCHEMA_VERSION
    );
    assert.equal(data.hashVersion, core.PERCEPTUAL_HASH_VERSION);
    assert.equal(data.windowMs, core.PERCEPTUAL_REPLAY_WINDOW_MS);
    assert.equal(data.maxEntries, core.PERCEPTUAL_REPLAY_MAX_ENTRIES);
    assert.equal(data.entries.length, 1);
  });

  console.log(
    'PASS replay transactions: same-UID near=1/2, cross-UID near=2/2, ' +
    'global exact=1/2.'
  );
} finally {
  await deleteApp(app);
}
