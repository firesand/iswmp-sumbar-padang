// Re-export single Firebase instance (avoid duplicate init)
export { appCheck, auth, db, functions, storage, default } from '../config/firebase.js';
