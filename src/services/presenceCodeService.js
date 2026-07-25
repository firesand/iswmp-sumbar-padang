import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions } from '../config/firebase';
import { hasAdminAccess } from '../utils/authorization';
import { getCurrentLocation } from '../utils/geolocation';

const GEOFENCE_TYPES = Object.freeze(['kelurahan', 'kantor']);
const MAX_GEOFENCE_RADIUS_METERS = 500;

const getPresenceCodeCallable = httpsCallable(
  functions,
  'getOnsitePresenceCode',
  { limitedUseAppCheckTokens: true }
);

const safeErrorMessages = Object.freeze({
  unauthenticated: 'Sesi admin berakhir. Silakan login kembali.',
  'permission-denied': 'Akun ini tidak diizinkan menampilkan kode onsite.',
  'invalid-argument': 'Pilihan geofence tidak valid.',
  'failed-precondition': 'Geofence belum siap untuk menggunakan kode onsite.',
  'not-found': 'Geofence tidak ditemukan.',
  'resource-exhausted': 'Permintaan terlalu sering. Tunggu sebentar lalu coba kembali.',
  unavailable: 'Layanan kode onsite sedang tidak tersedia. Coba kembali.',
  'deadline-exceeded': 'Permintaan kode onsite melewati batas waktu. Coba kembali.',
  internal: 'Kode onsite gagal dibuat oleh server.',
});

const reasonMessages = Object.freeze({
  APP_CHECK_REQUIRED: 'Verifikasi keamanan aplikasi gagal. Muat ulang aplikasi lalu coba kembali.',
  APP_CHECK_REPLAY: 'Token keamanan sudah digunakan. Muat ulang aplikasi lalu coba kembali.',
  ADMIN_REQUIRED: 'Hanya admin aktif yang dapat menampilkan kode onsite.',
  GEOFENCE_NOT_FOUND: 'Geofence tidak ditemukan.',
  GEOFENCE_INACTIVE: 'Geofence belum aktif dan terverifikasi.',
  GEOFENCE_UNVERIFIED: 'Geofence belum memiliki verifikasi lapangan.',
  GEOFENCE_REVIEW_MISSING: 'Geofence belum direview oleh petugas kedua.',
  GEOFENCE_AUDIT_INVALID: 'Dokumen audit geofence tidak cocok dengan konfigurasi aktif.',
  GEOFENCE_INVALID: 'Koordinat atau radius geofence tidak valid.',
  PRESENCE_PROOF_DISABLED: 'Kode onsite belum diwajibkan untuk geofence ini.',
  PRESENCE_SECRET_DISABLED: 'Kode onsite untuk geofence ini sedang dinonaktifkan.',
  EMPLOYEE_NOT_FOUND: 'Profil karyawan tidak ditemukan.',
  EMPLOYEE_ASSIGNMENT_MISMATCH: 'Karyawan tidak ditugaskan pada lokasi ini.',
  PENDING_CHALLENGE_REQUIRED: 'Minta karyawan memulai proses absensi terlebih dahulu.',
  PENDING_CHALLENGE_INVALID: 'Challenge absensi karyawan tidak lagi valid.',
  PRESENCE_GRANT_CONSUMED: 'Kode untuk challenge ini sudah digunakan.',
  INVALID_LOCATION: 'Lokasi perangkat admin tidak valid. Aktifkan GPS lalu coba kembali.',
  LOCATION_ACCURACY: 'Akurasi GPS admin belum cukup baik. Pindah ke area terbuka lalu coba kembali.',
  LOCATION_STALE: 'Lokasi admin sudah kedaluwarsa. Ambil ulang lokasi lalu coba kembali.',
  INVALID_LOCATION_SOURCE: 'Sumber lokasi perangkat admin tidak dapat diverifikasi.',
  VERIFIER_OUTSIDE_GEOFENCE: 'Perangkat admin harus berada di dalam geofence sebelum kode dapat diterbitkan.',
});

