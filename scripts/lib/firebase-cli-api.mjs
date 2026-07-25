import authModule from 'firebase-tools/lib/auth.js';

/** Return an authenticated JSON fetch helper backed by Firebase CLI OAuth. */
export async function createFirebaseCliApi() {
  const account = authModule.getGlobalDefaultAccount();
  if (!account?.tokens?.refresh_token) {
    throw new Error('Firebase CLI belum login. Jalankan: npx firebase login');
  }
  const refreshToken = account.tokens.refresh_token;
  authModule.setRefreshToken(refreshToken);
  const token = await authModule.getAccessToken(refreshToken, []);
  if (!token?.access_token) {
    throw new Error('Tidak dapat memperoleh token Firebase CLI.');
  }

  return async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token.access_token}`,
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
}

export function decodeFirestoreValue(value) {
  if (!value || 'nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('bytesValue' in value) return '[bytes-redacted]';
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, nested]) => [
        key,
        decodeFirestoreValue(nested),
      ])
    );
  }
  return null;
}

export function decodeFirestoreDocument(document) {
  if (!document?.name) return null;
  return {
    id: document.name.split('/').pop(),
    name: document.name,
    createTime: document.createTime || null,
    updateTime: document.updateTime || null,
    data: Object.fromEntries(
      Object.entries(document.fields || {}).map(([key, value]) => [
        key,
        decodeFirestoreValue(value),
      ])
    ),
  };
}

export function encodeFirestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  }
  if (value && typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, nested]) => [
            key,
            encodeFirestoreValue(nested),
          ])
        ),
      },
    };
  }
  throw new Error(`Nilai Firestore tidak didukung: ${typeof value}`);
}

export const encodeFirestoreFields = fields => Object.fromEntries(
  Object.entries(fields).map(([key, value]) => [
    key,
    encodeFirestoreValue(value),
  ])
);
