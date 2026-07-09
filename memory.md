# memory.md — ISWMP SumBar-Padang

> **Tujuan file ini:** Jembatan informasi keberlanjutan pembahasan proyek.  
> Baca file ini di awal setiap sesi baru agar konteks tidak hilang.  
> **Update terakhir:** 9 Juli 2026

---

## Cara Pakai

1. **Agent / developer baru** → baca `memory.md` dulu, lalu `PROJECT_SPEC.md` jika perlu detail teknis
2. **Setelah setiap sesi penting** → update bagian *Log Sesi*, *Keputusan*, dan *Blocker*
3. **Jangan duplikasi** → detail teknis lengkap tetap di `docs/`, file ini hanya ringkasan hidup + konteks percakapan

---

## Snapshot Proyek

| Item | Nilai |
|------|-------|
| **Nama proyek** | ISWMP SumBar-Padang |
| **Nama lengkap** | Integrated Solid Waste Management Project — Sumatera Barat, Kota Padang |
| **Tujuan aplikasi** | Crosscheck kehadiran tim proyek (bukan HR/payroll) |
| **Developer** | Hikmahtiar Studio |
| **Status saat ini** | Fase 0 — Setup & perencanaan (parent sudah sync GitHub, belum fork codebase) |
| **Parent commit lokal** | `1b9605e` — sinkron dengan `origin/main` (9 Jul 2026) |
| **Workspace lokal** | `github_SA_Connecteam/ISWMP-SumBar-Padang/` |
| **Parent project** | `github_SA_Connecteam/surya-abadi-connecteam/` |
| **Repo parent (GitHub)** | https://github.com/firesand/surya-abadi-connecteam |
| **Production parent** | https://surya-abadi-connecteam.vercel.app |
| **Provinsi / Kota** | Sumatera Barat — Kota Padang |
| **Total user absensi** | 26 orang (+ 1–2 admin) |
| **Total geofence** | 12 (11 kelurahan + 1 kantor kota) |

---

## Konteks dari Percakapan

### Sesi 1 — Review parent project (9 Jul 2026)

User minta cek repo `firesand/surya-abadi-connecteam`. Temuan utama:

- Aplikasi **production-ready** untuk PT Surya Abadi (Depok): absensi GPS + selfie, admin dashboard, payroll, cuti, PWA
- Stack: React 19 + Vite 7 + Tailwind + Firebase + Vercel
- Build sukses; bundle JS ~1.3 MB
- Bug ditemukan: `navigate` dipakai tanpa import di `App.jsx` baris 190 (akun suspended)
- ESLint 81 masalah; file `.backup` dan `console_log.txt` (data sensitif) masih di repo parent
- Ada 1 PR terbuka: fix validasi lokasi GPS (branch Copilot)

**Kesimpulan sesi:** Parent project cocok sebagai **fondasi**, bukan rebuild from scratch.

### Sesi 2 — Adaptasi untuk Padang (9 Jul 2026)

User jelaskan kebutuhan baru:

- Proyek di **Sumatera Barat, Kota Padang**
- **11 kelurahan**, masing-masing 2 tenaga ahli:
  - Tenaga Pendamping Persampahan
  - Tenaga Ahli Kelembagaan
- Total lapangan: **22 orang**
- Tujuan: **crosscheck kehadiran** tim pendamping di lapangan

**Keputusan arah adaptasi:**
- Multi-geofence (bukan single office seperti parent)
- Fokus monitoring, bukan payroll/cuti/BPJS
- Firebase project **terpisah** dari Surya Abadi
- Parent project **tidak diubah**

### Sesi 3 — Sub-project setup + tim kantor (9 Jul 2026)

User minta buat subfolder `ISWMP-SumBar-Padang` sebagai langkah awal.

**Tambahan informasi penting:**
- Selain 22 TA lapangan, ada **4 orang berkantor di Kota Padang**
- Lokasi kantor **belum ditentukan** (koordinat TBD)
- Peran tim kantor:
  1. **Koordinator Kota (KorKot)** × 1
  2. **Asisten Manajemen Data** × 1
  3. **Operator** × 2

Dokumentasi awal dibuat: README, PROJECT_SPEC, ORGANIZATION, DATA_MODEL, KELURAHAN, ROADMAP, `.env.example`.

### Sesi 4 — memory.md (9 Jul 2026)

User minta `memory.md` sebagai jembatan keberlanjutan diskusi.

---

## Struktur Pengguna (Confirmed)

