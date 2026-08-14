#!/usr/bin/env node

/**
 * Safely update projectConfig/default.jamCheckInDeadline.
 *
 * Read-only by default. A write requires --apply and an explicit confirmation
 * token. The Firestore updateTime precondition prevents overwriting a
 * concurrent project configuration change.
 */

import {
  createFirebaseCliApi,
  decodeFirestoreDocument,
  encodeFirestoreFields,
} from './lib/firebase-cli-api.mjs';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'iswmp-sumbar-padang';
const CONFIG_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
  'databases/(default)/documents/projectConfig/default';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const deadline = args.find(value => value.startsWith('--deadline='))
  ?.split('=').slice(1).join('=').trim();
const expectedCurrent = args.find(value => value.startsWith('--expected-current='))
  ?.split('=').slice(1).join('=').trim();
const confirmation = args.find(value => value.startsWith('--confirm='))
  ?.split('=').slice(1).join('=').trim();

const isValidTime = value =>
  typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

if (!isValidTime(deadline)) {
  throw new Error('--deadline wajib memakai format HH:mm, contoh --deadline=08:10.');
}
if (expectedCurrent && !isValidTime(expectedCurrent)) {
  throw new Error('--expected-current wajib memakai format HH:mm.');
}

const api = await createFirebaseCliApi();
const currentDocument = await api(CONFIG_URL);
const decoded = decodeFirestoreDocument(currentDocument);
if (!decoded?.updateTime) {
  throw new Error('projectConfig/default tidak memiliki updateTime.');
}

const currentDeadline = decoded.data.jamCheckInDeadline ?? null;
console.log(JSON.stringify({
  apply: APPLY,
  projectId: PROJECT_ID,
  document: 'projectConfig/default',
  currentDeadline,
  proposedDeadline: deadline,
  updateTime: decoded.updateTime,
}, null, 2));

if (currentDeadline === deadline) {
  console.log('Tidak ada perubahan: deadline produksi sudah sesuai.');
  process.exit(0);
}
if (expectedCurrent && currentDeadline !== expectedCurrent) {
  throw new Error(
    `Deadline saat ini ${String(currentDeadline)} tidak sama dengan ` +
    `--expected-current=${expectedCurrent}; perubahan dibatalkan.`
  );
}
if (!APPLY) {
  console.log('Dry-run saja. Tambahkan --apply dan token --confirm untuk menulis.');
  process.exit(0);
}

const requiredConfirmation = `SET_ATTENDANCE_DEADLINE_${deadline.replace(':', '_')}`;
if (confirmation !== requiredConfirmation) {
  throw new Error(
    `Konfirmasi tidak cocok. Gunakan --confirm=${requiredConfirmation}.`
  );
}

const params = new URLSearchParams();
params.append('updateMask.fieldPaths', 'jamCheckInDeadline');
params.set('currentDocument.updateTime', decoded.updateTime);
await api(`${CONFIG_URL}?${params}`, {
  method: 'PATCH',
  body: JSON.stringify({
    name: currentDocument.name,
    fields: encodeFirestoreFields({ jamCheckInDeadline: deadline }),
  }),
});

const confirmed = decodeFirestoreDocument(await api(CONFIG_URL));
if (confirmed?.data?.jamCheckInDeadline !== deadline) {
  throw new Error('Verifikasi pascatulis gagal: deadline produksi belum berubah.');
}

console.log(JSON.stringify({
  applied: true,
  confirmedDeadline: confirmed.data.jamCheckInDeadline,
  updateTime: confirmed.updateTime,
}, null, 2));
