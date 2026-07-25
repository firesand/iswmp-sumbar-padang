# Runbook deployment keamanan absensi

Jalur absensi v2 bersifat server-authoritative dan fail-closed. Namun aplikasi
web ini **bukan foolproof**: GPS browser tetap berasal dari perangkat klien dan
dapat dipalsukan. Kontrol yang ada menaikkan biaya kecurangan dan menyediakan
bukti audit; kontrol tersebut tidak membuktikan integritas sensor atau
liveness manusia.

## Status keamanan saat ini

- Tepat sebelas callable Gen2 berjalan pada Node 22 di `asia-southeast2` dengan
  service account runtime khusus. Firestore/Storage rules menolak write
  absensi langsung dari browser.
- Callable sensitif memerlukan Firebase Auth dan App Check. Firestore dan
  Storage App Check tetap `UNENFORCED` (monitoring) sampai smoke test lapangan
  di bawah menghasilkan dua alur nyata—check-in dan check-out—serta metrik
  `VALID/ALLOW` lebih dari nol pada **kedua** service.
- Seluruh geofence seed tetap provisional/nonaktif. Aktivasi hanya boleh lewat
  dua callable App Check di panel admin: satu akun admin aplikasi mengusulkan
  hasil survei dan akun admin aplikasi lain mereview dari lokasi fisik.
- Baseline lokal terbaru: 60 backend unit/handler test, 25 frontend/helper test,
  dan 104 semantic security-rules test lulus. Uji
  transaksi replay konkuren di Firestore Emulator merupakan gate terpisah;
  perintahnya ada di bawah.
- Hosting menerapkan CSP script ketat: script hanya dari origin aplikasi dan
  endpoint reCAPTCHA yang diizinkan, tanpa `unsafe-inline`/`unsafe-eval`, serta
  memblokir script attribute. Ini mengurangi jalur injeksi script, bukan bukti
  bahwa perangkat atau lokasi fisik tepercaya.

Snapshot pascadeploy 23 Juli 2026:

- Hosting live version `b36deec30214780e`; 16 file publik, hash index,
  JavaScript, CSS, dan service worker live cocok byte-for-byte dengan build
  lokal.
- Sebelas Functions `ACTIVE`, Node 22, runtime service account khusus, dan satu
  source hash `68eb9492ca3d99b36371156687220acd448b085f`.
- Firestore/Storage rules live cocok byte-for-byte dengan source lokal; sebelas
  probe callable tanpa autentikasi semuanya ditolak HTTP 401.
- Tiga puluh akun aktif memiliki assignment kanonik. Seluruh 12 geofence tetap
  provisional/nonaktif dan belum memiliki audit dual-control, sehingga flow
  absensi v2 masih fail-closed. Enam record lama tetap legacy/unverified dan
  belum menjadi bukti runtime replay v2.
- Satu user-managed service-account key masih aktif karena konsumennya belum
  dikonfirmasi. Jangan menonaktifkannya hanya berdasarkan asumsi.
- Audit log Firestore `DATA_WRITE` aktif tanpa exemption. Editor pada App Engine
  default account yang tidak terpakai dan Compute default build account telah
  dicabut; deployment sebelas Functions membuktikan grant build yang lebih
  sempit tetap cukup. Lima principal IAM masih dapat menulis Firestore mentah
  dan tetap berada di dalam trust boundary proyek.
- Audit dependency frontend dan Functions melaporkan 0 vulnerability. Advisory
  `uuid` moderate pada dependency Firebase/Google Storage ditutup dengan
  override `uuid@11.1.1` yang sengaja dibatasi pada `gaxios@6.7.1` dan
  `teeny-request@9.0.0`. Kedua caller hanya memakai `v4()` dan telah diuji pada
  Node 22, termasuk pemuatan seluruh export Function. Jangan menggantinya
  dengan override global atau `npm audit fix --force`; evaluasi ulang saat
  versi caller berubah dan hapus override bila upstream sudah memperbaikinya.

Jangan mengganti status ini menjadi “aman dari fake GPS”. Dua pihak yang
berkolusi dan memalsukan lokasi admin serta pegawai masih dapat memenuhi
kontrol aplikasi web. Assurance yang lebih tinggi memerlukan aplikasi native,
attestation perangkat, sinyal mock-location, dan liveness yang terikat
challenge server; perangkat yang dikompromikan tetap menjadi residual risk.

## Kontrol yang benar-benar diterapkan

### Challenge, lokasi, dan co-presence

