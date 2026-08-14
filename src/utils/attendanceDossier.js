// Berkas bukti kehadiran per pegawai — ISWMP SumBar-Padang
//
// Menyusun catatan harian satu pegawai sepanjang satu periode kontrak: jam
// check-in/check-out, lokasi beserta koordinat dan jaraknya, serta penanda
// ketersediaan foto bukti. Dipakai layar arsip yang ditelusuri pemberi kerja
// dan auditor, jadi setiap hari dalam periode selalu muncul — termasuk hari
// tanpa catatan — supaya tidak ada tanggal yang diam-diam hilang.

import {
  attendanceTimestampDate,
  formatAttendanceWibDateTime,
  getAttendanceLocationLabel,
  getCanonicalEarlyLeaveDetails,
  isCrossDayAttendance,
} from './attendanceDisplay.js';
import {
  isLocationPhotoAttendance,
  isReviewableAttendancePhoto,
  isVerifiedAttendance,
} from './attendanceIntegrity.js';
import { resolveAttendanceCompletion } from './attendanceCorrection.js';
import { formatWibTime } from './attendanceTime.js';
import { getDateKeysInRange, isWeekend } from './contractPeriods.js';
import { categorizeAttendanceLocation, getLocationCategoryLabel } from './attendanceRecap.js';

const WEEKDAY_NAMES_ID = [
  'Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu',
];

/** Nama hari dihitung dari tanggal kalender, bukan zona waktu perangkat. */
export const getWeekdayNameId = (dateKey) => {
  if (typeof dateKey !== 'string') return '-';
  const [year, month, day] = dateKey.split('-').map(Number);
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return WEEKDAY_NAMES_ID[index] ?? '-';
};

export const getCoordinates = (location) => {
  if (!location || typeof location !== 'object') return null;

  const lat = Number(location.lat);
  const lng = Number(location.lng);
  const isValid = Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180
    && !(lat === 0 && lng === 0);

  return isValid ? { lat, lng } : null;
};

