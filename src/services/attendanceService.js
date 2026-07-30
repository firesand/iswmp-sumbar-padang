import { httpsCallable } from 'firebase/functions';
import { ref, uploadBytes } from 'firebase/storage';
import { auth, functions, storage } from '../config/firebase';
import { isValidGpsCoords } from '../utils/geolocation';
import { GPS_TRACE_VERSION } from '../utils/gpsSignalTrace';
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
export const EARLY_LEAVE_THRESHOLD_HOUR_WIB = 17;
export const EARLY_LEAVE_REASON_MIN_LENGTH = 5;
export const EARLY_LEAVE_REASON_MAX_LENGTH = 300;

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

const friendlyMessages = {
  unauthenticated: 'Sesi login berakhir. Silakan login kembali.',
  'permission-denied': 'Akun ini tidak diizinkan melakukan absensi.',
  'failed-precondition':
    'Absensi belum dapat diproses. Pastikan geofence aktif, foto valid, dan urutan check-in/check-out benar.',
  'already-exists': 'Absensi untuk tahap ini sudah tercatat.',
  'not-found': 'Tantangan absensi tidak ditemukan atau sudah kedaluwarsa.',
  'deadline-exceeded': 'Tantangan absensi sudah kedaluwarsa. Silakan ulangi dari awal.',
  'resource-exhausted':
    'Permintaan absensi terlalu cepat berturut-turut. Tunggu sekitar 15 detik, lalu tekan tombol SATU kali dan tunggu sampai kamera terbuka.',
};

const reasonMessages = {
  PHOTO_REPLAY: 'Foto ini atau variasinya sudah pernah dipakai. Ambil selfie baru langsung dari kamera.',
  PHOTO_LOW_INFORMATION: 'Foto terlalu gelap, terang, polos, atau minim detail. Ambil selfie baru dengan pencahayaan yang baik.',
  PHOTO_REPLAY_INDEX_INVALID: 'Indeks keamanan foto sedang tidak konsisten. Hubungi operator; absensi ditolak demi keamanan.',
  PHOTO_REPLAY_STATE_INVALID: 'Riwayat keamanan foto sedang tidak konsisten. Hubungi operator; absensi ditolak demi keamanan.',
  PHOTO_REPLAY_STATE_OVERFLOW: 'Riwayat keamanan foto mencapai batas aman. Hubungi operator untuk pemeriksaan.',
  CHALLENGE_RATE_LIMIT:
    'Tombol absensi ditekan terlalu cepat berturut-turut. Tunggu sekitar 15 detik, lalu tekan SATU kali dan tunggu sampai kamera terbuka.',
  DAILY_CHALLENGE_LIMIT:
    'Batas percobaan absensi hari ini sudah tercapai karena tombol tertekan terlalu sering. Hubungi admin untuk penanganan hari ini.',
  OPEN_SHIFT_EXISTS: 'Shift sebelumnya masih terbuka. Selesaikan check-out shift tersebut terlebih dahulu, baru bisa check-in lagi.',
  OPEN_SHIFT_EXPIRED: 'Shift aktif melewati batas durasi dan memerlukan koreksi administratif.',
  OPEN_SHIFT_STATE_INVALID: 'Status shift aktif tidak konsisten. Hubungi operator.',
  SHIFT_POLICY_INVALID: 'Batas durasi shift belum dikonfigurasi dengan aman oleh operator.',
  CHALLENGE_DAY_CHANGED: 'Tanggal WIB berubah saat proses check-in. Ambil selfie ulang untuk challenge baru.',
  CHALLENGE_TARGET_INVALID: 'Target shift dari server tidak valid. Mulai ulang proses absensi.',
  CHALLENGE_TARGET_STALE: 'Status shift berubah. Muat ulang dashboard lalu mulai kembali.',
  OUTSIDE_GEOFENCE: 'Posisi GPS beserta margin akurasinya berada di luar geofence.',
  OUTSIDE_OPERATIONAL_LOCATION:
    'Posisi GPS beserta margin akurasinya berada di luar lokasi operasional yang diizinkan (penugasan atau lokasi kegiatan sementara).',
  OPERATIONAL_LOCATION_UNAVAILABLE:
    'Tidak ada lokasi operasional yang dapat dipakai untuk absensi. Hubungi operator.',
  VERIFIER_OUTSIDE_GEOFENCE: 'Perangkat admin penerbit kode tidak terverifikasi di dalam geofence.',
  VERIFIER_LOCATION_INVALID: 'Lokasi admin penerbit kode sudah kedaluwarsa. Minta admin menerbitkan kode baru.',
  PRESENCE_ISSUER_INACTIVE: 'Admin penerbit kode tidak lagi aktif. Minta kode dari admin aktif.',
  COPRESENCE_UNCERTAIN: 'GPS karyawan dan admin belum membuktikan keduanya berada berdekatan. Ambil ulang GPS di area terbuka.',
  GEOFENCE_REVIEW_MISSING: 'Geofence belum direview oleh petugas kedua.',
  GEOFENCE_AUDIT_INVALID: 'Dokumen audit geofence tidak cocok; absensi ditolak demi keamanan.',
  ATTENDANCE_POLICY_CHANGED:
    'Mode absensi berubah saat proses berjalan. Mulai ulang dari awal.',
  LOCATION_PHOTO_MODE_EXPIRED:
    'Layanan check-in GPS dan foto sedang tidak tersedia. Hubungi operator.',
  ATTENDANCE_VERIFICATION_POLICY_INVALID:
    'Konfigurasi layanan absensi tidak valid. Hubungi operator.',
  CHALLENGE_POLICY_INVALID:
    'Kebijakan challenge absensi tidak valid atau sudah berubah. Mulai ulang proses.',
  ASSIGNMENT_LOCATION_MISSING:
    'Dokumen lokasi penugasan tidak ditemukan. Hubungi admin untuk memperbaiki penugasan.',
  ASSIGNMENT_LOCATION_INVALID:
    'Nama atau data lokasi penugasan tidak valid. Hubungi admin.',
  GPS_INTEGRITY_REJECTED:
    'Pola sinyal GPS tidak lolos pemeriksaan integritas. Matikan aplikasi pemalsu lokasi, aktifkan GPS perangkat, lalu ambil lokasi ulang di area terbuka.',
  GPS_TRACE_INVALID:
    'Rekaman sinyal GPS tidak valid. Muat ulang aplikasi lalu ulangi absensi.',
  GPS_TRACE_SCHEMA:
    'Versi aplikasi belum sesuai dengan pemeriksaan sinyal GPS server. Muat ulang aplikasi.',
  GPS_TRACE_STALE:
    'Rekaman sinyal GPS sudah kedaluwarsa. Ambil lokasi ulang lalu kirim kembali.',
  GPS_INTEGRITY_POLICY_INVALID:
    'Konfigurasi pemeriksaan sinyal GPS tidak valid. Hubungi operator.',
  EARLY_LEAVE_REASON_REQUIRED:
    'Alasan pulang awal wajib diisi sebelum check-out.',
  EARLY_LEAVE_REASON_INVALID:
    `Alasan pulang awal harus ${EARLY_LEAVE_REASON_MIN_LENGTH}-${EARLY_LEAVE_REASON_MAX_LENGTH} karakter.`,
};

