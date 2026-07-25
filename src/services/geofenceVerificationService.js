import {
  collection,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions } from '../config/firebase';
import { getCurrentLocation } from '../utils/geolocation';
import {
  GEOFENCE_VERIFICATION_COLLECTIONS,
  GeofenceVerificationInputError,
  normalizeFreshVerificationLocation,
  normalizeGeofenceProposalInput,
  normalizeGeofenceTarget,
  normalizePendingGeofenceProposal,
  normalizeReviewDecision,
} from '../utils/geofenceVerification';

const PROPOSALS_COLLECTION = 'geofenceVerificationProposals';

const proposeCallable = httpsCallable(
  functions,
  'proposeGeofenceVerification',
  { limitedUseAppCheckTokens: true }
);

const reviewCallable = httpsCallable(
  functions,
  'reviewGeofenceVerification',
  { limitedUseAppCheckTokens: true }
);

const codeMessages = Object.freeze({
  unauthenticated: 'Sesi admin berakhir. Silakan login kembali.',
  'permission-denied': 'Akun ini tidak berwenang mengelola verifikasi geofence.',
  'invalid-argument': 'Data verifikasi geofence ditolak karena tidak valid.',
  'failed-precondition': 'Proposal tidak dapat diproses pada kondisi geofence saat ini.',
  'not-found': 'Geofence atau proposal tidak ditemukan.',
  'already-exists': 'Sudah ada proposal pending untuk geofence ini.',
  'resource-exhausted': 'Permintaan terlalu sering. Tunggu sebentar lalu coba kembali.',
  aborted: 'Data berubah saat diproses. Muat ulang daftar lalu coba kembali.',
  unavailable: 'Layanan verifikasi geofence sedang tidak tersedia.',
  'deadline-exceeded': 'Permintaan melewati batas waktu. Coba kembali.',
  internal: 'Server tidak dapat menyelesaikan verifikasi geofence.',
});

const reasonMessages = Object.freeze({
  APP_CHECK_REQUIRED: 'Verifikasi keamanan aplikasi gagal. Muat ulang aplikasi lalu coba kembali.',
  APP_CHECK_REPLAY: 'Token keamanan sudah digunakan. Muat ulang aplikasi lalu coba kembali.',
  ADMIN_REQUIRED: 'Hanya admin aktif yang dapat mengelola verifikasi geofence.',
  GEOFENCE_NOT_FOUND: 'Geofence yang dipilih tidak ditemukan.',
  GEOFENCE_INVALID: 'Data pusat atau radius geofence tidak valid.',
  GEOFENCE_PROPOSAL_EXISTS: 'Geofence ini sudah memiliki proposal pending.',
  PROPOSAL_NOT_FOUND: 'Proposal tidak ditemukan atau sudah tidak tersedia.',
  PROPOSAL_NOT_PENDING: 'Proposal ini sudah pernah direview.',
  SAME_REVIEWER: 'Proposal harus direview oleh akun admin kedua yang berbeda.',
  REVIEWER_NOT_INDEPENDENT: 'Server menolak review karena reviewer tidak independen.',
  INVALID_LOCATION: 'GPS perangkat admin tidak valid.',
  LOCATION_ACCURACY: 'Akurasi GPS admin belum cukup baik. Pindah ke area terbuka lalu coba lagi.',
  LOCATION_STALE: 'GPS admin sudah kedaluwarsa. Ambil lokasi ulang lalu coba kembali.',
  INVALID_LOCATION_SOURCE: 'Sumber lokasi perangkat admin tidak dapat diverifikasi.',
  VERIFIER_OUTSIDE_GEOFENCE: 'Admin harus berada di lokasi yang diverifikasi.',
  REVIEWER_OUTSIDE_GEOFENCE: 'Reviewer harus berada di lokasi yang diverifikasi.',
});

