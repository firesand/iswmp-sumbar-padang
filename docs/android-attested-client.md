# Runbook client Android attested

Aplikasi web dapat mengukur **bentuk** sinyal GPS, tetapi tidak dapat membaca
flag mock-location milik sistem operasi. Satu-satunya lompatan kelas terhadap
Fake GPS adalah aplikasi Android terinstal: `Location.isMock()` di tingkat OS
plus attestation Play Integrity lewat App Check.

Runbook ini melengkapi `docs/attendance-security-deployment.md` bagian
“Pemeriksaan sidik sinyal GPS”. Backend-nya **sudah terpasang dan teruji**; yang
belum adalah aplikasi Androidnya dan pendaftaran platformnya.

## Status

| Komponen | Status |
| --- | --- |
| Kontrak `deviceIntegrity` + verifikasi server | ✅ `functions/gps-integrity.js`, teruji |
| Sinyal `OS_MOCK_LOCATION`, `DEVICE_INTEGRITY_UNVERIFIED`, `DEVICE_EVIDENCE_MISSING`, `ATTESTED_APP_REQUIRED` | ✅ teruji unit + handler |
| Jembatan klien web (`src/utils/deviceIntegrity.js`) | ✅ no-op di browser, aktif di wrapper |
| Sumber plugin native | ✅ `android-client/plugin/` |
| Provider App Check native | ✅ sumber tersedia, **belum** dipasang ke `src/config/firebase.js` |
| Proyek Android (`npx cap add android`) | ⬜ belum dibuat |
| Registrasi Android app di Firebase + SHA-256 | ⬜ hanya pemilik proyek |
| Play Console internal testing + Play Integrity | ⬜ hanya pemilik proyek |
| Keystore rilis | ⬜ hanya pemilik proyek |

Proyek Android sengaja belum di-generate di repo ini: ia membutuhkan
`google-services.json` dari registrasi Firebase yang belum ada, sehingga tree
hasil generate tidak akan bisa dibuild dan hanya membebani diff.

## Mengapa jembatan App Check wajib

Di dalam WebView, Firebase JavaScript SDK tetap memakai
`ReCaptchaEnterpriseProvider`. Token yang dihasilkan membawa **application id
web**. Backend memutuskan attestation dari `request.app.appId` terhadap
`gpsIntegrityAttestedAppIds`, jadi tanpa jembatan ini bukti perangkat akan
dianggap `unattested-claim` dan **ditolak** sebagai pemalsuan.

Karena itu wrapper harus meminta token App Check dari Firebase SDK **native**
(terdaftar dengan provider Play Integrity untuk aplikasi Android), lalu
menyuapkannya ke JavaScript SDK lewat `CustomProvider`. Sumbernya ada di
`android-client/plugin/appCheckNativeProvider.js`.

Konsekuensi yang harus diterima secara sadar: interface `CustomProvider` di JS
hanya punya `getToken`, sehingga build wrapper tidak dapat mengirim
*limited-use token*. `limitedUseAppCheckTokens: true` pada `submitAttendance`
turun menjadi token biasa dan replay protection App Check berhenti berkontribusi
di jalur wrapper. Kontrol replay lain — challenge sekali pakai, lock transaksi,
hash foto, digest jejak GPS — tetap berlaku. Menutup celah ini sepenuhnya
memerlukan pemanggilan callable secara native (`@capacitor-firebase/functions`),
yang merupakan refactor terpisah.

## Urutan pembuatan

### 1. Registrasi platform (pemilik proyek)

1. Firebase Console → Project settings → Add app → Android.
   Package name: `id.iswmp.padang.attendance`.
2. Unduh `google-services.json`, simpan ke `android/app/` setelah langkah 2.
   Jangan commit berkas ini bila repo dapat diakses pihak lain.
3. Buat keystore rilis dan simpan di luar repo:

   ```sh
   export JAVA_HOME=/home/edo/Android_iOS_Apps/.tools/jdk-21
   "$JAVA_HOME/bin/keytool" -genkeypair -v \
     -keystore ~/keys/iswmp-padang-release.jks \
     -alias iswmp-padang -keyalg RSA -keysize 4096 -validity 10000
   ```

4. Daftarkan SHA-256 keystore tersebut di Firebase Console. Bila memakai Play
   App Signing, daftarkan juga SHA-256 dari Play Console.
5. Play Console → buat aplikasi → track **Internal testing**, unggah bundle,
   tambahkan 29 pegawai sebagai tester. Play Integrity memerlukan aplikasi
   didistribusikan lewat Play; APK sideload tidak menghasilkan verdict aplikasi
   yang dapat dipercaya.
6. Firebase Console → App Check → aplikasi Android → aktifkan provider **Play
   Integrity**. Biarkan mode monitoring dulu.

### 2. Generate proyek Capacitor

Dari root repo:

```sh
export JAVA_HOME=/home/edo/Android_iOS_Apps/.tools/jdk-21
export ANDROID_HOME=/home/edo/Android_iOS_Apps/.tools/android-sdk
export PATH="$JAVA_HOME/bin:$PATH"

npm install --save-dev @capacitor/cli
npm install @capacitor/core @capacitor/android
cp android-client/capacitor.config.json ./capacitor.config.json
npm run build
npx cap add android
```

