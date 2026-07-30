#!/usr/bin/env node

/**
 * Emergency stop for the forced-update reload loop.
 *
 * `notifications/global` with { active: true, type: 'update', forced: true }
 * makes AppUpdateNotification call window.location.reload() on every page load,
 * for every user, forever. This deactivates that broadcast.
 *
 * Read-only by default. Add --apply to write.
 */

import authModule from 'firebase-tools/lib/auth.js';

const PROJECT_ID = 'iswmp-sumbar-padang';
const APPLY = process.argv.includes('--apply');
const DOC_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
  'databases/(default)/documents/notifications/global';

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

const flatten = fields =>
  Object.fromEntries(
    Object.entries(fields || {}).map(([key, value]) => [
      key,
      Object.values(value)[0],
    ])
  );

const current = await api(DOC_URL);
console.log('sebelum:', JSON.stringify(flatten(current.fields), null, 1));

const loopActive =
  current.fields?.active?.booleanValue === true &&
  current.fields?.type?.stringValue === 'update' &&
  current.fields?.forced?.booleanValue === true;
console.log('loop reload aktif:', loopActive);

if (!APPLY) {
  console.log('Dry-run saja. Tambahkan --apply untuk menghentikan loop.');
  process.exit(0);
}

const params = new URLSearchParams();
['active', 'forced', 'action'].forEach(field =>
  params.append('updateMask.fieldPaths', field)
);
params.set('currentDocument.updateTime', current.updateTime);

const updated = await api(`${DOC_URL}?${params}`, {
  method: 'PATCH',
  body: JSON.stringify({
    name: current.name,
    fields: {
      active: { booleanValue: false },
      forced: { booleanValue: false },
      action: { stringValue: 'none' },
    },
  }),
});

console.log('sesudah:', JSON.stringify(flatten(updated.fields), null, 1));

const confirmed = await api(DOC_URL);
const stillLooping =
  confirmed.fields?.active?.booleanValue === true &&
  confirmed.fields?.forced?.booleanValue === true;
if (stillLooping) {
  throw new Error('Verifikasi gagal: broadcast forced update masih aktif.');
}
console.log('OK: loop reload dihentikan.');
