#!/usr/bin/env node

/**
 * Remove legacy plaintext tempPassword fields using Firebase CLI OAuth.
 * Read-only by default; apply requires an explicit confirmation.
 */

import { createFirebaseCliApi } from './lib/firebase-cli-api.mjs';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'iswmp-sumbar-padang';
const FIRESTORE_ROOT =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
  'databases/(default)/documents';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const confirmation = args.find(value =>
  value.startsWith('--confirm-delete='))?.split('=').slice(1).join('=');

if (APPLY && confirmation !== 'DELETE_TEMP_PASSWORD_FIELDS') {
  throw new Error(
    'Mode --apply membutuhkan ' +
    '--confirm-delete=DELETE_TEMP_PASSWORD_FIELDS.'
  );
}

const api = await createFirebaseCliApi();
const documents = [];
let pageToken = '';
do {
  const query = new URLSearchParams({ pageSize: '300', showMissing: 'false' });
  if (pageToken) query.set('pageToken', pageToken);
  const result = await api(`${FIRESTORE_ROOT}/users?${query}`);
  documents.push(...(result.documents || []));
  pageToken = result.nextPageToken || '';
} while (pageToken);

const targets = documents.filter(document =>
  Object.hasOwn(document.fields || {}, 'tempPassword'));

console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'dry-run',
  usersScanned: documents.length,
  targetCount: targets.length,
  targetIds: targets.map(document => document.name.split('/').pop()),
}, null, 2));

if (!APPLY || targets.length === 0) {
  console.log(APPLY ? 'Tidak ada field yang perlu dihapus.' :
    'Tidak ada data diubah. Gunakan --apply dengan confirmation flag bila diperlukan.');
  process.exit(0);
}

for (let offset = 0; offset < targets.length; offset += 400) {
  const batch = targets.slice(offset, offset + 400);
  await api(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
      'databases/(default)/documents:commit',
    {
      method: 'POST',
      body: JSON.stringify({
        writes: batch.map(document => ({
          update: { name: document.name, fields: {} },
          updateMask: { fieldPaths: ['tempPassword'] },
          currentDocument: { updateTime: document.updateTime },
        })),
      }),
    }
  );
}

console.log(`Selesai: tempPassword dihapus dari ${targets.length} pengguna.`);
