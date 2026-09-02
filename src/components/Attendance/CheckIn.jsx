import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../../services/firebase';
import {
  formatAttendanceShiftDuration,
  getEmployeeAttendanceState,
  resolveEmployeeAttendanceState,
} from '../../services/database';
import { validateLocationForUser } from '../../services/geofenceService';
import {
  isValidGpsCoords,
  validateLocationAgainstAllowedLocations,
  validateLocationAgainstGeofence,
} from '../../utils/geolocation';
import {
  captureGpsSignalTrace,
  describeGpsCaptureStatus,
} from '../../utils/gpsSignalTrace';
import {
  beginDeviceObservation,
  collectDeviceIntegrity,
} from '../../utils/deviceIntegrity';
import {
  ATTENDANCE_TIMEZONE,
  formatWibDate,
  formatWibTime,
} from '../../utils/attendanceTime';
import {
  createAttendanceChallenge,
  getAttendanceErrorMessage,
  submitAttendance,
  uploadAttendanceProof,
  VERIFICATION_MODE_LOCATION_PHOTO,
} from '../../services/attendanceService';
import { compressAttendancePhoto } from '../../utils/compressAttendancePhoto';
import { isVerifiedAttendance } from '../../utils/attendanceIntegrity';
import { resolveAttendanceCompletion } from '../../utils/attendanceCorrection';
import { PROJECT } from '../../config/projectConfig';

