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

const KELURAHAN = [
  { id: 'kel-alang-laweh', nama: 'Alang Laweh', kecamatan: 'Padang Selatan' },
  { id: 'kel-rawang', nama: 'Rawang', kecamatan: 'Padang Selatan' },
  { id: 'kel-lubuk-begalung', nama: 'Lubuk Begalung', kecamatan: 'Padang Timur' },
  { id: 'kel-tanjung-aur', nama: 'Tanjung Aur', kecamatan: 'Lubuk Begalung' },
  { id: 'kel-surau-gadang', nama: 'Surau Gadang', kecamatan: 'Nanggalo' },
  { id: 'kel-lubuk-buaya', nama: 'Lubuk Buaya', kecamatan: 'Koto Tangah' },
  { id: 'kel-parupuak-tabing', nama: 'Parupuak Tabing', kecamatan: 'Koto Tangah' },
  { id: 'kel-rimbo-kaluang', nama: 'Rimbo Kaluang', kecamatan: 'Padang Barat' },
  { id: 'kel-berok-nipah', nama: 'Berok Nipah', kecamatan: 'Padang Barat' },
  { id: 'kel-batang-arau', nama: 'Batang Arau', kecamatan: 'Padang Selatan' },
  { id: 'kel-kampung-pondok', nama: 'Kampung Pondok', kecamatan: 'Padang Barat' },
];

async function seed() {
  console.log('🌱 Seeding ISWMP SumBar-Padang Firestore...\n');

  const batch = db.batch();

  for (const kel of KELURAHAN) {
    const ref = db.collection('kelurahan').doc(kel.id);
    batch.set(ref, {
      nama: kel.nama,
      kecamatan: kel.kecamatan,
      kota: 'Padang',
      provinsi: 'Sumatera Barat',
      lat: null,
      lng: null,
      radius: 300,
      isActive: false,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
    console.log(`  ✓ kelurahan/${kel.id} — ${kel.nama}`);
  }

  const kantorRef = db.collection('kantor').doc('kantor-padang-kota');
  batch.set(kantorRef, {
    nama: 'Kantor ISWMP Kota Padang',
    alamat: null,
    kota: 'Padang',
    provinsi: 'Sumatera Barat',
    lat: null,
    lng: null,
    radius: 200,
    isActive: false,
    catatan: 'Koordinat kantor belum ditentukan',
    createdAt: now,
    updatedAt: now,
  }, { merge: true });
  console.log('  ✓ kantor/kantor-padang-kota');

  const configRef = db.collection('projectConfig').doc('default');
  batch.set(configRef, {
    namaProyek: 'ISWMP SumBar-Padang',
    jamCheckInDeadline: '08:00',
    timezone: 'Asia/Jakarta',
    geofenceTransitionMode: true,
    defaultKelurahanRadius: 300,
    defaultKantorRadius: 200,
    updatedAt: now,
  }, { merge: true });
  console.log('  ✓ projectConfig/default');

  await batch.commit();

  console.log(`
✅ Seed selesai!
   - ${KELURAHAN.length} kelurahan
   - 1 kantor
   - 1 projectConfig

Cek di: https://console.firebase.google.com/project/iswmp-sumbar-padang/firestore
`);
}

seed().catch((err) => {
  console.error('❌ Seed gagal:', err.message);
  process.exit(1);
});
