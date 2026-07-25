#!/usr/bin/env node

/**
 * Idempotent least-privilege IAM/bootstrap for attendance Cloud Functions.
 * Read-only by default; pass --apply to create/update external resources.
 */

import authModule from 'firebase-tools/lib/auth.js';

const PROJECT_ID = 'iswmp-sumbar-padang';
const PROJECT_NUMBER = '1079074812491';
const BUCKET = 'iswmp-sumbar-padang.firebasestorage.app';
const RUNTIME_ACCOUNT_ID = 'attendance-runtime';
const RUNTIME_EMAIL = `${RUNTIME_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com`;
const STORAGE_AGENT =
  `service-${PROJECT_NUMBER}@gcp-sa-firebasestorage.iam.gserviceaccount.com`;
const APPLY = process.argv.includes('--apply');

const account = authModule.getGlobalDefaultAccount();
if (!account?.tokens?.refresh_token) {
  throw new Error('Firebase CLI belum login. Jalankan: npx firebase login');
}
authModule.setRefreshToken(account.tokens.refresh_token);
const tokenResult = await authModule.getAccessToken(account.tokens.refresh_token, []);
const accessToken = tokenResult?.access_token;
if (!accessToken) throw new Error('Tidak dapat memperoleh token Firebase CLI.');

const api = async (url, options = {}, acceptedStatuses = []) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    throw new Error(body?.error?.message || `${response.status} ${url}`);
  }
  return { status: response.status, body };
};

const waitForOperation = async operation => {
  if (!operation?.name || operation.done === true) return operation;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const result = await api(`https://serviceusage.googleapis.com/v1/${operation.name}`);
    if (result.body.done === true) {
      if (result.body.error) throw new Error(result.body.error.message);
      return result.body;
    }
  }
  throw new Error(`Timeout menunggu operasi ${operation.name}`);
};

const requiredApis = [
  'compute.googleapis.com',
  'iamcredentials.googleapis.com',
];

const projectRoleRequirements = new Map([
  ['roles/datastore.user', new Set([`serviceAccount:${RUNTIME_EMAIL}`])],
  ['roles/firebaseauth.admin', new Set([`serviceAccount:${RUNTIME_EMAIL}`])],
  ['roles/firebaseappcheck.tokenVerifier', new Set([`serviceAccount:${RUNTIME_EMAIL}`])],
  ['roles/firebaserules.firestoreServiceAgent', new Set([`serviceAccount:${STORAGE_AGENT}`])],
]);

const mergeBindings = (bindings = [], requirements) => {
  const result = bindings.map(binding => ({
    ...binding,
    members: [...(binding.members || [])],
  }));
  for (const [role, requiredMembers] of requirements) {
    let binding = result.find(item => item.role === role && !item.condition);
    if (!binding) {
      binding = { role, members: [] };
      result.push(binding);
    }
    for (const member of requiredMembers) {
      if (!binding.members.includes(member)) binding.members.push(member);
    }
  }
  return result;
};

const missingBindings = (bindings = [], requirements) => {
  const missing = [];
  for (const [role, members] of requirements) {
    const current = new Set(
      bindings.filter(item => item.role === role && !item.condition)
        .flatMap(item => item.members || [])
    );
    for (const member of members) {
      if (!current.has(member)) missing.push({ role, member });
    }
  }
  return missing;
};

const serviceStates = await Promise.all(requiredApis.map(async service => {
  const result = await api(
    `https://serviceusage.googleapis.com/v1/projects/${PROJECT_NUMBER}/services/${service}`
  );
  return { service, state: result.body.state };
}));

const runtimeAccountResult = await api(
  `https://iam.googleapis.com/v1/projects/${PROJECT_ID}/serviceAccounts/${encodeURIComponent(RUNTIME_EMAIL)}`,
  {},
  [404]
);
const runtimeExists = runtimeAccountResult.status === 200;

