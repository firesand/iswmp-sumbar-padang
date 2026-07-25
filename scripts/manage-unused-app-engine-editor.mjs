#!/usr/bin/env node

/**
 * Reversibly remove/restore the legacy App Engine default service account's
 * primitive Editor role. Removal is allowed only after live workload and
 * recent-audit preconditions pass. No service account is disabled or deleted.
 */

import { createHash } from 'node:crypto';
import { createFirebaseCliApi } from './lib/firebase-cli-api.mjs';

const PROJECT_ID = 'iswmp-sumbar-padang';
const TARGET_EMAIL = `${PROJECT_ID}@appspot.gserviceaccount.com`;
const TARGET_MEMBER = `serviceAccount:${TARGET_EMAIL}`;
const TARGET_ROLE = 'roles/editor';
const LOOKBACK_DAYS = 90;
const ACTIONS = new Set(['status', 'remove', 'restore']);

const args = new Map();
const valueArguments = new Set(['--action', '--confirm-app-engine-editor']);
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
  throw new Error('--action harus status, remove, atau restore.');
}
if (apply && action === 'status') {
  throw new Error('--apply tidak berlaku untuk action=status.');
}
if (!apply && args.has('--confirm-app-engine-editor')) {
  throw new Error('Konfirmasi hanya berlaku bersama --apply.');
}
if (apply) {
  const expected = `${action.toUpperCase()}_APP_ENGINE_DEFAULT_EDITOR`;
  if (args.get('--confirm-app-engine-editor') !== expected) {
    throw new Error(`Operasi memerlukan --confirm-app-engine-editor=${expected}.`);
  }
}

const fingerprint = value => createHash('sha256')
  .update('attendance-legacy-iam-v1\u0000')
  .update(value)
  .digest('hex')
  .slice(0, 16);
const api = await createFirebaseCliApi();
const projectPolicyUrl =
  `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}`;
const getPolicy = () => api(`${projectPolicyUrl}:getIamPolicy`, {
  method: 'POST',
  body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
});

