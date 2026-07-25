import { isAttendanceWorkflowEligible } from './attendanceIntegrity.js';
import {
  getWibDateDaysAgo,
  getWibDateString,
} from './attendanceTime.js';
import { resolveAttendanceCompletion } from './attendanceCorrection.js';

export const MIN_ATTENDANCE_SHIFT_DURATION_MINUTES = 60;
export const MAX_ATTENDANCE_SHIFT_DURATION_MINUTES = 24 * 60;

export const attendanceShiftDurationMs = (minutes) => (
  Number.isInteger(minutes) &&
  minutes >= MIN_ATTENDANCE_SHIFT_DURATION_MINUTES &&
  minutes <= MAX_ATTENDANCE_SHIFT_DURATION_MINUTES
    ? minutes * 60 * 1000
    : null
);

export const formatAttendanceShiftDuration = (minutes) => {
  if (attendanceShiftDurationMs(minutes) == null) {
    return 'batas durasi shift';
  }
  return minutes % 60 === 0
    ? `${minutes / 60} jam`
    : `${minutes} menit`;
};

const normalizeMaximumAgeMs = (value) => (
  Number.isFinite(value) &&
  value >= MIN_ATTENDANCE_SHIFT_DURATION_MINUTES * 60 * 1000 &&
  value <= MAX_ATTENDANCE_SHIFT_DURATION_MINUTES * 60 * 1000
    ? value
    : null
);

const attendanceTimestampMillis = (value) => {
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

const compareAttendanceRecords = (left, right) => {
  const dateOrder = String(right?.date || '').localeCompare(
    String(left?.date || '')
  );
  if (dateOrder !== 0) return dateOrder;

  const leftCheckIn = attendanceTimestampMillis(left?.checkIn) ?? -Infinity;
  const rightCheckIn = attendanceTimestampMillis(right?.checkIn) ?? -Infinity;
  if (leftCheckIn !== rightCheckIn) return rightCheckIn - leftCheckIn;

  return String(left?.id || '').localeCompare(String(right?.id || ''));
};

export const isOpenAttendanceWithinShiftDuration = (
  attendance,
  now = new Date(),
  maximumAgeMs = null
) => {
  const nowMillis = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const checkInMillis = attendanceTimestampMillis(attendance?.checkIn);
  const ageMillis = checkInMillis == null ? NaN : nowMillis - checkInMillis;
  const normalizedMaximumAgeMs = normalizeMaximumAgeMs(maximumAgeMs);
  return attendance?.checkOut == null &&
    !resolveAttendanceCompletion(attendance).isComplete &&
    isAttendanceWorkflowEligible(attendance) &&
    Number.isFinite(ageMillis) &&
    normalizedMaximumAgeMs != null &&
    ageMillis >= 0 &&
    ageMillis <= normalizedMaximumAgeMs;
};

// Backward-compatible export for callers that still use the old name. The
// predicate now includes explicitly recognized temporary location+photo shifts.
export const isVerifiedOpenAttendanceWithinShiftDuration =
  isOpenAttendanceWithinShiftDuration;

/**
 * Resolve the record used by employee attendance UI without trusting query
 * ordering. Only a verified, incomplete shift from today/yesterday whose
 * server check-in is within the server-configured duration may be offered for
 * checkout.
 */
export const resolveEmployeeAttendanceState = (
  records,
  now = new Date(),
  userId = '',
  maximumAgeMs = null
) => {
  const nowMillis = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const today = getWibDateString(now);
  const previousDate = getWibDateDaysAgo(1, now);
  const allowedDates = new Set([today, previousDate]);
  const sortedRecords = (Array.isArray(records) ? records : [])
    .filter((record) => record && allowedDates.has(record.date))
    .sort(compareAttendanceRecords);
  const todayRecords = sortedRecords.filter((record) => record.date === today);
  const canonicalTodayId = userId ? `${userId}_${today}` : '';
  const todayAttendance = todayRecords.find(
    (record) => canonicalTodayId && record.id === canonicalTodayId
  ) || todayRecords[0] || null;
  const operationalOpenRecords = sortedRecords.filter((record) => (
    !resolveAttendanceCompletion(record).isComplete &&
    isAttendanceWorkflowEligible(record)
  ));
  const activeAttendance = operationalOpenRecords.find((record) =>
    isOpenAttendanceWithinShiftDuration(
      record,
      now,
      maximumAgeMs
    )
  ) || null;
  const normalizedMaximumAgeMs = normalizeMaximumAgeMs(maximumAgeMs);
  const expiredOpenAttendance = activeAttendance
    ? null
    : normalizedMaximumAgeMs == null
      ? null
      : operationalOpenRecords.find((record) => {
      const checkInMillis = attendanceTimestampMillis(record.checkIn);
      return checkInMillis != null &&
        Number.isFinite(nowMillis) &&
        nowMillis - checkInMillis > normalizedMaximumAgeMs;
      }) || null;

  return {
    today,
    previousDate,
    records: sortedRecords,
    todayAttendance,
    activeAttendance,
    expiredOpenAttendance,
  };
};
