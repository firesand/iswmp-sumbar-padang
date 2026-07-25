#!/usr/bin/env node

/**
 * Write or clear temporary operational attendance locations on
 * projectConfig/default for location_photo mode.
 *
 * Read-only by default. Add --apply after reviewing the proposed state.
 * The write is protected by the Firestore document updateTime so a concurrent
 * project-config edit cannot be overwritten silently.
 */

import crypto from 'node:crypto';
import authModule from 'firebase-tools/lib/auth.js';
import { TEMPORARY_ATTENDANCE_LOCATIONS } from '../src/data/temporaryAttendanceLocations.js';

const PROJECT_ID = 'iswmp-sumbar-padang';
const CONFIG_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
  'databases/(default)/documents/projectConfig/default';
const APPLY = process.argv.includes('--apply');
const CLEAR = process.argv.includes('--clear');
const MAX_OPERATIONAL_LOCATIONS = 8;
const MIN_RADIUS = 50;
const MAX_RADIUS = 500;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const account = authModule.getGlobalDefaultAccount();
if (!account?.tokens?.refresh_token) {
  throw new Error('Firebase CLI belum login. Jalankan: npx firebase login');
}
authModule.setRefreshToken(account.tokens.refresh_token);
const tokenResult = await authModule.getAccessToken(
  account.tokens.refresh_token,
  []
);
const accessToken = tokenResult?.access_token;
if (!accessToken) {
  throw new Error('Tidak dapat memperoleh access token Firebase CLI.');
}

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `${response.status} ${url}`);
  }
  return body;
};

const decodeValue = value => {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(decodeValue);
  }
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(
        ([key, nested]) => [key, decodeValue(nested)]
      )
    );
  }
  return undefined;
};

const encodeValue = value => {
  if (value === null) return { nullValue: null };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { doubleValue: value };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(encodeValue),
      },
    };
  }
  if (value && typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, nested]) => [
            key,
            encodeValue(nested),
          ])
        ),
      },
    };
  }
  throw new Error(`Tipe nilai config tidak didukung: ${typeof value}`);
};

const normalizeEntry = entry => {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Entri lokasi operasional tidak valid.');
  }
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const nama = typeof entry.nama === 'string' ? entry.nama.trim() : '';
  const lat = Number(entry.lat);
  const lng = Number(entry.lng);
  const radius = Number(entry.radius);
  const validFromMs = Date.parse(entry.validFrom);
  const validUntilMs = Date.parse(entry.validUntil);
  if (!id || !/^[A-Za-z0-9:_-]{1,120}$/.test(id) ||
      !nama || nama.length > 200 ||
      !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lng) || lng < -180 || lng > 180 ||
      (lat === 0 && lng === 0) ||
      !Number.isFinite(radius) ||
      radius < MIN_RADIUS || radius > MAX_RADIUS ||
      !Number.isFinite(validFromMs) || !Number.isFinite(validUntilMs) ||
      validUntilMs <= validFromMs ||
      validUntilMs - validFromMs > MAX_WINDOW_MS) {
    throw new Error(`Entri lokasi operasional tidak valid: ${id || '(tanpa id)'}`);
  }
  return {
    id,
    nama,
    lat,
    lng,
    radius,
    validFrom: new Date(validFromMs).toISOString(),
    validUntil: new Date(validUntilMs).toISOString(),
  };
};

const digestLocations = locations => crypto.createHash('sha256')
  .update(JSON.stringify(locations))
  .digest('hex');

const currentDocument = await api(CONFIG_URL);
if (!currentDocument.updateTime) {
  throw new Error('projectConfig/default tidak memiliki updateTime.');
}
const current = Object.fromEntries(
  Object.entries(currentDocument.fields || {}).map(
    ([key, value]) => [key, decodeValue(value)]
  )
);
if (
  current.attendanceSecurityVersion !== 2 ||
  current.geofenceTransitionMode !== false
) {
  throw new Error(
    'Kebijakan absensi v2 canonical belum aktif; lokasi tidak diubah.'
  );
}