function callableCode(error) {
  return String(error?.code || '').replace(/^functions\//, '');
}

function callableReason(error) {
  const details = error?.details;
  return details && typeof details === 'object' && typeof details.reason === 'string'
    ? details.reason
    : '';
}

function wrapPresenceCodeError(error) {
  const code = callableCode(error);
  const reason = callableReason(error);
  const wrapped = new Error(
    reasonMessages[reason] ||
      safeErrorMessages[code] ||
      'Kode onsite tidak dapat dimuat. Coba kembali.'
  );
  wrapped.name = 'PresenceCodeError';
  wrapped.code = code;
  wrapped.reason = reason;
  wrapped.retryable = new Set([
    'resource-exhausted',
    'unavailable',
    'deadline-exceeded',
    'internal',
  ]).has(code);
  wrapped.cause = error;
  return wrapped;
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  return NaN;
}

function validCoordinates(data) {
  const lat = Number(data.lat);
  const lng = Number(data.lng);
  const radius = Number(data.radius);
  return (
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0) &&
    Number.isFinite(radius) &&
    radius > 0 &&
    radius <= MAX_GEOFENCE_RADIUS_METERS
  );
}

function readiness(data) {
  if (data.isActive !== true) {
    return { eligible: false, reason: 'Nonaktif' };
  }
  if (data.coordinateStatus !== 'verified') {
    return { eligible: false, reason: 'Belum diverifikasi' };
  }
  if (
    !Number.isFinite(timestampMillis(data.verifiedAt)) ||
    timestampMillis(data.verifiedAt) <= 0
  ) {
    return { eligible: false, reason: 'Verifikasi lapangan belum tercatat' };
  }
  if (
    typeof data.verificationReviewedBy !== 'string' ||
    data.verificationReviewedBy.trim().length < 3 ||
    data.verificationReviewedBy.trim().toLocaleLowerCase('id-ID') ===
      String(data.verifiedBy || '').trim().toLocaleLowerCase('id-ID') ||
    !Number.isFinite(timestampMillis(data.verificationReviewedAt)) ||
    timestampMillis(data.verificationReviewedAt) <= 0
  ) {
    return { eligible: false, reason: 'Belum direview petugas kedua' };
  }
  if (
    typeof data.verificationOperator !== 'string' ||
    typeof data.verificationReviewOperator !== 'string' ||
    !/^[0-9a-f]{64}$/.test(data.verificationOperator) ||
    !/^[0-9a-f]{64}$/.test(data.verificationReviewOperator) ||
    data.verificationOperator === data.verificationReviewOperator ||
    typeof data.verificationAuditId !== 'string' ||
    data.verificationAuditId.length === 0
  ) {
    return { eligible: false, reason: 'Review dua akun operator belum lengkap' };
  }
  if (!validCoordinates(data)) {
    return { eligible: false, reason: 'Koordinat atau radius tidak valid' };
  }
  // The backend fails closed unless this policy is set explicitly.
  if (data.presenceProofRequired !== true) {
    return { eligible: false, reason: 'Kode onsite belum diwajibkan' };
  }
  return { eligible: true, reason: 'Siap' };
}

function normalizeGeofence(snapshot, type) {
  const data = snapshot.data();
  const status = readiness(data);
  const name = typeof data.nama === 'string' && data.nama.trim()
    ? data.nama.trim()
    : snapshot.id;

  return {
    key: `${type}/${snapshot.id}`,
    id: snapshot.id,
    type,
    name,
    eligible: status.eligible,
    status: status.reason,
  };
}

async function assertActiveAdmin() {
  const user = auth.currentUser;
  if (!user) {
    throw wrapPresenceCodeError({ code: 'unauthenticated' });
  }

  const profileSnapshot = await getDoc(doc(db, 'users', user.uid));
  if (!profileSnapshot.exists() || !hasAdminAccess(profileSnapshot.data())) {
    throw wrapPresenceCodeError({
      code: 'permission-denied',
      details: { reason: 'ADMIN_REQUIRED' },
    });
  }
}

export async function loadOnsitePresenceGeofences() {
  try {
    await assertActiveAdmin();
    const snapshots = await Promise.all(
      GEOFENCE_TYPES.map((type) => getDocs(collection(db, type)))
    );

    return snapshots
      .flatMap((snapshot, index) =>
        snapshot.docs.map((documentSnapshot) =>
          normalizeGeofence(documentSnapshot, GEOFENCE_TYPES[index])
        )
      )
      .sort((first, second) => {
        if (first.type !== second.type) {
          return first.type.localeCompare(second.type, 'id');
        }
        return first.name.localeCompare(second.name, 'id');
      });
  } catch (error) {
    if (error?.name === 'PresenceCodeError') throw error;
    throw wrapPresenceCodeError(error);
  }
}

