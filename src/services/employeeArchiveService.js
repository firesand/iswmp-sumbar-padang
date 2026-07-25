import { httpsCallable } from 'firebase/functions';
import { functions } from '../config/firebase';

const archiveEmployeeCallable = httpsCallable(
  functions,
  'adminArchiveEmployee',
  { limitedUseAppCheckTokens: true }
);

const messages = {
  unauthenticated: 'Sesi admin berakhir. Silakan login kembali.',
  'permission-denied': 'Akun ini tidak berwenang mengarsipkan karyawan.',
  'invalid-argument': 'Target atau alasan pengarsipan tidak valid.',
  'failed-precondition': 'Karyawan harus berstatus suspended dan nonaktif dahulu.',
  'not-found': 'Profil karyawan tidak ditemukan.',
};

export async function archiveEmployee(targetUserId, reason) {
  try {
    const response = await archiveEmployeeCallable({ targetUserId, reason });
    if (response.data?.success !== true || response.data?.targetUserId !== targetUserId) {
      throw new Error('Server tidak mengonfirmasi pengarsipan karyawan.');
    }
    return response.data;
  } catch (error) {
    const code = String(error?.code || '').replace(/^functions\//, '');
    const wrapped = new Error(messages[code] || error?.message || 'Arsip karyawan gagal.');
    wrapped.code = code;
    wrapped.cause = error;
    throw wrapped;
  }
}
