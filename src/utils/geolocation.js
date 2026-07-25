// Geolocation utilities — ISWMP SumBar-Padang
// GPS wajib untuk absensi; tidak ada fallback ke koordinat kantor.

const ACCURACY_THRESHOLD_METERS = 1000;
// Harus sama atau lebih ketat dari backend attendance-core.
export const MAX_GPS_ACCURACY_FOR_CHECKIN = 100;

const BLOCKED_LOCATION_SOURCES = new Set(['fallback', 'denied', 'office', 'manual']);

export class GeolocationRequiredError extends Error {
  constructor(message, code = 'GPS_REQUIRED') {
    super(message);
    this.name = 'GeolocationRequiredError';
    this.code = code;
  }
}

/** Validasi struktur koordinat GPS (client + sebelum write Firestore). */
export function isValidGpsCoords(location) {
  if (!location || typeof location !== 'object') return false;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  // Tolak (0,0) — sering dipakai spoof/default
  if (lat === 0 && lng === 0) return false;
  if (location.source && BLOCKED_LOCATION_SOURCES.has(location.source)) return false;
  if (
    location.accuracy != null &&
    Number.isFinite(Number(location.accuracy)) &&
    Number(location.accuracy) > MAX_GPS_ACCURACY_FOR_CHECKIN
  ) {
    return false;
  }
  return true;
}

export function assertValidGpsForAttendance(location) {
  if (!isValidGpsCoords(location)) {
    throw new GeolocationRequiredError(
      'Lokasi GPS tidak valid. Aktifkan GPS dan izinkan akses lokasi untuk absensi.',
      'GPS_INVALID'
    );
  }
  return location;
}

// Get current GPS location — rejects if unavailable (no office fallback)
export const getCurrentLocation = () => {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new GeolocationRequiredError(
        'Perangkat tidak mendukung GPS. Absensi memerlukan lokasi aktual.',
        'GPS_UNSUPPORTED'
      ));
      return;
    }

    const getPosition = (options) =>
      new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, options)
      );

    // maximumAge: 0 — selalu minta posisi baru, tolak cache lama
    const highAccOptions = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
    const lowAccOptions = { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 };

    const toResult = (pos, source) => ({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      source,
      capturedAt: Date.now(),
    });

    const fail = (err) => {
      const code = err?.code;
      if (code === 1) {
        reject(new GeolocationRequiredError(
          'Izin lokasi ditolak. Aktifkan GPS dan izinkan akses lokasi untuk absensi.',
          'GPS_DENIED'
        ));
      } else if (code === 2) {
        reject(new GeolocationRequiredError(
          'GPS tidak tersedia. Pastikan layanan lokasi perangkat Anda aktif.',
          'GPS_UNAVAILABLE'
        ));
      } else if (code === 3) {
        reject(new GeolocationRequiredError(
          'Waktu habis mendapatkan lokasi. Coba di area terbuka lalu ulangi.',
          'GPS_TIMEOUT'
        ));
      } else {
        reject(new GeolocationRequiredError(
          err?.message || 'Gagal mendapatkan lokasi GPS.',
          'GPS_ERROR'
        ));
      }
    };

    getPosition(highAccOptions)
      .then(async (first) => {
        const highResult = toResult(first, 'gps-high');

        if (
          Number.isFinite(highResult.accuracy) &&
          highResult.accuracy <= MAX_GPS_ACCURACY_FOR_CHECKIN
        ) {
          if (!isValidGpsCoords(highResult)) {
            fail({ code: 2, message: 'Koordinat GPS tidak valid' });
            return;
          }
          resolve(highResult);
          return;
        }

        try {
          const low = await getPosition(lowAccOptions);
          const lowResult = toResult(low, 'gps-low');
          const better =
            Number.isFinite(highResult.accuracy) &&
            Number.isFinite(lowResult.accuracy) &&
            lowResult.accuracy < highResult.accuracy
              ? lowResult
              : highResult;
          if (!isValidGpsCoords(better)) {
            fail({ code: 2, message: 'Koordinat GPS tidak valid' });
            return;
          }
          resolve(better);
        } catch {
          if (!isValidGpsCoords(highResult)) {
            fail({ code: 2, message: 'Koordinat GPS tidak valid' });
            return;
          }
          resolve(highResult);
        }
      })
      .catch(async (highErr) => {
        try {
          const low = await getPosition(lowAccOptions);
          const lowResult = toResult(low, 'gps-low');
          if (!isValidGpsCoords(lowResult)) {
            fail({ code: 2, message: 'Koordinat GPS tidak valid' });
            return;
          }
          resolve(lowResult);
        } catch (lowErr) {
          fail(lowErr?.code ? lowErr : highErr);
        }
      });
  });
};

export const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

