#!/usr/bin/env node

/**
 * Switch the GPS signal-integrity policy on projectConfig/default.
 *
 * Read-only by default. Add --apply after reviewing the proposed state.
 *
 * Moving to `enforce` starts rejecting real attendance, so this script first
 * summarises what observe mode actually recorded and refuses to enforce while
 * the evidence says employees would be locked out — in particular while any
 * recent submission still carries TRACE_MISSING, which means that client
 * release is not deployed everywhere yet.
 *
 * The write is protected by the Firestore document updateTime so a concurrent
 * project-config edit cannot be overwritten silently.
 */

import authModule from 'firebase-tools/lib/auth.js';

const PROJECT_ID = 'iswmp-sumbar-padang';
const CONFIG_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
  'databases/(default)/documents/projectConfig/default';
const RUN_QUERY_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/` +
  'databases/(default)/documents:runQuery';
const POLICY_VERSION = 1;
const SUPPORTED_MODES = new Set(['observe', 'enforce']);
const ENFORCEMENT_CONFIRMATION = 'GPS_OBSERVATION_REVIEWED';
const DEFAULT_MINIMUM_SCORE = 50;
const DEFAULT_MIN_OBSERVED = 10;
const OBSERVATION_WINDOW_DAYS = 7;

const argument = (name) => {
  const found = process.argv.find(item => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const APPLY = flag('apply');
const mode = argument('mode');
const minimumScore = argument('minimum-score') == null
  ? DEFAULT_MINIMUM_SCORE
  : Number(argument('minimum-score'));
const minObserved = argument('min-observed') == null
  ? DEFAULT_MIN_OBSERVED
  : Number(argument('min-observed'));
const requireMobile = flag('require-mobile');
const confirmation = argument('confirm-enforcement');
const acceptPendingRejects = flag('accept-pending-rejects');

if (!SUPPORTED_MODES.has(mode)) {
  throw new Error('--mode wajib diisi observe atau enforce.');
}
if (!Number.isInteger(minimumScore) ||
    minimumScore < 0 || minimumScore > 100) {
  throw new Error('--minimum-score harus bilangan bulat 0..100.');
}
if (!Number.isInteger(minObserved) || minObserved < 1) {
  throw new Error('--min-observed harus bilangan bulat >= 1.');
}
if (mode === 'enforce' && APPLY && confirmation !== ENFORCEMENT_CONFIRMATION) {
  throw new Error(
    `Enforcement memerlukan --confirm-enforcement=${ENFORCEMENT_CONFIRMATION}.`
  );
}
if (mode !== 'enforce' && confirmation != null) {
  throw new Error('--confirm-enforcement hanya berlaku untuk mode enforce.');
}

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

const decodeValue = value => {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(decodeValue);
  }
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(
        ([key, nested]) => [key, decodeValue(nested)]
      )
    );
  }
  return undefined;
};

const encodeValue = value => {
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  throw new Error(`Tipe nilai config tidak didukung: ${typeof value}`);
};

const wibDateString = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(date);

/** Read-only summary of what observe mode recorded in the recent window. */
const summariseObservations = async () => {
  const cutoff = wibDateString(
    new Date(Date.now() - OBSERVATION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  );
  const rows = await api(RUN_QUERY_URL, {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'attendances' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'date' },
            op: 'GREATER_THAN_OR_EQUAL',
            value: { stringValue: cutoff },
          },
        },
        orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
        limit: 500,
      },
    }),
  });
  const documents = (Array.isArray(rows) ? rows : [])
    .map(row => row.document)
    .filter(Boolean);
  const summary = {
    windowFromWibDate: cutoff,
    attendanceRecords: documents.length,
    evaluations: 0,
    withTrace: 0,
    traceMissing: 0,
    verdicts: { pass: 0, suspect: 0, reject: 0, unrecorded: 0 },
    signalCounts: {},
    wouldBlock: 0,
  };
  for (const document of documents) {
    const fields = document.fields || {};
    for (const key of ['gpsIntegrity', 'checkOutGpsIntegrity']) {
      const report = decodeValue(fields[key]);
      if (!report || typeof report !== 'object') continue;
      summary.evaluations += 1;
      const verdict = ['pass', 'suspect', 'reject'].includes(report.verdict)
        ? report.verdict
        : 'unrecorded';
      summary.verdicts[verdict] += 1;
      const signals = Array.isArray(report.signals) ? report.signals : [];
      for (const signal of signals) {
        summary.signalCounts[signal] = (summary.signalCounts[signal] || 0) + 1;
      }
      if (signals.includes('TRACE_MISSING')) {
        summary.traceMissing += 1;
      } else {
        summary.withTrace += 1;
      }
      if (verdict === 'reject') summary.wouldBlock += 1;
    }
  }
  return summary;
};

const currentDocument = await api(CONFIG_URL);
if (!currentDocument.updateTime) {
  throw new Error('projectConfig/default tidak memiliki updateTime.');
}
const current = Object.fromEntries(
  Object.entries(currentDocument.fields || {}).map(
    ([key, value]) => [key, decodeValue(value)]
  )
);
if (current.attendanceSecurityVersion !== 2 ||
    current.geofenceTransitionMode !== false) {
  throw new Error(
    'Kebijakan absensi v2 canonical belum aktif; policy GPS tidak diubah.'
  );
}

const observations = await summariseObservations();
const now = new Date();
const proposed = {
  gpsIntegrityMode: mode,
  gpsIntegrityPolicyVersion: POLICY_VERSION,
  gpsIntegrityMinimumScore: minimumScore,
  gpsIntegrityRequireMobileDevice: requireMobile,
  gpsIntegrityUpdatedAt: now,
};
const printable = Object.fromEntries(
  Object.entries(proposed).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])
);

const blockers = [];
if (mode === 'enforce') {
  if (observations.withTrace < minObserved) {
    blockers.push(
      `Bukti observasi belum cukup: ${observations.withTrace} evaluasi ` +
      `bertrace, minimum ${minObserved}. Jalankan observe lebih lama.`
    );
  }
  if (observations.traceMissing > 0) {
    blockers.push(
      `${observations.traceMissing} evaluasi masih TRACE_MISSING: rilis ` +
      'client perekam sinyal belum dipakai semua pengguna. Enforce akan ' +
      'memblokir mereka.'
    );
  }
  if (observations.wouldBlock > 0 && !acceptPendingRejects) {
    blockers.push(
      `${observations.wouldBlock} evaluasi berverdict reject akan diblokir. ` +
      'Selesaikan investigasinya, atau tambahkan --accept-pending-rejects ' +
      'bila memang itu tujuannya.'
    );
  }
}

console.log(JSON.stringify({
  apply: APPLY,
  projectId: PROJECT_ID,
  currentMode: current.gpsIntegrityMode || 'observe (default, unconfigured)',
  currentPolicyVersion: current.gpsIntegrityPolicyVersion ?? null,
  proposed: printable,
  observations,
  blockers,
}, null, 2));

if (blockers.length > 0) {
  throw new Error(
    'Perubahan dibatalkan fail-closed. Lihat daftar blockers di atas.'
  );
}

if (!APPLY) {
  console.log('Dry-run saja. Tambahkan --apply untuk menulis perubahan.');
  process.exit(0);
}

const params = new URLSearchParams();
Object.keys(proposed).forEach(field =>
  params.append('updateMask.fieldPaths', field)
);
params.set('currentDocument.updateTime', currentDocument.updateTime);
await api(`${CONFIG_URL}?${params}`, {
  method: 'PATCH',
  body: JSON.stringify({
    name: currentDocument.name,
    fields: Object.fromEntries(
      Object.entries(proposed).map(([key, value]) => [
        key,
        encodeValue(value),
      ])
    ),
  }),
});

const confirmed = await api(CONFIG_URL);
const confirmedFields = Object.fromEntries(
  Object.entries(confirmed.fields || {}).map(
    ([key, value]) => [key, decodeValue(value)]
  )
);
for (const [key, expected] of Object.entries(printable)) {
  if (confirmedFields[key] !== expected) {
    throw new Error(`Verifikasi pascatulis gagal untuk field ${key}.`);
  }
}
console.log(JSON.stringify({
  applied: true,
  updateTime: confirmed.updateTime,
  confirmed: Object.fromEntries(
    Object.keys(proposed).map(key => [key, confirmedFields[key]])
  ),
}, null, 2));
