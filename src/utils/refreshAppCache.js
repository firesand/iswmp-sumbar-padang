/**
 * Clear app cache / service worker and reload — for non-technical users.
 * Keeps Firebase Auth session by default (IndexedDB not wiped).
 */
export async function refreshAppCache({ keepLogin = true } = {}) {
  const steps = [];

  try {
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name)));
      steps.push(`cache:${cacheNames.length}`);
    }

    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((reg) => reg.unregister()));
      steps.push(`sw:${registrations.length}`);
    }

    if (!keepLogin) {
      try {
        localStorage.clear();
        sessionStorage.clear();
        steps.push('storage');
      } catch {
        // ignore
      }
    }

    // Mark so next load can show a brief success hint
    try {
      sessionStorage.setItem('iswmp_cache_cleared', '1');
    } catch {
      // ignore
    }

    const url = new URL(window.location.href);
    url.searchParams.set('_refresh', String(Date.now()));
    window.location.replace(url.toString());
    return { ok: true, steps };
  } catch (error) {
    console.error('refreshAppCache failed:', error);
    // Still try hard reload
    window.location.reload();
    return { ok: false, error };
  }
}

export function confirmAndRefreshAppCache() {
  const ok = window.confirm(
    'Perbarui aplikasi?\n\n' +
      'Ini membersihkan cache lama dan memuat versi terbaru.\n' +
      'Login Anda biasanya tetap tersimpan.\n\n' +
      'Tekan OK untuk melanjutkan.'
  );
  if (!ok) return Promise.resolve(false);
  return refreshAppCache({ keepLogin: true }).then(() => true);
}
