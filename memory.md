# memory.md — ISWMP SumBar-Padang

> **Tujuan file ini:** Jembatan informasi keberlanjutan pembahasan proyek.  
> Baca file ini di awal setiap sesi baru agar konteks tidak hilang.  
> **Update terakhir:** 25 Juli 2026
>
> **Catatan keamanan 23 Juli 2026:** status dan prosedur absensi pada bagian
> lama di bawah telah digantikan oleh `docs/attendance-security-deployment.md`.
> `npm run seed` kini hanya dry-run, tidak memakai JSON service account, dan
> tidak boleh dipakai untuk mengaktifkan geofence. Aplikasi web ini tidak boleh
> disebut foolproof atau kebal fake GPS.
>
> **Catatan 25 Juli 2026:** mode `location_photo` mendapat allow-list lokasi
> operasional sementara berjangka waktu (BimTek The ZHM Premiere Padang,
> 28–31 Juli). Record tetap `location_photo_only`; bukan Verified v2.

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
| **Status saat ini** | Firebase live; jalur absensi v2 fail-closed, menunggu verifikasi geofence dan uji perangkat nyata |
| **Workspace lokal** | `~/iswmp-sumbar-padang/` |
| **Repo ISWMP (GitHub)** | https://github.com/firesand/iswmp-sumbar-padang |
| **Firebase project** | https://console.firebase.google.com/project/iswmp-sumbar-padang |
| **Firebase region** | Firestore: `asia-southeast2` (Jakarta) |
| **Parent project** | `firesand/surya-abadi-connecteam` (tidak diubah) |
| **Provinsi / Kota** | Sumatera Barat — Kota Padang |
| **Total user** | 30 akun aktif (29 non-admin + 1 admin) |
| **Total geofence** | 12 (11 kelurahan + 1 kantor kota) |

Identitas akun uji, UID, alamat akun, dan koordinat presisi tidak disimpan di
file kontinuitas ini. Ambil nilai yang diperlukan langsung dari sistem akses
terkontrol saat menjalankan smoke test.

### Snapshot keamanan absensi v2

- Semua write absensi dilakukan callable server-authoritative; direct client
  write ditolak rules.
- Geofence fail-closed dan hanya aktif setelah workflow dua callable: satu admin
  aplikasi membuat proposal survei, admin aplikasi lain mereview dari lokasi
  fisik dan mengaktifkannya secara atomik.
- Kode onsite mensyaratkan GPS admin yang fresh/akurat. Submit memvalidasi GPS
  pegawai dan admin, radius dengan margin akurasi, serta co-presence maksimal
  100 meter setelah ketidakpastian kedua lokasi ditambahkan.
- Replay detector `dh144mv2` memakai delapan view, tujuh band interleaved, dan
  threshold Hamming enam. Residual yang diketahui: rotasi sekitar 3 derajat
  atau lebih, crop bergeser/lebih besar, dan border besar masih bisa lolos.
- Quality gate foto menolak citra kosong/minim informasi, tetapi bukan face
  detection, face matching, atau liveness.
- Structured telemetry memakai fingerprint dan tidak mencatat identitas mentah,
  token, kode onsite, koordinat, atau hash foto. Hosting memakai CSP script
  tanpa `unsafe-inline`/`unsafe-eval`.
- Baseline lokal: 60 backend unit/handler test, 25 frontend/helper test, dan 104
  rules test; replay race juga diuji melalui Firestore
  Emulator. Audit dependency frontend dan Functions sama-sama 0 vulnerability.
- Firestore dan Storage App Check tetap `UNENFORCED`. Enforcement menunggu
  check-in serta check-out perangkat nyata dan metrik `VALID/ALLOW` pada kedua
  service, lalu wajib memakai smoke report schema v3 yang lulus.
- Smoke/gate mengikat report ke rilis Hosting live: konfigurasi header/rewrites,
  daftar file, ETag, CSP, dan seluruh byte build harus sama dengan `dist` lokal.
  Perubahan deployment sesudah smoke membuat report tidak berlaku.
