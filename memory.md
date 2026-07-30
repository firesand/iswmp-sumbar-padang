# memory.md — ISWMP SumBar-Padang

> **Tujuan file ini:** Jembatan informasi keberlanjutan pembahasan proyek.  
> Baca file ini di awal setiap sesi baru agar konteks tidak hilang.  
> **Update terakhir:** 30 Juli 2026
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
>
> **Catatan 30 Juli 2026 (b) — TEMUAN PRODUKSI:** analisis telemetri BimTek
> menunjukkan kegagalan absensi lapangan **bukan** karena GPS/perangkat, melainkan
> tombol absensi yang tidak pernah di-`disabled` sehingga ditekan berulang, plus
> shift yang tidak pernah di-check-out. Delapan pegawai terkunci. Rinciannya di
> bagian “Temuan produksi 28–30 Juli 2026”. Perbaikan UI **sudah dideploy**
> 31 Jul 2026 01:05 WIB.
>
> **Catatan 30 Juli 2026 (a):** ditambahkan pemeriksaan sidik sinyal GPS
> server-authoritative (deret sampel `watchPosition` + bukti lingkungan klien)
> dengan mode default `observe`, serta kontrak bukti perangkat OS untuk client
> Android attested. Lihat `docs/attendance-security-deployment.md` bagian
> “Pemeriksaan sidik sinyal GPS” dan `docs/android-attested-client.md`. Record
> yang lolos pemeriksaan ini tetap `location_photo_only`.

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
| **Status deploy 31 Jul 2026** | ✅ Lengkap. Rules/indexes/storage + 11 Functions dideploy 01:05 WIB; hosting **1.0.5** dideploy 01:31 WIB; `appConfig/version.latest` = **1.0.5** diterbitkan 01:33 WIB (`forcedUpdate: false`). Bundle live `assets/index-D1XPv96s.js`, service worker `iswmp-padang-v1.0.5-updateloopfix`, `notifications/global` non-aktif. **Belum di-commit ke git.** Urutan deploy wajib tetap Functions → Hosting (client baru ke backend lama gagal `UNEXPECTED_FIELD`) |
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
- Baseline lokal: 132 backend unit/handler test, 49 frontend/helper test, dan 108
  rules test; replay race juga diuji melalui Firestore
  Emulator. Audit dependency frontend dan Functions sama-sama 0 vulnerability.
- Sidik sinyal GPS dinilai server dari deret fix (bukan satu koordinat):
  koordinat beku, akurasi konstan, jitter nol, cadence seragam, teleport, rute
  terinterpolasi, API geolocation yang dipatch, dan replay digest jejak. Mode
  `observe` mencatat verdict tanpa menolak; `enforce` menolak
  `GPS_INTEGRITY_REJECTED`. Konfigurasi separuh jalan gagal tertutup.
- Kontrak bukti perangkat OS siap dan teruji: `OS_MOCK_LOCATION`,
  `DEVICE_INTEGRITY_UNVERIFIED`, `DEVICE_EVIDENCE_MISSING`,
  `ATTESTED_APP_REQUIRED`. Attestation ditentukan application id App Check,
  bukan isi payload. Aplikasi Android dan registrasi platformnya belum dibuat.
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
  dengan IAM build sempit.
- **KOREKSI 30 Juli 2026:** kini ada **dua** akun `role: admin` aktif di Firestore
  (keduanya `accountStatus: active`, `isActive: true`, tanpa `mustChangePassword`).
  Catatan lama “hanya satu admin aktif” sudah tidak berlaku. Dual-control geofence
  dan approval koreksi missing-checkout karena itu **sudah dapat dijalankan**,
  dengan syarat mutlak kedua akun benar-benar dipegang dua orang berbeda. Bila
  salah satunya akun cadangan milik orang yang sama, memakainya untuk approval
  membatalkan makna kontrol dua-pihak — jangan lakukan.

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

## Temuan produksi 28–30 Juli 2026

Diagnosis dari telemetri nyata, bukan dugaan. Sumber: `npx firebase functions:log
--lines 1500` (jendela 28 Jul 11:25 UTC – 30 Jul 14:19 UTC) plus query read-only
ke `attendances` dan `attendanceOpenShifts`.

### Angka

