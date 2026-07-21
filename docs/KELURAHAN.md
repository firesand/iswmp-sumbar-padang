# Master Data Kelurahan — ISWMP SumBar-Padang

**Status:** 11 titik kantor kelurahan tersedia sebagai koordinat provisional; belum diverifikasi lapangan

**Sumber nama awal:** Kelurahan ISWMP Padang.pdf (9 Jul 2026)

**Koreksi nama/kecamatan:** konfirmasi user (11 Jul 2026)

**Sumber alamat:** KPU Kota Padang dan konfirmasi user

**Sumber koordinat:** marker POI Google Maps, dicek 11 Jul 2026

**Total kelurahan:** 11

**Total kecamatan:** 5

**Kota:** Padang, Sumatera Barat

> Koordinat di bawah boleh dipakai untuk development dan seed provisional, tetapi seluruh geofence tetap `isActive: false` sampai titik diverifikasi dari lokasi kantor masing-masing.

---

## Daftar 11 Kelurahan dan Titik Kantor

| No | Nama Kelurahan | Kecamatan | ID | Alamat Kantor Kelurahan | Lat | Lng | Radius (m) | Status |
|---:|----------------|-----------|----|--------------------------|----:|----:|-----------:|--------|
| 1 | Alang Laweh | Padang Selatan | `kel-alang-laweh` | Jl. Alang Laweh II No. 4, RT 09/RW 03 | -0.9528483 | 100.3646431 | 300 | Provisional |
| 2 | Rawang | Padang Selatan | `kel-rawang` | Jondul Rawang, RT 001/RW 009 | -0.9850455 | 100.3803928 | 300 | Provisional |
| 3 | Lubuk Begalung Nan XX | Lubuk Begalung | `kel-lubuk-begalung` | Jl. Dalam Gadung No. 8, RT 03/RW 08 | -0.9599285 | 100.3991082 | 300 | Provisional |
| 4 | Tanjung Aur Nan XX | Lubuk Begalung | `kel-tanjung-aur` | RT 03/RW 02, Tanjung Aur Nan XX | -0.9594514 | 100.3810860 | 300 | Provisional |
| 5 | Surau Gadang | Nanggalo | `kel-surau-gadang` | Jl. Padang (nomor bangunan menunggu verifikasi) | -0.8943706 | 100.3664989 | 300 | Provisional |
| 6 | Lubuk Buaya | Koto Tangah | `kel-lubuk-buaya` | Jl. Adinegoro, Simpang Rumah Potong No. 1 | -0.8303021 | 100.3277431 | 300 | Provisional |
| 7 | Parupuk Tabing | Koto Tangah | `kel-parupuak-tabing` | Jl. Bakti No. 64 | -0.8734243 | 100.3453567 | 300 | Provisional |
| 8 | Rimbo Kaluang | Padang Barat | `kel-rimbo-kaluang` | Jl. Batang Pasaman No. 6 | -0.9285304 | 100.3595448 | 300 | Provisional |
| 9 | Berok Nipah | Padang Barat | `kel-berok-nipah` | Jl. HOS Cokroaminoto No. 103 | -0.9609424 | 100.3543467 | 300 | Provisional |
| 10 | Batang Arau | Padang Selatan | `kel-batang-arau` | Jl. Kampung Batu, RT 05/RW 02 | -0.9659099 | 100.3593819 | 300 | Provisional |
| 11 | Kampung Pondok | Padang Barat | `kel-kampung-pondok` | Jl. Dobi VI No. 2 | -0.9571423 | 100.3584096 | 300 | Provisional |

### Ringkasan per Kecamatan

| Kecamatan | Jumlah Kelurahan | Kelurahan |
|-----------|-----------------:|-----------|
| Padang Selatan | 3 | Alang Laweh, Rawang, Batang Arau |
| Lubuk Begalung | 2 | Lubuk Begalung Nan XX, Tanjung Aur Nan XX |
| Nanggalo | 1 | Surau Gadang |
| Koto Tangah | 2 | Lubuk Buaya, Parupuk Tabing |
| Padang Barat | 3 | Rimbo Kaluang, Berok Nipah, Kampung Pondok |

