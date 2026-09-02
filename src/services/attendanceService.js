import { httpsCallable } from 'firebase/functions';
import { ref, uploadBytes } from 'firebase/storage';
import { auth, functions, storage } from '../config/firebase';
import { isValidGpsCoords } from '../utils/geolocation';
import { GPS_TRACE_VERSION } from '../utils/gpsSignalTrace';
import {
  EARLY_LEAVE_REASON_MAX_LENGTH,
  EARLY_LEAVE_REASON_MIN_LENGTH,
  getAttendanceErrorMessage,
  getAttendanceErrorReason,
  wrapAttendanceError,
} from '../utils/attendanceErrors';

export {
  EARLY_LEAVE_REASON_MAX_LENGTH,
  EARLY_LEAVE_REASON_MIN_LENGTH,
  getAttendanceErrorMessage,
  getAttendanceErrorReason,
};

const createChallengeCallable = httpsCallable(
  functions,
  'createAttendanceChallenge'
);
const submitAttendanceCallable = httpsCallable(
  functions,
  'submitAttendance',
  { limitedUseAppCheckTokens: true }
);
const getAttendancePhotoUrlCallable = httpsCallable(
  functions,
  'getAttendancePhotoUrl'
);

const VALID_ACTIONS = new Set(['checkIn', 'checkOut']);
export const VERIFICATION_MODE_GEOFENCE_ONSITE = 'geofence_onsite';
export const VERIFICATION_MODE_LOCATION_PHOTO = 'location_photo';
export const EARLY_LEAVE_THRESHOLD_HOUR_WIB = 16;

export const isValidEarlyLeaveReason = (value) => {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  const hasForbiddenControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127;
  });
  return normalized.length >= EARLY_LEAVE_REASON_MIN_LENGTH &&
    normalized.length <= EARLY_LEAVE_REASON_MAX_LENGTH &&
    !hasForbiddenControlCharacter;
};

function assertAction(action) {
  if (!VALID_ACTIONS.has(action)) {
    throw new Error('Jenis absensi tidak valid.');
  }
}

