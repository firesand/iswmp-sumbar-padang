import {
  formatWibDate,
  formatWibTime,
  getWibDateString,
  getWibHour,
} from './attendanceTime.js';

export const attendanceTimestampDate = (value) => {
  if (value == null) return null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value?.toMillis === 'function') {
    const date = new Date(value.toMillis());
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const attendanceTimestampMillis = (value) =>
  attendanceTimestampDate(value)?.getTime() ?? null;

export const formatAttendanceWibDateTime = (value, fallback = '-') => {
  const date = attendanceTimestampDate(value);
  if (!date) return fallback;
  return `${formatWibDate(date, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })}, ${formatWibTime(date)} WIB`;
};

export const isCrossDayAttendance = (attendance) => {
  const checkOut = attendanceTimestampDate(attendance?.checkOut);
  if (!checkOut) return false;

  const shiftDate = typeof attendance?.date === 'string'
    ? attendance.date
    : getWibDateString(attendanceTimestampDate(attendance?.checkIn) || checkOut);
  return getWibDateString(checkOut) !== shiftDate;
};

export const classifyAttendanceCheckout = (
  attendance,
  {
    earlyLeaveBeforeHour = 17,
    overtimeAtOrAfterHour = 18,
  } = {}
) => {
  const checkOut = attendanceTimestampDate(attendance?.checkOut);
  if (!checkOut) {
    return {
      crossDay: false,
      earlyLeave: false,
      overtime: false,
    };
  }
  if (isCrossDayAttendance(attendance)) {
    return {
      crossDay: true,
      earlyLeave: false,
      overtime: false,
    };
  }

  const checkOutHour = getWibHour(checkOut);
  return {
    crossDay: false,
    earlyLeave: checkOutHour < earlyLeaveBeforeHour,
    overtime: checkOutHour >= overtimeAtOrAfterHour,
  };
};

export const getCanonicalEarlyLeaveDetails = (attendance) => {
  const isEarlyLeave = attendance?.earlyLeave === true;
  const candidate = isEarlyLeave &&
    typeof attendance?.earlyLeaveReason === 'string'
    ? attendance.earlyLeaveReason.trim()
    : '';
  const hasForbiddenControlCharacter = [...candidate].some((character) => {
    const codePoint = character.codePointAt(0);
    return (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127;
  });
  const reason = candidate.length >= 5 &&
    candidate.length <= 300 &&
    !hasForbiddenControlCharacter
    ? candidate
    : '';

  return {
    isEarlyLeave,
    reason,
  };
};

const FORMULA_PREFIX_PATTERN = /^\s*[=+\-@]/u;

export const neutralizeSpreadsheetFormula = (value) => {
  const text = value == null ? '' : String(value);
  return FORMULA_PREFIX_PATTERN.test(text) ? `'${text}` : text;
};

export const escapeCsvCell = (value) => {
  const safeValue = neutralizeSpreadsheetFormula(value);
  return `"${safeValue.replace(/"/g, '""')}"`;
};

export const rowsToCsv = (rows) =>
  (Array.isArray(rows) ? rows : [])
    .map((row) =>
      (Array.isArray(row) ? row : [row])
        .map(escapeCsvCell)
        .join(',')
    )
    .join('\r\n');

/**
 * Prefer the matched operational location (assignment or temporary venue)
 * when present; fall back to verified geofence / assignment name.
 */
export const getAttendanceLocationLabel = (
  attendance,
  { action = 'checkIn', fallback = '' } = {},
) => {
  if (!attendance || typeof attendance !== 'object') return fallback;
  const operational = action === 'checkOut'
    ? attendance.checkOutOperationalLocationSnapshot
    : attendance.operationalLocationSnapshot;
  const operationalName = typeof operational?.name === 'string'
    ? operational.name.trim()
    : '';
  if (operationalName) {
    return operational.source === 'temporary'
      ? `${operationalName} (lokasi sementara)`
      : operationalName;
  }
  if (typeof attendance.geofenceName === 'string' &&
      attendance.geofenceName.trim()) {
    return attendance.geofenceName.trim();
  }
  const assignmentName = typeof attendance.assignmentSnapshot?.name === 'string'
    ? attendance.assignmentSnapshot.name.trim()
    : '';
  return assignmentName || fallback;
};