1. Server membuat challenge sekali pakai untuk aksi dan pegawai tertentu.
2. Foto JPEG diunggah hanya ke path challenge yang diizinkan dan diverifikasi
   kembali berdasarkan generation, checksum, metadata, ukuran, dimensi, serta
   freshness sebelum transaksi absensi.
3. Admin meminta kode onsite berumur pendek sambil mengirim lokasi admin yang
   fresh dan cukup akurat. Server memastikan admin aktif dan berada di dalam
   geofence yang telah diaudit.
4. Saat submit, server memvalidasi ulang lokasi pegawai, lokasi admin, kode,
   assignment, waktu, akurasi, radius, dan audit geofence. Batas radius memakai
   `jarak + akurasi <= radius`.
   Waktu freshness/expiry diambil ulang pada setiap percobaan transaksi setelah
   download dan decode foto, sehingga proses I/O tidak memperpanjang challenge.
5. Co-presence diterima hanya bila jarak pegawai–admin yang sudah ditambah
   ketidakpastian kedua pembacaan tidak lebih dari 100 meter. Bukti dan batas
   ini disimpan pada snapshot absensi.
6. Challenge, grant kode onsite, lock, indeks exact, audit perceptual, state
   replay per UID, pointer shift, dan absensi dikonsumsi/dibuat secara
   transaksional sehingga replay atau balapan submit gagal tertutup.

Co-presence mencegah penggunaan kode jarak jauh secara sederhana. Ia tetap
bergantung pada dua pembacaan GPS klien dan karena itu tidak menutup kolusi atau
fake GPS pada kedua perangkat.

### Foto dan deteksi replay

- Exact SHA-256 menolak byte foto yang sudah pernah dipakai.
- Detektor perceptual memakai versi `dh144mv2`: delapan view dari empat center
  crop (100%, 96%, 92%, 88%), masing-masing normal dan mirror, lalu membandingkan
  full 144-bit dengan jarak Hamming maksimal enam. Audit immutable schema v3
  memakai document ID SHA-256 dan mengikat UID, aksi, attendance, challenge,
  object generation, versi hash, serta delapan view.
- Near-replay perceptual dibatasi pada UID yang sama dalam rolling window 30
  hari, maksimum 64 bukti aktif. State menyimpan metadata versi/window/limit,
  entry terurut, dan proof ID SHA-256. Exact SHA-256 tetap global dan permanen;
  foto mirip milik UID lain tidak otomatis ditolak.
- Quality gate mengukur rentang luminance, deviasi, highlight/shadow, dan edge
  RMS untuk menolak JPEG kosong, terlalu polos, terlalu gelap/terang, atau minim
  informasi.

### Shift lintas tengah malam dan koreksi check-out

- `attendanceOpenShifts/{uid}` mengikat check-out ke attendance, `workDate`,
  check-in, dan revision shift yang dibuat saat check-in. Pergantian tanggal
  WIB tidak mengubah target; batas durasi dibaca ulang dari
  `projectConfig/default.maxAttendanceShiftDurationMinutes` pada challenge dan
  submit. Nilai produksi saat ini 1.440 menit.
- Pointer tidak dihapus. Check-in berikutnya menaikkan revision, sehingga
  challenge lama, pointer rollback, atau perubahan policy di tengah flow
  ditolak. Test handler penuh mencakup check-out pukul 00:05 WIB, perubahan
  revision, dan policy yang dipersempit.
- Attendance kanonik tetap immutable dari klien maupun admin browser. Check-out
  yang benar-benar hilang hanya dapat diselesaikan lewat proposal dan approval
  dua UID admin aktif yang berbeda. Approval membuat event immutable dan
  effective-view privacy-reduced; ia tidak menulis bukti GPS/selfie palsu ke
  attendance kanonik dan selalu diberi label `manualCorrection: true` serta
  `deviceVerified: false`.
- Saat ini hanya ada satu admin aplikasi aktif. Karena itu koreksi produksi
  sengaja belum operasional sampai admin kedua yang benar-benar independen
  tersedia; jangan melemahkan pemeriksaan ini atau membuat akun bayangan.

Quality gate **bukan** face detection, face matching, atau liveness. Foto lama,
gambar bertekstur, layar lain, maupun virtual camera masih dapat lolos. Uji
red-team juga menunjukkan bahwa rotasi sekitar 3 derajat atau lebih, crop yang
lebih besar/bergeser, dan border besar dapat menghindari `dh144mv2`. Jangan
menaikkan threshold secara membabi buta: pada sampel berlatar sama, threshold
lebih longgar menimbulkan false positive. Perubahan algoritme harus dikalibrasi
dengan corpus selfie nyata dan idealnya memakai alignment/local descriptor atau
embedding serta liveness terikat challenge.

