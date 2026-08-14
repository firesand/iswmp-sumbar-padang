// Rekap kehadiran per periode kontrak — ISWMP SumBar-Padang
//
// Modul ini murni perhitungan: menerima daftar pegawai + record absensi yang
// sudah dilampiri projection koreksi, lalu mengembalikan rekap siap tampil
// untuk remunerasi (hari hadir yang dapat ditagihkan) dan monitoring-evaluasi
// (kedisiplinan jam masuk serta sebaran lokasi kehadiran). Tidak ada akses
// Firestore di sini supaya seluruh aturannya bisa diuji.

import { ATTENDANCE_TIMEZONE, getWibDateString } from './attendanceTime.js';
import { getDateKeysInRange, isWeekend } from './contractPeriods.js';
import { resolveAttendanceCompletion } from './attendanceCorrection.js';
import {
  isAttendanceWorkflowEligible,
  isLocationPhotoAttendance,
  isVerifiedAttendance,
} from './attendanceIntegrity.js';
import {
  getAttendanceLocationLabel,
  getCanonicalEarlyLeaveDetails,
} from './attendanceDisplay.js';

/** Status satu kotak di kalender periode. */
export const DAY_STATE = Object.freeze({
  ONTIME: 'ontime',
  LATE: 'late',
  ABSENT: 'absent',
  WEEKEND: 'weekend',
  WEEKEND_PRESENT: 'weekendPresent',
  FUTURE: 'future',
  /** Sebelum akun pegawai ada — bukan ketidakhadiran. */
  PRE_ACTIVE: 'preActive',
});

export const LOCATION_CATEGORIES = Object.freeze([
  Object.freeze({ key: 'kantor', label: 'Kantor Proyek', color: '#0f766e' }),
  Object.freeze({ key: 'kelurahan', label: 'Lokasi Penugasan', color: '#2563eb' }),
  Object.freeze({ key: 'temporary', label: 'Kegiatan Sementara', color: '#a16207' }),
  Object.freeze({ key: 'lainnya', label: 'Lainnya / Legacy', color: '#6b7280' }),
]);

const LOCATION_KEYS = LOCATION_CATEGORIES.map((category) => category.key);

export const getLocationCategoryLabel = (key) =>
  LOCATION_CATEGORIES.find((category) => category.key === key)?.label
  ?? 'Lainnya / Legacy';

/**
 * Kategori lokasi check-in. `operationalLocationSnapshot` ditulis backend saat
 * absensi tervalidasi, jadi ia yang dipercaya lebih dulu; record legacy jatuh
 * ke kategori "lainnya" alih-alih ditebak dari koordinat.
 */
export const categorizeAttendanceLocation = (attendance) => {
  const snapshot = attendance?.operationalLocationSnapshot;
  if (snapshot?.source === 'temporary') return 'temporary';
  if (snapshot?.collection === 'kantor') return 'kantor';
  if (snapshot?.collection === 'kelurahan') return 'kelurahan';
  if (attendance?.assignmentSnapshot?.collection === 'kantor') return 'kantor';
  if (attendance?.assignmentSnapshot?.collection === 'kelurahan') {
    return 'kelurahan';
  }
  return 'lainnya';
};

const toDate = (value) => {
  if (!value) return null;
  const date = typeof value?.toDate === 'function'
    ? value.toDate()
    : new Date(value);
  return Number.isNaN(date?.getTime?.()) ? null : date;
};

/** Menit sejak tengah malam WIB, dipakai untuk rata-rata jam check-in. */
export const getWibMinutesOfDay = (value) => {
  const date = toDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
};

