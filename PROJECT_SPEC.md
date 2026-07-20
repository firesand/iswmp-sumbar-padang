# ISWMP SumBar-Padang — Project Specification

**Versi:** 0.1.0 (Draft)  
**Tanggal:** Juli 2026  
**Base project:** Surya Abadi Connecteam

---

## 1. Latar Belakang

Proyek ISWMP (Integrated Solid Waste Management Project) di Provinsi Sumatera Barat, Kota Padang, membutuhkan sistem absensi untuk memverifikasi kehadiran tim di lapangan dan kantor.

Sistem absensi berfungsi sebagai **crosscheck kehadiran**, bukan pengganti sistem HR atau payroll.

---

## 2. Ruang Lingkup Geografis

| Wilayah | Jumlah lokasi | Status koordinat |
|---------|---------------|------------------|
| 11 Kelurahan (Kota Padang) | 11 titik geofence | Belum diinput |
| Kantor Kota Padang | 1 titik geofence | **Belum ditentukan** |

---

## 3. Pengguna Sistem

### 3.1 Tim Lapangan — 22 orang

Penugasan: **2 tenaga ahli per kelurahan** × 11 kelurahan.

| Jenis Tenaga Ahli | Kode | Per kelurahan |
|-------------------|------|---------------|
| Tenaga Pendamping Persampahan | `TA_PERSAMP` | 1 |
| Tenaga Ahli Kelembagaan | `TA_KELEMBAGAAN` | 1 |

- Absensi di **kelurahan penugasan** masing-masing
- Validasi GPS terhadap geofence kelurahan yang ditetapkan

### 3.2 Tim Kantor Kota Padang — 4 orang

Berkantor di Kota Padang. **Lokasi kantor belum ditentukan** — geofence akan dikonfigurasi setelah koordinat tersedia.

| Peran | Kode | Jumlah | Keterangan |
|-------|------|--------|------------|
| Koordinator Kota | `KORKOT` | 1 | Koordinasi operasional di tingkat kota |
| Asisten Manajemen Data | `ASMAN_DATA` | 1 | Pengelolaan data proyek |
| Operator | `OPERATOR` | 2 | Operasional kantor |
| Office Boy | `OFFICE_BOY` | 1 | Dukungan operasional kantor |

- Absensi di **kantor kota Padang** (satu geofence, setelah koordinat ditentukan)
- Peran berbeda, lokasi absensi sama

### 3.3 Admin Sistem

| Peran | Estimasi | Akses |
|-------|----------|-------|
| Super Admin / Admin Proyek | 1–2 | Full dashboard, kelola user, laporan |

**Total estimasi user aktif: 26–28 orang**

---

## 4. Perbedaan dengan Surya Abadi Connecteam

| Aspek | Surya Abadi | ISWMP SumBar-Padang |
|-------|-------------|---------------------|
| Lokasi absensi | 1 kantor (Depok) | 11 kelurahan + 1 kantor kota |
| Validasi GPS | Single geofence | Multi-geofence per penugasan |
| Peran user | Admin / Employee | Admin, TA Lapangan, Tim Kantor |
| Field `department` | Bebas input | `jenisTenagaAhli` / `peranKantor` |
| Field lokasi | Env single office | `kelurahanId` atau `kantorKotaId` |
| Payroll | Ada | **Tidak diperlukan** |
| Cuti / BPJS | Ada | **Tidak diperlukan** (fase awal) |
| Update lokasi 4x/hari | Ada | **Tidak diperlukan** |
| Tujuan | HR internal | Crosscheck kehadiran proyek |

---

## 5. Fitur yang Dipertahankan (dari parent)

- [x] Login / registrasi dengan approval admin
- [x] Absensi check-in (+ check-out opsional) dengan GPS
- [x] Foto selfie saat absensi
- [x] Dashboard admin dengan statistik harian
- [x] Laporan bulanan + export Excel
- [x] Notifikasi (WhatsApp / email) — opsional
- [x] PWA / mobile-friendly
- [x] Reset password