| Metrik | Nilai |
| --- | --- |
| Kejadian absensi tercatat | 346 |
| `submitAttendance` sukses / ditolak | **69 / 0** |
| `createAttendanceChallenge` sukses / ditolak | 135 / 142 |
| Challenge dibuat tetapi tidak pernah disubmit | 66 |
| Record absensi 28–30 Jul (semua `location_photo`) | 52 (44 lengkap, 8 tanpa check-out) |
| Akurasi GPS tercatat (n=96) | median 12,4 m; p90 35 m; maksimum 100 m; **nol** di atas 100 m |

Rincian penolakan — **seluruhnya di tahap challenge, tidak satu pun di submit**:

| Alasan | Jumlah | Arti |
| --- | --- | --- |
| `CHALLENGE_RATE_LIMIT` | 118 | jarak antar penekanan **median 0,9 detik**; 83 di bawah 5 detik |
| `OPEN_SHIFT_EXISTS` | 16 | shift hari sebelumnya belum di-check-out |
| `DAILY_CHALLENGE_LIMIT` | 8 | jatah 20 percobaan/hari habis, satu pegawai terkunci sisa hari |

### Kesimpulan

1. **Tipe HP bukan penyebabnya.** Tidak ada satu pun penolakan server karena GPS,
   akurasi, radius, atau foto, dan kualitas GPS lapangan justru baik.
2. **Penyebab utama: tombol absensi tidak pernah di-`disabled`.** `startCamera` di
   `Employee/Dashboard.jsx` menjalankan dua pembacaan GPS (masing-masing bisa 15
   detik) sementara tombol tetap terlihat aktif dan layar diam. Pengguna menekan
   ulang, setiap tekanan membakar satu challenge server, lalu kena rate limit 15
   detik. Diperbaiki dengan penjaga berbasis `useRef` (state React terlambat satu
   render untuk tap kedua), tombol nonaktif berlabel “Menyiapkan absensi…”, status
   bertahap, dan pesan rate-limit yang menyebut durasi tunggu.
3. **Penyebab kedua: pegawai lupa check-out.** Shift terbuka melewati batas 1.440
   menit tidak bisa di-check-out **dan** memblokir check-in berikutnya, sehingga
   pegawai terkunci total sampai ada koreksi administratif.

### Utang operasional yang masih terbuka

- **Per 31 Jul 2026: 4 shift berstatus `open`** (dari 10 sebelumnya; 6 sudah
  ditutup lewat koreksi administratif). 2 di antaranya sudah punya proposal
  menunggu approval admin kedua.
- Enam shift dari 28–29 Juli sudah melewati batas 24 jam sehingga hanya bisa
  diselesaikan lewat proposal + approval koreksi missing-checkout oleh dua admin
  berbeda. Jangan mengedit `attendances` atau `attendanceOpenShifts` langsung.
- Nama pemiliknya sengaja tidak dicatat di sini. Ambil saat dibutuhkan dengan
  query read-only `attendanceOpenShifts` (status `open`) lalu cocokkan `uid` ke
  `attendances.userId` untuk memperoleh `userName`.

### Titik buta yang belum tertutup

Validasi GPS di sisi browser menolak **sebelum** callable dipanggil, jadi kegagalan
tersebut tidak muncul di telemetri sama sekali. Selisih 66 challenge yang tidak
berujung submit adalah satu-satunya jejaknya. Mode `observe` pemeriksaan sidik
sinyal GPS dirancang persis untuk menutup lubang ini: setiap absensi akan mencatat
jumlah sampel, akurasi, dan kelas perangkat, sehingga pertanyaan “apakah tipe HP
berpengaruh” dapat dijawab dengan data setelah beberapa hari kerja.

---

## INSIDEN 31 Juli 2026 01:16 WIB — loop reload seluruh pengguna

**Gejala:** aplikasi loading → refresh → loading berputar tanpa henti, di semua
perangkat. **Penyebab: tombol "Force" di panel debug admin**, bukan deploy.

`forceUpdate()` di `src/components/Common/AppUpdateNotification.jsx` menulis
`notifications/global` = `{ active: true, type: 'update', forced: true }`. Listener
`onSnapshot` di komponen yang sama memanggil `handleUpdateNotification()`, dan di
sana `if (notification.forced) window.location.reload()` dieksekusi **tanpa syarat
pada setiap load**. Dokumennya tidak punya kedaluwarsa dan tidak dinonaktifkan
sendiri, jadi loop-nya abadi dan mengenai seluruh pengguna sekaligus.