function callableCode(error) {
  return String(error?.code || '').replace(/^functions\//, '');
}

export function getAttendanceErrorMessage(error) {
  const code = callableCode(error);
  const reason = error?.details && typeof error.details === 'object'
    ? error.details.reason
    : '';
  if (reasonMessages[reason]) return reasonMessages[reason];
  return friendlyMessages[code] || error?.message || 'Gagal memproses absensi.';
}

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
    const expiresAtMs = Date.parse(challenge.verificationModeExpiresAt);
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
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= Date.now() ||
      !hasValidAllowedLocations
    ) {
      throw new Error('Kebijakan mode lokasi dan foto dari server tidak valid.');
    }
    return;
  }
  throw new Error('Mode verifikasi absensi dari server tidak dikenali.');
}

export async function createAttendanceChallenge(action) {
  assertAction(action);
  if (!auth.currentUser) {
    throw new Error('Anda harus login untuk melakukan absensi.');
  }

  try {
    const response = await createChallengeCallable({ action });
    const challenge = response.data;
    assertChallenge(challenge, action, auth.currentUser.uid);
    return challenge;
  } catch (error) {
    const wrapped = new Error(getAttendanceErrorMessage(error));
    wrapped.code = error?.code;
    wrapped.cause = error;
    throw wrapped;
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
    const wrapped = new Error(getAttendanceErrorMessage(error));
    wrapped.code = error?.code;
    wrapped.cause = error;
    throw wrapped;
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
    const wrapped = new Error(getAttendanceErrorMessage(error));
    wrapped.code = error?.code;
    wrapped.cause = error;
    throw wrapped;
  }
}
