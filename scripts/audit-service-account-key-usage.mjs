#!/usr/bin/env node

/**
 * Read-only inventory for long-lived Firebase Admin SDK keys. Cloud Audit Logs
 * only prove observed use when serviceAccountKeyName is present; a zero count
 * is never proof that a key is unused.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import authModule from 'firebase-tools/lib/auth.js';

const PROJECT_ID = 'iswmp-sumbar-padang';
const SERVICE_ACCOUNT =
  `firebase-adminsdk-fbsvc@${PROJECT_ID}.iam.gserviceaccount.com`;
const MAX_LOG_ENTRIES = 10_000;

const account = authModule.getGlobalDefaultAccount();
if (!account?.tokens?.refresh_token) {
  throw new Error('Firebase CLI belum login. Jalankan: npx firebase login');
}
authModule.setRefreshToken(account.tokens.refresh_token);
const tokenResult = await authModule.getAccessToken(account.tokens.refresh_token, []);
const accessToken = tokenResult?.access_token;
if (!accessToken) throw new Error('Tidak dapat memperoleh token Firebase CLI.');

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

const keyResult = await api(
  `https://iam.googleapis.com/v1/projects/${PROJECT_ID}/serviceAccounts/` +
  `${encodeURIComponent(SERVICE_ACCOUNT)}/keys`
);
const userManagedKeys = (keyResult.keys || [])
  .filter(key => key.keyType === 'USER_MANAGED')
  .map(key => ({
    id: key.name.split('/').pop(),
    disabled: key.disabled === true,
    disableReason: key.disableReason || null,
    validAfterTime: key.validAfterTime,
    validBeforeTime: key.validBeforeTime,
  }))
  .sort((left, right) => left.validAfterTime.localeCompare(right.validAfterTime));

const earliestKeyTime = userManagedKeys[0]?.validAfterTime;
const entries = [];
let pageToken = '';
if (earliestKeyTime) {
  do {
    const result = await api('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      body: JSON.stringify({
        resourceNames: [`projects/${PROJECT_ID}`],
        filter: `timestamp>="${earliestKeyTime}" AND ` +
          `protoPayload.authenticationInfo.principalEmail="${SERVICE_ACCOUNT}"`,
        orderBy: 'timestamp desc',
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    entries.push(...(result.entries || []));
    pageToken = result.nextPageToken || '';
  } while (pageToken && entries.length < MAX_LOG_ENTRIES);
}

const evidenceByKey = new Map(userManagedKeys.map(key => [key.id, []]));
let entriesWithoutKeyId = 0;
for (const entry of entries) {
  const payload = entry.protoPayload || {};
  const authenticationInfo = payload.authenticationInfo || {};
  const keyId = authenticationInfo.serviceAccountKeyName?.split('/').pop();
  if (!keyId) {
    entriesWithoutKeyId += 1;
    continue;
  }
  if (!evidenceByKey.has(keyId)) evidenceByKey.set(keyId, []);
  evidenceByKey.get(keyId).push({
    timestamp: entry.timestamp || entry.receiveTimestamp || null,
    service: payload.serviceName || null,
    method: payload.methodName || null,
  });
}

const localCredentialFiles = [];
for (const fileName of await readdir(process.cwd())) {
  if (!fileName.endsWith('.json')) continue;
  const fullPath = resolve(fileName);
  try {
    const parsed = JSON.parse(await readFile(fullPath, 'utf8'));
    if (parsed.type !== 'service_account' || parsed.client_email !== SERVICE_ACCOUNT) {
      continue;
    }
    const fileStat = await stat(fullPath);
    localCredentialFiles.push({
      file: basename(fullPath),
      keyId: parsed.private_key_id || null,
      mode: `0${(fileStat.mode & 0o777).toString(8)}`,
    });
  } catch {
    // Ignore non-JSON and inaccessible files; no credential content is printed.
  }
}

console.log(JSON.stringify({
  auditedAt: new Date().toISOString(),
  serviceAccount: SERVICE_ACCOUNT,
  userManagedKeys: userManagedKeys.map(key => {
    const evidence = evidenceByKey.get(key.id) || [];
    return {
      ...key,
      auditLogMatches: evidence.length,
      latestObservedUse: evidence[0] || null,
    };
  }),
  localCredentialFiles,
  principalAuditEntriesScanned: entries.length,
  entriesWithoutRecordedKeyId: entriesWithoutKeyId,
  resultTruncated: Boolean(pageToken),
  warning: 'Nol auditLogMatches bukan bukti key tidak digunakan; inventaris CI/job/workstation tetap wajib sebelum revocation.',
}, null, 2));
