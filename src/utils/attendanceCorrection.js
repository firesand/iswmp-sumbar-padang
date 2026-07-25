import {
  isAttendanceWorkflowEligible,
  isCompletedLocationPhotoAttendance,
  isCompletedRecordedAttendance,
  isCompletedVerifiedAttendance,
  isLocationPhotoAttendance,
} from './attendanceIntegrity.js';

export const ADMINISTRATIVE_COMPLETION_SOURCE =
  'dual-approved-manual-missing-checkout-v1';

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

const calculatedHours = (checkInMs, checkOutMs) =>
  Math.round(((checkOutMs - checkInMs) / 3_600_000) * 100) / 100;

export const normalizeEffectiveAttendanceCorrection = (
  attendance,
  projection
) => {
  const checkInMs = timestampMillis(attendance?.checkIn);
  const originalCheckInMs = timestampMillis(projection?.originalCheckIn);
  const effectiveCheckOutMs = timestampMillis(projection?.effectiveCheckOut);
  const approvedAtMs = timestampMillis(projection?.approvedAt);
  const canonicalAttendanceId = attendance?.userId && attendance?.date
    ? `${attendance.userId}_${attendance.date}`
    : null;
  const expectedHours =
    checkInMs != null && effectiveCheckOutMs != null
      ? calculatedHours(checkInMs, effectiveCheckOutMs)
      : null;
  const projectionValid = Boolean(
    attendance &&
    projection &&
    isAttendanceWorkflowEligible(attendance) &&
    !isCompletedRecordedAttendance(attendance) &&
    attendance.checkOut == null &&
    attendance.id === canonicalAttendanceId &&
    projection.schemaVersion === 1 &&
    projection.attendanceId === attendance.id &&
    projection.userId === attendance.userId &&
    projection.workDate === attendance.date &&
    projection.correctionType === 'missing_checkout' &&
    projection.revision === 1 &&
    Number.isInteger(projection.baseShiftRevision) &&
    projection.baseShiftRevision >= 1 &&
    typeof projection.proposalId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(projection.proposalId) &&
    projection.correctionEventId === projection.proposalId &&
    projection.completionSource === ADMINISTRATIVE_COMPLETION_SOURCE &&
    projection.manualCorrection === true &&
    projection.deviceVerified === false &&
    projection.canonicalAttendanceChanged === false &&
    checkInMs != null &&
    originalCheckInMs === checkInMs &&
    effectiveCheckOutMs != null &&
    effectiveCheckOutMs > checkInMs &&
    approvedAtMs != null &&
    approvedAtMs >= effectiveCheckOutMs &&
    Number.isFinite(Number(projection.effectiveWorkHours)) &&
    Number(projection.effectiveWorkHours) === expectedHours
  );

  if (!projectionValid) return null;
  return {
    approvedAt: projection.approvedAt,
    baseShiftRevision: projection.baseShiftRevision,
    checkOut: projection.effectiveCheckOut,
    completionSource: projection.completionSource,
    correctionEventId: projection.correctionEventId,
    deviceVerified: false,
    manualCorrection: true,
    proposalId: projection.proposalId,
    workHours: expectedHours,
  };
};

export const attachEffectiveAttendanceCorrection = (
  attendance,
  projection
) => {
  const normalized =
    normalizeEffectiveAttendanceCorrection(attendance, projection);
  return {
    ...attendance,
    administrativeCorrection: normalized,
    correctionProjectionInvalid: Boolean(projection && !normalized),
  };
};

export const resolveAttendanceCompletion = (attendance) => {
  if (isCompletedVerifiedAttendance(attendance)) {
    return {
      checkOut: attendance.checkOut,
      completionSource: 'verified-device',
      deviceRecorded: true,
      deviceVerified: true,
      isComplete: true,
      locationPhotoOnly: false,
      manualCorrection: false,
      workHours: attendance.workHours,
    };
  }
  if (isCompletedLocationPhotoAttendance(attendance)) {
    return {
      checkOut: attendance.checkOut,
      completionSource: 'location-photo',
      deviceRecorded: true,
      deviceVerified: false,
      isComplete: true,
      locationPhotoOnly: true,
      manualCorrection: false,
      workHours: attendance.workHours,
    };
  }
  if (attendance?.administrativeCorrection) {
    return {
      checkOut: attendance.administrativeCorrection.checkOut,
      completionSource:
        attendance.administrativeCorrection.completionSource,
      deviceRecorded: false,
      deviceVerified: false,
      isComplete: true,
      locationPhotoOnly: isLocationPhotoAttendance(attendance),
      manualCorrection: true,
      workHours: attendance.administrativeCorrection.workHours,
    };
  }
  return {
    checkOut: null,
    completionSource: 'open',
    deviceRecorded: false,
    deviceVerified: false,
    isComplete: false,
    locationPhotoOnly: isLocationPhotoAttendance(attendance),
    manualCorrection: false,
    workHours: 0,
  };
};
