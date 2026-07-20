/**
 * Firestore Script: Delete all tempPassword fields from users collection
 * 
 * Usage: 
 * 1. Install firebase-tools: npm install -g firebase-tools
 * 2. Login: firebase login
 * 3. Run: firebase firestore:delete --all-collections (NOT RECOMMENDED)
 * 
 * Instead, use this script with Firebase Admin SDK:
 * 1. Save this file
 * 2. Run: node deleteTempPasswords.mjs
 * 
 * IMPORTANT: This requires Firebase Admin SDK setup with service account credentials
 */

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Check if already initialized
if (!getApps().length) {
  // You need to download your service account key from Firebase Console
  // Project Settings > Service Accounts > Generate New Private Key
  // Save it as serviceAccountKey.json in the project root (DO NOT COMMIT!)
  
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  
  if (!serviceAccount.project_id) {
    console.error('❌ Error: Firebase service account credentials not found.');
    console.error('Please set FIREBASE_SERVICE_ACCOUNT environment variable with your service account JSON.');
    console.error('\nSteps to get service account credentials:');
    console.error('1. Go to Firebase Console → Project Settings');
    console.error('2. Click "Service Accounts" tab');
    console.error('3. Click "Generate New Private Key"');
    console.error('4. Save the JSON file securely');
    console.error('5. Set env var: export FIREBASE_SERVICE_ACCOUNT=\'{...json content...}\'');
    process.exit(1);
  }
  
  initializeApp({
    credential: cert(serviceAccount),
  });
}

const db = getFirestore();

async function deleteTempPasswords() {
  console.log('🔍 Searching for users with tempPassword field...\n');
  
  try {
    const usersSnapshot = await db.collection('users').get();
    
    if (usersSnapshot.empty) {
      console.log('ℹ️  No users found in the database.');
      return;
    }
    
    let updatedCount = 0;
    const batch = db.batch();
    
    for (const doc of usersSnapshot.docs) {
      const data = doc.data();
      
      if (data.tempPassword) {
        console.log(`📝 Found tempPassword in user: ${doc.id} (${data.email || data.displayName || 'unknown'})`);
        
        // Remove tempPassword field
        const userRef = db.collection('users').doc(doc.id);
        batch.update(userRef, { tempPassword: null });
        
        // Also delete the field using FieldValue.delete() approach
        // We'll do a separate update for field deletion
        updatedCount++;
      }
    }
    
    if (updatedCount === 0) {
      console.log('✅ No tempPassword fields found. Database is clean!');
      return;
    }
    
    // Commit the batch (setting to null first)
    await batch.commit();
    
    // Now actually delete the fields with a second pass
    console.log(`\n🗑️  Deleting ${updatedCount} tempPassword fields...`);
    
    for (const doc of usersSnapshot.docs) {
      const data = doc.data();
      
      if (data.tempPassword !== undefined) {
        const userRef = db.collection('users').doc(doc.id);
        await userRef.update({ tempPassword: null });
        // Use string field path to actually delete the field
        await userRef.update({ ['tempPassword']: null });
      }
    }
    
    console.log(`\n✅ Successfully processed ${updatedCount} users.`);
    console.log('⚠️  Note: Setting to null may not fully delete the field.');
    console.log('To completely remove fields, use Firebase Console or gcloud CLI:');
    console.log('  gcloud firestore documents patch users/USER_ID --update-mask=""');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Alternative: Using gcloud CLI command generator
function generateGcloudCommands() {
  console.log('\n📋 Alternative: Use these gcloud commands to delete fields:');
  console.log('firebase firestore:delete --collection-path users --field-paths tempPassword --recursive');
}

deleteTempPasswords()
  .then(() => {
    generateGcloudCommands();
    console.log('\n✨ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