function employeeAssignment(data) {
  if (data.assignmentType === 'kelurahan' || data.role === 'field_staff') {
    return typeof data.kelurahanId === 'string' && data.kelurahanId
      ? `kelurahan/${data.kelurahanId}`
      : '';
  }
  if (data.assignmentType === 'kantor' || data.role === 'office_staff') {
    return typeof data.kantorId === 'string' && data.kantorId
      ? `kantor/${data.kantorId}`
      : '';
  }
  return '';
}

export async function loadOnsitePresenceEmployees() {
  try {
    await assertActiveAdmin();
    const snapshot = await getDocs(collection(db, 'users'));
    return snapshot.docs
      .map((documentSnapshot) => ({
        id: documentSnapshot.id,
        ...documentSnapshot.data(),
      }))
      .filter((employee) =>
        employee.accountStatus === 'active' &&
        employee.isActive === true &&
        employee.mustChangePassword !== true &&
        employee.role !== 'admin' &&
        employee.isAdmin !== true &&
        employeeAssignment(employee)
      )
      .map((employee) => ({
        id: employee.id,
        name: employee.name || employee.displayName || employee.email || employee.id,
        email: employee.email || '',
        geofenceKey: employeeAssignment(employee),
      }))
      .sort((first, second) => first.name.localeCompare(second.name, 'id'));
  } catch (error) {
    if (error?.name === 'PresenceCodeError') throw error;
    throw wrapPresenceCodeError(error);
  }
}

function assertGeofenceIdentity(geofenceType, geofenceId) {
  if (
    !GEOFENCE_TYPES.includes(geofenceType) ||
    typeof geofenceId !== 'string' ||
    !/^[A-Za-z0-9:_-]{1,128}$/.test(geofenceId)
  ) {
    throw wrapPresenceCodeError({ code: 'invalid-argument' });
  }
}

export async function requestOnsitePresenceCode(geofenceType, geofenceId, employeeUid) {
  assertGeofenceIdentity(geofenceType, geofenceId);
  if (typeof employeeUid !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(employeeUid)) {
    throw wrapPresenceCodeError({ code: 'invalid-argument' });
  }

  try {
    const location = await getCurrentLocation();
    const response = await getPresenceCodeCallable({
      geofenceType,
      geofenceId,
      employeeUid,
      location,
    });
    const result = response.data;
    const expiresAtMs = Date.parse(result?.expiresAt);
    const periodSeconds = Number(result?.periodSeconds);

    if (
      !result ||
      typeof result.code !== 'string' ||
      !/^\d{6}$/.test(result.code) ||
      !Number.isFinite(expiresAtMs) ||
      !Number.isInteger(periodSeconds) ||
      periodSeconds < 10 ||
      periodSeconds > 300 ||
      typeof result.challengeId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(result.challengeId) ||
      !['checkIn', 'checkOut'].includes(result.action) ||
      result.employee?.uid !== employeeUid ||
      typeof result.employee?.name !== 'string' ||
      result.geofence?.id !== geofenceId ||
      typeof result.geofence?.name !== 'string' ||
      !Number.isFinite(result.verifier?.distanceMeters) ||
      result.verifier.distanceMeters < 0 ||
      !Number.isFinite(result.verifier?.accuracyMeters) ||
      result.verifier.accuracyMeters <= 0 ||
      !Number.isFinite(result.verifier?.uncertaintyAdjustedDistanceMeters) ||
      result.verifier.uncertaintyAdjustedDistanceMeters <
        result.verifier.distanceMeters
    ) {
      throw wrapPresenceCodeError({ code: 'internal' });
    }

    return {
      code: result.code,
      expiresAt: result.expiresAt,
      expiresAtMs,
      periodSeconds,
      challengeId: result.challengeId,
      action: result.action,
      employee: result.employee,
      geofence: {
        id: result.geofence.id,
        name: result.geofence.name,
      },
      verifier: {
        distanceMeters: result.verifier.distanceMeters,
        accuracyMeters: result.verifier.accuracyMeters,
        uncertaintyAdjustedDistanceMeters:
          result.verifier.uncertaintyAdjustedDistanceMeters,
      },
    };
  } catch (error) {
    if (error?.name === 'PresenceCodeError') throw error;
    if (error?.name === 'GeolocationRequiredError') {
      const wrapped = new Error(error.message || 'GPS admin wajib diaktifkan.');
      wrapped.name = 'PresenceCodeError';
      wrapped.code = error.code || 'GPS_REQUIRED';
      wrapped.reason = error.code || 'GPS_REQUIRED';
      wrapped.retryable = false;
      wrapped.cause = error;
      throw wrapped;
    }
    throw wrapPresenceCodeError(error);
  }
}