**Penanganan:** `node scripts/stop-forced-update-loop.mjs --apply` (dibuat saat
insiden; dry-run default, dilindungi `currentDocument.updateTime`). Alternatif
manual: Firebase Console → Firestore → `notifications/global` → `active: false`.

**Aturan untuk agent berikutnya:**

- **Jangan pernah menyarankan tombol "Force"** untuk menerbitkan versi. Tombol itu
  memicu reload paksa massal, bukan pengumuman versi.
- Menerbitkan versi = menulis `appConfig/version.latest`. Gunakan
  `node scripts/publish-app-version.mjs [--forced] [--apply]`, yang menolak
  menerbitkan versi yang belum ada di `sw.js` live dan menolak jalan selama
  broadcast forced masih aktif.
- `appConfig/version.latest` yang lebih **lama** dari `APP_VERSION` client membuat
  spanduk merah “Update Required” menyuruh turun versi. Setelah setiap deploy
  hosting, terbitkan versinya.

**Perbaikan kode: SUDAH dikerjakan dan dideploy sebagai 1.0.5** (31 Jul 2026
01:31 WIB). Logikanya dipindah ke `src/utils/forcedUpdateBroadcast.js` agar bisa
diuji — 17 test di `forcedUpdateBroadcast.test.js`, termasuk regresi memakai
dokumen outage yang sebenarnya. Semua klausul gagal tertutup (memilih toast
daripada reload) bila broadcast ambigu:

- broadcast wajib menyebut `version`/`latest`; tanpa itu diabaikan
- broadcast yang menuntut versi yang sudah berjalan diabaikan
- `expiresAt` ditegakkan; broadcast lama tanpa expiry kedaluwarsa setelah 30 menit
- satu reload per broadcast per tab, ditandai di `sessionStorage`
- `sessionStorage` tidak tersedia atau melempar → tidak reload
- `forceUpdate()` kini meminta konfirmasi, menulis `expiresAt` 15 menit, dan
  menyiarkan `appConfig/version.latest` sebagai target, bukan versi browsernya

---

## Keputusan arah 31 Juli 2026 — geofence dicoret permanen

**Instruksi user, final:** jalur `geofence_onsite` dan dual-control penguncian
lokasi **bukan solusi** dan tidak boleh diusulkan lagi. Alasannya bukan teknis:
admin kedua di Padang jadwalnya padat dan kurang paham teknologi, sehingga syarat
“dua petugas melakukan propose/review di lokasi” tidak akan pernah terpenuhi.
Target rilis 1.0.4 adalah **memaksimalkan deteksi GPS/geotagging tanpa melibatkan
admin kedua**.

Konsekuensi yang harus dipahami agent berikutnya:

- `location_photo` **bukan mode sementara lagi — itu mode operasional tetap.**
  Label `location_photo_only` juga menjadi label final, bukan transisi. Jangan
  pernah melabelinya “Verified v2”, “dalam radius”, atau “onsite terverifikasi”.
- Desain mode ini punya **tenggat keras**: `MAX_LOCATION_PHOTO_MODE_DURATION_MS`
  di `functions/attendance.js` = 7 hari, dan `scripts/configure-attendance-verification-mode.mjs`
  membatasi `--duration-hours` ke 1..168. Saat kedaluwarsa, **semua check-in baru
  ditolak** (`LOCATION_PHOTO_MODE_EXPIRED`); check-out masih jalan dalam masa
  tenggang satu `maxAttendanceShiftDurationMinutes`. Tidak ada fallback otomatis.
- Artinya perpanjangan manual harus dilakukan **setiap minggu, selamanya** — ini
  risiko outage berulang, bukan pengaman. Banner peringatan di
  `src/components/Admin/Dashboard.jsx` hanya tampil untuk satu UID admin dan
  syaratnya `expiresAt > Date.now()`, jadi justru **hilang saat kedaluwarsa**.
- Opsi yang sudah dibahas dan direkomendasikan: **mode permanen eksplisit**
  (`policyVersion: 2` + `locationPhotoModePermanent` dengan `acceptedBy`,
  `acceptedAt`, `reason`) supaya penerimaan risiko tercatat sebagai keputusan,
  bukan kelalaian. Alternatif yang ditolak: auto-renew terjadwal (mengubah pemaksa
  jadi hiasan diam-diam) dan sekadar menaikkan batas ke 90 hari (hanya memindah
  tebing). Belum dikerjakan.