- Dual-control geofence dipaksakan oleh callable, lock transaksi, dan dua UID
  admin aplikasi; workflow CLI direct-write sudah dipensiunkan. Dua UID bukan
  bukti dua manusia, dan GPS browser tetap dapat dipalsukan. Selain itu,
  principal IAM dengan akses tulis Firestore mentah tetap trusted dan dapat
  melewati workflow. Metrik App Check juga bersifat agregat Web App/window,
  bukan bukti yang dapat diikat ke satu request.
- Replay near-match kini hanya membandingkan UID yang sama dalam rolling window
  30 hari (maksimum 64 bukti aktif); exact SHA-256 tetap global dan permanen.
- Pointer shift mempertahankan `workDate` check-in sehingga checkout lintas
  tengah malam tetap bisa dilakukan sampai batas server 1.440 menit. Koreksi
  missing-checkout memakai proposal/approval dua admin dan effective sidecar
  berlabel manual/non-device; attendance kanonik tidak diubah.
- Deploy produksi terakhir: Hosting version `b36deec30214780e`; sebelas Function
  `ACTIVE` Node 22 memakai source hash
  `68eb9492ca3d99b36371156687220acd448b085f`. Artifact hosting live cocok
  byte-for-byte dengan build lokal dan sebelas probe tanpa autentikasi ditolak
  HTTP 401.
- Snapshot data: 12/12 geofence masih nonaktif/provisional, 0 audit dual-control,
  0 bukti replay v2, dan enam attendance lama tetap legacy/unverified. Satu
  user-managed service-account key masih aktif menunggu konfirmasi konsumen.
- Firestore `DATA_WRITE` audit aktif tanpa exemption. Principal raw writer turun
  dari tujuh menjadi lima; Editor dicabut dari App Engine default account yang
  tidak terpakai dan Compute default build account. Deploy Functions berhasil
  dengan IAM build sempit. Hanya satu admin aplikasi aktif, jadi aktivasi
  dual-control masih menunggu bootstrap admin kedua yang benar-benar independen.
  Ketiadaan admin kedua juga membuat approval koreksi missing-checkout sengaja
  belum operasional.

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
├── Tim Kantor Kota Padang (5) ────── absensi di 1 geofence kantor (Pasir Nan Tigo)
│   ├── KorKot (KORKOT) × 1
│   ├── Asisten Manajemen Data (ASMAN_DATA) × 1
│   ├── Operator (OPERATOR) × 2
│   └── Office Boy (OFFICE_BOY) × 1
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
| `office_staff` + `OFFICE_BOY` | Office Boy | kantor |

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
| 7 | Geofence v2 fail-closed | Absensi ditolak bila geofence belum lolos audit dua pihak dan belum aktif |
| 8 | Foto selfie tetap wajib | Bukti visual; quality/replay gate bukan face/liveness verification |
| 9 | Web config via env/fallback; maintenance tepercaya via Firebase CLI OAuth; geofence via callable | Tidak memakai JSON service-account jangka panjang untuk script operasi dan tidak memberi browser raw-write IAM |
| 10 | Pusat geofence awal TA = kantor kelurahan masing-masing | Anchor lokasi yang stabil dan dapat diverifikasi |
| 11 | Koordinat Google Maps disimpan provisional dan nonaktif | Marker web bukan pengganti verifikasi GPS lapangan |
| 12 | Co-presence admin–pegawai wajib | Membatasi pembagian kode jarak jauh, tetapi tidak menutup kolusi/fake GPS dua perangkat |
| 13 | Allow-list lokasi operasional sementara di mode GPS+foto | Venue BimTek / kegiatan di luar geofence tanpa mengklaim Verified v2; aditif terhadap penugasan asal |

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
| Survei fisik 12 geofence | Validasi lokasi/radius | 🟡 Marker masih provisional dan seluruh geofence sengaja nonaktif |
| Dua admin aplikasi/petugas independen | Aktivasi dual-control | ⏳ Baru satu admin aktif; bootstrap admin kedua tepercaya lalu jalankan panel produksi |
| Smoke check-in + check-out | Bukti alur v2 nyata | ⏳ Belum ada report verify `PASS` |
| Metrik App Check kedua service | Gate enforcement | ⏳ Firestore dan Storage tetap `UNENFORCED` |
| Consumer key eksternal | Rotasi key lama | ⏳ Harus diidentifikasi sebelum disable/revoke |