Lalu pasang sumber yang sudah disiapkan:

```sh
PKG=android/app/src/main/java/id/iswmp/padang/attendance
mkdir -p "$PKG"
cp android-client/plugin/IswmpLocationIntegrityPlugin.java "$PKG/"
cp android-client/plugin/MainActivity.java "$PKG/"
cp android-client/plugin/appCheckNativeProvider.js src/config/
```

`npx cap add android` membuat `MainActivity.java` sendiri; berkas di atas
menggantikannya karena ia mendaftarkan plugin sebelum `super.onCreate`.

### 3. Dependency dan manifest native

`android/app/build.gradle`:

```gradle
dependencies {
    implementation platform('com.google.firebase:firebase-bom:34.1.0')
    implementation 'com.google.firebase:firebase-appcheck-playintegrity'
}
```

Pastikan plugin `com.google.gms.google-services` aktif (ditambahkan otomatis oleh
Capacitor saat `google-services.json` ada), lalu `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-feature android:name="android.hardware.location.gps" android:required="true" />
```

Jangan menambahkan `QUERY_ALL_PACKAGES`. Tanpa permission itu deteksi aplikasi
mock yang terinstal memang lemah pada Android 11+, dan itu konsekuensi yang
sudah diterima: `mockLocationCapableAppsDetected` hanya sinyal bonus, bukan
bukti tidak ada aplikasi mock.

Inisialisasi App Check native sebelum WebView memuat halaman. Tambahkan di
`Application` class atau di `MainActivity.onCreate` sebelum `super.onCreate`:

```java
FirebaseApp.initializeApp(this);
FirebaseAppCheck.getInstance()
    .installAppCheckProviderFactory(
        PlayIntegrityAppCheckProviderFactory.getInstance());
```

### 4. Pasang provider App Check di web bundle

Ubah `src/config/firebase.js` agar memakai provider hasil resolusi:

```js
import { resolveAppCheckProvider } from './appCheckNativeProvider.js';

export const appCheck = appCheckSiteKey
  ? initializeAppCheck(app, {
      provider: resolveAppCheckProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    })
  : null;
```

Perubahan ini menyentuh attestation **seluruh** panggilan Firebase aplikasi.
Validasi pada build uji lebih dulu: pastikan login, Firestore read, upload
Storage, dan kedua callable absensi tetap berhasil di browser biasa maupun di
wrapper. Jangan deploy web release ini sebelum aplikasi Android terdaftar,
karena di dalam wrapper `resolveAppCheckProvider` akan meminta token native yang
belum ada dan seluruh panggilan akan gagal.

### 5. Build dan uji

```sh
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```

Uji pada perangkat fisik, bukan emulator:

1. Absensi normal harus berhasil dan `gpsIntegrity.platform` pada record menjadi
   `android-app`, `deviceAttested: true`.
2. Aktifkan aplikasi Fake GPS lewat developer options, ulangi absensi. Dalam
   mode `observe` record harus memuat `OS_MOCK_LOCATION`; dalam `enforce`
   absensi harus ditolak `GPS_INTEGRITY_REJECTED`.
3. Cabut izin lokasi aplikasi lalu absen. Bukti perangkat hilang, sehingga
   backend wajib mencatat `DEVICE_EVIDENCE_MISSING` — bukan meloloskannya
   sebagai klien web.
4. Absen dari browser biasa. Record harus `platform: web`, tanpa sinyal device,
   dan tetap diterima selama `gpsIntegrityRequireAttestedApp` belum diaktifkan.

### 6. Aktifkan allowlist attested

Ambil Android application id dari Firebase Console (format
`1:<sender>:android:<hash>`), lalu tulis ke `projectConfig/default`:
`gpsIntegrityAttestedAppIds`. Field ini tidak ditangani
`npm run configure:gps-integrity`; tulis lewat prosedur perubahan config yang
sama seperti field policy lain dan catat di tiket.

Setelah seluruh pegawai memakai aplikasi Android, baru aktifkan
`gpsIntegrityRequireAttestedApp: true`. Sejak titik itu absensi dari browser
ditolak `ATTESTED_APP_REQUIRED`. Jangan mengaktifkannya lebih awal: 29 pegawai
akan terkunci.

## Yang tetap tidak dibuktikan

- Play Integrity membuktikan aplikasi dan perangkat, **bukan** bahwa manusianya
  ada di lokasi. Perangkat root dengan Magisk + modul yang mem-bypass integritas
  tetap menjadi residual risk, dan verdict Play Integrity turun kelas — pantau
  verdict tersebut, jangan berasumsi.
- `Location.isMock()` menangkap mock provider standar Android. Modifikasi
  framework tingkat ROM atau injeksi ke proses aplikasi dapat memalsukan flag
  itu sendiri.
- Ini tetap **bukan** pengganti geofence dual-control. Record yang lolos
  seluruh pemeriksaan ini tetap `location_photo_only` selama geofence belum
  diverifikasi dua petugas. Yang naik adalah keyakinan bahwa koordinatnya
  berasal dari penerima GNSS sungguhan, bukan bahwa titiknya sudah diaudit di
  lapangan.