const now = new Date();
const currentVersion = Number.isInteger(current.locationPhotoAllowedLocationsVersion)
  ? current.locationPhotoAllowedLocationsVersion
  : 0;
let normalizedLocations = [];
if (!CLEAR) {
  if (TEMPORARY_ATTENDANCE_LOCATIONS.length > MAX_OPERATIONAL_LOCATIONS) {
    throw new Error('Daftar lokasi operasional melebihi batas aman.');
  }
  const seen = new Set();
  normalizedLocations = TEMPORARY_ATTENDANCE_LOCATIONS
    .map(normalizeEntry)
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const entry of normalizedLocations) {
    if (seen.has(entry.id)) {
      throw new Error(`ID lokasi operasional duplikat: ${entry.id}`);
    }
    seen.add(entry.id);
  }
}

const proposed = {
  locationPhotoAllowedLocations: normalizedLocations,
  locationPhotoAllowedLocationsVersion: currentVersion + 1,
  locationPhotoAllowedLocationsDigest: digestLocations(normalizedLocations),
  locationPhotoAllowedLocationsUpdatedAt: now,
  locationPhotoAllowedLocationsReason: CLEAR
    ? 'clear-temporary-operational-locations'
    : 'bimtek-zhm-premiere-padang-2026-07',
};

console.log(JSON.stringify({
  apply: APPLY,
  clear: CLEAR,
  projectId: PROJECT_ID,
  current: {
    attendanceVerificationMode: current.attendanceVerificationMode || null,
    locationPhotoAllowedLocationsVersion:
      current.locationPhotoAllowedLocationsVersion ?? null,
    locationPhotoAllowedLocationsDigest:
      current.locationPhotoAllowedLocationsDigest ?? null,
    locationPhotoAllowedLocations:
      current.locationPhotoAllowedLocations ?? [],
  },
  proposed,
}, null, 2));

if (!APPLY) {
  console.log('Dry-run saja. Tambahkan --apply untuk menulis perubahan.');
  process.exit(0);
}

const params = new URLSearchParams();
Object.keys(proposed).forEach(field =>
  params.append('updateMask.fieldPaths', field)
);
params.set('currentDocument.updateTime', currentDocument.updateTime);
await api(`${CONFIG_URL}?${params}`, {
  method: 'PATCH',
  body: JSON.stringify({
    name: currentDocument.name,
    fields: Object.fromEntries(
      Object.entries(proposed).map(([key, value]) => [
        key,
        encodeValue(value),
      ])
    ),
  }),
});

const confirmed = await api(CONFIG_URL);
const confirmedFields = Object.fromEntries(
  Object.entries(confirmed.fields || {}).map(
    ([key, value]) => [key, decodeValue(value)]
  )
);
const expectedDigest = proposed.locationPhotoAllowedLocationsDigest;
if (
  confirmedFields.locationPhotoAllowedLocationsVersion !==
    proposed.locationPhotoAllowedLocationsVersion ||
  confirmedFields.locationPhotoAllowedLocationsDigest !== expectedDigest ||
  confirmedFields.locationPhotoAllowedLocationsReason !==
    proposed.locationPhotoAllowedLocationsReason
) {
  throw new Error('Verifikasi pascatulis gagal untuk lokasi operasional.');
}
console.log(JSON.stringify({
  applied: true,
  updateTime: confirmed.updateTime,
  confirmed: {
    locationPhotoAllowedLocationsVersion:
      confirmedFields.locationPhotoAllowedLocationsVersion,
    locationPhotoAllowedLocationsDigest:
      confirmedFields.locationPhotoAllowedLocationsDigest,
    locationPhotoAllowedLocations:
      confirmedFields.locationPhotoAllowedLocations,
    locationPhotoAllowedLocationsReason:
      confirmedFields.locationPhotoAllowedLocationsReason,
    locationPhotoAllowedLocationsUpdatedAt:
      confirmedFields.locationPhotoAllowedLocationsUpdatedAt,
  },
}, null, 2));