---

## Adaptasi Teknis — Status Implementasi

| Komponen | Status |
|----------|--------|
| Fork + rebrand UI | ✅ |
| `projectConfig.js` feature flags | ✅ |
| `geofenceService.js` multi-geofence | ✅ |
| Validasi lokasi server + co-presence admin/pegawai | ✅ implementasi; ⬜ uji lapangan |
| `Register.jsx` ISWMP (kelurahan/kantor) | ✅ |
| `CheckIn.jsx` + `Employee/Dashboard.jsx` | ✅ |
| Callable challenge/upload/submit server-authoritative | ✅ |
| Dual-control geofence propose/review dua akun | ✅ callable + panel; ⬜ admin kedua dan aktivasi lapangan |
| Exact + `dh144mv2` replay dan quality gate | ✅; residual transform/liveness didokumentasikan |
| Structured telemetry tersanitasi + CSP script ketat | ✅ |
| App Check Functions | ✅ diwajibkan callable |
| App Check Firestore/Storage | 🟡 `UNENFORCED`, menunggu smoke + metrik kedua service |
| `firestore.rules` ISWMP | ✅ deployed |
| `storage.rules` | ✅ deployed |
| Firebase Hosting (frontend) | ✅ https://iswmp-sumbar-padang.web.app |
| `firebase.credentials.js` | ✅ |
| `Admin/Dashboard.jsx` matriks kelurahan | ⬜ Fase 2 |
| Seed script `npm run seed` | ✅ dry-run; hanya mereset provisional dengan konfirmasi eksplisit |
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
    ├── attendance-security-deployment.md ← runbook keamanan/field smoke
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
| **1** Core adaptation | ✅ | Firebase live; jalur absensi v2 dan hardening lokal tersedia |
| **2** Dashboard monitoring | ⬜ Belum | Matriks 11×2 kelurahan + panel kantor |
| **3** Laporan & export | ⬜ Belum | Excel per kelurahan |
| **4** Uji lapangan & enforcement | ⬜ Belum | Dual-control geofence, check-in/out nyata, App Check metrics |
| **5** Enhancement | ⬜ Belum | WhatsApp, peta, dll. |

---

## Langkah Berikutnya (Prioritas)

1. **Bootstrap admin kedua secara tepercaya**, lalu dua petugas menjalankan propose/review dari tab Verifikasi Geofence; jangan aktifkan koordinat seed
2. **Uji perangkat nyata** — jalankan smoke preflight, check-in dan check-out, lalu verify
3. **Pantau App Check** — pertahankan `UNENFORCED` sampai report dan metrik kedua service lulus
4. **Identifikasi consumer key eksternal** sebelum disable/revoke
5. **Fase 2** — dashboard matriks kelurahan untuk admin

### Perintah dev rutin

```bash
cd ~/iswmp-sumbar-padang
npm run dev                              # localhost:5173
npm run firebase:deploy:rules            # deploy rules
npm run seed                             # dry-run saja; tidak menulis Firestore
```

### Administrasi user

- Approval/rejection dilakukan dari dashboard dan ditulis atomik.
- Role dan assignment tidak dapat diubah oleh browser setelah registrasi;
  assignment baru harus cocok dengan master server dan dikonfirmasi admin saat
  approval.
