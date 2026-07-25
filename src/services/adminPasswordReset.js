// src/services/adminPasswordReset.js
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';

const resetPasswordCallable = httpsCallable(
  functions,
  'adminResetUserPassword',
  { limitedUseAppCheckTokens: true }
);

const generateTemporaryPassword = () => {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  const randomPart = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `${randomPart}aA1!`;
};

const wait = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds));

/**
 * Admin password reset service
 * Allows admins to reset user passwords manually
 */

/**
 * Get user by email for admin password reset
 */
export const getUserByEmail = async (email) => {
  try {
    // Note: This is a simplified approach. In a real app, you might want to
    // create an index on email field or use a different approach
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where('email', '==', email));
    const snapshot = await getDocs(q);
    
    if (snapshot.empty) {
      return { success: false, message: 'User tidak ditemukan' };
    }

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();

    return {
      success: true,
      user: {
        id: userDoc.id,
        ...userData
      }
    };
  } catch (error) {
    console.error('Get user by email error:', error);
    return { success: false, message: 'Terjadi kesalahan saat mencari user' };
  }
};

/**
 * Complete admin password reset process
 */
export const adminPasswordReset = async (email) => {
  try {
    // Get user by email
    const userResult = await getUserByEmail(email);
    
    if (!userResult.success) {
      return userResult;
    }

    const { user } = userResult;
    const requestId = globalThis.crypto.randomUUID();
    const temporaryPassword = generateTemporaryPassword();
    const payload = { targetUserId: user.id, requestId, temporaryPassword };
    let response;
    try {
      response = await resetPasswordCallable(payload);
    } catch (firstError) {
      const code = String(firstError?.code || '').replace(/^functions\//, '');
      if (!['unavailable', 'deadline-exceeded', 'internal', 'aborted'].includes(code)) {
        throw firstError;
      }
      // Retry the same request/password. The backend uses requestId as its
      // idempotency key, so a lost success response cannot create an unknown
      // credential or perform a second logical reset.
      await wait(1500);
      response = await resetPasswordCallable(payload);
    }
    if (response.data?.success !== true || response.data?.requestId !== requestId) {
      throw new Error('Server tidak mengonfirmasi reset password.');
    }

    // Return the generated password to admin for secure delivery to user
    // Admin should communicate this through a secure channel (e.g., in-person, encrypted message)
    return {
      success: true,
      message: 'Password berhasil direset. Silakan berikan password baru kepada user melalui saluran yang aman.',
      newPassword: temporaryPassword,
      resetAt: response.data?.resetAt || null,
      user
    };

  } catch (error) {
    console.error('Admin password reset error:', error);
    const code = String(error?.code || '').replace(/^functions\//, '');
    const messages = {
      unauthenticated: 'Sesi admin berakhir. Silakan login kembali.',
      'permission-denied': 'Akun admin tidak aktif atau tidak berwenang mereset password.',
      'failed-precondition': 'Password akun ini tidak dapat direset.',
      'not-found': 'Akun Firebase Auth tidak ditemukan.',
    };
    return {
      success: false,
      message: messages[code] || error?.message || 'Terjadi kesalahan saat reset password',
    };
  }
};

/**
 * Get password reset history for a user
 */
export const getPasswordResetHistory = async (userId) => {
  try {
    const userDoc = await getDoc(doc(db, 'users', userId));
    
    if (!userDoc.exists()) {
      return { success: false, message: 'User tidak ditemukan' };
    }

    const userData = userDoc.data();
    
    return {
      success: true,
      resetHistory: {
        lastReset: userData.passwordResetAt,
        resetBy: userData.passwordResetBy,
        mustChangePassword: userData.mustChangePassword || false
      }
    };
  } catch (error) {
    console.error('Get password reset history error:', error);
    return { success: false, message: 'Gagal mengambil riwayat reset password' };
  }
};

export default {
  getUserByEmail,
  adminPasswordReset,
  getPasswordResetHistory
};