function callableCode(error) {
  return String(error?.code || '').replace(/^functions\//, '');
}

function callableReason(error) {
  return error?.details && typeof error.details === 'object'
    && typeof error.details.reason === 'string'
    ? error.details.reason
    : '';
}

function wrapError(error) {
  if (error instanceof GeofenceVerificationInputError) return error;
  if (error?.name === 'GeofenceVerificationError') return error;

  if (error?.name === 'GeolocationRequiredError') {
    const wrapped = new Error(
      error.message || 'GPS admin wajib diaktifkan untuk verifikasi geofence.'
    );
    wrapped.name = 'GeofenceVerificationError';
    wrapped.code = error.code || 'GPS_REQUIRED';
    return wrapped;
  }

  const code = callableCode(error);
  const reason = callableReason(error);
  const wrapped = new Error(
    reasonMessages[reason]
      || codeMessages[code]
      || 'Verifikasi geofence tidak dapat diproses.'
  );
  wrapped.name = 'GeofenceVerificationError';
  wrapped.code = code;
  wrapped.reason = reason;
  return wrapped;
}

function assertAuthenticated() {
  if (!auth.currentUser) {
    throw wrapError({ code: 'unauthenticated' });
  }
}

function safeCallableResult(data, expectedStatus = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.success === false) {
    throw wrapError({ code: 'internal' });
  }

  const proposalId = typeof data.proposalId === 'string'
    && /^[A-Za-z0-9:_-]{1,128}$/.test(data.proposalId)
    ? data.proposalId
    : null;
  const status = typeof data.status === 'string'
    && ['pending', 'approved', 'rejected'].includes(data.status)
    ? data.status
    : expectedStatus;

  return {
    success: true,
    proposalId,
    status,
  };
}

export async function captureGeofenceVerificationLocation() {
  try {
    assertAuthenticated();
    const location = await getCurrentLocation();
    return normalizeFreshVerificationLocation(location);
  } catch (error) {
    throw wrapError(error);
  }
}

export async function loadGeofenceVerificationTargets() {
  try {
    assertAuthenticated();
    const snapshots = await Promise.all(
      GEOFENCE_VERIFICATION_COLLECTIONS.map((collectionName) =>
        getDocs(collection(db, collectionName))
      )
    );

    return snapshots
      .flatMap((snapshot, index) => snapshot.docs.map((documentSnapshot) =>
        normalizeGeofenceTarget(
          GEOFENCE_VERIFICATION_COLLECTIONS[index],
          documentSnapshot.id,
          documentSnapshot.data()
        )
      ))
      .sort((first, second) => {
        if (first.collection !== second.collection) {
          return first.collection.localeCompare(second.collection, 'id');
        }
        return first.name.localeCompare(second.name, 'id');
      });
  } catch (error) {
    throw wrapError(error);
  }
}

export async function loadPendingGeofenceVerificationProposals() {
  try {
    assertAuthenticated();
    const pendingQuery = query(
      collection(db, PROPOSALS_COLLECTION),
      where('status', '==', 'pending')
    );
    const snapshot = await getDocs(pendingQuery);
    return snapshot.docs
      .map((documentSnapshot) => normalizePendingGeofenceProposal(
        documentSnapshot.id,
        documentSnapshot.data()
      ))
      .sort((first, second) =>
        (second.createdAtMs || 0) - (first.createdAtMs || 0)
      );
  } catch (error) {
    throw wrapError(error);
  }
}

export async function proposeGeofenceVerification(input) {
  try {
    assertAuthenticated();
    const proposal = normalizeGeofenceProposalInput(input);
    // Always acquire a new reading at submission time. A location captured to
    // populate the form is never reused as verifier evidence.
    const location = await captureGeofenceVerificationLocation();
    const response = await proposeCallable({
      collection: proposal.collection,
      geofenceId: proposal.geofenceId,
      lat: proposal.lat,
      lng: proposal.lng,
      radius: proposal.radius,
      location,
    });
    return safeCallableResult(response.data, 'pending');
  } catch (error) {
    throw wrapError(error);
  }
}

export async function reviewGeofenceVerification(proposalId, decision) {
  try {
    assertAuthenticated();
    const review = normalizeReviewDecision(proposalId, decision);
    const location = await captureGeofenceVerificationLocation();
    const response = await reviewCallable({
      proposalId: review.proposalId,
      decision: review.decision,
      location,
    });
    return safeCallableResult(
      response.data,
      decision === 'approve' ? 'approved' : 'rejected'
    );
  } catch (error) {
    throw wrapError(error);
  }
}