### Telemetry dan privasi log

Event sukses, penolakan, dan error ditulis sebagai structured log. Identitas,
attendance, challenge, dan geofence direpresentasikan dengan fingerprint
SHA-256 terpotong. Log tidak boleh memuat UID mentah, token, kode onsite,
koordinat, nama, alamat akun, atau hash foto. Nilai action dari klien hanya
dicatat jika termasuk allowlist `checkIn`/`checkOut`.

### IAM dan audit write mentah

- `datastore.googleapis.com` `DATA_WRITE` Audit Logs aktif tanpa anggota yang
  dikecualikan. Data Access logs dapat menambah biaya ingest/retensi; `DATA_READ`
  tidak diaktifkan oleh hardening ini.
- Jumlah principal yang memiliki permission mutasi Firestore turun dari tujuh
  menjadi lima. Yang tersisa adalah runtime absensi, dua service identity
  Firebase/Google, Firebase Admin SDK project account, dan satu human Project
  Owner. Mereka tetap dapat melewati Security Rules/callable dan harus dianggap
  root trust, bukan bukti bahwa workflow mustahil dibypass.
- App Engine default account yang tidak mempunyai workload kehilangan
  `roles/editor`. Compute default build account juga kehilangan `roles/editor`
  dan hanya mendapat log writer pada project, Artifact Registry writer pada
  repository Functions Jakarta, serta object viewer pada dua bucket build.
  Deployment produksi sebelas Functions berhasil dengan grant ini.
- Satu key user-managed Firebase Admin SDK masih aktif dan pernah terlihat
  membuat ruleset. Nonaktifkan hanya setelah pemilik job/workstation memastikan
  tidak ada konsumen. Nol log bukan bukti key tidak dipakai.

Status dan jalur recovery dapat diperiksa tanpa menulis:

```sh
npm run harden:functions-build-iam -- --action=status
npm run manage:app-engine-editor -- --action=status
npm run audit:service-account-keys
```

Jika perubahan platform membuat build Function gagal karena permission, restore
sementara Editor build account dengan konfirmasi eksplisit, lalu audit ulang:

```sh
npm run harden:functions-build-iam -- \
  --action=restore-editor \
  --apply \
  --confirm-build-iam=RESTORE_COMPUTE_DEFAULT_EDITOR
```

Recovery App Engine default account, hanya bila workload App Engine memang
dibuat dan membutuhkan account tersebut:

```sh
npm run manage:app-engine-editor -- \
  --action=restore \
  --apply \
  --confirm-app-engine-editor=RESTORE_APP_ENGINE_DEFAULT_EDITOR
```

## Gate lokal sebelum deployment

Jalankan dari root repo:

```sh
npm --prefix functions test
npm --prefix functions run lint
npm test
npm run lint
npm run build
npm run test:security-rules
npm run test:replay-transaction
git diff --check
```

`test:replay-transaction` menjalankan Firestore Emulator dan memaksa dua
reservasi near-replay konkuren. Hanya satu transaksi boleh commit; transaksi
lain harus retry lalu ditolak sebagai replay. Test menolak berjalan jika
`FIRESTORE_EMULATOR_HOST` tidak tersedia dan memerlukan Java untuk emulator.
Ia tidak pernah diarahkan ke production.

Rules juga dapat dikompilasi tanpa deploy:

```sh
npx firebase deploy --only firestore:rules,storage --dry-run
```

## Aktivasi geofence dengan dual control

Workflow terdiri dari dua fase di tab **Admin → Verifikasi Geofence**. Proposer
dan reviewer wajib memakai dua akun admin aplikasi aktif yang berbeda, tidak
sedang memakai password sementara, dan secara operasional harus dikuasai dua
petugas berbeda. Kedua callable memerlukan Firebase Auth, App Check, serta token
limited-use.

Ini adalah dual-control pada workflow, bukan batas kriptografis terhadap
Project Owner atau principal IAM lain yang bisa menulis Firestore secara
langsung. Dua UID juga tidak membuktikan dua manusia. Batasi akses tulis mentah,
gunakan dua pemegang akun yang benar-benar berbeda, dan tinjau Cloud Audit Logs.
GPS browser kedua admin tetap dapat dipalsukan.

