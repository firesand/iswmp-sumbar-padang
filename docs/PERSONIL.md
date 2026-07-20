# Personil ISWMP Padang — Tahun 2026

Sumber: `PERSONIL ISWMP PADANG TAHUN 2026.xlsx`  
Disimpan sebagai referensi onboarding/absensi. **Belum diimpor ke Firebase Auth/Firestore.**

## Mapping jabatan → sistem

| Jabatan (Excel) | `role` | Assignment | Kode sistem |
|-----------------|--------|------------|-------------|
| KOORDINATOR | `office_staff` | `kantor` → `kantor-padang-kota` | `peranKantor: KORKOT` |
| ASMANDAT | `office_staff` | `kantor` → `kantor-padang-kota` | `peranKantor: ASMAN_DATA` |
| OPERATOR | `office_staff` | `kantor` → `kantor-padang-kota` | `peranKantor: OPERATOR` |
| PPM | `field_staff` | `kelurahan` *(TBD per orang)* | `jenisTenagaAhli: TA_PERSAMP` |
| PPL | `field_staff` | `kelurahan` *(TBD per orang)* | `jenisTenagaAhli: TA_KELEMBAGAAN` |

**Konfirmasi (20 Jul 2026):** PPM = `TA_PERSAMP`, PPL = `TA_KELEMBAGAAN`.

## Ringkasan

| Kategori | Jumlah |
|----------|--------|
| Tim kantor (KorKot + Asman Dat + Operator) | 4 |
| PPM (`TA_PERSAMP`) | 11 |
| PPL (`TA_KELEMBAGAAN`) | 11 |
| **Total** | **26** |

## Data yang masih kurang untuk akun absensi

- [ ] Email per personil (wajib Firebase Auth)
- [ ] `kelurahanId` untuk tiap PPM/PPL (11 kelurahan × 2 TA)
- [ ] Admin sistem (1–2 orang) — tidak ada di daftar Excel ini

Lihat master kelurahan: [KELURAHAN.md](./KELURAHAN.md) · struktur peran: [ORGANIZATION.md](./ORGANIZATION.md)

---

## 1. Tim Kantor Kota Padang (4)

| No | Nama | Jabatan | Kode | No. Telp | Tgl lahir | Pendidikan |
|----|------|---------|------|----------|-----------|------------|
| 1 | MISDAR PUTRA | KOORDINATOR | `KORKOT` | 85267047465 | 1966-06-17 | S2 Teknik Sipil ITB |
| 2 | ABDUL AZIS SIKUMBANG | ASMANDAT | `ASMAN_DATA` | 81266966866 | 1987-11-25 | S1 Sistem Informasi UPI YPTK Padang |
| 3 | MAIZUL HAMDI | OPERATOR | `OPERATOR` | 81275540614 | 1988-05-18 | S1 Sistem Informasi UPI YPTK Padang |
| 4 | RIZA FEBRIYAN | OPERATOR | `OPERATOR` | 81338062209 | 1985-02-21 | DIII Universitas Andalas |

## 2. PPM — Tenaga Pendamping Persampahan (`TA_PERSAMP`) (11)

| No | Nama | No. Telp | Tgl lahir | Pendidikan | Kelurahan |
|----|------|----------|-----------|------------|-----------|
| 5 | WIDIASARI | 85271944291 | 1984-10-08 | S1 Teknik Sipil | *TBD* |
| 6 | TUT WURI HANDAYANI | 85272741933 | 1969-06-24 | S1 Hukum | *TBD* |
| 7 | ARDI ALISMAN | 85263722499 | 1970-09-24 | S1 Teknik Sipil | *TBD* |
| 8 | SRI NOVIE | 81374378872 | 1979-03-21 | S2 Ilmu Lingkungan | *TBD* |
| 9 | HANIFAH | 85263867776 | 1987-04-05 | S1 Kesehatan Masyarakat | *TBD* |
| 10 | ALDIB SYAGLI | 85376539365 | 1977-04-25 | Magister Ilmu Lingkungan | *TBD* |
| 11 | ARMADAN | 85271079478 | 1978-12-26 | S1 Teknik Bangunan | *TBD* |
| 12 | RIDHAWATI NAIZAL | 81374725857 | 1983-05-18 | S1 Ilmu Kesehatan Masyarakat | *TBD* |
| 13 | FERIVIANI | 81363449460 | 1992-01-09 | S2 Teknologi Pertanian | *TBD* |
| 14 | FIRDAUS | 85165756206 | 1972-07-26 | S1 Sosiologi | *TBD* |
| 15 | MENDY MAITON | 81266559913 | 1985-07-28 | S1 Teknik Sipil | *TBD* |

## 3. PPL — Tenaga Ahli Kelembagaan (`TA_KELEMBAGAAN`) (11)

| No | Nama | No. Telp | Tgl lahir | Pendidikan | Kelurahan |
|----|------|----------|-----------|------------|-----------|
| 16 | DEKKEROFERSON INDO RAFELZA | 82387396282 | 1988-08-31 | S1 Pendidikan Bahasa Inggris | *TBD* |
| 17 | NOFRIZAL BUSRI | 85272544749 | 1980-03-15 | S1 Ekonomi Akuntansi | *TBD* |
| 18 | SHIDDIEQY | 82169887704 | 1982-10-16 | S1 Ekonomi | *TBD* |
| 19 | ANTONI FILTER MASBIRAN | 81291126958 | 1976-11-26 | S1 Teknik Lingkungan | *TBD* |
| 20 | INDAH MEGA PUSPITA | 811667077 | 1985-01-19 | S1 Ilmu Kesehatan Masyarakat | *TBD* |
| 21 | RIRIN DEFLINA | 81270377009 | 1986-12-12 | S1 Kesehatan Masyarakat | *TBD* |
| 22 | BENI SUWANDI | 8992558069 | 1973-10-02 | S1 Ekonomi Manajemen | *TBD* |
| 23 | F. AR RAZY | 85373903278 | 1975-04-16 | S1 Ekonomi | *TBD* |
| 24 | KHAIRIYANTI | 85274382900 | 1983-05-29 | S1 Kesehatan Masyarakat | *TBD* |
| 25 | AZMI FANDRA | 81374972967 | 1973-10-21 | S1 Teknik Elektro | *TBD* |
| 26 | YENI ROZA | 82381771266 | 1975-08-15 | S1 Ekonomi | *TBD* |

---

## Catatan

- Nomor telepon disalin apa adanya dari Excel (tanpa prefix `+62` / `0`).
- Kolom pengalaman/umur ada di sumber Excel; tidak diulang di sini karena tidak dipakai aplikasi.
- Setelah email + kelurahan tersedia, lanjut opsi **B**: script import Admin SDK.
