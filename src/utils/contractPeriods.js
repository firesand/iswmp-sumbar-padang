// Periode laporan mengikuti kontrak/SPK — ISWMP SumBar-Padang
//
// Laporan bulanan proyek ini tidak memakai bulan kalender (1 s/d akhir bulan),
// melainkan anchor tanggal mulai kontrak. Untuk SPK yang mulai 13 Juli 2026
// selama 300 hari, periode berjalan 13 Jul–12 Agu, 13 Agu–12 Sep, dan
// seterusnya, dengan periode terakhir dipotong tepat di hari ke-300.
//
// Semua tanggal di modul ini berupa string "YYYY-MM-DD" WIB — format yang sama
// dengan field `date` pada dokumen attendances — dan aritmetikanya memakai UTC
// murni supaya zona waktu perangkat tidak pernah menggeser batas periode.

import { CONTRACT } from '../config/projectConfig.js';
import { getWibDateString } from './attendanceTime.js';

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MONTH_ABBREVIATIONS_ID = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
];

const MONTH_NAMES_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const MS_PER_DAY = 86400000;

const isDateKey = (value) =>
  typeof value === 'string' && DATE_KEY_PATTERN.test(value);

const toUtcTime = (dateKey) => {
  if (!isDateKey(dateKey)) return NaN;
  const [year, month, day] = dateKey.split('-').map(Number);
  const time = Date.UTC(year, month - 1, day);
  // Tolak tanggal yang overflow (mis. "2026-02-31" jadi 3 Maret).
  return new Date(time).getUTCDate() === day ? time : NaN;
};

const fromUtcTime = (time) => new Date(time).toISOString().slice(0, 10);

const daysInMonth = (year, monthIndex) =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

export const isValidDateKey = (dateKey) => Number.isFinite(toUtcTime(dateKey));

/** Geser tanggal sejumlah hari kalender. */
export const addDays = (dateKey, days) => {
  const time = toUtcTime(dateKey);
  const shift = Number(days);
  if (!Number.isFinite(time) || !Number.isFinite(shift)) return null;
  return fromUtcTime(time + Math.trunc(shift) * MS_PER_DAY);
};

/**
 * Geser tanggal sejumlah bulan dengan mempertahankan tanggal anchor. Kalau
 * bulan tujuan lebih pendek dari tanggal anchor (mis. anchor 31 ke Februari),
 * tanggal dipotong ke hari terakhir bulan itu sehingga periode tetap kontinu.
 */
export const addMonths = (dateKey, months) => {
  const time = toUtcTime(dateKey);
  const shift = Number(months);
  if (!Number.isFinite(time) || !Number.isFinite(shift)) return null;

  const anchor = new Date(time);
  const day = anchor.getUTCDate();
  const targetMonth = anchor.getUTCMonth() + Math.trunc(shift);
  const targetYear = anchor.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;

  return fromUtcTime(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(day, daysInMonth(targetYear, normalizedMonth))
  ));
};

/** Selisih hari inklusif: start dan end sama menghasilkan 1. */
export const countDaysInclusive = (startDateKey, endDateKey) => {
  const start = toUtcTime(startDateKey);
  const end = toUtcTime(endDateKey);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / MS_PER_DAY) + 1;
};

/** Semua tanggal dari start sampai end, inklusif. */
export const getDateKeysInRange = (startDateKey, endDateKey) => {
  const total = countDaysInclusive(startDateKey, endDateKey);
  const keys = [];
  for (let offset = 0; offset < total; offset += 1) {
    keys.push(addDays(startDateKey, offset));
  }
  return keys;
};

/** 0 = Minggu … 6 = Sabtu, dihitung dari tanggal kalender, bukan zona lokal. */
export const getWeekdayIndex = (dateKey) => {
  const time = toUtcTime(dateKey);
  return Number.isFinite(time) ? new Date(time).getUTCDay() : null;
};

export const isWeekend = (dateKey) => {
  const weekday = getWeekdayIndex(dateKey);
  return weekday === 0 || weekday === 6;
};

