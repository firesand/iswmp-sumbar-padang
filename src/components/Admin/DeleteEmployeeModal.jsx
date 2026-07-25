import { useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../config/firebase';
import { archiveEmployee } from '../../services/employeeArchiveService';

const EVIDENCE_COLLECTIONS = [
  ['attendances', 'Absensi'],
  ['leaveRequests', 'Cuti'],
  ['locationUpdates', 'Pembaruan lokasi'],
  ['payrollRequests', 'Payroll'],
];

function DeleteEmployeeModal({ employee, isOpen, onClose, onDeleteSuccess }) {
  const [reason, setReason] = useState('');
  const [summary, setSummary] = useState([]);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen || !employee) return undefined;
    let disposed = false;
    setReason('');
    setError('');
    setLoadingSummary(true);

    Promise.all(
      EVIDENCE_COLLECTIONS.map(async ([collectionName, label]) => {
        const snapshot = await getDocs(
          query(collection(db, collectionName), where('userId', '==', employee.id))
        );
        return { collectionName, label, count: snapshot.size };
      })
    )
      .then((result) => {
        if (!disposed) setSummary(result);
      })
      .catch(() => {
        if (!disposed) {
          setSummary([]);
          setError('Ringkasan bukti tidak dapat dimuat; server tetap tidak akan menghapus bukti.');
        }
      })
      .finally(() => {
        if (!disposed) setLoadingSummary(false);
      });

    return () => {
      disposed = true;
    };
  }, [employee, isOpen]);

  if (!isOpen || !employee) return null;

  const submit = async (event) => {
    event.preventDefault();
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 10) {
      setError('Alasan pengarsipan minimal 10 karakter.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await archiveEmployee(employee.id, normalizedReason);
      onDeleteSuccess(employee.id);
      onClose();
    } catch (submitError) {
      setError(submitError.message || 'Pengarsipan karyawan gagal.');
    } finally {
      setSubmitting(false);
    }
  };

  const totalRecords = summary.reduce((total, item) => total + item.count, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl">
        <header className="flex items-start justify-between border-b border-gray-200 p-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Arsipkan Karyawan</h2>
            <p className="mt-1 text-sm text-gray-600">
              Nonaktifkan akses {employee.name} tanpa menghapus bukti historis.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Tutup"
            className="text-2xl leading-none text-gray-400 hover:text-gray-700 disabled:opacity-50"
          >
            ×
          </button>
        </header>

        <form onSubmit={submit} className="space-y-5 p-6">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            <p><strong>Nama:</strong> {employee.name}</p>
            <p><strong>Email:</strong> {employee.email}</p>
            <p><strong>Status:</strong> {employee.accountStatus}</p>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <h3 className="font-semibold text-amber-900">Bukti tetap dipertahankan</h3>
            {loadingSummary ? (
              <p className="mt-2 text-sm text-amber-800">Memuat ringkasan…</p>
            ) : (
              <>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {summary.map((item) => (
                    <div key={item.collectionName} className="rounded-md bg-white p-3 text-center">
                      <p className="text-xl font-bold text-slate-900">{item.count}</p>
                      <p className="text-xs text-slate-600">{item.label}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-sm text-amber-900">
                  {totalRecords} record dipertahankan untuk audit dan payroll.
                </p>
              </>
            )}
          </div>

          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            Akun Authentication akan dinonaktifkan, token sesi dicabut, profil menjadi
            archived, dan tindakan dicatat server. Penghapusan attendance langsung dari
            browser telah dinonaktifkan.
          </div>

          <label className="block text-sm font-medium text-gray-700">
            Alasan pengarsipan
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows="4"
              maxLength="500"
              disabled={submitting}
              placeholder="Minimal 10 karakter"
              className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-red-500 focus:ring-2 focus:ring-red-200"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-lg bg-red-100 p-3 text-sm text-red-800">
              {error}
            </p>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-gray-700 disabled:opacity-50"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting || reason.trim().length < 10}
              className="flex-1 rounded-lg bg-red-700 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Mengarsipkan…' : 'Arsipkan dan Nonaktifkan'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default DeleteEmployeeModal;
