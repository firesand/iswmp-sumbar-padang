import { 
  collection, 
  doc,
  getDoc,
  getDocs, 
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp
} from 'firebase/firestore';
import { db } from './firebase';
import {
  getWibDateDaysAgo,
  getWibDateString,
} from '../utils/attendanceTime';
import { isVerifiedAttendance } from '../utils/attendanceIntegrity';
import {
  attendanceShiftDurationMs,
  resolveEmployeeAttendanceState,
} from '../utils/employeeAttendanceState';
import { attachEffectiveAttendanceCorrection } from '../utils/attendanceCorrection';

export {
  attendanceShiftDurationMs,
  formatAttendanceShiftDuration,
  resolveEmployeeAttendanceState,
} from '../utils/employeeAttendanceState';

export const getEmployeeAttendanceState = async (
  userId,
  now = new Date()
) => {
  try {
    if (typeof userId !== 'string' || !userId) {
      throw new Error('User ID wajib tersedia untuk memuat absensi.');
    }
    const today = getWibDateString(now);
    const previousDate = getWibDateDaysAgo(1, now);
    const q = query(
      collection(db, 'attendances'),
      where('userId', '==', userId),
      where('date', '>=', previousDate),
      where('date', '<=', today),
      orderBy('date', 'desc')
    );
    const [snapshot, configSnapshot] = await Promise.all([
      getDocs(q),
      getDoc(doc(db, 'projectConfig', 'default')),
    ]);
    const projectConfig = configSnapshot.exists()
      ? configSnapshot.data()
      : null;
    const maximumShiftDurationMinutes =
      projectConfig?.maxAttendanceShiftDurationMinutes ?? null;
    const maximumShiftDurationMs = attendanceShiftDurationMs(
      maximumShiftDurationMinutes
    );
    if (maximumShiftDurationMs == null) {
      throw new Error(
        'Kebijakan batas durasi shift belum tersedia atau tidak valid.'
      );
    }
    const canonicalRecords = snapshot.docs.map((attendanceDoc) => ({
      id: attendanceDoc.id,
      ...attendanceDoc.data(),
    }));
    const projectionSnapshots = await Promise.all(
      canonicalRecords.map((record) =>
        getDoc(doc(db, 'attendanceCorrectionEffectiveViews', record.id))
      )
    );
    const records = canonicalRecords.map((record, index) =>
      attachEffectiveAttendanceCorrection(
        record,
        projectionSnapshots[index].exists()
          ? projectionSnapshots[index].data()
          : null
      )
    );
    return {
      ...resolveEmployeeAttendanceState(
        records,
        now,
        userId,
        maximumShiftDurationMs
      ),
      maximumShiftDurationMinutes,
      maximumShiftDurationMs,
      attendanceVerificationMode:
        projectConfig?.attendanceVerificationMode || 'geofence_onsite',
      locationPhotoModeExpiresAt:
        projectConfig?.locationPhotoModeExpiresAt || null,
      loadError: null,
    };
  } catch (error) {
    console.error('Get employee attendance state error:', error);
    return {
      ...resolveEmployeeAttendanceState([], now, userId, 0),
      maximumShiftDurationMinutes: null,
      maximumShiftDurationMs: null,
      attendanceVerificationMode: null,
      locationPhotoModeExpiresAt: null,
      loadError:
        'Status shift tidak dapat dimuat. Muat ulang halaman sebelum melakukan absensi.',
    };
  }
};

// Attendance functions
export const addAttendance = async (attendanceData) => {
  console.error('Direct attendance write blocked', attendanceData?.date);
  return {
    success: false,
    message:
      'Alur absensi lama dinonaktifkan. Gunakan challenge dan callable backend.',
  };
};

export const getTodayAttendance = async (userId) => {
  const attendanceState = await getEmployeeAttendanceState(userId);
  return attendanceState.todayAttendance;
};

export const getAttendanceHistory = async (userId, limitCount = 30) => {
  try {
    const q = query(
      collection(db, 'attendances'),
      where('userId', '==', userId),
      orderBy('date', 'desc'),
      limit(limitCount)
    );
    
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Get attendance history error:', error);
    return [];
  }
};

// User management functions
export const getPendingRegistrations = async () => {
  try {
    const q = query(
      collection(db, 'registrationRequests'),
      where('status', '==', 'pending'),
      orderBy('requestedAt', 'desc')
    );
    
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Get pending registrations error:', error);
    return [];
  }
};

export const approveRegistration = async (requestId, userId) => {
  try {
    // Update registration request
    await updateDoc(doc(db, 'registrationRequests', requestId), {
      status: 'approved',
      reviewedBy: userId,
      reviewedAt: serverTimestamp()
    });
    
    // Activate user account
    await updateDoc(doc(db, 'users', requestId), {
      accountStatus: 'active',
      isActive: true,
      activatedAt: serverTimestamp(),
      activatedBy: userId
    });
    
    return { success: true };
  } catch (error) {
    console.error('Approve registration error:', error);
    return { success: false, message: error.message };
  }
};

export const rejectRegistration = async (requestId, userId, reason) => {
  try {
    await updateDoc(doc(db, 'registrationRequests', requestId), {
      status: 'rejected',
      reviewedBy: userId,
      reviewedAt: serverTimestamp(),
      rejectionReason: reason
    });
    
    return { success: true };
  } catch (error) {
    console.error('Reject registration error:', error);
    return { success: false, message: error.message };
  }
};

export const deactivateEmployee = async (employeeId, adminId, reason) => {
  try {
    await updateDoc(doc(db, 'users', employeeId), {
      accountStatus: 'resigned',
      isActive: false,
      deactivatedAt: serverTimestamp(),
      deactivatedBy: adminId,
      deactivationReason: reason
    });
    
    return { success: true };
  } catch (error) {
    console.error('Deactivate employee error:', error);
    return { success: false, message: error.message };
  }
};

export const getActiveEmployees = async () => {
  try {
    const q = query(
      collection(db, 'users'),
      where('isActive', '==', true),
      where('role', '==', 'employee')
    );
    
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Get active employees error:', error);
    return [];
  }
};

// Analytics functions
export const getAttendanceStats = async (date) => {
  try {
    const q = query(
      collection(db, 'attendances'),
      where('date', '==', date)
    );
    
    const snapshot = await getDocs(q);
    const attendances = snapshot.docs
      .map(doc => doc.data())
      .filter(isVerifiedAttendance);
    
    const stats = {
      total: attendances.length,
      present: attendances.filter(a => a.checkIn).length,
      absent: 0, // Calculate based on active employees
      late: attendances.filter(a => a.status === 'late').length,
      ontime: attendances.filter(a => a.status === 'ontime').length
    };
    
    return stats;
  } catch (error) {
    console.error('Get attendance stats error:', error);
    return { total: 0, present: 0, absent: 0, late: 0, ontime: 0 };
  }
};

export const getWeeklyAttendance = async (startDate, endDate) => {
  try {
    const q = query(
      collection(db, 'attendances'),
      where('date', '>=', startDate),
      where('date', '<=', endDate),
      orderBy('date', 'asc')
    );
    
    const snapshot = await getDocs(q);
    return snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(isVerifiedAttendance);
  } catch (error) {
    console.error('Get weekly attendance error:', error);
    return [];
  }
};
