import { useEffect, useState } from 'react';

/** Banner singkat setelah clear cache berhasil + reload */
export default function CacheClearedToast() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem('iswmp_cache_cleared') === '1') {
        sessionStorage.removeItem('iswmp_cache_cleared');
        setVisible(true);
        const t = setTimeout(() => setVisible(false), 4000);
        return () => clearTimeout(t);
      }
    } catch {
      // ignore
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed top-4 left-4 right-4 z-[100] flex justify-center pointer-events-none">
      <div className="pointer-events-auto max-w-md w-full rounded-lg bg-green-600 text-white px-4 py-3 shadow-lg text-sm text-center">
        Aplikasi berhasil diperbarui. Cache lama sudah dibersihkan.
      </div>
    </div>
  );
}