const getOptional = async url => {
  try {
    return await api(url);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
};

const listRecentAuditMatches = async () => {
  const startTime = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  let pageToken = '';
  let pages = 0;
  do {
    if (++pages > 100) throw new Error('Pagination audit log berlebihan.');
    const result = await api('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      body: JSON.stringify({
        resourceNames: [`projects/${PROJECT_ID}`],
        filter: `timestamp>="${startTime}" AND ` +
          `protoPayload.authenticationInfo.principalEmail="${TARGET_EMAIL}"`,
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if ((result.entries || []).length > 0) return result.entries.length;
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return 0;
};

const readPreconditions = async () => {
  const [appEngineApp, functions, runServices, instances, recentAuditMatches] =
    await Promise.all([
      getOptional(`https://appengine.googleapis.com/v1/apps/${PROJECT_ID}`),
      api(
        `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT_ID}/` +
        'locations/-/functions'
      ),
      api(
        `https://run.googleapis.com/v2/projects/${PROJECT_ID}/` +
        'locations/-/services'
      ),
      api(
        `https://compute.googleapis.com/compute/v1/projects/${PROJECT_ID}/` +
        'aggregated/instances?maxResults=500'
      ),
      listRecentAuditMatches(),
    ]);
  const functionReferences = (functions.functions || []).filter(item => {
    const runtime = item.serviceConfig?.serviceAccountEmail;
    const build = item.buildConfig?.serviceAccount;
    return runtime === TARGET_EMAIL ||
      build === TARGET_EMAIL || build?.endsWith(`/serviceAccounts/${TARGET_EMAIL}`);
  }).length;
  const runReferences = (runServices.services || []).filter(item =>
    item.template?.serviceAccount === TARGET_EMAIL
  ).length;
  const instanceReferences = Object.values(instances.items || {}).reduce(
    (total, zone) => total + (zone.instances || []).filter(instance =>
      (instance.serviceAccounts || []).some(account => account.email === TARGET_EMAIL)
    ).length,
    0
  );
  return {
    appEngineApplicationExists: Boolean(appEngineApp),
    functionReferences,
    runReferences,
    instanceReferences,
    recentAuditMatches,
    lookbackDays: LOOKBACK_DAYS,
  };
};

const bindingState = policy => {
  if (!Array.isArray(policy.bindings)) {
    throw new Error('IAM policy tidak memiliki bindings yang valid.');
  }
  const matching = policy.bindings.filter(binding =>
    binding.role === TARGET_ROLE && (binding.members || []).includes(TARGET_MEMBER)
  );
  if (matching.some(binding => binding.condition)) {
    throw new Error('Target memiliki conditional Editor binding yang tidak didukung.');
  }
  if (matching.length > 1) {
    throw new Error('Target memiliki Editor binding duplikat.');
  }
  return { hasEditor: matching.length === 1 };
};

const [initialPolicy, initialPreconditions] = await Promise.all([
  getPolicy(),
  readPreconditions(),
]);
const initialState = bindingState(initialPolicy);
const removalSafe = !initialPreconditions.appEngineApplicationExists &&
  initialPreconditions.functionReferences === 0 &&
  initialPreconditions.runReferences === 0 &&
  initialPreconditions.instanceReferences === 0 &&
  initialPreconditions.recentAuditMatches === 0;

console.log(JSON.stringify({
  operation: apply ? 'apply' : 'dry-run',
  requestedAction: action,
  target: 'app-engine-default',
  targetFingerprint: fingerprint(TARGET_MEMBER),
  role: TARGET_ROLE,
  before: initialState,
  preconditions: initialPreconditions,
  removalSafe,
  serviceAccountDisabledOrDeleted: false,
}, null, 2));

if (!apply || action === 'status') {
  if (action !== 'status') {
    console.log('Tidak ada perubahan. Tambahkan konfirmasi penuh dan --apply.');
  }
  process.exit(0);
}
if (action === 'remove' && !removalSafe) {
  throw new Error('Prasyarat removal tidak lulus; IAM tidak diubah.');
}

const latestPolicy = await getPolicy();
const latestState = bindingState(latestPolicy);
let updatedBindings = structuredClone(latestPolicy.bindings);
if (action === 'remove' && latestState.hasEditor) {
  updatedBindings = updatedBindings.map(binding => {
    if (binding.role !== TARGET_ROLE || binding.condition) return binding;
    return {
      ...binding,
      members: (binding.members || []).filter(member => member !== TARGET_MEMBER),
    };
  }).filter(binding => (binding.members || []).length > 0);
}
if (action === 'restore' && !latestState.hasEditor) {
  let editorBinding = updatedBindings.find(binding =>
    binding.role === TARGET_ROLE && !binding.condition
  );
  if (editorBinding) {
    editorBinding.members = [...(editorBinding.members || []), TARGET_MEMBER];
  } else {
    updatedBindings.push({ role: TARGET_ROLE, members: [TARGET_MEMBER] });
  }
}

const changeRequired = action === 'remove'
  ? latestState.hasEditor
  : !latestState.hasEditor;
if (changeRequired) {
  if (typeof latestPolicy.etag !== 'string' || !latestPolicy.etag) {
    throw new Error('IAM policy etag tidak tersedia; perubahan dibatalkan.');
  }
  await api(`${projectPolicyUrl}:setIamPolicy`, {
    method: 'POST',
    body: JSON.stringify({
      policy: {
        version: latestPolicy.version || 1,
        etag: latestPolicy.etag,
        bindings: updatedBindings,
      },
      updateMask: 'bindings,etag',
    }),
  });
}

const verifiedPolicy = await getPolicy();
const after = bindingState(verifiedPolicy);
const expectedEditor = action === 'restore';
if (after.hasEditor !== expectedEditor) {
  throw new Error('Verifikasi pascaperubahan IAM gagal.');
}
console.log(JSON.stringify({
  appliedAt: new Date().toISOString(),
  action,
  changed: changeRequired,
  before: latestState,
  after,
  serviceAccountDisabledOrDeleted: false,
  recovery: action === 'remove'
    ? '--action=restore --apply ' +
      '--confirm-app-engine-editor=RESTORE_APP_ENGINE_DEFAULT_EDITOR'
    : null,
}, null, 2));
