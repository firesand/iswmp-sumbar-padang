# Data Model — ISWMP SumBar-Padang

Skema Firestore untuk sub-project ini. Base project: Surya Abadi Connecteam.

---

## Koleksi Overview

| Koleksi | Deskripsi |
|---------|-----------|
| `kelurahan` | Master data 11 kelurahan + geofence |
| `kantor` | Master data kantor kota Padang |
| `users` | Profil semua pengguna (26 + admin) |
| `attendances` | Record absensi harian |
| `registrationRequests` | Permintaan registrasi (jika self-register) |
| `projectConfig` | Konfigurasi proyek (jam kerja, dll.) |

Koleksi **tidak digunakan** (vs parent): `payrollRequests`, `leaveRequests`, `locationUpdates`

---

## `kelurahan`

```javascript
{
  id: "kel-001",                    // Document ID
  nama: "Nama Kelurahan",
  kecamatan: "Nama Kecamatan",
  alamat: "Alamat kantor kelurahan",
  kota: "Padang",
  provinsi: "Sumatera Barat",
  lat: -0.9,                        // marker kantor kelurahan
  lng: 100.3,
  radius: 300,                      // meter, default 300 — kalibrasi lapangan
  coordinateStatus: "provisional", // provisional | verified
  coordinateSource: "Google Maps POI",
  coordinateSourceUrl: "https://www.google.com/maps?q=...",
  verifiedAt: null,
  catatan: "Verifikasi lapangan sebelum aktivasi geofence",
  isActive: false,                  // true hanya setelah verifikasi lapangan
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

**Jumlah record:** 11

Koordinat provisional tetap disimpan agar development dan seed bisa berjalan, tetapi runtime tidak menerapkan radius selama `isActive !== true`. Nama dan koordinat canonical berada di `src/data/seedData.js`.

---

## `kantor`

```javascript
{
  id: "kantor-padang-kota",
  nama: "Kantor ISWMP Kota Padang",
  alamat: null,                       // ⏳ to be filled
  kota: "Padang",
  provinsi: "Sumatera Barat",
  lat: null,                          // ⏳ BELUM DITENTUKAN
  lng: null,                          // ⏳ BELUM DITENTUKAN
  radius: 200,                        // meter, default 200
  isActive: false,                      // aktif setelah koordinat diisi
  catatan: "Koordinat kantor belum ditentukan",
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

**Jumlah record:** 1 (untuk 4 orang tim kantor)

---

## `users`

### Field umum (semua user)

```javascript
{
  uid: string,
  email: string,
  name: string,
  phoneNumber: string,
  photoUrl: string | null,
  role: "admin" | "field_staff" | "office_staff",
  accountStatus: "pending" | "active" | "suspended",
  isActive: boolean,
  registeredAt: Timestamp,
  updatedAt: Timestamp
}
```

### Field staff lapangan (`role: field_staff`)

```javascript
{
  assignmentType: "kelurahan",
  kelurahanId: string,              // ref → kelurahan.id
  kelurahanNama: string,            // denormalized
  jenisTenagaAhli: "TA_PERSAMP" | "TA_KELEMBAGAAN",
  provinsi: "Sumatera Barat",
  kota: "Padang"
}
```

### Field staff kantor (`role: office_staff`)

```javascript
{
  assignmentType: "kantor",
  kantorId: "kantor-padang-kota",   // ref → kantor.id
  peranKantor: "KORKOT" | "ASMAN_DATA" | "OPERATOR" | "OFFICE_BOY",
  provinsi: "Sumatera Barat",
  kota: "Padang"
}
```

### Field admin (`role: admin`)

```javascript
{
  assignmentType: null,
  canManageKelurahan: true,
  canManageUsers: true,
  canViewReports: true
}
```

---

## `attendances`

```javascript
{
  id: string,
  userId: string,
  userName: string,
  userRole: "field_staff" | "office_staff",

  // Lokasi penugasan (denormalized)
  assignmentType: "kelurahan" | "kantor",
  kelurahanId: string | null,
  kelurahanNama: string | null,
  jenisTenagaAhli: string | null,   // TA_PERSAMP | TA_KELEMBAGAAN
  kantorId: string | null,
  peranKantor: string | null,       // KORKOT | ASMAN_DATA | OPERATOR | OFFICE_BOY

  // Absensi
  date: "2026-07-09",               // YYYY-MM-DD
  checkIn: Timestamp,
  checkOut: Timestamp | null,
  checkInPhoto: string,             // Storage URL
  checkOutPhoto: string | null,

  // GPS
  location: {
    lat: number,
    lng: number,
    accuracy: number
  },
  assignedLocation: {               // titik yang divalidasi
    lat: number,
    lng: number,
    radius: number
  },
  distance: number,                 // meter dari titik penugasan
  isWithinRadius: boolean,

  // Status
  status: "ontime" | "late" | "outside_radius" | "manual",
  createdAt: Timestamp
}
```

---

## `projectConfig`

Singleton document: `projectConfig/settings`

```javascript
{
  projectName: "ISWMP SumBar-Padang",
  provinsi: "Sumatera Barat",
  kota: "Padang",
  workStartHour: 8,
  workStartMinute: 0,
  lateThresholdMinutes: 15,
  requirePhoto: true,
  requireCheckOut: false,             // fase awal: check-in saja
  kantorGeofenceActive: false,        // true setelah koordinat kantor diisi
  totalKelurahan: 11,
  totalFieldStaff: 22,
  totalOfficeStaff: 4,
  updatedAt: Timestamp
}
```

---

## Relasi Data

```
kelurahan (11)
    └── users.field_staff (22) ──→ attendances

kantor (1)
    └── users.office_staff (5) ──→ attendances

users.admin (1-2) ──→ read all attendances
```

---

## Index Firestore yang Dibutuhkan

```
attendances: date ASC, kelurahanId ASC
attendances: date ASC, userId ASC
attendances: date ASC, assignmentType ASC
users: role ASC, accountStatus ASC
users: kelurahanId ASC, jenisTenagaAhli ASC
users: kantorId ASC, peranKantor ASC
```

---

## Migrasi dari Parent Project

| Parent field | ISWMP field |
|--------------|-------------|
| `department` | `jenisTenagaAhli` atau `peranKantor` |
| `position` | *(dihapus / diganti)* |
| `nik`, `employeeId` | *(opsional, tidak wajib fase awal)* |
| `leaveBalance` | *(tidak digunakan)* |
| `bpjsNumber` | *(tidak digunakan)* |
| Single office env | `kelurahan` + `kantor` collections |