/** 505 → "08:25". Null-safe supaya kolom kosong tampil sebagai "-". */
export const formatMinutesOfDay = (minutes) => {
  if (!Number.isFinite(minutes)) return '-';
  const rounded = Math.round(minutes);
  const hour = Math.floor(rounded / 60) % 24;
  const minute = rounded % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const ratio = (numerator, denominator) => (
  denominator > 0 ? numerator / denominator : 0
);

const emptyLocationTally = () => LOCATION_KEYS.reduce((tally, key) => {
  tally[key] = 0;
  return tally;
}, {});

/**
 * Tanggal WIB akun pegawai dibuat. Hari sebelum itu tidak boleh dihitung
 * sebagai mangkir — pegawai yang bergabung di tengah kontrak akan tampak
 * bolos sepanjang awal periode kalau ini diabaikan.
 */
export const getEmployeeActiveFromDateKey = (employee) => {
  const date = toDate(employee?.createdAt ?? employee?.joinDate);
  return date ? getWibDateString(date) : null;
};

const createEmployeeRecap = (employee) => ({
  id: employee.id,
  name: employee.name || 'Tanpa Nama',
  activeFromDateKey: getEmployeeActiveFromDateKey(employee),
  elapsedWorkingDays: 0,
  email: employee.email || '',
  department: employee.department || 'N/A',
  position: employee.position || 'N/A',
  presentDays: 0,
  onTimeDays: 0,
  lateDays: 0,
  absentDays: 0,
  weekendPresentDays: 0,
  earlyLeaveDays: 0,
  completeDays: 0,
  openShiftDays: 0,
  manualCorrectionDays: 0,
  unverifiedDays: 0,
  locationPhotoDays: 0,
  totalWorkHours: 0,
  checkInMinutes: [],
  locationTally: emptyLocationTally(),
  locationNames: new Map(),
  dayStates: {},
  records: [],
});

const finalizeEmployeeRecap = (recap, context) => {
  const { workingDays } = context;
  const elapsedWorkingDays = recap.elapsedWorkingDays;
  const checkInMinutes = recap.checkInMinutes;
  const averageCheckInMinutes = checkInMinutes.length > 0
    ? checkInMinutes.reduce((sum, value) => sum + value, 0) / checkInMinutes.length
    : null;

  const dominantLocationKey = LOCATION_KEYS.reduce((best, key) => (
    recap.locationTally[key] > recap.locationTally[best] ? key : best
  ), LOCATION_KEYS[0]);
  const hasLocationData = recap.locationTally[dominantLocationKey] > 0;

  const topLocationNames = [...recap.locationNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, days]) => ({ name, days }));

  return {
    ...recap,
    checkInMinutes: undefined,
    locationNames: undefined,
    averageCheckInMinutes,
    averageCheckInLabel: formatMinutesOfDay(averageCheckInMinutes),
    dominantLocation: hasLocationData
      ? {
        key: dominantLocationKey,
        label: getLocationCategoryLabel(dominantLocationKey),
        days: recap.locationTally[dominantLocationKey],
      }
      : null,
    topLocationNames,
    attendanceRate: ratio(recap.presentDays, elapsedWorkingDays) * 100,
    punctualityRate: ratio(recap.onTimeDays, recap.presentDays) * 100,
    completionRate: ratio(recap.completeDays, recap.presentDays) * 100,
    avgWorkHours: ratio(recap.totalWorkHours, recap.completeDays),
    workingDays,
    elapsedWorkingDays,
  };
};

/**
 * Rekap satu periode kontrak.
 *
 * `todayDateKey` memisahkan hari yang belum terjadi dari ketidakhadiran, jadi
 * periode yang sedang berjalan tidak menghukum pegawai atas sisa hari.
 */
