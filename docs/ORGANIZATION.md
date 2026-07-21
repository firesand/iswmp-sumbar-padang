# Struktur Organisasi & Peran — ISWMP SumBar-Padang

---

## Ringkasan

| Kategori | Jumlah | Lokasi kerja | Tipe absensi |
|----------|--------|--------------|--------------|
| Tenaga Ahli Lapangan | 22 | 11 kelurahan | Geofence kelurahan |
| Tim Kantor Kota Padang | 5 | Kantor kota (Pasir Nan Tigo / Muaro Penjalinan) | Geofence kantor |
| Admin Sistem | 1–2 | — | Tidak absen / opsional |
| **Total** | **28–29** | | |

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

## 2. Tim Kantor Kota Padang (5 orang)

Berkantor di **Kota Padang** — Jl. Raya Pasir Nan Tigo, Muaro Penjalinan (−0.861081, 100.337068). Geofence provisional; aktifkan setelah verifikasi lapangan.

### Daftar peran

| No | Peran | Kode sistem | Jumlah |
|----|-------|-------------|--------|
| 1 | Koordinator Kota (KorKot) | `KORKOT` | 1 |
| 2 | Asisten Manajemen Data | `ASMAN_DATA` | 1 |
| 3 | Operator | `OPERATOR` | 2 |
| 4 | Office Boy | `OFFICE_BOY` | 1 |

### Atribut user (kantor)

```javascript
{
  role: 'office_staff',
  assignmentType: 'kantor',
  kantorId: 'kantor-padang-kota',
  peranKantor: 'KORKOT' | 'ASMAN_DATA' | 'OPERATOR' | 'OFFICE_BOY',
  provinsi: 'Sumatera Barat',
  kota: 'Padang'
}
```

### Aturan absensi

- Absen di **kantor kota Padang** (satu lokasi untuk ke-5 orang)
- Geofence aktif setelah koordinat kantor ditentukan
- Sementara koordinat belum ada: absensi bisa mode **manual approval** atau **GPS tanpa validasi radius** (fase transisi)

### Catatan peran KorKot

**Keputusan (9 Jul 2026):** KorKot = `role: office_staff` + `peranKantor: 'KORKOT'` — **tanpa akses admin dashboard**. Hanya absen di geofence kantor seperti staff kantor lainnya. Monitoring kehadiran dilakukan oleh Admin Sistem (1–2 orang).

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
    ├── KorKot (absensi kantor saja, tanpa dashboard)
    │
    ├── Asisten Manajemen Data (absensi kantor)
    │
    ├── 2× Operator (absensi kantor)
    │
    ├── Office Boy (absensi kantor)
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
| KorKot | 1 | Kantor kota Padang | 1 geofence (Pasir Nan Tigo) |
| Asisten Manajemen Data | 1 | Kantor kota Padang | 1 geofence (Pasir Nan Tigo) |
| Operator | 2 | Kantor kota Padang | 1 geofence (Pasir Nan Tigo) |
| Office Boy | 1 | Kantor kota Padang | 1 geofence (Pasir Nan Tigo) |

**Total geofence: 12** (11 kelurahan + 1 kantor)

---

## 6. Daftar nama personil

Referensi nama & kontak tahun 2026: **[PERSONIL.md](./PERSONIL.md)**  
(PPM = `TA_PERSAMP`, PPL = `TA_KELEMBAGAAN`. Email & kelurahan penugasan masih TBD.)

---

## 7. Checklist Data User (saat onboarding)

Untuk setiap user yang didaftarkan:

- [ ] Nama lengkap
- [ ] Email (login)
- [ ] No. HP (notifikasi WhatsApp)
- [ ] Tipe penugasan: `kelurahan` atau `kantor`
- [ ] Jika lapangan: kelurahan + jenis TA
- [ ] Jika kantor: peran kantor (KorKot / Asman Data / Operator)
- [ ] Foto profil (opsional)
