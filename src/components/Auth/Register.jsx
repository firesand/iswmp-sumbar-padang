// src/components/Auth/Register.jsx
import { useState } from 'react';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { auth, db, storage } from '../../config/firebase';
import { useNavigate } from 'react-router-dom';
import { getCurrentLocation } from '../../utils/geolocation';
import { checkGeolocationPermission } from '../../utils/geolocationPermissions';
import { tryMobileNavigation } from '../../utils/mobileWhiteScreenFix.js';
import { handleProductionNavigation } from '../../utils/productionFix.js';
import { aggressiveProductionFix } from '../../utils/aggressiveProductionFix.js';
import { cspErrorHandler } from '../../utils/cspErrorHandler.js';
import { KELURAHAN_SEED } from '../../data/seedData.js';
import { FIELD_STAFF_TYPES, OFFICE_STAFF_ROLES } from '../../services/geofenceService.js';
import { PROJECT } from '../../config/projectConfig.js';
import ProjectBrandHeader from '../Common/ProjectBrandHeader.jsx';

function Register() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    phone: '',
    nik: '',
    address: '',
    staffCategory: '',       // 'field_staff' | 'office_staff'
    kelurahanId: '',
    jenisTenagaAhli: '',     // TA_PERSAMP | TA_KELEMBAGAAN
    peranKantor: '',         // KORKOT | ASMAN_DATA | OPERATOR | OFFICE_BOY
  });
  const [photo, setPhoto] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showRecovery, setShowRecovery] = useState(false);
  const [registrationStep, setRegistrationStep] = useState('form'); // 'form', 'processing', 'success', 'error'

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handlePhotoChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) { // 5MB limit
        alert('Ukuran foto maksimal 5MB');
        return;
      }
      setPhoto(file);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (isSubmitting) {
      console.log('Registration already in progress, ignoring duplicate submit');
      return;
    }

    // Validation
    if (formData.password !== formData.confirmPassword) {
      setError('Password tidak cocok');
      return;
    }

    if (formData.password.length < 6) {
      setError('Password minimal 6 karakter');
      return;
    }

    if (!formData.staffCategory) {
      setError('Pilih kategori penugasan (Lapangan atau Kantor)');
      return;
    }

    if (formData.staffCategory === 'field_staff') {
      if (!formData.kelurahanId || !formData.jenisTenagaAhli) {
        setError('Pilih kelurahan penugasan dan jenis tenaga ahli');
        return;
      }
    }

    if (formData.staffCategory === 'office_staff' && !formData.peranKantor) {
      setError('Pilih peran kantor');
      return;
    }

    const selectedKelurahan = KELURAHAN_SEED.find((k) => k.id === formData.kelurahanId);

    setError('');
    setLoading(true);
    setIsSubmitting(true);
    setRegistrationStep('processing');
    let createdNewAuthUser = false;
    let recoveringIncompleteRegistration = false;

    try {
      console.log('🚀 Starting registration process...');

      // Lokasi opsional saat registrasi — tidak boleh pakai koordinat palsu
      let location = null;
      try {
        const permission = await checkGeolocationPermission();
        console.log('📍 Permission status:', permission);

        location = await getCurrentLocation();
        console.log('📍 Location obtained:', location);
      } catch (locationError) {
        console.warn('❌ Location tidak tersedia saat registrasi:', locationError.message);
        location = {
          lat: null,
          lng: null,
          accuracy: null,
          source: 'unavailable',
          error: locationError.message,
        };
      }

      // Create Firebase user
      console.log('👤 Creating Firebase user...');
      let user;
      try {
        const userCredential = await createUserWithEmailAndPassword(
          auth,
          formData.email,
          formData.password
        );
        user = userCredential.user;
        createdNewAuthUser = true;
        console.log('✅ Firebase user created:', user.uid);
      } catch (authError) {
        if (authError.code !== 'auth/email-already-in-use') {
          throw authError;
        }

        // Registrations attempted while the July 20 rules were broken may
        // have an Auth account but no Firestore profile. Verify ownership with
        // the original password, then safely finish that registration.
        console.warn('⚠️ Existing email detected; checking incomplete registration...');
        const existingCredential = await signInWithEmailAndPassword(
          auth,
          formData.email,
          formData.password
        );
        user = existingCredential.user;

        const existingUserDoc = await getDoc(doc(db, 'users', user.uid));
        if (existingUserDoc.exists()) {
          await auth.signOut();
          throw authError;
        }

        recoveringIncompleteRegistration = true;
        console.log('✅ Incomplete registration verified and ready for recovery:', user.uid);
      }

      // Upload photo if provided (with comprehensive CSP error handling)
      let photoURL = '';
      if (photo) {
        console.log('📸 Uploading photo...');

        // Use CSP error handler to wrap storage operation
        const uploadResult = await cspErrorHandler.wrapStorageOperation(
          async () => {
            const photoRef = ref(storage, `profiles/${user.uid}/${photo.name}`);
            const snapshot = await uploadBytes(photoRef, photo);
            const url = await getDownloadURL(snapshot.ref);
            console.log('✅ Photo uploaded:', url);
            return url;
          },
          '' // Fallback: empty string (no photo)
        );

        photoURL = uploadResult || '';

        if (!photoURL) {
          console.log('⚠️ Photo upload failed or blocked by CSP, continuing without photo');
        }
      }

      // Update profile
      console.log('👤 Updating profile...');
      await updateProfile(user, {
        displayName: formData.name,
        photoURL: photoURL
      });
      console.log('✅ Profile updated');

      // Create user document
      console.log('📄 Creating user document...');
      const userData = {
        uid: user.uid,
        name: formData.name,
        email: formData.email,
        phone: formData.phone,
        phoneNumber: formData.phone,
        nik: formData.nik,
        address: formData.address,
        photoURL: photoURL,
        role: formData.staffCategory,
        accountStatus: 'pending',
        isActive: false,
        provinsi: 'Sumatera Barat',
        kota: 'Padang',
        createdAt: serverTimestamp(),
        location: location,
        lastLogin: serverTimestamp(),
        ...(formData.staffCategory === 'field_staff' ? {
          assignmentType: 'kelurahan',
          kelurahanId: formData.kelurahanId,
          kelurahanNama: selectedKelurahan?.nama || '',
          jenisTenagaAhli: formData.jenisTenagaAhli,
        } : {
          assignmentType: 'kantor',
          kantorId: 'kantor-padang-kota',
          peranKantor: formData.peranKantor,
        }),
      };

      // Keep registration requests minimal. Full applicant details live in the
      // users collection and are joined by the admin dashboard.
      console.log('📋 Creating registration request...');
      const registrationData = {
        userId: user.uid,
        requestedBy: user.uid,
        requestedAt: serverTimestamp(),
        status: 'pending',
      };

      // Both documents must succeed together. Never show a success message if
      // the admin approval request was rejected by Firestore rules.
      const registrationBatch = writeBatch(db);
      registrationBatch.set(doc(db, 'users', user.uid), userData);
      registrationBatch.set(doc(db, 'registrationRequests', user.uid), registrationData);
      await registrationBatch.commit();
      console.log('✅ User document and registration request created');

      // SUCCESS - Show success state and handle navigation properly
      console.log('✅ Registration completed successfully');
      setRegistrationStep('success');

      // Clear loading states immediately
      setLoading(false);
      setIsSubmitting(false);

      // Show success message
      try {
        alert(
          recoveringIncompleteRegistration
            ? 'Registrasi sebelumnya berhasil dipulihkan! Akun Anda sekarang menunggu persetujuan admin.'
            : 'Registrasi berhasil! Akun Anda sedang menunggu persetujuan admin. Anda akan dialihkan ke halaman utama.'
        );
      } catch (alertError) {
        console.error('❌ Alert failed:', alertError);
      }

      // Handle logout and navigation with multiple fallbacks
      await handleSuccessfulRegistration();

    } catch (error) {
      console.error('❌ Registration error:', error);
      setRegistrationStep('error');

      // Clean up on failure
      try {
        if (auth.currentUser && createdNewAuthUser) {
          await auth.currentUser.delete();
          console.log('✅ Cleaned up failed user account');
        } else if (auth.currentUser) {
          await auth.signOut();
        }
      } catch (cleanupError) {
        console.error('❌ Cleanup failed:', cleanupError);
      }

      // Set specific error messages
      if (error.code === 'auth/email-already-in-use') {
        setError('Email sudah terdaftar');
      } else if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
        setError('Email sudah terdaftar. Gunakan password yang sama seperti saat registrasi sebelumnya.');
      } else if (error.code === 'auth/network-request-failed') {
        setError('Koneksi internet bermasalah. Silakan coba lagi.');
      } else if (error.code === 'auth/weak-password') {
        setError('Password terlalu lemah');
      } else if (error.code === 'auth/invalid-email') {
        setError('Format email tidak valid');
      } else if (error.code === 'auth/operation-not-allowed') {
        setError('Registrasi email/password tidak diizinkan');
      } else if (error.code === 'permission-denied' || error.code === 'firestore/permission-denied') {
        setError('Data registrasi ditolak oleh sistem. Silakan hubungi admin.');
      } else {
        setError('Terjadi kesalahan: ' + error.message);
      }

      // Clear loading states immediately
      setLoading(false);
      setIsSubmitting(false);

      // Show recovery button after 5 seconds (faster)
      setTimeout(() => {
        if (registrationStep === 'error') {
          setShowRecovery(true);
          console.log('🔄 Recovery options shown');
        }
      }, 5000);
    }
  };

  // Separate function to handle successful registration with mobile support
  const handleSuccessfulRegistration = async () => {
    console.log('🚪 Handling successful registration...');

    // Detect mobile browser
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isAndroid = /Android/.test(navigator.userAgent);

    console.log('📱 Mobile detected:', isMobile);
    console.log('📱 iOS detected:', isIOS);
    console.log('📱 Android detected:', isAndroid);

    try {
      // Step 1: Sign out
      console.log('Step 1: Signing out...');
      await auth.signOut();
      console.log('✅ Sign out successful');

      // Step 2: Wait a moment (longer for mobile)
      const waitTime = isMobile ? 1000 : 500;
      await new Promise(resolve => setTimeout(resolve, waitTime));

      // Step 3: Navigate to home page with production and mobile-specific handling
      console.log('Step 3: Navigating to home page...');

      // Check if we're in production
      const isProduction = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
      console.log('🌐 Production detected:', isProduction);

      // For production, use AGGRESSIVE production navigation
      if (isProduction) {
        console.log('🚀 AGGRESSIVE: Using aggressive production navigation...');

        // Try aggressive production navigation first
        const aggressiveNavSuccess = aggressiveProductionFix.forceNavigate('/');
        if (aggressiveNavSuccess) {
          console.log('✅ Aggressive production navigation successful');
          return;
        }

        // Fallback to normal production navigation
        console.log('🌐 Aggressive navigation failed, trying normal production navigation...');
        const productionNavSuccess = await handleProductionNavigation('/');
        if (productionNavSuccess) {
          console.log('✅ Production navigation successful');
          return;
        }

        // Fallback to mobile navigation if production navigation fails
        if (isMobile) {
          console.log('📱 Production navigation failed, trying mobile navigation...');
          const mobileNavSuccess = await tryMobileNavigation('/');
          if (mobileNavSuccess) {
            console.log('✅ Mobile navigation successful');
            return;
          }
        }

        // Nuclear option for production
        console.log('🚀 AGGRESSIVE: All navigation methods failed, applying nuclear reset...');
        aggressiveProductionFix.nuclearReset();
        return;
      }

      // For mobile (non-production), use mobile-specific navigation
      if (isMobile) {
        console.log('📱 Using mobile-specific navigation...');

        // MOBILE AGGRESSIVE NAVIGATION - Bypass React Router entirely
        const mobileNavMethods = [
          // Method 1: Direct replace (most reliable for mobile)
          () => {
            console.log('📱 Method 1: window.location.replace');
            window.location.replace('/');
          },
          // Method 2: Direct href
          () => {
            console.log('📱 Method 2: window.location.href');
            window.location.href = '/';
          },
          // Method 3: Direct assign
          () => {
            console.log('📱 Method 3: window.location.assign');
            window.location.assign('/');
          },
          // Method 4: iOS-specific reload
          () => {
            if (isIOS) {
              console.log('📱 Method 4: iOS-specific reload');
              window.location.href = window.location.href;
            } else {
              console.log('📱 Method 4: Android reload');
              window.location.reload();
            }
          },
          // Method 5: Hard reload
          () => {
            console.log('📱 Method 5: Hard reload');
            window.location.reload(true);
          },
          // Method 6: History replace
          () => {
            console.log('📱 Method 6: History replace');
            window.history.replaceState({}, '', '/');
            window.dispatchEvent(new PopStateEvent('popstate'));
          },
          // Method 7: History push
          () => {
            console.log('📱 Method 7: History push');
            window.history.pushState({}, '', '/');
            window.dispatchEvent(new PopStateEvent('popstate'));
          },
          // Method 8: React Router (last resort for mobile)
          () => {
            console.log('📱 Method 8: React Router');
            navigate('/');
          }
        ];

        // Try each method with delay
        for (let i = 0; i < mobileNavMethods.length; i++) {
          try {
            console.log(`📱 Trying mobile navigation method ${i + 1}...`);
            await new Promise(resolve => setTimeout(resolve, 300)); // Wait between attempts
            mobileNavMethods[i]();
            console.log(`✅ Mobile navigation method ${i + 1} successful`);
            return;
          } catch (error) {
            console.warn(`❌ Mobile navigation method ${i + 1} failed:`, error);
          }
        }

        // If all methods fail, force reload
        console.log('📱 All mobile navigation methods failed, forcing reload...');
        window.location.reload(true);

      } else {
        // Desktop navigation (original logic)
        console.log('🖥️ Using desktop navigation...');

        // Try React Router first
        try {
          navigate('/');
          console.log('✅ React Router navigation to home successful');
          return;
        } catch (navError) {
          console.warn('❌ React Router failed:', navError);
        }

        // Try window.location
        try {
          window.location.href = '/';
          console.log('✅ Window location navigation to home successful');
          return;
        } catch (windowError) {
          console.warn('❌ Window location failed:', windowError);
        }

        // Try window.location.replace
        try {
          window.location.replace('/');
          console.log('✅ Window location.replace to home successful');
          return;
        } catch (replaceError) {
          console.warn('❌ Window location.replace failed:', replaceError);
        }

        // Last resort: reload page
        console.log('🔄 Using fallback: reload page');
        window.location.reload();
      }

    } catch (error) {
      console.error('❌ Registration completion failed:', error);

      // Emergency fallback - go to home page
      try {
        if (isMobile) {
          console.log('📱 Emergency mobile fallback...');
          window.location.replace('/');
        } else {
          console.log('🖥️ Emergency desktop fallback...');
          window.location.href = '/';
        }
      } catch (finalError) {
        console.error('❌ Final fallback failed:', finalError);
        window.location.reload();
      }
    }
  };

  const handleRecovery = () => {
    console.log('🔄 Recovery initiated...');

    // Clear form and reset state
    setFormData({
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
      phone: '',
      nik: '',
      address: '',
      staffCategory: '',
      kelurahanId: '',
      jenisTenagaAhli: '',
      peranKantor: '',
    });
    setPhoto(null);
    setError('');
    setShowRecovery(false);
    setRegistrationStep('form');

    // Clear cache and reload
    if ('caches' in window) {
      caches.keys().then(names => {
        names.forEach(name => caches.delete(name));
      });
    }

    // Force reload
    window.location.reload(true);
  };

  const handleGoToLogin = () => {
    navigate('/login');
  };

  const handleGoHome = () => {
    window.location.href = '/';
  };

  // Show recovery UI if stuck
  if (registrationStep === 'error' && showRecovery) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-pink-100 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <div className="mx-auto h-16 w-16 bg-red-500 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-xl">⚠️</span>
            </div>
            <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
              Registrasi Gagal
            </h2>
            <p className="mt-2 text-center text-sm text-gray-600">
              Terjadi masalah saat registrasi. Silakan coba salah satu opsi di bawah.
            </p>
          </div>

          <div className="bg-white shadow-lg rounded-lg p-6">
            <div className="space-y-4">
              {/* Error Display */}
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      <svg className="h-5 w-5 text-red-400" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-red-800">
                        {error}
                      </h3>
                    </div>
                  </div>
                </div>
              )}

              {/* Recovery Options */}
              <div className="space-y-3">
                <button
                  onClick={handleRecovery}
                  className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center"
                >
                  <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
                  </svg>
                  Coba Lagi
                </button>

                <button
                  onClick={() => window.location.href = '/'}
                  className="w-full bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors"
                >
                  Kembali ke Halaman Utama
                </button>

                <button
                  onClick={handleGoToLogin}
                  className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Login Sekarang
                </button>
              </div>

              {/* Instructions */}
              <div className="text-xs text-gray-500 text-center">
                <p>Jika masalah berlanjut, silakan:</p>
                <p>1. Clear cache browser</p>
                <p>2. Restart aplikasi</p>
                <p>3. Hubungi support</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show processing state
  if (registrationStep === 'processing') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-green-600 mx-auto"></div>
          <h2 className="mt-4 text-xl font-semibold text-gray-800">Memproses Registrasi...</h2>
          <p className="mt-2 text-gray-600">Mohon tunggu, jangan tutup halaman ini</p>

          {/* Progress indicators */}
          <div className="mt-6 space-y-2">
            <div className="flex items-center justify-center">
              <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
              <span className="text-sm text-gray-600">Membuat akun...</span>
            </div>
            <div className="flex items-center justify-center">
              <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
              <span className="text-sm text-gray-600">Mengunggah foto...</span>
            </div>
            <div className="flex items-center justify-center">
              <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
              <span className="text-sm text-gray-600">Menyimpan data...</span>
            </div>
          </div>

          {/* Cancel button */}
          <button
            onClick={() => {
              setRegistrationStep('form');
              setLoading(false);
              setIsSubmitting(false);
            }}
            className="mt-6 text-red-600 hover:text-red-700 text-sm"
          >
            Batalkan
          </button>
        </div>
      </div>
    );
  }

  // Show success state
  if (registrationStep === 'success') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-16 w-16 bg-green-500 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-xl">✅</span>
          </div>
          <h2 className="mt-4 text-xl font-semibold text-gray-800">Registrasi Berhasil!</h2>
          <p className="mt-2 text-gray-600">Akun Anda sedang menunggu persetujuan admin</p>
          <p className="mt-1 text-sm text-gray-500">Anda akan dialihkan ke halaman utama...</p>

          <div className="mt-6 space-y-3">
            <button
              onClick={() => window.location.href = '/'}
              className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 transition-colors"
            >
              Lanjut ke Halaman Utama
            </button>
            <button
              onClick={handleGoToLogin}
              className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Login Sekarang
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Main registration form
  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="bg-white shadow-lg rounded-lg p-6 mb-2">
          <ProjectBrandHeader compact />
          <h2 className="text-center text-xl font-bold text-gray-900">
            Registrasi Tim ISWMP
          </h2>
          <p className="mt-1 text-center text-sm text-gray-600">
            Isi data diri dan penugasan Anda
          </p>
        </div>

        <form className="mt-4 space-y-6" onSubmit={handleSubmit}>
          <div className="bg-white shadow-lg rounded-lg p-6 space-y-4">
            {/* Error Display */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-red-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-800">
                      {error}
                    </h3>
                  </div>
                </div>
              </div>
            )}

            {/* Personal Information */}
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Data Pribadi</h3>

              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                  Nama Lengkap *
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  required
                  value={formData.name}
                  onChange={handleInputChange}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                />
              </div>

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                  Email *
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  value={formData.email}
                  onChange={handleInputChange}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                />
              </div>

              <div>
                <label htmlFor="phone" className="block text-sm font-medium text-gray-700">
                  Nomor Telepon *
                </label>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  required
                  value={formData.phone}
                  onChange={handleInputChange}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                />
              </div>

              <div>
                <label htmlFor="nik" className="block text-sm font-medium text-gray-700">
                  NIK *
                </label>
                <input
                  id="nik"
                  name="nik"
                  type="text"
                  required
                  value={formData.nik}
                  onChange={handleInputChange}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                />
              </div>
              
              {/* ID Karyawan field has been removed - no longer required */}
            </div>

            {/* Penugasan ISWMP */}
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Penugasan</h3>

              <div>
                <label htmlFor="staffCategory" className="block text-sm font-medium text-gray-700">
                  Kategori Penugasan *
                </label>
                <select
                  id="staffCategory"
                  name="staffCategory"
                  required
                  value={formData.staffCategory}
                  onChange={handleInputChange}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                >
                  <option value="">Pilih kategori</option>
                  <option value="field_staff">Tenaga Ahli Lapangan (Kelurahan)</option>
                  <option value="office_staff">Tim Kantor Kota Padang</option>
                </select>
              </div>

              {formData.staffCategory === 'field_staff' && (
                <>
                  <div>
                    <label htmlFor="kelurahanId" className="block text-sm font-medium text-gray-700">
                      Kelurahan Penugasan *
                    </label>
                    <select
                      id="kelurahanId"
                      name="kelurahanId"
                      required
                      value={formData.kelurahanId}
                      onChange={handleInputChange}
                      className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                    >
                      <option value="">Pilih kelurahan</option>
                      {KELURAHAN_SEED.map((kel) => (
                        <option key={kel.id} value={kel.id}>
                          {kel.nama} — {kel.kecamatan}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="jenisTenagaAhli" className="block text-sm font-medium text-gray-700">
                      Jenis Tenaga Ahli *
                    </label>
                    <select
                      id="jenisTenagaAhli"
                      name="jenisTenagaAhli"
                      required
                      value={formData.jenisTenagaAhli}
                      onChange={handleInputChange}
                      className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                    >
                      <option value="">Pilih jenis TA</option>
                      {FIELD_STAFF_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {formData.staffCategory === 'office_staff' && (
                <div>
                  <label htmlFor="peranKantor" className="block text-sm font-medium text-gray-700">
                    Peran Kantor *
                  </label>
                  <select
                    id="peranKantor"
                    name="peranKantor"
                    required
                    value={formData.peranKantor}
                    onChange={handleInputChange}
                    className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                  >
                    <option value="">Pilih peran</option>
                    {OFFICE_STAFF_ROLES.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label htmlFor="address" className="block text-sm font-medium text-gray-700">
                  Alamat *
                </label>
                <textarea
                  id="address"
                  name="address"
                  required
                  value={formData.address}
                  onChange={handleInputChange}
                  rows="3"
                  placeholder="Alamat lengkap tempat tinggal"
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                />
              </div>
            </div>

            {/* Photo Upload */}
            <div>
              <label htmlFor="photo" className="block text-sm font-medium text-gray-700">
                Foto Profil (Opsional)
              </label>
              <input
                id="photo"
                name="photo"
                type="file"
                accept="image/*"
                onChange={handlePhotoChange}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                Format: JPG, PNG, GIF. Maksimal 5MB
              </p>
            </div>

            {/* Password Fields */}
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Keamanan Akun</h3>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                  Password *
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  value={formData.password}
                  onChange={handleInputChange}
                  placeholder="Minimal 6 karakter"
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                />
                <p className="mt-1 text-xs text-gray-500">Minimal 6 karakter</p>
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                  Konfirmasi Password *
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  required
                  value={formData.confirmPassword}
                  onChange={handleInputChange}
                  placeholder="Masukkan password yang sama"
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-green-500 focus:border-green-500"
                />
              </div>
            </div>

            {/* Submit Button */}
            <div className="pt-4">
              <button
                type="submit"
                disabled={loading || isSubmitting}
                className={`w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${
                  loading || isSubmitting
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500'
                }`}
              >
                {loading || isSubmitting ? 'Memproses...' : 'Daftar'}
              </button>
            </div>

            {/* Login Link */}
            <div className="text-center">
              <p className="text-sm text-gray-600">
                Sudah punya akun?{' '}
                <button
                  type="button"
                  onClick={handleGoToLogin}
                  className="font-medium text-green-600 hover:text-green-500"
                >
                  Login di sini
                </button>
              </p>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export default Register;