### Kalibrasi radius — tuas presisi yang tidak butuh admin kedua

Di mode ini yang berfungsi sebagai pagar adalah `radius` pada dokumen penugasan
(`kelurahan`/`kantor`), aditif dengan allow-list sementara. Aturannya
`jarak + akurasi <= radius`. Produksi saat ini: **11 kelurahan 300 m, kantor 200 m**
(`defaultKelurahanRadius`/`defaultKantorRadius` di `projectConfig/default`).

Dari 131 titik `operationalLocationSnapshot.distanceMeters` yang benar-benar
terekam:

| Sumber                       | n  | p50  | p75  | p90  | maks  |
|------------------------------|----|------|------|------|-------|
| Penugasan (radius 300/200 m) | 41 | 17 m | 27 m | 53 m | 240 m |
| Venue BimTek (radius 150 m)  | 90 | 30 m | 33 m | 34 m | 46 m  |

Simulasi terhadap riwayat: radius 150 m meloloskan 39/41 absensi penugasan lama,
120 m juga 39/41, 100 m 38/41. Menurunkan 300 → 150 m memangkas area penerimaan
koordinat palsu ~75% dan **hanya perubahan config, tanpa survei lapangan**.
Peringatan jujur: titik pusat kelurahan masih **provisional** (hasil peta, belum
disurvei), jadi jangan seragamkan buta — turunkan bertahap dan setel per kelurahan
memakai data jarak yang terus terekam. Belum diterapkan; menunggu keputusan user.

### Audit rantai koreksi: `securityReady: false` adalah false alarm

`scripts/audit-security-state.mjs` melaporkan `validImmutableEvents: 0`,
`validEffectiveViews: 0`, dan `approvedDecisionsWithoutCompleteChain: 8`. Ini
**sudah didiagnosis dan bukan masalah integritas data** — jangan panik dan jangan
memperbaiki data koreksi karenanya.

Kegagalan terisolasi ke satu klausul saja:
`validCorrectionProposal(..., { requireCurrentSource: true })`. Di dalamnya:

1. **`attendanceUpdateTime` meleset 1 milidetik** pada 5 dari 8 record. Produksi
   menyimpan hasil `timestampIso()` yang **membulatkan** nanodetik Firestore,
   sedangkan `decodeDocument` di skrip audit memakai `Date.parse()` yang
   **memotong**. Instan yang sama, string berbeda. Produksi konsisten dengan
   dirinya sendiri, jadi `ATTENDANCE_CHANGED` tidak pernah salah picu.
2. **`baseFingerprint` tidak cocok pada seluruh 8 record**, termasuk 3 record yang
   `attendanceUpdateTime`-nya persis sama. Jadi ada celah lain di rekonstruksi
   skrip audit — ia membangun objek `shift` sintetis berisi 8 field, sedangkan
   `assertOpenShift()` di produksi mengembalikan objek yang lebih kaya. Celah
   spesifiknya belum ditelusuri sampai tuntas.

Bukti bahwa datanya sehat: `assertSourceStillCurrent()` di
`functions/attendance-corrections.js` **menghitung ulang dan menegakkan**
`baseFingerprint`, `attendanceUpdateTime`, revisi open-shift, dan config di dalam
transaksi approval — gagal sedikit saja melempar `CORRECTION_BASE_CHANGED`,
`ATTENDANCE_CHANGED`, atau `OPEN_SHIFT_CHANGED`. Kedelapan approval lolos
pemeriksaan asli itu. Seluruh klausul substantif lain (work hours, field event,
dual admin, reviewer ≠ proposer, `hasExactKeys`) juga lolos saat diuji terpisah.

