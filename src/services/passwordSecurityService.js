import { httpsCallable } from 'firebase/functions';
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { auth, functions } from '../config/firebase';

const changeTemporaryPasswordCallable = httpsCallable(
  functions,
  'changeTemporaryPassword',
  { limitedUseAppCheckTokens: true }
);

export const changeTemporaryPassword = async (temporaryPassword, newPassword) => {
  const user = auth.currentUser;
  if (!user?.email) {
    throw new Error('Sesi login tidak memiliki email yang dapat diautentikasi ulang.');
  }
  const credential = EmailAuthProvider.credential(user.email, temporaryPassword);
  await reauthenticateWithCredential(user, credential);
  // Force the callable to receive the newly reauthenticated ID token. The
  // backend independently checks revocation and auth_time before changing it.
  await user.getIdToken(true);
  const response = await changeTemporaryPasswordCallable({ newPassword });
  if (response.data?.success !== true) {
    throw new Error('Server tidak mengonfirmasi perubahan password.');
  }
  return response.data;
};
