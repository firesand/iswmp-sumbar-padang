#!/usr/bin/env node

/**
 * Time-boxed switch for the temporary GPS+photo attendance mode.
 *
 * Read-only by default. Add --apply after reviewing the proposed state.
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
const APPLY = process.argv.includes('--apply');
const STOP_NEW_CHECKINS = process.argv.includes('--stop-new-checkins');
const PERMANENT = process.argv.includes('--permanent');
const modeArgument = process.argv.find(argument => argument.startsWith('--mode='));
const durationArgument = process.argv.find(argument =>
  argument.startsWith('--duration-hours=')
);
const acceptedByArgument = process.argv.find(argument =>
  argument.startsWith('--accepted-by=')
);
const reasonArgument = process.argv.find(argument =>
  argument.startsWith('--reason=')
);
const mode = modeArgument?.split('=')[1] || 'location_photo';
const durationHours = Number(durationArgument?.split('=')[1] || 24);
const acceptedBy = acceptedByArgument?.split('=').slice(1).join('=').trim() || '';
const acceptanceReason = reasonArgument?.split('=').slice(1).join('=').trim() || '';
const supportedModes = new Set(['geofence_onsite', 'location_photo']);

if (!supportedModes.has(mode)) {
  throw new Error('--mode harus geofence_onsite atau location_photo.');
}
if (STOP_NEW_CHECKINS && mode !== 'location_photo') {
  throw new Error(
    '--stop-new-checkins hanya berlaku untuk mode location_photo.'
  );
}
if (PERMANENT) {
  if (mode !== 'location_photo') {
    throw new Error('--permanent hanya berlaku untuk mode location_photo.');
  }
  if (STOP_NEW_CHECKINS) {
    throw new Error('--permanent tidak dapat digabung --stop-new-checkins.');
  }
  if (durationArgument) {
    throw new Error('--permanent tidak memakai --duration-hours.');
  }
  if (acceptedBy.length < 3 || acceptedBy.length > 120) {
    throw new Error('--accepted-by wajib 3..120 karakter saat --permanent.');
  }
  if (acceptanceReason.length < 8 || acceptanceReason.length > 500) {
    throw new Error('--reason wajib 8..500 karakter saat --permanent.');
  }
}
if (
  !PERMANENT &&
  mode === 'location_photo' &&
  (!Number.isInteger(durationHours) ||
    durationHours < 1 ||
    durationHours > 168)
) {
  throw new Error('--duration-hours harus bilangan bulat 1..168.');
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
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(
        ([key, entry]) => [key, decodeValue(entry)]
      )
    );
  }
  return undefined;
};

const encodeValue = value => {
  if (value === null) return { nullValue: null };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'object' && !Array.isArray(value)) {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, encodeValue(entry)])
        ),
      },
    };
  }
  throw new Error(`Tipe nilai config tidak didukung: ${typeof value}`);
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
if (
  current.attendanceSecurityVersion !== 2 ||
  current.geofenceTransitionMode !== false
) {
  throw new Error(
    'Kebijakan absensi v2 canonical belum aktif; mode tidak diubah.'
  );
}
const currentMode =
  current.attendanceVerificationMode || 'geofence_onsite';
if (currentMode !== mode) {
  const openShiftRows = await api(RUN_QUERY_URL, {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'attendanceOpenShifts' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'status' },
            op: 'EQUAL',
            value: { stringValue: 'open' },
          },
        },
        limit: 1,
      },
    }),
  });
  const openShift = Array.isArray(openShiftRows)
    ? openShiftRows.find(row => row.document)?.document
    : null;
  if (openShift) {
    throw new Error(
      'Mode tidak diubah: masih ada shift terbuka. Selesaikan check-out ' +
      'atau koreksi administratif terlebih dahulu.'
    );
  }
}

const enabledAt = new Date();
let proposed;
const deleteFields = [];
if (STOP_NEW_CHECKINS) {
  if (currentMode !== 'location_photo') {
    throw new Error(
      'Penghentian darurat gagal: mode aktif bukan location_photo.'
    );
  }
  const existingEnabledAt = new Date(current.locationPhotoModeEnabledAt);
  if (
    (current.locationPhotoModePolicyVersion !== 1 &&
      current.locationPhotoModePolicyVersion !== 2) ||
    Number.isNaN(existingEnabledAt.getTime()) ||
    existingEnabledAt.getTime() >= enabledAt.getTime()
  ) {
    throw new Error(
      'Penghentian darurat gagal: snapshot policy location_photo tidak valid.'
    );
  }
  // Downgrade to an already-expired time-boxed policy: new check-ins stop,
  // open shifts keep their checkout grace window.
  proposed = {
    attendanceVerificationMode: 'location_photo',
    locationPhotoModePolicyVersion: 1,
    locationPhotoModeEnabledAt: existingEnabledAt,
    locationPhotoModeExpiresAt: enabledAt,
    attendanceVerificationModeReason:
      'emergency-stop-new-checkins-checkout-grace-only',
    attendanceVerificationModeUpdatedAt: enabledAt,
  };
  if (current.locationPhotoModePolicyVersion === 2) {
    deleteFields.push('locationPhotoModePermanent');
  }
} else if (PERMANENT) {
  proposed = {
    attendanceVerificationMode: 'location_photo',
    locationPhotoModePolicyVersion: 2,
    locationPhotoModeEnabledAt: enabledAt,
    locationPhotoModePermanent: {
      acceptedAt: enabledAt,
      acceptedBy,
      reason: acceptanceReason,
    },
    attendanceVerificationModeReason:
      'permanent-location-and-photo-capture-risk-accepted',
    attendanceVerificationModeUpdatedAt: enabledAt,
  };
  // The time-boxed expiry must not coexist with a permanent acceptance; the
  // backend rejects that as ambiguous. Removal goes through the update mask:
  // the field is listed there but omitted from the written fields.
  deleteFields.push('locationPhotoModeExpiresAt');
} else {
  proposed = mode === 'location_photo'
  ? {
      attendanceVerificationMode: 'location_photo',
      locationPhotoModePolicyVersion: 1,
      locationPhotoModeEnabledAt: enabledAt,
      locationPhotoModeExpiresAt: new Date(
        enabledAt.getTime() + durationHours * 60 * 60 * 1000
      ),
      attendanceVerificationModeReason:
        'temporary-operational-location-and-photo-capture',
      attendanceVerificationModeUpdatedAt: enabledAt,
    }
  : {
      attendanceVerificationMode: 'geofence_onsite',
      attendanceVerificationModeReason:
        'verified-geofence-and-onsite-presence-required',
      attendanceVerificationModeUpdatedAt: enabledAt,
    };
  if (current.locationPhotoModePolicyVersion === 2) {
    // Leaving a stale permanent acceptance behind would contradict the
    // time-boxed (or geofence) policy that replaces it.
    deleteFields.push('locationPhotoModePermanent');
  }
}

const printable = Object.fromEntries(
  Object.entries(proposed).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])
);
console.log(JSON.stringify({
  apply: APPLY,
  stopNewCheckins: STOP_NEW_CHECKINS,
  projectId: PROJECT_ID,
  currentMode,
  proposed: printable,
}, null, 2));

if (!APPLY) {
  console.log('Dry-run saja. Tambahkan --apply untuk menulis perubahan.');
  process.exit(0);
}

const params = new URLSearchParams();
[...Object.keys(proposed), ...deleteFields].forEach(field =>
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

const canonical = value => {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, canonical(entry)])
        .sort(([left], [right]) => left.localeCompare(right))
    );
  }
  return value;
};

const confirmed = await api(CONFIG_URL);
const confirmedFields = Object.fromEntries(
  Object.entries(confirmed.fields || {}).map(
    ([key, value]) => [key, decodeValue(value)]
  )
);
for (const [key, expected] of Object.entries(printable)) {
  if (
    JSON.stringify(canonical(confirmedFields[key])) !==
      JSON.stringify(canonical(expected))
  ) {
    throw new Error(`Verifikasi pascatulis gagal untuk field ${key}.`);
  }
}
for (const field of deleteFields) {
  if (confirmedFields[field] !== undefined && confirmedFields[field] !== null) {
    throw new Error(
      `Verifikasi pascatulis gagal: field ${field} seharusnya terhapus.`
    );
  }
}
console.log(JSON.stringify({
  applied: true,
  updateTime: confirmed.updateTime,
  confirmed: Object.fromEntries(
    Object.keys(proposed).map(key => [key, confirmedFields[key]])
  ),
}, null, 2));
