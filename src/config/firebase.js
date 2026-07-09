// src/config/firebase.js
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { FIREBASE_CREDENTIALS } from './firebase.credentials.js';

// Env vars override credentials (production/Vercel); fallback ke credentials file
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || FIREBASE_CREDENTIALS.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || FIREBASE_CREDENTIALS.authDomain,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || FIREBASE_CREDENTIALS.projectId,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || FIREBASE_CREDENTIALS.storageBucket,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || FIREBASE_CREDENTIALS.messagingSenderId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || FIREBASE_CREDENTIALS.appId,
};

if (import.meta.env.DEV) {
  console.log('🔥 Firebase project:', firebaseConfig.projectId);
}

// Initialize Firebase (reuse existing app if already initialized)
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

let storage;
try {
  storage = getStorage(app);
} catch (storageError) {
  console.warn('⚠️ Firebase Storage initialization failed:', storageError);
  storage = {
    app,
    bucket: firebaseConfig.storageBucket,
    ref: () => Promise.reject(new Error('Storage not available')),
    uploadBytes: () => Promise.reject(new Error('Storage not available')),
    getDownloadURL: () => Promise.reject(new Error('Storage not available')),
  };
}

export { storage };
export const OFFICE_CONFIG = null;
export default app;
