const timestampMillis = (value) => {
  if (value == null) return null;
  if (typeof value?.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value?.toDate === 'function') {
    const millis = value.toDate().getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  const millis = value instanceof Date
    ? value.getTime()
    : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
};

export const getCorrectionProposalState = (
  proposal,
  now = new Date()
) => {
  const decisionStatus = proposal?.decision?.status;
  if (decisionStatus === 'approved' || decisionStatus === 'rejected') {
    return decisionStatus;
  }

  const expiresAtMs = timestampMillis(proposal?.expiresAt);
  const nowMs = timestampMillis(now);
  if (expiresAtMs === null || nowMs === null) return 'invalid';
  return expiresAtMs <= nowMs ? 'expired' : 'pending';
};

export const getCorrectionProposalRemainingMs = (
  proposal,
  now = new Date()
) => {
  const expiresAtMs = timestampMillis(proposal?.expiresAt);
  const nowMs = timestampMillis(now);
  if (expiresAtMs === null || nowMs === null) return null;
  return Math.max(0, expiresAtMs - nowMs);
};

export const getCorrectionProposalResubmission = (proposal) => {
  const requestedCheckOutMs = timestampMillis(proposal?.requestedCheckOut);
  const reason = typeof proposal?.reason === 'string'
    ? proposal.reason.trim()
    : '';
  if (
    typeof proposal?.attendanceId !== 'string' ||
    !proposal.attendanceId ||
    requestedCheckOutMs === null ||
    reason.length < 10
  ) {
    return null;
  }
  return {
    attendanceId: proposal.attendanceId,
    checkOutAt: new Date(requestedCheckOutMs),
    reason,
  };
};

export const hasCorrectionReplacement = (
  proposal,
  proposals,
  now = new Date()
) => {
  if (!proposal?.id || !proposal?.attendanceId || !Array.isArray(proposals)) {
    return false;
  }
  const proposedAtMs = timestampMillis(proposal.proposedAt);
  return proposals.some((candidate) => {
    if (
      candidate?.id === proposal.id ||
      candidate?.attendanceId !== proposal.attendanceId
    ) {
      return false;
    }
    const candidateState = getCorrectionProposalState(candidate, now);
    if (!['pending', 'approved'].includes(candidateState)) return false;
    const candidateProposedAtMs = timestampMillis(candidate.proposedAt);
    return proposedAtMs === null ||
      (candidateProposedAtMs !== null && candidateProposedAtMs > proposedAtMs);
  });
};
