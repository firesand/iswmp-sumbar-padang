# memory.md — ISWMP SumBar-Padang

> **Tujuan file ini:** Jembatan informasi keberlanjutan pembahasan proyek.  
> Baca file ini di awal setiap sesi baru agar konteks tidak hilang.  
> **Update terakhir:** 11 Juli 2026

---

## Cara Pakai

1. **Agent / developer baru** → baca `memory.md` dulu, lalu `PROJECT_SPEC.md` jika perlu detail teknis
2. **Setelah setiap sesi penting** → update bagian *Log Sesi*, *Keputusan*, dan *Blocker*
3. **Jangan duplikasi** → detail teknis lengkap tetap di `docs/`, file ini hanya ringkasan hidup + konteks percakapan

---

## Snapshot Proyek

| Item | Nilai |
|------|-------|
| **Nama proyek** | ISWMP SumBar-Padang |
| **Nama lengkap** | Integrated Solid Waste Management Project — Sumatera Barat, Kota Padang |
| **Tujuan aplikasi** | Crosscheck kehadiran tim proyek (bukan HR/payroll) |
| **Developer** | Hikmahtiar Studio |
| **Status saat ini** | Fase 1 — Core adaptation (Firebase live, registrasi & login OK, belum seed & check-in uji) |
| **Workspace lokal** | `~/iswmp-sumbar-padang/` |
| **Repo ISWMP (GitHub)** | https://github.com/firesand/iswmp-sumbar-padang |
| **Firebase project** | https://console.firebase.google.com/project/iswmp-sumbar-padang |
| **Firebase region** | Firestore: `asia-southeast2` (Jakarta) |
| **Parent project** | `firesand/surya-abadi-connecteam` (tidak diubah) |
| **Provinsi / Kota** | Sumatera Barat — Kota Padang |
| **Total user absensi** | 26 orang (+ 1–2 admin) |
| **Total geofence** | 12 (11 kelurahan + 1 kantor kota) |

### User testing saat ini (Firestore)

| Field | Nilai |
|-------|-------|
| Email | `firesand@gmail.com` |
| UID | `TJBS6DlyhcbcGxOtoxdCXLQeFYq1` |
| Role | `office_staff` |
| Peran | `KORKOT` (Koordinator Kota) |
| Status | `active` / `isActive: true` |
| Catatan | Akun testing developer — bukan data produksi final |

---

## Konteks dari Percakapan

### Sesi 1–3 — Review parent + perencanaan Padang (9 Jul 2026)

- Parent `surya-abadi-connecteam` cocok sebagai fondasi (absensi GPS + selfie + dashboard)
- 11 kelurahan × 2 TA = 22 lapangan + 4 tim kantor = **26 user absensi**
- Firebase terpisah, multi-geofence, tanpa payroll/cuti/BPJS

### Sesi 4 — memory.md (9 Jul 2026)

File kontinuitas dibuat.

### Sesi 5 — Fork codebase (9 Jul 2026)

- KorKot **tanpa** dashboard admin; registrasi **self-register + approval**
- Fork parent → rebrand, feature flags, build OK (~1.26 MB)

### Sesi 6 — Input 11 kelurahan (9 Jul 2026)

PDF `Kelurahan ISWMP Padang.pdf` → `docs/KELURAHAN.md` (pembacaan awal 6 kecamatan; kemudian dikoreksi menjadi 5)

### Sesi 7 — Firebase + multi-geofence (9 Jul 2026)

- `geofenceService.js`, mode transisi geofence, adaptasi Register/CheckIn
- `docs/FIREBASE_SETUP.md`, `scripts/seed-firestore.mjs`, `firestore.rules` ISWMP

### Sesi 8 — Firebase go-live + registrasi pertama (9–10 Jul 2026)

**Firebase Console selesai:**
- Web App: `ISWMP SumBar-Padang Web`
- Auth: Email/Password ✅
- Firestore: Jakarta ✅
- Storage: `iswmp-sumbar-padang.firebasestorage.app` ✅

