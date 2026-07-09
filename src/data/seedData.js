// Master seed data — ISWMP SumBar-Padang
// Sumber: Kelurahan ISWMP Padang.pdf (9 Jul 2026)

export const KELURAHAN_SEED = [
  { id: 'kel-alang-laweh', nama: 'Alang Laweh', kecamatan: 'Padang Selatan' },
  { id: 'kel-rawang', nama: 'Rawang', kecamatan: 'Padang Selatan' },
  { id: 'kel-lubuk-begalung', nama: 'Lubuk Begalung', kecamatan: 'Padang Timur' },
  { id: 'kel-tanjung-aur', nama: 'Tanjung Aur', kecamatan: 'Lubuk Begalung' },
  { id: 'kel-surau-gadang', nama: 'Surau Gadang', kecamatan: 'Nanggalo' },
  { id: 'kel-lubuk-buaya', nama: 'Lubuk Buaya', kecamatan: 'Koto Tangah' },
  { id: 'kel-parupuak-tabing', nama: 'Parupuak Tabing', kecamatan: 'Koto Tangah' },
  { id: 'kel-rimbo-kaluang', nama: 'Rimbo Kaluang', kecamatan: 'Padang Barat' },
  { id: 'kel-berok-nipah', nama: 'Berok Nipah', kecamatan: 'Padang Barat' },
  { id: 'kel-batang-arau', nama: 'Batang Arau', kecamatan: 'Padang Selatan' },
  { id: 'kel-kampung-pondok', nama: 'Kampung Pondok', kecamatan: 'Padang Barat' },
];

export const KANTOR_SEED = {
  id: 'kantor-padang-kota',
  nama: 'Kantor ISWMP Kota Padang',
  alamat: null,
  kota: 'Padang',
  provinsi: 'Sumatera Barat',
  lat: null,
  lng: null,
  radius: 200,
  isActive: false,
  catatan: 'Koordinat kantor belum ditentukan',
};

export const PROJECT_CONFIG_SEED = {
  id: 'default',
  namaProyek: 'ISWMP SumBar-Padang',
  jamCheckInDeadline: '08:00',
  timezone: 'Asia/Jakarta',
  geofenceTransitionMode: true,
  defaultKelurahanRadius: 300,
  defaultKantorRadius: 200,
};
