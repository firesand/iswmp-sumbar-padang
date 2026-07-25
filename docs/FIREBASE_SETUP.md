# Firebase Setup — ISWMP SumBar-Padang

**Project:** [iswmp-sumbar-padang](https://console.firebase.google.com/project/iswmp-sumbar-padang/overview)  
**Mode keamanan:** fail-closed; absensi ditolak sampai geofence diverifikasi
secara fisik dan diaktifkan melalui workflow audit.

---

## Checklist Console Firebase

Buka [Firebase Console → iswmp-sumbar-padang](https://console.firebase.google.com/project/iswmp-sumbar-padang/overview) dan pastikan semua langkah di bawah selesai.

### 1. Authentication

1. **Build** → **Authentication** → **Get started**
2. Tab **Sign-in method** → aktifkan **Email/Password**
3. Tab **Settings** → pastikan authorized domain hanya memuat domain yang
   benar-benar dipakai:
   - `localhost` (otomatis untuk dev)
   - domain Firebase Hosting production

### 2. Firestore Database

1. **Build** → **Firestore Database** → **Create database**
2. Pilih **Start in production mode** (rules akan kita deploy dari repo)
3. Pilih region: **`asia-southeast2` (Jakarta)** — terdekat dengan Padang
4. Klik **Create**

### 3. Storage

1. **Build** → **Storage** → **Get started**
2. Pilih **Start in production mode**
3. Gunakan region yang sama dengan Firestore (Jakarta jika tersedia)
4. Klik **Done**

> Storage dipakai untuk foto profil dan bukti selfie yang terikat challenge.

### 4. Web App — Ambil Config

1. **Project Overview** (ikon gear) → **Project settings**
2. Scroll ke **Your apps** → klik **</> Web**
3. App nickname: `ISWMP SumBar-Padang Web`
4. Firebase Hosting dikelola oleh `firebase.json`; pilihan saat registrasi Web
   App tidak menggantikan konfigurasi repo.
5. Klik **Register app**
6. Salin nilai `firebaseConfig`:

```javascript
const firebaseConfig = {
  apiKey: "NILAI_DARI_FIREBASE_CONSOLE",
  authDomain: "DOMAIN_AUTH_PROJECT",
  projectId: "ID_PROJECT",
  storageBucket: "BUCKET_PROJECT",
  messagingSenderId: "SENDER_ID",
  appId: "WEB_APP_ID",
  measurementId: "MEASUREMENT_ID_JIKA_DIPAKAI"
};

```

7. Buat file `.env.local` di root project:

```bash
cp .env.example .env.local
```

8. Isi `.env.local` dengan nilai dari Firebase Console:

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

> **Penting:** Jangan commit `.env.local` ke git.

### 5. App Check Web

1. Daftarkan provider reCAPTCHA Enterprise pada Web App yang sama.
2. Isi public site key di environment build production.
3. Deploy client dan pantau request valid/invalid terlebih dahulu.
4. Pertahankan Cloud Firestore dan Cloud Storage pada `UNENFORCED` sampai
   check-in **dan** check-out perangkat nyata berhasil serta metrik
   `VALID/ALLOW` muncul pada kedua service.

Callable absensi sudah memerlukan App Check di backend. App Check web bukan
attestation sensor GPS dan tidak membuat aplikasi kebal fake GPS.

---

## Deploy Rules & Seed Data

### Prasyarat

Firebase CLI sudah ada di project (tidak perlu install global):

```bash
# Login (buka browser otomatis)
npx firebase login

# Atau via npm script
npm run firebase:login
```

> Jika `firebase: command not found` — gunakan **`npx firebase`** atau **`npm run firebase -- <perintah>`**, bukan `firebase` langsung.

### Deploy Firestore & Storage Rules

```bash
cd ISWMP-SumBar-Padang
npm run firebase:deploy:rules
```

> Perintah deploy storage yang benar: `--only storage` (bukan `storage:rules`).

### Seed 11 Kelurahan + Kantor

Seed kelurahan sudah memuat alamat dan marker kantor kelurahan dari Google Maps dengan status `coordinateStatus: provisional`. Script memaksa seluruh geofence kelurahan tetap `isActive: false`; menjalankan seed **tidak** mengaktifkan validasi radius.

**Opsi A — Firebase CLI OAuth (disarankan)**

1. Login dengan `npm run firebase:login`.
2. Pastikan akun hanya memiliki izin minimum yang diperlukan pada project.
3. Tinjau dry-run; perintah ini tidak menulis data:

```bash
npm run seed
```

4. Reset seed hanya jika memang ingin menonaktifkan seluruh geofence dan
   mengembalikannya ke status provisional:

```bash
npm run seed -- --apply \
  --confirm-reset-geofences=RESET_GEOFENCES_TO_PROVISIONAL
```

Script tidak lagi membaca JSON service account jangka panjang.

**Opsi B — Manual di Console**

Buat koleksi `kelurahan` dan `kantor` secara manual, atau import dari data di `docs/KELURAHAN.md`.

---

## Buat Admin Pertama

Karena registrasi self-register menghasilkan akun `pending`, admin pertama dibuat manual:

### Langkah

1. Jalankan app: `npm run dev`
2. Buka `http://localhost:5173/register`
3. Daftar dengan identitas admin resmi; jangan menaruh alamat akun itu di
   dokumentasi atau issue tracker.
4. Di Firebase Console → **Firestore** → koleksi `users` → dokumen user tersebut:
   - Ubah `role` → `"admin"`
   - Ubah `accountStatus` → `"active"`
   - Ubah `isActive` → `true`
5. Login ulang → redirect ke `/admin`

> Setelah admin aktif, approve registrasi user lain dari tab **Pending Approvals**.
> Ini hanya bootstrap satu kali melalui Firebase Console. Rules aplikasi
> melarang admin browser membuat atau mempromosikan admin lain.

Aktivasi geofence memerlukan **dua admin aplikasi yang dikuasai dua petugas
berbeda**. Bootstrap admin kedua juga merupakan tindakan root melalui Console;
verifikasi identitas dan batasi siapa yang dapat melakukan langkah ini. Jangan
memberinya role IAM penulis Firestore hanya agar dual-control terlihat berjalan.

---

## Verifikasi Setup

| Cek | Cara |
|-----|------|
| Auth berfungsi | Register + login di `localhost:5173` |
| Firestore rules | Register tidak error saat buat dokumen `users` |
| Storage | Upload foto profil saat register |
| Seed kelurahan | Firestore → `kelurahan` → 11 dokumen |
| Seed kantor | Firestore → `kantor` → 1 dokumen `kantor-padang-kota` |
| Geofence mode | Check-in ditolak sampai titik berstatus verified dan aktif |
| App Check data service | Firestore dan Storage tetap `UNENFORCED` sebelum smoke test lapangan lulus |

---

## Koleksi Firestore ISWMP

| Koleksi | Isi | Status |
|---------|-----|--------|
| `kelurahan` | 11 kelurahan + geofence | Seed via script |
| `kantor` | 1 kantor kota Padang | Seed via script |
| `projectConfig` | Jam kerja dan kebijakan keamanan server | Seed/migrasi tepercaya |
| `users` | Profil peserta dan admin | Via registrasi/approval |
| `registrationRequests` | Antrian approval | Otomatis saat register |
| `attendances` | Bukti absensi tervalidasi backend | Callable saat check-in |
| `geofenceVerificationProposals` | Material review geofence pending | Dua callable; read admin, seluruh client write ditolak |
| `geofenceVerificationAuditLogs` | Audit approve/reject privat dan immutable | Backend saja; seluruh akses browser ditolak |

**Tidak dipakai:** `payrollRequests`, `leaveRequests`, `locationUpdates`

---

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| `auth/api-key-not-valid` | Restart `npm run dev` setelah buat `.env.local`. Cek API key di [Google Cloud Credentials](https://console.cloud.google.com/apis/credentials?project=iswmp-sumbar-padang) — pastikan tidak diblokir untuk `localhost` |
| `Missing or insufficient permissions` | Deploy rules: `firebase deploy --only firestore:rules` |
| Upload foto gagal | Deploy storage rules + cek Storage sudah diaktifkan |
| Index error pada query | Deploy indexes: `firebase deploy --only firestore:indexes` |
| `storageBucket` salah | Gunakan nilai dari Console (bisa `.firebasestorage.app` bukan `.appspot.com`) |

---

## Langkah Berikutnya (Development)

1. ✅ Firebase project dibuat
2. ⬜ Isi `.env.local` dengan config Web App
3. ⬜ Deploy rules + seed data
4. ⬜ Buat admin pertama
5. ⬜ Uji registrasi TA lapangan (pilih kelurahan)
6. ⬜ Siapkan admin kedua yang benar-benar dikuasai petugas berbeda, lalu
   verifikasi fisik setiap titik melalui tab **Admin → Verifikasi Geofence**:
   admin pertama mengusulkan dan admin kedua approve/reject di lokasi
7. ⬜ Uji check-in/check-out perangkat nyata setelah geofence aktif
8. ⬜ Jalankan smoke `preflight`; setelah check-in jalankan phase `checkin` dan
   simpan report intermediate sebelum melakukan check-out; lalu jalankan
   `verify` dengan `--checkin-report`. Simpan report final schema v3 secara aman.
   Report mengikat status shift `open` lalu `closed`, flow lapangan, replay
   proof, Functions, rules, dan rilis Hosting live yang byte-for-byte sama
   dengan build lokal
9. ⬜ Aktifkan App Check Firestore/Storage hanya dengan `--smoke-report` yang
   lulus dan metrik token valid pada kedua service

Workflow lengkap dual-control geofence, smoke test, dan gate App Check ada di
[`attendance-security-deployment.md`](./attendance-security-deployment.md).
