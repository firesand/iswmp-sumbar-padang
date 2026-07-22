import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { auth, db } from '../../config/firebase';
import { KELURAHAN_SEED } from '../../data/seedData';
import { FIELD_STAFF_TYPES, OFFICE_STAFF_ROLES } from '../../services/geofenceService';

const EMPTY_FORM = {
  name: '',
  phone: '',
  nik: '',
  address: '',
  staffCategory: '',
  kelurahanId: '',
  jenisTenagaAhli: '',
  peranKantor: '',
};

const formatAuthDate = (value) => {
  if (!value) return '-';
  const date = value.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

function IncompleteRegistrations({ onQueued }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, 'incompleteRegistrations'),
      (snapshot) => {
        const items = snapshot.docs
          .map(accountDoc => ({ id: accountDoc.id, ...accountDoc.data() }))
          .sort((a, b) => {
            const aTime = a.authCreatedAt?.toMillis?.() || 0;
            const bTime = b.authCreatedAt?.toMillis?.() || 0;
            return aTime - bTime;
          });
        setAccounts(items);
        setLoadError('');
        setLoading(false);
      },
      (error) => {
        console.error('Failed to load incomplete registrations:', error);
        setLoadError('Daftar pemulihan tidak dapat dimuat. Periksa koneksi lalu coba lagi.');
        setLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  const filteredAccounts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return accounts;
    return accounts.filter(account =>
      [account.displayName, account.email]
        .filter(Boolean)
        .some(value => value.toLowerCase().includes(keyword))
    );
  }, [accounts, search]);

  const openRecoveryForm = (account) => {
    setSelectedAccount(account);
    setFormData({
      ...EMPTY_FORM,
      name: account.displayName || '',
      phone: account.phoneNumber || '',
    });
    setFormError('');
  };

  const closeRecoveryForm = () => {
    if (processing) return;
    setSelectedAccount(null);
    setFormData(EMPTY_FORM);
    setFormError('');
  };

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData(previous => ({
      ...previous,
      [name]: value,
      ...(name === 'staffCategory' ? {
        kelurahanId: '',
        jenisTenagaAhli: '',
        peranKantor: '',
      } : {}),
    }));
  };

  const validateForm = () => {
    if (!formData.name.trim() || !formData.phone.trim() || !formData.nik.trim() || !formData.address.trim()) {
      return 'Nama, nomor telepon, NIK, dan alamat wajib diisi.';
    }
    if (!formData.staffCategory) {
      return 'Pilih kategori penugasan.';
    }
    if (formData.staffCategory === 'field_staff'
      && (!formData.kelurahanId || !formData.jenisTenagaAhli)) {
      return 'Pilih kelurahan penugasan dan jenis tenaga ahli.';
    }
    if (formData.staffCategory === 'office_staff' && !formData.peranKantor) {
      return 'Pilih peran kantor.';
    }
    return '';
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!selectedAccount || processing) return;

    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    const adminUser = auth.currentUser;
    if (!adminUser) {
      setFormError('Sesi admin berakhir. Silakan login kembali.');
      return;
    }

    const selectedKelurahan = KELURAHAN_SEED.find(
      kelurahan => kelurahan.id === formData.kelurahanId
    );
    const queuedAt = Timestamp.now();
    const userId = selectedAccount.userId || selectedAccount.id;
    const normalizedEmail = String(selectedAccount.email || '').trim().toLowerCase();

    if (!normalizedEmail) {
      setFormError('Email akun Authentication tidak tersedia. Akun ini perlu diperiksa manual.');
      return;
    }

    const userData = {
      uid: userId,
      name: formData.name.trim(),
      email: normalizedEmail,
      phone: formData.phone.trim(),
      phoneNumber: formData.phone.trim(),
      nik: formData.nik.trim(),
      address: formData.address.trim(),
      photoURL: selectedAccount.photoURL || '',
      role: formData.staffCategory,
      accountStatus: 'pending',
      isActive: false,
      provinsi: 'Sumatera Barat',
      kota: 'Padang',
      createdAt: serverTimestamp(),
      originalAuthCreatedAt: selectedAccount.authCreatedAt || null,
      location: {
        lat: null,
        lng: null,
        accuracy: null,
        source: 'admin-assisted-recovery',
      },
      recoveredBy: adminUser.uid,
      recoveredAt: serverTimestamp(),
      recoverySource: 'admin-assisted',
      ...(formData.staffCategory === 'field_staff' ? {
        assignmentType: 'kelurahan',
        kelurahanId: formData.kelurahanId,
        kelurahanNama: selectedKelurahan?.nama || '',
        jenisTenagaAhli: formData.jenisTenagaAhli,
      } : {
        assignmentType: 'kantor',
        kantorId: 'kantor-padang-kota',
        peranKantor: formData.peranKantor,
      }),
    };

    const registrationData = {
      userId,
      requestedBy: adminUser.uid,
      requestedAt: serverTimestamp(),
      status: 'pending',
      recoverySource: 'admin-assisted',
    };

    setProcessing(true);
    setFormError('');

    try {
      const incompleteRef = doc(db, 'incompleteRegistrations', userId);
      const userRef = doc(db, 'users', userId);
      const requestRef = doc(db, 'registrationRequests', userId);
      const auditRef = doc(
        db,
        'recoveryAuditLogs',
        `${userId}_${Date.now()}`
      );

      await runTransaction(db, async transaction => {
        const [incompleteSnapshot, userSnapshot] = await Promise.all([
          transaction.get(incompleteRef),
          transaction.get(userRef),
        ]);

        if (!incompleteSnapshot.exists()) {
          throw new Error('Akun tidak lagi berada dalam antrean pemulihan.');
        }
        if (userSnapshot.exists()) {
          throw new Error('Akun ini sudah mempunyai profil pengguna. Muat ulang dashboard.');
        }

        transaction.set(userRef, userData);
        transaction.set(requestRef, registrationData);
        transaction.set(auditRef, {
          action: 'queued_for_approval',
          targetUserId: userId,
          targetEmail: normalizedEmail,
          performedBy: adminUser.uid,
          performedAt: serverTimestamp(),
          source: 'admin-assisted-recovery',
        });
        transaction.delete(incompleteRef);
      });

      const localRegistration = {
        id: userId,
        ...registrationData,
        requestedAt: queuedAt,
        name: userData.name,
        email: userData.email,
        phone: userData.phone,
        phoneNumber: userData.phoneNumber,
        nik: userData.nik,
        role: userData.role,
      };

      onQueued?.(localRegistration, { id: userId, ...userData, createdAt: queuedAt });
      setSelectedAccount(null);
      setFormData(EMPTY_FORM);
      window.alert(`${userData.name} berhasil dimasukkan ke Pending Approvals.`);
    } catch (error) {
      console.error('Admin-assisted recovery failed:', error);
      setFormError(error.message || 'Pemulihan gagal. Silakan coba lagi.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div>
      <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 p-4">
        <h3 className="font-semibold text-blue-900">Pemulihan Registrasi Berbantuan Admin</h3>
        <p className="mt-1 text-sm text-blue-800">
          Lengkapi data berdasarkan konfirmasi peserta melalui WhatsApp. Akun akan masuk ke Pending
          Approvals dan tidak langsung diaktifkan.
        </p>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-800">Registrasi Belum Lengkap</h3>
          <p className="text-sm text-gray-500">{accounts.length} akun menunggu bantuan admin</p>
        </div>
        <input
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Cari nama atau email"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 sm:w-72"
        />
      </div>

      {loadError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {loading ? (
        <div className="py-10 text-center text-gray-500">Memuat antrean pemulihan...</div>
      ) : filteredAccounts.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {filteredAccounts.map(account => (
            <div key={account.id} className="rounded-lg border border-gray-200 p-4 hover:shadow-sm">
              <div className="flex items-start gap-3">
                {account.photoURL ? (
                  <img
                    src={account.photoURL}
                    alt=""
                    className="h-11 w-11 rounded-full border object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-200 font-semibold text-gray-600">
                    {(account.displayName || account.email || '?').charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-gray-900">
                    {account.displayName || 'Nama belum tersedia'}
                  </p>
                  <p className="truncate text-sm text-gray-600">{account.email || 'Email tidak tersedia'}</p>
                  <p className="mt-1 text-xs text-gray-400">
                    Dibuat: {formatAuthDate(account.authCreatedAt)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => openRecoveryForm(account)}
                className="mt-4 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Lengkapi Data
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center text-gray-500">
          {accounts.length === 0
            ? 'Semua akun sudah ditangani.'
            : 'Tidak ada akun yang cocok dengan pencarian.'}
        </div>
      )}

      {selectedAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white shadow-xl">
            <div className="sticky top-0 flex items-center justify-between border-b bg-white p-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Lengkapi Registrasi</h3>
                <p className="text-sm text-gray-500">{selectedAccount.email}</p>
              </div>
              <button
                type="button"
                onClick={closeRecoveryForm}
                disabled={processing}
                className="rounded p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                aria-label="Tutup"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 p-5">
              {formError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {formError}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700">Nama lengkap *</label>
                <input
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  required
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Nomor telepon *</label>
                  <input
                    name="phone"
                    type="tel"
                    value={formData.phone}
                    onChange={handleChange}
                    required
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">NIK *</label>
                  <input
                    name="nik"
                    inputMode="numeric"
                    value={formData.nik}
                    onChange={handleChange}
                    required
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Alamat *</label>
                <textarea
                  name="address"
                  value={formData.address}
                  onChange={handleChange}
                  required
                  rows="3"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Kategori penugasan *</label>
                <select
                  name="staffCategory"
                  value={formData.staffCategory}
                  onChange={handleChange}
                  required
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                >
                  <option value="">Pilih kategori</option>
                  <option value="field_staff">Tenaga Ahli Lapangan (Kelurahan)</option>
                  <option value="office_staff">Tim Kantor Kota Padang</option>
                </select>
              </div>

              {formData.staffCategory === 'field_staff' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Kelurahan *</label>
                    <select
                      name="kelurahanId"
                      value={formData.kelurahanId}
                      onChange={handleChange}
                      required
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                    >
                      <option value="">Pilih kelurahan</option>
                      {KELURAHAN_SEED.map(kelurahan => (
                        <option key={kelurahan.id} value={kelurahan.id}>
                          {kelurahan.nama} — {kelurahan.kecamatan}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Jenis tenaga ahli *</label>
                    <select
                      name="jenisTenagaAhli"
                      value={formData.jenisTenagaAhli}
                      onChange={handleChange}
                      required
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                    >
                      <option value="">Pilih jenis TA</option>
                      {FIELD_STAFF_TYPES.map(type => (
                        <option key={type.value} value={type.value}>{type.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {formData.staffCategory === 'office_staff' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">Peran kantor *</label>
                  <select
                    name="peranKantor"
                    value={formData.peranKantor}
                    onChange={handleChange}
                    required
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                  >
                    <option value="">Pilih peran</option>
                    {OFFICE_STAFF_ROLES.map(role => (
                      <option key={role.value} value={role.value}>{role.label}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-xs text-yellow-800">
                Pastikan data sudah dikonfirmasi peserta. Tombol berikut hanya memasukkan akun ke
                Pending Approvals; akun belum dapat melakukan absensi sebelum disetujui.
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeRecoveryForm}
                  disabled={processing}
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={processing}
                  className="flex-1 rounded-lg bg-green-600 px-4 py-2 font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {processing ? 'Menyimpan...' : 'Masukkan ke Pending'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default IncompleteRegistrations;
