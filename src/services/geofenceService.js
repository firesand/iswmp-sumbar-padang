// Multi-geofence service — ISWMP SumBar-Padang
import { doc, getDoc, collection, getDocs, query, orderBy } from 'firebase/firestore';
import { db } from '../config/firebase';
import {
  pickMatchingGeofence,
  validateLocationAgainstGeofence,
} from '../utils/geolocation';

const KANTOR_DEFAULT_ID = 'kantor-padang-kota';

let kelurahanCache = null;
let kelurahanCacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function isGeofenceConfigured(geofence) {
  if (!geofence) return false;
  return (
    geofence.isActive === true &&
    geofence.coordinateStatus === 'verified' &&
    geofence.verifiedAt != null &&
    geofence.verificationReviewedAt != null &&
    typeof geofence.verificationReviewedBy === 'string' &&
    geofence.verificationReviewedBy.trim().length >= 3 &&
    geofence.verificationReviewedBy.trim().toLocaleLowerCase('id-ID') !==
      String(geofence.verifiedBy || '').trim().toLocaleLowerCase('id-ID') &&
    typeof geofence.verificationOperator === 'string' &&
    typeof geofence.verificationReviewOperator === 'string' &&
    /^[0-9a-f]{64}$/.test(geofence.verificationOperator) &&
    /^[0-9a-f]{64}$/.test(geofence.verificationReviewOperator) &&
    geofence.verificationOperator !== geofence.verificationReviewOperator &&
    typeof geofence.verificationAuditId === 'string' &&
    geofence.verificationAuditId.length > 0 &&
    geofence.lat != null &&
    geofence.lng != null &&
    Number.isFinite(Number(geofence.lat)) &&
    Number.isFinite(Number(geofence.lng)) &&
    Number(geofence.lat) >= -90 &&
    Number(geofence.lat) <= 90 &&
    Number(geofence.lng) >= -180 &&
    Number(geofence.lng) <= 180 &&
    Number.isFinite(Number(geofence.radius)) &&
    Number(geofence.radius) > 0
  );
}

export function getGeofenceLabel(geofence) {
  if (!geofence) return 'Lokasi penugasan';
  return geofence.nama || geofence.id || 'Lokasi penugasan';
}

export async function getKelurahanById(kelurahanId) {
  if (!kelurahanId) return null;
  const snap = await getDoc(doc(db, 'kelurahan', kelurahanId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getKantorById(kantorId = KANTOR_DEFAULT_ID) {
  const snap = await getDoc(doc(db, 'kantor', kantorId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getKelurahanList() {
  const now = Date.now();
  if (kelurahanCache && now - kelurahanCacheAt < CACHE_TTL_MS) {
    return kelurahanCache;
  }

  const q = query(collection(db, 'kelurahan'), orderBy('nama'));
  const snapshot = await getDocs(q);
  kelurahanCache = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  kelurahanCacheAt = now;
  return kelurahanCache;
}

export async function resolveUserGeofence(userData) {
  if (!userData || userData.role === 'admin') return null;

  if (userData.role === 'field_staff' || userData.assignmentType === 'kelurahan') {
    return getKelurahanById(userData.kelurahanId);
  }

  if (userData.role === 'office_staff' || userData.assignmentType === 'kantor') {
    return getKantorById(userData.kantorId || KANTOR_DEFAULT_ID);
  }

  // Akun employee lama hanya boleh memakai geofence jika assignment eksplisit
  // tersedia. Tanpa assignment, validator akan fail-closed.
  if (userData.role === 'employee') {
    if (userData.kelurahanId) return getKelurahanById(userData.kelurahanId);
    if (userData.kantorId) return getKantorById(userData.kantorId);
  }

  return null;
}

/**
 * Ordered list of geofences a user may check in/out at, tagged with which
 * collection each came from. Field staff normally attend their kelurahan,
 * but may also attend the project kantor in person, so it is appended as a
 * second candidate. Office staff are unaffected — their only candidate
 * remains their own kantor. Mirrors functions/attendance-core.js's
 * resolveAssignmentCandidates.
 */
export async function resolveUserGeofenceCandidates(userData) {
  if (!userData || userData.role === 'admin') return [];

  if (userData.role === 'field_staff' || userData.assignmentType === 'kelurahan') {
    const [kelurahan, kantor] = await Promise.all([
      getKelurahanById(userData.kelurahanId),
      getKantorById(KANTOR_DEFAULT_ID),
    ]);
    return [
      kelurahan ? { ...kelurahan, collection: 'kelurahan' } : null,
      kantor ? { ...kantor, collection: 'kantor' } : null,
    ].filter(Boolean);
  }

  if (userData.role === 'office_staff' || userData.assignmentType === 'kantor') {
    const kantor = await getKantorById(userData.kantorId || KANTOR_DEFAULT_ID);
    return kantor ? [{ ...kantor, collection: 'kantor' }] : [];
  }

  if (userData.role === 'employee') {
    const geofence = await resolveUserGeofence(userData);
    if (!geofence) return [];
    return [{ ...geofence, collection: userData.kelurahanId ? 'kelurahan' : 'kantor' }];
  }

  return [];
}

/**
 * Best-effort pick of which candidate geofence ('kelurahan' | 'kantor') a
 * check-in/out request should target, based on the current GPS fix. Returns
 * null whenever there is nothing to choose (a single candidate) or the
 * position isn't clearly inside one of them — the backend then falls back to
 * the user's primary assignment and reports the usual out-of-range error.
 */
export async function resolveAssignmentChoiceForLocation(userData, location) {
  try {
    const candidates = (await resolveUserGeofenceCandidates(userData))
      .filter(isGeofenceConfigured);
    if (candidates.length <= 1) return null;
    const match = pickMatchingGeofence(candidates, location);
    return match?.withinRadius ? match.geofence.collection : null;
  } catch {
    return null;
  }
}

export async function validateLocationForUser(userData) {
  try {
    const geofence = await resolveUserGeofence(userData);
    if (!isGeofenceConfigured(geofence)) {
      return {
        isValid: false,
        transitionMode: false,
        message: geofence
          ? `Geofence ${getGeofenceLabel(geofence)} belum aktif dan terverifikasi. Hubungi admin.`
          : 'Lokasi penugasan belum ditetapkan. Hubungi admin sebelum melakukan absensi.',
        code: geofence ? 'GEOFENCE_UNVERIFIED' : 'GEOFENCE_UNASSIGNED',
        geofence: geofence || null,
        location: null,
      };
    }
    return validateLocationAgainstGeofence(geofence);
  } catch (error) {
    return {
      isValid: false,
      transitionMode: false,
      message: 'Konfigurasi lokasi penugasan tidak dapat diverifikasi. Absensi ditolak; hubungi admin.',
      code: 'GEOFENCE_LOOKUP_FAILED',
      error: error?.message,
      geofence: null,
      location: null,
    };
  }
}

export const OFFICE_STAFF_ROLES = [
  { value: 'KORKOT', label: 'Koordinator Kota (KorKot)' },
  { value: 'ASMAN_DATA', label: 'Asisten Manajemen Data' },
  { value: 'OPERATOR', label: 'Operator' },
  { value: 'OFFICE_BOY', label: 'Office Boy' },
];

export const FIELD_STAFF_TYPES = [
  { value: 'TA_PERSAMP', label: 'Tenaga Pendamping Persampahan' },
  { value: 'TA_KELEMBAGAAN', label: 'Tenaga Ahli Kelembagaan' },
];
