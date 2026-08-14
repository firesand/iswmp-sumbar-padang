// src/services/whatsappService.js

/**
 * WhatsApp Notification Service
 * Simple implementation using WhatsApp Web Link (FREE)
 */

import { PROJECT, getAppUrl, getAdminUrl } from '../config/projectConfig';
import { ADMIN_CONFIG, WHATSAPP_TEMPLATES } from '../config/adminConfig';

export const formatPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return '';

  // Keep digits only
  let cleaned = String(phoneNumber).replace(/\D/g, '');

  // 62xxxxxxxxxx already OK
  if (cleaned.startsWith('62')) {
    return cleaned;
  }

  // 08xxxxxxxxxx → 628xxxxxxxxxx
  if (cleaned.startsWith('0')) {
    return '62' + cleaned.substring(1);
  }

  // 8xxxxxxxxxx (common in Excel / forms) → 628xxxxxxxxxx
  if (cleaned.startsWith('8') && cleaned.length >= 9 && cleaned.length <= 13) {
    return '62' + cleaned;
  }

  return cleaned;
};

export const sendWhatsAppDirect = (phoneNumber, message) => {
  const formattedNumber = formatPhoneNumber(phoneNumber);
  if (!formattedNumber) {
    throw new Error('Nomor WhatsApp kosong atau tidak valid');
  }

  const waLink = `https://wa.me/${formattedNumber}?text=${encodeURIComponent(message)}`;
  const opened = window.open(waLink, '_blank');
  if (!opened) {
    // Popup blocked — still return link so UI can show it
    console.warn('Popup blocked for WhatsApp link:', waLink);
  }
  return waLink;
};

export const notifyApprovalViaWhatsApp = (employeeData, status = 'approved') => {
  const phone = employeeData.phoneNumber || employeeData.phone;
  const name = employeeData.name || employeeData.displayName || 'User';
  const message =
    status === 'approved'
      ? WHATSAPP_TEMPLATES.approval(name, employeeData.email)
      : WHATSAPP_TEMPLATES.rejection(name);

  return sendWhatsAppDirect(phone, message);
};

export const notifyLateCheckIn = (adminPhone, employeeName, checkInTime) => {
  const message = WHATSAPP_TEMPLATES.lateAlert(employeeName, checkInTime);
  return sendWhatsAppDirect(adminPhone, message);
};

export const sendDailyReminder = (phoneNumber, name) => {
  const message = WHATSAPP_TEMPLATES.dailyReminder(name);
  return sendWhatsAppDirect(phoneNumber, message);
};

export const sendMonthlyReportWhatsApp = (phoneNumber, reportSummary) => {
  const message = `
*LAPORAN BULANAN ATTENDANCE — ${PROJECT.shortName}*
${reportSummary.periodLabel || `${reportSummary.month} ${reportSummary.year}`}${reportSummary.contractDayEnd
    ? `\nHari kontrak ke-${reportSummary.contractDayStart} s/d ke-${reportSummary.contractDayEnd}`
    : ''}

*RINGKASAN:*
• Total Karyawan: ${reportSummary.totalEmployees}
• Hari Kerja: ${reportSummary.totalWorkDays} hari
• Rata-rata Kehadiran: ${reportSummary.avgAttendance}

*STATISTIK:*
• Total Hadir: ${reportSummary.totalPresent || 0}
• Tepat Waktu: ${reportSummary.totalOnTime || 0}
• Terlambat: ${reportSummary.totalLate || 0}
• Tidak Hadir: ${reportSummary.totalAbsent || 0}

Dashboard:
${getAdminUrl()}

*${ADMIN_CONFIG.whatsapp.businessName}*
Generated: ${new Date().toLocaleString('id-ID')}
`.trim();

  return sendWhatsAppDirect(phoneNumber, message);
};

export const sendBulkWhatsApp = async (recipients, messageTemplate) => {
  const results = [];

  for (let index = 0; index < recipients.length; index++) {
    const recipient = recipients[index];
    try {
      const personalizedMessage = messageTemplate.replace(/\{name\}/g, recipient.name || 'User');
      const link = sendWhatsAppDirect(recipient.phone, personalizedMessage);
      results.push({
        recipient: recipient.name,
        phone: recipient.phone,
        status: 'sent',
        link,
      });
    } catch (error) {
      results.push({
        recipient: recipient.name,
        phone: recipient.phone,
        status: 'failed',
        error: error.message,
      });
    }

    // Give WhatsApp / browser time between tabs (also reduces popup-block bursts)
    if (index < recipients.length - 1) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  return results;
};

export const generateWhatsAppQR = (phoneNumber, message) => {
  const formattedNumber = formatPhoneNumber(phoneNumber);
  const waLink = `https://wa.me/${formattedNumber}?text=${encodeURIComponent(message)}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(waLink)}`;
};

export const messageTemplates = {
  approval: {
    subject: 'Registrasi Disetujui',
    template: `Selamat {name}! Registrasi Anda di ${PROJECT.shortName} telah disetujui. Silakan login di: ${getAppUrl()}`,
  },
  rejection: {
    subject: 'Registrasi Ditolak',
    template: `Halo {name}, mohon maaf registrasi Anda belum dapat disetujui. Silakan hubungi admin ${PROJECT.shortName}.`,
  },
  reminder: {
    subject: 'Reminder Check-in',
    template: `Pagi {name}! Jangan lupa check-in hari ini. Jam kerja: 08:00-16:00 WIB (Batas on-time: 08:10 WIB) — ${getAppUrl()}`,
  },
  late: {
    subject: 'Alert Keterlambatan',
    template: `Alert: Ada check-in terlambat. Cek dashboard: ${getAdminUrl()}`,
  },
};

export const createNotificationSystem = (adminPhone) => ({
  notifyApproval: (registration, status) => {
    notifyApprovalViaWhatsApp(registration, status);
  },
  notifyLate: (employeeName, checkInTime) => {
    notifyLateCheckIn(adminPhone, employeeName, checkInTime);
  },
  sendReminder: (phoneNumber, name) => {
    sendDailyReminder(phoneNumber, name);
  },
});

export default {
  sendWhatsAppDirect,
  notifyApprovalViaWhatsApp,
  notifyLateCheckIn,
  sendDailyReminder,
  sendMonthlyReportWhatsApp,
  sendBulkWhatsApp,
  formatPhoneNumber,
  generateWhatsAppQR,
  messageTemplates,
  createNotificationSystem,
};
