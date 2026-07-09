# ISWMP SumBar-Padang

**Integrated Solid Waste Management Project — Sumatera Barat, Kota Padang**

Sub-project sistem absensi & crosscheck kehadiran tim lapangan, dikembangkan dari fondasi [Surya Abadi Connecteam](../surya-abadi-connecteam/).

> **Developer:** Hikmahtiar Studio  
> **Repository:** https://github.com/firesand/iswmp-sumbar-padang  
> **Status:** Fase 1 — Core adaptation (fork selesai, build OK)  
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
├── memory.md                 ← Konteks percakapan & keputusan
├── package.json              ← Vite + React app
├── .env.example              ← Template konfigurasi Firebase
├── src/                      ← Source code (fork dari parent)
│   └── config/projectConfig.js
├── public/                   ← PWA assets
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
| [docs/FIREBASE_SETUP.md](./docs/FIREBASE_SETUP.md) | Panduan setup Firebase + seed |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Fase pengembangan |

---

## Langkah Selanjutnya

1. Lengkapi daftar 11 kelurahan di [docs/KELURAHAN.md](./docs/KELURAHAN.md)
2. Tentukan koordinat kantor kota Padang (4 orang tim kantor)
3. ~~Fork/adaptasi codebase dari `surya-abadi-connecteam/`~~ ✅ Selesai
4. Setup Firebase project terpisah untuk ISWMP SumBar-Padang
5. Implementasi multi-geofence + adaptasi model user (Fase 1 lanjutan)

## Development

```bash
cd ISWMP-SumBar-Padang
npm install
cp .env.example .env.local
# Isi kredensial Firebase di .env.local
npm run dev
```

---

## Relasi dengan Parent Project

Sub-project ini **tidak mengubah** `surya-abadi-connecteam/` yang sudah production.  
Kode akan di-fork/adaptasi ke folder ini saat fase development dimulai.

---

## Setup di PC Desktop

```bash
mkdir github_SA_Connecteam && cd github_SA_Connecteam

git clone https://github.com/firesand/surya-abadi-connecteam.git
git clone https://github.com/firesand/iswmp-sumbar-padang.git ISWMP-SumBar-Padang

cd surya-abadi-connecteam && npm install && cp .env.example .env.local
# Edit .env.local dengan kredensial Firebase, lalu: npm run dev
```

Buka folder `github_SA_Connecteam` di Cursor, lalu mulai chat dengan:
> *"Baca ISWMP-SumBar-Padang/memory.md, lanjutkan proyek."*
