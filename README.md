# ISWMP SumBar-Padang

**Integrated Solid Waste Management Project — Sumatera Barat, Kota Padang**

Sub-project sistem absensi & crosscheck kehadiran tim lapangan, dikembangkan dari fondasi [Surya Abadi Connecteam](../surya-abadi-connecteam/).

> **Developer:** Hikmahtiar Studio  
> **Status:** Perencanaan / Setup awal  
> **Provinsi:** Sumatera Barat  
> **Wilayah kerja:** Kota Padang (11 kelurahan + kantor kota)

---

## Tujuan

Aplikasi ini berfungsi sebagai **alat crosscheck kehadiran** tim proyek ISWMP di lapangan dan kantor, bukan sistem HR/payroll internal.

---

## Cakupan Pengguna

| Kategori | Jumlah | Lokasi absensi |
|----------|--------|----------------|
| Tenaga Ahli Lapangan | 22 | 11 kelurahan (2 TA per kelurahan) |
| Tim Kantor Kota Padang | 4 | Kantor kota *(koordinat belum ditentukan)* |
| **Total pengguna absensi** | **26** | — |

Detail peran: lihat [docs/ORGANIZATION.md](./docs/ORGANIZATION.md)

---

## Struktur Folder

```
ISWMP-SumBar-Padang/
├── README.md                 ← Ringkasan proyek (file ini)
├── PROJECT_SPEC.md           ← Spesifikasi teknis & fungsional
├── .env.example              ← Template konfigurasi (saat development)
└── docs/
    ├── ORGANIZATION.md       ← Peran & hierarki pengguna
    ├── DATA_MODEL.md         ← Skema database Firestore
    ├── KELURAHAN.md          ← Daftar 11 kelurahan (to be filled)
    └── ROADMAP.md            ← Tahapan pengembangan
```

---

## Dokumentasi

| Dokumen | Isi |
|---------|-----|
| [PROJECT_SPEC.md](./PROJECT_SPEC.md) | Spesifikasi lengkap fitur & adaptasi dari parent project |
| [docs/ORGANIZATION.md](./docs/ORGANIZATION.md) | 22 TA lapangan + 4 tim kantor |
| [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) | Koleksi Firestore & field definitions |
| [docs/KELURAHAN.md](./docs/KELURAHAN.md) | Master data 11 kelurahan |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Fase pengembangan |

---

## Langkah Selanjutnya

1. Lengkapi daftar 11 kelurahan di [docs/KELURAHAN.md](./docs/KELURAHAN.md)
2. Tentukan koordinat kantor kota Padang (4 orang tim kantor)
3. Fork/adaptasi codebase dari `surya-abadi-connecteam/`
4. Setup Firebase project terpisah untuk ISWMP SumBar-Padang
5. Implementasi Fase 1 (multi-lokasi + struktur peran)

---

## Relasi dengan Parent Project

Sub-project ini **tidak mengubah** `surya-abadi-connecteam/` yang sudah production.  
Kode akan di-fork/adaptasi ke folder ini saat fase development dimulai.