export const getGoogleMapsUrl = (location) => {
  const coordinates = getCoordinates(location);
  if (!coordinates) return null;
  const query = `${coordinates.lat},${coordinates.lng}`;
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}`;
};

const getAccuracyMeters = (location, fallback = null) => {
  const accuracy = Number(location?.accuracy ?? fallback);
  return Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null;
};

const getDistanceMeters = (record, action) => {
  const snapshot = action === 'checkOut'
    ? record?.checkOutOperationalLocationSnapshot
    : record?.operationalLocationSnapshot;
  const candidate = Number(
    snapshot?.distanceMeters ?? (action === 'checkIn' ? record?.distanceFromGeofence : null)
  );
  return Number.isFinite(candidate) && candidate >= 0 ? Math.round(candidate) : null;
};

/** Sisi check-in atau check-out dari satu record, siap tampil. */
const buildSide = (record, action, { timestamp, isEffective = false }) => {
  const location = action === 'checkOut'
    ? record?.checkOutLocation
    : record?.checkInLocation;
  const date = attendanceTimestampDate(timestamp);
  const coordinates = getCoordinates(location);

  return {
    action,
    recorded: Boolean(date),
    /** Jam check-out hasil koreksi administratif, bukan rekaman perangkat. */
    isEffective,
    time: date,
    timeLabel: date ? `${formatWibTime(date)} WIB` : '-',
    dateTimeLabel: formatAttendanceWibDateTime(timestamp),
    locationName: getAttendanceLocationLabel(record, {
      action,
      fallback: 'Tidak tercatat',
    }),
    locationCategory: categorizeAttendanceLocation(record),
    locationCategoryLabel: getLocationCategoryLabel(
      categorizeAttendanceLocation(record)
    ),
    coordinates,
    coordinatesLabel: coordinates
      ? `${coordinates.lat.toFixed(6)}, ${coordinates.lng.toFixed(6)}`
      : '-',
    mapsUrl: getGoogleMapsUrl(location),
    accuracyMeters: getAccuracyMeters(location, record?.locationAccuracy),
    distanceMeters: getDistanceMeters(record, action),
    hasPhoto: isReviewableAttendancePhoto(record, action),
    /** Sidik digital foto menurut catatan server — dasar verifikasi auditor. */
    photoPath: typeof record?.[`${action}PhotoPath`] === 'string'
      ? record[`${action}PhotoPath`]
      : null,
    photoSha256: typeof record?.[`${action}PhotoHash`] === 'string'
      ? record[`${action}PhotoHash`]
      : null,
    photoGeneration: record?.[`${action}PhotoGeneration`] ?? null,
  };
};

const buildAssuranceLabel = (record, completion) => {
  if (isVerifiedAttendance(record)) {
    if (completion.manualCorrection) {
      return 'Verified v2 + koreksi administratif';
    }
    return 'Verified v2 (perangkat terverifikasi)';
  }
  if (isLocationPhotoAttendance(record)) return 'GPS + foto (lokasi sementara)';
  return 'Tidak terverifikasi / legacy';
};

/**
 * Satu hari dalam berkas. `record` boleh null: hari tanpa catatan tetap
 * ditampilkan sebagai baris kosong agar rentangnya utuh.
 */
const buildDayEntry = (dateKey, record, { cutoffDateKey }) => {
  const weekend = isWeekend(dateKey);
  const pending = Boolean(cutoffDateKey) && dateKey > cutoffDateKey;

  if (!record) {
    return {
      date: dateKey,
      weekdayName: getWeekdayNameId(dateKey),
      isWeekend: weekend,
      isPending: pending,
      hasRecord: false,
      status: null,
      statusLabel: pending
        ? 'Belum berjalan'
        : (weekend ? 'Akhir pekan' : 'Tidak ada catatan'),
      checkIn: null,
      checkOut: null,
      workHours: 0,
      isCrossDay: false,
      earlyLeave: { isEarlyLeave: false, reason: '' },
      assuranceLabel: '-',
      manualCorrection: false,
      recordId: null,
    };
  }

  const completion = resolveAttendanceCompletion(record);
  const earlyLeave = getCanonicalEarlyLeaveDetails(record);
  const effectiveRecord = {
    ...record,
    checkOut: completion.isComplete ? completion.checkOut : null,
  };

  return {
    date: dateKey,
    weekdayName: getWeekdayNameId(dateKey),
    isWeekend: weekend,
    isPending: false,
    hasRecord: true,
    status: record.status === 'late' ? 'late' : 'ontime',
    statusLabel: record.status === 'late' ? 'Terlambat' : 'Tepat waktu',
    checkIn: buildSide(record, 'checkIn', { timestamp: record.checkIn }),
    checkOut: completion.isComplete
      ? buildSide(record, 'checkOut', {
        timestamp: completion.checkOut,
        isEffective: completion.manualCorrection,
      })
      : null,
    workHours: completion.isComplete && Number.isFinite(Number(completion.workHours))
      ? Number(completion.workHours)
      : 0,
    isCrossDay: completion.isComplete && isCrossDayAttendance(effectiveRecord),
    earlyLeave,
    assuranceLabel: buildAssuranceLabel(record, completion),
    manualCorrection: completion.manualCorrection === true,
    completionSource: completion.completionSource,
    recordId: record.id,
  };
};

/**
 * Berkas satu pegawai untuk satu periode.
 *
 * Record ganda pada tanggal yang sama dipertahankan di `extraRecords` supaya
 * penelusuran audit melihat semuanya, bukan hanya yang pertama.
 */
export const buildEmployeeDossier = ({
  employee,
  attendances = [],
  period,
  cutoffDateKey = null,
}) => {
  if (!employee || !period?.startDate || !period?.endDate) return null;

  const owned = attendances
    .filter((record) => record?.userId === employee.id)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const byDate = new Map();
  const duplicatesByDate = new Map();
  owned.forEach((record) => {
    if (byDate.has(record.date)) {
      const list = duplicatesByDate.get(record.date) || [];
      list.push(record);
      duplicatesByDate.set(record.date, list);
      return;
    }
    byDate.set(record.date, record);
  });

  const days = getDateKeysInRange(period.startDate, period.endDate).map(
    (dateKey) => ({
      ...buildDayEntry(dateKey, byDate.get(dateKey) || null, { cutoffDateKey }),
      extraRecords: duplicatesByDate.get(dateKey) || [],
    })
  );

  const recorded = days.filter((day) => day.hasRecord);
  const photoCount = recorded.reduce((sum, day) => (
    sum + (day.checkIn?.hasPhoto ? 1 : 0) + (day.checkOut?.hasPhoto ? 1 : 0)
  ), 0);

  return {
    employee: {
      id: employee.id,
      name: employee.name || 'Tanpa Nama',
      email: employee.email || '',
      position: employee.position || 'N/A',
      department: employee.department || 'N/A',
    },
    period,
    days,
    summary: {
      recordedDays: recorded.length,
      lateDays: recorded.filter((day) => day.status === 'late').length,
      completeDays: recorded.filter((day) => day.checkOut).length,
      openShiftDays: recorded.filter((day) => !day.checkOut).length,
      earlyLeaveDays: recorded.filter((day) => day.earlyLeave.isEarlyLeave).length,
      crossDayShifts: recorded.filter((day) => day.isCrossDay).length,
      manualCorrections: recorded.filter((day) => day.manualCorrection).length,
      totalWorkHours: recorded.reduce((sum, day) => sum + day.workHours, 0),
      photoCount,
      duplicateRecords: [...duplicatesByDate.values()]
        .reduce((sum, list) => sum + list.length, 0),
    },
  };
};