**Utang:** perbaiki skrip audit agar (a) membandingkan `updateTime` dengan
pembulatan yang sama seperti produksi, dan (b) merekonstruksi sumber open-shift
persis seperti `assertOpenShift()` — atau longgarkan `requireCurrentSource` untuk
record historis, karena freshness check memang tidak bermakna untuk koreksi lama.

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
| 14 | Sidik sinyal GPS dinilai server dari deret sampel, bukan satu koordinat | Satu koordinat adalah klaim yang gratis dipalsukan; pola deret memaksa penyerang mensimulasikan perilaku GNSS |
| 15 | Kontrol GPS baru mulai dari mode `observe`, bukan langsung menolak | Ambang dikalibrasi dari perangkat nyata; deploy tidak boleh mengunci 29 pegawai saat kegiatan berjalan |
| 16 | Attestation perangkat ditentukan application id App Check, bukan payload | Klien web dapat mengarang objek bukti; application id hanya dapat diperoleh lewat token App Check aplikasi terdaftar |
| 17 | Sampel GPS mentah disimpan di koleksi terpisah yang ditolak seluruh klien | Klien yang bisa membacanya belajar sidik sinyal mana yang diterima backend |

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
| Dua admin aplikasi/petugas independen | Aktivasi dual-control | ✅ Dua akun admin aktif per 30 Jul 2026; verifikasi dulu keduanya dipegang dua orang berbeda sebelum dipakai approval |
| Delapan shift terbuka yang tidak di-check-out | Pegawai terkunci dari absensi | 🔴 Enam sudah lewat batas 24 jam (28–29 Jul) dan butuh koreksi dua-admin; dua dari 30 Jul masih bisa self-checkout bila belum lewat batas |
| Smoke check-in + check-out | Bukti alur v2 nyata | ⏳ Belum ada report verify `PASS` |
| Metrik App Check kedua service | Gate enforcement | ⏳ Firestore dan Storage tetap `UNENFORCED` |
| Consumer key eksternal | Rotasi key lama | ⏳ Harus diidentifikasi sebelum disable/revoke |
| Observasi `observe` beberapa hari kerja | Gate pindah ke `enforce` | ⏳ `npm run configure:gps-integrity -- --mode=enforce` menolak selama masih ada `TRACE_MISSING` |
| Registrasi Android app + Play Console internal testing | Attestation Play Integrity | ⏳ Hanya pemilik proyek; lihat `docs/android-attested-client.md` |

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
| Sidik sinyal GPS server-authoritative | ✅ implementasi + test; 🟡 mode `observe`, enforce menunggu bukti observasi |
| Kontrak bukti perangkat OS (`deviceIntegrity`) | ✅ backend + jembatan klien; ⬜ aplikasi Android belum dibuat |
| Plugin native mock-location + provider App Check native | 🟡 sumber siap di `android-client/`; ⬜ belum di-generate/registrasi |
| Anti tekan-ganda tombol absensi + indikator progres | ✅ dideploy 31 Jul 2026 |
| Versi client 1.0.5 (`APP_VERSION` + `CACHE_NAME` service worker) | ✅ dideploy dan diterbitkan ke `appConfig/version` |
| Pengaman broadcast muat ulang paksa (`src/utils/forcedUpdateBroadcast.js`) | ✅ 17 test, dideploy 1.0.5 |
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
├── scripts/
│   ├── seed-firestore.mjs            ← seed kelurahan + kantor
│   └── configure-gps-integrity.mjs   ← observe/enforce sidik sinyal GPS + ringkasan observasi
├── functions/
│   ├── attendance.js                 ← callable challenge/submit (otoritatif)
│   ├── attendance-core.js            ← validasi lokasi/foto/geofence
│   └── gps-integrity.js              ← analisis deret sampel GPS + bukti perangkat OS
├── android-client/                   ← scaffold wrapper Android attested (belum di-generate)
│   ├── capacitor.config.json
│   └── plugin/                       ← plugin mock-location + jembatan App Check native
├── src/
│   ├── config/
│   │   ├── firebase.js
│   │   ├── firebase.credentials.js   ← fallback credentials
│   │   └── projectConfig.js
│   ├── data/seedData.js
│   ├── utils/
│   │   ├── gpsSignalTrace.js         ← perekam deret fix + bukti lingkungan klien
│   │   └── deviceIntegrity.js        ← jembatan bukti OS (no-op di browser)
│   └── services/geofenceService.js
└── docs/
    ├── FIREBASE_SETUP.md             ← panduan setup (updated)
    ├── attendance-security-deployment.md ← runbook keamanan/field smoke
    ├── android-attested-client.md    ← runbook wrapper Android + Play Integrity
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

