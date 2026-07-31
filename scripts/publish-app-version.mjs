#!/usr/bin/env node

/**
 * Publish the client version to appConfig/version.
 *
 * This is the correct way to announce a release. It is NOT the "Force" button
 * in the admin debug panel — that one writes notifications/global with
 * forced: true, which makes every client reload on every load, forever.
 *
 * Guards, because announcing a version nobody can load is worse than silence:
 *   1. the version must match APP_VERSION in the client source, and
 *   2. the live hosting service worker must already carry that version.
 *
 * Read-only by default. Add --apply after reviewing the proposed state.
 */

import authModule from 'firebase-tools/lib/auth.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT_ID = 'iswmp-sumbar-padang';
const HOSTING_ORIGIN = 'https://iswmp-sumbar-padang.web.app';
const VERSION_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
  'databases/(default)/documents/appConfig/version';
const NOTIFICATION_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
  'databases/(default)/documents/notifications/global';

const APPLY = process.argv.includes('--apply');
const FORCED = process.argv.includes('--forced');
const SKIP_LIVE_CHECK = process.argv.includes('--skip-live-check');

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(
  join(here, '..', 'src', 'components', 'Common', 'AppUpdateNotification.jsx'),
  'utf8'
);
const sourceVersion = clientSource.match(
  /const APP_VERSION = '([^']+)'/
)?.[1];
if (!sourceVersion) {
  throw new Error('APP_VERSION tidak ditemukan di AppUpdateNotification.jsx.');
}

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

const decode = fields =>
  Object.fromEntries(
    Object.entries(fields || {}).map(([key, value]) => {
      if ('arrayValue' in value) {
        return [
          key,
          (value.arrayValue.values || []).map(item => Object.values(item)[0]),
        ];
      }
      return [key, Object.values(value)[0]];
    })
  );

// Guard 1: the announced version must exist on the live site.
if (!SKIP_LIVE_CHECK) {
  const response = await fetch(`${HOSTING_ORIGIN}/sw.js`, {
    cache: 'no-store',
  });
  const serviceWorker = await response.text();
  if (!serviceWorker.includes(sourceVersion)) {
    throw new Error(
      `Hosting live belum memuat versi ${sourceVersion}. ` +
        'Deploy hosting dulu, atau pakai --skip-live-check jika yakin.'
    );
  }
  console.log(`live sw.js memuat ${sourceVersion}: OK`);
}

// Guard 2: never announce while the forced-reload broadcast is still armed.
const notification = await api(NOTIFICATION_URL).catch(() => null);
if (
  notification?.fields?.active?.booleanValue === true &&
  notification?.fields?.forced?.booleanValue === true
) {
  throw new Error(
    'notifications/global masih forced+active — client akan reload berulang. ' +
      'Jalankan scripts/stop-forced-update-loop.mjs --apply lebih dulu.'
  );
}

const current = await api(VERSION_URL);
const currentData = decode(current.fields);
console.log('sekarang:', JSON.stringify(currentData, null, 1));

if (currentData.latest === sourceVersion) {
  console.log(`appConfig/version sudah ${sourceVersion}. Tidak ada perubahan.`);
  process.exit(0);
}

// Release notes are keyed by version and required: announcing a release with
// the previous release's notes tells every user something untrue.
const RELEASE_NOTES = {
  '1.0.4': {
    updateMessage:
      'Perbaikan tombol absensi yang tertekan berulang dan pemeriksaan ' +
      'keaslian sinyal GPS.',
    features: [
      'Tombol absensi dikunci saat proses berjalan',
      'Indikator progres perekaman lokasi',
      'Pemeriksaan keaslian sinyal GPS di server (mode observasi)',
    ],
  },
  '1.0.5': {
    updateMessage:
      'Perbaikan perintah pembaruan yang membuat aplikasi memuat ulang ' +
      'berputar-putar.',
    features: [
      'Perintah muat ulang paksa berhenti sendiri setelah 15 menit',
      'Perangkat yang versinya sudah terbaru tidak ikut memuat ulang',
      'Tombol kirim perintah muat ulang meminta konfirmasi',
    ],
  },
  '1.0.6': {
    updateMessage:
      'Koreksi lupa check-out kini menjangkau 30 hari ke belakang dan ' +
      'selalu menampilkan nama pegawai.',
    features: [
      'Shift lama yang belum di-check-out tidak lagi hilang setelah 7 hari',
      'Kartu proposal koreksi menampilkan nama, bukan kode acak',
      'Peringatan jelas bila identitas pegawai tidak terbaca',
    ],
  },
};

const notes = RELEASE_NOTES[sourceVersion];
if (!notes) {
  throw new Error(
    `Catatan rilis untuk ${sourceVersion} belum ditulis. ` +
      'Tambahkan ke RELEASE_NOTES di skrip ini lebih dulu.'
  );
}

const updatedAt = new Date();
const proposed = {
  latest: sourceVersion,
  previous: currentData.latest ?? null,
  forcedUpdate: FORCED,
  updatedAt,
  updateMessage: notes.updateMessage,
  features: notes.features,
};
console.log('diusulkan:', JSON.stringify(
  { ...proposed, updatedAt: updatedAt.toISOString() },
  null,
  1
));

if (!APPLY) {
  console.log('Dry-run saja. Tambahkan --apply untuk menerbitkan versi.');
  process.exit(0);
}

const params = new URLSearchParams();
Object.keys(proposed).forEach(field =>
  params.append('updateMask.fieldPaths', field)
);
params.set('currentDocument.updateTime', current.updateTime);

await api(`${VERSION_URL}?${params}`, {
  method: 'PATCH',
  body: JSON.stringify({
    name: current.name,
    fields: {
      latest: { stringValue: proposed.latest },
      previous: proposed.previous == null
        ? { nullValue: null }
        : { stringValue: proposed.previous },
      forcedUpdate: { booleanValue: proposed.forcedUpdate },
      updatedAt: { timestampValue: updatedAt.toISOString() },
      updateMessage: { stringValue: proposed.updateMessage },
      features: {
        arrayValue: {
          values: proposed.features.map(item => ({ stringValue: item })),
        },
      },
    },
  }),
});

const confirmed = decode((await api(VERSION_URL)).fields);
if (confirmed.latest !== sourceVersion) {
  throw new Error('Verifikasi pascatulis gagal: latest tidak sesuai.');
}
console.log('sesudah:', JSON.stringify(confirmed, null, 1));
console.log(`OK: versi ${sourceVersion} diterbitkan.`);
