// src/services/emailService.js
import emailjs from '@emailjs/browser';
import { PROJECT, getAppUrl, getAdminUrl } from '../config/projectConfig';
import { ADMIN_CONFIG } from '../config/adminConfig';

// ============================================
// EMAILJS CONFIGURATION
// ============================================

// Initialize EmailJS - Call this once in your App.jsx
export const initEmailJS = () => {
  // Replace with your actual Public Key from EmailJS Dashboard
  emailjs.init('YOUR_EMAILJS_PUBLIC_KEY');
  console.log('EmailJS initialized');
};

// EmailJS Credentials (Get from https://www.emailjs.com/dashboard)
const EMAILJS_SERVICE_ID = 'YOUR_SERVICE_ID'; // e.g., 'service_abc123'
const EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID'; // e.g., 'template_xyz789'

// ============================================
// EMAIL NOTIFICATION FUNCTIONS
// ============================================

// Send approval/rejection email
export const sendApprovalEmail = async (userData, status = 'approved') => {
  const templateParams = {
    to_name: userData.name,
    to_email: userData.email,
    from_name: ADMIN_CONFIG.email.fromName,
    status: status === 'approved' ? 'DISETUJUI' : 'DITOLAK',
    user_email: userData.email,
    login_url: getAppUrl(),
    message: status === 'approved'
      ? `Selamat! Registrasi Anda di ${PROJECT.shortName} telah disetujui. Anda sekarang dapat login menggunakan email dan password yang telah didaftarkan.`
      : `Mohon maaf, registrasi Anda belum dapat disetujui. Silakan hubungi admin ${PROJECT.shortName} untuk informasi lebih lanjut.`,
    approved: status === 'approved'
  };

  try {
    const response = await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ID,
      templateParams
    );
    console.log('Email sent successfully:', response);
    return { success: true, response };
  } catch (error) {
    console.error('Email sending failed:', error);
    return { success: false, error };
  }
};

// Send late check-in alert to admin
export const sendLateAlert = async (adminEmail, employeeData) => {
  const templateParams = {
    to_email: adminEmail,
    to_name: 'Admin',
    employee_name: employeeData.name,
    check_in_time: employeeData.checkInTime,
    date: new Date().toLocaleDateString('id-ID'),
    department: employeeData.department || 'N/A',
    message: `${employeeData.name} telah melakukan check-in terlambat pada pukul ${employeeData.checkInTime}.`
  };

  try {
    const response = await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ID,
      templateParams
    );
    return { success: true, response };
  } catch (error) {
    console.error('Late alert email failed:', error);
    return { success: false, error };
  }
};

// Send daily reminder email
export const sendDailyReminder = async (employeeEmail, employeeName) => {
  const templateParams = {
    to_email: employeeEmail,
    to_name: employeeName,
    date: new Date().toLocaleDateString('id-ID'),
    office_hours: '08:00 - 16:00',
    login_url: getAppUrl(),
    message: `Pengingat: Jangan lupa untuk melakukan check-in hari ini di ${PROJECT.shortName}. Jam kerja: 08:00 - 16:00 WIB (Batas on-time: 08:10 WIB).`
  };

  try {
    const response = await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ID,
      templateParams
    );
    return { success: true, response };
  } catch (error) {
    console.error('Daily reminder email failed:', error);
    return { success: false, error };
  }
};

// Send monthly report email
export const sendMonthlyReport = async (recipientEmail, reportData) => {
  const templateParams = {
    to_email: recipientEmail,
    to_name: reportData.recipientName,
    month: reportData.month,
    year: reportData.year,
    // Periode kontrak/SPK — laporan tidak lagi memakai bulan kalender penuh.
    period_label: reportData.periodLabel || `${reportData.month} ${reportData.year}`,
    period_range: reportData.periodRange || reportData.period,
    period_start: reportData.periodStartDate,
    period_end: reportData.periodEndDate,
    contract_label: reportData.contractLabel,
    contract_day_start: reportData.contractDayStart,
    contract_day_end: reportData.contractDayEnd,
    total_employees: reportData.totalEmployees,
    total_work_days: reportData.totalWorkDays,
    avg_attendance: reportData.avgAttendance,
    total_late: reportData.totalLate,
    perfect_attendance_count: reportData.perfectAttendance?.length || 0,
    dashboard_url: getAdminUrl(),
    message: `Laporan attendance ${reportData.periodLabel || `${reportData.month} ${reportData.year}`} telah tersedia.`
  };

  try {
    const response = await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ID,
      templateParams
    );
    console.log('Monthly report email sent:', response);
    return { success: true, response };
  } catch (error) {
    console.error('Monthly report email failed:', error);
    return { success: false, error };
  }
};

