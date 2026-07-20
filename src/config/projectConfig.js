// ISWMP SumBar-Padang — project configuration & feature flags

export const PROJECT = {
  name: 'ISWMP SumBar-Padang',
  shortName: 'ISWMP Padang',
  description: 'Sistem Absensi & Crosscheck Kehadiran — ISWMP Kota Padang',
  organization: 'ISWMP Sumatera Barat',
  developer: 'Hikmahtiar Studio',
  year: 2026,
  /** URL publik aplikasi (Firebase Hosting) */
  appUrl: 'https://iswmp-sumbar-padang.web.app',
  adminPath: '/admin',
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
