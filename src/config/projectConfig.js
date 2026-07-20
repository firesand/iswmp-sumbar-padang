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
};

export const getAppUrl = () => PROJECT.appUrl;
export const getAdminUrl = () => `${PROJECT.appUrl}${PROJECT.adminPath}`;

// Modul yang tidak dipakai di ISWMP (fokus crosscheck kehadiran)
export const FEATURES = {
  payroll: false,
  leave: false,
  locationUpdate: false,
  selfRegistration: true,
  checkOut: false,
};
