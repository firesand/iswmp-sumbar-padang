#!/usr/bin/env node

/**
 * Replace the Compute default build identity's primitive Editor grant with
 * narrowly scoped permissions required by the Cloud Functions build pipeline.
 * The account is not disabled/deleted. Read-only by default; restore-editor is
 * retained as a recovery path if a future platform change breaks deployment.
 */

import { createHash } from 'node:crypto';
import { createFirebaseCliApi } from './lib/firebase-cli-api.mjs';

const PROJECT_ID = 'iswmp-sumbar-padang';
const PROJECT_NUMBER = '1079074812491';
const REGION = 'asia-southeast2';
const BUILD_EMAIL = `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`;
const BUILD_MEMBER = `serviceAccount:${BUILD_EMAIL}`;
const EDITOR_ROLE = 'roles/editor';
const LOG_WRITER_ROLE = 'roles/logging.logWriter';
const ARTIFACT_WRITER_ROLE = 'roles/artifactregistry.writer';
const STORAGE_VIEWER_ROLE = 'roles/storage.objectViewer';
const REPOSITORY =
  `projects/${PROJECT_ID}/locations/${REGION}/repositories/gcf-artifacts`;
const BUILD_BUCKETS = [
  `gcf-v2-sources-${PROJECT_NUMBER}-${REGION}`,
  `gcf-v2-uploads-${PROJECT_NUMBER}.${REGION}.cloudfunctions.appspot.com`,
];
const ACTIONS = new Set(['status', 'harden', 'restore-editor']);

const args = new Map();
const valueArguments = new Set(['--action', '--confirm-build-iam']);
for (const argument of process.argv.slice(2)) {
  if (argument === '--apply') {
    if (args.has('--apply')) throw new Error('--apply tidak boleh diulang.');
    args.set('--apply', true);
    continue;
  }
  const separator = argument.indexOf('=');
  const key = separator > 0 ? argument.slice(0, separator) : argument;
  const value = separator > 0 ? argument.slice(separator + 1) : '';
  if (key === '--apply') {
    throw new Error('--apply adalah flag tanpa nilai; bentuk --apply=... ditolak.');
  }
  if (!valueArguments.has(key) || separator < 0 || !value) {
    throw new Error(`Argumen tidak dikenal atau tidak lengkap: ${argument}`);
  }
  if (args.has(key)) throw new Error(`${key} tidak boleh diulang.`);
  args.set(key, value);
}

const action = String(args.get('--action') || 'status').toLowerCase();
const apply = args.get('--apply') === true;
if (!ACTIONS.has(action)) {
  throw new Error('--action harus status, harden, atau restore-editor.');
}
if (apply && action === 'status') {
  throw new Error('--apply tidak berlaku untuk action=status.');
}
if (!apply && args.has('--confirm-build-iam')) {
  throw new Error('Konfirmasi hanya berlaku bersama --apply.');
}
if (apply) {
  const expected = action === 'harden'
    ? 'HARDEN_COMPUTE_BUILD_IAM'
    : 'RESTORE_COMPUTE_DEFAULT_EDITOR';
  if (args.get('--confirm-build-iam') !== expected) {
    throw new Error(`Operasi memerlukan --confirm-build-iam=${expected}.`);
  }
}

const fingerprint = value => createHash('sha256')
  .update('attendance-build-iam-v1\u0000')
  .update(value)
  .digest('hex')
  .slice(0, 16);
const api = await createFirebaseCliApi();
const projectPolicyUrl =
  `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}`;
const repositoryPolicyUrl =
  `https://artifactregistry.googleapis.com/v1/${REPOSITORY}`;

const getProjectPolicy = () => api(`${projectPolicyUrl}:getIamPolicy`, {
  method: 'POST',
  body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
});
const getRepositoryPolicy = () => api(`${repositoryPolicyUrl}:getIamPolicy`);
const getBucketPolicy = bucket => api(
  `https://storage.googleapis.com/storage/v1/b/${bucket}/iam`
);

