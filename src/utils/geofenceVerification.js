export const GEOFENCE_VERIFICATION_COLLECTIONS = Object.freeze([
  'kelurahan',
  'kantor',
]);

export const GEOFENCE_REVIEW_DECISIONS = Object.freeze([
  'approve',
  'reject',
]);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_RADIUS_METERS = 500;
const MAX_LOCATION_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5_000;

export class GeofenceVerificationInputError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'GeofenceVerificationInputError';
    this.code = code;
  }
}

function finiteNumber(value) {
  if (value === '' || value === null || value === undefined) return NaN;
  return Number(value);
}

function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function validCollection(value) {
  return GEOFENCE_VERIFICATION_COLLECTIONS.includes(value);
}

function normalizedCoordinates(latValue, lngValue, radiusValue) {
  const lat = finiteNumber(latValue);
  const lng = finiteNumber(lngValue);
  const radius = finiteNumber(radiusValue);
  const valid = Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lng) && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0)
    && Number.isFinite(radius) && radius > 0 && radius <= MAX_RADIUS_METERS;

  return { lat, lng, radius, valid };
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  if (value && typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function proposalCoordinates(data) {
  const proposed = data?.proposed && typeof data.proposed === 'object'
    ? data.proposed
    : {};
  const center = data?.center && typeof data.center === 'object'
    ? data.center
    : {};

  return normalizedCoordinates(
    data?.lat ?? data?.proposedLat ?? proposed.lat ?? center.lat,
    data?.lng ?? data?.proposedLng ?? proposed.lng ?? center.lng,
    data?.radius ?? data?.proposedRadius ?? proposed.radius ?? center.radius
  );
}

export function normalizeGeofenceTarget(collection, id, data = {}) {
  const coordinates = normalizedCoordinates(data.lat, data.lng, data.radius);
  const name = typeof data.nama === 'string' && data.nama.trim()
    ? data.nama.trim()
    : typeof data.name === 'string' && data.name.trim()
      ? data.name.trim()
      : id;

  return {
    key: `${collection}/${id}`,
    collection,
    id,
    name,
    lat: coordinates.valid ? coordinates.lat : null,
    lng: coordinates.valid ? coordinates.lng : null,
    radius: coordinates.valid ? coordinates.radius : null,
    isActive: data.isActive === true,
    coordinateStatus: data.coordinateStatus === 'verified'
      ? 'verified'
      : 'provisional',
  };
}

export function normalizePendingGeofenceProposal(proposalId, data = {}) {
  const collection = data.collection ?? data.geofenceCollection;
  const geofenceId = data.geofenceId;
  const coordinates = proposalCoordinates(data);
  const valid = validIdentifier(proposalId)
    && data.status === 'pending'
    && validCollection(collection)
    && validIdentifier(geofenceId)
    && coordinates.valid;

  // Explicit allowlist: operator identifiers, account addresses, OAuth
  // fingerprints, reviewer data, and captured verifier GPS never reach UI.
  return {
    proposalId,
    collection: validCollection(collection) ? collection : null,
    geofenceId: validIdentifier(geofenceId) ? geofenceId : null,
    lat: coordinates.valid ? coordinates.lat : null,
    lng: coordinates.valid ? coordinates.lng : null,
    radius: coordinates.valid ? coordinates.radius : null,
    createdAtMs: timestampMillis(
      data.proposedAt ?? data.createdAt ?? data.requestedAt
    ),
    valid,
  };
}

export function normalizeGeofenceProposalInput(input = {}) {
  const collection = input.collection;
  const geofenceId = input.geofenceId;
  const coordinates = normalizedCoordinates(input.lat, input.lng, input.radius);

  if (!validCollection(collection) || !validIdentifier(geofenceId)) {
    throw new GeofenceVerificationInputError(
      'Pilihan geofence tidak valid.',
      'INVALID_GEOFENCE'
    );
  }
  if (!coordinates.valid) {
    throw new GeofenceVerificationInputError(
      'Pusat geofence atau radius tidak valid. Radius harus lebih dari 0 dan maksimal 500 meter.',
      'INVALID_COORDINATES'
    );
  }

  return {
    collection,
    geofenceId,
    lat: coordinates.lat,
    lng: coordinates.lng,
    radius: coordinates.radius,
  };
}

export function normalizeReviewDecision(proposalId, decision) {
  if (!validIdentifier(proposalId) || !GEOFENCE_REVIEW_DECISIONS.includes(decision)) {
    throw new GeofenceVerificationInputError(
      'Proposal atau keputusan review tidak valid.',
      'INVALID_REVIEW'
    );
  }
  return { proposalId, decision };
}

export function normalizeFreshVerificationLocation(location, nowMs = Date.now()) {
  const coordinates = normalizedCoordinates(location?.lat, location?.lng, 1);
  const accuracy = finiteNumber(location?.accuracy);
  const capturedAt = finiteNumber(location?.capturedAt);
  const source = location?.source;

  if (
    !coordinates.valid
    || !Number.isFinite(accuracy)
    || accuracy <= 0
    || accuracy > 100
    || !Number.isFinite(capturedAt)
    || capturedAt < nowMs - MAX_LOCATION_AGE_MS
    || capturedAt > nowMs + MAX_FUTURE_SKEW_MS
    || !['gps-high', 'gps-low'].includes(source)
  ) {
    throw new GeofenceVerificationInputError(
      'GPS belum fresh atau akurasinya belum cukup baik. Pindah ke area terbuka lalu coba lagi.',
      'INVALID_LOCATION'
    );
  }

  return {
    lat: coordinates.lat,
    lng: coordinates.lng,
    accuracy,
    capturedAt,
    source,
  };
}
