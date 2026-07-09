// Re-export single Firebase instance (avoid duplicate init)
export { auth, db, storage, default } from '../config/firebase.js';
