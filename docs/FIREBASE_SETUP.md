# Firebase Setup — ISWMP SumBar-Padang

**Project:** [iswmp-sumbar-padang](https://console.firebase.google.com/project/iswmp-sumbar-padang/overview)  
**Mode transisi:** absensi tetap dicatat meski geofence belum dikalibrasi (GPS + selfie disimpan)

---

## Checklist Console Firebase

Buka [Firebase Console → iswmp-sumbar-padang](https://console.firebase.google.com/project/iswmp-sumbar-padang/overview) dan pastikan semua langkah di bawah selesai.

### 1. Authentication

1. **Build** → **Authentication** → **Get started**
2. Tab **Sign-in method** → aktifkan **Email/Password**
3. (Opsional) Tab **Settings** → tambahkan authorized domain untuk production:
   - `localhost` (otomatis untuk dev)
   - domain Vercel nanti, mis. `iswmp-sumbar-padang.vercel.app`

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

> Storage dipakai untuk foto profil & selfie absensi.

### 4. Web App — Ambil Config

1. **Project Overview** (ikon gear) → **Project settings**
2. Scroll ke **Your apps** → klik **</> Web**
3. App nickname: `ISWMP SumBar-Padang Web`
4. **Jangan** centang Firebase Hosting dulu (pakai Vercel nanti)
5. Klik **Register app**
6. Salin nilai `firebaseConfig`:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyCS0zQzf22j4ttDA6pYeOlrNxaacZ7Cqk4",
  authDomain: "iswmp-sumbar-padang.firebaseapp.com",
  projectId: "iswmp-sumbar-padang",
  storageBucket: "iswmp-sumbar-padang.firebasestorage.app",
  messagingSenderId: "1079074812491",
  appId: "1:1079074812491:web:28a1a3fa33933c5ca9d3ce",
  measurementId: "G-4LE8FDY3VW"
};

```

7. Buat file `.env.local` di root project:

```bash
cp .env.example .env.local
```

8. Isi `.env.local` dengan nilai dari Firebase Console:

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=iswmp-sumbar-padang.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=iswmp-sumbar-padang
VITE_FIREBASE_STORAGE_BUCKET=iswmp-sumbar-padang.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

> **Penting:** Jangan commit `.env.local` ke git.

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

**Opsi A — Firebase Admin SDK (disarankan)**

1. Di Console → **Project settings** → **Service accounts**
2. Klik **Generate new private key** → simpan sebagai `service-account.json` di root project
3. **Jangan commit** file ini (sudah ada di `.gitignore`)
4. Jalankan:

```bash
npm run seed
```

**Opsi B — Manual di Console**

Buat koleksi `kelurahan` dan `kantor` secara manual, atau import dari data di `docs/KELURAHAN.md`.

---

## Buat Admin Pertama

Karena registrasi self-register menghasilkan akun `pending`, admin pertama dibuat manual:

### Langkah

1. Jalankan app: `npm run dev`
2. Buka `http://localhost:5173/register`
3. Daftar dengan email admin (mis. `admin@iswmp-padang.id`)
4. Di Firebase Console → **Firestore** → koleksi `users` → dokumen user tersebut:
   - Ubah `role` → `"admin"`
   - Ubah `accountStatus` → `"active"`
   - Ubah `isActive` → `true`
5. Login ulang → redirect ke `/admin`

> Setelah admin aktif, approve registrasi user lain dari tab **Pending Approvals**.

---

## Verifikasi Setup

| Cek | Cara |
|-----|------|
| Auth berfungsi | Register + login di `localhost:5173` |
| Firestore rules | Register tidak error saat buat dokumen `users` |
| Storage | Upload foto profil saat register |
| Seed kelurahan | Firestore → `kelurahan` → 11 dokumen |
| Seed kantor | Firestore → `kantor` → 1 dokumen `kantor-padang-kota` |
| Geofence mode | Check-in berhasil dengan pesan "belum dikalibrasi" |

---

## Koleksi Firestore ISWMP

| Koleksi | Isi | Status |
|---------|-----|--------|
| `kelurahan` | 11 kelurahan + geofence | Seed via script |
| `kantor` | 1 kantor kota Padang | Seed via script |
| `projectConfig` | Jam kerja, mode transisi | Seed via script |
| `users` | Profil 26 user + admin | Via registrasi |
| `registrationRequests` | Antrian approval | Otomatis saat register |
| `attendances` | Record absensi harian | Otomatis saat check-in |

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
6. ⬜ Uji check-in mode transisi (koordinat provisional, geofence belum aktif)
7. ⬜ Verifikasi titik di kantor kelurahan → set `coordinateStatus: verified`, isi `verifiedAt`, lalu set `isActive: true`