const policyResult = await api(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}:getIamPolicy`,
  { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) }
);
const projectPolicy = policyResult.body;

const bucketPolicyResult = await api(
  `https://storage.googleapis.com/storage/v1/b/${BUCKET}/iam`
);
const bucketPolicy = bucketPolicyResult.body;
const bucketRequirements = new Map([
  ['roles/storage.objectViewer', new Set([`serviceAccount:${RUNTIME_EMAIL}`])],
]);

const plan = {
  mode: APPLY ? 'apply' : 'dry-run',
  enableApis: serviceStates.filter(item => item.state !== 'ENABLED').map(item => item.service),
  createRuntimeServiceAccount: !runtimeExists,
  addProjectBindings: missingBindings(projectPolicy.bindings, projectRoleRequirements),
  addBucketBindings: missingBindings(bucketPolicy.bindings, bucketRequirements),
  ensureRuntimeCanSignAsSelf: true,
  ensureStorageServiceIdentity: true,
};
console.log(JSON.stringify(plan, null, 2));

if (!APPLY) {
  console.log('Tidak ada IAM/API yang diubah. Gunakan --apply setelah review.');
  process.exit(0);
}

for (const service of plan.enableApis) {
  const result = await api(
    `https://serviceusage.googleapis.com/v1/projects/${PROJECT_NUMBER}/services/${service}:enable`,
    { method: 'POST', body: '{}' }
  );
  await waitForOperation(result.body);
}

if (!runtimeExists) {
  await api(`https://iam.googleapis.com/v1/projects/${PROJECT_ID}/serviceAccounts`, {
    method: 'POST',
    body: JSON.stringify({
      accountId: RUNTIME_ACCOUNT_ID,
      serviceAccount: {
        displayName: 'Attendance security runtime',
        description: 'Least-privilege identity for App Check protected attendance callables',
      },
    }),
  });
}

// Ensure the Storage service identity exists before granting its cross-service
// Firestore Rules role.
const storageIdentity = await api(
  `https://serviceusage.googleapis.com/v1beta1/projects/${PROJECT_NUMBER}/services/firebasestorage.googleapis.com:generateServiceIdentity`,
  { method: 'POST', body: '{}' }
);
await waitForOperation(storageIdentity.body);

if (plan.addProjectBindings.length > 0) {
  const latest = await api(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}:getIamPolicy`,
    { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) }
  );
  latest.body.bindings = mergeBindings(latest.body.bindings, projectRoleRequirements);
  await api(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}:setIamPolicy`,
    {
      method: 'POST',
      body: JSON.stringify({ policy: latest.body, updateMask: 'bindings,etag' }),
    }
  );
}

if (plan.addBucketBindings.length > 0) {
  const latest = await api(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/iam`);
  latest.body.bindings = mergeBindings(latest.body.bindings, bucketRequirements);
  await api(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/iam`, {
    method: 'PUT',
    body: JSON.stringify(latest.body),
  });
}

const runtimeIamResource =
  `projects/${PROJECT_ID}/serviceAccounts/${encodeURIComponent(RUNTIME_EMAIL)}`;
const runtimeIam = await api(
  `https://iam.googleapis.com/v1/${runtimeIamResource}:getIamPolicy`,
  { method: 'POST', body: '{}' }
);
const selfSignRequirement = new Map([
  ['roles/iam.serviceAccountTokenCreator', new Set([`serviceAccount:${RUNTIME_EMAIL}`])],
]);
if (missingBindings(runtimeIam.body.bindings, selfSignRequirement).length > 0) {
  runtimeIam.body.bindings = mergeBindings(runtimeIam.body.bindings, selfSignRequirement);
  await api(`https://iam.googleapis.com/v1/${runtimeIamResource}:setIamPolicy`, {
    method: 'POST',
    body: JSON.stringify({ policy: runtimeIam.body }),
  });
}

console.log('IAM/API attendance selesai dikonfigurasi secara idempotent.');