- Bootstrap admin hanya melalui identitas tepercaya/Firebase Console; admin
  aplikasi tidak dapat mempromosikan admin lain.

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
| 2026-07-21 | Koordinat kantor proyek | Marker kantor disimpan provisional; nilai presisi tidak dicatat di memory |
| 2026-07-22 | Fix registrasi dan pending approval | Selaraskan Firestore rules dengan model ISWMP, write atomik, banner admin, recovery akun Auth-only; rules + hosting dideploy |
| 2026-07-23 | Hardening absensi v2 | Co-presence, dual-control geofence, `dh144mv2`, photo quality, telemetry, CSP, smoke/App Check gate |
| 2026-07-23 | Hardening produksi lanjutan | Dual-control callable/panel, audit DATA_WRITE, IAM build least-privilege, Hosting exact binding; Functions/rules/hosting dideploy |
| 2026-07-23 | Replay/overnight/correction | Replay near-match per UID/30 hari, checkout lintas tengah malam, koreksi dual-admin, 11 Functions/rules/Hosting dideploy |
| 2026-07-25 | Lokasi operasional sementara BimTek | Allow-list aditif di mode GPS+foto untuk The ZHM Premiere Padang 28–31 Juli; deploy Functions + apply config |

---

## Catatan untuk Agent Berikutnya

- User berkomunikasi dalam **Bahasa Indonesia**
- Developer: Hikmahtiar Studio; identitas akun uji tidak disimpan di dokumentasi
- Jangan commit ke git kecuali diminta eksplisit
- Jangan commit: `.env.local`, `service-account.json`
- Firebase CLI: gunakan `npx firebase` atau `npm run firebase:*`, **bukan** `firebase` global
- Ambil Firebase Web config dari Console/environment; jangan salin credential atau identitas akun ke dokumentasi
- `firebase.credentials.js` = fallback jika `.env.local` bermasalah
- KorKot = `office_staff`, bukan `admin`
- Kantor = **1 geofence** untuk 5 orang; marker masih provisional / `isActive: false`
- Total absensi = **26** (bukan 22)
- Total cakupan = **11 kelurahan di 5 kecamatan**
- Nama canonical: Lubuk Begalung Nan XX, Tanjung Aur Nan XX, Parupuk Tabing
- Kampung Pondok sementara: **Jl. Dobi VI No. 2**
- Koordinat kantor kelurahan yang ada masih provisional dan `isActive: false`
- Production memiliki 12 geofence provisional/nonaktif; seed bukan alat aktivasi
- Jangan klaim foolproof: browser GPS dapat dipalsukan; co-presence juga dapat dilewati bila dua pihak berkolusi dan memalsukan kedua lokasi
- Perintah operasional keamanan harus mengikuti `docs/attendance-security-deployment.md`
- Pendaftar saat rules rusak (setelah deploy keamanan 20 Jul) dapat mengulang form dengan email/password lama untuk memulihkan akun Auth-only

---

## Changelog memory.md

| Versi | Tanggal | Perubahan |
|-------|---------|-----------|
| 0.3.0 | 2026-07-09 | Firebase guide, multi-geofence, seed script |
| 0.4.0 | 2026-07-10 | Firebase go-live, rules deployed, registrasi & login OK, testing user KorKot |
| 0.4.1 | 2026-07-10 | Fix celah GPS: no fallback, no accuracy bypass, audit fields di attendance |
| 0.5.0 | 2026-07-11 | Normalisasi 11 kelurahan, 11 marker kantor provisional, seed satu sumber, geofence tetap nonaktif |
| 0.5.1 | 2026-07-21 | Marker kantor proyek ditambahkan sebagai data provisional |
| 0.6.0 | 2026-07-22 | Perbaiki regresi rules registrasi, pending approval, dan recovery akun; deploy production |
| 0.7.0 | 2026-07-23 | Runbook absensi v2: dual control, co-presence, replay/quality, telemetry, smoke dan App Check gate |
| 0.7.1 | 2026-07-23 | Pindahkan dual-control ke callable/panel, kurangi IAM bypass, tambah audit DATA_WRITE dan binding Hosting, deploy sembilan Functions |
| 0.8.0 | 2026-07-23 | Replay per UID/30 hari, pointer overnight, koreksi missing-checkout dual-admin, deploy 11 Functions/rules/Hosting |
| 0.8.1 | 2026-07-25 | Allow-list lokasi operasional sementara BimTek di mode location_photo; record tetap location_photo_only |
