// src/services/whatsappService.js

/**
 * WhatsApp Notification Service
 * Simple implementation using WhatsApp Web Link (FREE)
 */

import { PROJECT, getAppUrl, getAdminUrl } from '../config/projectConfig';
import { ADMIN_CONFIG, WHATSAPP_TEMPLATES } from '../config/adminConfig';

export const sendWhatsAppDirect = (phoneNumber, message) => {
  const formattedNumber = phoneNumber.startsWith('0')
    ? '62' + phoneNumber.substring(1)
    : phoneNumber.startsWith('+')
      ? phoneNumber.substring(1)
      : phoneNumber;

  const waLink = `https://wa.me/${formattedNumber}?text=${encodeURIComponent(message)}`;
  window.open(waLink, '_blank');
  return waLink;
};

export const notifyApprovalViaWhatsApp = (employeeData, status = 'approved') => {
  const message =
    status === 'approved'
      ? WHATSAPP_TEMPLATES.approval(employeeData.name, employeeData.email)
      : WHATSAPP_TEMPLATES.rejection(employeeData.name);

  return sendWhatsAppDirect(employeeData.phoneNumber, message);
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
${reportSummary.month} ${reportSummary.year}

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

export const sendBulkWhatsApp = (recipients, messageTemplate) => {
  const results = [];
  let successCount = 0;

  recipients.forEach((recipient, index) => {
    setTimeout(() => {
      try {
        const personalizedMessage = messageTemplate.replace('{name}', recipient.name);
        const link = sendWhatsAppDirect(recipient.phone, personalizedMessage);
        results.push({
          recipient: recipient.name,
          phone: recipient.phone,
          status: 'sent',
          link,
        });
        successCount++;
        console.log(`Sent ${successCount}/${recipients.length} messages`);
      } catch (error) {
        results.push({
          recipient: recipient.name,
          phone: recipient.phone,
          status: 'failed',
          error: error.message,
        });
      }
    }, index * 2000);
  });

  return results;
};

export const formatPhoneNumber = (phoneNumber) => {
  let cleaned = phoneNumber.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.substring(1);
  } else if (!cleaned.startsWith('62')) {
    cleaned = '62' + cleaned;
  }
  return cleaned;
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
    template: `Pagi {name}! Jangan lupa check-in hari ini. Jam kerja: 08:00-17:00 WIB — ${getAppUrl()}`,
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