function assertChallenge(challenge, expectedAction, uid) {
  if (!challenge || typeof challenge !== 'object') {
    throw new Error('Tantangan absensi tidak valid. Silakan ulangi dari awal.');
  }

  assertAction(expectedAction);
  if (
    typeof challenge.challengeId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      challenge.challengeId
    ) ||
    challenge.action !== expectedAction
  ) {
    throw new Error('Tantangan absensi tidak cocok dengan tindakan ini.');
  }

  const expectedPath = `attendanceProofs/${uid}/${challenge.challengeId}`;
  if (challenge.uploadPath !== expectedPath) {
    throw new Error('Path bukti absensi dari server tidak valid.');
  }
  if (
    typeof challenge.workDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(challenge.workDate) ||
    challenge.attendanceId !== `${uid}_${challenge.workDate}`
  ) {
    throw new Error('Target shift dari server tidak valid.');
  }

  const expiresAtMs = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error('Tantangan absensi sudah kedaluwarsa. Silakan ulangi dari awal.');
  }
  if (
    typeof challenge.earlyLeaveReasonRequired !== 'boolean' ||
    challenge.earlyLeaveThresholdHourWib !==
      EARLY_LEAVE_THRESHOLD_HOUR_WIB ||
    (
      expectedAction !== 'checkOut' &&
      challenge.earlyLeaveReasonRequired !== false
    )
  ) {
    throw new Error('Kebijakan pulang awal dari server tidak valid.');
  }

  // Advisory only: the backend re-derives the authoritative policy at submit
  // time. A malformed block still means the client and server disagree, so it
  // is worth refusing before the employee takes a selfie.
  const tracePolicy = challenge.gpsTracePolicy;
  if (tracePolicy != null && (
    typeof tracePolicy !== 'object' ||
    tracePolicy.traceVersion !== GPS_TRACE_VERSION ||
    !['observe', 'enforce'].includes(tracePolicy.mode) ||
    !Number.isInteger(tracePolicy.minSamples) ||
    tracePolicy.minSamples < 2 ||
    !Number.isInteger(tracePolicy.minSpanMs) ||
    tracePolicy.minSpanMs < 1000
  )) {
    throw new Error(
      'Kebijakan pemeriksaan sinyal GPS dari server tidak valid.'
    );
  }

  const verificationMode =
    challenge.verificationMode || VERIFICATION_MODE_GEOFENCE_ONSITE;
  if (verificationMode === VERIFICATION_MODE_GEOFENCE_ONSITE) {
    const geofence = challenge.geofence;
    if (
      !geofence ||
      typeof geofence.id !== 'string' ||
      !Number.isFinite(Number(geofence.lat)) ||
      !Number.isFinite(Number(geofence.lng)) ||
      !Number.isFinite(Number(geofence.radius)) ||
      Number(geofence.radius) <= 0 ||
      challenge.presenceProofRequired !== true
    ) {
      throw new Error('Geofence terverifikasi dari server tidak valid.');
    }
    return;
  }
  if (verificationMode === VERIFICATION_MODE_LOCATION_PHOTO) {
    const assignment = challenge.assignment;
    // A permanent server policy has no expiry at all; a time-boxed one must
    // still be in the future.
    const expiresAtMs = challenge.verificationModeExpiresAt == null ?
      null :
      Date.parse(challenge.verificationModeExpiresAt);
    const expiryValid = challenge.verificationModeExpiresAt == null ?
      true :
      Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
    const allowedLocations = challenge.allowedLocations;
    const hasValidAllowedLocations = Array.isArray(allowedLocations) &&
      allowedLocations.length > 0 &&
      allowedLocations.every((entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        typeof (entry.name || entry.nama) === 'string' &&
        String(entry.name || entry.nama).trim().length > 0 &&
        Number.isFinite(Number(entry.lat)) &&
        Number.isFinite(Number(entry.lng)) &&
        Number.isFinite(Number(entry.radius)) &&
        Number(entry.radius) > 0
      );
    if (
      !assignment ||
      !['kelurahan', 'kantor'].includes(assignment.collection) ||
      typeof assignment.id !== 'string' ||
      assignment.id.length === 0 ||
      typeof assignment.name !== 'string' ||
      assignment.name.trim().length === 0 ||
      challenge.presenceProofRequired !== false ||
      !expiryValid ||
      !hasValidAllowedLocations
    ) {
      throw new Error('Kebijakan mode lokasi dan foto dari server tidak valid.');
    }
    return;
  }
  throw new Error('Mode verifikasi absensi dari server tidak dikenali.');
}

export async function createAttendanceChallenge(action, assignmentChoice = null) {
  assertAction(action);
  if (!auth.currentUser) {
    throw new Error('Anda harus login untuk melakukan absensi.');
  }
  if (
    assignmentChoice != null &&
    !['kelurahan', 'kantor'].includes(assignmentChoice)
  ) {
    throw new Error('Pilihan lokasi absensi tidak valid.');
  }

  try {
    const payload = assignmentChoice == null
      ? { action }
      : { action, assignmentChoice };
    const response = await createChallengeCallable(payload);
    const challenge = response.data;
    assertChallenge(challenge, action, auth.currentUser.uid);
    return challenge;
  } catch (error) {
    throw wrapAttendanceError(error);
  }
}

export async function uploadAttendanceProof(photo, challenge) {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Anda harus login untuk mengunggah bukti absensi.');
  }
  if (!(photo instanceof Blob) || photo.size <= 0) {
    throw new Error('Foto selfie tidak valid.');
  }
  if (photo.type !== 'image/jpeg') {
    throw new Error('Bukti absensi harus berupa JPEG.');
  }

  assertChallenge(challenge, challenge?.action, user.uid);

  const proofRef = ref(storage, challenge.uploadPath);
  await uploadBytes(proofRef, photo, {
    contentType: 'image/jpeg',
    customMetadata: {
      challengeId: challenge.challengeId,
      uid: user.uid,
      action: challenge.action,
    },
  });

  return challenge.uploadPath;
}

