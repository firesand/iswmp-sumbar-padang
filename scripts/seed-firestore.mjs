#!/usr/bin/env node

/**
 * Seed Firestore using the current Firebase CLI OAuth session.
 *
 * Dry-run: npm run seed
 * Apply: npm run seed -- --apply
 *   --confirm-reset-geofences=RESET_GEOFENCES_TO_PROVISIONAL
 */

import {
  KELURAHAN_SEED,
  KANTOR_SEED,
  PROJECT_CONFIG_SEED,
} from '../src/data/seedData.js';
import {
  createFirebaseCliApi,
  encodeFirestoreFields,
} from './lib/firebase-cli-api.mjs';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'iswmp-sumbar-padang';
const FIRESTORE_ROOT =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
  'databases/(default)/documents';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const confirmation = args.find(value =>
  value.startsWith('--confirm-reset-geofences='))?.split('=').slice(1).join('=');

if (APPLY && confirmation !== 'RESET_GEOFENCES_TO_PROVISIONAL') {
  throw new Error(
    'Mode --apply membutuhkan ' +
    '--confirm-reset-geofences=RESET_GEOFENCES_TO_PROVISIONAL karena seed ' +
    'menonaktifkan seluruh geofence.'
  );
}

const api = await createFirebaseCliApi();
const documentName = (collection, id) =>
  `projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${id}`;
const write = (collection, id, data) => ({
  update: {
    name: documentName(collection, id),
    fields: encodeFirestoreFields(data),
  },
  updateMask: { fieldPaths: Object.keys(data) },
  updateTransforms: [
    { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
    { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
  ],
});

const writes = [];
for (const kelurahan of KELURAHAN_SEED) {
  writes.push(write('kelurahan', kelurahan.id, {
    nama: kelurahan.nama,
    kecamatan: kelurahan.kecamatan,
    alamat: kelurahan.alamat,
    kota: kelurahan.kota,
    provinsi: kelurahan.provinsi,
    lat: kelurahan.lat,
    lng: kelurahan.lng,
    radius: kelurahan.radius,
    coordinateStatus: kelurahan.coordinateStatus,
    coordinateSource: kelurahan.coordinateSource,
    coordinateSourceUrl: kelurahan.coordinateSourceUrl,
    verifiedAt: kelurahan.verifiedAt,
    verifiedBy: kelurahan.verifiedBy,
    verificationReviewedAt: kelurahan.verificationReviewedAt,
    verificationReviewedBy: kelurahan.verificationReviewedBy,
    verificationEvidence: kelurahan.verificationEvidence,
    verificationOperator: kelurahan.verificationOperator,
    verificationReviewOperator: kelurahan.verificationReviewOperator,
    verificationAuditId: kelurahan.verificationAuditId,
    presenceProofRequired: true,
    catatan: kelurahan.catatan,
    isActive: false,
  }));
}

writes.push(write('kantor', KANTOR_SEED.id, {
  nama: KANTOR_SEED.nama,
  alamat: KANTOR_SEED.alamat,
  kota: KANTOR_SEED.kota,
  provinsi: KANTOR_SEED.provinsi,
  lat: KANTOR_SEED.lat,
  lng: KANTOR_SEED.lng,
  radius: KANTOR_SEED.radius,
  isActive: false,
  coordinateStatus: KANTOR_SEED.coordinateStatus,
  coordinateSource: KANTOR_SEED.coordinateSource,
  coordinateSourceUrl: KANTOR_SEED.coordinateSourceUrl,
  verifiedAt: KANTOR_SEED.verifiedAt,
  verifiedBy: KANTOR_SEED.verifiedBy,
  verificationReviewedAt: KANTOR_SEED.verificationReviewedAt,
  verificationReviewedBy: KANTOR_SEED.verificationReviewedBy,
  verificationEvidence: KANTOR_SEED.verificationEvidence,
  verificationOperator: KANTOR_SEED.verificationOperator,
  verificationReviewOperator: KANTOR_SEED.verificationReviewOperator,
  verificationAuditId: KANTOR_SEED.verificationAuditId,
  presenceProofRequired: true,
  catatan: KANTOR_SEED.catatan,
}));

writes.push(write('projectConfig', PROJECT_CONFIG_SEED.id, {
  namaProyek: PROJECT_CONFIG_SEED.namaProyek,
  jamCheckInDeadline: PROJECT_CONFIG_SEED.jamCheckInDeadline,
  timezone: PROJECT_CONFIG_SEED.timezone,
  geofenceTransitionMode: PROJECT_CONFIG_SEED.geofenceTransitionMode,
  maxAttendanceShiftDurationMinutes:
    PROJECT_CONFIG_SEED.maxAttendanceShiftDurationMinutes,
  defaultKelurahanRadius: PROJECT_CONFIG_SEED.defaultKelurahanRadius,
  defaultKantorRadius: PROJECT_CONFIG_SEED.defaultKantorRadius,
}));

// Proves the replacement credential can read production before any write.
await api(`${FIRESTORE_ROOT}/projectConfig/${PROJECT_CONFIG_SEED.id}`);

console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'dry-run',
  writes: writes.map(item => item.update.name),
  warning: 'Apply mereset semua geofence menjadi provisional dan nonaktif.',
}, null, 2));

if (!APPLY) {
  console.log('Tidak ada data ditulis. Gunakan --apply hanya untuk reset seed yang disengaja.');
  process.exit(0);
}

await api(
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
    'databases/(default)/documents:commit',
  { method: 'POST', body: JSON.stringify({ writes }) }
);
console.log(`Seed selesai: ${writes.length} dokumen ditulis dalam satu commit.`);