**Development & deploy:**
- `firebase-tools` via npm (`npx firebase`, `npm run firebase:deploy:rules`)
- Fix deploy: `storage:rules` → `storage`; `firebase.json` bucket eksplisit
- Rules + indexes **deployed** ✅
- `src/config/firebase.credentials.js` — fallback config (fix typo API key `tT` → `tt`)
- `.env.local` diisi dari Console

**Uji coba berhasil:**
- Registrasi self-register ✅
- Manual aktivasi di Firestore (`accountStatus: active`) ✅
- Login → dashboard employee (`/employee`) ✅
- Console: `🔥 Firebase project: iswmp-sumbar-padang` ✅

**Belum dilakukan sesi ini:**
- `npm run seed` (11 kelurahan ke Firestore)
- Buat akun `admin` terpisah
- Uji check-in end-to-end
- Fix minor: `AppUpdateNotification` → `Missing or insufficient permissions`

### Sesi 9 — Titik kantor kelurahan provisional (11 Jul 2026)

- 11 marker kantor kelurahan diperoleh dari Google Maps dan dicatat sebagai koordinat **provisional**
- Normalisasi: **Lubuk Begalung Nan XX** berada di Kecamatan Lubuk Begalung; **Tanjung Aur Nan XX**; **Parupuk Tabing**
- Total wilayah dikoreksi menjadi **11 kelurahan di 5 kecamatan**
- Kampung Pondok sementara menggunakan alamat **Jl. Dobi VI No. 2**
- `src/data/seedData.js` menjadi master executable; `scripts/seed-firestore.mjs` mengimpor data tersebut
- Seluruh geofence kelurahan tetap `isActive: false` sampai verifikasi lapangan
- ID internal lama dipertahankan, termasuk `kel-parupuak-tabing`, agar referensi user tidak terputus

---

## Struktur Pengguna (Confirmed)

```
ISWMP SumBar-Padang
│
├── Admin Sistem (1–2) ─────────────── tidak wajib absen
│
├── Tim Kantor Kota Padang (4) ────── absensi di 1 geofence kantor (TBD)
│   ├── KorKot (KORKOT) × 1
│   ├── Asisten Manajemen Data (ASMAN_DATA) × 1
│   └── Operator (OPERATOR) × 2
│
└── Tenaga Ahli Lapangan (22) ─────── absensi di kelurahan masing-masing
    ├── TA Persampahan (TA_PERSAMP) × 11
    └── TA Kelembagaan (TA_KELEMBAGAAN) × 11
```

### Kode peran (untuk development)

| Kode | Label | Tipe |
|------|-------|------|
| `admin` | Admin Sistem | admin |
| `field_staff` + `TA_PERSAMP` | Tenaga Pendamping Persampahan | kelurahan |
| `field_staff` + `TA_KELEMBAGAAN` | Tenaga Ahli Kelembagaan | kelurahan |
| `office_staff` + `KORKOT` | Koordinator Kota | kantor |
| `office_staff` + `ASMAN_DATA` | Asisten Manajemen Data | kantor |
| `office_staff` + `OPERATOR` | Operator | kantor |

---

## Keputusan Desain (Sudah Disepakati)

| # | Keputusan | Alasan |
|---|-----------|--------|
| 1 | Fork dari `surya-abadi-connecteam` | Hemat waktu; fitur absensi sudah ada |
| 2 | Firebase project `iswmp-sumbar-padang` terpisah | Isolasi data proyek ISWMP |
| 3 | Koordinat di Firestore (`kelurahan` + `kantor`) | 12 lokasi, fleksibel update |
| 4 | Modul payroll, cuti, location-update **OFF** | Fokus crosscheck kehadiran |
| 5 | Self-register + approval admin | Alur registrasi |
| 6 | KorKot = `office_staff`, **bukan admin** | Hanya absen kantor |
| 7 | Mode transisi geofence **A** | Absensi tercatat selama geofence belum diverifikasi/diaktifkan |
| 8 | Foto selfie tetap wajib | Bukti visual kehadiran |
| 9 | Firebase credentials: env + `firebase.credentials.js` fallback | Hindari masalah `.env.local` di dev |
| 10 | Pusat geofence awal TA = kantor kelurahan masing-masing | Anchor lokasi yang stabil dan dapat diverifikasi |
| 11 | Koordinat Google Maps disimpan provisional dan nonaktif | Marker web bukan pengganti verifikasi GPS lapangan |

