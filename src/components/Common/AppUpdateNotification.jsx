import { useState, useEffect, useRef } from 'react';
import { doc, onSnapshot, setDoc, getDoc } from 'firebase/firestore';
import { db } from '../../config/firebase';
import toast, { Toaster } from 'react-hot-toast';
import {
  FORCE_RELOAD_TTL_MS,
  shouldForceReload,
} from '../../utils/forcedUpdateBroadcast';

// App version - update this when deploying new version.
// Must match what the admin publishes to appConfig/version.latest, otherwise
// every client keeps prompting for an update it already has.
const APP_VERSION = '1.0.6';

function AppUpdateNotification({ userId, userRole }) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isChecking, setIsChecking] = useState(false);
  const [userPreferences, setUserPreferences] = useState({
    autoUpdate: true,
    showNotifications: true,
    updateCheckInterval: 5
  });
  
  const checkIntervalRef = useRef(null);
  const serviceWorkerRef = useRef(null);

  // Load user preferences from localStorage
  useEffect(() => {
    const savedPrefs = localStorage.getItem('updatePrefs');
    if (savedPrefs) {
      setUserPreferences(JSON.parse(savedPrefs));
    }
  }, []);

  // Save preferences to localStorage
  const savePreferences = (newPrefs) => {
    setUserPreferences(newPrefs);
    localStorage.setItem('updatePrefs', JSON.stringify(newPrefs));
  };

  // Register service worker
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        .then(async (registration) => {
          console.log('Service Worker registered:', registration);
          serviceWorkerRef.current = registration;

          // Do not wait for the browser's periodic service-worker check. This
          // deployment repairs registration, so stale clients need the newest
          // worker as soon as the app is opened.
          await registration.update();
          
          // Listen for service worker updates
          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New version available
                showUpdateNotification({
                  type: 'service-worker',
                  message: 'New version available! Click to update.',
                  forced: false
                });
              }
            });
          });
        })
        .catch((error) => {
          console.error('Service Worker registration failed:', error);
        });
    }
  }, []);

  // Listen for Firestore notifications
  useEffect(() => {
    if (!userId) return;

    // Listen for global notifications
    const unsubscribeGlobal = onSnapshot(
      doc(db, 'notifications', 'global'),
      (doc) => {
        if (doc.exists()) {
          const data = doc.data();
          if (data.active && data.type === 'update') {
            handleUpdateNotification(data);
          }
        }
      },
      (error) => {
        console.error('Global notification listener error:', error);
      }
    );

    // Listen for user-specific notifications
    const unsubscribeUser = onSnapshot(
      doc(db, 'userNotifications', userId),
      (doc) => {
        if (doc.exists()) {
          const data = doc.data();
          if (data.notifications && data.notifications.length > 0) {
            const latestNotification = data.notifications[data.notifications.length - 1];
            if (latestNotification.type === 'update') {
              handleUpdateNotification(latestNotification);
            }
          }
        }
      },
      (error) => {
        console.error('User notification listener error:', error);
      }
    );

    return () => {
      unsubscribeGlobal();
      unsubscribeUser();
    };
  }, [userId]);

  // Periodic version check
  useEffect(() => {
    if (!userPreferences.showNotifications) return;

    const checkForUpdates = async () => {
      setIsChecking(true);
      try {
        const versionDoc = await getDoc(doc(db, 'appConfig', 'version'));
        if (versionDoc.exists()) {
          const versionData = versionDoc.data();
          if (versionData.latest !== APP_VERSION) {
            setUpdateAvailable(true);
            setUpdateInfo(versionData);
            
            // Show notification if not already shown
            if (!updateAvailable) {
              showUpdateNotification({
                type: 'version-check',
                message: `Version ${versionData.latest} available!`,
                forced: versionData.forcedUpdate || false,
                features: versionData.features || [],
                updateMessage: versionData.updateMessage || ''
              });
            }
          }
        }
      } catch (error) {
        console.error('Version check failed:', error);
      } finally {
        setIsChecking(false);
      }
    };

    // Initial check
    checkForUpdates();

    // Set up periodic checks
    const interval = userPreferences.updateCheckInterval * 60 * 1000; // Convert to milliseconds
    checkIntervalRef.current = setInterval(checkForUpdates, interval);

    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
      }
    };
  }, [userPreferences.showNotifications, userPreferences.updateCheckInterval, updateAvailable]);

  // Handle update notifications
  const handleUpdateNotification = (notification) => {
    if (shouldForceReload(notification, { appVersion: APP_VERSION })) {
      window.location.reload();
      return;
    }

    setUpdateAvailable(true);
    setUpdateInfo(notification);

    // Show toast notification. Never render it as forced: the forced path
    // either reloaded above or was rejected as stale, same-version, or already
    // acted on, and a toast with no dismiss button is its own dead end.
    showUpdateNotification({
      type: 'firestore',
      message: notification.message || 'Update available!',
      forced: false,
      features: notification.features || [],
      updateMessage: notification.updateMessage || ''
    });
  };

  // Show update notification
  const showUpdateNotification = (updateData) => {
    if (!userPreferences.showNotifications) return;

    const updateToast = toast.custom(
      (t) => (
        <div className={`p-4 rounded-lg shadow-lg max-w-sm w-full ${
          updateData.forced 
            ? 'bg-red-500 text-white' 
            : 'bg-gradient-to-r from-blue-500 to-blue-600 text-white'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-xl">🔄</span>
              <div>
                <p className="font-semibold">App Update</p>
                <p className="text-sm opacity-90">{updateData.message}</p>
                {updateData.features && updateData.features.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-medium">New Features:</p>
                    <ul className="text-xs opacity-75">
                      {updateData.features.slice(0, 2).map((feature, index) => (
                        <li key={index}>• {feature}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={() => {
                toast.dismiss(t.id);
                handleUpdate();
              }}
              className="ml-2 px-3 py-1 bg-white bg-opacity-20 rounded text-sm font-medium hover:bg-opacity-30 transition-colors"
            >
              {updateData.forced ? 'Update Now' : 'Update'}
            </button>
          </div>
          {!updateData.forced && (
            <button
              onClick={() => toast.dismiss(t.id)}
              className="mt-2 text-xs opacity-75 hover:opacity-100"
            >
              Later
            </button>
          )}
        </div>
      ),
      {
        duration: updateData.forced ? Infinity : 10000,
        position: 'top-right'
      }
    );

    // Auto-dismiss after 10 seconds if not forced
    if (!updateData.forced) {
      setTimeout(() => {
        toast.dismiss(updateToast);
      }, 10000);
    }
  };

  // Handle update action
  const handleUpdate = async () => {
    try {
      // Log update action
      if (userId) {
        await setDoc(doc(db, 'updateLogs', `${userId}_${Date.now()}`), {
          userId: userId,
          fromVersion: APP_VERSION,
          toVersion: updateInfo?.latest || 'unknown',
          timestamp: new Date(),
          method: 'manual',
          userRole: userRole
        });
      }

      // Remove every old application cache before loading the new bundle.
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
      }

      if ('serviceWorker' in navigator) {
        const registration = serviceWorkerRef.current
          || await navigator.serviceWorker.getRegistration();
        if (registration) {
          await registration.update();
          if (registration.waiting) {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        }
      }

      // A versioned URL also bypasses any stale browser HTTP cache entry.
      const refreshUrl = new URL(window.location.href);
      refreshUrl.searchParams.set('appVersion', updateInfo?.latest || APP_VERSION);
      window.location.replace(refreshUrl.toString());
    } catch (error) {
      console.error('Update failed:', error);
      toast.error('Update failed. Please refresh manually.');
    }
  };

  // Force update (admin only)
  const forceUpdate = async () => {
    if (userRole !== 'admin') return;

    const confirmed = window.confirm(
      'Kirim perintah MUAT ULANG PAKSA ke semua pengguna?\n\n' +
        'Ini bukan tombol untuk menerbitkan versi baru.\n' +
        'Gunakan hanya jika pengguna benar-benar tertahan di versi lama.\n\n' +
        'Perintah berhenti sendiri dalam 15 menit.'
    );
    if (!confirmed) return;

    try {
      // Broadcast the version the admin actually wants everyone on, not this
      // browser's build. Clients already running it must ignore the command.
      const versionDoc = await getDoc(doc(db, 'appConfig', 'version'));
      const target = versionDoc.exists() ? versionDoc.data().latest : null;
      if (typeof target !== 'string' || !target) {
        toast.error('appConfig/version belum berisi "latest". Terbitkan versi dulu.');
        return;
      }

      const nowMs = Date.now();
      await setDoc(doc(db, 'notifications', 'global'), {
        active: true,
        type: 'update',
        title: 'Force Update',
        message: `Admin meminta semua pengguna memuat versi ${target}`,
        timestamp: new Date(nowMs),
        // Without an expiry this document reloads clients until someone edits
        // Firestore by hand. It must switch itself off.
        expiresAt: new Date(nowMs + FORCE_RELOAD_TTL_MS),
        version: target,
        forced: true,
        action: 'reload'
      });

      toast.success(`Perintah muat ulang ke versi ${target} dikirim (15 menit)`);
    } catch (error) {
      console.error('Force update failed:', error);
      toast.error('Failed to send force update');
    }
  };

  // Check for updates manually
  const checkUpdates = async () => {
    setIsChecking(true);
    try {
      const versionDoc = await getDoc(doc(db, 'appConfig', 'version'));
      if (versionDoc.exists()) {
        const versionData = versionDoc.data();
        if (versionData.latest !== APP_VERSION) {
          setUpdateAvailable(true);
          setUpdateInfo(versionData);
          showUpdateNotification({
            type: 'manual-check',
            message: `Version ${versionData.latest} available!`,
            forced: false,
            features: versionData.features || [],
            updateMessage: versionData.updateMessage || ''
          });
        } else {
          toast.success('App is up to date!');
        }
      }
    } catch (error) {
      console.error('Manual update check failed:', error);
      toast.error('Failed to check for updates');
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <>
      <Toaster />
      
      {/* Update Banner (if forced update) */}
      {updateInfo?.forcedUpdate && (
        <div className="fixed top-0 left-0 right-0 bg-red-600 text-white p-3 z-50">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span>⚠️</span>
              <span className="font-medium">Update Required</span>
              <span className="text-sm opacity-90">
                Version {updateInfo.latest} is required to continue
              </span>
            </div>
            <button
              onClick={handleUpdate}
              className="px-4 py-1 bg-white text-red-600 rounded font-medium hover:bg-gray-100 transition-colors"
            >
              Update Now
            </button>
          </div>
        </div>
      )}

      {/* Debug Panel (admin only) */}
      {userRole === 'admin' && (
        <div className="fixed bottom-4 right-4 bg-gray-800 text-white p-3 rounded-lg text-xs z-40">
          <div className="space-y-1">
            <div>Version: {APP_VERSION}</div>
            <div>Update: {updateAvailable ? 'Available' : 'None'}</div>
            <div>Checking: {isChecking ? 'Yes' : 'No'}</div>
            <div className="flex space-x-2 mt-2">
              <button
                onClick={checkUpdates}
                disabled={isChecking}
                className="px-2 py-1 bg-blue-600 rounded text-xs hover:bg-blue-700 disabled:opacity-50"
              >
                Check
              </button>
              <button
                onClick={forceUpdate}
                className="px-2 py-1 bg-red-600 rounded text-xs hover:bg-red-700"
              >
                Force
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default AppUpdateNotification;