const isGeofenceCalibrated = (geofence) =>
  geofence?.isActive === true &&
  geofence.lat != null &&
  geofence.lng != null &&
  Number.isFinite(Number(geofence.lat)) &&
  Number.isFinite(Number(geofence.lng)) &&
  Number(geofence.lat) >= -90 &&
  Number(geofence.lat) <= 90 &&
  Number(geofence.lng) >= -180 &&
  Number(geofence.lng) <= 180 &&
  Number.isFinite(Number(geofence.radius)) &&
  Number(geofence.radius) > 0;

// Validate user position against assigned geofence
export const validateLocationAgainstGeofence = async (geofence) => {
  // Fail closed: lokasi penugasan yang belum ada, belum aktif, atau belum
  // memiliki koordinat valid tidak boleh berubah menjadi izin absensi.
  if (!isGeofenceCalibrated(geofence)) {
    const geofenceName = geofence?.nama || geofence?.name || 'lokasi penugasan';
    return {
      isValid: false,
      transitionMode: false,
      message: geofence
        ? `Geofence ${geofenceName} belum aktif atau belum dikalibrasi. Hubungi admin sebelum melakukan absensi.`
        : 'Lokasi penugasan belum ditetapkan. Hubungi admin sebelum melakukan absensi.',
      distance: null,
      location: null,
      geofence: geofence || null,
      maxRadius: geofence?.radius ?? null,
      source: null,
      accuracy: null,
      code: geofence ? 'GEOFENCE_INACTIVE' : 'GEOFENCE_UNASSIGNED',
    };
  }

  let currentLocation;

  try {
    currentLocation = await getCurrentLocation();

    if (
      Number.isFinite(currentLocation?.accuracy) &&
      currentLocation.accuracy > ACCURACY_THRESHOLD_METERS
    ) {
      const retry = await getCurrentLocation();
      if (
        Number.isFinite(retry?.accuracy) &&
        retry.accuracy < currentLocation.accuracy
      ) {
        currentLocation = retry;
      }
    }
  } catch (error) {
    return {
      isValid: false,
      transitionMode: false,
      message: error.message || 'GPS wajib diaktifkan untuk absensi.',
      error: error.message,
      code: error.code || 'GPS_REQUIRED',
      source: 'denied',
    };
  }

  if (!isValidGpsCoords(currentLocation) || currentLocation.source === 'fallback') {
    return {
      isValid: false,
      transitionMode: false,
      message: 'Lokasi GPS tidak valid. Aktifkan GPS dan izinkan akses lokasi.',
      source: currentLocation?.source || 'fallback',
      code: 'GPS_INVALID',
    };
  }

  if (
    Number.isFinite(currentLocation.accuracy) &&
    currentLocation.accuracy > MAX_GPS_ACCURACY_FOR_CHECKIN
  ) {
    return {
      isValid: false,
      transitionMode: false,
      message: `Akurasi GPS terlalu rendah (${Math.round(currentLocation.accuracy)}m). Pindah ke area terbuka dan coba lagi.`,
      location: currentLocation,
      source: currentLocation.source,
      accuracy: currentLocation.accuracy,
      code: 'GPS_ACCURACY',
    };
  }

  const maxRadius = geofence.radius ?? 300;
  const geofenceName = geofence.nama || geofence.name || 'lokasi penugasan';

  const targetLat = Number(geofence.lat);
  const targetLng = Number(geofence.lng);

  const distance = calculateDistance(
    currentLocation.lat,
    currentLocation.lng,
    targetLat,
    targetLng
  );

  const uncertaintyAdjustedDistance =
    distance + Number(currentLocation.accuracy);
  const isWithinRadius = uncertaintyAdjustedDistance <= maxRadius;
  const isValid = isWithinRadius;

  return {
    isValid,
    transitionMode: false,
    message: isValid
      ? `Berada dalam radius ${geofenceName} (${Math.round(distance)}m + akurasi ${Math.round(currentLocation.accuracy)}m / max ${maxRadius}m)`
      : `Jarak ${Math.round(distance)}m + margin akurasi ${Math.round(currentLocation.accuracy)}m melewati batas ${maxRadius}m dari ${geofenceName}.`,
    distance: Math.round(distance),
    location: currentLocation,
    geofence,
    maxRadius,
    source: currentLocation.source,
    accuracy: currentLocation.accuracy,
  };
};

/**
 * Validate GPS against one or more operator-declared operational locations
 * used by location_photo mode (assignment + temporary venues).
 */
