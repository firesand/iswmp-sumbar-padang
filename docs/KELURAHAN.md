# Master Data Kelurahan — ISWMP SumBar-Padang

**Status:** Menunggu input  
**Total kelurahan:** 11  
**Kota:** Padang, Sumatera Barat

---

## Template Data

Isi tabel di bawah ini saat daftar kelurahan sudah tersedia.

| No | Nama Kelurahan | Kecamatan | Lat | Lng | Radius (m) | TA Persampahan | TA Kelembagaan | Status |
|----|----------------|-----------|-----|-----|------------|----------------|----------------|--------|
| 1 | _belum diinput_ | | | | 300 | | | ⏳ |
| 2 | _belum diinput_ | | | | 300 | | | ⏳ |
| 3 | _belum diinput_ | | | | 300 | | | ⏳ |
| 4 | _belum diinput_ | | | | 300 | | | ⏳ |
| 5 | _belum diinput_ | | | | 300 | | | ⏳ |
| 6 | _belum diinput_ | | | | 300 | | | ⏳ |
| 7 | _belum diinput_ | | | | 300 | | | ⏳ |
| 8 | _belum diinput_ | | | | 300 | | | ⏳ |
| 9 | _belum diinput_ | | | | 300 | | | ⏳ |
| 10 | _belum diinput_ | | | | 300 | | | ⏳ |
| 11 | _belum diinput_ | | | | 300 | | | ⏳ |

---

## Kantor Kota Padang

| Item | Nilai |
|------|-------|
| Nama | Kantor ISWMP Kota Padang |
| Alamat | _belum ditentukan_ |
| Lat | _belum ditentukan_ |
| Lng | _belum ditentukan_ |
| Radius | 200 m (default) |
| Staff | KorKot (1) + Asisten Manajemen Data (1) + Operator (2) = **4 orang** |

---

## Cara Mendapatkan Koordinat

1. Buka [Google Maps](https://maps.google.com)
2. Klik kanan pada titik lokasi kerja TA / kantor kelurahan
3. Salin koordinat (format: `-0.xxxxx, 100.xxxxx`)
4. Isi kolom Lat dan Lng di tabel di atas

**Tips:** Gunakan titik kantor kelurahan atau lokasi kerja harian TA sebagai pusat geofence.

---

## Seed Data (JSON)

Setelah diisi, data ini akan di-import ke Firestore collection `kelurahan`:

```javascript
// Contoh format — ganti dengan data aktual
[
  {
    id: "kel-001",
    nama: "Nama Kelurahan",
    kecamatan: "Nama Kecamatan",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: -0.000000,
    lng: 100.000000,
    radius: 300,
    isActive: true
  }
  // ... 10 kelurahan lainnya
]
```

---

## Checklist

- [ ] Daftar 11 kelurahan dikonfirmasi
- [ ] Koordinat GPS per kelurahan disurvei
- [ ] Radius geofence dikalibrasi per lokasi
- [ ] Koordinat kantor kota Padang ditentukan
- [ ] Nama TA per kelurahan di-assign
- [ ] Data di-import ke Firestore