/** "13 Jul 2026" */
export const formatDateKeyId = (dateKey) => {
  if (!isValidDateKey(dateKey)) return '-';
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${day} ${MONTH_ABBREVIATIONS_ID[month - 1]} ${year}`;
};

/** "Juli 2026" */
export const formatMonthKeyId = (dateKey) => {
  if (!isValidDateKey(dateKey)) return '-';
  const [year, month] = dateKey.split('-').map(Number);
  return `${MONTH_NAMES_ID[month - 1]} ${year}`;
};

const normalizeContract = (contract = CONTRACT) => {
  const startDate = contract?.startDate;
  const durationDays = Math.trunc(Number(contract?.durationDays));
  if (!isValidDateKey(startDate) || !Number.isFinite(durationDays) || durationDays < 1) {
    return null;
  }
  return { startDate, durationDays };
};

/** Tanggal terakhir kontrak, inklusif (hari ke-durationDays). */
export const getContractEndDate = (contract = CONTRACT) => {
  const normalized = normalizeContract(contract);
  if (!normalized) return null;
  return addDays(normalized.startDate, normalized.durationDays - 1);
};

/**
 * Daftar periode laporan sepanjang kontrak. Periode terakhir bisa lebih pendek
 * dari sebulan penuh karena dipotong di tanggal berakhirnya kontrak.
 */
export const getContractPeriods = (contract = CONTRACT) => {
  const normalized = normalizeContract(contract);
  if (!normalized) return [];

  const contractEndDate = addDays(
    normalized.startDate,
    normalized.durationDays - 1
  );

  const periods = [];
  let index = 0;
  let startDate = normalized.startDate;

  while (startDate <= contractEndDate) {
    index += 1;
    const naturalEndDate = addDays(addMonths(normalized.startDate, index), -1);
    const endDate = naturalEndDate > contractEndDate
      ? contractEndDate
      : naturalEndDate;

    periods.push({
      index,
      startDate,
      endDate,
      totalDays: countDaysInclusive(startDate, endDate),
      /** Hari kontrak ke-berapa periode ini mulai & selesai. */
      contractDayStart: countDaysInclusive(normalized.startDate, startDate),
      contractDayEnd: countDaysInclusive(normalized.startDate, endDate),
      isFinal: endDate === contractEndDate,
      isPartial: endDate !== naturalEndDate,
      rangeLabel: `${formatDateKeyId(startDate)} – ${formatDateKeyId(endDate)}`,
      shortLabel: `Periode ${index}`,
      label: `Periode ${index}: ${formatDateKeyId(startDate)} – ${formatDateKeyId(endDate)}`,
    });

    startDate = addDays(endDate, 1);
  }

  return periods;
};

/** Periode yang memuat tanggal tertentu, atau null di luar masa kontrak. */
export const findContractPeriodByDate = (dateKey, contract = CONTRACT) => {
  if (!isValidDateKey(dateKey)) return null;
  return getContractPeriods(contract).find(
    (period) => dateKey >= period.startDate && dateKey <= period.endDate
  ) || null;
};

export const getContractPeriodByIndex = (index, contract = CONTRACT) =>
  getContractPeriods(contract).find(
    (period) => period.index === Number(index)
  ) || null;

/**
 * Periode default untuk UI: periode berjalan kalau hari ini di dalam kontrak,
 * periode pertama kalau kontrak belum mulai, periode terakhir kalau sudah usai.
 */
export const getActiveContractPeriod = (
  contract = CONTRACT,
  todayDateKey = getWibDateString()
) => {
  const periods = getContractPeriods(contract);
  if (periods.length === 0) return null;

  const current = periods.find(
    (period) => todayDateKey >= period.startDate && todayDateKey <= period.endDate
  );
  if (current) return current;
  return todayDateKey < periods[0].startDate
    ? periods[0]
    : periods[periods.length - 1];
};

/** Jumlah hari kerja (Senin–Jumat) dalam satu rentang. */
export const countWorkingDays = (startDateKey, endDateKey) =>
  getDateKeysInRange(startDateKey, endDateKey).filter(
    (dateKey) => !isWeekend(dateKey)
  ).length;
