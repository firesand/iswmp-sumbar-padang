#!/usr/bin/env node
/**
 * Seed Firestore dengan data kelurahan, kantor, dan projectConfig.
 *
 * Prasyarat:
 *   1. Download service account key dari Firebase Console
 *   2. Simpan sebagai service-account.json di root project
 *   3. Jalankan: npm run seed
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  KELURAHAN_SEED,
  KANTOR_SEED,
  PROJECT_CONFIG_SEED,
} from '../src/data/seedData.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  join(__dirname, '..', 'service-account.json');

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error(`
❌ Service account tidak ditemukan: ${SERVICE_ACCOUNT_PATH}

Langkah:
  1. Buka https://console.firebase.google.com/project/iswmp-sumbar-padang/settings/serviceaccounts/adminsdk
  2. Generate new private key → simpan sebagai service-account.json
  3. Jalankan: npm run seed
`);
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
const now = FieldValue.serverTimestamp();

async function seed() {
  console.log('🌱 Seeding ISWMP SumBar-Padang Firestore...\n');

  const batch = db.batch();

  for (const kel of KELURAHAN_SEED) {
    const ref = db.collection('kelurahan').doc(kel.id);
    batch.set(ref, {
      nama: kel.nama,
      kecamatan: kel.kecamatan,
      alamat: kel.alamat,
      kota: kel.kota,
      provinsi: kel.provinsi,
      lat: kel.lat,
      lng: kel.lng,
      radius: kel.radius,
      coordinateStatus: kel.coordinateStatus,
      coordinateSource: kel.coordinateSource,
      coordinateSourceUrl: kel.coordinateSourceUrl,
      verifiedAt: kel.verifiedAt,
      catatan: kel.catatan,
      // Koordinat web tidak boleh mengaktifkan geofence sebelum verifikasi lapangan.
      isActive: false,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
    console.log(`  ✓ kelurahan/${kel.id} — ${kel.nama}`);
  }

  const kantorRef = db.collection('kantor').doc(KANTOR_SEED.id);
  batch.set(kantorRef, {
    nama: KANTOR_SEED.nama,
    alamat: KANTOR_SEED.alamat,
    kota: KANTOR_SEED.kota,
    provinsi: KANTOR_SEED.provinsi,
    lat: KANTOR_SEED.lat,
    lng: KANTOR_SEED.lng,
    radius: KANTOR_SEED.radius,
    isActive: false,
    catatan: KANTOR_SEED.catatan,
    createdAt: now,
    updatedAt: now,
  }, { merge: true });
  console.log('  ✓ kantor/kantor-padang-kota');

  const configRef = db.collection('projectConfig').doc(PROJECT_CONFIG_SEED.id);
  batch.set(configRef, {
    namaProyek: PROJECT_CONFIG_SEED.namaProyek,
    jamCheckInDeadline: PROJECT_CONFIG_SEED.jamCheckInDeadline,
    timezone: PROJECT_CONFIG_SEED.timezone,
    geofenceTransitionMode: PROJECT_CONFIG_SEED.geofenceTransitionMode,
    defaultKelurahanRadius: PROJECT_CONFIG_SEED.defaultKelurahanRadius,
    defaultKantorRadius: PROJECT_CONFIG_SEED.defaultKantorRadius,
    updatedAt: now,
  }, { merge: true });
  console.log('  ✓ projectConfig/default');

  await batch.commit();

  console.log(`
✅ Seed selesai!
   - ${KELURAHAN_SEED.length} kelurahan
   - 1 kantor
   - 1 projectConfig

Cek di: https://console.firebase.google.com/project/iswmp-sumbar-padang/firestore
`);
}

seed().catch((err) => {
  console.error('❌ Seed gagal:', err.message);
  process.exit(1);
});
