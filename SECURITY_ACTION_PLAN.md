# P0 Security Fixes - Action Plan

## ✅ Completed (Code Changes)

### 1. Password Storage Fix
- **File**: `/workspace/src/services/adminPasswordReset.js`
- **Change**: Removed `tempPassword` field from Firestore writes
- **Status**: ✅ Complete

### 2. Cryptographically Secure Password Generation
- **File**: `/workspace/src/services/adminPasswordReset.js`
- **Change**: Replaced `Math.random()` with `crypto.getRandomValues()`
- **Status**: ✅ Complete

### 3. Environment Variable Support
- **File**: `/workspace/src/config/firebase.credentials.js`
- **Change**: Added environment variable fallbacks for all Firebase credentials
- **Status**: ✅ Complete

### 4. Enhanced Firestore Security Rules
- **File**: `/workspace/firestore.rules`
- **Changes**:
  - Added field validation functions (`isValidUserCreate`, `isValidUserUpdate`)
  - Restricted allowed fields in user documents
  - Added default deny rule for unmatched collections
  - Field-level validation for all collections
- **Status**: ✅ Complete

### 5. Created .env.local Template
- **File**: `/workspace/.env.local`
- **Status**: ✅ Complete (with placeholder values)

### 6. Created Database Cleanup Script
- **File**: `/workspace/scripts/deleteTempPasswords.mjs`
- **Status**: ✅ Complete

---

## 🔧 Required Manual Actions

### Action 1: Delete Existing tempPassword Fields from Firestore

**Option A: Using Firebase Console (Recommended for small datasets)**
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: `iswmp-sumbar-padang`
3. Navigate to **Firestore Database**
4. Click on the `users` collection
5. For each document that has a `tempPassword` field:
   - Click on the document
   - Find the `tempPassword` field
   - Click the trash icon next to it to delete the field
   - Save the document

**Option B: Using the Provided Script (For larger datasets)**
```bash
# 1. Install dependencies
npm install firebase-admin

# 2. Get service account credentials:
#    - Go to Firebase Console → Project Settings
#    - Click "Service Accounts" tab
#    - Click "Generate New Private Key"
#    - Save the JSON file securely (DO NOT COMMIT!)

# 3. Set environment variable
export FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'

# 4. Run the script
node scripts/deleteTempPasswords.mjs
```

**Option C: Using Firebase CLI**
```bash
# Install Firebase CLI
npm install -g firebase-tools

# Login
firebase login

# Deploy updated rules first
firebase deploy --only firestore:rules

# Note: There's no direct CLI command to delete specific fields from all documents
# You'll need to use the Console or the Admin SDK script above
```

---

### Action 2: Rotate Firebase Credentials

**Steps:**
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: `iswmp-sumbar-padang`
3. Click **Project Settings** (gear icon)
4. Go to **Service Accounts** tab
5. Scroll to "Firebase Admin SDK" section
6. Click **"Generate New Private Key"**
7. Download the JSON file and save it securely
8. **Important**: The old credentials will still work until you regenerate them
9. To fully rotate, you may need to:
   - Go to Google Cloud Console
   - Navigate to APIs & Services → Credentials
   - Find and delete old API keys
   - Create new ones

**Update Your .env.local:**
```bash
# Edit /workspace/.env.local with NEW credentials
VITE_FIREBASE_API_KEY=new_api_key_here
# ... update all other fields
```

---

### Action 3: Configure .env.local with Actual Credentials

**Steps:**
1. Open `/workspace/.env.local`
2. Replace placeholder values with your actual Firebase credentials:
   ```
   VITE_FIREBASE_API_KEY=your_actual_api_key
   VITE_FIREBASE_AUTH_DOMAIN=iswmp-sumbar-padang.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=iswmp-sumbar-padang
   VITE_FIREBASE_STORAGE_BUCKET=iswmp-sumbar-padang.appspot.com
   VITE_FIREBASE_MESSAGING_SENDER_ID=1079074812491
   VITE_FIREBASE_APP_ID=1:1079074812491:web:28a1a3fa33933c5ca9d3ce
   ```
3. Save the file
4. **Verify .gitignore includes `.env.local`** (already configured)

---

### Action 4: Deploy Updated Firestore Security Rules

**Steps:**
```bash
# 1. Install Firebase CLI if not already installed
npm install -g firebase-tools

# 2. Login to Firebase
firebase login

# 3. Deploy the updated rules
firebase deploy --only firestore:rules
```

**Verify Deployment:**
1. Go to Firebase Console → Firestore Database → Rules
2. Verify the new rules are active
3. Test with the Rules Playground

---

## 📋 Verification Checklist

After completing all actions:

- [ ] No `tempPassword` fields exist in Firestore `users` collection
- [ ] Firebase credentials have been rotated
- [ ] `.env.local` contains actual credentials (not placeholders)
- [ ] `.env.local` is NOT committed to git
- [ ] Updated Firestore rules are deployed
- [ ] Application still works correctly with new setup
- [ ] Test password reset functionality
- [ ] Verify users cannot write unauthorized fields

---

## 🔒 Additional Security Recommendations

### Short-term (Next Sprint)
1. **Implement rate limiting** on authentication attempts
2. **Add input sanitization** before all database writes
3. **Enable Firebase App Check** to prevent unauthorized clients
4. **Set up security alerting** in Firebase Console

### Medium-term (Next Month)
1. **Migrate to Firebase Authentication** for password management
2. **Implement proper password reset flow** with email verification
3. **Add audit logging** for sensitive operations
4. **Review and restrict CORS policies**

### Long-term (Quarterly)
1. **Regular security audits**
2. **Penetration testing**
3. **Dependency vulnerability scanning**
4. **Security training for development team**

---

## 📞 Support

If you encounter issues:
- Firebase Documentation: https://firebase.google.com/docs
- Firestore Rules Reference: https://firebase.google.com/docs/rules
- Security Best Practices: https://firebase.google.com/docs/security

---

**Generated**: $(date)
**Files Modified**: 5
**Scripts Created**: 1
