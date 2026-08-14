// src/config/adminConfig.js
// Admin Configuration for WhatsApp and Email notifications — ISWMP SumBar-Padang

import { PROJECT, getAppUrl, getAdminUrl } from './projectConfig';

// Canonical Firebase Auth account that receives private operational notices.
// Use the UID rather than role/email so project admins do not inherit them.
export const PRIVATE_ATTENDANCE_NOTICE_ADMIN_UID =
  'TJBS6DIyhcbcGxOtoxdCXLQeFYq1';

export const ADMIN_CONFIG = {
  // ⚠️ UPDATE nomor/email kontak admin proyek bila berubah
  phone: '08118062231',
  contactEmail: 'firesand@gmail.com',
  name: 'Admin ISWMP Padang',

  whatsapp: {
    enabled: true,
    defaultMessage: `Halo! Ini pesan dari ${PROJECT.name} — sistem absensi & crosscheck kehadiran.`,
    businessName: PROJECT.organization,
    businessUrl: getAppUrl(),
  },

  email: {
    enabled: true,
    fromName: `Admin ${PROJECT.shortName}`,
    fromEmail: 'noreply@iswmp-sumbar-padang.web.app',
    replyTo: 'firesand@gmail.com',
  },

  notifications: {
    sendLateAlerts: true,
    sendDailyReminders: true,
    sendApprovalNotifications: true,
    sendRejectionNotifications: true,
  },
};

export const WHATSAPP_TEMPLATES = {
  dailyReminder: (employeeName) => `
Pagi ${employeeName}!

*Reminder Check-in Hari Ini — ${PROJECT.shortName}*

Jam Kerja: 08:00 - 16:00 WIB (Batas On-Time Check-In: 08:10 WIB)
Jangan lupa check-in tepat waktu + foto selfie + GPS aktif.

Login / check-in:
${getAppUrl()}

*${ADMIN_CONFIG.whatsapp.businessName}*
`.trim(),

  approval: (employeeName, employeeEmail) => `
*SELAMAT ${employeeName}!*

Registrasi Anda di *${PROJECT.shortName}* telah *DISETUJUI*.

*Informasi Login:*
• Email: ${employeeEmail}
• Password: (yang Anda daftarkan)
• Status: Aktif

Login sekarang:
${getAppUrl()}

Silakan login dan mulai check-in sesuai jadwal kerja.

Jam Kerja:
• Check-in: 08:00 - 08:10 WIB (On-Time)
• Check-out: Mulai 16:00 WIB

Terima kasih,
*${ADMIN_CONFIG.whatsapp.businessName}*
`.trim(),

  rejection: (employeeName) => `
Halo ${employeeName},

Mohon maaf, registrasi Anda di ${PROJECT.shortName} belum dapat disetujui.

Silakan hubungi admin untuk informasi lebih lanjut.

Kontak:
• WhatsApp: ${ADMIN_CONFIG.phone}
• Email: ${ADMIN_CONFIG.contactEmail}

Terima kasih,
*${ADMIN_CONFIG.whatsapp.businessName}*
`.trim(),

  lateAlert: (employeeName, checkInTime) => `
*LATE CHECK-IN ALERT — ${PROJECT.shortName}*

Employee: *${employeeName}*
Check-in Time: ${checkInTime}
Status: *LATE*

Expected: On-time maksimal 08:10 WIB
Actual: ${checkInTime}

Dashboard admin:
${getAdminUrl()}

*Sistem otomatis ${PROJECT.shortName}*
`.trim(),
};

export const EMAIL_TEMPLATES = {
  dailyReminder: (employeeName) => ({
    subject: `Reminder Check-in — ${PROJECT.shortName}`,
    body: `
Halo ${employeeName}!

Jangan lupa check-in hari ini.
Jam kerja: 08:00 - 16:00 WIB (Batas On-Time: 08:10 WIB).

Login di: ${getAppUrl()}

Terima kasih,
${ADMIN_CONFIG.email.fromName}
`.trim(),
  }),

  approval: (employeeName, employeeEmail) => ({
    subject: `Registrasi Disetujui — ${PROJECT.shortName}`,
    body: `
Selamat ${employeeName}!

Registrasi Anda di ${PROJECT.name} telah DISETUJUI.

Anda sekarang dapat login menggunakan:
Email: ${employeeEmail}
Password: (yang telah Anda daftarkan)

Login di: ${getAppUrl()}

Terima kasih,
${ADMIN_CONFIG.email.fromName}
`.trim(),
  }),

  rejection: (employeeName) => ({
    subject: `Registrasi Ditolak — ${PROJECT.shortName}`,
    body: `
Halo ${employeeName},

Mohon maaf, registrasi Anda belum dapat disetujui.
Silakan hubungi admin untuk informasi lebih lanjut.

Kontak:
Email: ${ADMIN_CONFIG.contactEmail}
WhatsApp: ${ADMIN_CONFIG.phone}

Terima kasih,
${ADMIN_CONFIG.email.fromName}
`.trim(),
  }),
};

export const validateAdminConfig = () => {
  const errors = [];

  if (!ADMIN_CONFIG.phone) {
    errors.push('Nomor admin belum diisi di src/config/adminConfig.js');
  }

  if (!ADMIN_CONFIG.contactEmail) {
    errors.push('Email admin belum diisi di src/config/adminConfig.js');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

export default ADMIN_CONFIG;
