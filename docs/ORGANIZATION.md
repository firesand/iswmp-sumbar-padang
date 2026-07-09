# Struktur Organisasi & Peran — ISWMP SumBar-Padang

---

## Ringkasan

| Kategori | Jumlah | Lokasi kerja | Tipe absensi |
|----------|--------|--------------|--------------|
| Tenaga Ahli Lapangan | 22 | 11 kelurahan | Geofence kelurahan |
| Tim Kantor Kota Padang | 4 | Kantor kota *(TBD)* | Geofence kantor |
| Admin Sistem | 1–2 | — | Tidak absen / opsional |
| **Total** | **27–28** | | |

---

## 1. Tenaga Ahli Lapangan (22 orang)

### Penugasan per kelurahan

Setiap kelurahan memiliki **2 tenaga ahli**:

```
Kelurahan [N]
├── Tenaga Pendamping Persampahan  (TA_PERSAMP)      × 1
└── Tenaga Ahli Kelembagaan        (TA_KELEMBAGAAN)  × 1
```

**11 kelurahan × 2 TA = 22 orang**

### Detail peran

| Peran | Kode sistem | Deskripsi |
|-------|-------------|-----------|
| Tenaga Pendamping Persampahan | `TA_PERSAMP` | Pendamping program persampahan di kelurahan |
| Tenaga Ahli Kelembagaan | `TA_KELEMBAGAAN` | Ahli kelembagaan di kelurahan |

### Atribut user (lapangan)

```javascript
{
  role: 'field_staff',
  assignmentType: 'kelurahan',
  kelurahanId: 'kel-xxx',
  kelurahanNama: 'Nama Kelurahan',
  jenisTenagaAhli: 'TA_PERSAMP' | 'TA_KELEMBAGAAN',
  provinsi: 'Sumatera Barat',
  kota: 'Padang'
}
```

### Aturan absensi

- Wajib absen di **kelurahan penugasan** (geofence kelurahan)
- Tidak boleh absen di kelurahan lain
- Foto selfie wajib (crosscheck visual)

---

## 2. Tim Kantor Kota Padang (4 orang)

Berkantor di **Kota Padang**. Lokasi kantor **belum ditentukan** — akan dikonfigurasi sebagai satu geofence setelah koordinat tersedia.

### Daftar peran

| No | Peran | Kode sistem | Jumlah |
|----|-------|-------------|--------|
| 1 | Koordinator Kota (KorKot) | `KORKOT` | 1 |
| 2 | Asisten Manajemen Data | `ASMAN_DATA` | 1 |
| 3 | Operator | `OPERATOR` | 2 |

### Atribut user (kantor)

```javascript
{
  role: 'office_staff',
  assignmentType: 'kantor',
  kantorId: 'kantor-padang-kota',
  peranKantor: 'KORKOT' | 'ASMAN_DATA' | 'OPERATOR',
  provinsi: 'Sumatera Barat',
  kota: 'Padang'
}
```

### Aturan absensi

- Absen di **kantor kota Padang** (satu lokasi untuk ke-4 orang)
- Geofence aktif setelah koordinat kantor ditentukan
- Sementara koordinat belum ada: absensi bisa mode **manual approval** atau **GPS tanpa validasi radius** (fase transisi)

### Catatan peran KorKot

Koordinator Kota kemungkinan juga membutuhkan akses **admin dashboard** untuk monitoring kehadiran seluruh kelurahan. Opsi implementasi:

- **Opsi A:** KorKot = `role: admin` + absensi sebagai office staff
- **Opsi B:** KorKot = `role: office_staff` dengan permission `canViewDashboard: true`

*(Keputusan final menunggu konfirmasi)*

---

## 3. Admin Sistem

| Peran | Kode | Akses |
|-------|------|-------|
| Super Admin | `admin` | Full: kelola user, kelurahan, laporan, approval |

Admin proyek (developer / PM) tidak wajib absen.

---

## 4. Hierarki Akses

```
Super Admin
    │
    ├── KorKot (monitoring + absensi kantor) — akses dashboard?
    │
    ├── Asisten Manajemen Data (absensi kantor + data?)
    │
    ├── 2× Operator (absensi kantor)
    │
    └── 22× Tenaga Ahli Lapangan (absensi kelurahan)
            ├── 11× TA Persampahan
            └── 11× TA Kelembagaan
```

---

## 5. Matriks Lokasi Absensi

| Tipe user | Jumlah | Lokasi absensi | Geofence |
|-----------|--------|----------------|----------|
| TA Persampahan | 11 | Masing-masing kelurahan | 11 geofence berbeda |
| TA Kelembagaan | 11 | Masing-masing kelurahan | 11 geofence berbeda |
| KorKot | 1 | Kantor kota Padang | 1 geofence (TBD) |
| Asisten Manajemen Data | 1 | Kantor kota Padang | 1 geofence (TBD) |
| Operator | 2 | Kantor kota Padang | 1 geofence (TBD) |

**Total geofence: 12** (11 kelurahan + 1 kantor)

---

## 6. Checklist Data User (saat onboarding)

Untuk setiap user yang didaftarkan:

- [ ] Nama lengkap
- [ ] Email (login)
- [ ] No. HP (notifikasi WhatsApp)
- [ ] Tipe penugasan: `kelurahan` atau `kantor`
- [ ] Jika lapangan: kelurahan + jenis TA
- [ ] Jika kantor: peran kantor (KorKot / Asman Data / Operator)
- [ ] Foto profil (opsional)