```
ISWMP SumBar-Padang
│
├── Admin Sistem (1–2) ─────────────── tidak wajib absen
│
├── Tim Kantor Kota Padang (4) ────── absensi di 1 geofence kantor (TBD)
│   ├── KorKot (KORKOT) × 1
│   ├── Asisten Manajemen Data (ASMAN_DATA) × 1
│   └── Operator (OPERATOR) × 2
│
└── Tenaga Ahli Lapangan (22) ─────── absensi di kelurahan masing-masing
    ├── TA Persampahan (TA_PERSAMP) × 11
    └── TA Kelembagaan (TA_KELEMBAGAAN) × 11
        └── 11 kelurahan × 2 TA = 22
```

### Kode peran (untuk development)

| Kode | Label | Tipe |
|------|-------|------|
| `admin` | Admin Sistem | admin |
| `field_staff` + `TA_PERSAMP` | Tenaga Pendamping Persampahan | kelurahan |
| `field_staff` + `TA_KELEMBAGAAN` | Tenaga Ahli Kelembagaan | kelurahan |
| `office_staff` + `KORKOT` | Koordinator Kota | kantor |
| `office_staff` + `ASMAN_DATA` | Asisten Manajemen Data | kantor |
| `office_staff` + `OPERATOR` | Operator | kantor |

---

## Keputusan Desain (Sudah Disepakati)

| # | Keputusan | Alasan |
|---|-----------|--------|
| 1 | Fork dari `surya-abadi-connecteam`, bukan from scratch | Hemat waktu; fitur absensi GPS + selfie + dashboard sudah ada |
| 2 | Subfolder terpisah, parent tidak diubah | Surya Abadi tetap production independen |
| 3 | Firebase project baru & terpisah | Isolasi data proyek ISWMP |
| 4 | Koordinat kelurahan di Firestore (`kelurahan` collection) | 11 lokasi, tidak cocok di env vars |
| 5 | Koordinat kantor di Firestore (`kantor` collection) | Fleksibel saat lokasi TBD |
| 6 | Modul payroll, cuti, BPJS, location-update **tidak dipakai** | Fokus crosscheck kehadiran |
| 7 | Foto selfie tetap wajib | Bukti visual kehadiran lapangan |
| 8 | Fase awal: check-in saja (check-out opsional) | Cukup untuk crosscheck |
| 9 | Geofence kantor **nonaktif** sampai koordinat ditentukan | Hindari false reject absensi |

---

## Keputusan yang BELUM Final

| # | Pertanyaan | Opsi | Status |
|---|------------|------|--------|
| 1 | Apakah KorKot punya akses admin dashboard? | A) role admin + absensi kantor · B) office_staff + permission khusus | ⏳ Tanya user |
| 2 | Metode registrasi user? | A) Admin buat semua akun · B) Self-register + approval | ⏳ Tanya user |
| 3 | Apakah Asisten Manajemen Data butuh akses dashboard? | Ya / Tidak | ⏳ Tanya user |
| 4 | Jam absensi resmi proyek? | Default sementara: 08:00 WIB | ⏳ Tanya user |
| 5 | Radius geofence default? | 300m kelurahan, 200m kantor (perlu kalibrasi lapangan) | ⏳ Konfirmasi |
| 6 | Branding UI final? | Draft: "ISWMP SumBar-Padang" | ⏳ Konfirmasi |

---

## Data yang Masih Kosong (Blocker)

| Data | Dampak jika kosong | File target |
|------|-------------------|-------------|
| Daftar 11 kelurahan (nama + kecamatan) | Tidak bisa seed geofence | `docs/KELURAHAN.md` |
| Koordinat GPS per kelurahan | Validasi absensi TA tidak akurat | `docs/KELURAHAN.md` |
| Koordinat kantor Kota Padang | 4 orang kantor belum bisa validasi GPS | `docs/KELURAHAN.md` + `kantor` collection |
| Nama/email 26 user | Tidak bisa onboarding | belum ada file |
| Assign TA per kelurahan | Matriks dashboard kosong | `docs/KELURAHAN.md` |

---

## Adaptasi Teknis dari Parent (Rencana)

| Komponen parent | Perubahan untuk ISWMP |
|-----------------|----------------------|
| `src/utils/geolocation.js` | Single office → multi-geofence per `kelurahanId` / `kantorId` |
| `users` collection | Tambah `assignmentType`, `jenisTenagaAhli`, `peranKantor`, `kelurahanId` |
| `Register.jsx` | Form penugasan kelurahan/kantor, bukan department/position bebas |
| `Admin/Dashboard.jsx` | Matriks 11×2 kelurahan + panel 4 kantor |
| `CheckIn.jsx` | Validasi ke lokasi penugasan user, bukan office global |
| Payroll, Leave, LocationUpdate | Nonaktifkan / hapus dari routing |
| Branding UI | Ganti nama, logo, footer |

