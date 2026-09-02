// Pemetaan kegagalan absensi callable menjadi pesan yang bisa ditindaklanjuti
// pengguna. Dipisahkan dari attendanceService agar bebas dari Firebase SDK dan
// dapat diuji langsung dengan `node --test`.

export const EARLY_LEAVE_REASON_MIN_LENGTH = 5;
export const EARLY_LEAVE_REASON_MAX_LENGTH = 300;

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
  EARLY_LEAVE_REASON_NOT_ALLOWED:
    'Alasan pulang awal hanya berlaku untuk check-out. Muat ulang aplikasi lalu ulangi.',
  EARLY_LEAVE_STATE_INVALID:
    'Status pulang awal tidak konsisten. Muat ulang dashboard lalu ulangi check-out.',

  // Urutan shift. Ini penyebab kegagalan check-out yang paling sering
  // dilaporkan pengguna, dan sebelumnya semuanya tampil sebagai pesan generik.
  CHECK_IN_REQUIRED:
    'Tidak ada shift aktif yang bisa di-check-out. Pastikan check-in hari ini sudah tercatat, lalu muat ulang dashboard dan coba lagi.',
  ALREADY_CHECKED_OUT:
    'Shift ini sudah memiliki check-out. Muat ulang dashboard untuk melihat data terbaru.',
  ALREADY_CHECKED_IN:
    'Check-in hari ini sudah tercatat. Muat ulang dashboard untuk melihat data terbaru.',
  UNVERIFIED_CHECK_IN:
    'Check-in shift ini belum lengkap terverifikasi sehingga check-out tidak dapat diproses. Hubungi admin untuk koreksi absensi.',
  ATTENDANCE_NOT_FOUND:
    'Data absensi tidak ditemukan. Muat ulang dashboard lalu coba lagi.',

  // Siklus hidup challenge.
  CHALLENGE_NOT_FOUND:
    'Sesi absensi tidak ditemukan atau sudah kedaluwarsa. Mulai ulang dari tombol absensi.',
  CHALLENGE_EXPIRED:
    'Sesi absensi kedaluwarsa. Ambil selfie lebih cepat setelah menekan tombol absensi.',
  CHALLENGE_CONSUMED:
    'Sesi absensi ini sudah dipakai. Mulai ulang dari tombol absensi.',
  CHALLENGE_SUPERSEDED:
    'Tombol absensi ditekan lebih dari sekali sehingga sesi sebelumnya dibatalkan. Ulangi dan tekan tombol SATU kali.',
  CHALLENGE_MISMATCH:
    'Sesi absensi bukan milik akun ini. Logout lalu login kembali.',
  CHALLENGE_SUBMIT_LIMIT:
    'Batas percobaan untuk sesi absensi ini tercapai. Mulai ulang dari tombol absensi.',
  SUBMIT_RATE_LIMIT:
    'Pengiriman absensi terlalu cepat berturut-turut. Tunggu sekitar 15 detik lalu coba lagi.',
  DAILY_SUBMIT_LIMIT:
    'Batas percobaan absensi hari ini sudah tercapai. Hubungi admin untuk penanganan hari ini.',

  // Bukti foto.
  PHOTO_MISSING:
    'Foto bukti belum terunggah. Ambil selfie ulang lalu kirim kembali.',
  PHOTO_INVALID:
    'Berkas foto tidak valid. Ambil selfie baru langsung dari kamera aplikasi.',
  PHOTO_METADATA:
    'Metadata foto tidak sesuai ketentuan. Ambil selfie baru langsung dari kamera aplikasi.',
  PHOTO_SIZE:
    'Ukuran berkas foto tidak sesuai ketentuan. Ambil selfie ulang dari kamera aplikasi.',
  PHOTO_DIMENSIONS:
    'Resolusi foto tidak sesuai ketentuan. Ambil selfie ulang dari kamera aplikasi.',
  PHOTO_STALE:
    'Foto sudah terlalu lama sejak diambil. Ambil selfie baru lalu segera kirim.',
  PHOTO_BINDING:
    'Foto yang diunggah tidak cocok dengan sesi absensi ini. Ulangi absensi dari awal.',
  PHOTO_CHANGED:
    'Foto berubah setelah diunggah. Ulangi absensi dari awal.',
  PHOTO_VERSION_MISMATCH:
    'Versi berkas foto tidak cocok dengan sesi absensi ini. Ulangi absensi dari awal.',
  PHOTO_NOT_FOUND:
    'Foto bukti tidak ditemukan di server. Ulangi absensi dari awal.',
  PHOTO_ACCESS_DENIED:
    'Akun ini tidak berhak membuka foto bukti tersebut.',

  // Lokasi. LOCATION_ACCURACY sengaja tidak dipetakan: pesan server memuat
  // ambang meter yang berlaku, dan pesan statis di sini akan menghapusnya.
  LOCATION_STALE:
    'Data GPS sudah kedaluwarsa. Ambil lokasi ulang lalu kirim kembali.',
  INVALID_LOCATION:
    'Koordinat GPS tidak valid. Aktifkan GPS lalu ambil lokasi ulang di area terbuka.',
  INVALID_LOCATION_SOURCE:
    'Sumber lokasi tidak diizinkan. Gunakan GPS perangkat, bukan lokasi manual atau aplikasi pemalsu lokasi.',

  // Akun dan penugasan.
  AUTH_REQUIRED:
    'Sesi login berakhir. Login kembali lalu ulangi absensi.',
  ACCOUNT_INACTIVE:
    'Akun ini tidak aktif. Hubungi admin untuk mengaktifkan kembali.',
  ROLE_NOT_ALLOWED:
    'Akun admin tidak dapat melakukan absensi. Gunakan akun karyawan.',
  PASSWORD_CHANGE_REQUIRED:
    'Password sementara harus diganti sebelum melakukan absensi. Ganti password lalu ulangi.',
  PROFILE_MISSING:
    'Profil pengguna tidak ditemukan. Hubungi admin.',
  ASSIGNMENT_MISSING:
    'Penugasan lokasi belum dikonfigurasi untuk akun ini. Hubungi admin.',
  ASSIGNMENT_CHOICE_INVALID:
    'Lokasi absensi yang dipilih tidak tersedia untuk akun ini. Mulai ulang proses absensi.',
  ASSIGNMENT_CHANGED:
    'Penugasan lokasi berubah saat proses berjalan. Mulai ulang dari awal.',

  // Geofence.
  GEOFENCE_MISSING:
    'Data geofence lokasi tidak ditemukan. Hubungi admin.',
  GEOFENCE_INACTIVE:
    'Geofence penugasan belum aktif dan terverifikasi. Hubungi admin.',
  GEOFENCE_UNVERIFIED:
    'Geofence penugasan belum diverifikasi petugas. Hubungi admin.',
  GEOFENCE_AUDIT_MISSING:
    'Dokumen audit geofence tidak ditemukan. Hubungi admin.',

  // Kode kehadiran onsite.
  PRESENCE_CODE_REQUIRED:
    'Kode kehadiran onsite 6 digit wajib diisi. Minta kode dari admin di lokasi.',
  PRESENCE_CODE_INVALID:
    'Kode kehadiran salah atau sudah kedaluwarsa. Minta kode baru dari admin di lokasi.',
  PRESENCE_CODE_UNAVAILABLE:
    'Kode kehadiran belum diterbitkan admin. Minta admin menerbitkan kode terlebih dahulu.',
  PRESENCE_PROOF_REQUIRED:
    'Bukti kehadiran bersama admin belum lengkap. Minta kode baru dari admin di lokasi.',

  // Verifikasi aplikasi dan perangkat.
  APP_CHECK_REQUIRED:
    'Aplikasi belum terverifikasi. Muat ulang aplikasi; jika masih gagal, pasang versi terbaru.',
  APP_CHECK_REPLAY:
    'Token verifikasi aplikasi sudah dipakai. Muat ulang aplikasi lalu ulangi absensi.',
  APP_INSTANCE_MISMATCH:
    'Sesi absensi dimulai dari instalasi aplikasi lain. Mulai ulang absensi di perangkat ini.',
  DEVICE_INTEGRITY_INVALID:
    'Pemeriksaan integritas perangkat gagal. Perbarui aplikasi ke versi terbaru lalu ulangi.',
  DEVICE_INTEGRITY_SCHEMA:
    'Versi aplikasi belum sesuai dengan pemeriksaan integritas perangkat. Perbarui aplikasi lalu ulangi.',

  INTERNAL_ERROR:
    'Layanan absensi gagal memproses permintaan. Coba lagi beberapa saat; jika berulang, laporkan kode ini ke admin.',
};

