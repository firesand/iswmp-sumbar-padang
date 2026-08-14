// ISWMP SumBar-Padang — project configuration & feature flags

export const PROJECT = {
  name: 'ISWMP SumBar-Padang',
  shortName: 'ISWMP Padang',
  fullName: 'Integrated Solid Waste Management Project — Sumatera Barat, Kota Padang',
  description: 'Sistem Absensi & Crosscheck Kehadiran — ISWMP Kota Padang',
  organization: 'ISWMP Sumatera Barat',
  ministry: 'Kementerian Pekerjaan Umum',
  ministryShort: 'Kementerian PU',
  developer: 'Hikmahtiar Studio',
  year: 2026,
  /** URL publik aplikasi (Firebase Hosting) */
  appUrl: 'https://iswmp-sumbar-padang.web.app',
  adminPath: '/admin',
  /** Brand assets di /public */
  logoMinistry: '/logo-kementerian-pu.svg',
  logoMinistryWordmark: '/logo-kementerian-pu-dark.png',
  logoApp: '/logo192.png',
  logoAppFallback: '/logo.png',
  partnerBrand: 'Surya Abadi',
};

export const getAppUrl = () => PROJECT.appUrl;
export const getAdminUrl = () => `${PROJECT.appUrl}${PROJECT.adminPath}`;

// Periode kontrak/SPK. Laporan bulanan memakai anchor tanggal mulai kontrak
// (13 Juli 2026), bukan tanggal 1 kalender: periode ke-n berjalan dari tanggal
// 13 sampai tanggal 12 bulan berikutnya, dan periode terakhir dipotong di hari
// ke-300 kontrak (8 Mei 2027).
export const CONTRACT = {
  /** Tanggal mulai kontrak/SPK, "YYYY-MM-DD" WIB. Hari ke-1 kontrak. */
  startDate: '2026-07-13',
  /** Total masa kontrak dalam hari kalender, inklusif tanggal mulai. */
  durationDays: 300,
  label: 'SPK ISWMP SumBar-Padang',
};

// Modul yang tidak dipakai di ISWMP (fokus crosscheck kehadiran)
export const FEATURES = {
  payroll: false,
  leave: false,
  locationUpdate: false,
  selfRegistration: true,
  checkOut: false,
};