export async function submitAttendance(
  challenge,
  location,
  presenceCode = '',
  earlyLeaveReason = '',
  locationTrace = null,
  deviceIntegrity = null
) {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Anda harus login untuk melakukan absensi.');
  }
  assertChallenge(challenge, challenge?.action, user.uid);
  if (!isValidGpsCoords(location)) {
    throw new Error('Koordinat GPS tidak valid. Ambil lokasi ulang lalu coba lagi.');
  }
  const normalizedPresenceCode = String(presenceCode || '').trim();
  if (
    challenge.presenceProofRequired === true &&
    !/^\d{6}$/.test(normalizedPresenceCode)
  ) {
    throw new Error('Kode kehadiran lokasi wajib diisi dengan tepat 6 digit.');
  }
  const normalizedEarlyLeaveReason = String(earlyLeaveReason || '').trim();
  if (
    challenge.action === 'checkOut' &&
    normalizedEarlyLeaveReason &&
    !isValidEarlyLeaveReason(normalizedEarlyLeaveReason)
  ) {
    throw new Error(
      `Alasan pulang awal harus ${EARLY_LEAVE_REASON_MIN_LENGTH}-${EARLY_LEAVE_REASON_MAX_LENGTH} karakter.`
    );
  }
  if (
    challenge.action === 'checkOut' &&
    challenge.earlyLeaveReasonRequired === true &&
    !normalizedEarlyLeaveReason
  ) {
    throw new Error('Alasan pulang awal wajib diisi sebelum check-out.');
  }

  const payload = {
    challengeId: challenge.challengeId,
    location: {
      lat: Number(location.lat),
      lng: Number(location.lng),
      accuracy: Number(location.accuracy),
      capturedAt: Number(location.capturedAt),
      source: String(location.source || 'gps'),
    },
  };
  // Sent verbatim. The backend binds the submitted coordinate to one of these
  // samples, so re-rounding or trimming here would break that binding.
  if (locationTrace != null) {
    payload.locationTrace = locationTrace;
  }
  // Only the attested Android wrapper produces this. The backend decides
  // whether to trust it from the App Check application id, not from its
  // presence, so a browser build simply never sends it.
  if (deviceIntegrity != null) {
    payload.deviceIntegrity = deviceIntegrity;
  }
  if (normalizedPresenceCode) {
    payload.presenceCode = normalizedPresenceCode;
  }
  if (challenge.action === 'checkOut' && normalizedEarlyLeaveReason) {
    payload.earlyLeaveReason = normalizedEarlyLeaveReason;
  }

  try {
    const response = await submitAttendanceCallable(payload);
    if (!response.data?.success || !response.data?.attendanceId) {
      throw new Error('Server tidak mengembalikan hasil absensi yang valid.');
    }
    return response.data;
  } catch (error) {
    throw wrapAttendanceError(error);
  }
}

export async function getAttendancePhotoUrl(attendanceId, action) {
  if (!auth.currentUser) {
    throw new Error('Anda harus login untuk melihat bukti absensi.');
  }
  if (typeof attendanceId !== 'string' || !attendanceId) {
    throw new Error('ID absensi tidak valid.');
  }
  if (!VALID_ACTIONS.has(action)) {
    throw new Error('Jenis foto absensi tidak valid.');
  }

  try {
    const response = await getAttendancePhotoUrlCallable({ attendanceId, action });
    const url = response.data?.url;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('Server tidak mengembalikan URL bukti yang valid.');
    }
    return {
      url,
      expiresAt: response.data?.expiresAt || null,
    };
  } catch (error) {
    throw wrapAttendanceError(error);
  }
}