### Koreksi terhadap daftar awal

- `Lubuk Begalung` dilengkapi menjadi **Lubuk Begalung Nan XX** dan berada di **Kecamatan Lubuk Begalung**, bukan Padang Timur.
- `Tanjung Aur` dilengkapi menjadi **Tanjung Aur Nan XX**.
- Ejaan nama tampil menggunakan **Parupuk Tabing**.
- ID internal `kel-parupuak-tabing` sengaja dipertahankan agar referensi `kelurahanId` lama tidak terputus.
- Alamat sementara Kantor Kelurahan Kampung Pondok menggunakan **Jl. Dobi VI No. 2**.

---

## Status Koordinat dan Aktivasi

Semua record kelurahan memakai metadata berikut selama tahap provisional:

```javascript
{
  coordinateStatus: "provisional",
  coordinateSource: "Google Maps POI",
  verifiedAt: null,
  isActive: false,
  catatan: "Titik kantor kelurahan; verifikasi lapangan sebelum aktivasi geofence"
}
```

Konsekuensi desain: titik ini memvalidasi kehadiran di sekitar **kantor kelurahan**, bukan keberadaan di seluruh wilayah administratif kelurahan.

Radius 300 meter masih merupakan default lama dan belum final. Radius harus dikalibrasi setelah data akurasi GPS lapangan tersedia; jangan memperlebar radius hanya untuk menutupi marker yang belum terverifikasi.

Master data executable berada di `src/data/seedData.js`. Script `scripts/seed-firestore.mjs` mengimpor data tersebut agar dropdown registrasi dan seed Firestore tidak berbeda.

---

## Kantor Kota Padang

| Item | Nilai |
|------|-------|
| Nama | Kantor ISWMP Kota Padang |
| Alamat | Jl. Raya Pasir Nan Tigo, Muaro Penjalinan, Kota Padang |
| Lat | -0.861081 |
| Lng | 100.337068 |
| Radius | 200 m (default) |
| Status | provisional (dikonfirmasi user 21 Jul 2026; menunggu verifikasi lapangan) |
| Maps | https://www.google.com/maps?q=-0.861081,100.337068 |
| Staff | KorKot (1) + Asisten Manajemen Data (1) + Operator (2) + Office Boy (1) = **5 orang** |

---

## Prosedur Verifikasi Lapangan

1. Staf berdiri di depan atau di dalam Kantor Kelurahan.
2. Ambil koordinat GPS aktual dari telepon yang akan dipakai absensi.
3. Bandingkan jarak terhadap marker provisional.
4. Pastikan akurasi GPS tercatat dan marker benar-benar berada pada bangunan kantor.
5. Setelah dikonfirmasi, isi `verifiedAt`, ubah `coordinateStatus` menjadi `verified`, lalu aktifkan `isActive`.
6. Kalibrasi radius per lokasi berdasarkan hasil uji, bukan satu radius longgar untuk semua kantor.

---

## Checklist

- [x] Daftar 11 kelurahan dikonfirmasi
- [x] Nama Lubuk Begalung Nan XX, Tanjung Aur Nan XX, dan Parupuk Tabing dinormalisasi
- [x] Alamat sementara Kampung Pondok ditetapkan ke Jl. Dobi VI No. 2
- [x] Kandidat koordinat Google Maps untuk 11 kantor tersedia
- [ ] Koordinat GPS diverifikasi di setiap kantor kelurahan
- [ ] Radius geofence dikalibrasi per lokasi
- [x] Koordinat kantor kota Padang ditentukan (Pasir Nan Tigo / Muaro Penjalinan)
- [ ] Koordinat kantor kota diverifikasi lapangan dan `isActive: true`
- [ ] Nama TA per kelurahan di-assign
- [ ] Data di-import ke Firestore