### Fase 1 — proposer survei fisik

1. Login ke aplikasi sebagai admin proposer dan buka tab **Verifikasi Geofence**.
2. Pilih dokumen kelurahan/kantor yang benar. Jangan mengaktifkan marker seed
   hanya karena tampak masuk akal pada peta.
3. Dari lokasi fisik, gunakan pembacaan GPS baru sebagai pusat atau masukkan
   hasil survei, lalu isi radius maksimal 500 meter.
4. Kirim proposal. Server memvalidasi admin, freshness/sumber/akurasi GPS, serta
   `jarak + akurasi <= radius`; membaca versi geofence saat ini; lalu membuat
   proposal fingerprint-bound, TTL 24 jam, rate limit, dan satu lock pending per
   geofence. Geofence belum aktif.

### Fase 2 — reviewer independen

1. Petugas kedua login dengan akun admin aplikasi lain, idealnya pada perangkat
   lain, dan berada di lokasi fisik yang diusulkan.
2. Buka proposal pending, bandingkan pusat/radius dengan kondisi lapangan, lalu
   pilih **Setujui** atau **Tolak**. Kedua keputusan meminta pembacaan GPS baru.
3. Server menolak UID yang sama, proposal kedaluwarsa/tampered, lock tidak cocok,
   proposer yang tidak lagi aktif saat approval, geofence yang berubah sejak
   proposal, atau reviewer di luar radius setelah margin akurasi.
4. Approval membuat audit privat immutable dan mengaktifkan geofence dalam satu
   transaksi. Reject menutup proposal/lock dan membuat audit reject tanpa
   mengubah geofence.

Saat snapshot ini dibuat hanya ada satu akun admin aplikasi aktif. Workflow
produksi belum dapat diselesaikan sampai pemilik proyek mem-bootstrap akun admin
kedua dengan identitas petugas yang berbeda melalui prosedur root tepercaya.
Jangan membuat akun bayangan hanya untuk melewati pemeriksaan dua UID.

Workflow Firebase CLI lama sudah dipensiunkan. `scripts/verify-geofence.mjs`
masih dapat dipakai untuk forensik read-only, tetapi setiap `--apply` sekarang
gagal sebelum melakukan write. Jangan memberi reviewer `roles/datastore.user`
atau peran IAM serupa; itu justru membuat jalur bypass baru.

## Mode operasional sementara GPS + foto

`location_photo` adalah fallback operasional yang sengaja lebih lemah daripada
`geofence_onsite`. Gunakan hanya bila absensi harus tetap berjalan sementara
geofence atau petugas onsite belum tersedia, dengan persetujuan pemilik risiko
dan durasi sesingkat mungkin. Skrip dan backend menolak durasi kurang dari satu
jam atau lebih dari **168 jam (tujuh hari)**. Jangan memperpanjangnya berulang
kali untuk menjadikannya mode permanen.

Kontrol yang tetap berlaku adalah Auth, App Check callable, akun aktif,
assignment canonical dengan dokumen lokasi yang tersedia,
challenge sekali pakai, selfie JPEG terikat challenge, quality/replay checks,
GPS browser yang fresh dan cukup akurat, timestamp server, rate limit, serta
pointer shift. Yang tidak dibuktikan adalah posisi terhadap geofence yang telah
diaudit, kode onsite, lokasi admin, co-presence, integritas sensor, dan liveness.
Karena itu GPS masih dapat dipalsukan dan foto layar/virtual camera tetap
menjadi residual risk.

Label keamanan wajib pada UI, laporan, ekspor, dan komunikasi operasional:

> **Mode operasional sementara — GPS + foto; geofence dan keberadaan onsite
> tidak terverifikasi; GPS browser dapat dipalsukan; bukan Verified v2 atau
> device-verified.**

Record memakai `verificationMode: location_photo`,
`verificationStatus: location_photo_only`, `transitionMode: true`,
`isWithinRadius: null`, dan `deviceVerified: false`. Jangan menamainya
“Verified v2”, “dalam radius”, “onsite terverifikasi”, atau memasukkannya ke
metrik/payroll yang mensyaratkan `isCompletedVerifiedAttendance`. Jam kerja
boleh ditampilkan sebagai catatan operasional bila kedua aksi lengkap, tetapi
harus tetap dipisahkan dari assurance geofence.

