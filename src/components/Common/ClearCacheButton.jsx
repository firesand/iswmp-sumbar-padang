import { useState } from 'react';
import { confirmAndRefreshAppCache } from '../../utils/refreshAppCache';

/**
 * Tombol troubleshoot awam: bersihkan cache + muat ulang aplikasi.
 */
export default function ClearCacheButton({
  variant = 'menu', // 'menu' | 'link' | 'button'
  className = '',
  label = 'Perbarui Aplikasi',
}) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await confirmAndRefreshAppCache();
    } finally {
      // If confirm cancelled, unlock; if reload happens this unmounts
      setBusy(false);
    }
  };

  if (variant === 'menu') {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={`block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 ${className}`}
      >
        {busy ? 'Membersihkan cache…' : label}
      </button>
    );
  }

  if (variant === 'link') {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={`text-sm text-green-700 underline disabled:opacity-50 ${className}`}
      >
        {busy ? 'Membersihkan cache…' : label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={`w-full py-2.5 px-4 rounded-lg border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 ${className}`}
    >
      {busy ? 'Membersihkan cache…' : label}
    </button>
  );
}
