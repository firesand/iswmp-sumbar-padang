#!/usr/bin/env node

/**
 * Enable Firestore/Datastore DATA_WRITE Data Access audit logs without
 * modifying any IAM binding. Read-only by default and fail-closed on unknown
 * arguments, exemptions, concurrent policy changes, or unverifiable results.
 */

import { createFirebaseCliApi } from './lib/firebase-cli-api.mjs';

const PROJECT_ID = 'iswmp-sumbar-padang';
const AUDIT_SERVICE = 'datastore.googleapis.com';
const LOG_TYPE = 'DATA_WRITE';
const CONFIRMATION = 'DATA_WRITE_AUDIT_CONFIRMED';

const args = new Map();
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
  if (key !== '--confirm-data-write-audit' || separator < 0 || !value) {
    throw new Error(`Argumen tidak dikenal atau tidak lengkap: ${argument}`);
  }
  if (args.has(key)) throw new Error(`${key} tidak boleh diulang.`);
  args.set(key, value);
}

const apply = args.get('--apply') === true;
if (apply && args.get('--confirm-data-write-audit') !== CONFIRMATION) {
  throw new Error(
    `--apply memerlukan --confirm-data-write-audit=${CONFIRMATION}.`
  );
}
if (!apply && args.has('--confirm-data-write-audit')) {
  throw new Error('Konfirmasi hanya berlaku bersama --apply.');
}

const api = await createFirebaseCliApi();
const policyUrl =
  `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}`;
const getPolicy = () => api(`${policyUrl}:getIamPolicy`, {
  method: 'POST',
  body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
});

const assertAuditConfigs = auditConfigs => {
  if (!Array.isArray(auditConfigs)) {
    throw new Error('auditConfigs IAM live bukan array.');
  }
  const services = new Set();
  for (const config of auditConfigs) {
    if (!config || typeof config.service !== 'string' ||
        !Array.isArray(config.auditLogConfigs) || services.has(config.service)) {
      throw new Error('Struktur auditConfigs IAM live tidak valid atau duplikat.');
    }
    services.add(config.service);
    const logTypes = new Set();
    for (const logConfig of config.auditLogConfigs) {
      if (!logConfig || typeof logConfig.logType !== 'string' ||
          logTypes.has(logConfig.logType) ||
          (logConfig.exemptedMembers !== undefined &&
            !Array.isArray(logConfig.exemptedMembers))) {
        throw new Error('Struktur auditLogConfigs IAM live tidak valid.');
      }
      logTypes.add(logConfig.logType);
    }
  }
};

const relevantWriteConfigs = auditConfigs => auditConfigs.flatMap(config => {
  if (![AUDIT_SERVICE, 'allServices'].includes(config.service)) return [];
  return config.auditLogConfigs
    .filter(logConfig => logConfig.logType === LOG_TYPE)
    .map(logConfig => ({ service: config.service, ...logConfig }));
});

const summarize = auditConfigs => {
  const relevant = relevantWriteConfigs(auditConfigs);
  return {
    configured: relevant.length > 0,
    relevantConfigCount: relevant.length,
    exemptionCount: relevant.reduce(
      (total, item) => total + (item.exemptedMembers?.length || 0),
      0
    ),
    totalAuditServices: auditConfigs.length,
  };
};

const mergeDataWriteAudit = auditConfigs => {
  const merged = structuredClone(auditConfigs);
  const relevant = relevantWriteConfigs(merged);
  if (relevant.some(item => (item.exemptedMembers?.length || 0) > 0)) {
    throw new Error(
      'DATA_WRITE audit memiliki exemption; script menolak mengubahnya otomatis.'
    );
  }
  if (relevant.length > 0) return merged;
  let serviceConfig = merged.find(config => config.service === AUDIT_SERVICE);
  if (!serviceConfig) {
    serviceConfig = { service: AUDIT_SERVICE, auditLogConfigs: [] };
    merged.push(serviceConfig);
  }
  serviceConfig.auditLogConfigs.push({ logType: LOG_TYPE });
  return merged;
};

const initialPolicy = await getPolicy();
const initialAuditConfigs = initialPolicy.auditConfigs || [];
assertAuditConfigs(initialAuditConfigs);
const initialSummary = summarize(initialAuditConfigs);
mergeDataWriteAudit(initialAuditConfigs);

console.log(JSON.stringify({
  operation: apply ? 'apply' : 'dry-run',
  projectId: PROJECT_ID,
  service: AUDIT_SERVICE,
  logType: LOG_TYPE,
  before: initialSummary,
  changeRequired: !initialSummary.configured,
  iamBindingsTouched: false,
  warning: 'DATA_WRITE Data Access logs dapat menambah volume dan biaya Cloud Logging.',
}, null, 2));

if (!apply) {
  console.log('Tidak ada perubahan. Tambahkan konfirmasi penuh dan --apply setelah review.');
  process.exit(0);
}

const latestPolicy = await getPolicy();
const latestAuditConfigs = latestPolicy.auditConfigs || [];
assertAuditConfigs(latestAuditConfigs);
const desiredAuditConfigs = mergeDataWriteAudit(latestAuditConfigs);
const latestSummary = summarize(latestAuditConfigs);
if (!latestSummary.configured) {
  if (typeof latestPolicy.etag !== 'string' || !latestPolicy.etag) {
    throw new Error('IAM policy etag tidak tersedia; perubahan dibatalkan.');
  }
  await api(`${policyUrl}:setIamPolicy`, {
    method: 'POST',
    body: JSON.stringify({
      policy: {
        etag: latestPolicy.etag,
        auditConfigs: desiredAuditConfigs,
      },
      updateMask: 'auditConfigs,etag',
    }),
  });
}

const verifiedPolicy = await getPolicy();
const verifiedAuditConfigs = verifiedPolicy.auditConfigs || [];
assertAuditConfigs(verifiedAuditConfigs);
const after = summarize(verifiedAuditConfigs);
if (!after.configured || after.exemptionCount !== 0) {
  throw new Error('Verifikasi DATA_WRITE audit gagal atau exemption ditemukan.');
}

console.log(JSON.stringify({
  appliedAt: new Date().toISOString(),
  before: latestSummary,
  after,
  changed: !latestSummary.configured,
  iamBindingsTouched: false,
}, null, 2));
