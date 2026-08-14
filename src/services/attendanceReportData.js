// Pengambilan data laporan & rekap kehadiran — ISWMP SumBar-Padang
//
// Dipakai bersama oleh laporan detail dan rekap periode supaya keduanya
// membaca populasi pegawai dan rentang tanggal dengan aturan yang sama persis;
// perbedaan angka antara dua layar itu selalu jadi temuan yang mahal.

import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
} from 'firebase/firestore';

import { db } from '../config/firebase.js';
import { attachEffectiveAttendanceCorrection } from '../utils/attendanceCorrection.js';

const NON_EMPLOYEE_ROLES = new Set([
  'admin',
  'admin_viewer',
  'viewer',
  'monitor',
]);

const normalizedRole = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

/** Akun admin/pemantau tidak pernah menjadi populasi laporan pegawai. */
export const isReportEmployeeProfile = (employee) => Boolean(
  employee
  && !NON_EMPLOYEE_ROLES.has(normalizedRole(employee.role))
  && !NON_EMPLOYEE_ROLES.has(normalizedRole(employee.adminRole))
  && employee.isAdmin !== true
  && employee.isViewer !== true
);

/**
 * Tambahkan profil nonaktif hanya bila UID-nya memiliki record pada rentang
 * historis yang sedang dibuka. Dengan begitu pegawai resign/arsip tetap muncul,
 * tanpa memasukkan seluruh akun nonaktif sebagai absen pada setiap periode.
 */
export const mergeHistoricalReportEmployees = (
  currentEmployees = [],
  attendances = [],
  historicalProfiles = []
) => {
  const representedIds = new Set(
    attendances
      .map((record) => record?.userId)
      .filter((userId) => typeof userId === 'string' && userId.length > 0)
  );
  const reportEmployees = currentEmployees.filter(isReportEmployeeProfile);
  const existingIds = new Set(
    reportEmployees
      .map((employee) => employee?.id)
      .filter(Boolean)
  );
  const additions = [];
  historicalProfiles.forEach((employee) => {
    if (!employee?.id
        || !representedIds.has(employee.id)
        || existingIds.has(employee.id)
        || !isReportEmployeeProfile(employee)) {
      return;
    }
    additions.push(employee);
    existingIds.add(employee.id);
  });

  return [...reportEmployees, ...additions];
};

/** Pegawai aktif operasional; akun admin dan monitor selalu dikecualikan. */
export const fetchActiveEmployees = async () => {
  const snapshot = await getDocs(collection(db, 'users'));
  return snapshot.docs
    .map((employeeDoc) => ({ id: employeeDoc.id, ...employeeDoc.data() }))
    .filter((employee) => (
      isReportEmployeeProfile(employee)
      && employee.accountStatus === 'active'
      && employee.isActive === true
    ));
};

/**
 * Lampirkan projection koreksi administratif ke tiap record. Projection dibaca
 * per dokumen karena koleksinya dikunci per attendanceId oleh security rules.
 */
export const attachCorrectionViews = async (records) => {
  const projectionSnapshots = await Promise.all(
    records.map((record) => getDoc(doc(
      db,
      'attendanceCorrectionEffectiveViews',
      record.id
    )))
  );
  return records.map((record, index) => attachEffectiveAttendanceCorrection(
    record,
    projectionSnapshots[index].exists()
      ? projectionSnapshots[index].data()
      : null
  ));
};

/**
 * Record absensi pada rentang tanggal WIB "YYYY-MM-DD", sudah dilampiri nama
 * pegawai dan projection koreksi.
 */
export const fetchAttendancesInRange = async (
  startDateKey,
  endDateKey,
  employees = []
) => {
  const attendanceQuery = query(
    collection(db, 'attendances'),
    where('date', '>=', startDateKey),
    where('date', '<=', endDateKey),
    orderBy('date', 'asc')
  );

  const snapshot = await getDocs(attendanceQuery);
  const attendanceRecords = snapshot.docs.map((attendanceDoc) => ({
    id: attendanceDoc.id,
    ...attendanceDoc.data(),
  }));
  const currentEmployeeIds = new Set(
    employees.map((employee) => employee?.id).filter(Boolean)
  );
  const historicalEmployeeIds = [...new Set(
    attendanceRecords
      .map((record) => record.userId)
      .filter((userId) => (
        typeof userId === 'string'
        && userId.length > 0
        && !currentEmployeeIds.has(userId)
      ))
  )];
  const historicalProfiles = (await Promise.all(
    historicalEmployeeIds.map(async (userId) => {
      const employeeSnapshot = await getDoc(doc(db, 'users', userId));
      return employeeSnapshot.exists()
        ? { id: employeeSnapshot.id, ...employeeSnapshot.data() }
        : null;
    })
  )).filter(Boolean);
  const reportEmployees = mergeHistoricalReportEmployees(
    employees,
    attendanceRecords,
    historicalProfiles
  );

  // Semua pemanggil meneruskan array ini ke pembangun rekap setelah fungsi
  // selesai. Pertahankan referensinya sambil menambahkan profil historis.
  employees.splice(0, employees.length, ...reportEmployees);
  const employeeById = new Map(
    reportEmployees.map((employee) => [employee.id, employee])
  );
  const records = attendanceRecords.map((record) => {
    return {
      ...record,
      userName: record.userName
        || employeeById.get(record.userId)?.name
        || 'Unknown Employee',
    };
  });

  return attachCorrectionViews(records);
};
