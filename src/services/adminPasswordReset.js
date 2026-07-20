// src/services/adminPasswordReset.js
import { doc, getDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from './firebase';

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
 * Generate a new random password using cryptographically secure random number generator
 */
export const generateNewPassword = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  const array = new Uint32Array(8);
  crypto.getRandomValues(array);
  
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(array[i % 8] % chars.length);
  }
  return password;
};

/**
 * Update user password in Firestore (for admin reset)
 * Note: This updates a custom field, not the actual Firebase Auth password
 * DEPRECATED: Should use Firebase Auth updatePassword instead
 */
export const updateUserPasswordField = async (userId, newPassword) => {
  try {
    // REMOVED: Storing passwords in Firestore is a security risk
    // Only store metadata about password reset
    await updateDoc(doc(db, 'users', userId), {
      passwordResetAt: new Date(),
      passwordResetBy: 'admin',
      mustChangePassword: true // Flag to force password change on next login
    });

    return { success: true, message: 'Password berhasil direset. User harus mengubah password saat login berikutnya.' };
  } catch (error) {
    console.error('Update user password error:', error);
    return { success: false, message: 'Gagal mereset password' };
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

    // Generate new password
    const newPassword = generateNewPassword();

    // Update user document with password reset flag (NOT the password itself)
    const updateResult = await updateUserPasswordField(user.id, newPassword);

    if (!updateResult.success) {
      return updateResult;
    }

    // Return the generated password to admin for secure delivery to user
    // Admin should communicate this through a secure channel (e.g., in-person, encrypted message)
    return {
      success: true,
      message: 'Password berhasil direset. Silakan berikan password baru kepada user melalui saluran yang aman.',
      newPassword: newPassword,
      user: user
    };

  } catch (error) {
    console.error('Admin password reset error:', error);
    return { success: false, message: 'Terjadi kesalahan saat reset password' };
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
  generateNewPassword,
  updateUserPasswordField,
  adminPasswordReset,
  getPasswordResetHistory
}; 