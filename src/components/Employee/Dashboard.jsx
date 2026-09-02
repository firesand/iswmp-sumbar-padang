// src/components/Employee/Dashboard.jsx
import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth, db } from '../../config/firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
} from 'firebase/firestore';
import {
  getCurrentLocation,
  isValidGpsCoords,
  validateLocationAgainstAllowedLocations,
  validateLocationAgainstGeofence,
} from '../../utils/geolocation';
import { resolveAssignmentChoiceForLocation } from '../../services/geofenceService';
import {
  captureGpsSignalTrace,
  describeGpsCaptureStatus,
  describeGpsTraceProgress,
} from '../../utils/gpsSignalTrace';
import {
  beginDeviceObservation,
  collectDeviceIntegrity,
} from '../../utils/deviceIntegrity';
import {
  ATTENDANCE_TIMEZONE,
  formatWibDate,
  formatWibTime,
  getWibDateDaysAgo,
  getWibDateString,
} from '../../utils/attendanceTime';
import {
  createAttendanceChallenge,
  EARLY_LEAVE_REASON_MAX_LENGTH,
  EARLY_LEAVE_REASON_MIN_LENGTH,
  getAttendanceErrorMessage,
  isValidEarlyLeaveReason,
  submitAttendance,
  uploadAttendanceProof,
  VERIFICATION_MODE_LOCATION_PHOTO,
} from '../../services/attendanceService';
import {
  formatAttendanceShiftDuration,
  getEmployeeAttendanceState,
  resolveEmployeeAttendanceState,
} from '../../services/database';
import {
  isAttendanceWorkflowEligible,
  isLocationPhotoAttendance,
} from '../../utils/attendanceIntegrity';
import {
  attachEffectiveAttendanceCorrection,
  resolveAttendanceCompletion,
} from '../../utils/attendanceCorrection';
import { getAttendanceLocationLabel } from '../../utils/attendanceDisplay';
import { getGoogleMapsUrl } from '../../utils/attendanceDossier';
import {
  hasDeliverablesAccess,
  isTeamLeader,
  isDataManagementExpert,
} from '../../utils/authorization';
import { PROJECT } from '../../config/projectConfig';
import ClearCacheButton from '../Common/ClearCacheButton';
import { compressAttendancePhoto } from '../../utils/compressAttendancePhoto';
import DevicePermissionGuide, {
  isIOSDevice,
  isPermissionDeniedMessage,
} from '../Common/DevicePermissionGuide';