export const validateLocationAgainstAllowedLocations = async (
  allowedLocations,
) => {
  const candidates = Array.isArray(allowedLocations)
    ? allowedLocations.filter((entry) =>
      entry &&
      typeof entry === 'object' &&
      Number.isFinite(Number(entry.lat)) &&
      Number.isFinite(Number(entry.lng)) &&
      Number.isFinite(Number(entry.radius)) &&
      Number(entry.radius) > 0
    )
    : [];

  if (candidates.length === 0) {
    return {
      isValid: false,
      transitionMode: true,
      message:
        'Tidak ada lokasi operasional yang diizinkan untuk absensi saat ini.',
      distance: null,
      location: null,
      matchedLocation: null,
      code: 'OPERATIONAL_LOCATION_UNAVAILABLE',
    };
  }

  let currentLocation;
  try {
    currentLocation = await getCurrentLocation();
    if (
      Number.isFinite(currentLocation?.accuracy) &&
      currentLocation.accuracy > ACCURACY_THRESHOLD_METERS
    ) {
      const retry = await getCurrentLocation();
      if (
        Number.isFinite(retry?.accuracy) &&
        retry.accuracy < currentLocation.accuracy
      ) {
        currentLocation = retry;
      }
    }
  } catch (error) {
    return {
      isValid: false,
      transitionMode: true,
      message: error.message || 'GPS wajib diaktifkan untuk absensi.',
      error: error.message,
      code: error.code || 'GPS_REQUIRED',
      source: 'denied',
    };
  }

  if (!isValidGpsCoords(currentLocation) || currentLocation.source === 'fallback') {
    return {
      isValid: false,
      transitionMode: true,
      message: 'Lokasi GPS tidak valid. Aktifkan GPS dan izinkan akses lokasi.',
      source: currentLocation?.source || 'fallback',
      code: 'GPS_INVALID',
    };
  }

  if (
    Number.isFinite(currentLocation.accuracy) &&
    currentLocation.accuracy > MAX_GPS_ACCURACY_FOR_CHECKIN
  ) {
    return {
      isValid: false,
      transitionMode: true,
      message: `Akurasi GPS terlalu rendah (${Math.round(currentLocation.accuracy)}m). Pindah ke area terbuka dan coba lagi.`,
      location: currentLocation,
      source: currentLocation.source,
      accuracy: currentLocation.accuracy,
      code: 'GPS_ACCURACY',
    };
  }

  let bestMatch = null;
  let nearestOutside = null;
  for (const candidate of candidates) {
    const distance = calculateDistance(
      currentLocation.lat,
      currentLocation.lng,
      Number(candidate.lat),
      Number(candidate.lng)
    );
    const uncertaintyAdjustedDistance =
      distance + Number(currentLocation.accuracy);
    const radius = Number(candidate.radius);
    const name = candidate.name || candidate.nama || candidate.id || 'lokasi';
    if (uncertaintyAdjustedDistance <= radius) {
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = {
          distance: Math.round(distance),
          maxRadius: radius,
          matchedLocation: candidate,
          name,
        };
      }
    } else if (!nearestOutside || distance < nearestOutside.distance) {
      nearestOutside = {
        distance: Math.round(distance),
        maxRadius: radius,
        name,
      };
    }
  }

  if (bestMatch) {
    return {
      isValid: true,
      transitionMode: true,
      message:
        `Berada dalam radius ${bestMatch.name} ` +
        `(${bestMatch.distance}m + akurasi ${Math.round(currentLocation.accuracy)}m ` +
        `/ max ${bestMatch.maxRadius}m). Mode operasional sementara — GPS + foto.`,
      distance: bestMatch.distance,
      location: currentLocation,
      matchedLocation: bestMatch.matchedLocation,
      maxRadius: bestMatch.maxRadius,
      source: currentLocation.source,
      accuracy: currentLocation.accuracy,
    };
  }

  return {
    isValid: false,
    transitionMode: true,
    message: nearestOutside
      ? `Jarak ${nearestOutside.distance}m + margin akurasi ` +
        `${Math.round(currentLocation.accuracy)}m melewati batas ` +
        `${nearestOutside.maxRadius}m dari ${nearestOutside.name}.`
      : 'Posisi GPS berada di luar seluruh lokasi operasional yang diizinkan.',
    distance: nearestOutside?.distance ?? null,
    location: currentLocation,
    matchedLocation: null,
    maxRadius: nearestOutside?.maxRadius ?? null,
    source: currentLocation.source,
    accuracy: currentLocation.accuracy,
    code: 'OUTSIDE_OPERATIONAL_LOCATION',
  };
};

// Legacy wrapper
export const validateLocation = async (geofence = null) => {
  if (geofence) {
    return validateLocationAgainstGeofence(geofence);
  }

  const officeLat = parseFloat(import.meta.env.VITE_OFFICE_LAT);
  const officeLng = parseFloat(import.meta.env.VITE_OFFICE_LNG);
  const officeRadius = parseInt(import.meta.env.VITE_OFFICE_RADIUS) || 300;

  return validateLocationAgainstGeofence({
    lat: Number.isNaN(officeLat) ? null : officeLat,
    lng: Number.isNaN(officeLng) ? null : officeLng,
    radius: officeRadius,
    isActive: !Number.isNaN(officeLat) && !Number.isNaN(officeLng),
    nama: 'Kantor',
  });
};

export const getOfficeLocation = () => ({
  lat: parseFloat(import.meta.env.VITE_OFFICE_LAT) || null,
  lng: parseFloat(import.meta.env.VITE_OFFICE_LNG) || null,
  maxRadius: parseInt(import.meta.env.VITE_OFFICE_RADIUS) || 300,
});