export const buildPeriodRecap = ({
  employees = [],
  attendances = [],
  period,
  todayDateKey,
}) => {
  if (!period?.startDate || !period?.endDate) return null;

  const dateKeys = getDateKeysInRange(period.startDate, period.endDate);

  // Tanggal yang sudah punya record pasti sudah berlalu. Cutoff mengikuti yang
  // paling akhir antara "hari ini" dan tanggal record terakhir, supaya jam
  // perangkat yang mundur tidak menghasilkan capaian di atas 100%.
  const latestRecordedDateKey = attendances.reduce((latest, record) => (
    typeof record?.date === 'string' && record.date > latest ? record.date : latest
  ), '');
  const observedDateKey = [todayDateKey, latestRecordedDateKey]
    .filter(Boolean)
    .reduce((latest, candidate) => (candidate > latest ? candidate : latest), '');
  const cutoffDateKey = observedDateKey && observedDateKey < period.endDate
    ? observedDateKey
    : period.endDate;

  const workingDayKeys = dateKeys.filter((dateKey) => !isWeekend(dateKey));
  const elapsedWorkingDayKeys = workingDayKeys.filter(
    (dateKey) => dateKey <= cutoffDateKey
  );
  const workingDays = workingDayKeys.length;
  const elapsedWorkingDays = elapsedWorkingDayKeys.length;

  const recapById = new Map(
    employees.map((employee) => [employee.id, createEmployeeRecap(employee)])
  );

  // Hanya record yang lolos alur kerja yang dihitung; sisanya dilaporkan
  // terpisah sebagai catatan integritas, bukan diam-diam dibuang.
  const eligible = attendances.filter(isAttendanceWorkflowEligible);
  const ineligibleCount = attendances.length - eligible.length;
  const invalidCorrectionProjections = attendances.filter(
    (record) => record.correctionProjectionInvalid
  ).length;

  const dailyTrend = new Map(
    dateKeys.map((dateKey) => [dateKey, {
      date: dateKey,
      weekend: isWeekend(dateKey),
      elapsed: dateKey <= cutoffDateKey,
      present: 0,
      late: 0,
    }])
  );

  const locationTotals = emptyLocationTally();
  const seenPerDay = new Set();
  const unmatchedRecords = [];

  eligible.forEach((record) => {
    const recap = recapById.get(record.userId);
    if (!recap) {
      unmatchedRecords.push(record);
      return;
    }

    const dateKey = record.date;
    const dayKey = `${record.userId}__${dateKey}`;
    recap.records.push(record);

    // Satu hari dihitung sekali; record susulan hanya melengkapi detail.
    if (seenPerDay.has(dayKey)) return;
    seenPerDay.add(dayKey);

    const completion = resolveAttendanceCompletion(record);
    const earlyLeave = getCanonicalEarlyLeaveDetails(record);
    const isLate = record.status === 'late';
    const weekendDay = isWeekend(dateKey);
    const locationKey = categorizeAttendanceLocation(record);

    recap.locationTally[locationKey] += 1;
    locationTotals[locationKey] += 1;

    const locationName = getAttendanceLocationLabel(record, {
      fallback: 'Tidak tercatat',
    });
    recap.locationNames.set(
      locationName,
      (recap.locationNames.get(locationName) || 0) + 1
    );

    const checkInMinutes = getWibMinutesOfDay(record.checkIn);
    if (Number.isFinite(checkInMinutes)) recap.checkInMinutes.push(checkInMinutes);

    if (weekendDay) {
      recap.weekendPresentDays += 1;
      recap.dayStates[dateKey] = DAY_STATE.WEEKEND_PRESENT;
    } else {
      recap.presentDays += 1;
      if (isLate) recap.lateDays += 1;
      else recap.onTimeDays += 1;
      recap.dayStates[dateKey] = isLate ? DAY_STATE.LATE : DAY_STATE.ONTIME;
    }

    if (earlyLeave.isEarlyLeave) recap.earlyLeaveDays += 1;
    if (completion.isComplete) {
      recap.completeDays += 1;
      const hours = Number(completion.workHours);
      if (Number.isFinite(hours) && hours >= 0) recap.totalWorkHours += hours;
    } else {
      recap.openShiftDays += 1;
    }
    if (completion.manualCorrection) recap.manualCorrectionDays += 1;
    if (!isVerifiedAttendance(record)) recap.unverifiedDays += 1;
    if (isLocationPhotoAttendance(record)) recap.locationPhotoDays += 1;

    const trend = dailyTrend.get(dateKey);
    if (trend) {
      trend.present += 1;
      if (isLate) trend.late += 1;
    }
  });

  // Sisa hari kerja yang sudah lewat tanpa record adalah ketidakhadiran,
  // dihitung sejak akun pegawai aktif saja.
  recapById.forEach((recap) => {
    // Record yang lebih tua dari tanggal pembuatan akun membuktikan pegawai
    // sudah bertugas lebih dulu, jadi tanggal aktif ikut yang paling awal.
    const earliestRecordDateKey = recap.records.reduce((earliest, record) => (
      typeof record?.date === 'string' && (!earliest || record.date < earliest)
        ? record.date
        : earliest
    ), '');
    const declaredActiveFrom = recap.activeFromDateKey;
    const effectiveActiveFrom = declaredActiveFrom
      && earliestRecordDateKey
      && earliestRecordDateKey < declaredActiveFrom
      ? earliestRecordDateKey
      : declaredActiveFrom;
    const activeFrom = effectiveActiveFrom && effectiveActiveFrom > period.startDate
      ? effectiveActiveFrom
      : period.startDate;
    recap.elapsedWorkingDays = elapsedWorkingDayKeys.filter(
      (dateKey) => dateKey >= activeFrom
    ).length;

    elapsedWorkingDayKeys.forEach((dateKey) => {
      if (recap.dayStates[dateKey]) return;
      if (dateKey < activeFrom) {
        recap.dayStates[dateKey] = DAY_STATE.PRE_ACTIVE;
        return;
      }
      recap.dayStates[dateKey] = DAY_STATE.ABSENT;
      recap.absentDays += 1;
    });
    dateKeys.forEach((dateKey) => {
      if (recap.dayStates[dateKey]) return;
      if (isWeekend(dateKey)) {
        recap.dayStates[dateKey] = dateKey < activeFrom
          ? DAY_STATE.PRE_ACTIVE
          : DAY_STATE.WEEKEND;
        return;
      }
      recap.dayStates[dateKey] = DAY_STATE.FUTURE;
    });
  });

  const employeeRecaps = [...recapById.values()]
    .map((recap) => finalizeEmployeeRecap(recap, { workingDays }))
    .sort((a, b) => b.attendanceRate - a.attendanceRate
      || a.name.localeCompare(b.name, 'id'));

  const totalPresentDays = employeeRecaps.reduce(
    (sum, recap) => sum + recap.presentDays, 0
  );
  // Kapasitas orang-hari menjumlahkan hari kerja masing-masing pegawai, jadi
  // pegawai yang bergabung di tengah periode tidak menurunkan capaian proyek.
  const manDaysCapacity = employeeRecaps.reduce(
    (sum, recap) => sum + recap.elapsedWorkingDays, 0
  );
  const totalOnTimeDays = employeeRecaps.reduce(
    (sum, recap) => sum + recap.onTimeDays, 0
  );
  const totalCheckInMinutes = employeeRecaps
    .map((recap) => recap.averageCheckInMinutes)
    .filter((value) => Number.isFinite(value));

  return {
    period,
    cutoffDateKey,
    isOngoing: cutoffDateKey < period.endDate,
    dateKeys,
    workingDays,
    elapsedWorkingDays,
    employees: employeeRecaps,
    totals: {
      employees: employeeRecaps.length,
      presentDays: totalPresentDays,
      onTimeDays: totalOnTimeDays,
      lateDays: employeeRecaps.reduce((sum, r) => sum + r.lateDays, 0),
      absentDays: employeeRecaps.reduce((sum, r) => sum + r.absentDays, 0),
      weekendPresentDays: employeeRecaps.reduce(
        (sum, r) => sum + r.weekendPresentDays, 0
      ),
      earlyLeaveDays: employeeRecaps.reduce((sum, r) => sum + r.earlyLeaveDays, 0),
      openShiftDays: employeeRecaps.reduce((sum, r) => sum + r.openShiftDays, 0),
      manualCorrectionDays: employeeRecaps.reduce(
        (sum, r) => sum + r.manualCorrectionDays, 0
      ),
      unverifiedDays: employeeRecaps.reduce((sum, r) => sum + r.unverifiedDays, 0),
      locationPhotoDays: employeeRecaps.reduce(
        (sum, r) => sum + r.locationPhotoDays, 0
      ),
      workHours: employeeRecaps.reduce((sum, r) => sum + r.totalWorkHours, 0),
      manDaysCapacity,
      attendanceRate: ratio(totalPresentDays, manDaysCapacity) * 100,
      punctualityRate: ratio(totalOnTimeDays, totalPresentDays) * 100,
      averageCheckInMinutes: totalCheckInMinutes.length > 0
        ? totalCheckInMinutes.reduce((sum, v) => sum + v, 0)
          / totalCheckInMinutes.length
        : null,
    },
    locationTotals,
    dailyTrend: [...dailyTrend.values()],
    integrity: {
      ineligibleRecords: ineligibleCount,
      invalidCorrectionProjections,
      unmatchedRecords: unmatchedRecords.length,
      eligibleRecords: eligible.length,
      totalRecords: attendances.length,
    },
  };
};

/**
 * Besaran remunerasi tiap pegawai dihitung dengan rumus yang berbeda-beda di
 * luar aplikasi, jadi modul ini sengaja tidak mengalikan apa pun dengan tarif.
 * Yang disediakan adalah besaran dasarnya — hari hadir, hari kerja periode,
 * dan jam kerja — untuk dipakai pada perhitungan masing-masing.
 */
export const getRemunerationBasis = (employeeRecap) => {
  if (!employeeRecap) return null;
  return {
    presentDays: employeeRecap.presentDays,
    workingDays: employeeRecap.workingDays,
    elapsedWorkingDays: employeeRecap.elapsedWorkingDays,
    absentDays: employeeRecap.absentDays,
    weekendPresentDays: employeeRecap.weekendPresentDays,
    totalWorkHours: employeeRecap.totalWorkHours,
    attendanceRatio: ratio(
      employeeRecap.presentDays,
      employeeRecap.elapsedWorkingDays
    ),
  };
};
