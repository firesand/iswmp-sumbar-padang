import { useEffect } from 'react';

export function isIOSDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isIOSStandalone() {
  return (
    typeof window !== 'undefined' &&
    (window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

/**
 * Popup panduan mengaktifkan izin Lokasi & Kamera — fokus iOS/iPhone.
 */
export default function DevicePermissionGuide({
  open,
  onClose,
  onRetry,
  focus = 'both', // 'location' | 'camera' | 'both'
  title,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const ios = isIOSDevice();
  const pwa = isIOSStandalone();
  const showLocation = focus === 'location' || focus === 'both';
  const showCamera = focus === 'camera' || focus === 'both';

  const heading =
    title ||
    (focus === 'camera'
      ? 'Izinkan Akses Kamera'
      : focus === 'location'
        ? 'Izinkan Akses Lokasi'
        : 'Izinkan Lokasi & Kamera');

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="permission-guide-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-start justify-between gap-3 rounded-t-2xl">
          <div>
            <h2 id="permission-guide-title" className="text-lg font-bold text-gray-900">
              {heading}
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              {ios
                ? 'Di iPhone, setelah izin ditolak sekali, Safari tidak menampilkan dialog lagi. Aktifkan lewat Pengaturan.'
                : 'Izin sebelumnya ditolak. Aktifkan lewat pengaturan browser/perangkat, lalu coba lagi.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1"
            aria-label="Tutup"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {ios && (
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-sm text-blue-900">
              <p className="font-semibold">Langkah umum</p>
              <ol className="mt-2 list-decimal list-inside space-y-1 text-blue-800">
                <li>Keluar dari aplikasi sebentar, buka app <strong>Settings</strong> (Pengaturan).</li>
                <li>Ikuti langkah di bawah sesuai jenis izin.</li>
                <li>Kembali ke absensi, tekan <strong>Coba Lagi</strong>.</li>
              </ol>
            </div>
          )}

          {showLocation && (
            <section>
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-green-100 text-green-700 text-sm">1</span>
                Lokasi (GPS)
              </h3>
              {ios ? (
                <ol className="mt-2 ml-9 list-decimal space-y-1.5 text-sm text-gray-700">
                  <li>
                    Settings → <strong>Privacy &amp; Security</strong> → <strong>Location Services</strong> → pastikan <strong>On</strong>.
                  </li>
                  <li>
                    Scroll ke bawah, pilih{' '}
                    <strong>{pwa ? 'Safari Websites (atau nama app ini)' : 'Safari Websites'}</strong>.
                  </li>
                  <li>
                    Ubah menjadi <strong>Ask</strong> atau <strong>While Using the App</strong> / Allow.
                  </li>
                  <li>
                    Alternatif Safari: Settings → <strong>Safari</strong> → Location → <strong>Allow</strong> / Ask.
                  </li>
                  <li>Pastikan Mode Fokus / Low Power tidak memblokir lokasi.</li>
                </ol>
              ) : (
                <ol className="mt-2 ml-9 list-decimal space-y-1.5 text-sm text-gray-700">
                  <li>Buka pengaturan situs di browser (ikon gembok / ⋮ di address bar).</li>
                  <li>Izin <strong>Lokasi</strong> → <strong>Izinkan</strong>.</li>
                  <li>Atau Settings HP → Apps → Browser → Permissions → Location → Allow.</li>
                </ol>
              )}
            </section>
          )}

          {showCamera && (
            <section>
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-green-100 text-green-700 text-sm">
                  {showLocation ? '2' : '1'}
                </span>
                Kamera
              </h3>
              {ios ? (
                <ol className="mt-2 ml-9 list-decimal space-y-1.5 text-sm text-gray-700">
                  <li>
                    Settings → <strong>Safari</strong> → <strong>Camera</strong> → <strong>Allow</strong> / Ask.
                  </li>
                  <li>
                    Atau Settings → <strong>Privacy &amp; Security</strong> → <strong>Camera</strong> → aktifkan untuk Safari.
                  </li>
                  <li>
                    Jika memakai Chrome/Firefox di iPhone: Settings → app browser tersebut → Camera → Allow.
                  </li>
                </ol>
              ) : (
                <ol className="mt-2 ml-9 list-decimal space-y-1.5 text-sm text-gray-700">
                  <li>Ikon gembok / Site settings → Camera → Allow.</li>
                  <li>Atau Settings HP → Apps → Browser → Permissions → Camera → Allow.</li>
                </ol>
              )}
            </section>
          )}

          <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-sm text-amber-900">
            <strong>Tips:</strong> Setelah mengubah Settings, tutup tab absensi sepenuhnya lalu buka lagi
            {ios ? ' (atau swipe tutup Safari lalu buka URL absensi).' : '.'}
          </div>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-5 py-4 flex flex-col sm:flex-row gap-2 rounded-b-2xl">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 px-4 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50"
          >
            Tutup
          </button>
          <button
            type="button"
            onClick={() => {
              onRetry?.();
            }}
            className="flex-1 py-3 px-4 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700"
          >
            Coba Lagi
          </button>
        </div>
      </div>
    </div>
  );
}

export function isPermissionDeniedMessage(message = '', code = '') {
  const m = String(message).toLowerCase();
  return (
    code === 'GPS_DENIED' ||
    m.includes('izin lokasi ditolak') ||
    m.includes('permission denied') ||
    m.includes('akses kamera ditolak') ||
    m.includes('notallowed') ||
    m.includes('denied')
  );
}