const timestampDate = (value) => {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const isCrossDayAttendance = (attendance, checkOutValue) => {
  const checkOutDate = timestampDate(checkOutValue ?? attendance?.checkOut);
  return Boolean(
    attendance?.date &&
    checkOutDate &&
    getWibDateString(checkOutDate) !== attendance.date
  );
};

const formatWibDateTime = (value) => {
  const date = timestampDate(value);
  if (!date) return '-';
  return `${formatWibDate(date, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}, ${formatWibTime(date)} WIB`;
};

const getValidEarlyLeaveReason = (attendance) => {
  if (attendance?.earlyLeave !== true) return '';
  const reason = typeof attendance.earlyLeaveReason === 'string'
    ? attendance.earlyLeaveReason.trim()
    : '';
  return isValidEarlyLeaveReason(reason) ? reason : '';
};

function EmployeeDashboard() {
  const navigate = useNavigate();

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const attendanceChallengeRef = useRef(null);
  const startingAttendanceRef = useRef(false);

  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attendanceCandidates, setAttendanceCandidates] = useState([]);
  const [attendanceLoadError, setAttendanceLoadError] = useState('');
  const [
    maximumShiftDurationMinutes,
    setMaximumShiftDurationMinutes,
  ] = useState(null);
  const [maximumShiftDurationMs, setMaximumShiftDurationMs] = useState(null);
  const [lastSubmittedAttendance, setLastSubmittedAttendance] = useState(null);
  const [showCamera, setShowCamera] = useState(false);
  const [checkType, setCheckType] = useState(''); // 'in' or 'out'
  const [location, setLocation] = useState(null);
  const [locationValidation, setLocationValidation] = useState(null);
  const [locationError, setLocationError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [attendanceHistory, setAttendanceHistory] = useState([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraMode, setCameraMode] = useState('idle'); // idle | preview | failed
  const [cameraHint, setCameraHint] = useState('');
  const [permissionGuideOpen, setPermissionGuideOpen] = useState(false);
  const [permissionGuideFocus, setPermissionGuideFocus] = useState('both'); // location | camera | both
  const [pendingCheckType, setPendingCheckType] = useState('');
  const [attendanceChallenge, setAttendanceChallenge] = useState(null);
  const [presenceCode, setPresenceCode] = useState('');
  const [earlyLeaveReason, setEarlyLeaveReason] = useState('');

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

          if (data.accountStatus !== 'active' || data.isActive !== true) {
            alert('Akun Anda tidak aktif. Hubungi admin.');
            await signOut(auth);
            navigate('/login');
            return;
          }

          // Check if user is admin and redirect only after the account guard.
          if (data.role === 'admin') {
            console.log('User is admin, redirecting to admin dashboard...');
            navigate('/admin');
            return;
          }
          setUserData(data);
        } else {
          console.error('User document not found in Firestore!');
          alert('Profil pengguna tidak ditemukan. Hubungi admin.');
          await signOut(auth);
          navigate('/login');
          return;
        }

        // Resolve today's record separately from a still-open shift using the
        // same server-configured duration enforced by the callable backend.
        try {
          const attendanceState = await getEmployeeAttendanceState(user.uid);
          setAttendanceCandidates(attendanceState.records);
          setAttendanceLoadError(attendanceState.loadError || '');
          setMaximumShiftDurationMinutes(
            attendanceState.maximumShiftDurationMinutes
          );
          setMaximumShiftDurationMs(
            attendanceState.maximumShiftDurationMs
          );
          console.log('Current attendance candidates loaded:', attendanceState.records.length);
        } catch (attendanceError) {
          console.log('Attendance query error (normal if no attendances yet):', attendanceError);
          setAttendanceCandidates([]);
          setMaximumShiftDurationMinutes(null);
          setMaximumShiftDurationMs(null);
          setAttendanceLoadError(
            'Status shift tidak dapat dimuat. Muat ulang halaman sebelum melakukan absensi.'
          );
        }

        // Get attendance history (skip if no attendances collection yet)
        try {
          const sevenDaysAgo = getWibDateDaysAgo(7);
          const historyQuery = query(
            collection(db, 'attendances'),
                                     where('userId', '==', user.uid),
                                     where('date', '>=', sevenDaysAgo),
                                     orderBy('date', 'desc')
          );
          const historySnapshot = await getDocs(historyQuery);
          const canonicalHistory = historySnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          }));
          const historyProjectionSnapshots = await Promise.all(
            canonicalHistory.map((record) => getDoc(doc(
              db,
              'attendanceCorrectionEffectiveViews',
              record.id
            )))
          );
          const history = canonicalHistory.map((record, index) =>
            attachEffectiveAttendanceCorrection(
              record,
              historyProjectionSnapshots[index].exists()
                ? historyProjectionSnapshots[index].data()
                : null
            )
          );
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

  // The backend challenge is authoritative for whether a verified geofence is
  // required. Temporary location+photo mode still requires fresh accurate GPS
  // inside an operator-declared operational location (assignment and/or
  // temporary venue), but deliberately does not pretend that the point passed
  // a dual-control geofence audit.
  const validateLocation = async (challenge = null, options = {}) => {
    let result;
    if (challenge?.verificationMode === VERIFICATION_MODE_LOCATION_PHOTO) {
      result = await validateLocationAgainstAllowedLocations(
        challenge.allowedLocations,
        options,
      );
    } else if (challenge?.geofence) {
      result = await validateLocationAgainstGeofence({
        ...challenge.geofence,
        nama: challenge.geofence?.name,
        isActive: true,
      }, options);
    } else {
      try {
        const currentLocation = options.location || await getCurrentLocation();
        result = {
          isValid: isValidGpsCoords(currentLocation),
          transitionMode: false,
          message: 'GPS siap.',
          location: currentLocation,
          source: currentLocation.source,
          accuracy: currentLocation.accuracy,
        };
      } catch (error) {
        result = {
          isValid: false,
          transitionMode: false,
          message: error.message || 'GPS wajib aktif untuk absensi.',
          code: error.code || 'GPS_REQUIRED',
        };
      }
    }
    setLocationError('');
    setLocationValidation(null);
    if (!result.isValid) {
      const msg = result.message || `Anda berada ${result.distance}m dari lokasi penugasan. Maksimal ${result.maxRadius}m.`;
      setLocationError(msg);
      if (isPermissionDeniedMessage(msg, result.code)) {
        setPermissionGuideFocus('location');
        setPermissionGuideOpen(true);
      }
      return result;
    }
    setLocation(result.location);
    setLocationValidation(result);
    return result;
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

  /** Direct live-camera capture. File/gallery inputs are intentionally excluded. */
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
        'Kamera langsung tidak tersedia. Pemilihan foto dari galeri dinonaktifkan untuk menjaga integritas bukti absensi.'
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

  // Check In/Out: fail-closed validation, then request a short-lived backend
  // challenge before the camera may produce an attendance proof.
  const startCamera = async (type) => {
    // Preparing an attendance flow reads GPS twice before the camera opens,
    // which can take tens of seconds on a weak fix. A React state flag updates
    // too late to stop a second tap in the same tick, so the guard is a ref:
    // every extra tap used to burn a server challenge and trip the 15-second
    // rate limit, which is what field users experienced as "gagal absen".
    if (startingAttendanceRef.current) return;
    startingAttendanceRef.current = true;
    setCheckType(type);
    setPendingCheckType(type);
    setLocationError('');
    setCameraStarting(true);
    setCameraMode('idle');
    setCameraHint('');
    setPresenceCode('');
    setEarlyLeaveReason('');

    try {
      if (attendanceLoadError) {
        throw new Error(attendanceLoadError);
      }
      if (
        type === 'in' &&
        (activeAttendance || expiredOpenAttendance || todayAttendance)
      ) {
        throw new Error(
          'Check-in baru tidak tersedia karena masih ada catatan shift yang harus diselesaikan.'
        );
      }
      if (type === 'out' && !activeAttendance) {
        throw new Error(
          'Shift aktif yang memenuhi syarat checkout tidak ditemukan. Muat ulang halaman.'
        );
      }

      // Check permission/accuracy before consuming a server challenge.
      setCameraHint('Membaca lokasi GPS… mohon tunggu, jangan tekan ulang.');
      const locationCheck = await validateLocation();
      if (!locationCheck.isValid) return;

      const action = type === 'out' ? 'checkOut' : 'checkIn';
      // Field staff may attend either their kelurahan or the project kantor;
      // best-effort pick which one this fix falls inside so the challenge is
      // requested against the right geofence. Reuses the fix just captured
      // instead of reading GPS again. Returns null (server default) for
      // anyone with only one candidate, or when the position doesn't clearly
      // match either.
      const assignmentChoice = await resolveAssignmentChoiceForLocation(
        userData,
        locationCheck.location,
      );
      setCameraHint('Meminta izin absensi dari server…');
      const challenge = await createAttendanceChallenge(action, assignmentChoice);
      setCameraHint('Memeriksa lokasi terhadap titik yang diizinkan…');
      // Reuse the fix that already passed the gate above. Reading GPS again
      // here gave the attempt a second, independent chance to fail on a coarse
      // reading - and by this point the challenge is already spent against the
      // daily quota, so that failure cost the employee an attempt for nothing.
      const challengeLocationCheck = await validateLocation(challenge, {
        location: locationCheck.location,
      });
      if (!challengeLocationCheck.isValid) {
        // The employee has to know the attempt was consumed; otherwise the
        // natural response is to press again immediately, which is what drives
        // accounts into the daily challenge limit.
        setLocationError(
          `${challengeLocationCheck.message || 'Lokasi tidak valid untuk absensi.'} ` +
            'Percobaan ini sudah terpakai dari jatah absensi hari ini. ' +
            'Pindah ke area terbuka, tunggu sekitar 15 detik, lalu tekan tombol SATU kali.'
        );
        return;
      }
      setCameraHint('Menyiapkan kamera…');
      attendanceChallengeRef.current = challenge;
      setAttendanceChallenge(challenge);
      setShowCamera(true);

      // getUserMedia is the only accepted client flow because a file input can
      // expose a gallery and allow an old photo to be submitted.
      await startInAppPreview();
    } catch (error) {
      console.error('Unable to start attendance flow:', error);
      const message = getAttendanceErrorMessage(error);
      setLocationError(message);
      attendanceChallengeRef.current = null;
      setAttendanceChallenge(null);
      setShowCamera(false);
      alert(message);
    } finally {
      startingAttendanceRef.current = false;
      setCameraStarting(false);
    }
  };

  const refreshCanonicalAttendance = async (result) => {
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const attendanceSnapshot = await getDoc(
          doc(db, 'attendances', result.attendanceId)
        );
        if (attendanceSnapshot.exists()) {
          const canonical = {
            id: attendanceSnapshot.id,
            ...attendanceSnapshot.data(),
          };
          setAttendanceCandidates((records) => [
            canonical,
            ...records.filter((record) => record.id !== canonical.id),
          ]);
          setLastSubmittedAttendance(canonical);
          setAttendanceHistory((history) => [
            canonical,
            ...history.filter((record) => record.id !== canonical.id),
          ]);
          return canonical;
        }
        lastError = new Error('Record canonical belum tersedia.');
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) {
        await new Promise(resolve =>
          window.setTimeout(resolve, 400 * (attempt + 1))
        );
      }
    }

    // The callable already committed successfully. Never synthesize a partial
    // record that could look unverified or still open; reload instead so only
    // the server-authored canonical document can drive the next action.
    console.warn('Canonical attendance refresh failed:', lastError);
    window.setTimeout(() => window.location.reload(), 1200);
    return null;
  };

  const processAttendancePhoto = async (blobOrFile) => {
    const challenge = attendanceChallengeRef.current || attendanceChallenge;
    if (!challenge) {
      throw new Error('Tantangan absensi tidak tersedia. Silakan ulangi dari awal.');
    }

    try {
      const normalizedEarlyLeaveReason = earlyLeaveReason.trim();
      if (
        challenge.action === 'checkOut' &&
        challenge.earlyLeaveReasonRequired === true &&
        !isValidEarlyLeaveReason(normalizedEarlyLeaveReason)
      ) {
        throw new Error(
          `Alasan pulang awal wajib diisi ${EARLY_LEAVE_REASON_MIN_LENGTH}-${EARLY_LEAVE_REASON_MAX_LENGTH} karakter.`
        );
      }
      if (
        challenge.presenceProofRequired === true &&
        !/^\d{6}$/.test(presenceCode.trim())
      ) {
        throw new Error('Masukkan kode kehadiran lokasi 6 digit sebelum mengambil foto.');
      }
      setCameraHint('Mengompres dan mengunggah bukti…');
      const compressed = await compressAttendancePhoto(blobOrFile, {
        mimeType: 'image/jpeg',
      });
      await uploadAttendanceProof(compressed, challenge);

      // GPS final diambil setelah upload agar capturedAt tetap segar saat
      // backend memvalidasi batas umur lokasi (jaringan lambat tidak memakai
      // koordinat lama). Perekaman deret sampel memerlukan belasan detik dan
      // titik yang dikirim wajib salah satu sampel itu, jadi lokasi diambil
      // sekali lalu dipakai ulang untuk validasi.
      setCameraHint(describeGpsCaptureStatus({ elapsedMs: 0, samples: 0 }));
      // Di dalam wrapper Android attested, listener OS berjalan pada jendela
      // yang sama dengan perekaman deret sampel. Di browser ini no-op.
      await beginDeviceObservation();
      const captured = await captureGpsSignalTrace({
        onProgress: (progress) => setCameraHint(
          describeGpsCaptureStatus(progress)
        ),
      });
      const deviceIntegrity = await collectDeviceIntegrity();
      setCameraHint(
        `Memverifikasi lokasi final… ${describeGpsTraceProgress(
          captured.trace
        )}`
      );
      const freshValidation = await (async () => {
        if (challenge.verificationMode === VERIFICATION_MODE_LOCATION_PHOTO) {
          return validateLocationAgainstAllowedLocations(
            challenge.allowedLocations,
            { location: captured.location },
          );
        }
        return validateLocationAgainstGeofence({
          ...challenge.geofence,
          nama: challenge.geofence?.name,
          isActive: true,
        }, { location: captured.location });
      })();
      if (!freshValidation.isValid || !isValidGpsCoords(freshValidation.location)) {
        const message = freshValidation.message || 'GPS wajib aktif untuk absensi.';
        setLocationError(message);
        throw new Error(message);
      }
      setLocation(freshValidation.location);
      setLocationValidation(freshValidation);

      setCameraHint('Memvalidasi absensi di server…');
      const result = await submitAttendance(
        challenge,
        freshValidation.location,
        presenceCode,
        normalizedEarlyLeaveReason,
        captured.trace,
        deviceIntegrity
      );
      const canonicalAttendance = await refreshCanonicalAttendance(result);

      const actionLabel = challenge.action === 'checkOut' ? 'Check-out' : 'Check-in';
      const successLines = [`${actionLabel} berhasil!`];
      if (challenge.action === 'checkOut' && result.workHours != null) {
        successLines.push(`Jam kerja: ${result.workHours} jam`);
      } else if (result.status) {
        successLines.push(
          `Status: ${result.status === 'late' ? 'Terlambat' : 'Tepat Waktu'}`
        );
      }
      if (challenge.action === 'checkOut' && result.earlyLeave === true) {
        successLines.push('Status checkout: Pulang awal');
      }
      if (!canonicalAttendance) {
        successLines.push(
          'Data sudah tersimpan; dashboard sedang disinkronkan ulang.'
        );
      }
      stopCamera();
      alert(successLines.join('\n'));
      return true;
    } catch (error) {
      console.error('Attendance submission failed:', error);
      const message = getAttendanceErrorMessage(error);
      alert(message);
      // Status upload dapat ambigu saat jaringan putus dan path create-only
      // tidak boleh ditimpa. Retry selalu memakai challenge/path baru.
      stopCamera();
      return false;
    } finally {
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
    setPendingCheckType('');
    attendanceChallengeRef.current = null;
    setAttendanceChallenge(null);
    setPresenceCode('');
    setEarlyLeaveReason('');
    setLocationError('');
    setCameraStarting(false);
    setCameraMode('idle');
    setCameraHint('');
  };

  // Enhanced capture photo with better error handling
  const capturePhoto = async () => {
    if (!attendanceChallengeRef.current && !attendanceChallenge) {
      alert(
        'Tantangan absensi tidak tersedia. Tutup kamera, muat ulang halaman, lalu mulai check-in dari awal.'
      );
      stopCamera();
      return;
    }
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

      // Resize down before the challenge-bound uploader compresses further.
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

      await processAttendancePhoto(blob);
    } catch (error) {
      console.error('Error capturing photo:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        videoReady: videoRef.current?.readyState,
        canvasAvailable: !!canvasRef.current
      });

      alert(`Gagal mengambil foto: ${error.message}\n\nFoto wajib untuk absensi — silakan coba lagi.`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Format time
  const formatTime = (timestamp) => {
    return formatWibTime(timestamp);
  };

  const employeeAttendanceState = useMemo(
    () => resolveEmployeeAttendanceState(
      attendanceCandidates,
      currentTime,
      auth.currentUser?.uid || '',
      maximumShiftDurationMs ?? 0
    ),
    [attendanceCandidates, currentTime, maximumShiftDurationMs]
  );
  const {
    today,
    todayAttendance,
    activeAttendance,
    expiredOpenAttendance,
  } = employeeAttendanceState;
  const attendanceForStatus =
    activeAttendance ||
    todayAttendance ||
    expiredOpenAttendance ||
    lastSubmittedAttendance;
  const attendanceForStatusOperational = isAttendanceWorkflowEligible(
    attendanceForStatus
  );
  const attendanceForStatusLocationPhoto = isLocationPhotoAttendance(
    attendanceForStatus
  );
  const attendanceCompletion =
    resolveAttendanceCompletion(attendanceForStatus);
  const todayAttendanceCompletion =
    resolveAttendanceCompletion(todayAttendance);
  const activeShiftIsOvernight = Boolean(
    activeAttendance && activeAttendance.date !== today
  );
  const maximumShiftDurationLabel = formatAttendanceShiftDuration(
    maximumShiftDurationMinutes
  );
  const attendanceForStatusIsCrossDay =
    isCrossDayAttendance(
      attendanceForStatus,
      attendanceCompletion.checkOut
    );
  const attendanceForStatusEarlyLeaveReason =
    getValidEarlyLeaveReason(attendanceForStatus);



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
    {currentTime.toLocaleTimeString('id-ID', {
      timeZone: ATTENDANCE_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })}
    </p>
    <p className="text-gray-600">
    {formatWibDate(currentTime, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })} WIB
    </p>
    </div>
    </div>
    </div>

    {/* Deliverables Portal Banner for Team Leader & Tenaga Ahli Manajemen Data */}
    {hasDeliverablesAccess(userData) && (
      <div className="bg-gradient-to-r from-blue-700 via-indigo-700 to-blue-800 text-white rounded-2xl shadow-lg p-5 mb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-2 border-blue-400/30">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center text-2xl shrink-0">
            📁
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="bg-yellow-300 text-amber-950 text-[11px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                {isTeamLeader(userData)
                  ? 'Portal Team Leader'
                  : isDataManagementExpert(userData)
                  ? 'Tenaga Ahli Manajemen Data'
                  : 'Portal Deliverables KAK'}
              </span>
              <span className="text-xs text-blue-200">
                PT Surya Abadi Konsultan
              </span>
            </div>
            <h3 className="font-bold text-base md:text-lg text-white mt-0.5">
              Pengiriman Laporan & Deliverables KAK
            </h3>
            <p className="text-xs text-blue-100 mt-0.5">
              Kelola dan unggah Laporan Pendahuluan, Laporan Bulanan (10 Periode), Triwulanan, Basis Data BNBA, dan Laporan Akhir.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => navigate('/deliverables')}
          className="w-full md:w-auto px-5 py-2.5 bg-yellow-300 hover:bg-yellow-200 text-amber-950 font-bold text-xs rounded-xl shadow-md transition transform active:scale-95 shrink-0 flex items-center justify-center gap-1.5"
        >
          <span>🚀</span>
          <span>Buka Portal Deliverables</span>
        </button>
      </div>
    )}

    {/* Current shift / today's attendance status */}
    <div className="bg-white rounded-xl shadow-md p-6 mb-6">
    <div className="mb-4">
    <h3 className="text-lg font-semibold text-gray-800">
      {activeShiftIsOvernight
        ? 'Shift Aktif Lintas Hari'
        : attendanceForStatus?.date && attendanceForStatus.date !== today
          ? 'Shift Terakhir'
          : 'Absensi Hari Ini'}
    </h3>
    {attendanceForStatus?.date && (
      <p className="mt-1 text-sm text-gray-500">
        Tanggal shift:{' '}
        {formatWibDate(attendanceForStatus.date, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })} WIB
      </p>
    )}
    {activeShiftIsOvernight && (
      <p className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
        Shift ini dimulai kemarin dan masih aktif. Selesaikan dengan check-out;
        jangan membuat check-in baru.
      </p>
    )}
    </div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
    <div className="bg-green-50 rounded-lg p-4 flex flex-col justify-between">
    <div>
    <p className="text-sm text-gray-600 font-medium">Check In</p>
    <p className="text-xl font-bold text-green-600 mt-1">
    {attendanceForStatus?.checkIn ? formatTime(attendanceForStatus.checkIn) : 'Belum'}
    </p>
    {attendanceForStatus?.checkIn && (
      <p className="mt-1 text-xs text-gray-500">
        {formatWibDateTime(attendanceForStatus.checkIn)}
      </p>
    )}
    {attendanceForStatus?.status && (
      <span className={`inline-block px-2.5 py-1 text-xs font-semibold rounded-full mt-2 ${
        !attendanceForStatusOperational
        ? 'bg-red-100 text-red-800'
        : attendanceForStatus.status === 'ontime'
          ? 'bg-green-100 text-green-800'
          : 'bg-amber-100 text-amber-900'
      }`}>
      {!attendanceForStatusOperational
        ? 'Unverified'
        : attendanceForStatus.status === 'ontime' ? '✓ On Time (≤ 08:10 WIB)' : '⚠ Terlambat (> 08:10 WIB)'}
      </span>
    )}
    </div>

    {attendanceForStatus?.checkInLocation && (
      <div className="mt-3 pt-2.5 border-t border-green-200/80 text-xs">
        <p className="font-semibold text-gray-800 flex items-center gap-1">
          <span>📍 Lokasi Masuk:</span>
        </p>
        <p className="text-gray-700 font-medium mt-0.5">
          {getAttendanceLocationLabel(attendanceForStatus, { action: 'checkIn' }) || 'Titik GPS'}
        </p>
        {attendanceForStatus.checkInLocation.lat != null && attendanceForStatus.checkInLocation.lng != null && (
          <a
            href={getGoogleMapsUrl(attendanceForStatus.checkInLocation)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 hover:underline font-mono text-[11px] mt-1 bg-white/80 px-2 py-0.5 rounded border border-green-300"
            title="Buka lokasi Check-In di Google Maps"
          >
            <span>🗺️ {attendanceForStatus.checkInLocation.lat.toFixed(5)}, {attendanceForStatus.checkInLocation.lng.toFixed(5)}</span>
            {attendanceForStatus.checkInLocation.accuracy != null && (
              <span className="text-gray-500">±{Math.round(attendanceForStatus.checkInLocation.accuracy)}m</span>
            )}
          </a>
        )}
      </div>
    )}
    </div>

    <div className="bg-blue-50 rounded-lg p-4 flex flex-col justify-between">
    <div>
    <p className="text-sm text-gray-600 font-medium">Check Out</p>
    <p className="text-xl font-bold text-blue-600 mt-1">
    {attendanceCompletion.checkOut
      ? attendanceForStatusIsCrossDay
        ? formatWibDateTime(attendanceCompletion.checkOut)
        : formatTime(attendanceCompletion.checkOut)
      : 'Belum'}
    </p>
    {attendanceCompletion.checkOut && !attendanceForStatusIsCrossDay && (
      <span className={`inline-block px-2.5 py-1 text-xs font-semibold rounded-full mt-2 ${
        attendanceForStatus?.earlyLeave === true
          ? 'bg-amber-100 text-amber-900'
          : 'bg-green-100 text-green-800'
      }`}>
        {attendanceForStatus?.earlyLeave === true
          ? '⚠ Pulang Awal (< 16:00 WIB)'
          : '✓ Pulang Tepat Waktu (≥ 16:00 WIB)'}
      </span>
    )}
    {attendanceForStatusIsCrossDay && (
      <span className="mt-2 inline-block rounded bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800">
        Checkout lintas hari
      </span>
    )}
    {attendanceCompletion.manualCorrection && (
      <span className="mt-2 inline-block rounded bg-orange-100 px-2 py-1 text-xs font-medium text-orange-900">
        Koreksi administratif — bukan checkout GPS/selfie terverifikasi
      </span>
    )}
    {attendanceForStatus?.earlyLeave === true && attendanceForStatusEarlyLeaveReason && (
      <div className="mt-2 p-2 bg-amber-100/70 rounded border border-amber-200 text-xs">
        <span className="font-semibold text-amber-950">Alasan pulang awal:</span>
        <p className="text-amber-900 mt-0.5">{attendanceForStatusEarlyLeaveReason}</p>
      </div>
    )}
    </div>

    {attendanceForStatus?.checkOutLocation && (
      <div className="mt-3 pt-2.5 border-t border-blue-200/80 text-xs">
        <p className="font-semibold text-gray-800 flex items-center gap-1">
          <span>📍 Lokasi Pulang:</span>
        </p>
        <p className="text-gray-700 font-medium mt-0.5">
          {getAttendanceLocationLabel(attendanceForStatus, { action: 'checkOut' }) || 'Titik GPS'}
        </p>
        {attendanceForStatus.checkOutLocation.lat != null && attendanceForStatus.checkOutLocation.lng != null && (
          <a
            href={getGoogleMapsUrl(attendanceForStatus.checkOutLocation)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 hover:underline font-mono text-[11px] mt-1 bg-white/80 px-2 py-0.5 rounded border border-blue-300"
            title="Buka lokasi Check-Out di Google Maps"
          >
            <span>🗺️ {attendanceForStatus.checkOutLocation.lat.toFixed(5)}, {attendanceForStatus.checkOutLocation.lng.toFixed(5)}</span>
            {attendanceForStatus.checkOutLocation.accuracy != null && (
              <span className="text-gray-500">±{Math.round(attendanceForStatus.checkOutLocation.accuracy)}m</span>
            )}
          </a>
        )}
      </div>
    )}
    </div>

    <div className="bg-purple-50 rounded-lg p-4 flex flex-col justify-between">
    <div>
    <p className="text-sm text-gray-600 font-medium">Work Hours</p>
    <p className="text-xl font-bold text-purple-600 mt-1">
    {attendanceForStatusOperational &&
    attendanceCompletion.isComplete &&
    attendanceCompletion.workHours != null
      ? `${attendanceCompletion.workHours} hours`
      : '-'}
    </p>
    </div>
    <div className="mt-3 pt-2 text-xs text-gray-500 border-t border-purple-200/60">
      <p>Jam kerja normal: 08:00 - 16:00 WIB</p>
      <p>Check-in on-time: maks 08:10 WIB</p>
    </div>
    </div>
    </div>

    {/* Check In/Out Buttons */}
    <div id="attendance-action-section" className="mt-6 flex gap-4">
    {attendanceLoadError ? (
      <div className="flex-1 rounded-lg border border-red-200 bg-red-50 px-6 py-3 text-center text-red-800">
        <p className="font-semibold">Status shift tidak dapat diverifikasi</p>
        <p className="mt-1 text-sm">{attendanceLoadError}</p>
      </div>
    ) : activeAttendance ? (
      <button
      onClick={() => startCamera('out')}
      disabled={cameraStarting}
      className={`flex-1 text-white py-3 px-6 rounded-lg font-semibold transition-colors flex items-center justify-center space-x-2 ${
        cameraStarting
          ? 'bg-gray-400 cursor-not-allowed'
          : 'bg-blue-600 hover:bg-blue-700'
      }`}
      >
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
      </svg>
      <span>
        {cameraStarting
          ? 'Menyiapkan absensi…'
          : activeShiftIsOvernight
            ? 'Check Out Shift Kemarin'
            : 'Check Out'}
      </span>
      </button>
    ) : expiredOpenAttendance ? (
      <div className="flex-1 rounded-lg border border-orange-200 bg-orange-50 px-6 py-3 text-center text-orange-900">
        <p className="font-semibold">
          Shift terbuka sudah melewati {maximumShiftDurationLabel}
        </p>
        <p className="mt-1 text-sm">
          Checkout otomatis dinonaktifkan. Hubungi admin untuk penanganan tanpa
          mengubah bukti absensi asli.
        </p>
      </div>
    ) : !todayAttendance ? (
      <button
      onClick={() => startCamera('in')}
      disabled={cameraStarting}
      className={`flex-1 text-white py-3 px-6 rounded-lg font-semibold transition-colors flex items-center justify-center space-x-2 ${
        cameraStarting
          ? 'bg-gray-400 cursor-not-allowed'
          : 'bg-green-600 hover:bg-green-700'
      }`}
      >
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      <span>
        {cameraStarting ? 'Menyiapkan absensi…' : 'Check In Hari Ini'}
      </span>
      </button>
    ) : !isAttendanceWorkflowEligible(todayAttendance) ? (
      <div className="flex-1 rounded-lg border border-red-200 bg-red-50 px-6 py-3 text-center text-red-800">
        <p className="font-semibold">Catatan hari ini belum terverifikasi</p>
        <p className="mt-1 text-sm">
          Data legacy/transisi tidak dihitung hadir dan tidak dapat di-check-out. Hubungi admin.
        </p>
      </div>
    ) : !todayAttendanceCompletion.isComplete ? (
      <div className="flex-1 rounded-lg border border-orange-200 bg-orange-50 px-6 py-3 text-center text-orange-900">
        <p className="font-semibold">Shift tidak dapat dilanjutkan otomatis</p>
        <p className="mt-1 text-sm">
          Waktu check-in tidak memenuhi jendela shift aktif. Muat ulang halaman
          atau hubungi admin.
        </p>
      </div>
    ) : (
      <div className="flex-1 bg-gray-100 text-gray-600 py-3 px-6 rounded-lg text-center">
      <p className="font-semibold">Absensi hari ini selesai</p>
      <p className="text-sm mt-1">Terima kasih.</p>
      </div>
    )}
    </div>

    {/* Reading GPS can take tens of seconds. Without a moving status the user
        reads the screen as frozen and taps again, which burns a server
        challenge and trips the rate limit. */}
    {cameraStarting && (
      <div
        className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-center text-blue-900"
        aria-live="polite"
      >
        <p className="text-sm font-medium">
          {cameraHint || 'Mohon tunggu…'}
        </p>
        <p className="mt-1 text-xs text-blue-700">
          Jangan menekan tombol berulang kali. Proses ini bisa memakan waktu
          sampai setengah menit bila sinyal GPS lemah.
        </p>
      </div>
    )}

    {locationValidation?.transitionMode && (
      <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
      <p className="text-yellow-900 text-sm font-medium">
        Mode operasional sementara — GPS + foto
      </p>
      <p className="text-yellow-800 text-sm mt-1">{locationValidation.message}</p>
      <p className="text-yellow-700 text-xs mt-2">
        Geofence dual-control dan keberadaan onsite tidak terverifikasi.
        GPS browser dapat dipalsukan.
      </p>
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

    {/* Camera Modal */}
    {showCamera && (
      <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6">
      <h3 className="text-lg font-semibold mb-2">
      Selfie Check {checkType === 'in' ? 'In' : 'Out'}
      </h3>
      <p className="text-sm text-gray-600 mb-4">
      {cameraHint ||
        (attendanceChallenge?.verificationMode ===
        VERIFICATION_MODE_LOCATION_PHOTO
          ? 'Ambil selfie langsung. Foto dan titik GPS akan dicatat.'
          : 'Ambil foto wajah untuk verifikasi kehadiran.')}
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

      {cameraMode === 'failed' && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-100 p-4 text-center">
          <p className="text-sm text-red-900 font-medium">
            Kamera langsung wajib tersedia. Foto dari file atau galeri tidak dapat digunakan untuk absensi.
          </p>
          <button
            type="button"
            onClick={() => openPermissionGuide('both')}
            className="mt-2 text-sm text-red-800 underline"
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
        <div className={`mb-4 p-3 rounded-lg ${
          attendanceChallenge?.verificationMode ===
          VERIFICATION_MODE_LOCATION_PHOTO
            ? 'bg-amber-50'
            : 'bg-green-50'
        }`}>
        <p className={`text-sm ${
          attendanceChallenge?.verificationMode ===
          VERIFICATION_MODE_LOCATION_PHOTO
            ? 'text-amber-900'
            : 'text-green-800'
        }`}>
        {attendanceChallenge?.verificationMode ===
        VERIFICATION_MODE_LOCATION_PHOTO
          ? (locationValidation?.matchedLocation
            ? `Lokasi operasional: ${locationValidation.matchedLocation.name || locationValidation.matchedLocation.nama} (akurasi ±${Math.round(location.accuracy)}m)`
            : `Titik GPS terekam (akurasi ±${Math.round(location.accuracy)}m)`)
          : '✓ Lokasi terverifikasi'}
        </p>
        </div>
      )}

      {attendanceChallenge?.presenceProofRequired === true && (
        <div className="mb-4">
          <label htmlFor="attendance-presence-code" className="block text-sm font-medium text-gray-800 mb-1">
            Kode kehadiran lokasi (6 digit)
          </label>
          <input
            id="attendance-presence-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={presenceCode}
            onChange={(event) =>
              setPresenceCode(event.target.value.replace(/\D/g, '').slice(0, 6))
            }
            placeholder="000000"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-center text-xl tracking-[0.35em]"
          />
          <p className="mt-1 text-xs text-gray-500">
            Minta kode aktif kepada petugas di lokasi. Kode berubah secara berkala.
          </p>
        </div>
      )}

      {attendanceChallenge?.action === 'checkOut' &&
        attendanceChallenge?.earlyLeaveReasonRequired === true && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <label
            htmlFor="early-leave-reason"
            className="block text-sm font-semibold text-amber-950 mb-1"
          >
            Alasan pulang awal (wajib)
          </label>
          <textarea
            id="early-leave-reason"
            rows={3}
            required
            minLength={EARLY_LEAVE_REASON_MIN_LENGTH}
            maxLength={EARLY_LEAVE_REASON_MAX_LENGTH}
            value={earlyLeaveReason}
            onChange={(event) => setEarlyLeaveReason(event.target.value)}
            placeholder="Contoh: izin berobat berdasarkan persetujuan atasan"
            disabled={isProcessing}
            className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:opacity-60"
          />
          <div className="mt-1 flex justify-between gap-3 text-xs text-amber-900">
            <span>
              Minimal {EARLY_LEAVE_REASON_MIN_LENGTH} karakter setelah dirapikan.
            </span>
            <span>
              {earlyLeaveReason.trim().length}/{EARLY_LEAVE_REASON_MAX_LENGTH}
            </span>
          </div>
          <p className="mt-1 text-xs font-medium text-amber-950">
            Check-out ini akan ditandai sebagai pulang awal.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
      {cameraMode === 'preview' ? (
        <button
        onClick={capturePhoto}
        disabled={
          isProcessing ||
          cameraStarting ||
          !attendanceChallenge ||
          (attendanceChallenge?.presenceProofRequired === true &&
            !/^\d{6}$/.test(presenceCode)) ||
          (attendanceChallenge?.action === 'checkOut' &&
            attendanceChallenge?.earlyLeaveReasonRequired === true &&
            !isValidEarlyLeaveReason(earlyLeaveReason))
        }
        className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
        >
        {isProcessing ? 'Memproses…' : 'Ambil Foto'}
        </button>
      ) : (
        <button
        type="button"
        onClick={startInAppPreview}
        disabled={isProcessing || cameraStarting}
        className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center justify-center"
        >
        {cameraStarting ? 'Menyiapkan kamera…' : 'Coba Kamera Langsung'}
        </button>
      )}

      <div className="flex gap-3">
      <button
      onClick={stopCamera}
      disabled={isProcessing}
      className="flex-1 px-6 py-3 bg-gray-500 text-white rounded-lg font-semibold hover:bg-gray-600 transition-colors disabled:opacity-50"
      >
      Batal
      </button>
      </div>
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
    <th className="text-left py-2 px-2 text-sm font-medium text-gray-600">Lokasi</th>
    <th className="text-left py-2 px-2 text-sm font-medium text-gray-600">Work Hours</th>
    </tr>
    </thead>
    <tbody>
    {attendanceHistory.length > 0 ? (
      attendanceHistory.map((record) => {
        const completion = resolveAttendanceCompletion(record);
        const validEarlyLeaveReason = getValidEarlyLeaveReason(record);
        const recordForDisplay = {
          ...record,
          checkOut: completion.checkOut,
        };
        const inLocLabel = getAttendanceLocationLabel(record, { action: 'checkIn' });
        const outLocLabel = getAttendanceLocationLabel(record, { action: 'checkOut' });
        return (
        <tr key={record.id} className="border-b">
        <td className="py-2 px-2 text-sm whitespace-nowrap">
        {formatWibDate(record.date, {
          weekday: 'short',
          day: 'numeric',
          month: 'short'
        })}
        </td>
        <td className="py-2 px-2 text-sm">
        {record.checkIn ? formatTime(record.checkIn) : '-'}
        </td>
        <td className="py-2 px-2 text-sm">
        {completion.checkOut
          ? isCrossDayAttendance(record, completion.checkOut)
            ? formatWibDateTime(completion.checkOut)
            : formatTime(completion.checkOut)
          : '-'}
        {isCrossDayAttendance(recordForDisplay) && (
          <span className="mt-1 block text-xs font-medium text-blue-700">
            Lintas hari
          </span>
        )}
        {completion.manualCorrection && (
          <span className="mt-1 block text-xs font-medium text-orange-800">
            Koreksi admin · bukan bukti perangkat
          </span>
        )}
        </td>
        <td className="py-2 px-2">
        <span className={`inline-block px-2 py-1 text-xs rounded-full ${
          !isAttendanceWorkflowEligible(record)
          ? 'bg-red-100 text-red-800'
          : record.status === 'ontime'
            ? 'bg-green-100 text-green-800'
            : 'bg-yellow-100 text-yellow-800'
        }`}>
        {!isAttendanceWorkflowEligible(record)
          ? 'Unverified'
          : record.status === 'ontime' ? 'On Time' : 'Late'}
        </span>
        {record.earlyLeave === true && (
          <div className="mt-1">
            <span className="inline-block rounded bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900">
              Pulang awal
            </span>
            {validEarlyLeaveReason && (
              <p className="mt-1 max-w-xs text-xs text-amber-950">
                Alasan: {validEarlyLeaveReason}
              </p>
            )}
          </div>
        )}
        </td>
        <td className="py-2 px-2 text-xs">
          {inLocLabel && (
            <div className="text-gray-700">
              <span className="text-gray-500 text-[11px]">Masuk: </span>
              {record.checkInLocation?.lat ? (
                <a
                  href={getGoogleMapsUrl(record.checkInLocation)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline inline-flex items-center gap-0.5"
                >
                  {inLocLabel}
                </a>
              ) : inLocLabel}
            </div>
          )}
          {outLocLabel && (
            <div className="text-gray-700 mt-0.5">
              <span className="text-gray-500 text-[11px]">Pulang: </span>
              {record.checkOutLocation?.lat ? (
                <a
                  href={getGoogleMapsUrl(record.checkOutLocation)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline inline-flex items-center gap-0.5"
                >
                  {outLocLabel}
                </a>
              ) : outLocLabel}
            </div>
          )}
          {!inLocLabel && !outLocLabel && '-'}
        </td>
        <td className="py-2 px-2 text-sm whitespace-nowrap">
        {isAttendanceWorkflowEligible(record) && completion.isComplete
          ? `${completion.workHours}h`
          : '-'}
        </td>
        </tr>
        );
      })
    ) : (
      <tr>
      <td colSpan="6" className="text-center py-4 text-gray-500">
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
