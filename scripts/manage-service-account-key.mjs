#!/usr/bin/env node

/**
 * Reversible enable/disable workflow for a single user-managed Admin SDK key.
 * Key deletion is intentionally unsupported.
 */

import { createFirebaseCliApi } from './lib/firebase-cli-api.mjs';

const PROJECT_ID = 'iswmp-sumbar-padang';
const SERVICE_ACCOUNT =
  `firebase-adminsdk-fbsvc@${PROJECT_ID}.iam.gserviceaccount.com`;
const args = new Map(process.argv.slice(2).map(argument => {
  const [key, ...parts] = argument.split('=');
  return [key, parts.length ? parts.join('=') : true];
}));
const action = String(args.get('--action') || 'status').toLowerCase();
const keyId = String(args.get('--key-id') || '');
const apply = args.has('--apply');

if (!new Set(['status', 'disable', 'enable']).has(action) ||
    !/^[0-9a-f]{40}$/.test(keyId)) {
  throw new Error('--action=status|disable|enable dan --key-id=<40 hex> wajib valid.');
}
if (action === 'status' && apply) {
  throw new Error('--apply tidak digunakan untuk action=status.');
}
if (action !== 'status' && apply &&
    args.get('--confirm-key-operation') !== `${action.toUpperCase()}_${keyId}`) {
  throw new Error(
    `Operasi membutuhkan --confirm-key-operation=${action.toUpperCase()}_${keyId}`
  );
}

const api = await createFirebaseCliApi();
const listUrl = `https://iam.googleapis.com/v1/projects/${PROJECT_ID}/` +
  `serviceAccounts/${encodeURIComponent(SERVICE_ACCOUNT)}/keys`;
const listKeys = async () => (await api(listUrl)).keys || [];
const before = (await listKeys()).find(key => key.name.endsWith(`/keys/${keyId}`));

if (!before) throw new Error(`Key ${keyId} tidak ditemukan pada service account target.`);
if (before.keyType !== 'USER_MANAGED') {
  throw new Error('Script menolak operasi pada key SYSTEM_MANAGED.');
}

const publicState = key => ({
  id: key.name.split('/').pop(),
  keyType: key.keyType,
  disabled: key.disabled === true,
  disableReason: key.disableReason || null,
  validAfterTime: key.validAfterTime,
  validBeforeTime: key.validBeforeTime,
});

console.log(JSON.stringify({
  operation: apply ? 'apply' : 'dry-run',
  requestedAction: action,
  before: publicState(before),
}, null, 2));

if (action === 'status' || !apply) {
  if (action !== 'status') console.log('Tidak ada perubahan; tambahkan --apply setelah review.');
  process.exit(0);
}

await api(`https://iam.googleapis.com/v1/${before.name}:${action}`, {
  method: 'POST',
  body: '{}',
});

const expectedDisabled = action === 'disable';
let after = null;
for (let attempt = 0; attempt < 10; attempt += 1) {
  after = (await listKeys()).find(key => key.name.endsWith(`/keys/${keyId}`));
  if (after && (after.disabled === true) === expectedDisabled) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!after || (after.disabled === true) !== expectedDisabled) {
  throw new Error(`Verifikasi pasca-${action} gagal untuk key ${keyId}.`);
}

console.log(JSON.stringify({
  appliedAt: new Date().toISOString(),
  after: publicState(after),
  recovery: action === 'disable'
    ? `--action=enable --key-id=${keyId} --apply ` +
      `--confirm-key-operation=ENABLE_${keyId}`
    : null,
}, null, 2));