---

## 6. Fitur Baru / Adaptasi

### 6.1 Multi-lokasi geofence

- Koleksi `kelurahan` — 11 record
- Koleksi `kantor` — 1 record (Kantor Kota Padang, koordinat TBD)
- User ditautkan ke **satu lokasi absensi** via `assignmentType`:
  - `kelurahan` → `kelurahanId`
  - `kantor` → `kantorId`

### 6.2 Validasi absensi

```
IF user.assignmentType == 'kelurahan'
  → validasi GPS terhadap koordinat kelurahan penugasan
IF user.assignmentType == 'kantor'
  → validasi GPS terhadap koordinat kantor kota
```

### 6.3 Dashboard admin — matriks kehadiran

**Panel Kelurahan (11 × 2):**

```
Kelurahan          | TA Persampahan | TA Kelembagaan
-------------------|----------------|----------------
[Kelurahan 1]      | ✅ / ❌ / ⏳   | ✅ / ❌ / ⏳
...
[Kelurahan 11]     | ✅ / ❌ / ⏳   | ✅ / ❌ / ⏳
```

**Panel Kantor Kota (4 orang):**

```
Peran                  | Kehadiran hari ini
-----------------------|-------------------
Koordinator Kota       | ✅ / ❌ / ⏳
Asisten Manajemen Data | ✅ / ❌ / ⏳
Operator 1             | ✅ / ❌ / ⏳
Operator 2             | ✅ / ❌ / ⏳
```

### 6.4 Filter & laporan

- Filter per kelurahan, per jenis TA, per peran kantor
- Export Excel: rekap harian / bulanan per kelurahan
- Alert: belum absen setelah jam batas (konfigurasi)

---

## 7. Konfigurasi yang Dibutuhkan

```bash
# Firebase (project terpisah)
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=

# Proyek
VITE_PROJECT_NAME=ISWMP SumBar-Padang
VITE_PROJECT_REGION=Sumatera Barat
VITE_PROJECT_CITY=Padang

# Kantor Kota Padang (TBD — isi setelah koordinat ditentukan)
VITE_KANTOR_KOTA_LAT=
VITE_KANTOR_KOTA_LNG=
VITE_KANTOR_KOTA_RADIUS=200

# Jam kerja
VITE_WORK_START_HOUR=8
VITE_WORK_START_MINUTE=0
VITE_LATE_THRESHOLD_MINUTES=15

# EmailJS (opsional)
VITE_EMAILJS_PUBLIC_KEY=
VITE_EMAILJS_SERVICE_ID=
VITE_EMAILJS_TEMPLATE_ID=
```

Koordinat 11 kelurahan disimpan di Firestore (`kelurahan` collection), bukan env vars.

---

## 8. Informasi yang Masih Dibutuhkan

| Item | Status |
|------|--------|
| Daftar 11 kelurahan (nama + kecamatan) | ✅ Dikonfirmasi — 11 kelurahan, 5 kecamatan |
| Koordinat GPS per kelurahan | 🟡 Marker kantor Google Maps tersedia; menunggu verifikasi lapangan |
| Koordinat kantor kota Padang | ⏳ **Belum ditentukan** |
| Radius geofence per lokasi | ⏳ Perlu kalibrasi lapangan |
| Jam absensi resmi proyek | ⏳ Menunggu konfirmasi |
| Nama resmi proyek untuk branding UI | ⏳ ISWMP SumBar-Padang (draft) |
| Metode registrasi (admin buat vs self-register) | ⏳ Menunggu keputusan |

---

## 9. Tech Stack (rencana)

Sama dengan parent project:

- React + Vite + Tailwind CSS
- Firebase Auth + Firestore + Storage
- Vercel hosting
- PWA

---

## 10. Kapasitas

| Metrik | Estimasi |
|--------|----------|
| User aktif | 26–28 |
| Absensi/hari | ~26 record |
| Absensi/bulan | ~520 record |
| Firebase free tier | Lebih dari cukup |
