import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyAttendanceCheckout,
  escapeCsvCell,
  formatAttendanceWibDateTime,
  getAttendanceLocationLabel,
  getCanonicalEarlyLeaveDetails,
  isCrossDayAttendance,
  neutralizeSpreadsheetFormula,
  rowsToCsv,
} from './attendanceDisplay.js';

const timestamp = (iso) => ({
  toDate: () => new Date(iso),
});

test('formats full attendance timestamps in WIB', () => {
  assert.equal(
    formatAttendanceWibDateTime('2026-07-23T17:15:00.000Z'),
    '24 Jul 2026, 00.15 WIB'
  );
});

test('detects checkout on a later WIB date from the shift date', () => {
  assert.equal(
    isCrossDayAttendance({
      date: '2026-07-23',
      checkIn: timestamp('2026-07-23T16:30:00.000Z'),
      checkOut: timestamp('2026-07-23T18:30:00.000Z'),
    }),
    true
  );
  assert.equal(
    isCrossDayAttendance({
      date: '2026-07-24',
      checkIn: timestamp('2026-07-24T01:00:00.000Z'),
      checkOut: timestamp('2026-07-24T09:00:00.000Z'),
    }),
    false
  );
});

test('excludes cross-day checkout from hour-of-day early/overtime metrics', () => {
  const overnight = classifyAttendanceCheckout({
    date: '2026-07-23',
    checkIn: timestamp('2026-07-23T16:30:00.000Z'),
    checkOut: timestamp('2026-07-23T17:30:00.000Z'),
  });
  assert.deepEqual(overnight, {
    crossDay: true,
    earlyLeave: false,
    overtime: false,
  });

  const sameDayEarly = classifyAttendanceCheckout({
    date: '2026-07-24',
    checkOut: timestamp('2026-07-24T08:30:00.000Z'),
  });
  assert.deepEqual(sameDayEarly, {
    crossDay: false,
    earlyLeave: true,
    overtime: false,
  });

  const sameDayOvertime = classifyAttendanceCheckout({
    date: '2026-07-24',
    checkOut: timestamp('2026-07-24T11:30:00.000Z'),
  });
  assert.deepEqual(sameDayOvertime, {
    crossDay: false,
    earlyLeave: false,
    overtime: true,
  });
});

test('uses only the canonical early-leave marker and reason', () => {
  assert.deepEqual(
    getCanonicalEarlyLeaveDetails({
      earlyLeave: true,
      earlyLeaveReason: '  Izin pemeriksaan kesehatan  ',
    }),
    {
      isEarlyLeave: true,
      reason: 'Izin pemeriksaan kesehatan',
    }
  );
  assert.deepEqual(
    getCanonicalEarlyLeaveDetails({
      earlyLeave: 'true',
      earlyLeaveReason: 'Tidak boleh ditampilkan',
    }),
    {
      isEarlyLeave: false,
      reason: '',
    }
  );
  assert.deepEqual(
    getCanonicalEarlyLeaveDetails({
      earlyLeave: false,
      earlyLeaveReason: '=HYPERLINK("https://example.invalid")',
    }),
    {
      isEarlyLeave: false,
      reason: '',
    }
  );
  assert.deepEqual(
    getCanonicalEarlyLeaveDetails({
      earlyLeave: true,
      earlyLeaveReason: 'abc',
    }),
    {
      isEarlyLeave: true,
      reason: '',
    }
  );
  assert.deepEqual(
    getCanonicalEarlyLeaveDetails({
      earlyLeave: true,
      earlyLeaveReason: 'Alasan\u0000rusak',
    }),
    {
      isEarlyLeave: true,
      reason: '',
    }
  );
});

test('escapes RFC CSV characters and neutralizes spreadsheet formulas', () => {
  assert.equal(neutralizeSpreadsheetFormula('=1+1'), "'=1+1");
  assert.equal(neutralizeSpreadsheetFormula('  @SUM(A1:A2)'), "'  @SUM(A1:A2)");
  assert.equal(escapeCsvCell('A, "B"\nC'), '"A, ""B""\nC"');
  assert.equal(
    rowsToCsv([
      ['Name', 'Value'],
      ['Employee', '+cmd'],
    ]),
    '"Name","Value"\r\n"Employee","\'+cmd"'
  );
  assert.equal(
    rowsToCsv([
      ['Early Leave Reason'],
      ['=HYPERLINK("https://example.invalid")'],
    ]),
    '"Early Leave Reason"\r\n"\'=HYPERLINK(""https://example.invalid"")"'
  );
});

test('prefers operational location label and marks temporary venues', () => {
  assert.equal(
    getAttendanceLocationLabel({
      operationalLocationSnapshot: {
        name: 'BimTek The ZHM Premiere Padang',
        source: 'temporary',
      },
      geofenceName: 'Alang Laweh',
      assignmentSnapshot: { name: 'Alang Laweh' },
    }),
    'BimTek The ZHM Premiere Padang (lokasi sementara)'
  );
  assert.equal(
    getAttendanceLocationLabel({
      operationalLocationSnapshot: {
        name: 'Alang Laweh',
        source: 'assignment',
      },
    }),
    'Alang Laweh'
  );
  assert.equal(
    getAttendanceLocationLabel({
      assignmentSnapshot: { name: 'Kantor ISWMP Kota Padang' },
    }),
    'Kantor ISWMP Kota Padang'
  );
});
