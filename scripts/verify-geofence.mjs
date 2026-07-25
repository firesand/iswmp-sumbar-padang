#!/usr/bin/env node

/**
 * Two-person, fail-closed geofence verification.
 *
 * Legacy read-only verifier for the retired Firebase CLI OAuth workflow.
 * Production writes now belong to App Check protected server-authoritative
 * callables used by two distinct application administrators. Direct IAM writes
 * are deliberately blocked here because they bypass that trust boundary.
 */

import crypto from 'node:crypto';
import authModule from 'firebase-tools/lib/auth.js';

const PROJECT_ID = 'iswmp-sumbar-padang';
const FIRESTORE_ROOT =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const COMMIT_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`;
const AUDIT_COLLECTION = 'geofenceVerificationAuditLogs';
const AUDIT_SCHEMA_VERSION = 2;
const PROPOSE_CONFIRMATION = 'PHYSICALLY_VERIFIED';
const REVIEW_CONFIRMATION = 'INDEPENDENTLY_REVIEWED';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

if (APPLY) {
  throw new Error(
    'Direct IAM geofence writes sudah dihentikan. Gunakan panel Verifikasi ' +
    'Geofence dengan dua akun admin aplikasi yang berbeda.'
  );
}

const argValue = name => {
  const prefix = `--${name}=`;
  const matches = args.filter(value => value.startsWith(prefix));
  if (matches.length > 1) {
    throw new Error(`Argumen --${name} tidak boleh diulang.`);
  }
  return matches.length === 1 ? matches[0].slice(prefix.length) : null;
};

const phase = argValue('phase');
if (!['propose', 'review'].includes(phase)) {
  throw new Error('Wajib memilih --phase=propose atau --phase=review.');
}

const allowedArguments = new Set(
  phase === 'propose' ? [
    'phase',
    'collection',
    'id',
    'lat',
    'lng',
    'radius',
    'verified-by',
    'evidence',
    'confirm-physical-verification',
  ] : [
    'phase',
    'audit-id',
    'reviewed-by',
    'confirm-independent-review',
    'confirm-fingerprint',
  ]
);
if (args.filter(value => value === '--apply').length > 1) {
  throw new Error('Argumen --apply tidak boleh diulang.');
}
for (const argument of args) {
  if (argument === '--apply') continue;
  const match = /^--([a-z0-9-]+)=/u.exec(argument);
  if (!match || !allowedArguments.has(match[1])) {
    throw new Error(`Argumen tidak dikenal untuk phase ${phase}: ${argument}`);
  }
}

const normalizeText = value =>
  typeof value === 'string' ? value.normalize('NFKC').trim() : '';

const hasControlCharacters = value => /[\u0000-\u001f\u007f-\u009f]/u.test(value);

const requireText = (value, label, minimum, maximum) => {
  const normalized = normalizeText(value);
  if (normalized.length < minimum || normalized.length > maximum ||
      hasControlCharacters(normalized)) {
    throw new Error(
      `${label} wajib ${minimum}..${maximum} karakter tanpa karakter kontrol.`
    );
  }
  return normalized;
};

const requireIdentifier = (value, label, maximum = 128) => {
  const normalized = normalizeText(value);
  if (!new RegExp(`^[A-Za-z0-9:_-]{1,${maximum}}$`, 'u').test(normalized)) {
    throw new Error(`${label} tidak valid.`);
  }
  return normalized;
};

const requireNumber = (value, label, minimum, maximum) => {
  if (value === null || value === undefined ||
      (typeof value === 'string' && normalizeText(value) === '')) {
    throw new Error(`${label} wajib diisi.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} harus berupa angka ${minimum}..${maximum}.`);
  }
  return Object.is(parsed, -0) ? 0 : parsed;
};

const requireTimestamp = (value, label) => {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} tidak valid.`);
  }
  return value;
};

const normalizeOperator = value => {
  const normalized = normalizeText(value).toLocaleLowerCase('en-US');
  if (normalized.length < 3 || normalized.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new Error('Identitas email akun OAuth Firebase CLI tidak valid.');
  }
  return normalized;
};

const sameText = (left, right) =>
  normalizeText(left).toLocaleLowerCase('id-ID') ===
  normalizeText(right).toLocaleLowerCase('id-ID');