Jangan jalankan ulang `scripts/migrate-attendance-security.mjs` setelah record
`location_photo` terbentuk. Skrip tersebut sekarang berhenti fail-closed pada
preflight; gunakan `scripts/audit-security-state.mjs` untuk pemeriksaan
read-only.

### Prasyarat dan aktivasi

Aktivasi adalah write langsung ke `projectConfig/default`, bukan deployment
kode. Gunakan maintenance window sebelum check-in dimulai. Pastikan:

1. release Functions, client, rules, dan label laporan yang memahami
   `location_photo` sudah terpasang dan gate lokal telah lulus;
2. `attendanceSecurityVersion` bernilai `2` dan
   `geofenceTransitionMode` bernilai `false`;
3. audit menunjukkan `attendanceOpenShifts.open` bernilai `0`, tidak ada
   challenge yang sedang dipakai, dan pengguna sudah diminta me-refresh
   aplikasi; serta
4. tiket perubahan mencatat alasan, operator, durasi, waktu mulai/berakhir,
   dan rencana revert. Identitas Firebase CLI harus merupakan operator
   berwenang dan aktivitasnya ditinjau di Cloud Audit Logs.

Periksa state produksi secara read-only dan login CLI bila diperlukan:

```sh
node scripts/audit-security-state.mjs
npx firebase login
```

Selalu sebutkan mode dan durasi secara eksplisit. Contoh window 24 jam:

```sh
# Preview; tidak menulis.
npm run configure:attendance-mode -- \
  --mode=location_photo \
  --duration-hours=24

# Apply setelah preview dan tiket disetujui.
npm run configure:attendance-mode -- \
  --mode=location_photo \
  --duration-hours=24 \
  --apply
```

Invocation `--apply` membuat timestamp mulai/berakhir baru, lalu memakai
precondition `updateTime` dan membaca ulang dokumen. Salin blok `confirmed`
dari output apply ke tiket dan pastikan selisih
`locationPhotoModeExpiresAt - locationPhotoModeEnabledAt` sama dengan durasi
yang disetujui serta tidak lebih dari 168 jam. Jika state berubah konkuren atau
verifikasi pascatulis gagal, hentikan operasi; jangan menulis field ini manual
melalui Console.

Ganti `24` hanya dengan bilangan bulat `1..168`; nilai `168` adalah batas
darurat, bukan default operasional. Setiap aktivasi atau perpanjangan baru
memerlukan review risiko dan tiket baru.

Pergantian mode membuat challenge lama gagal dengan
`ATTENDANCE_POLICY_CHANGED`. Pengguna harus me-refresh dan mengambil challenge
serta selfie baru setelah aktivasi.

### Daftar lokasi operasional sementara (allow-list)

Mode `location_photo` dapat membatasi GPS ke lokasi yang dideklarasikan
operator. Daftar disimpan di `projectConfig/default` sebagai:

- `locationPhotoAllowedLocations` — array `{ id, nama, lat, lng, radius,
  validFrom, validUntil }`
- `locationPhotoAllowedLocationsVersion` — naik tiap penulisan
- `locationPhotoAllowedLocationsDigest` — SHA-256 daftar ternormalisasi

Saat submit, kandidat bersifat **aditif**: lokasi penugasan pengguna (koordinat
dari dokumen `kelurahan`/`kantor`, termasuk provisional) **ditambah** entri
sementara yang jendelanya mencakup waktu server. Cukup satu kandidat yang
memenuhi `jarak + akurasi <= radius`. Penolakan memakai alasan
`OUTSIDE_OPERATIONAL_LOCATION`.

Assurance tetap jujur:

- koordinat venue adalah deklarasi operator (OpenStreetMap / dokumen proyek),
  **bukan** geofence dual-control yang diaudit di lapangan;
- tidak ada kode onsite maupun co-presence admin–pegawai;
- record tetap `verificationStatus: location_photo_only`,
  `transitionMode: true`, `isWithinRadius: null`, `deviceVerified: false`;
- bukti kecocokan ditulis ke `operationalLocationSnapshot` /
  `checkOutOperationalLocationSnapshot`, bukan ke `geofenceSnapshot`.

Master data kode: `src/data/temporaryAttendanceLocations.js`. Contoh BimTek
28–31 Juli 2026 di The ZHM Premiere Padang
(`-0.9546883, 100.3643174`, radius 150 m).

```sh
# Preview daftar lokasi; tidak menulis.
npm run configure:attendance-locations

# Apply setelah review.
npm run configure:attendance-locations -- --apply

# Hapus daftar setelah kegiatan selesai.
npm run configure:attendance-locations -- --clear --apply
```

