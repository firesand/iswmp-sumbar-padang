// Multi-geofence service — ISWMP SumBar-Padang
import { doc, getDoc, collection, getDocs, query, orderBy } from 'firebase/firestore';
import { db } from '../config/firebase';
import { validateLocationAgainstGeofence } from '../utils/geolocation';

const KANTOR_DEFAULT_ID = 'kantor-padang-kota';

let kelurahanCache = null;
let kelurahanCacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function isGeofenceConfigured(geofence) {
  if (!geofence) return false;
  return (
    geofence.isActive === true &&
    geofence.lat != null &&
    geofence.lng != null &&
    Number.isFinite(Number(geofence.lat)) &&
    Number.isFinite(Number(geofence.lng))
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

  // Legacy parent role
  if (userData.role === 'employee') return null;

  return null;
}

export async function validateLocationForUser(userData) {
  const geofence = await resolveUserGeofence(userData);
  return validateLocationAgainstGeofence(geofence);
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
