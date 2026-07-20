// src/components/Employee/Dashboard.jsx
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, db, storage } from '../../config/firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';


import { validateLocationForUser } from '../../services/geofenceService';
import { PROJECT } from '../../config/projectConfig';
import ClearCacheButton from '../Common/ClearCacheButton';
import { compressAttendancePhoto } from '../../utils/compressAttendancePhoto';
import DevicePermissionGuide, {
  isIOSDevice,
  isPermissionDeniedMessage,
} from '../Common/DevicePermissionGuide';

function EmployeeDashboard() {
  const navigate = useNavigate();

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);

  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [todayAttendance, setTodayAttendance] = useState(null);
  const [showCamera, setShowCamera] = useState(false);
  const [checkType, setCheckType] = useState(''); // 'in' or 'out'
  const [location, setLocation] = useState(null);
  const [locationValidation, setLocationValidation] = useState(null);
  const [locationError, setLocationError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [attendanceHistory, setAttendanceHistory] = useState([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraMode, setCameraMode] = useState('idle'); // idle | preview | native | failed
  const [cameraHint, setCameraHint] = useState('');
  const [permissionGuideOpen, setPermissionGuideOpen] = useState(false);
  const [permissionGuideFocus, setPermissionGuideFocus] = useState('both'); // location | camera | both
  const [pendingCheckType, setPendingCheckType] = useState('');

  // Utility function untuk deteksi browser dan device
  const detectDevice = () => {
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;

    return {
      isIOS: /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream,
      isAndroid: /android/i.test(userAgent),
      isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent),
      isSafari: /^((?!chrome|android).)*safari/i.test(userAgent),
      isChrome: /chrome|chromium|crios/i.test(userAgent),
      isFirefox: /firefox|fxios/i.test(userAgent)
    };
  };

  // Update current time every second
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Log device info for debugging
  useEffect(() => {
    const device = detectDevice();
    console.log('Device info:', device);
    console.log('User Agent:', navigator.userAgent);
    console.log('Platform:', navigator.platform);
    console.log('Vendor:', navigator.vendor);
  }, []);

  // Fetch user data and today's attendance
  useEffect(() => {
    const fetchData = async () => {
      try {
        const user = auth.currentUser;
        console.log('Current user:', user?.email, 'UID:', user?.uid);

        if (!user) {
          console.log('No authenticated user, redirecting to login...');
          navigate('/login');
          return;
        }

        // Get user data
        console.log('Fetching user document from Firestore...');
        const userDoc = await getDoc(doc(db, 'users', user.uid));

        if (userDoc.exists()) {
          const data = userDoc.data();
          console.log('User data found:', data);

          // Check if user is admin and redirect
          if (data.role === 'admin') {
            console.log('User is admin, redirecting to admin dashboard...');
            navigate('/admin');
            return;
          }

          if (data.accountStatus !== 'active') {
            alert('Your account is not active. Please contact admin.');
            await signOut(auth);
            navigate('/login');
            return;
          }
          setUserData(data);
        } else {
          console.error('User document not found in Firestore!');
          alert('User profile not found. Please contact administrator.');
          return;
        }

        // Get today's attendance (skip if no attendances collection yet)
        try {
          const today = new Date().toISOString().split('T')[0];
          console.log('Fetching today attendance for date:', today);

          const attendanceQuery = query(
            collection(db, 'attendances'),
                                        where('userId', '==', user.uid),
                                        where('date', '==', today)
          );
          const attendanceSnapshot = await getDocs(attendanceQuery);

          if (!attendanceSnapshot.empty) {
            setTodayAttendance({
              id: attendanceSnapshot.docs[0].id,
              ...attendanceSnapshot.docs[0].data()
            });
            console.log('Today attendance found');
          } else {
            console.log('No attendance record for today');
          }
        } catch (attendanceError) {
          console.log('Attendance query error (normal if no attendances yet):', attendanceError);
        }

        // Get attendance history (skip if no attendances collection yet)
        try {
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          const historyQuery = query(
            collection(db, 'attendances'),
                                     where('userId', '==', user.uid),
                                     where('date', '>=', sevenDaysAgo.toISOString().split('T')[0]),
                                     orderBy('date', 'desc')
          );
          const historySnapshot = await getDocs(historyQuery);
          const history = historySnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          }));
          setAttendanceHistory(history);
          console.log('Attendance history loaded:', history.length, 'records');
        } catch (historyError) {
          console.log('History query error (normal if no attendances yet):', historyError);
        }

      } catch (error) {
        console.error('Error fetching data:', error);
        console.error('Error details:', error.message);
        alert(`Error loading dashboard data: ${error.message}`);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [navigate]);

  // Validate location against user's assigned geofence
  const validateLocation = async () => {
    const result = await validateLocationForUser(userData);
    setLocationError('');
    setLocationValidation(null);
    if (!result.isValid) {
      const msg = result.message || `Anda berada ${result.distance}m dari lokasi penugasan. Maksimal ${result.maxRadius}m.`;
      setLocationError(msg);
      if (isPermissionDeniedMessage(msg, result.code)) {
        setPermissionGuideFocus('location');
        setPermissionGuideOpen(true);
      }
      return false;
    }
    setLocation(result.location);
    setLocationValidation(result);
    return true;
  };

  const openPermissionGuide = (focus = 'both') => {
    setPermissionGuideFocus(focus);
    setPermissionGuideOpen(true);
  };

  const handlePermissionRetry = async () => {
    setPermissionGuideOpen(false);
    setLocationError('');
    if (pendingCheckType) {
      await startCamera(pendingCheckType);
      return;
    }
    // Hanya uji lokasi ulang
    await validateLocation();
  };

  const stopMediaStream = (stream) => {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
  };

  /** Progressive getUserMedia — desktop / fallback only. */
  const requestCameraStream = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error('Camera API not supported');
      err.name = 'NotSupportedError';
      throw err;
    }

    // Prefer explicit deviceId on multi-camera phones (foldables)
    let deviceAttempts = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videos = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
      const frontish = videos.filter((d) => /front|user|selfie|facing/i.test(d.label));
      const ordered = [...frontish, ...videos.filter((d) => !frontish.includes(d))];
      deviceAttempts = ordered.slice(0, 3).map((d) => ({
        video: { deviceId: { exact: d.deviceId } },
        audio: false,
      }));
    } catch {
      // ignore enumerate failures
    }

    const attempts = [
      ...deviceAttempts,
      { video: { facingMode: 'user' }, audio: false },
      { video: { facingMode: { ideal: 'user' } }, audio: false },
      { video: true, audio: false },
    ];

    let lastError;
    for (const constraints of attempts) {
      try {
        console.log('Trying camera constraints:', constraints);
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        console.warn('Camera constraint failed:', constraints, error?.name, error?.message);
        lastError = error;
      }
    }
    throw lastError || new Error('Unable to access camera');
  };

  const waitForVideoElement = async (timeoutMs = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (videoRef.current) return videoRef.current;
      await new Promise((r) => requestAnimationFrame(r));
    }
    throw new Error('Video element not ready');
  };

  const attachStreamToVideo = async (stream) => {
    const video = await waitForVideoElement();
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video load timeout')), 8000);

      const onReady = () => {
        clearTimeout(timeout);
        video.play().then(resolve).catch(reject);
      };

      if (video.readyState >= 1) {
        onReady();
      } else {
        video.onloadedmetadata = onReady;
      }

      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Video error'));
      };
    });
  };

  const openNativeCamera = () => {
    setCameraMode('native');
    setCameraHint('Membuka kamera HP…');
    // Must run from a direct tap so Android allows the file picker
    fileInputRef.current?.click();
  };

  const startInAppPreview = async () => {
    setCameraStarting(true);
    setCameraMode('preview');
    setCameraHint('Menyiapkan preview kamera…');
    let stream = null;
    try {
      stream = await requestCameraStream();
      streamRef.current = stream;
      await attachStreamToVideo(stream);
      setCameraHint('');
      setCameraMode('preview');
    } catch (error) {
      console.error('In-app camera preview failed:', error);
      stopMediaStream(stream);
      streamRef.current = null;
      setCameraMode('failed');
      setCameraHint(
        'Preview di aplikasi tidak tersedia di HP ini. Gunakan tombol "Buka Kamera HP" di bawah.'
      );
      if (
        error?.name === 'NotAllowedError' ||
        error?.name === 'PermissionDeniedError' ||
        isPermissionDeniedMessage(error?.message || '', error?.name)
      ) {
        openPermissionGuide('camera');
      }
    } finally {
      setCameraStarting(false);
    }
  };

  // Check In/Out: validate location, then show capture UI.
  // On Android/iOS prefer native camera (reliable on foldables / Android 16).
  const startCamera = async (type) => {
    setCheckType(type);
    setPendingCheckType(type);
    setLocationError('');
    setCameraStarting(true);
    setCameraMode('idle');
    setCameraHint('');

    const device = detectDevice();
    console.log('Starting camera for device:', device);

    const isLocationValid = await validateLocation();
    if (!isLocationValid) {
      setCameraStarting(false);
      return;
    }

    setShowCamera(true);
    setCameraStarting(false);

    if (device.isMobile) {
      // Don't auto-call getUserMedia — often fails on Android 16 / multi-camera.
      // Show clear CTA that opens system camera (user gesture).
      setCameraMode('native');
      setCameraHint('Tekan tombol hijau untuk membuka kamera HP dan ambil selfie.');
      return;
    }

    await startInAppPreview();
  };

  const uploadAttendancePhoto = async (blobOrFile) => {
    const compressed = await compressAttendancePhoto(blobOrFile);
    const timestamp = Date.now();
    const fileName = `${auth.currentUser.uid}_${checkType || 'in'}_${timestamp}.jpg`;
    const storageRef = ref(storage, `attendances/${auth.currentUser.uid}/${fileName}`);
    const uploadSnapshot = await uploadBytes(storageRef, compressed, {
      contentType: 'image/jpeg',
      customMetadata: {
        originalBytes: String(blobOrFile.size || 0),
        compressedBytes: String(compressed.size || 0),
      },
    });
    return getDownloadURL(uploadSnapshot.ref);
  };

  const handleNativePhotoSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      setCameraHint('Foto belum dipilih. Tekan "Buka Kamera HP" untuk coba lagi.');
      return;
    }

    setIsProcessing(true);
    setCameraHint('Mengompres & mengunggah foto…');
    try {
      const photoUrl = await uploadAttendancePhoto(file);
      setShowCamera(false);
      if (checkType === 'out') {
        await processCheckOut(photoUrl);
      } else {
        await processCheckIn(photoUrl);
      }
    } catch (error) {
      console.error('Native photo upload error:', error);
      const continueWithout = window.confirm(
        'Gagal upload foto. Lanjutkan tanpa foto?'
      );
      if (continueWithout) {
        setShowCamera(false);
        if (checkType === 'out') {
          await processCheckOut('');
        } else {
          await processCheckIn('');
        }
      }
    } finally {
      setIsProcessing(false);
      setCameraHint('');
    }
  };

  // Stop camera
  const stopCamera = () => {
    if (videoRef.current?.srcObject) {
      stopMediaStream(videoRef.current.srcObject);
      videoRef.current.srcObject = null;
    }
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    setShowCamera(false);
    setCheckType('');
    setLocationError('');
    setCameraStarting(false);
    setCameraMode('idle');
    setCameraHint('');
  };

  // Enhanced capture photo with better error handling
  const capturePhoto = async () => {
    if (!videoRef.current || !canvasRef.current) {
      console.error('Video or canvas reference not available');
      alert('Camera tidak siap. Silakan coba lagi.');
      return;
    }

    setIsProcessing(true);

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      // Pastikan video sudah siap
      if (video.readyState !== video.HAVE_ENOUGH_DATA) {
        console.log('Video not ready, waiting...');
        await new Promise(resolve => setTimeout(resolve, 500));

        if (video.readyState !== video.HAVE_ENOUGH_DATA) {
          throw new Error('Video stream not ready');
        }
      }

      const context = canvas.getContext('2d', { alpha: false });

      // Resize down before encode — uploadAttendancePhoto will compress further
      const maxSide = 960;
      const srcW = video.videoWidth || 640;
      const srcH = video.videoHeight || 480;
      const scale = Math.min(maxSide / srcW, maxSide / srcH, 1);
      canvas.width = Math.round(srcW * scale);
      canvas.height = Math.round(srcH * scale);

      console.log('Canvas dimensions:', canvas.width, 'x', canvas.height);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Blob creation timeout')), 5000);
        if (!canvas.toBlob) {
          try {
            const dataURL = canvas.toDataURL('image/jpeg', 0.58);
            fetch(dataURL).then((r) => r.blob()).then(resolve).catch(reject);
          } catch (e) {
            clearTimeout(timeout);
            reject(e);
          }
          return;
        }
        canvas.toBlob(
          (blobResult) => {
            clearTimeout(timeout);
            if (blobResult) resolve(blobResult);
            else reject(new Error('Failed to create blob'));
          },
          'image/jpeg',
          0.58
        );
      });

      if (!blob) {
        throw new Error('Failed to create image blob');
      }

      console.log('Blob created successfully, size:', blob.size);

      // Upload to Firebase Storage dengan error handling
      try {
        console.log('Uploading photo to Firebase...');
        const photoUrl = await uploadAttendancePhoto(blob);
        console.log('Photo uploaded successfully:', photoUrl);

        // Process check-in or check-out
        if (checkType === 'in') {
          await processCheckIn(photoUrl);
        } else {
          await processCheckOut(photoUrl);
        }

        stopCamera();
      } catch (uploadError) {
        console.error('Upload error:', uploadError);

        // Jika upload gagal, coba lanjutkan tanpa foto
        const confirmWithoutPhoto = window.confirm(
          'Gagal upload foto. Lanjutkan check-in tanpa foto?'
        );

        if (confirmWithoutPhoto) {
          if (checkType === 'in') {
            await processCheckIn(''); // Empty photo URL
          } else {
            await processCheckOut('');
          }
          stopCamera();
        }
      }
    } catch (error) {
      console.error('Error capturing photo:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        videoReady: videoRef.current?.readyState,
        canvasAvailable: !!canvasRef.current
      });

      // Berikan opsi untuk melanjutkan tanpa foto
      const confirmWithoutPhoto = window.confirm(
        `Gagal mengambil foto: ${error.message}\n\nLanjutkan check-in tanpa foto?`
      );

      if (confirmWithoutPhoto) {
        try {
          if (checkType === 'in') {
            await processCheckIn('');
          } else {
            await processCheckOut('');
          }
          stopCamera();
        } catch (processError) {
          console.error('Process error:', processError);
          alert('Gagal memproses attendance. Silakan coba lagi.');
        }
      }
    } finally {
      setIsProcessing(false);
    }
  };

  // Process check-in with null photo support
  const processCheckIn = async (photoUrl) => {
    try {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const isLate = now.getHours() >= 9; // Consider late if after 9 AM

      const attendanceData = {
        userId: auth.currentUser.uid,
        userName: userData.name,
        date: today,
        checkIn: serverTimestamp(),
        checkInTime: now.toISOString(),
        checkInLocation: location,
        checkInPhoto: photoUrl || null,
        status: isLate ? 'late' : 'ontime',
        checkOut: null,
        checkOutLocation: null,
        checkOutPhoto: null,
        workHours: 0,
        locationSource: locationValidation?.source || location?.source || null,
        locationAccuracy: locationValidation?.accuracy ?? location?.accuracy ?? null,
        distanceFromGeofence: locationValidation?.distance ?? null,
        geofenceId: locationValidation?.geofence?.id || null,
        geofenceName: locationValidation?.geofence?.nama || null,
        transitionMode: locationValidation?.transitionMode || false,
      };

      // Guard: skip if already has attendance today (client-side safeguard)
      const existingQ = query(
        collection(db, 'attendances'),
        where('userId', '==', auth.currentUser.uid),
        where('date', '==', today)
      );
      const existingSnap = await getDocs(existingQ);
      if (!existingSnap.empty) {
        alert('Anda sudah check-in hari ini.');
        return;
      }

      const docRef = await addDoc(collection(db, 'attendances'), attendanceData);

      // Update local state
      setTodayAttendance({
        id: docRef.id,
        ...attendanceData,
        checkIn: Timestamp.fromDate(now)
      });

      const photoStatus = photoUrl ? 'dengan foto' : 'tanpa foto';
      alert(`Check-in berhasil ${photoStatus}!\nStatus: ${isLate ? 'Terlambat' : 'Tepat Waktu'}`);
    } catch (error) {
      console.error('Error processing check-in:', error);
      alert('Gagal memproses check-in. Silakan coba lagi.');
    }
  };

  // Process check-out with null photo support
  const processCheckOut = async (photoUrl) => {
    try {
      if (!todayAttendance) {
        alert('Tidak ada check-in untuk hari ini!');
        return;
      }

      const now = new Date();
      const checkInTime = todayAttendance.checkIn.toDate();
      const workHours = (now - checkInTime) / (1000 * 60 * 60); // Hours

      await updateDoc(doc(db, 'attendances', todayAttendance.id), {
        checkOut: serverTimestamp(),
                      checkOutTime: now.toISOString(),
                      checkOutLocation: location,
                      checkOutPhoto: photoUrl || null, // Allow null photo
                      workHours: parseFloat(workHours.toFixed(2))
      });

      // Update local state
      setTodayAttendance({
        ...todayAttendance,
        checkOut: Timestamp.fromDate(now),
                         checkOutLocation: location,
                         checkOutPhoto: photoUrl || null,
                         workHours: parseFloat(workHours.toFixed(2))
      });

      const photoStatus = photoUrl ? 'dengan foto' : 'tanpa foto';
      alert(`Check-out berhasil ${photoStatus}!\nJam kerja: ${workHours.toFixed(2)} jam`);
    } catch (error) {
      console.error('Error processing check-out:', error);
      alert('Gagal memproses check-out. Silakan coba lagi.');
    }
  };

  // Format time
  const formatTime = (timestamp) => {
    if (!timestamp) return '-';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  };



  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center">
      <div className="text-center">
      <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-green-600 mx-auto"></div>
      <p className="mt-4 text-gray-600">Loading dashboard...</p>
      </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 pb-20">
    {/* Page Title */}
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-center space-x-3 mb-6">
        <div className="w-10 h-10 bg-green-600 rounded-lg flex items-center justify-center">
          <span className="text-white font-bold">SA</span>
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-800">Surya Abadi Connecteam</h1>
          <p className="text-sm text-gray-600">Employee Dashboard</p>
        </div>
      </div>
    </div>

    <div className="max-w-7xl mx-auto px-4 py-6">
    {/* Welcome Section */}
    <div className="bg-white rounded-xl shadow-md p-6 mb-6">
    <div className="flex justify-between items-start">
    <div className="flex items-center space-x-4">
    {userData?.photoUrl ? (
      <img
      src={userData.photoUrl}
      alt={userData.name}
      className="w-20 h-20 rounded-full object-cover border-4 border-green-100"
      />
    ) : (
      <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center">
      <span className="text-2xl font-bold text-green-600">
      {userData?.name?.charAt(0).toUpperCase()}
      </span>
      </div>
    )}
    <div>
    <h2 className="text-2xl font-bold text-gray-800">Welcome, {userData?.name}!</h2>
    <p className="text-gray-600">{userData?.position} - {userData?.department}</p>
    <p className="text-sm text-gray-500">Employee ID: {userData?.employeeId}</p>
    </div>
    </div>
    <div className="text-right">
    <p className="text-3xl font-bold text-gray-800">
    {currentTime.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </p>
    <p className="text-gray-600">
    {currentTime.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
    </p>
    </div>
    </div>
    </div>

    {/* Today's Attendance Status */}
    <div className="bg-white rounded-xl shadow-md p-6 mb-6">
    <h3 className="text-lg font-semibold text-gray-800 mb-4">Today's Attendance</h3>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
    <div className="bg-green-50 rounded-lg p-4">
    <p className="text-sm text-gray-600">Check In</p>
    <p className="text-xl font-bold text-green-600">
    {todayAttendance?.checkIn ? formatTime(todayAttendance.checkIn) : 'Not yet'}
    </p>
    {todayAttendance?.status && (
      <span className={`inline-block px-2 py-1 text-xs rounded-full mt-2 ${
        todayAttendance.status === 'ontime'
        ? 'bg-green-100 text-green-800'
        : 'bg-yellow-100 text-yellow-800'
      }`}>
      {todayAttendance.status === 'ontime' ? 'On Time' : 'Late'}
      </span>
    )}
    </div>
    <div className="bg-blue-50 rounded-lg p-4">
    <p className="text-sm text-gray-600">Check Out</p>
    <p className="text-xl font-bold text-blue-600">
    {todayAttendance?.checkOut ? formatTime(todayAttendance.checkOut) : 'Not yet'}
    </p>
    </div>
    <div className="bg-purple-50 rounded-lg p-4">
    <p className="text-sm text-gray-600">Work Hours</p>
    <p className="text-xl font-bold text-purple-600">
    {todayAttendance?.workHours ? `${todayAttendance.workHours} hours` : '-'}
    </p>
    </div>
    </div>

    {/* Check In/Out Buttons */}
    <div className="mt-6 flex gap-4">
    {!todayAttendance?.checkIn ? (
      <button
      onClick={() => startCamera('in')}
      className="flex-1 bg-green-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-green-700 transition-colors flex items-center justify-center space-x-2"
      >
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      <span>Check In</span>
      </button>
    ) : !todayAttendance?.checkOut ? (
      <button
      onClick={() => startCamera('out')}
      className="flex-1 bg-blue-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-blue-700 transition-colors flex items-center justify-center space-x-2"
      >
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
      </svg>
      <span>Check Out</span>
      </button>
    ) : (
      <div className="flex-1 bg-gray-100 text-gray-600 py-3 px-6 rounded-lg text-center">
      <p className="font-semibold">Attendance Complete for Today</p>
      <p className="text-sm mt-1">Thank you for your hard work!</p>
      </div>
    )}
    </div>

    {locationValidation?.transitionMode && (
      <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
      <p className="text-yellow-800 text-sm">{locationValidation.message}</p>
      </div>
    )}

    {locationError && (
      <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-red-600 flex items-start">
          <svg className="w-5 h-5 mr-2 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>{locationError}</span>
        </p>
        {isPermissionDeniedMessage(locationError) && (
          <button
            type="button"
            onClick={() => openPermissionGuide(isIOSDevice() ? 'both' : 'location')}
            className="mt-3 w-full py-2.5 px-3 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700"
          >
            {isIOSDevice() ? 'Panduan izinkan Lokasi & Kamera (iPhone)' : 'Cara izinkan akses lokasi'}
          </button>
        )}
      </div>
    )}
    </div>

    <DevicePermissionGuide
      open={permissionGuideOpen}
      focus={permissionGuideFocus}
      onClose={() => setPermissionGuideOpen(false)}
      onRetry={handlePermissionRetry}
    />

    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      capture="user"
      className="hidden"
      onChange={handleNativePhotoSelected}
    />

    {/* Camera Modal */}
    {showCamera && (
      <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-lg w-full p-6">
      <h3 className="text-lg font-semibold mb-2">
      Selfie Check {checkType === 'in' ? 'In' : 'Out'}
      </h3>
      <p className="text-sm text-gray-600 mb-4">
      {cameraHint || 'Ambil foto wajah untuk verifikasi kehadiran.'}
      </p>

      {cameraMode === 'preview' && (
      <div className="relative bg-black rounded-lg overflow-hidden mb-4 min-h-[200px]">
      <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      webkit-playsinline="true"
      className="w-full"
      style={{
        maxWidth: '100%',
        height: 'auto',
        transform: 'scaleX(-1)'
      }}
      />
      <canvas
      ref={canvasRef}
      className="hidden"
      style={{ display: 'none' }}
      />
      </div>
      )}

      {cameraMode !== 'preview' && (
        <div className="mb-4 rounded-lg bg-green-50 border border-green-100 p-4 text-center">
          <p className="text-sm text-green-900 font-medium">
            Gunakan kamera HP (lebih stabil di Android)
          </p>
          <button
            type="button"
            onClick={() => openPermissionGuide('both')}
            className="mt-2 text-sm text-green-800 underline"
          >
            Lokasi/kamera diblokir? Buka panduan Settings
          </button>
        </div>
      )}

      {/* Keep refs mounted for capture helpers */}
      {cameraMode !== 'preview' && (
        <>
          <video ref={videoRef} className="hidden" playsInline muted autoPlay />
          <canvas ref={canvasRef} className="hidden" />
        </>
      )}

      {location && (
        <div className="mb-4 p-3 bg-green-50 rounded-lg">
        <p className="text-sm text-green-800">
        ✓ Lokasi terverifikasi
        </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
      {cameraMode === 'preview' ? (
        <button
        onClick={capturePhoto}
        disabled={isProcessing || cameraStarting}
        className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
        >
        {isProcessing ? 'Memproses…' : 'Ambil Foto'}
        </button>
      ) : (
        <button
        type="button"
        onClick={openNativeCamera}
        disabled={isProcessing}
        className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center justify-center"
        >
        {isProcessing ? 'Mengunggah…' : 'Buka Kamera HP'}
        </button>
      )}

      <div className="flex gap-3">
      {cameraMode !== 'preview' && (
        <button
        type="button"
        onClick={startInAppPreview}
        disabled={isProcessing || cameraStarting}
        className="flex-1 py-3 bg-white border border-gray-300 text-gray-700 rounded-lg font-medium disabled:opacity-50"
        >
        Coba preview
        </button>
      )}
      <button
      onClick={stopCamera}
      disabled={isProcessing}
      className="flex-1 px-6 py-3 bg-gray-500 text-white rounded-lg font-semibold hover:bg-gray-600 transition-colors disabled:opacity-50"
      >
      Batal
      </button>
      </div>
      </div>

      <div className="mt-3 text-center space-y-2">
      {cameraMode === 'preview' && (
      <button
      type="button"
      onClick={openNativeCamera}
      className="text-sm text-green-700 underline"
      >
      Atau buka kamera/galeri sistem
      </button>
      )}
      <button
      onClick={() => {
        stopCamera();
        const confirmWithoutPhoto = window.confirm(
          'Lanjutkan check-in tanpa foto?'
        );
        if (confirmWithoutPhoto) {
          setIsProcessing(true);
          if (checkType === 'in') {
            processCheckIn('').finally(() => setIsProcessing(false));
          } else {
            processCheckOut('').finally(() => setIsProcessing(false));
          }
        }
      }}
      className="block w-full text-sm text-gray-500 underline"
      >
      Skip foto (lanjut tanpa foto)
      </button>
      </div>
      </div>
      </div>
    )}

    {/* Recent Attendance History */}
    <div className="bg-white rounded-xl shadow-md p-6">
    <h3 className="text-lg font-semibold text-gray-800 mb-4">Recent Attendance History</h3>
    <div className="overflow-x-auto">
    <table className="w-full">
    <thead>
    <tr className="border-b">
    <th className="text-left py-2 px-2 text-sm font-medium text-gray-600">Date</th>
    <th className="text-left py-2 px-2 text-sm font-medium text-gray-600">Check In</th>
    <th className="text-left py-2 px-2 text-sm font-medium text-gray-600">Check Out</th>
    <th className="text-left py-2 px-2 text-sm font-medium text-gray-600">Status</th>
    <th className="text-left py-2 px-2 text-sm font-medium text-gray-600">Work Hours</th>
    </tr>
    </thead>
    <tbody>
    {attendanceHistory.length > 0 ? (
      attendanceHistory.map((record) => (
        <tr key={record.id} className="border-b">
        <td className="py-2 px-2 text-sm">
        {new Date(record.date).toLocaleDateString('id-ID', {
          weekday: 'short',
          day: 'numeric',
          month: 'short'
        })}
        </td>
        <td className="py-2 px-2 text-sm">
        {record.checkIn ? formatTime(record.checkIn) : '-'}
        </td>
        <td className="py-2 px-2 text-sm">
        {record.checkOut ? formatTime(record.checkOut) : '-'}
        </td>
        <td className="py-2 px-2">
        <span className={`inline-block px-2 py-1 text-xs rounded-full ${
          record.status === 'ontime'
          ? 'bg-green-100 text-green-800'
          : 'bg-yellow-100 text-yellow-800'
        }`}>
        {record.status === 'ontime' ? 'On Time' : 'Late'}
        </span>
        </td>
        <td className="py-2 px-2 text-sm">
        {record.workHours ? `${record.workHours}h` : '-'}
        </td>
        </tr>
      ))
    ) : (
      <tr>
      <td colSpan="5" className="text-center py-4 text-gray-500">
      No attendance records found
      </td>
      </tr>
    )}
    </tbody>
    </table>
    </div>
    </div>

    <div className="mt-6 rounded-xl bg-white shadow-sm p-4 text-center">
      <p className="text-sm text-gray-600 mb-3">
        Aplikasi error, kamera bermasalah, atau tampilan tidak update?
      </p>
      <ClearCacheButton variant="button" label="Perbarui Aplikasi (Hapus Cache)" />
    </div>
    </div>
    </div>
  );
}

export default EmployeeDashboard;