const CheckIn = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progressHint, setProgressHint] = useState('');
  const [location, setLocation] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [photoError, setPhotoError] = useState(null);
  const [showCamera, setShowCamera] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [attendanceCandidates, setAttendanceCandidates] = useState([]);
  const [attendanceStateReady, setAttendanceStateReady] = useState(false);
  const [attendanceLoadError, setAttendanceLoadError] = useState('');
  const [
    maximumShiftDurationMinutes,
    setMaximumShiftDurationMinutes,
  ] = useState(null);
  const [maximumShiftDurationMs, setMaximumShiftDurationMs] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [attendanceChallenge, setAttendanceChallenge] = useState(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [presenceCode, setPresenceCode] = useState('');
  
  // Camera refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const submittingRef = useRef(false);

  const checkEmployeeAttendance = useCallback(async () => {
    if (user) {
      setAttendanceStateReady(false);
      const attendanceState = await getEmployeeAttendanceState(user.uid);
      setAttendanceCandidates(attendanceState.records);
      setAttendanceLoadError(attendanceState.loadError || '');
      setMaximumShiftDurationMinutes(
        attendanceState.maximumShiftDurationMinutes
      );
      setMaximumShiftDurationMs(attendanceState.maximumShiftDurationMs);
      setAttendanceStateReady(true);
    }
  }, [user]);
  
  useEffect(() => {
    // Get current user from auth
    const unsubscribe = auth.onAuthStateChanged(async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        // Get user data from Firestore
        try {
          const { doc, getDoc } = await import('firebase/firestore');
          const { db } = await import('../../services/firebase');
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (userDoc.exists()) {
            setUserData(userDoc.data());
          }
        } catch (error) {
          console.error('Error fetching user data:', error);
        }
      } else {
        navigate('/login');
      }
    });

    return () => unsubscribe();
  }, [navigate]);

  useEffect(() => {
    if (user) {
      checkEmployeeAttendance();
    }
  }, [user, checkEmployeeAttendance]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  
  const employeeAttendanceState = useMemo(
    () => resolveEmployeeAttendanceState(
      attendanceCandidates,
      currentTime,
      user?.uid || '',
      maximumShiftDurationMs ?? 0
    ),
    [
      attendanceCandidates,
      currentTime,
      maximumShiftDurationMs,
      user?.uid,
    ]
  );
  const {
    today,
    todayAttendance,
    activeAttendance,
    expiredOpenAttendance,
  } = employeeAttendanceState;
  const activeShiftIsOvernight = Boolean(
    activeAttendance && activeAttendance.date !== today
  );
  const maximumShiftDurationLabel = formatAttendanceShiftDuration(
    maximumShiftDurationMinutes
  );
  const todayAttendanceCompletion =
    resolveAttendanceCompletion(todayAttendance);
  const canStartCheckIn = Boolean(
    attendanceStateReady &&
    !attendanceLoadError &&
    !activeAttendance &&
    !expiredOpenAttendance &&
    !todayAttendance
  );

  // Initialize camera
  const startCamera = async () => {
    try {
      setPhotoError(null);
      setError('');
      setPhoto(null);
      setPresenceCode('');

      if (!attendanceStateReady || attendanceLoadError) {
        setError(
          attendanceLoadError ||
            'Status shift masih dimuat. Tunggu sebentar lalu coba lagi.'
        );
        return;
      }
      if (activeAttendance) {
        setError(
          'Masih ada shift aktif. Selesaikan check-out melalui dashboard karyawan.'
        );
        return;
      }
      if (expiredOpenAttendance) {
        setError(
          `Shift terbuka sudah melewati ${maximumShiftDurationLabel}. ` +
          'Hubungi admin sebelum membuat shift baru.'
        );
        return;
      }
      if (todayAttendance) {
        setError('Catatan absensi hari ini sudah tersedia.');
        return;
      }

      const challenge = await createAttendanceChallenge('checkIn');
      let initialValidation;
      if (challenge.verificationMode === VERIFICATION_MODE_LOCATION_PHOTO) {
        initialValidation = await validateLocationAgainstAllowedLocations(
          challenge.allowedLocations,
        );
      } else {
        initialValidation = await validateLocationForUser(userData);
        if (initialValidation.isValid) {
          initialValidation = await validateLocationAgainstGeofence({
            ...challenge.geofence,
            nama: challenge.geofence?.name,
            isActive: true,
          });
        }
      }
      if (!initialValidation.isValid) {
        setError(initialValidation.message || 'Lokasi penugasan tidak valid.');
        return;
      }
      setAttendanceChallenge(challenge);
      setLocation(initialValidation.location);
      setShowCamera(true);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      
      // Check if camera is supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera tidak didukung di browser ini.');
      }
      
      // Request camera permission
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error('Error accessing camera:', error);
      setShowCamera(false);
      setAttendanceChallenge(null);
      setPhotoError(
        getAttendanceErrorMessage(error) ||
          'Camera tidak dapat diakses. Aktifkan izin kamera lalu coba lagi.'
      );
    }
  };

  // Stop camera
  const stopCamera = (preserveChallenge = false) => {
    if (videoRef.current && videoRef.current.srcObject) {
      const tracks = videoRef.current.srcObject.getTracks();
      tracks.forEach(track => track.stop());
    }
    setShowCamera(false);
    setPhotoError(null);
    if (!preserveChallenge) {
      setAttendanceChallenge(null);
      setPhoto(null);
      setPresenceCode('');
    }
  };

  // Capture photo
  const capturePhoto = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setIsProcessing(true);

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0);

      // Convert to blob
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      const file = new File([blob], "selfie.jpg", { type: "image/jpeg" });
      
      setPhoto(file);
      stopCamera(true);
    } catch (error) {
      console.error('Error capturing photo:', error);
      setPhotoError('Failed to capture photo. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCheckIn = async () => {
    // The disabled attribute only applies after a re-render; a fast double tap
    // would otherwise start two flows and burn two server challenges.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      if (!attendanceStateReady || attendanceLoadError) {
        setError(
          attendanceLoadError ||
            'Status shift masih dimuat. Tunggu sebentar lalu coba lagi.'
        );
        setLoading(false);
        return;
      }
      if (activeAttendance) {
        setError(
          'Masih ada shift aktif. Selesaikan check-out melalui dashboard karyawan.'
        );
        setLoading(false);
        return;
      }
      if (expiredOpenAttendance) {
        setError(
          `Shift terbuka sudah melewati ${maximumShiftDurationLabel}. ` +
          'Hubungi admin sebelum membuat shift baru.'
        );
        setLoading(false);
        return;
      }
      if (todayAttendance) {
        setError('Catatan absensi hari ini sudah tersedia.');
        setLoading(false);
        return;
      }

      // Foto selfie wajib — tidak ada opsi skip/galeri
      if (!photo) {
        setError('Foto selfie wajib untuk check in. Ambil foto dengan kamera terlebih dahulu.');
        setLoading(false);
        return;
      }

      if (!attendanceChallenge) {
        setError('Tantangan absensi tidak tersedia. Ambil selfie ulang.');
        setLoading(false);
        return;
      }
      if (
        attendanceChallenge.presenceProofRequired === true &&
        !/^\d{6}$/.test(presenceCode.trim())
      ) {
        setError('Kode kehadiran lokasi wajib diisi dengan tepat 6 digit.');
        setLoading(false);
        return;
      }

      // Validasi ulang memakai lokasi canonical dari challenge backend.
      const locationValidation =
        attendanceChallenge.verificationMode === VERIFICATION_MODE_LOCATION_PHOTO
          ? await validateLocationAgainstAllowedLocations(
            attendanceChallenge.allowedLocations,
          )
          : await validateLocationAgainstGeofence({
            ...attendanceChallenge.geofence,
            nama: attendanceChallenge.geofence?.name,
            isActive: true,
          });

      if (!locationValidation.isValid || !isValidGpsCoords(locationValidation.location)) {
        setError(locationValidation.message || 'GPS wajib aktif untuk absensi.');
        setLoading(false);
        return;
      }

      setLocation(locationValidation.location);

      // Upload hanya ke path challenge, lalu backend menghitung seluruh field.
      try {
        const compressed = await compressAttendancePhoto(photo, {
          mimeType: 'image/jpeg',
        });
        await uploadAttendanceProof(compressed, attendanceChallenge);
        // Satu perekaman deret sampel GPS, dipakai untuk validasi final dan
        // dikirim sebagai bukti sinyal ke backend. Bukti OS hanya terisi bila
        // berjalan di dalam wrapper Android attested.
        await beginDeviceObservation();
        setProgressHint(
          describeGpsCaptureStatus({ elapsedMs: 0, samples: 0 })
        );
        const captured = await captureGpsSignalTrace({
          onProgress: (progress) => setProgressHint(
            describeGpsCaptureStatus(progress)
          ),
        });
        setProgressHint('Memverifikasi absensi di server…');
        const deviceIntegrity = await collectDeviceIntegrity();
        const finalLocationValidation =
          attendanceChallenge.verificationMode === VERIFICATION_MODE_LOCATION_PHOTO
            ? await validateLocationAgainstAllowedLocations(
              attendanceChallenge.allowedLocations,
              { location: captured.location },
            )
            : await validateLocationAgainstGeofence({
              ...attendanceChallenge.geofence,
              nama: attendanceChallenge.geofence?.name,
              isActive: true,
            }, { location: captured.location });
        if (
          !finalLocationValidation.isValid ||
          !isValidGpsCoords(finalLocationValidation.location)
        ) {
          throw new Error(
            finalLocationValidation.message || 'GPS final tidak valid.'
          );
        }
        setLocation(finalLocationValidation.location);
        await submitAttendance(
          attendanceChallenge,
          finalLocationValidation.location,
          presenceCode,
          '',
          captured.trace,
          deviceIntegrity
        );
      } catch (uploadError) {
        console.error('Error submitting attendance:', uploadError);
        setError(getAttendanceErrorMessage(uploadError));
        // Status upload dapat ambigu saat jaringan putus. Karena path bersifat
        // create-only, selalu mulai ulang dengan challenge baru.
        setPhoto(null);
        setAttendanceChallenge(null);
        setPresenceCode('');
        setLoading(false);
        return;
      }

      setSuccess('Check in berhasil!');
      setPhoto(null);
      setAttendanceChallenge(null);
      setPresenceCode('');
      await checkEmployeeAttendance();
      
    } catch (error) {
      console.error('Check in error:', error);
      setError('Check in gagal: ' + error.message);
    } finally {
      submittingRef.current = false;
      setLoading(false);
      setProgressHint('');
    }
  };
  
  return (
    <div className="max-w-md mx-auto p-4">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Check In</h2>
          <p className="text-gray-600">{PROJECT.shortName}</p>
        </div>
        
        {/* Current time display */}
        <div className="text-center mb-6 p-4 bg-blue-50 rounded-lg">
          <div className="text-3xl font-bold text-blue-600">
            {currentTime.toLocaleTimeString('id-ID', {
              timeZone: ATTENDANCE_TIMEZONE,
            })}
          </div>
          <div className="text-gray-600 mt-1">
            {formatWibDate(currentTime, {
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            })} WIB
          </div>
        </div>
        
        {/* Status display */}
        {!attendanceStateReady ? (
          <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-center text-gray-700">
            Memuat status shift…
          </div>
        ) : attendanceLoadError ? (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-center text-red-800">
            <div className="font-semibold">Status shift tidak dapat diverifikasi</div>
            <div className="mt-1 text-sm">{attendanceLoadError}</div>
          </div>
        ) : activeAttendance ? (
          <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="text-center">
              <div className="font-semibold text-blue-700">
                {activeShiftIsOvernight
                  ? 'Shift kemarin masih aktif'
                  : 'Shift hari ini masih aktif'}
              </div>
              <div className="mt-1 text-sm text-blue-700">
                Tanggal shift:{' '}
                {formatWibDate(activeAttendance.date, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}; check-in {formatWibTime(activeAttendance.checkIn)} WIB
              </div>
              <button
                type="button"
                onClick={() => navigate('/employee')}
                className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white hover:bg-blue-700"
              >
                Lanjutkan Check Out di Dashboard
              </button>
            </div>
          </div>
        ) : expiredOpenAttendance ? (
          <div className="mb-6 rounded-lg border border-orange-200 bg-orange-50 p-4 text-center text-orange-900">
            <div className="font-semibold">
              Shift terbuka melewati {maximumShiftDurationLabel}
            </div>
            <div className="mt-1 text-sm">
              Check-in baru dan checkout otomatis dinonaktifkan. Hubungi admin.
            </div>
          </div>
        ) : todayAttendance ? (
          <div className={`mb-6 rounded-lg border p-4 ${
            isVerifiedAttendance(todayAttendance)
              ? 'border-green-200 bg-green-50'
              : 'border-red-200 bg-red-50'
          }`}>
            <div className="text-center">
              <div className={`font-semibold ${
                isVerifiedAttendance(todayAttendance)
                  ? 'text-green-700'
                  : 'text-red-700'
              }`}>
                {isVerifiedAttendance(todayAttendance)
                  ? todayAttendanceCompletion.isComplete
                    ? 'Absensi hari ini selesai'
                    : 'Shift hari ini sudah dimulai'
                  : 'Catatan hari ini belum terverifikasi'}
              </div>
              {todayAttendanceCompletion.manualCorrection && (
                <div className="mt-2 text-xs font-medium text-orange-800">
                  Selesai melalui koreksi administratif; bukan checkout GPS/selfie
                  terverifikasi.
                </div>
              )}
              <div className="mt-1 text-sm text-gray-600">
                {todayAttendance.checkIn
                  ? `${formatWibDate(todayAttendance.checkIn, {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}, ${formatWibTime(todayAttendance.checkIn)} WIB`
                  : 'Tidak ada check-in terverifikasi.'}
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="text-center">
              <div className="text-yellow-600 font-semibold">⏰ Belum Check In</div>
              <div className="text-sm text-yellow-600 mt-1">
                Silakan lakukan check in
              </div>
            </div>
          </div>
        )}
        
        {/* Error/Success messages */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg">
            {error}
          </div>
        )}
        
        {success && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-lg">
            {success}
          </div>
        )}
        
        {/* Location status */}
        {location && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <span className="text-blue-600 mr-2 text-lg">📍</span>
                <div>
                  <div className="text-sm font-semibold text-blue-900">Lokasi Dinamis Terdeteksi</div>
                  <div className="text-xs text-blue-700 font-mono">
                    Lat: {location.lat.toFixed(5)}, Lng: {location.lng.toFixed(5)}
                    {location.accuracy != null && (
                      <span className="ml-1 text-gray-500 font-sans">(akurasi ±{Math.round(location.accuracy)}m)</span>
                    )}
                  </div>
                </div>
              </div>
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.lat},${location.lng}`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-blue-700 hover:text-blue-900 underline bg-white/80 px-2 py-1 rounded border border-blue-200"
              >
                Buka Peta ↗
              </a>
            </div>
          </div>
        )}
        
        {/* Photo upload */}
        {canStartCheckIn && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Foto Selfie (Wajib)
            </label>

            <div className="space-y-2">
              <button
                type="button"
                onClick={startCamera}
                className="w-full py-3 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                📷 Buka Camera
              </button>
            </div>

            {photo && (
              <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm text-green-700">
                  ✅ Foto dipilih: {photo.name}
                </p>
              </div>
            )}

            {photoError && (
              <p className="text-xs text-red-500 mt-1">
                {photoError}
              </p>
            )}

            <p className="text-xs text-gray-500 mt-2">
              📱 Foto selfie wajib diambil langsung dari kamera untuk check in
            </p>
          </div>
        )}

        {canStartCheckIn &&
          attendanceChallenge?.presenceProofRequired === true && (
            <div className="mb-6">
              <label htmlFor="checkin-presence-code" className="block text-sm font-medium text-gray-700 mb-2">
                Kode kehadiran lokasi (6 digit)
              </label>
              <input
                id="checkin-presence-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={presenceCode}
                onChange={(event) =>
                  setPresenceCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-center text-xl tracking-[0.35em]"
                placeholder="000000"
              />
              <p className="mt-1 text-xs text-gray-500">
                Minta kode aktif kepada petugas di lokasi.
              </p>
            </div>
          )}
        
        {/* Check in button */}
        {canStartCheckIn && (
          <button
            onClick={handleCheckIn}
            disabled={
              loading ||
              (attendanceChallenge?.presenceProofRequired === true &&
                !/^\d{6}$/.test(presenceCode))
            }
            className={`w-full py-4 px-6 rounded-lg font-bold text-white text-lg transition-colors ${
              loading 
                ? 'bg-gray-400 cursor-not-allowed' 
                : 'bg-green-600 hover:bg-green-700'
            }`}
          >
            {loading ? 'Memproses...' : '📍 CHECK IN'}
          </button>
        )}

        {/* Perekaman GPS berlangsung belasan detik; status harus terlihat
            bergerak agar tidak dibaca sebagai aplikasi macet. */}
        {loading && progressHint && (
          <p
            className="mt-3 text-center text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg p-3"
            aria-live="polite"
          >
            {progressHint}
          </p>
        )}
        
        {/* User info */}
        <div className="mt-6 pt-4 border-t border-gray-200">
          <div className="text-center text-sm text-gray-600">
            <p className="font-medium">{userData?.name || user?.displayName}</p>
            <p>{userData?.employeeId}</p>
            <p>{userData?.department}</p>
          </div>
        </div>
      </div>

      {/* Camera Modal */}
      {showCamera && (
        <div className="fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full p-6">
            <h3 className="text-lg font-semibold mb-4">
              Take a Selfie for Check In
            </h3>

            <div className="relative bg-black rounded-lg overflow-hidden mb-4">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full"
              />
              <canvas ref={canvasRef} className="hidden" />
            </div>

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
                    ? 'Mode operasional sementara — GPS + foto. Backend memverifikasi lokasi operasional saat submit.'
                    : `✓ Lokasi awal diterima. Backend akan memverifikasi batas ${
                      attendanceChallenge?.geofence?.radius || 'yang dikonfigurasi'
                    } meter saat submit.`}
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={capturePhoto}
                disabled={isProcessing}
                className="flex-1 bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              >
                {isProcessing ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-white mr-2"></div>
                    Processing...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    Capture Photo
                  </>
                )}
              </button>
              <button
                onClick={() => stopCamera()}
                disabled={isProcessing}
                className="px-6 py-3 bg-gray-500 text-white rounded-lg font-semibold hover:bg-gray-600 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CheckIn;