---

## Keputusan yang BELUM Final

| # | Pertanyaan | Status |
|---|------------|--------|
| 1 | Asisten Manajemen Data butuh dashboard? | ⏳ Tanya user |
| 2 | Jam absensi resmi proyek? | Default: 08:00 WIB — ⏳ konfirmasi |
| 3 | Radius geofence default? | 300m kelurahan, 200m kantor — ⏳ kalibrasi lapangan |
| 4 | Branding UI final (logo)? | ⏳ Konfirmasi |

---

## Data yang Masih Perlu Diselesaikan (Blocker)

| Data | Dampak | Status |
|------|--------|--------|
| Daftar 11 kelurahan | Seed geofence | ✅ `docs/KELURAHAN.md` |
| Koordinat GPS kelurahan | Validasi radius TA | 🟡 11/11 marker provisional; verifikasi lapangan belum dilakukan |
| Koordinat kantor Padang | Validasi radius kantor | ⏳ TBD |
| Seed Firestore (`kelurahan`, `kantor`) | Dropdown/register dari DB | ⏳ jalankan `npm run seed` |
| Akun admin produksi | Approve registrasi user | ⏳ belum dibuat |
| Assign nama TA per kelurahan | Matriks dashboard | ⏳ daftar nama ✅ `docs/PERSONIL.md`; kelurahan per orang masih TBD |
| 26 user onboarding | Data lengkap | 🟡 nama+HP+jabatan ada; email & kelurahan TBD |

---

## Adaptasi Teknis — Status Implementasi

| Komponen | Status |
|----------|--------|
| Fork + rebrand UI | ✅ |
| `projectConfig.js` feature flags | ✅ |
| `geofenceService.js` multi-geofence | ✅ |
| `geolocation.js` mode transisi | ✅ |
| `Register.jsx` ISWMP (kelurahan/kantor) | ✅ |
| `CheckIn.jsx` + `Employee/Dashboard.jsx` | ✅ |
| `firestore.rules` ISWMP | ✅ deployed |
| `storage.rules` | ✅ deployed |
| Firebase Hosting (frontend) | ✅ https://iswmp-sumbar-padang.web.app |
| `firebase.credentials.js` | ✅ |
| `Admin/Dashboard.jsx` matriks kelurahan | ⬜ Fase 2 |
| Seed script `npm run seed` | ✅ memuat 11 titik provisional, ⬜ belum dijalankan |
| Logo ISWMP khusus | ⬜ masih icon parent |

---

## Peta File Proyek

```
iswmp-sumbar-padang/
├── memory.md                         ← FILE INI
├── README.md
├── PROJECT_SPEC.md
├── package.json
├── .env.example / .env.local         ← config lokal (jangan commit)
├── .firebaserc                       ← project: iswmp-sumbar-padang
├── firebase.json
├── firestore.rules / storage.rules
├── scripts/seed-firestore.mjs        ← seed kelurahan + kantor
├── src/
│   ├── config/
│   │   ├── firebase.js
│   │   ├── firebase.credentials.js   ← fallback credentials
│   │   └── projectConfig.js
│   ├── data/seedData.js
│   └── services/geofenceService.js
└── docs/
    ├── FIREBASE_SETUP.md             ← panduan setup (updated)
    ├── KELURAHAN.md                  ← 11 kelurahan ✅
    ├── PERSONIL.md                   ← 26 personil 2026 (referensi)
    ├── DATA_MODEL.md
    ├── ORGANIZATION.md
    └── ROADMAP.md
```

---

## Roadmap Singkat

| Fase | Status | Isi |
|------|--------|-----|
| **0** Setup & docs | ✅ Selesai | |
| **1** Core adaptation | 🟡 ~80% | Firebase live, register/login OK; seed & check-in uji tersisa |
| **2** Dashboard monitoring | ⬜ Belum | Matriks 11×2 kelurahan + panel kantor |
| **3** Laporan & export | ⬜ Belum | Excel per kelurahan |
| **4** Uji lapangan & go-live | ⬜ Belum | Kalibrasi GPS, deploy Vercel |
| **5** Enhancement | ⬜ Belum | WhatsApp, peta, dll. |

