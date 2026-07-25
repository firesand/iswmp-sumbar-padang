export const CURRENT_ATTENDANCE_INTEGRITY_VERSION = 2;
export const CURRENT_ATTENDANCE_PROOF_VERSION = 2;
export const ATTENDANCE_VERIFICATION_MODE_GEOFENCE_ONSITE =
  'geofence_onsite';
export const ATTENDANCE_VERIFICATION_MODE_LOCATION_PHOTO =
  'location_photo';
export const LOCATION_PHOTO_VERIFICATION_STATUS =
  'location_photo_only';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const PERCEPTUAL_HASH_PATTERN = /^[0-9a-f]{36}$/i;
const GPS_LOCATION_SOURCES = new Set(['gps-high', 'gps-low']);

const hasExactKeys = (value, expectedKeys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
};

const toTimestampMillis = (value) => {
  if (value == null) return null;
  if (typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === 'object' && Number.isFinite(Number(value.seconds))) {
    return Number(value.seconds) * 1000;
  }
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
};

/**
 * A canonical proof is a challenge-bound object written by the v2 backend.
 * Legacy public URLs are deliberately not accepted as proof.
 */
export const hasCanonicalAttendanceProof = (record, action) => {
  if (!record || !['checkIn', 'checkOut'].includes(action)) return false;

  const userId = typeof record.userId === 'string' ? record.userId : '';
  const path = record[`${action}PhotoPath`];
  const generation = record[`${action}PhotoGeneration`];
  const hash = record[`${action}PhotoHash`];
  const perceptualHash = record[`${action}PhotoPerceptualHash`];
  const challengeId = record.challengeIds?.[action];
  if (!userId || typeof path !== 'string') return false;

  const pathParts = path.split('/');
  const pathIsCanonical = pathParts.length === 3
    && pathParts[0] === 'attendanceProofs'
    && pathParts[1] === userId
    && UUID_V4_PATTERN.test(pathParts[2])
    && pathParts[2] === challengeId;

  return pathIsCanonical
    && typeof generation === 'string'
    && /^\d+$/.test(generation)
    && typeof hash === 'string'
    && SHA256_PATTERN.test(hash)
    && typeof perceptualHash === 'string'
    && PERCEPTUAL_HASH_PATTERN.test(perceptualHash);
};

const hasVerifiedPresenceProof = (record, action) => {
  const proof = action === 'checkIn'
    ? record?.presenceProof
    : record?.checkOutPresenceProof;
  const challengeId = record?.challengeIds?.[action];
  return Boolean(
    proof &&
    proof.required === true &&
    proof.verified === true &&
    Number.isInteger(proof.counter) &&
    typeof proof.issuedBy === 'string' &&
    proof.issuedBy.length > 0 &&
    typeof proof.grantId === 'string' &&
    proof.grantId === challengeId &&
    proof.coPresence?.verified === true &&
    Number.isInteger(proof.coPresence.distanceMeters) &&
    proof.coPresence.distanceMeters >= 0 &&
    Number.isInteger(proof.coPresence.uncertaintyAdjustedDistanceMeters) &&
    proof.coPresence.uncertaintyAdjustedDistanceMeters >=
      proof.coPresence.distanceMeters &&
    proof.coPresence.uncertaintyAdjustedDistanceMeters <= 100 &&
    proof.coPresence.maximumMeters === 100 &&
    Number.isFinite(proof.coPresence.verifierAccuracyMeters) &&
    proof.coPresence.verifierAccuracyMeters > 0
  );
};