// Send payroll data email
export const sendPayrollEmail = async (recipientEmail, recipientName, payrollData) => {
  const templateParams = {
    to_email: recipientEmail,
    to_name: recipientName,
    employee_name: payrollData.employeeInfo.name,
    employee_nik: payrollData.employeeInfo.nik,
    employee_department: payrollData.employeeInfo.department,
    employee_position: payrollData.employeeInfo.position,
    period_month: payrollData.period.monthName,
    period_year: payrollData.period.year,
    base_salary: payrollData.salary.baseSalary.toLocaleString('id-ID'),
    work_days: payrollData.salary.workDays,
    total_hours: payrollData.salary.totalHours,
    regular_hours: payrollData.salary.regularHours,
    overtime_hours: payrollData.salary.overtimeHours,
    regular_pay: payrollData.salary.regularPay.toLocaleString('id-ID'),
    overtime_pay: payrollData.salary.overtimePay.toLocaleString('id-ID'),
    total_salary: payrollData.salary.totalSalary.toLocaleString('id-ID'),
    deductions: payrollData.salary.deductions.toLocaleString('id-ID'),
    net_salary: payrollData.salary.netSalary.toLocaleString('id-ID'),
    message: `Data payroll ${payrollData.period.monthName} ${payrollData.period.year} untuk ${payrollData.employeeInfo.name} telah disiapkan.`
  };

  try {
    const response = await emailjs.send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ID,
      templateParams
    );
    console.log('Payroll email sent:', response);
    return { success: true, response };
  } catch (error) {
    console.error('Payroll email failed:', error);
    return { success: false, error };
  }
};

// ============================================
// SIMPLE MAILTO FALLBACK
// ============================================

export const sendEmailSimple = (email, subject, body) => {
  const mailtoLink = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailtoLink;
};

// Generate approval email with mailto
export const generateApprovalMailto = (userData, status = 'approved') => {
  const subject = `Registrasi ${status === 'approved' ? 'Disetujui' : 'Ditolak'} — ${PROJECT.shortName}`;

  const body = status === 'approved'
    ? `Halo ${userData.name},

Selamat! Registrasi Anda di ${PROJECT.name} telah DISETUJUI.

Anda sekarang dapat login menggunakan:
Email: ${userData.email}
Password: (yang telah Anda daftarkan)

Login di: ${getAppUrl()}

Terima kasih,
${ADMIN_CONFIG.email.fromName}`
    : `Halo ${userData.name},

Mohon maaf, registrasi Anda belum dapat disetujui.
Silakan hubungi admin ${PROJECT.shortName} untuk informasi lebih lanjut.

Terima kasih,
${ADMIN_CONFIG.email.fromName}`;

  sendEmailSimple(userData.email, subject, body);
};

// ============================================
// BULK EMAIL FUNCTIONS
// ============================================

export const sendBulkEmails = async (recipients, subject, messageTemplate) => {
  const results = [];

  for (const recipient of recipients) {
    // Personalize message
    const personalizedMessage = messageTemplate
      .replace('{name}', recipient.name)
      .replace('{email}', recipient.email)
      .replace('{department}', recipient.department || 'N/A');

    const templateParams = {
      to_email: recipient.email,
      to_name: recipient.name,
      subject: subject,
      message: personalizedMessage
    };

    try {
      const response = await emailjs.send(
        EMAILJS_SERVICE_ID,
        EMAILJS_TEMPLATE_ID,
        templateParams
      );
      results.push({
        recipient: recipient.email,
        success: true,
        response
      });
    } catch (error) {
      results.push({
        recipient: recipient.email,
        success: false,
        error
      });
    }

    // Add delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return results;
};

// ============================================
// EMAIL TEMPLATE CONFIGURATIONS
// ============================================

export const emailTemplates = {
  approval: {
    subject: `Registrasi Disetujui — ${PROJECT.shortName}`,
    body: `Selamat! Registrasi Anda telah disetujui. Login sekarang di: ${getAppUrl()}`
  },
  rejection: {
    subject: `Registrasi Ditolak — ${PROJECT.shortName}`,
    body: `Mohon maaf, registrasi Anda belum dapat disetujui. Silakan hubungi admin untuk informasi lebih lanjut.`
  },
  reminder: {
    subject: `Reminder: Check-in Hari Ini — ${PROJECT.shortName}`,
    body: `Jangan lupa untuk melakukan check-in hari ini. Jam kerja: 08:00 - 16:00 WIB (Batas on-time: 08:10 WIB). Login: ${getAppUrl()}`
  },
  late: {
    subject: `Alert: Late Check-in — ${PROJECT.shortName}`,
    body: `Ada karyawan yang terlambat check-in. Silakan cek dashboard untuk detail: ${getAdminUrl()}`
  },
  monthlyReport: {
    subject: `Laporan Bulanan Attendance — ${PROJECT.shortName}`,
    body: `Laporan attendance bulanan telah tersedia. Silakan cek dashboard admin: ${getAdminUrl()}`
  }
};

// ============================================
// COMBINED NOTIFICATION SERVICE
// ============================================

export const sendNotification = async (type, userData, options = {}) => {
  const results = {
    email: null,
    whatsapp: null
  };

  // Send email if EmailJS is configured
  if (EMAILJS_SERVICE_ID !== 'YOUR_SERVICE_ID') {
    try {
      switch (type) {
        case 'approval':
          results.email = await sendApprovalEmail(userData, 'approved');
          break;
        case 'rejection':
          results.email = await sendApprovalEmail(userData, 'rejected');
          break;
        case 'reminder':
          results.email = await sendDailyReminder(userData.email, userData.name);
          break;
        case 'late':
          results.email = await sendLateAlert(options.adminEmail, userData);
          break;
        case 'report':
          results.email = await sendMonthlyReport(userData.email, options.reportData);
          break;
        case 'payroll':
          results.email = await sendPayrollEmail(userData.email, userData.name, options.payrollData);
          break;
        default:
          console.log('Unknown notification type:', type);
      }
    } catch (error) {
      console.error('Email notification failed:', error);
    }
  } else {
    // Fallback to mailto if EmailJS not configured
    generateApprovalMailto(userData, type === 'approval' ? 'approved' : 'rejected');
  }

  return results;
};