---

## Langkah Berikutnya (Prioritas)

1. **`npm run seed`** — butuh `service-account.json` → isi 11 kelurahan + kantor di Firestore
2. **Buat akun admin** — register baru → Firestore: `role: admin`, `active: true` (atau upgrade akun terpisah)
3. **Uji check-in** — mode transisi (GPS + selfie, geofence belum aktif)
4. **Fix** `AppUpdateNotification` permissions error (minor)
5. **Verifikasi koordinat** di 11 kantor kelurahan; isi `verifiedAt` dan kalibrasi radius sebelum aktivasi
6. **Fase 2** — dashboard matriks kelurahan untuk admin

### Perintah dev rutin

```bash
cd ~/iswmp-sumbar-padang
npm run dev                              # localhost:5173
npm run firebase:deploy:rules            # deploy rules
npm run seed                             # seed Firestore (butuh service-account.json)
```

### Aktivasi user manual (Firestore)

Koleksi `users` → edit dokumen:
- Approve: `accountStatus: active`, `isActive: true`
- Jadi admin: tambah `role: admin`
- Koleksi `registrationRequests` → `status: approved` (opsional)

---

## Log Sesi

| Tanggal | Topik | Output |
|---------|-------|--------|
| 2026-07-09 | Review parent + perencanaan Padang | Arsitektur multi-geofence |
| 2026-07-09 | Setup sub-project + docs | Folder + dokumentasi awal |
| 2026-07-09 | Fork codebase | Rebrand, feature flags, build OK |
| 2026-07-09 | Input 11 kelurahan (PDF) | `docs/KELURAHAN.md` |
| 2026-07-09 | Firebase + multi-geofence code | geofenceService, seed script, Register adaptasi |
| 2026-07-10 | Firebase go-live + registrasi | Auth/Firestore/Storage OK, rules deployed, login OK |
| 2026-07-11 | Riset dan normalisasi lokasi kelurahan | 11 marker kantor provisional, 5 kecamatan, seed lokal diperbarui |
| 2026-07-20 | Security pull + deploy rules; personil Excel | `docs/PERSONIL.md` (26 orang; PPM/PPL mapping) |
| 2026-07-20 | Firebase Hosting config + deploy | Live: https://iswmp-sumbar-padang.web.app |

---

## Catatan untuk Agent Berikutnya

- User berkomunikasi dalam **Bahasa Indonesia**
- Developer: Hikmahtiar Studio (`firesand@gmail.com` = akun testing)
- Jangan commit ke git kecuali diminta eksplisit
- Jangan commit: `.env.local`, `service-account.json`
- Firebase CLI: gunakan `npx firebase` atau `npm run firebase:*`, **bukan** `firebase` global
- API key benar: `AIzaSyCS0zQzf22j4**tt**DA6pYeOlrNxaacZ7Cqk4` (perhatikan `tt` bukan `tT`)
- `firebase.credentials.js` = fallback jika `.env.local` bermasalah
- KorKot = `office_staff`, bukan `admin`
- Kantor = **1 geofence** untuk 4 orang
- Total absensi = **26** (bukan 22)
- Total cakupan = **11 kelurahan di 5 kecamatan**
- Nama canonical: Lubuk Begalung Nan XX, Tanjung Aur Nan XX, Parupuk Tabing
- Kampung Pondok sementara: **Jl. Dobi VI No. 2**
- Koordinat kantor kelurahan yang ada masih provisional dan `isActive: false`
- Firestore masih kosong koleksi `kelurahan` sampai `npm run seed` dijalankan

---

## Changelog memory.md

| Versi | Tanggal | Perubahan |
|-------|---------|-----------|
| 0.3.0 | 2026-07-09 | Firebase guide, multi-geofence, seed script |
| 0.4.0 | 2026-07-10 | Firebase go-live, rules deployed, registrasi & login OK, testing user KorKot |
| 0.4.1 | 2026-07-10 | Fix celah GPS: no fallback, no accuracy bypass, audit fields di attendance |
| 0.5.0 | 2026-07-11 | Normalisasi 11 kelurahan, 11 marker kantor provisional, seed satu sumber, geofence tetap nonaktif |