const hasAuditedGeofenceSnapshot = (record, action) => {
  const snapshot = action === 'checkIn'
    ? record?.geofenceSnapshot
    : record?.checkOutGeofenceSnapshot;
  return Boolean(
    snapshot &&
    typeof snapshot.verificationAuditId === 'string' &&
    /^[A-Za-z0-9:_-]{1,180}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(snapshot.verificationAuditId) &&
    typeof snapshot.verificationReviewedBy === 'string' &&
    snapshot.verificationReviewedBy.length >= 3 &&
    typeof snapshot.verificationOperator === 'string' &&
    typeof snapshot.verificationReviewOperator === 'string' &&
    /^[0-9a-f]{64}$/.test(snapshot.verificationOperator) &&
    /^[0-9a-f]{64}$/.test(snapshot.verificationReviewOperator) &&
    snapshot.verificationOperator !== snapshot.verificationReviewOperator &&
    toTimestampMillis(snapshot.verificationReviewedAt) !== null
  );
};

const hasRecordedGpsLocation = (record, action) => {
  const location = action === 'checkIn'
    ? record?.checkInLocation
    : record?.checkOutLocation;
  const actionMillis = toTimestampMillis(
    action === 'checkIn' ? record?.checkIn : record?.checkOut
  );
  const serverReceivedAtMillis = toTimestampMillis(location?.serverReceivedAt);
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  const accuracy = Number(location?.accuracy);
  const capturedAt = Number(location?.capturedAt);
  return Boolean(
    location &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0) &&
    Number.isFinite(accuracy) &&
    accuracy > 0 &&
    accuracy <= 100 &&
    Number.isInteger(capturedAt) &&
    actionMillis !== null &&
    serverReceivedAtMillis === actionMillis &&
    capturedAt >= serverReceivedAtMillis - 2 * 60 * 1000 &&
    capturedAt <= serverReceivedAtMillis + 10 * 1000 &&
    GPS_LOCATION_SOURCES.has(location.source)
  );
};

const hasAssignmentSnapshot = (record, action) => {
  const snapshot = action === 'checkIn'
    ? record?.assignmentSnapshot
    : record?.checkOutAssignmentSnapshot;
  return Boolean(
    hasExactKeys(snapshot, ['collection', 'id', 'name']) &&
    ['kelurahan', 'kantor'].includes(snapshot.collection) &&
    typeof snapshot.id === 'string' &&
    snapshot.id.length > 0 &&
    typeof snapshot.name === 'string' &&
    snapshot.name.trim().length > 0
  );
};

const hasLocationPhotoPresenceMarker = (record, action) => {
  const proof = action === 'checkIn'
    ? record?.presenceProof
    : record?.checkOutPresenceProof;
  return Boolean(
    hasExactKeys(proof, ['required', 'verified', 'reason']) &&
    proof.required === false &&
    proof.verified === false &&
    proof.reason === 'policy_location_photo'
  );
};

/**
 * Only backend-verified v2 records are valid presence evidence. A completed
 * record still needs the stricter predicate below before it may affect pay.
 */
export const isVerifiedAttendance = (record) => Boolean(
  record &&
  record.verificationStatus === 'verified' &&
  record.integrityVersion === CURRENT_ATTENDANCE_INTEGRITY_VERSION &&
  record.proofVersion === CURRENT_ATTENDANCE_PROOF_VERSION &&
  record.transitionMode === false &&
  record.isWithinRadius === true &&
  toTimestampMillis(record.checkIn) !== null &&
  hasCanonicalAttendanceProof(record, 'checkIn') &&
  hasVerifiedPresenceProof(record, 'checkIn') &&
  hasAuditedGeofenceSnapshot(record, 'checkIn')
);

/**
 * Temporary location+photo records remain operational for check-out and
 * reporting, but are deliberately excluded from Verified v2 and payroll.
 */
