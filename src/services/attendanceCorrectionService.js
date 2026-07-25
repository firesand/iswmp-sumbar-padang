import { httpsCallable } from 'firebase/functions';
import { functions } from '../config/firebase';

const proposeCallable = httpsCallable(
  functions,
  'proposeMissingCheckoutCorrection',
  {limitedUseAppCheckTokens: true}
);
const reviewCallable = httpsCallable(
  functions,
  'reviewAttendanceCorrection',
  {limitedUseAppCheckTokens: true}
);

const reasonMessages = {
  ADMIN_REQUIRED: 'Hanya admin aktif yang dapat memproses koreksi.',
  APP_CHECK_REQUIRED: 'Aplikasi admin tidak dapat diverifikasi.',
  APP_CHECK_REPLAY: 'Token keamanan sudah digunakan. Ulangi tindakan.',
  ATTENDANCE_ALREADY_CORRECTED: 'Absensi ini sudah memiliki koreksi yang disetujui.',
  ATTENDANCE_CHANGED: 'Catatan absensi berubah setelah proposal dibuat.',
  ATTENDANCE_NOT_ELIGIBLE: 'Catatan bukan check-in Verified v2 yang masih terbuka.',
  CHECKOUT_TIME_OUT_OF_RANGE: 'Waktu koreksi harus sesudah check-in, tidak di masa depan, dan masih dalam batas shift.',
  CORRECTION_BASE_CHANGED: 'Sumber koreksi berubah; buat proposal baru.',
  CORRECTION_POLICY_CHANGED: 'Kebijakan durasi shift berubah; buat proposal baru.',
  OPEN_SHIFT_CHANGED: 'Status shift aktif berubah; muat ulang data.',
  PROPOSAL_ALREADY_REVIEWED: 'Proposal ini sudah direview.',
  PROPOSAL_EXPIRED: 'Proposal sudah kedaluwarsa. Buat proposal baru.',
  SAME_REVIEWER: 'Pemohon tidak boleh mereview proposalnya sendiri. Gunakan admin kedua.',
  SHIFT_POLICY_INVALID: 'Batas durasi shift belum dikonfigurasi dengan aman.',
};

const correctionErrorMessage = (error) => {
  const reason =
    error?.details && typeof error.details === 'object'
      ? error.details.reason
      : '';
  return reasonMessages[reason] ||
    error?.message ||
    'Koreksi absensi gagal diproses.';
};

const wrapError = (error) => {
  const wrapped = new Error(correctionErrorMessage(error));
  wrapped.code = error?.code;
  wrapped.reason = error?.details?.reason;
  wrapped.cause = error;
  return wrapped;
};

export async function proposeMissingCheckoutCorrection({
  attendanceId,
  checkOutAt,
  reason,
}) {
  try {
    const checkOutDate =
      checkOutAt instanceof Date ? checkOutAt : new Date(checkOutAt);
    if (
      typeof attendanceId !== 'string' ||
      !attendanceId ||
      Number.isNaN(checkOutDate.getTime()) ||
      typeof reason !== 'string'
    ) {
      throw new Error('Data proposal koreksi tidak valid.');
    }
    const response = await proposeCallable({
      attendanceId,
      checkOutAt: checkOutDate.toISOString(),
      reason: reason.trim(),
    });
    if (
      response.data?.success !== true ||
      typeof response.data?.proposalId !== 'string'
    ) {
      throw new Error('Server tidak mengembalikan proposal yang valid.');
    }
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}

export async function reviewAttendanceCorrection(proposalId, decision) {
  try {
    if (
      typeof proposalId !== 'string' ||
      !proposalId ||
      !['approve', 'reject'].includes(decision)
    ) {
      throw new Error('Permintaan review koreksi tidak valid.');
    }
    const response = await reviewCallable({proposalId, decision});
    if (
      response.data?.success !== true ||
      response.data?.status !==
        (decision === 'approve' ? 'approved' : 'rejected')
    ) {
      throw new Error('Server tidak mengembalikan keputusan yang valid.');
    }
    return response.data;
  } catch (error) {
    throw wrapError(error);
  }
}