Deploy Functions (`createAttendanceChallenge`, `submitAttendance`) dan release
client yang memahami `allowedLocations` wajib selesai sebelum `--apply`.
Challenge lama tanpa snapshot version/digest gagal `CHALLENGE_POLICY_INVALID`
atau `ATTENDANCE_POLICY_CHANGED`; pengguna harus me-refresh.

Untuk BimTek 28–31 Juli 2026, setelah apply lokasi, perpanjang juga jendela
mode agar mencakup seluruh kegiatan (durasi dihitung saat apply, maksimum 168
jam), misalnya dari 27 Juli 09:00 WIB selama 112 jam sampai sekitar 1 Agustus
01:00 WIB.

### Prosedur check-in

1. Pegawai me-refresh release client dan memastikan banner amber
   **“Mode operasional sementara — GPS + foto”** terlihat. Jika UI menampilkan
   Verified v2 atau meminta kode onsite, hentikan proses karena client/challenge
   tidak sesuai policy.
2. Pastikan tidak ada shift sebelumnya yang masih terbuka. Aktifkan GPS dan
   kamera, tunggu akurasi diterima aplikasi, pastikan berada di lokasi
   penugasan atau venue sementara yang diizinkan, lalu ambil selfie baru
   langsung melalui release client untuk challenge check-in; jangan memakai
   file lama. Backend mengikat dan memeriksa replay foto, tetapi tidak
   membuktikan liveness atau mencegah client/perangkat yang dimodifikasi. Mode
   tidak boleh dijalankan tanpa GPS.
3. Submit satu kali. Bila hasil jaringan tidak pasti, refresh status terlebih
   dahulu; jangan membuat check-in kedua.
4. Konfirmasi tanggal/jam server, label **GPS + foto sementara**, nama lokasi
   operasional yang cocok (bila ada), dan shift aktif. Titik dan
   `operationalLocationSnapshot` dapat ditampilkan untuk audit, tetapi bukan
   bukti geofence dual-control.

### Prosedur check-out, expiry, dan shift lintas hari

1. Selesaikan shift yang sama dari dashboard; bila shift dimulai pada tanggal
   WIB sebelumnya, gunakan target shift aktif tersebut dan jangan membuat
   check-in baru.
2. Ambil challenge check-out baru, GPS baru, dan selfie baru. Selesaikan
   sebelum `locationPhotoModeExpiresAt` bila memungkinkan dan selalu sebelum
   batas `maxAttendanceShiftDurationMinutes`.
3. Setelah expiry, server menolak check-in baru. Hanya checkout untuk shift
   yang memang check-in dalam `location_photo` yang mendapat grace terbatas
   sampai maksimum durasi shift. Grace ini hanya bekerja selama konfigurasi
   masih `location_photo`; karena itu jangan melakukan revert normal ketika
   masih ada shift sementara yang terbuka.
4. Setelah submit, konfirmasi timestamp checkout lengkap, work hours
   operasional, label `location_photo_only`, serta pointer shift berstatus
   closed dengan sumber `location-photo-checkout`.
5. Shift yang melewati batas durasi tidak boleh diperbaiki dengan edit
   Firestore. Gunakan proposal koreksi missing-checkout dan approval admin kedua
   yang independen; hasilnya tetap berlabel koreksi administratif dan bukan
   checkout GPS/selfie terverifikasi.

### Revert terjadwal dan penghentian darurat

Expiry menghentikan check-in baru secara fail-closed, tetapi tidak mengubah
field mode menjadi `geofence_onsite` secara otomatis. Setelah seluruh shift
sementara selesai dan audit kembali menunjukkan
`attendanceOpenShifts.open: 0`, pastikan geofence target sudah aktif/audited
dan petugas onsite tersedia, lalu jalankan preview dan apply:

```sh
# Preview revert; tidak menulis.
npm run configure:attendance-mode -- --mode=geofence_onsite

# Revert.
npm run configure:attendance-mode -- \
  --mode=geofence_onsite \
  --apply
```

Periksa blok `confirmed`, jalankan ulang audit, minta seluruh pengguna
me-refresh, lalu pastikan challenge baru kembali meminta geofence audited dan
kode onsite. Historical `location_photo_only` harus tetap diberi label
sementara; revert tidak mengubah atau “meningkatkan” assurance record lama.

