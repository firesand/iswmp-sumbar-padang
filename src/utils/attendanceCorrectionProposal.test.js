import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCorrectionProposalRemainingMs,
  getCorrectionProposalResubmission,
  getCorrectionProposalState,
  hasCorrectionReplacement,
} from './attendanceCorrectionProposal.js';

const timestamp = (millis) => ({toMillis: () => millis});
const nowMs = Date.parse('2026-08-20T08:31:00.000Z');

test('expired pending proposal is not presented as pending', () => {
  const proposal = {expiresAt: timestamp(nowMs - 1)};
  assert.equal(getCorrectionProposalState(proposal, new Date(nowMs)), 'expired');
  assert.equal(getCorrectionProposalRemainingMs(proposal, new Date(nowMs)), 0);
});

test('unexpired proposal remains pending', () => {
  const proposal = {expiresAt: timestamp(nowMs + 60_000)};
  assert.equal(getCorrectionProposalState(proposal, new Date(nowMs)), 'pending');
  assert.equal(
    getCorrectionProposalRemainingMs(proposal, new Date(nowMs)),
    60_000
  );
});

test('final decision takes precedence over expiry', () => {
  const expired = timestamp(nowMs - 1);
  assert.equal(getCorrectionProposalState({
    expiresAt: expired,
    decision: {status: 'approved'},
  }, new Date(nowMs)), 'approved');
  assert.equal(getCorrectionProposalState({
    expiresAt: expired,
    decision: {status: 'rejected'},
  }, new Date(nowMs)), 'rejected');
});

test('missing expiry fails closed as invalid', () => {
  assert.equal(getCorrectionProposalState({}, new Date(nowMs)), 'invalid');
});

test('resubmission preserves the audited target, checkout and reason', () => {
  const proposal = {
    attendanceId: 'employee-1_2026-08-14',
    requestedCheckOut: timestamp(nowMs - 3_600_000),
    reason: '  Lupa check-out setelah kegiatan lapangan.  ',
  };
  const resubmission = getCorrectionProposalResubmission(proposal);
  assert.equal(resubmission.attendanceId, proposal.attendanceId);
  assert.equal(resubmission.checkOutAt.getTime(), nowMs - 3_600_000);
  assert.equal(
    resubmission.reason,
    'Lupa check-out setelah kegiatan lapangan.'
  );
});

test('malformed proposal cannot be resubmitted', () => {
  assert.equal(getCorrectionProposalResubmission({
    attendanceId: 'employee-1_2026-08-14',
    requestedCheckOut: 'not-a-date',
    reason: 'cukup panjang tetapi waktunya rusak',
  }), null);
});

test('newer pending or approved proposal supersedes an expired proposal', () => {
  const expired = {
    id: 'old',
    attendanceId: 'employee-1_2026-08-14',
    proposedAt: timestamp(nowMs - 48 * 3_600_000),
    expiresAt: timestamp(nowMs - 24 * 3_600_000),
  };
  const replacement = {
    id: 'new',
    attendanceId: expired.attendanceId,
    proposedAt: timestamp(nowMs - 3_600_000),
    expiresAt: timestamp(nowMs + 23 * 3_600_000),
  };
  assert.equal(
    hasCorrectionReplacement(expired, [expired, replacement], new Date(nowMs)),
    true
  );
  assert.equal(
    hasCorrectionReplacement(replacement, [expired, replacement], new Date(nowMs)),
    false
  );
});

test('another expired proposal is not treated as a replacement', () => {
  const first = {
    id: 'first',
    attendanceId: 'employee-1_2026-08-14',
    proposedAt: timestamp(nowMs - 72 * 3_600_000),
    expiresAt: timestamp(nowMs - 48 * 3_600_000),
  };
  const second = {
    id: 'second',
    attendanceId: first.attendanceId,
    proposedAt: timestamp(nowMs - 48 * 3_600_000),
    expiresAt: timestamp(nowMs - 24 * 3_600_000),
  };
  assert.equal(
    hasCorrectionReplacement(first, [first, second], new Date(nowMs)),
    false
  );
});