const hasUnconditionalBinding = (policy, role, member) =>
  Array.isArray(policy.bindings) && policy.bindings.some(binding =>
    binding.role === role && !binding.condition &&
    (binding.members || []).includes(member)
  );

const assertNoConditionalTarget = (policy, role) => {
  if ((policy.bindings || []).some(binding =>
    binding.role === role && binding.condition &&
    (binding.members || []).includes(BUILD_MEMBER)
  )) {
    throw new Error(`Conditional binding target tidak didukung untuk ${role}.`);
  }
};

const addBinding = (bindings, role, member) => {
  const result = structuredClone(bindings || []);
  let binding = result.find(item => item.role === role && !item.condition);
  if (!binding) {
    binding = { role, members: [] };
    result.push(binding);
  }
  if (!binding.members.includes(member)) binding.members.push(member);
  return result;
};

const removeBinding = (bindings, role, member) => structuredClone(bindings || [])
  .map(binding => {
    if (binding.role !== role || binding.condition) return binding;
    return {
      ...binding,
      members: (binding.members || []).filter(item => item !== member),
    };
  })
  .filter(binding => (binding.members || []).length > 0);

const readState = async () => {
  const [projectPolicy, repositoryPolicy, bucketPolicies, functions] =
    await Promise.all([
      getProjectPolicy(),
      getRepositoryPolicy(),
      Promise.all(BUILD_BUCKETS.map(async bucket => ({
        bucket,
        policy: await getBucketPolicy(bucket),
      }))),
      api(
        `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT_ID}/` +
        `locations/${REGION}/functions`
      ),
    ]);
  for (const [policy, role] of [
    [projectPolicy, EDITOR_ROLE],
    [projectPolicy, LOG_WRITER_ROLE],
    [repositoryPolicy, ARTIFACT_WRITER_ROLE],
    ...bucketPolicies.map(({ policy }) => [policy, STORAGE_VIEWER_ROLE]),
  ]) {
    if (!Array.isArray(policy.bindings)) policy.bindings = [];
    assertNoConditionalTarget(policy, role);
  }
  const deployedFunctions = functions.functions || [];
  const buildReferences = deployedFunctions.filter(item => {
    const account = item.buildConfig?.serviceAccount;
    return account === BUILD_EMAIL ||
      account?.endsWith(`/serviceAccounts/${BUILD_EMAIL}`);
  }).length;
  return {
    projectPolicy,
    repositoryPolicy,
    bucketPolicies,
    deployedFunctionCount: deployedFunctions.length,
    buildReferences,
    status: {
      editor: hasUnconditionalBinding(projectPolicy, EDITOR_ROLE, BUILD_MEMBER),
      projectLogWriter: hasUnconditionalBinding(
        projectPolicy,
        LOG_WRITER_ROLE,
        BUILD_MEMBER
      ),
      repositoryArtifactWriter: hasUnconditionalBinding(
        repositoryPolicy,
        ARTIFACT_WRITER_ROLE,
        BUILD_MEMBER
      ),
      sourceBucketViewer: hasUnconditionalBinding(
        bucketPolicies[0].policy,
        STORAGE_VIEWER_ROLE,
        BUILD_MEMBER
      ),
      uploadBucketViewer: hasUnconditionalBinding(
        bucketPolicies[1].policy,
        STORAGE_VIEWER_ROLE,
        BUILD_MEMBER
      ),
    },
  };
};

const summarize = state => ({
  ...state.status,
  deployedFunctionCount: state.deployedFunctionCount,
  buildReferences: state.buildReferences,
  leastPrivilegeReady:
    !state.status.editor &&
    state.status.projectLogWriter &&
    state.status.repositoryArtifactWriter &&
    state.status.sourceBucketViewer &&
    state.status.uploadBucketViewer,
});

