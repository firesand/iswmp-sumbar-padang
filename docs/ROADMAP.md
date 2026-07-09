# Roadmap Pengembangan — ISWMP SumBar-Padang

---

## Fase 0 — Setup & Perencanaan ✅ (sedang berjalan)

- [x] Buat subfolder proyek `ISWMP-SumBar-Padang/`
- [x] Dokumentasi spesifikasi awal
- [x] Definisikan struktur 22 TA lapangan + 4 tim kantor
- [ ] Input daftar 11 kelurahan
- [ ] Tentukan koordinat kantor kota Padang
- [ ] Keputusan: KorKot akses admin dashboard?
- [ ] Keputusan: metode registrasi user

---

## Fase 1 — Adaptasi Core (estimasi 1–2 minggu)

**Tujuan:** Fork codebase parent + multi-lokasi geofence

- [ ] Fork `surya-abadi-connecteam/` ke subfolder ini
- [ ] Setup Firebase project baru (terpisah)
- [ ] Implementasi koleksi `kelurahan` dan `kantor`
- [ ] Ubah `geolocation.js` → validasi multi-geofence
- [ ] Adaptasi model `users` (field_staff / office_staff)
- [ ] Sesuaikan form registrasi / admin create user
- [ ] Rebrand UI (nama proyek, logo)
- [ ] Nonaktifkan modul: payroll, cuti, BPJS, location update

**Deliverable:** Absensi TA di kelurahan + absensi tim kantor (mode transisi jika koordinat kantor belum ada)

---

## Fase 2 — Dashboard Monitoring (estimasi 1 minggu)

**Tujuan:** Crosscheck kehadiran untuk admin/KorKot

- [ ] Dashboard matriks 11 kelurahan × 2 TA
- [ ] Panel kehadiran 4 orang tim kantor
- [ ] Filter: kelurahan, jenis TA, peran kantor, tanggal
- [ ] Alert belum absen (setelah jam batas)
- [ ] Statistik harian: hadir / belum / di luar radius

**Deliverable:** Admin bisa lihat status kehadiran seluruh tim real-time

---

## Fase 3 — Laporan & Export (estimasi 3–5 hari)

- [ ] Laporan harian per kelurahan
- [ ] Laporan bulanan per TA / per kelurahan
- [ ] Export Excel
- [ ] Rekap tim kantor

**Deliverable:** Laporan siap untuk monitoring proyek

---

## Fase 4 — Uji Lapangan & Go-Live (estimasi 1 minggu)

- [ ] Uji GPS di 2–3 kelurahan (kalibrasi radius)
- [ ] Uji absensi tim kantor setelah koordinat ditentukan
- [ ] Training admin + 26 user
- [ ] Deploy production (Vercel)
- [ ] Monitoring minggu pertama

**Deliverable:** Aplikasi live untuk seluruh tim

---

## Fase 5 — Opsional (setelah go-live)

- [ ] Notifikasi WhatsApp: alert belum absen
- [ ] Check-out harian (jika diperlukan)
- [ ] Modul cuti sederhana
- [ ] Peta visual kehadiran per kelurahan
- [ ] Push notification PWA

---

## Timeline Visual

```
Fase 0  ████░░░░░░  Setup & docs        ← kita di sini
Fase 1  ░░░░░░░░░░  Core adaptation
Fase 2  ░░░░░░░░░░  Dashboard
Fase 3  ░░░░░░░░░░  Laporan
Fase 4  ░░░░░░░░░░  Uji & go-live
Fase 5  ░░░░░░░░░░  Enhancement
```

---

## Blocker Saat Ini

| Blocker | Dampak | Action |
|---------|--------|--------|
| Daftar 11 kelurahan belum ada | Tidak bisa seed geofence | Minta daftar resmi dari tim proyek |
| Koordinat kantor Padang TBD | 4 orang kantor belum bisa validasi GPS | Mode transisi / manual approval |
| Koordinat kelurahan belum disurvei | Radius belum akurat | Uji lapangan Fase 4 |
