// Waktu absensi — ISWMP SumBar-Padang
// Tanggal & status keterlambatan divalidasi ulang oleh Firestore rules memakai
// jam server (UTC+7). Helper di sini menghitung nilai yang sama di client agar
// write tidak ditolak, dan sengaja memakai zona waktu Asia/Jakarta secara
// eksplisit — bukan zona waktu perangkat — supaya HP yang zonanya salah tetap
// menghasilkan tanggal/status yang benar.

export const ATTENDANCE_TIMEZONE = 'Asia/Jakarta';

// Fallback dokumentasi lama saja. Status authoritative selalu dihitung backend
// dari projectConfig/default.jamCheckInDeadline, bukan dikirim client.
export const LATE_HOUR_WIB = 8;
export const LATE_MINUTE_WIB = 10;
export const DEFAULT_CHECKIN_DEADLINE = '08:10';

const wibDateParts = (date = new Date()) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: ATTENDANCE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

// "YYYY-MM-DD" menurut WIB, dirakit dari parts agar tidak bergantung pada
// variasi separator/urutan locale browser.
export const getWibDateString = (date = new Date()) => {
  const parts = wibDateParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};

export const getWibDateDaysAgo = (days, date = new Date()) => {
  const [year, month, day] = getWibDateString(date).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day - Number(days), 5));
  return getWibDateString(shifted);
};

const toDate = (value) => {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00+07:00`);
  }
  const result = value instanceof Date ? value : new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
};

export const formatWibTime = (value, options = {}) => {
  const date = toDate(value);
  if (!date) return '-';
  return date.toLocaleTimeString('id-ID', {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  });
};

export const formatWibDate = (value, options = {}) => {
  const date = toDate(value);
  if (!date) return '-';
  return date.toLocaleDateString('id-ID', {
    timeZone: ATTENDANCE_TIMEZONE,
    ...options,
  });
};

export const getWibHour = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === 'hour')?.value;
  return Number(hour);
};

export const getWibMinutes = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
};

export const getAttendanceStatus = (date = new Date(), deadline = DEFAULT_CHECKIN_DEADLINE) => {
  const currentMinutes = getWibMinutes(date);
  const [dHour, dMinute] = (deadline || DEFAULT_CHECKIN_DEADLINE).split(':').map(Number);
  const deadlineMinutes = (Number.isFinite(dHour) ? dHour : 8) * 60 + (Number.isFinite(dMinute) ? dMinute : 10);
  return currentMinutes > deadlineMinutes ? 'late' : 'ontime';
};

// Legacy/UI helper. Backend tidak mempercayai nilai ini dan menghitung status
// dari deadline canonical sendiri.
export const getAttendanceStamp = (deadline = DEFAULT_CHECKIN_DEADLINE) => {
  const now = new Date();
  return {
    now,
    date: getWibDateString(now),
    status: getAttendanceStatus(now, deadline),
  };
};

// Firestore menolak write bila jam perangkat melewati batas tanggal / batas
// jam 09:00 di tengah proses upload foto, atau bila jam perangkat memang meleset.
export const isServerTimeRejection = (error) =>
  error?.code === 'permission-denied' ||
  /permission|insufficient/i.test(error?.message || '');

export const SERVER_TIME_REJECTION_MESSAGE =
  'Absensi ditolak server. Pastikan tanggal & jam perangkat Anda otomatis/tepat, ' +
  'lalu coba lagi.';
