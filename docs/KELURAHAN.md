# Master Data Kelurahan — ISWMP SumBar-Padang

**Status:** Daftar kelurahan dikonfirmasi — koordinat GPS menunggu survei  
**Sumber:** Kelurahan ISWMP Padang.pdf (9 Jul 2026)  
**Total kelurahan:** 11  
**Kota:** Padang, Sumatera Barat

---

## Daftar 11 Kelurahan Kegiatan ISWMP

| No | Nama Kelurahan | Kecamatan | ID | Lat | Lng | Radius (m) | TA Persampahan | TA Kelembagaan | Status |
|----|----------------|-----------|-----|-----|-----|------------|----------------|----------------|--------|
| 1 | Alang Laweh | Padang Selatan | `kel-alang-laweh` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 2 | Rawang | Padang Selatan | `kel-rawang` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 3 | Lubuk Begalung | Padang Timur | `kel-lubuk-begalung` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 4 | Tanjung Aur | Lubuk Begalung | `kel-tanjung-aur` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 5 | Surau Gadang | Nanggalo | `kel-surau-gadang` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 6 | Lubuk Buaya | Koto Tangah | `kel-lubuk-buaya` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 7 | Parupuak Tabing | Koto Tangah | `kel-parupuak-tabing` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 8 | Rimbo Kaluang | Padang Barat | `kel-rimbo-kaluang` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 9 | Berok Nipah | Padang Barat | `kel-berok-nipah` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 10 | Batang Arau | Padang Selatan | `kel-batang-arau` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |
| 11 | Kampung Pondok | Padang Barat | `kel-kampung-pondok` | _TBD_ | _TBD_ | 300 | | | ⏳ koordinat |

### Ringkasan per Kecamatan

| Kecamatan | Jumlah Kelurahan | Kelurahan |
|-----------|------------------|-----------|
| Padang Selatan | 3 | Alang Laweh, Rawang, Batang Arau |
| Padang Timur | 1 | Lubuk Begalung |
| Lubuk Begalung | 1 | Tanjung Aur |
| Nanggalo | 1 | Surau Gadang |
| Koto Tangah | 2 | Lubuk Buaya, Parupuak Tabing |
| Padang Barat | 3 | Rimbo Kaluang, Berok Nipah, Kampung Pondok |

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

Data untuk import ke Firestore collection `kelurahan` — koordinat diisi setelah survei lapangan:

```javascript
[
  {
    id: "kel-alang-laweh",
    nama: "Alang Laweh",
    kecamatan: "Padang Selatan",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-rawang",
    nama: "Rawang",
    kecamatan: "Padang Selatan",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-lubuk-begalung",
    nama: "Lubuk Begalung",
    kecamatan: "Padang Timur",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-tanjung-aur",
    nama: "Tanjung Aur",
    kecamatan: "Lubuk Begalung",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-surau-gadang",
    nama: "Surau Gadang",
    kecamatan: "Nanggalo",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-lubuk-buaya",
    nama: "Lubuk Buaya",
    kecamatan: "Koto Tangah",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-parupuak-tabing",
    nama: "Parupuak Tabing",
    kecamatan: "Koto Tangah",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-rimbo-kaluang",
    nama: "Rimbo Kaluang",
    kecamatan: "Padang Barat",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-berok-nipah",
    nama: "Berok Nipah",
    kecamatan: "Padang Barat",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-batang-arau",
    nama: "Batang Arau",
    kecamatan: "Padang Selatan",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  },
  {
    id: "kel-kampung-pondok",
    nama: "Kampung Pondok",
    kecamatan: "Padang Barat",
    kota: "Padang",
    provinsi: "Sumatera Barat",
    lat: null,
    lng: null,
    radius: 300,
    isActive: false
  }
]
```

> `isActive: false` sampai koordinat GPS diisi dan dikonfirmasi. Setelah koordinat tersedia, ubah ke `true`.

---

## Checklist

- [x] Daftar 11 kelurahan dikonfirmasi (sumber: PDF 9 Jul 2026)
- [ ] Koordinat GPS per kelurahan disurvei
- [ ] Radius geofence dikalibrasi per lokasi
- [ ] Koordinat kantor kota Padang ditentukan
- [ ] Nama TA per kelurahan di-assign
- [ ] Data di-import ke Firestore