function callableCode(error) {
  return String(error?.code || '').replace(/^functions\//, '');
}

// Callables carry the reason in `details`; errors already wrapped by this
// module carry it directly, so a second pass in a component still sees it.
export function getAttendanceErrorReason(error) {
  const fromDetails = error?.details && typeof error.details === 'object'
    ? error.details.reason
    : '';
  const reason = fromDetails || error?.reason || '';
  return typeof reason === 'string' ? reason : '';
}

// The reason and the code both arrive from the network, so a value such as
// "constructor" must not resolve to something off Object.prototype.
function lookupMessage(table, key) {
  if (!key || !Object.prototype.hasOwnProperty.call(table, key)) return '';
  const message = table[key];
  return typeof message === 'string' ? message : '';
}

// A reason means the message was produced by our own callable, so it is
// already specific and in Indonesian. Preferring the generic per-code text
// over it is what made every check-out failure read the same to the user.
function serverProvidedMessage(error, code) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (!message || message === code) return '';
  return message;
}

// Users report "error saat check out" with nothing an operator can act on.
// The reason code is the one token that turns a complaint into a lookup in
// the attendance security log, so it travels with every server-side failure.
function withDiagnosticCode(message, diagnosticCode) {
  if (!diagnosticCode) return message;
  if (message.includes(`(Kode: ${diagnosticCode})`)) return message;
  return `${message} (Kode: ${diagnosticCode})`;
}

export function getAttendanceErrorMessage(error) {
  // Wrapping resolves the message once, where `details` is still intact.
  // Re-resolving here would drop the reason and re-append the code.
  if (error?.attendanceMessageResolved === true &&
      typeof error.message === 'string' &&
      error.message) {
    return error.message;
  }

  const code = callableCode(error);
  const reason = getAttendanceErrorReason(error);
  const message = lookupMessage(reasonMessages, reason) ||
    (reason ? serverProvidedMessage(error, code) : '') ||
    lookupMessage(friendlyMessages, code) ||
    (typeof error?.message === 'string' && error.message ? error.message : '') ||
    'Gagal memproses absensi.';
  // DOMException dari kamera membawa `code` numerik warisan (mis. 8) yang tidak
  // berarti apa-apa bagi operator, jadi hanya kode simbolik yang ditampilkan.
  const diagnosticCode = reason || (/^\d+$/.test(code) ? '' : code);
  return withDiagnosticCode(message, diagnosticCode);
}

export function wrapAttendanceError(error) {
  const wrapped = new Error(getAttendanceErrorMessage(error));
  wrapped.code = error?.code;
  wrapped.reason = getAttendanceErrorReason(error);
  wrapped.attendanceMessageResolved = true;
  wrapped.cause = error;
  return wrapped;
}