1. **Approve 2 proposal koreksi missing-checkout** pagi 31 Jul 2026 oleh admin kedua — batas 1 Agustus 00:29 WIB. Ini yang paling mendesak
2. **Uji absensi nyata pagi ini** — 1.0.5 baru live dini hari dan belum pernah dipakai check-in sungguhan; pantau apakah perekaman jejak GPS 10–30 detik terasa wajar di lapangan
3. **Putuskan nasib tenggat `location_photo`** — kedaluwarsa 7 Agu 2026 01:03 WIB. Lihat “Keputusan arah 31 Juli 2026”; opsi rekomendasi adalah mode permanen eksplisit. **Jangan usulkan geofence**
4. **Uji perangkat nyata** — jalankan smoke preflight, check-in dan check-out, lalu verify
5. **Pantau mode `observe` GPS** beberapa hari kerja sampai `TRACE_MISSING` nol, baru pertimbangkan `enforce`; sesudahnya pertimbangkan penurunan radius 300 → 150 m
6. **Pantau App Check** — pertahankan `UNENFORCED` sampai report dan metrik kedua service lulus
7. **Identifikasi consumer key eksternal** sebelum disable/revoke
8. **Fase 2** — dashboard matriks kelurahan untuk admin

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
| 2026-07-30 | Sidik sinyal GPS + kontrak perangkat attested | `functions/gps-integrity.js`, jejak `watchPosition`, mode `observe`, koleksi jejak/digest, skrip `configure:gps-integrity`, scaffold `android-client/`; **belum dideploy** |
| 2026-07-30 | Diagnosis keluhan lapangan | Telemetri membuktikan 0 penolakan submit; penyebabnya tekan-ganda tombol dan shift tak ditutup; perbaikan UI + versi 1.0.4 di working tree |
| 2026-07-31 | Deploy 1.0.4 + keputusan arah | Rules, 11 Functions, hosting dideploy; jendela `location_photo` diperpanjang ke 7 Agu 01:03 WIB; geofence dicoret permanen; audit rantai koreksi didiagnosis sebagai artefak skrip |
| 2026-07-31 | Insiden loop reload + hotfix 1.0.5 | Tombol "Force" memicu reload tanpa henti di semua perangkat; broadcast dinonaktifkan, pengaman ditambahkan (`forcedUpdateBroadcast.js`, 17 test), hosting 1.0.5 dideploy |

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
- **Pengguna lapangan gagap teknologi.** Setiap perubahan alur absensi wajib punya
  indikator yang bergerak dan tombol yang benar-benar nonaktif saat proses jalan.
  Layar diam = pengguna menekan ulang = jatah challenge habis = terkunci
- Sebelum menyimpulkan penyebab keluhan absensi, **ambil telemetrinya dulu**:
  `npx firebase functions:log --lines 1500`, lalu hitung `outcome`/`reason` per
  operasi. Log sudah tersanitasi (fingerprint, tanpa koordinat). Fingerprint UID =
  20 hex pertama dari `sha256("attendance-security-log-v1" + NUL + uid)`, sehingga
  dapat dicocokkan ke `attendances.userId` untuk menemukan nama
- **Titik buta yang diketahui:** validasi GPS sisi browser menolak sebelum callable
  dipanggil, jadi kegagalan itu **tidak muncul di telemetri sama sekali**. Selisih
  antara challenge dibuat dan submit sukses adalah satu-satunya petunjuknya.
  Mode `observe` GPS dirancang untuk menutup lubang ini
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
| 0.9.0 | 2026-07-30 | Sidik sinyal GPS server-authoritative (mode `observe`), kontrak bukti perangkat OS + scaffold Android attested |
| 0.9.1 | 2026-07-30 | Diagnosis produksi: perbaikan tekan-ganda tombol absensi, indikator progres, versi client 1.0.4, koreksi fakta jumlah admin aktif |
| 1.0.0 | 2026-07-31 | Deploy 1.0.4 (rules + 11 Functions + hosting); jalur geofence dicoret permanen atas keputusan user; `location_photo` jadi mode tetap; audit rantai koreksi terbukti false alarm |
| 1.0.1 | 2026-07-31 | Insiden loop reload akibat tombol "Force"; pengaman broadcast + skrip `stop-forced-update-loop.mjs` dan `publish-app-version.mjs`; hosting 1.0.5 |