export const isLocationPhotoAttendance = (record) => Boolean(
  record &&
  record.verificationMode === ATTENDANCE_VERIFICATION_MODE_LOCATION_PHOTO &&
  record.verificationStatus === LOCATION_PHOTO_VERIFICATION_STATUS &&
  record.integrityVersion === CURRENT_ATTENDANCE_INTEGRITY_VERSION &&
  record.proofVersion === CURRENT_ATTENDANCE_PROOF_VERSION &&
  record.transitionMode === true &&
  record.isWithinRadius === null &&
  record.deviceVerified === false &&
  record.distanceFromGeofence === null &&
  record.geofenceSnapshot === null &&
  toTimestampMillis(record.checkIn) !== null &&
  hasCanonicalAttendanceProof(record, 'checkIn') &&
  hasRecordedGpsLocation(record, 'checkIn') &&
  hasAssignmentSnapshot(record, 'checkIn') &&
  hasLocationPhotoPresenceMarker(record, 'checkIn')
);

export const isAttendanceWorkflowEligible = (record) =>
  isVerifiedAttendance(record) || isLocationPhotoAttendance(record);

/**
 * Payroll eligibility is stricter than a valid check-in: both server timestamps
 * and both challenge-bound photo proofs must form a completed shift.
 */
export const isCompletedVerifiedAttendance = (record) => {
  if (!isVerifiedAttendance(record)) return false;

  const checkInMillis = toTimestampMillis(record.checkIn);
  const checkOutMillis = toTimestampMillis(record.checkOut);
  const workHours = record.workHours;
  const calculatedWorkHours = checkOutMillis === null
    ? null
    : Math.round(((checkOutMillis - checkInMillis) / 3_600_000) * 100) / 100;
  return checkOutMillis !== null
    && checkOutMillis >= checkInMillis
    && Number.isFinite(workHours)
    && workHours >= 0
    && workHours === calculatedWorkHours
    && hasCanonicalAttendanceProof(record, 'checkOut')
    && hasVerifiedPresenceProof(record, 'checkOut')
    && hasAuditedGeofenceSnapshot(record, 'checkOut');
};

export const isCompletedLocationPhotoAttendance = (record) => {
  if (!isLocationPhotoAttendance(record)) return false;

  const checkInMillis = toTimestampMillis(record.checkIn);
  const checkOutMillis = toTimestampMillis(record.checkOut);
  const calculatedWorkHours = checkOutMillis === null
    ? null
    : Math.round(((checkOutMillis - checkInMillis) / 3_600_000) * 100) / 100;
  return checkOutMillis !== null &&
    checkOutMillis >= checkInMillis &&
    record.checkOutVerificationMode ===
      ATTENDANCE_VERIFICATION_MODE_LOCATION_PHOTO &&
    record.checkOutVerificationStatus === LOCATION_PHOTO_VERIFICATION_STATUS &&
    record.checkOutTransitionMode === true &&
    record.checkOutIsWithinRadius === null &&
    record.checkOutDeviceVerified === false &&
    record.checkOutDistanceFromGeofence === null &&
    record.checkOutGeofenceSnapshot === null &&
    Number.isFinite(record.workHours) &&
    record.workHours >= 0 &&
    record.workHours === calculatedWorkHours &&
    hasCanonicalAttendanceProof(record, 'checkOut') &&
    hasRecordedGpsLocation(record, 'checkOut') &&
    hasAssignmentSnapshot(record, 'checkOut') &&
    hasLocationPhotoPresenceMarker(record, 'checkOut');
};

export const isCompletedRecordedAttendance = (record) =>
  isCompletedVerifiedAttendance(record) ||
  isCompletedLocationPhotoAttendance(record);

export const isReviewableAttendancePhoto = (record, action) => {
  if (!['checkIn', 'checkOut'].includes(action) ||
      !hasCanonicalAttendanceProof(record, action)) {
    return false;
  }
  if (isVerifiedAttendance(record)) {
    return action === 'checkIn' || isCompletedVerifiedAttendance(record);
  }
  if (isLocationPhotoAttendance(record)) {
    return action === 'checkIn' || isCompletedLocationPhotoAttendance(record);
  }
  return false;
};

export const getVerifiedWorkHours = (record) => {
  if (!isCompletedVerifiedAttendance(record)) return 0;
  const hours = Number(record?.workHours);
  return Number.isFinite(hours) && hours >= 0 ? hours : 0;
};