const initial = await readState();
if (initial.deployedFunctionCount === 0 ||
    initial.buildReferences !== initial.deployedFunctionCount) {
  throw new Error(
    'Tidak semua Function live memakai Compute default sebagai build identity.'
  );
}
console.log(JSON.stringify({
  operation: apply ? 'apply' : 'dry-run',
  requestedAction: action,
  target: 'compute-default-build',
  targetFingerprint: fingerprint(BUILD_MEMBER),
  before: summarize(initial),
  scopes: {
    project: [LOG_WRITER_ROLE],
    artifactRepositoryCount: 1,
    sourceBucketCount: BUILD_BUCKETS.length,
  },
  serviceAccountDisabledOrDeleted: false,
}, null, 2));

if (!apply || action === 'status') {
  if (action !== 'status') {
    console.log('Tidak ada perubahan. Tambahkan konfirmasi penuh dan --apply.');
  }
  process.exit(0);
}

const setRepositoryPolicy = policy => api(`${repositoryPolicyUrl}:setIamPolicy`, {
  method: 'POST',
  body: JSON.stringify({ policy }),
});
const setBucketPolicy = (bucket, policy) => api(
  `https://storage.googleapis.com/storage/v1/b/${bucket}/iam`,
  { method: 'PUT', body: JSON.stringify(policy) }
);

if (action === 'harden') {
  // Add non-breaking scoped grants first. Primitive Editor is removed only
  // after every resource-level grant is independently persisted.
  const repositoryPolicy = await getRepositoryPolicy();
  repositoryPolicy.bindings = addBinding(
    repositoryPolicy.bindings,
    ARTIFACT_WRITER_ROLE,
    BUILD_MEMBER,
  );
  await setRepositoryPolicy(repositoryPolicy);

  for (const bucket of BUILD_BUCKETS) {
    const bucketPolicy = await getBucketPolicy(bucket);
    bucketPolicy.bindings = addBinding(
      bucketPolicy.bindings,
      STORAGE_VIEWER_ROLE,
      BUILD_MEMBER,
    );
    await setBucketPolicy(bucket, bucketPolicy);
  }

  const projectPolicy = await getProjectPolicy();
  if (typeof projectPolicy.etag !== 'string' || !projectPolicy.etag) {
    throw new Error('IAM project etag tidak tersedia; Editor tidak dicabut.');
  }
  let bindings = addBinding(
    projectPolicy.bindings,
    LOG_WRITER_ROLE,
    BUILD_MEMBER,
  );
  bindings = removeBinding(bindings, EDITOR_ROLE, BUILD_MEMBER);
  await api(`${projectPolicyUrl}:setIamPolicy`, {
    method: 'POST',
    body: JSON.stringify({
      policy: {
        version: projectPolicy.version || 1,
        etag: projectPolicy.etag,
        bindings,
      },
      updateMask: 'bindings,etag',
    }),
  });
} else {
  const projectPolicy = await getProjectPolicy();
  if (typeof projectPolicy.etag !== 'string' || !projectPolicy.etag) {
    throw new Error('IAM project etag tidak tersedia; restore dibatalkan.');
  }
  const bindings = addBinding(
    projectPolicy.bindings,
    EDITOR_ROLE,
    BUILD_MEMBER,
  );
  await api(`${projectPolicyUrl}:setIamPolicy`, {
    method: 'POST',
    body: JSON.stringify({
      policy: {
        version: projectPolicy.version || 1,
        etag: projectPolicy.etag,
        bindings,
      },
      updateMask: 'bindings,etag',
    }),
  });
}

const after = await readState();
const afterSummary = summarize(after);
if (action === 'harden' && !afterSummary.leastPrivilegeReady) {
  throw new Error('Verifikasi IAM build least-privilege gagal.');
}
if (action === 'restore-editor' && !afterSummary.editor) {
  throw new Error('Verifikasi restore Compute default Editor gagal.');
}
console.log(JSON.stringify({
  appliedAt: new Date().toISOString(),
  action,
  after: afterSummary,
  serviceAccountDisabledOrDeleted: false,
  recovery: action === 'harden'
    ? '--action=restore-editor --apply ' +
      '--confirm-build-iam=RESTORE_COMPUTE_DEFAULT_EDITOR'
    : null,
}, null, 2));
