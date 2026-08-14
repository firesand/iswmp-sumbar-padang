// Firebase Web App credentials — ISWMP SumBar-Padang
// IMPORTANT: These credentials are public by design (standard Firebase Web SDK).
// Security is enforced via Firestore Rules, Storage Rules, and Firebase Authentication.
// DO NOT commit actual production credentials to version control.
// Use environment variables (.env.local) instead.
// Source: Firebase Console → Project settings → ISWMP SumBar-Padang Web

const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};

export const FIREBASE_CREDENTIALS = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSyCS0zQzf22j4ttDA6pYeOlrNxaacZ7Cqk4',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'iswmp-sumbar-padang.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'iswmp-sumbar-padang',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'iswmp-sumbar-padang.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '1079074812491',
  appId: env.VITE_FIREBASE_APP_ID || '1:1079074812491:web:28a1a3fa33933c5ca9d3ce',
};