Jika mode harus dihentikan segera karena dugaan penyalahgunaan, jangan paksa
revert ketika masih ada shift terbuka. Hentikan check-in baru, tetapi
pertahankan grace check-out untuk shift yang sudah dimulai:

```sh
# Preview penghentian darurat; tidak menulis.
npm run configure:attendance-mode -- \
  --mode=location_photo \
  --stop-new-checkins

# Apply setelah preview.
npm run configure:attendance-mode -- \
  --mode=location_photo \
  --stop-new-checkins \
  --apply
```

Perubahan expiry membuat challenge lama gagal dan harus dimulai ulang.
Check-in baru ditolak fail-closed, sedangkan shift `location_photo` yang sudah
terbuka tetap dapat check-out dalam grace maksimum durasi shift. Setelah tidak
ada shift terbuka, lakukan revert normal ke `geofence_onsite`. Jangan
mencampur mode check-in/check-out atau mengedit attendance/pointer mentah.

Smoke verifier di bagian berikut sengaja hanya menerima alur kuat
`geofence_onsite`. Record `location_photo_only` tidak boleh dipakai sebagai
evidence smoke `PASS` atau sebagai alasan mengaktifkan enforcement App Check.

## Smoke test perangkat nyata

Smoke verifier bersifat read-only dan tidak mengunduh foto. Gunakan satu akun
pegawai uji yang assignment-nya menunjuk ke geofence aktif hasil dual control.
Pointer shift mendukung check-out lintas tengah malam; `workDate` tetap tanggal
check-in dan kedua challenge wajib mengikat revision pointer yang sama.

### 1. Preflight

```sh
npm run verify:attendance-smoke -- \
  --phase=preflight \
  --employee-uid=UID_AKUN_UJI \
  --collection=kelurahan \
  --geofence-id=ID_GEOFENCE
```

Preflight memastikan belum ada absensi hari itu atau shift yang masih terbuka,
kapasitas rate limit cukup, geofence/audit valid, policy v2 aktif, tepat sebelas
Functions sesuai runtime dan
service account yang diwajibkan, local/deployed rules cocok, serta Firestore dan
Storage masih `UNENFORCED`. Ia juga mencocokkan rilis Hosting live, konfigurasi
header/rewrites, seluruh manifest, ETag, dan byte file terhadap `dist` lokal.
Simpan nilai `startedAt` persis dari output.

### 2. Check-in dan observasi pointer open

Sesudah preflight `PASS`, lakukan check-in nyata melalui release client yang
sedang diuji. Sebelum check-out, jalankan:

```sh
npm run verify:attendance-smoke -- \
  --phase=checkin \
  --employee-uid=UID_AKUN_UJI \
  --started-at=TIMESTAMP_RFC3339_DARI_PREFLIGHT \
  --report=.firebase/attendance-smoke-checkin-release.json
```

Phase ini harus menghasilkan `READY_FOR_CHECKOUT`. Ia mengobservasi
`attendanceOpenShifts/{uid}` saat benar-benar berstatus `open`, lalu memeriksa
attendance check-in, challenge target `workDate`/revision, object generation,
exact hash, audit perceptual schema v3, dan entry rolling-state saat itu. Report
dibuat mode `0600` dan wajib disimpan untuk phase final.

### 3. Check-out lapangan

Baru setelah phase check-in `PASS`, lakukan check-out nyata dengan kamera,
lokasi pegawai, dan admin onsite yang sebenarnya. Check-out boleh melewati
tengah malam selama masih dalam batas durasi shift yang dikonfigurasi.

### 4. Verify final dan report

```sh
npm run verify:attendance-smoke -- \
  --phase=verify \
  --employee-uid=UID_AKUN_UJI \
  --started-at=TIMESTAMP_RFC3339_DARI_PREFLIGHT \
  --checkin-report=.firebase/attendance-smoke-checkin-release.json \
  --report=.firebase/attendance-smoke-release.json
```

Verify memeriksa 13 invariant, termasuk dua challenge/grant/lock yang berbeda,
binding geofence/generation/window waktunya, co-presence, objek Storage
immutable tanpa mengunduh isi bukti foto, exact hash global, audit perceptual
SHA-keyed, rolling-state per UID, bukti pointer `open` dari report intermediate
dan pointer `closed` final, binding
rilis/konfigurasi/seluruh artefak Hosting, serta structured success telemetry
yang terikat ke dua challenge. Metrik App Check `VALID/ALLOW`
Firestore dan Storage bersifat agregat Web App pada window pengujian, bukan
bukti per-request; karena itu jalankan smoke dalam window terkontrol dan tinjau
trafik lain. Exit code `0` berarti `PASS`, `2` berarti `FAIL`, dan `3` berarti
`INCONCLUSIVE`. Report dibuat sebagai file baru mode `0600`; jangan menaruhnya
di lokasi bersama atau commit ke git. Gate saat ini hanya menerima schema
report v3; report lama harus dibuat ulang.

