import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTRACT } from '../config/projectConfig.js';
import {
  addDays,
  addMonths,
  countDaysInclusive,
  countWorkingDays,
  findContractPeriodByDate,
  formatDateKeyId,
  getActiveContractPeriod,
  getContractEndDate,
  getContractPeriodByIndex,
  getContractPeriods,
  getDateKeysInRange,
  isValidDateKey,
  isWeekend,
} from './contractPeriods.js';

test('contract config anchors on the SPK start date for 300 days', () => {
  assert.equal(CONTRACT.startDate, '2026-07-13');
  assert.equal(CONTRACT.durationDays, 300);
});

test('contract ends on day 300 counted inclusively from the start date', () => {
  assert.equal(getContractEndDate(), '2027-05-08');
  assert.equal(
    countDaysInclusive(CONTRACT.startDate, getContractEndDate()),
    300
  );
});

test('date arithmetic stays on calendar days regardless of host timezone', () => {
  assert.equal(addDays('2026-07-13', 1), '2026-07-14');
  assert.equal(addDays('2026-07-13', -1), '2026-07-12');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addMonths('2026-07-13', 1), '2026-08-13');
  assert.equal(addMonths('2026-12-13', 1), '2027-01-13');
  assert.equal(addMonths('2027-01-13', -1), '2026-12-13');
  assert.equal(countDaysInclusive('2026-07-13', '2026-07-13'), 1);
  assert.equal(countDaysInclusive('2026-07-14', '2026-07-13'), 0);
});

test('month anchoring clamps to short months without leaving gaps', () => {
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  const periods = getContractPeriods({
    startDate: '2027-01-31',
    durationDays: 90,
  });
  assert.equal(periods[0].endDate, '2027-02-27');
  assert.equal(periods[1].startDate, '2027-02-28');
});

test('periods run from the 13th to the 12th of the next month', () => {
  const periods = getContractPeriods();
  assert.equal(periods.length, 10);
  assert.deepEqual(
    periods.map((period) => [period.startDate, period.endDate]),
    [
      ['2026-07-13', '2026-08-12'],
      ['2026-08-13', '2026-09-12'],
      ['2026-09-13', '2026-10-12'],
      ['2026-10-13', '2026-11-12'],
      ['2026-11-13', '2026-12-12'],
      ['2026-12-13', '2027-01-12'],
      ['2027-01-13', '2027-02-12'],
      ['2027-02-13', '2027-03-12'],
      ['2027-03-13', '2027-04-12'],
      ['2027-04-13', '2027-05-08'],
    ]
  );
});

test('periods tile the contract with no gaps or overlaps', () => {
  const periods = getContractPeriods();
  periods.forEach((period, position) => {
    if (position === 0) return;
    assert.equal(period.startDate, addDays(periods[position - 1].endDate, 1));
  });
  const totalDays = periods.reduce((sum, period) => sum + period.totalDays, 0);
  assert.equal(totalDays, CONTRACT.durationDays);
});

test('the final period is truncated at the contract end date', () => {
  const periods = getContractPeriods();
  const last = periods[periods.length - 1];
  assert.equal(last.index, 10);
  assert.equal(last.endDate, '2027-05-08');
  assert.equal(last.totalDays, 26);
  assert.equal(last.isFinal, true);
  assert.equal(last.isPartial, true);
  assert.equal(last.contractDayStart, 275);
  assert.equal(last.contractDayEnd, 300);

  const first = periods[0];
  assert.equal(first.isPartial, false);
  assert.equal(first.contractDayStart, 1);
  assert.equal(first.contractDayEnd, 31);
});

test('periods carry Indonesian labels for the report UI', () => {
  const [first] = getContractPeriods();
  assert.equal(formatDateKeyId('2026-07-13'), '13 Jul 2026');
  assert.equal(first.shortLabel, 'Periode 1');
  assert.equal(first.rangeLabel, '13 Jul 2026 – 12 Agu 2026');
  assert.equal(first.label, 'Periode 1: 13 Jul 2026 – 12 Agu 2026');
});

test('a date resolves to the period that contains it', () => {
  assert.equal(findContractPeriodByDate('2026-07-13').index, 1);
  assert.equal(findContractPeriodByDate('2026-08-12').index, 1);
  assert.equal(findContractPeriodByDate('2026-08-13').index, 2);
  assert.equal(findContractPeriodByDate('2027-05-08').index, 10);
  assert.equal(findContractPeriodByDate('2026-07-12'), null);
  assert.equal(findContractPeriodByDate('2027-05-09'), null);
  assert.equal(findContractPeriodByDate('bukan-tanggal'), null);
  assert.equal(getContractPeriodByIndex(3).startDate, '2026-09-13');
  assert.equal(getContractPeriodByIndex(99), null);
});

test('the active period clamps to the contract on either side', () => {
  assert.equal(getActiveContractPeriod(CONTRACT, '2026-09-20').index, 3);
  assert.equal(getActiveContractPeriod(CONTRACT, '2026-01-01').index, 1);
  assert.equal(getActiveContractPeriod(CONTRACT, '2030-01-01').index, 10);
});

test('working-day counting excludes weekends inside a period', () => {
  const [first] = getContractPeriods();
  assert.equal(getDateKeysInRange(first.startDate, first.endDate).length, 31);
  assert.equal(isWeekend('2026-07-18'), true); // Sabtu
  assert.equal(isWeekend('2026-07-19'), true); // Minggu
  assert.equal(isWeekend('2026-07-13'), false); // Senin
  assert.equal(countWorkingDays('2026-07-13', '2026-08-12'), 23);
  assert.equal(countWorkingDays('2026-07-13', '2026-07-13'), 1);
  assert.equal(countWorkingDays('2026-07-18', '2026-07-19'), 0);
});

test('invalid contract input yields no periods instead of throwing', () => {
  assert.deepEqual(getContractPeriods({ startDate: 'x', durationDays: 30 }), []);
  assert.deepEqual(getContractPeriods({ startDate: '2026-07-13', durationDays: 0 }), []);
  assert.equal(getContractEndDate({ startDate: '2026-02-31', durationDays: 30 }), null);
  assert.equal(isValidDateKey('2026-02-31'), false);
  assert.equal(isValidDateKey('2026-07-13'), true);
});