const sha256 = value =>
  crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const account = authModule.getProjectDefaultAccount(process.cwd());
if (!account?.tokens?.refresh_token) {
  throw new Error(
    'Firebase CLI belum login. Jalankan npx firebase login:add lalu pilih ' +
    'akun proyek dengan npx firebase login:use EMAIL.'
  );
}

const operator = normalizeOperator(account.user?.email);
const operatorSubject = normalizeText(account.user?.sub);
if (!operatorSubject || account.user?.email_verified !== true) {
  throw new Error('Identitas akun OAuth Firebase CLI tidak dapat diverifikasi.');
}
const operatorAccountFingerprint = sha256(
  `firebase-cli-oauth-subject:${operatorSubject}`
);

authModule.setRefreshToken(account.tokens.refresh_token);
const tokenResult = await authModule.getAccessToken(
  account.tokens.refresh_token,
  []
);
const accessToken = tokenResult?.access_token;
if (!accessToken) {
  throw new Error('Tidak dapat memperoleh token Firebase CLI.');
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
    const error = new Error(
      body?.error?.message || `${response.status} ${url}`
    );
    error.status = response.status;
    throw error;
  }
  return body;
};

const decodeValue = value => {
  if (!value || 'nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  throw new Error('Tipe field Firestore tidak didukung oleh alat verifikasi.');
};

const encodeValue = value => {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  throw new Error(`Tipe field tidak didukung: ${typeof value}`);
};

const encodeFields = fields => Object.fromEntries(
  Object.entries(fields).map(([key, value]) => [key, encodeValue(value)])
);

const decodeDocument = document => ({
  name: document.name,
  createTime: document.createTime,
  updateTime: document.updateTime,
  data: Object.fromEntries(
    Object.entries(document.fields || {}).map(([key, value]) => [
      key,
      decodeValue(value),
    ])
  ),
});

const documentUrl = (collection, id) =>
  `${FIRESTORE_ROOT}/${collection}/${encodeURIComponent(id)}`;

const readDocument = async (collection, id) =>
  decodeDocument(await api(documentUrl(collection, id)));

const stableProposalData = ({
  auditId,
  geofenceCollection,
  geofenceId,
  previousLat,
  previousLng,
  previousRadius,
  verifiedLat,
  verifiedLng,
  verifiedRadius,
  verifiedBy,
  evidence,
  proposer,
  proposerAccountFingerprint,
  sourceUpdateTime,
}) => ({
  schemaVersion: AUDIT_SCHEMA_VERSION,
  action: 'geofence_physical_verification',
  auditId,
  geofenceCollection,
  geofenceId,
  previousLat,
  previousLng,
  previousRadius,
  verifiedLat,
  verifiedLng,
  verifiedRadius,
  verifiedBy,
  evidence,
  operator: proposer,
  operatorAccountFingerprint: proposerAccountFingerprint,
  sourceUpdateTime,
});

const proposalFingerprint = proposal =>
  sha256(JSON.stringify(stableProposalData(proposal)));

const deterministicUuid = seed => {
  const bytes = Buffer.from(sha256(seed).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
};

const assertOnlyFields = (data, allowed, label) => {
  const unexpected = Object.keys(data).filter(key => !allowed.has(key));
  const missing = [...allowed].filter(key => !Object.hasOwn(data, key));
  if (unexpected.length || missing.length) {
    throw new Error(
      `${label} memiliki field hilang/tidak dikenal; proses dihentikan.`
    );
  }
};

const validatePreviousNumber = (value, label) => {
  if (value === null) return null;
  if (!Number.isFinite(value)) {
    throw new Error(`${label} pada proposal bukan angka yang valid.`);
  }
  return Object.is(value, -0) ? 0 : value;
};

const pendingAuditFields = new Set([
  'schemaVersion',
  'action',
  'auditId',
  'status',
  'geofenceCollection',
  'geofenceId',
  'previousLat',
  'previousLng',
  'previousRadius',
  'verifiedLat',
  'verifiedLng',
  'verifiedRadius',
  'verifiedBy',
  'evidence',
  'operator',
  'operatorAccountFingerprint',
  'sourceUpdateTime',
  'proposalFingerprint',
  'proposedAt',
]);

const approvedAuditFields = new Set([
  ...pendingAuditFields,
  'reviewedBy',
  'reviewOperator',
  'reviewOperatorAccountFingerprint',
  'createdAt',
]);

const validateStoredProposal = (auditId, audit, expectedStatus) => {
  const data = audit.data;
  assertOnlyFields(
    data,
    expectedStatus === 'pending' ? pendingAuditFields : approvedAuditFields,
    'Audit proposal'
  );
  if (data.schemaVersion !== AUDIT_SCHEMA_VERSION ||
      data.action !== 'geofence_physical_verification' ||
      data.auditId !== auditId || data.status !== expectedStatus) {
    throw new Error('Status atau identitas audit proposal tidak valid.');
  }

  const geofenceCollection = requireIdentifier(
    data.geofenceCollection,
    'Koleksi proposal',
    10
  );
  if (!['kelurahan', 'kantor'].includes(geofenceCollection)) {
    throw new Error('Koleksi proposal tidak diizinkan.');
  }
  const geofenceId = requireIdentifier(data.geofenceId, 'ID geofence proposal');
  const verifiedLat = requireNumber(data.verifiedLat, 'Latitude proposal', -90, 90);
  const verifiedLng = requireNumber(data.verifiedLng, 'Longitude proposal', -180, 180);
  const verifiedRadius = requireNumber(
    data.verifiedRadius,
    'Radius proposal',
    Number.MIN_VALUE,
    500
  );
  if (verifiedLat === 0 && verifiedLng === 0) {
    throw new Error('Koordinat proposal 0,0 ditolak.');
  }

  const verifiedBy = requireText(data.verifiedBy, 'verifiedBy', 3, 120);
  const evidence = requireText(data.evidence, 'evidence', 8, 500);
  const proposer = normalizeOperator(data.operator);
  const proposerAccountFingerprint = normalizeText(
    data.operatorAccountFingerprint
  ).toLocaleLowerCase('en-US');
  if (!/^[0-9a-f]{64}$/u.test(proposerAccountFingerprint)) {
    throw new Error('Fingerprint akun proposer tidak valid.');
  }
  const sourceUpdateTime = requireTimestamp(
    data.sourceUpdateTime,
    'sourceUpdateTime proposal'
  );
  const proposedAt = requireTimestamp(data.proposedAt, 'proposedAt proposal');
  if (Date.parse(proposedAt) < Date.parse(sourceUpdateTime) ||
      Date.parse(proposedAt) > Date.now() + 5 * 60 * 1000) {
    throw new Error('Urutan waktu proposal tidak valid.');
  }

  if (data.geofenceCollection !== geofenceCollection ||
      data.geofenceId !== geofenceId ||
      typeof data.verifiedLat !== 'number' ||
      typeof data.verifiedLng !== 'number' ||
      typeof data.verifiedRadius !== 'number' ||
      Object.is(data.verifiedLat, -0) || Object.is(data.verifiedLng, -0) ||
      Object.is(data.verifiedRadius, -0) ||
      data.verifiedLat !== verifiedLat || data.verifiedLng !== verifiedLng ||
      data.verifiedRadius !== verifiedRadius ||
      data.verifiedBy !== verifiedBy || data.evidence !== evidence ||
      data.operator !== proposer ||
      data.operatorAccountFingerprint !== proposerAccountFingerprint) {
    throw new Error('Proposal tidak memakai representasi kanonik yang disyaratkan.');
  }

  const previousLat = validatePreviousNumber(data.previousLat, 'previousLat');
  const previousLng = validatePreviousNumber(data.previousLng, 'previousLng');
  const previousRadius = validatePreviousNumber(
    data.previousRadius,
    'previousRadius'
  );
  if ((previousLat !== null && typeof data.previousLat !== 'number') ||
      (previousLng !== null && typeof data.previousLng !== 'number') ||
      (previousRadius !== null && typeof data.previousRadius !== 'number') ||
      Object.is(data.previousLat, -0) || Object.is(data.previousLng, -0) ||
      Object.is(data.previousRadius, -0)) {
    throw new Error('Nilai geofence sebelumnya tidak kanonik.');
  }
  const proposal = {
    auditId,
    geofenceCollection,
    geofenceId,
    previousLat,
    previousLng,
    previousRadius,
    verifiedLat,
    verifiedLng,
    verifiedRadius,
    verifiedBy,
    evidence,
    proposer,
    proposerAccountFingerprint,
    sourceUpdateTime,
  };
  const expectedFingerprint = proposalFingerprint(proposal);
  if (data.proposalFingerprint !== expectedFingerprint) {
    throw new Error('Fingerprint proposal tidak cocok; audit mungkin berubah.');
  }
  return {proposal, fingerprint: expectedFingerprint};
};

const assertDifferentOperators = proposal => {
  if (sameText(operator, proposal.proposer) ||
      operatorAccountFingerprint === proposal.proposerAccountFingerprint) {
    throw new Error(
      'Review wajib memakai akun OAuth Firebase CLI yang berbeda dari proposer. ' +
      'Gunakan npx firebase login:use EMAIL setelah login:add.'
    );
  }
};

const assertGeofenceMatchesApprovedAudit = (geofence, audit) => {
  const data = geofence.data;
  const proposal = audit.proposal;
  if (data.lat !== proposal.verifiedLat ||
      data.lng !== proposal.verifiedLng ||
      data.radius !== proposal.verifiedRadius ||
      data.isActive !== true || data.coordinateStatus !== 'verified' ||
      data.verifiedBy !== proposal.verifiedBy ||
      data.verificationReviewedBy !== audit.reviewedBy ||
      data.verificationEvidence !== proposal.evidence ||
      data.verificationOperator !== proposal.proposerAccountFingerprint ||
      data.verificationReviewOperator !== audit.reviewAccountFingerprint ||
      data.verificationAuditId !== proposal.auditId ||
      data.presenceProofRequired !== true) {
    throw new Error('Geofence aktif tidak cocok dengan audit yang disetujui.');
  }

  const verifiedAt = requireTimestamp(data.verifiedAt, 'verifiedAt geofence');
  const reviewedAt = requireTimestamp(
    data.verificationReviewedAt,
    'verificationReviewedAt geofence'
  );
  requireTimestamp(data.securityPolicyUpdatedAt, 'securityPolicyUpdatedAt');
  if (verifiedAt !== reviewedAt || verifiedAt !== audit.createdAt) {
    throw new Error('Waktu persetujuan audit dan aktivasi geofence tidak atomik.');
  }
};

const printProposal = ({mode, status, proposal, fingerprint, before, review}) => {
  console.log(JSON.stringify({
    phase,
    mode,
    status,
    auditId: proposal.auditId,
    proposalFingerprint: fingerprint,
    geofence: {
      collection: proposal.geofenceCollection,
      id: proposal.geofenceId,
    },
    proposerOperator: proposal.proposer,
    reviewerOperator: review?.operator ?? null,
    before: {
      lat: before.lat ?? null,
      lng: before.lng ?? null,
      radius: before.radius ?? null,
      isActive: before.isActive === true,
      coordinateStatus: before.coordinateStatus ?? null,
      updateTime: before.updateTime,
    },
    afterApproval: {
      lat: proposal.verifiedLat,
      lng: proposal.verifiedLng,
      radius: proposal.verifiedRadius,
      isActive: true,
      coordinateStatus: 'verified',
      verifiedBy: proposal.verifiedBy,
      reviewedBy: review?.reviewedBy ?? null,
      evidence: proposal.evidence,
      presenceProofRequired: true,
    },
  }, null, 2));
};

const runPropose = async () => {
  const collection = requireIdentifier(
    argValue('collection'),
    '--collection',
    10
  );
  if (!['kelurahan', 'kantor'].includes(collection)) {
    throw new Error('--collection harus kelurahan atau kantor.');
  }
  const documentId = requireIdentifier(argValue('id'), '--id');
  const lat = requireNumber(argValue('lat'), '--lat', -90, 90);
  const lng = requireNumber(argValue('lng'), '--lng', -180, 180);
  const radius = requireNumber(
    argValue('radius'),
    '--radius',
    Number.MIN_VALUE,
    500
  );
  if (lat === 0 && lng === 0) {
    throw new Error('Koordinat 0,0 ditolak.');
  }
  const verifiedBy = requireText(
    argValue('verified-by'),
    '--verified-by',
    3,
    120
  );
  const evidence = requireText(argValue('evidence'), '--evidence', 8, 500);
  if (argValue('reviewed-by') !== null || argValue('audit-id') !== null ||
      argValue('confirm-independent-review') !== null ||
      argValue('confirm-fingerprint') !== null) {
    throw new Error('Argumen review tidak boleh dipakai pada phase propose.');
  }
  if (APPLY &&
      argValue('confirm-physical-verification') !== PROPOSE_CONFIRMATION) {
    throw new Error(
      'Mode propose --apply membutuhkan ' +
      `--confirm-physical-verification=${PROPOSE_CONFIRMATION}.`
    );
  }

  const source = await readDocument(collection, documentId);
  const sourceData = source.data;
  const sourceUpdateTime = requireTimestamp(
    source.updateTime,
    'updateTime geofence sumber'
  );
  const proposalSeed = stableProposalData({
    auditId: null,
    geofenceCollection: collection,
    geofenceId: documentId,
    previousLat: validatePreviousNumber(sourceData.lat ?? null, 'lat lama'),
    previousLng: validatePreviousNumber(sourceData.lng ?? null, 'lng lama'),
    previousRadius: validatePreviousNumber(sourceData.radius ?? null, 'radius lama'),
    verifiedLat: lat,
    verifiedLng: lng,
    verifiedRadius: radius,
    verifiedBy,
    evidence,
    proposer: operator,
    proposerAccountFingerprint: operatorAccountFingerprint,
    sourceUpdateTime,
  });
  const auditId = `${collection}_${documentId}_${deterministicUuid(
    JSON.stringify(proposalSeed)
  )}`;
  requireIdentifier(auditId, 'Audit ID', 180);
  const proposal = {
    auditId,
    geofenceCollection: collection,
    geofenceId: documentId,
    previousLat: proposalSeed.previousLat,
    previousLng: proposalSeed.previousLng,
    previousRadius: proposalSeed.previousRadius,
    verifiedLat: lat,
    verifiedLng: lng,
    verifiedRadius: radius,
    verifiedBy,
    evidence,
    proposer: operator,
    proposerAccountFingerprint: operatorAccountFingerprint,
    sourceUpdateTime,
  };
  const fingerprint = proposalFingerprint(proposal);

  printProposal({
    mode: APPLY ? 'apply' : 'dry-run',
    status: 'pending',
    proposal,
    fingerprint,
    before: {...sourceData, updateTime: source.updateTime},
  });

  if (!APPLY) {
    console.log(
      'Tidak ada data yang ditulis. Tambahkan --apply dan konfirmasi fisik.'
    );
    return;
  }

  const auditName =
    `projects/${PROJECT_ID}/databases/(default)/documents/` +
    `${AUDIT_COLLECTION}/${auditId}`;
  const auditFields = {
    ...stableProposalData(proposal),
    status: 'pending',
    proposalFingerprint: fingerprint,
  };

  try {
    await api(COMMIT_URL, {
      method: 'POST',
      body: JSON.stringify({
        writes: [{
          update: {name: auditName, fields: encodeFields(auditFields)},
          updateTransforms: [
            {fieldPath: 'proposedAt', setToServerValue: 'REQUEST_TIME'},
          ],
          currentDocument: {exists: false},
        }],
      }),
    });
  } catch (error) {
    if (error.status !== 409) throw error;
    const existing = await readDocument(AUDIT_COLLECTION, auditId);
    const checked = validateStoredProposal(auditId, existing, 'pending');
    if (checked.fingerprint !== fingerprint) {
      throw new Error('Audit ID sudah ada dengan isi yang berbeda.');
    }
    console.log(`Proposal ${auditId} sudah pending dengan isi identik.`);
    return;
  }

  const confirmed = await readDocument(AUDIT_COLLECTION, auditId);
  const checked = validateStoredProposal(auditId, confirmed, 'pending');
  if (checked.fingerprint !== fingerprint) {
    throw new Error('Verifikasi pascatulis proposal gagal.');
  }
  console.log(
    `Proposal ${auditId} tersimpan sebagai pending; geofence belum diaktifkan.`
  );
};

const validateApprovedReview = (data, proposal) => {
  const reviewedBy = requireText(data.reviewedBy, 'reviewedBy audit', 3, 120);
  if (sameText(reviewedBy, proposal.verifiedBy)) {
    throw new Error('Label reviewer wajib berbeda dari petugas verifikasi.');
  }
  const reviewOperator = normalizeOperator(data.reviewOperator);
  const reviewAccountFingerprint = normalizeText(
    data.reviewOperatorAccountFingerprint
  ).toLocaleLowerCase('en-US');
  if (!/^[0-9a-f]{64}$/u.test(reviewAccountFingerprint) ||
      sameText(reviewOperator, proposal.proposer) ||
      reviewAccountFingerprint === proposal.proposerAccountFingerprint) {
    throw new Error('Identitas reviewer pada audit tidak independen.');
  }
  if (data.reviewedBy !== reviewedBy ||
      data.reviewOperator !== reviewOperator ||
      data.reviewOperatorAccountFingerprint !== reviewAccountFingerprint) {
    throw new Error('Metadata reviewer tidak memakai representasi kanonik.');
  }
  const createdAt = requireTimestamp(data.createdAt, 'createdAt audit');
  if (Date.parse(createdAt) < Date.parse(data.proposedAt)) {
    throw new Error('createdAt approval mendahului proposedAt.');
  }
  return {
    reviewedBy,
    reviewOperator,
    reviewAccountFingerprint,
    createdAt,
  };
};

const runReview = async () => {
  const auditId = requireIdentifier(argValue('audit-id'), '--audit-id', 180);
  if (argValue('collection') !== null || argValue('id') !== null ||
      argValue('lat') !== null || argValue('lng') !== null ||
      argValue('radius') !== null || argValue('verified-by') !== null ||
      argValue('evidence') !== null ||
      argValue('confirm-physical-verification') !== null) {
    throw new Error('Argumen propose tidak boleh dipakai pada phase review.');
  }
  const reviewedBy = requireText(
    argValue('reviewed-by'),
    '--reviewed-by',
    3,
    120
  );
  const audit = await readDocument(AUDIT_COLLECTION, auditId);
  const status = audit.data.status;
  if (!['pending', 'approved'].includes(status)) {
    throw new Error('Audit harus berstatus pending atau approved yang valid.');
  }
  const checked = validateStoredProposal(auditId, audit, status);
  const proposal = checked.proposal;
  assertDifferentOperators(proposal);
  if (sameText(reviewedBy, proposal.verifiedBy)) {
    throw new Error('--reviewed-by wajib berbeda dari --verified-by proposer.');
  }

  const geofence = await readDocument(
    proposal.geofenceCollection,
    proposal.geofenceId
  );
  const currentData = geofence.data;

  if (status === 'approved') {
    const approved = validateApprovedReview(audit.data, proposal);
    assertGeofenceMatchesApprovedAudit(geofence, {
      proposal,
      reviewedBy: approved.reviewedBy,
      reviewOperator: approved.reviewOperator,
      reviewAccountFingerprint: approved.reviewAccountFingerprint,
      createdAt: approved.createdAt,
    });
    if (!sameText(reviewedBy, approved.reviewedBy)) {
      throw new Error('Label reviewer tidak cocok dengan approval yang tersimpan.');
    }
    printProposal({
      mode: APPLY ? 'already-approved' : 'dry-run',
      status,
      proposal,
      fingerprint: checked.fingerprint,
      before: {...currentData, updateTime: geofence.updateTime},
      review: {operator: approved.reviewOperator, reviewedBy},
    });
    if (APPLY) {
      if (argValue('confirm-independent-review') !== REVIEW_CONFIRMATION ||
          normalizeText(argValue('confirm-fingerprint'))
            .toLocaleLowerCase('en-US') !== checked.fingerprint ||
          !sameText(operator, approved.reviewOperator) ||
          operatorAccountFingerprint !== approved.reviewAccountFingerprint) {
        throw new Error(
          'Approval idempoten hanya dapat dikonfirmasi ulang oleh reviewer asli ' +
          'dengan konfirmasi dan fingerprint yang sama.'
        );
      }
      console.log(`Audit ${auditId} sudah approved dengan isi identik.`);
    } else {
      console.log('Tidak ada data yang ditulis; audit ini sudah approved.');
    }
    return;
  }

  if (geofence.updateTime !== proposal.sourceUpdateTime) {
    throw new Error(
      'Dokumen geofence berubah setelah proposal dibuat. Buat proposal baru.'
    );
  }

  printProposal({
    mode: APPLY ? 'apply' : 'dry-run',
    status,
    proposal,
    fingerprint: checked.fingerprint,
    before: {...currentData, updateTime: geofence.updateTime},
    review: {operator, reviewedBy},
  });

  if (!APPLY) {
    console.log(
      'Tidak ada data yang ditulis. Cocokkan bukti secara independen, lalu ' +
      'gunakan --apply dengan konfirmasi dan fingerprint di atas.'
    );
    return;
  }

  const suppliedFingerprint = normalizeText(
    argValue('confirm-fingerprint')
  ).toLocaleLowerCase('en-US');
  if (argValue('confirm-independent-review') !== REVIEW_CONFIRMATION ||
      suppliedFingerprint !== checked.fingerprint) {
    throw new Error(
      'Mode review --apply membutuhkan ' +
      `--confirm-independent-review=${REVIEW_CONFIRMATION} dan ` +
      '--confirm-fingerprint=FINGERPRINT_DRY_RUN yang cocok.'
    );
  }

  const geofenceUpdates = {
    lat: proposal.verifiedLat,
    lng: proposal.verifiedLng,
    radius: proposal.verifiedRadius,
    isActive: true,
    coordinateStatus: 'verified',
    verifiedBy: proposal.verifiedBy,
    verificationReviewedBy: reviewedBy,
    verificationEvidence: proposal.evidence,
    // Publicly readable geofence documents contain only opaque OAuth subject
    // fingerprints. Operator emails remain in the private audit collection.
    verificationOperator: proposal.proposerAccountFingerprint,
    verificationReviewOperator: operatorAccountFingerprint,
    verificationAuditId: auditId,
    presenceProofRequired: true,
  };
  const auditUpdates = {
    status: 'approved',
    reviewedBy,
    reviewOperator: operator,
    reviewOperatorAccountFingerprint: operatorAccountFingerprint,
  };

  await api(COMMIT_URL, {
    method: 'POST',
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: geofence.name,
            fields: encodeFields(geofenceUpdates),
          },
          updateMask: {fieldPaths: Object.keys(geofenceUpdates)},
          updateTransforms: [
            {fieldPath: 'verifiedAt', setToServerValue: 'REQUEST_TIME'},
            {
              fieldPath: 'verificationReviewedAt',
              setToServerValue: 'REQUEST_TIME',
            },
            {
              fieldPath: 'securityPolicyUpdatedAt',
              setToServerValue: 'REQUEST_TIME',
            },
          ],
          currentDocument: {updateTime: proposal.sourceUpdateTime},
        },
        {
          update: {
            name: audit.name,
            fields: encodeFields(auditUpdates),
          },
          updateMask: {fieldPaths: Object.keys(auditUpdates)},
          updateTransforms: [
            {fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME'},
          ],
          currentDocument: {updateTime: audit.updateTime},
        },
      ],
    }),
  });

  const [confirmedGeofence, confirmedAudit] = await Promise.all([
    readDocument(proposal.geofenceCollection, proposal.geofenceId),
    readDocument(AUDIT_COLLECTION, auditId),
  ]);
  const confirmedProposal = validateStoredProposal(
    auditId,
    confirmedAudit,
    'approved'
  );
  const approved = validateApprovedReview(confirmedAudit.data, proposal);
  if (confirmedProposal.fingerprint !== checked.fingerprint ||
      approved.reviewedBy !== reviewedBy ||
      approved.reviewOperator !== operator ||
      approved.reviewAccountFingerprint !== operatorAccountFingerprint) {
    throw new Error('Verifikasi pascatulis approval gagal.');
  }
  assertGeofenceMatchesApprovedAudit(confirmedGeofence, {
    proposal,
    reviewedBy,
    reviewOperator: operator,
    reviewAccountFingerprint: operatorAccountFingerprint,
    createdAt: approved.createdAt,
  });
  console.log(
    `Audit ${auditId} approved dan geofence ` +
    `${proposal.geofenceCollection}/${proposal.geofenceId} aktif.`
  );
};

if (phase === 'propose') {
  await runPropose();
} else {
  await runReview();
}