## Enforcement App Check

Tetap gunakan monitoring sampai report verify berstatus `PASS`. Preview
`UNENFORCED` tidak memerlukan smoke report:

```sh
npm run configure:app-check -- --mode=UNENFORCED
```

Untuk **setiap** preview maupun apply `ENFORCED`, `--smoke-report` wajib:

```sh
npm run configure:app-check -- \
  --mode=ENFORCED \
  --smoke-report=.firebase/attendance-smoke-release.json

npm run configure:app-check -- \
  --mode=ENFORCED \
  --smoke-report=.firebase/attendance-smoke-release.json \
  --apply \
  --confirm-production-enforcement=VALID_TOKENS_VERIFIED
```

Gate menolak report lama, berubah, tidak aman, bukan milik operator, tidak
memiliki tepat 13 check `PASS`, tidak mencakup check-in/check-out, atau tidak
didukung metrik live kedua service. Gate juga memeriksa ulang site key provider,
evidence report intermediate check-in, exact/perceptual/rolling replay,
set/runtime/source Functions, source rules, serta versi, konfigurasi, manifest,
ETag, CSP, dan byte seluruh artefak Hosting terhadap report dan repo tepat
sebelum perubahan. Pembacaan channel sebelum/sesudah menolak deployment yang
berubah di tengah verifikasi. Digest report mendeteksi perubahan file; ia bukan
tanda tangan otorisasi. Jika perubahan service kedua atau post-verify gagal,
skrip mencoba compensating rollback ke snapshot awal; perubahan dua API service
ini bukan transaksi atomik lintas service.

Rollback eksplisit ke monitoring juga fail-closed dan memerlukan mode serta
konfirmasi penuh; `--apply=false`, flag bernilai, duplikat, dan argumen asing
ditolak:

```sh
npm run configure:app-check -- \
  --mode=UNENFORCED \
  --apply \
  --confirm-production-monitoring=MONITORING_MODE_CONFIRMED
```

Enforcement Firestore/Storage memengaruhi seluruh klien, bukan hanya absensi.
Callable tetap harus memvalidasi Auth, App Check, account/assignment, challenge,
foto, lokasi, geofence, co-presence, waktu, rate limit, dan replay walaupun token
App Check valid.

## Urutan deployment dan verifikasi

1. Luluskan seluruh gate lokal di atas.
2. Audit state production secara read-only:

   ```sh
   node scripts/audit-security-state.mjs
   ```

3. Deploy hanya komponen yang berubah. Jangan menyalakan App Check data-service
   pada deployment kode ini.
4. Ulangi audit, negative probes, dan pemeriksaan CSP/asset sesudah deploy.
5. Aktifkan minimal satu geofence melalui dual control dua akun.
6. Jalankan preflight, check-in, check-out, verify, dan periksa report.
7. Baru pertimbangkan `ENFORCED` bila report `PASS` dan metrik live kedua
   service mendukungnya. Jika salah satu bukti belum ada, pertahankan
   `UNENFORCED`.

Negative test pascadeploy minimal mencakup write attendance langsung, challenge
kedaluwarsa/replay, metadata atau object generation salah, overwrite/delete
foto, akun/geofence nonaktif, lokasi stale/tidak akurat/di luar radius, kode
onsite salah, admin di luar geofence, dan co-presence lebih dari batas. Semua
harus ditolak.

## Service-account key

Inventarisasi pemakaian key sebelum menonaktifkannya:

```sh
npm run audit:service-account-keys
npm run manage:service-account-key -- --action=status --key-id=KEY_ID
```

Disable bersifat eksplisit dan satu key setiap kali:

```sh
npm run manage:service-account-key -- \
  --action=disable \
  --key-id=KEY_ID \
  --apply \
  --confirm-key-operation=DISABLE_KEY_ID
```

Jangan disable atau delete key yang konsumennya belum diinventarisasi. Prioritas
migrasi adalah attached service account/Application Default Credentials untuk
workload Google-hosted dan Workload Identity Federation untuk CI eksternal.