### Bug parent — status setelah sync GitHub (9 Jul 2026)

- ~~`App.jsx` navigate tanpa import~~ → **sudah diperbaiki** di commit `b96d243`
- ~~Duplicate Firebase init~~ → **sudah diperbaiki** di commit `cf8ad99`
- ~~Check-in dobel per hari~~ → **sudah diperbaiki** di commit `5819a5d`
- `console_log.txt` & markdown clutter → **sudah dihapus** di GitHub (commit `1b9605e`)

---

## Peta File Proyek

```
github_SA_Connecteam/
│
├── surya-abadi-connecteam/          ← PARENT (jangan ubah)
│   └── [codebase production Surya Abadi Depok]
│
└── ISWMP-SumBar-Padang/             ← SUB-PROJECT (aktif)
    ├── memory.md                    ← FILE INI (baca dulu setiap sesi)
    ├── README.md                    ← Overview singkat
    ├── PROJECT_SPEC.md              ← Spesifikasi fungsional & teknis
    ├── .env.example                 ← Template env (Firebase TBD)
    └── docs/
        ├── ORGANIZATION.md          ← Peran 26 user + hierarki
        ├── DATA_MODEL.md            ← Skema Firestore
        ├── KELURAHAN.md             ← Master 11 kelurahan (KOSONG)
        └── ROADMAP.md               ← Fase 0–5 pengembangan
```

---

## Roadmap Singkat

| Fase | Status | Isi |
|------|--------|-----|
| **0** Setup & docs | 🟡 Sedang berjalan | Subfolder + dokumentasi + memory.md |
| **1** Core adaptation | ⬜ Belum | Fork code, multi-geofence, model user baru |
| **2** Dashboard monitoring | ⬜ Belum | Matriks kelurahan + panel kantor |
| **3** Laporan & export | ⬜ Belum | Excel harian/bulanan per kelurahan |
| **4** Uji lapangan & go-live | ⬜ Belum | Kalibrasi GPS, training, deploy |
| **5** Enhancement | ⬜ Belum | WhatsApp alert, peta, cuti, dll. |

---

## Langkah Berikutnya (Prioritas)

1. **User input:** daftar 11 kelurahan → isi `docs/KELURAHAN.md`
2. **User input:** koordinat kantor Padang (4 orang)
3. **User konfirmasi:** akses dashboard KorKot & metode registrasi
4. **Development:** fork `surya-abadi-connecteam/` → `ISWMP-SumBar-Padang/src/` *(base sudah up-to-date)*
5. **Development:** setup Firebase project baru
6. **Development:** implementasi multi-geofence (Fase 1)

---

## Log Sesi

| Tanggal | Topik | Output |
|---------|-------|--------|
| 2026-07-09 | Review parent project Surya Abadi Connecteam | Analisis fitur, bug, rekomendasi |
| 2026-07-09 | Perencanaan adaptasi Padang (11 kelurahan, 22 TA) | Arsitektur multi-geofence, fase dev |
| 2026-07-09 | Setup sub-project + 4 tim kantor | Folder + docs awal |
| 2026-07-09 | Buat memory.md | File kontinuitas ini |
| 2026-07-09 | Sync parent dengan GitHub | `git pull` — 16 commit, fast-forward ke `1b9605e`, build OK |

---

## Catatan untuk Agent Berikutnya

- User berkomunikasi dalam **Bahasa Indonesia**
- User adalah developer/pemilik proyek (Hikmahtiar Studio)
- Jangan commit ke git kecuali diminta eksplisit
- Jangan ubah folder `surya-abadi-connecteam/` — hanya baca/fork
- Parent lokal sudah **sync dengan GitHub** (`1b9605e`) — fork dari versi ini
- Kantor Padang = **1 geofence untuk 4 orang**, bukan 4 geofence terpisah
- Total absensi bukan 22 saja — **26 orang** (22 lapangan + 4 kantor)
- Jika user kirim daftar kelurahan, update `docs/KELURAHAN.md` DAN tabel blocker di file ini

---

## Changelog memory.md

| Versi | Tanggal | Perubahan |
|-------|---------|-----------|
| 0.1.0 | 2026-07-09 | Inisialisasi — konteks sesi 1–3, struktur user, keputusan, blocker |
| 0.1.1 | 2026-07-09 | Parent sync GitHub (16 commit), update status bug & next steps |
