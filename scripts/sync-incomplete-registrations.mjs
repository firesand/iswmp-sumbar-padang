#!/usr/bin/env node

/**
 * Synchronize Firebase Authentication accounts that do not have a Firestore
 * users/{uid} profile into the admin-only incompleteRegistrations queue.
 *
 * This script stores only metadata needed to identify an account. It never
 * exports passwords, password hashes, or salts. The default mode is dry-run;
 * pass --apply to write the queue documents.
 */

import authModule from 'firebase-tools/lib/auth.js';
import accountExporterModule from 'firebase-tools/lib/accountExporter.js';

const DEFAULT_PROJECT_ID = 'iswmp-sumbar-padang';
const APPLY_CHUNK_SIZE = 100;

const args = process.argv.slice(2);
const applyChanges = args.includes('--apply');
const projectArg = args.find(argument => argument.startsWith('--project='));
const projectId = projectArg?.slice('--project='.length) || DEFAULT_PROJECT_ID;

const account = authModule.getGlobalDefaultAccount();
if (!account?.tokens?.refresh_token) {
  console.error('Firebase CLI belum login. Jalankan: firebase login');
  process.exit(1);
}

authModule.setRefreshToken(account.tokens.refresh_token);

const firestoreRoot = `projects/${projectId}/databases/(default)/documents`;
const firestoreApi = `https://firestore.googleapis.com/v1/${firestoreRoot}`;

const getAccessToken = async () => {
  const tokens = await authModule.getAccessToken(account.tokens.refresh_token, []);
  if (!tokens?.access_token) {
    throw new Error('Tidak dapat memperoleh akses Firebase dari sesi CLI.');
  }
  return tokens.access_token;
};

const firestoreRequest = async (url, options = {}) => {
  const accessToken = await getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Firestore API ${response.status}: ${body}`);
  }

  return response.status === 204 ? null : response.json();
};

const listDocumentIds = async (collectionId) => {
  const ids = new Set();
  let pageToken = '';

  do {
    const url = new URL(`${firestoreApi}/${collectionId}`);
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('mask.fieldPaths', '__name__');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const result = await firestoreRequest(url);
    for (const document of result.documents || []) {
      ids.add(document.name.slice(document.name.lastIndexOf('/') + 1));
    }
    pageToken = result.nextPageToken || '';
  } while (pageToken);

  return ids;
};

const listAuthenticationAccounts = async () => {
  const accounts = [];

  await accountExporterModule.serialExportUsers(projectId, {
    format: 'json',
    batchSize: 1000,
    writeUsersToFile(userList) {
      for (const user of userList) {
        accounts.push({
          userId: user.localId,
          email: user.email || '',
          displayName: user.displayName || '',
          phoneNumber: user.phoneNumber || '',
          photoURL: user.photoUrl || '',
          disabled: Boolean(user.disabled),
          authCreatedAt: user.createdAt || null,
          authLastSignInAt: user.lastLoginAt || null,
        });
      }
    },
  });

  return accounts;
};

const stringValue = value => ({ stringValue: String(value || '') });

const timestampValue = (value) => {
  if (value === null || value === undefined || value === '') return { nullValue: null };
  const milliseconds = Number(value);
  const date = Number.isFinite(milliseconds) ? new Date(milliseconds) : new Date(value);
  return Number.isNaN(date.getTime())
    ? { nullValue: null }
    : { timestampValue: date.toISOString() };
};

const toFirestoreDocument = (user, importedAt) => ({
  name: `${firestoreRoot}/incompleteRegistrations/${user.userId}`,
  fields: {
    userId: stringValue(user.userId),
    email: stringValue(user.email.trim().toLowerCase()),
    displayName: stringValue(user.displayName),
    phoneNumber: stringValue(user.phoneNumber),
    photoURL: stringValue(user.photoURL),
    disabled: { booleanValue: user.disabled },
    authCreatedAt: timestampValue(user.authCreatedAt),
    authLastSignInAt: timestampValue(user.authLastSignInAt),
    status: stringValue('awaiting_admin_data'),
    source: stringValue('firebase_auth_orphan_audit'),
    importedAt: { timestampValue: importedAt },
  },
});

const chunksOf = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const applyQueueDocuments = async (users) => {
  if (users.length === 0) return 0;

  const importedAt = new Date().toISOString();
  let written = 0;

  for (const chunk of chunksOf(users, APPLY_CHUNK_SIZE)) {
    const writes = chunk.map(user => ({
      update: toFirestoreDocument(user, importedAt),
      currentDocument: { exists: false },
    }));

    await firestoreRequest(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`,
      { method: 'POST', body: JSON.stringify({ writes }) }
    );
    written += chunk.length;
  }

  return written;
};

const run = async () => {
  const [authAccounts, userIds, queuedIds] = await Promise.all([
    listAuthenticationAccounts(),
    listDocumentIds('users'),
    listDocumentIds('incompleteRegistrations'),
  ]);

  const candidates = authAccounts.filter(accountData =>
    accountData.userId
      && !userIds.has(accountData.userId)
      && !queuedIds.has(accountData.userId)
  );

  console.log(JSON.stringify({
    mode: applyChanges ? 'apply' : 'dry-run',
    projectId,
    authenticationAccounts: authAccounts.length,
    firestoreProfiles: userIds.size,
    alreadyQueued: queuedIds.size,
    candidates: candidates.length,
  }, null, 2));

  if (!applyChanges) {
    console.log('Tidak ada perubahan. Jalankan kembali dengan --apply setelah hasil diperiksa.');
    return;
  }

  const written = await applyQueueDocuments(candidates);
  console.log(JSON.stringify({ written, skipped: authAccounts.length - candidates.length }, null, 2));
};

run().catch(error => {
  console.error(`Sinkronisasi gagal: ${error.message}`);
  process.exit(1);
});
