import { useState } from 'react';
import { signOut } from 'firebase/auth';
import { auth } from '../../config/firebase';
import { changeTemporaryPassword } from '../../services/passwordSecurityService';

const STRONG_PASSWORD = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S{12,128}$/;

function friendlyError(error) {
  const code = String(error?.code || '').replace(/^functions\//, '');
  const messages = {
    unauthenticated: 'Sesi login berakhir. Silakan login kembali.',
    'permission-denied': 'Akun ini tidak diizinkan mengganti password.',
    'invalid-argument': 'Password belum memenuhi persyaratan keamanan.',
    'failed-precondition': 'Password sementara sudah tidak berlaku.',
    unavailable: 'Layanan sedang tidak tersedia. Coba kembali.',
    'auth/invalid-credential': 'Password sementara salah atau sudah tidak berlaku.',
    'auth/wrong-password': 'Password sementara salah atau sudah tidak berlaku.',
    'auth/too-many-requests': 'Terlalu banyak percobaan. Tunggu sebelum mencoba kembali.',
  };
  return messages[code] || error?.message || 'Password gagal diubah.';
}

function ForcePasswordChange() {
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!STRONG_PASSWORD.test(password)) {
      setError('Gunakan minimal 12 karakter berisi huruf besar, huruf kecil, angka, dan simbol tanpa spasi.');
      return;
    }
    if (!temporaryPassword) {
      setError('Masukkan kembali password sementara untuk memverifikasi identitas Anda.');
      return;
    }
    if (password !== confirmation) {
      setError('Konfirmasi password tidak sama.');
      return;
    }

    setSubmitting(true);
    try {
      await changeTemporaryPassword(temporaryPassword, password);
      setTemporaryPassword('');
      setPassword('');
      setConfirmation('');
      await signOut(auth);
      window.location.assign('/login');
    } catch (submitError) {
      setError(friendlyError(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-10">
      <section className="mx-auto max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <h1 className="text-2xl font-bold text-slate-900">Ganti password sementara</h1>
        <p className="mt-2 text-sm text-slate-600">
          Akses aplikasi dikunci sampai password sementara diganti melalui server.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Password sementara saat ini
            <input
              type="password"
              autoComplete="current-password"
              value={temporaryPassword}
              onChange={(event) => setTemporaryPassword(event.target.value)}
              disabled={submitting}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Password baru
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Ulangi password baru
            <input
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={submitting}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-green-700 px-4 py-3 font-semibold text-white disabled:opacity-50"
          >
            {submitting ? 'Mengubah password…' : 'Simpan password baru'}
          </button>
        </form>
      </section>
    </main>
  );
}

export default ForcePasswordChange;
