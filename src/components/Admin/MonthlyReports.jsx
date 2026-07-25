// src/components/Admin/MonthlyReports.jsx
import { useState } from 'react';
import { db } from '../../config/firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { sendMonthlyReportWhatsApp } from '../../services/whatsappService';
import { sendMonthlyReport } from '../../services/emailService';
import {
  createExcelHyperlink,
  downloadExcelWorkbook,
} from '../../utils/excelExport';
import {
  isAttendanceWorkflowEligible,
  isLocationPhotoAttendance,
  isReviewableAttendancePhoto,
  isVerifiedAttendance,
} from '../../utils/attendanceIntegrity';
import {
  ATTENDANCE_TIMEZONE,
  getWibDateString,
} from '../../utils/attendanceTime';
import {
  getAttendanceErrorMessage,
  getAttendancePhotoUrl,
} from '../../services/attendanceService';
import {
  formatAttendanceWibDateTime,
  getAttendanceLocationLabel,
  getCanonicalEarlyLeaveDetails,
  isCrossDayAttendance,
} from '../../utils/attendanceDisplay';
import {
  attachEffectiveAttendanceCorrection,
  resolveAttendanceCompletion,
} from '../../utils/attendanceCorrection';

const attachCorrectionViews = async (records) => {
  const projectionSnapshots = await Promise.all(
    records.map((record) => getDoc(doc(
      db,
      'attendanceCorrectionEffectiveViews',
      record.id
    )))
  );
  return records.map((record, index) =>
    attachEffectiveAttendanceCorrection(
      record,
      projectionSnapshots[index].exists()
        ? projectionSnapshots[index].data()
        : null
    )
  );
};

const getEffectiveCompletionRecord = (record, completion) => ({
  ...record,
  checkOut: completion.isComplete ? completion.checkOut : null,
  workHours: completion.isComplete ? completion.workHours : 0,
});

const getCompletionSourceLabel = (record, completion) => {
  if (isLocationPhotoAttendance(record)) {
    return completion.isComplete
      ? 'GPS + photo'
      : 'open GPS + photo shift';
  }
  if (!isVerifiedAttendance(record)) return 'unverified / legacy';
  if (completion.manualCorrection) {
    return 'administrative correction (not device verified)';
  }
  if (completion.deviceVerified) return 'verified device';
  return 'open';
};

const formatDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getCoordinates = (location) => {
  if (!location || typeof location !== 'object') return null;

  const lat = Number(location.lat);
  const lng = Number(location.lng);
  const isValid = Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180
    && !(lat === 0 && lng === 0);

  return isValid ? { lat, lng } : null;
};

const getGoogleMapsUrl = (location) => {
  const coordinates = getCoordinates(location);
  if (!coordinates) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(`${coordinates.lat},${coordinates.lng}`)}`;
};

const getAccuracyValue = (location, fallbackAccuracy = null) => {
  const accuracy = Number(location?.accuracy ?? fallbackAccuracy);
  return Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null;
};

const getTimestampDate = (timestamp) => {
  if (!timestamp) return null;
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

function MonthlyReports() {
  const [currentWibYear, currentWibMonth] = getWibDateString()
    .split('-')
    .map(Number);
  const [selectedMonth, setSelectedMonth] = useState(currentWibMonth);
  const [selectedYear, setSelectedYear] = useState(currentWibYear);
  const [reportData, setReportData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [attendanceData, setAttendanceData] = useState([]);

  const handleOpenAttendancePhoto = async (attendance, action) => {
    if (!isReviewableAttendancePhoto(attendance, action)) {
      alert('Bukti legacy atau tidak terverifikasi tidak dapat dibuka.');
      return;
    }

    const preview = window.open('', '_blank');
    if (preview) {
      preview.opener = null;
      preview.document.title = 'Memuat bukti absensi…';
      preview.document.body.textContent = 'Memuat bukti absensi…';
    }
    try {
      const { url } = await getAttendancePhotoUrl(attendance.id, action);
      if (preview) preview.location.replace(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      preview?.close();
      alert(getAttendanceErrorMessage(error));
    }
  };

  const fetchEmployees = async () => {
    const snapshot = await getDocs(collection(db, 'users'));
    return snapshot.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
      .filter(employee => (
        employee.role !== 'admin' &&
        employee.accountStatus === 'active' &&
        employee.isActive === true
      ));
  };

  const generateReport = async () => {
    setLoading(true);
    try {
      const employees = await fetchEmployees();

      // Get date range for selected month
      const startDate = new Date(selectedYear, selectedMonth - 1, 1);
      const endDate = new Date(selectedYear, selectedMonth, 0);

      // Use local calendar dates so WIB does not lose the last day of a month.
      const startDateStr = formatDateKey(startDate);
      const endDateStr = formatDateKey(endDate);

      // Fetch attendance records for the month
      const attendanceQuery = query(
        collection(db, 'attendances'),
        where('date', '>=', startDateStr),
        where('date', '<=', endDateStr),
        orderBy('date', 'asc')
      );

      const attendanceSnapshot = await getDocs(attendanceQuery);
      const employeeById = new Map(employees.map(employee => [employee.id, employee]));
      const canonicalAttendances = attendanceSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        userName: doc.data().userName
          || employeeById.get(doc.data().userId)?.name
          || 'Unknown Employee'
      }));
      const attendances = await attachCorrectionViews(canonicalAttendances);

      setAttendanceData(attendances);
      const operationalAttendances = attendances.filter(
        isAttendanceWorkflowEligible
      );
      const locationPhotoAttendances = operationalAttendances.filter(
        isLocationPhotoAttendance
      );

      // Process data for report
      const employeeAttendance = {};
      const dailyAttendance = {};
      let totalLate = 0;
      let totalOnTime = 0;
      let totalAbsent = 0;
      let totalEarlyLeave = 0;
      let totalCrossDayShifts = 0;
      let totalManualCorrections = 0;

      // Initialize employee attendance tracking
      employees.forEach(emp => {
        employeeAttendance[emp.id] = {
          name: emp.name,
          email: emp.email,
          department: emp.department || 'N/A',
          position: emp.position || 'N/A',
          presentDays: 0,
          lateDays: 0,
          absentDays: 0,
          earlyLeaveDays: 0,
          crossDayShifts: 0,
          manualCorrections: 0,
          totalWorkHours: 0,
          attendanceRate: 0,
          records: []
        };
      });

      // Calculate working days (exclude weekends)
      let workingDays = 0;
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const day = d.getDay();
        if (day !== 0 && day !== 6) { // Not Sunday or Saturday
          workingDays++;
          const dateStr = formatDateKey(d);
          dailyAttendance[dateStr] = {
            present: 0,
            late: 0,
            absent: 0
          };
        }
      }

      // Process attendance records (deduplicate by employeeId+date)
      const seenPerDay = new Set();
      const earlyLeaveCountedPerDay = new Set();
      const hoursCountedPerDay = new Set();
      operationalAttendances.forEach(record => {
        const empId = record.userId;
        const date = record.date;
        const key = `${empId}__${date}`;
        const completion = resolveAttendanceCompletion(record);
        const effectiveRecord = getEffectiveCompletionRecord(
          record,
          completion
        );
        const earlyLeave = getCanonicalEarlyLeaveDetails(record);

        if (!employeeAttendance[empId]) return;

        // Count only first record for a given employee on a given date
        if (!seenPerDay.has(key)) {
          seenPerDay.add(key);
          employeeAttendance[empId].presentDays++;
          if (record.status === 'late') {
            employeeAttendance[empId].lateDays++;
            totalLate++;
          } else {
            totalOnTime++;
          }

          if (dailyAttendance[date]) {
            dailyAttendance[date].present++;
            if (record.status === 'late') dailyAttendance[date].late++;
          }
        }

        // Regardless of deduplication, keep the record list for details/exports
        employeeAttendance[empId].records.push(record);

        if (earlyLeave.isEarlyLeave && !earlyLeaveCountedPerDay.has(key)) {
          employeeAttendance[empId].earlyLeaveDays++;
          totalEarlyLeave++;
          earlyLeaveCountedPerDay.add(key);
        }
        if (completion.manualCorrection) {
          employeeAttendance[empId].manualCorrections++;
          totalManualCorrections++;
        }
        if (completion.isComplete && isCrossDayAttendance(effectiveRecord)) {
          employeeAttendance[empId].crossDayShifts++;
          totalCrossDayShifts++;
        }

        // Recorded GPS/photo completion may contribute operational reporting,
        // but remains separate from Verified v2/payroll assurance.
        if (completion.isComplete && !hoursCountedPerDay.has(key)) {
          const hours = Number(completion.workHours);
          if (Number.isFinite(hours) && hours >= 0) {
            employeeAttendance[empId].totalWorkHours += hours;
          }
          hoursCountedPerDay.add(key);
        }
      });

      // Calculate absent days and attendance rate
      Object.keys(employeeAttendance).forEach(empId => {
        const emp = employeeAttendance[empId];
        emp.absentDays = workingDays - emp.presentDays;
        emp.attendanceRate = workingDays > 0
          ? ((emp.presentDays / workingDays) * 100).toFixed(1)
          : 0;
        totalAbsent += emp.absentDays;
      });

      // Find perfect attendance
      const perfectAttendance = Object.values(employeeAttendance).filter(
        emp => emp.presentDays === workingDays && emp.lateDays === 0
      );

      // Find most punctual employees
      const mostPunctual = Object.values(employeeAttendance)
        .sort((a, b) => a.lateDays - b.lateDays)
        .slice(0, 5);

      // Calculate averages
      const totalEmployees = employees.length;
      const avgAttendance = totalEmployees > 0
        ? (Object.values(employeeAttendance).reduce((sum, emp) =>
            sum + parseFloat(emp.attendanceRate), 0) / totalEmployees).toFixed(1)
        : 0;

      const avgWorkHours = totalEmployees > 0
        ? (Object.values(employeeAttendance).reduce((sum, emp) =>
            sum + emp.totalWorkHours, 0) / (totalEmployees * workingDays)).toFixed(1)
        : 0;

      // Compile report data
      const report = {
        month: getMonthName(selectedMonth),
        year: selectedYear,
        period: `${startDateStr} - ${endDateStr}`,
        totalEmployees,
        totalWorkDays: workingDays,
        totalAttendanceRecords: operationalAttendances.length,
        verifiedAttendanceRecords:
          operationalAttendances.length - locationPhotoAttendances.length,
        locationPhotoAttendanceRecords: locationPhotoAttendances.length,
        unverifiedAttendanceRecords:
          attendances.length - operationalAttendances.length,
        invalidCorrectionProjections: attendances.filter(
          record => record.correctionProjectionInvalid
        ).length,
        totalPresent: totalOnTime + totalLate,
        totalOnTime,
        totalLate,
        totalAbsent,
        totalEarlyLeave,
        totalCrossDayShifts,
        totalManualCorrections,
        avgAttendance: `${avgAttendance}%`,
        avgWorkHours: `${avgWorkHours} hours`,
        perfectAttendance,
        mostPunctual,
        employeeDetails: Object.values(employeeAttendance),
        dailyBreakdown: dailyAttendance,
        generatedAt: new Date().toLocaleString('id-ID', {
          timeZone: ATTENDANCE_TIMEZONE,
        })
      };

      setReportData(report);
    } catch (error) {
      console.error('Error generating report:', error);
      alert('Failed to generate report');
    } finally {
      setLoading(false);
    }
  };

  const exportToExcel = async () => {
    if (!reportData) {
      alert('Please generate report first');
      return;
    }

    // Sheet 1: Summary
    const summaryData = [
      ['MONTHLY ATTENDANCE REPORT'],
      [''],
      ['Period', `${reportData.month} ${reportData.year}`],
      ['Date Range', reportData.period],
      ['Generated', reportData.generatedAt],
      [''],
      ['SUMMARY STATISTICS'],
      ['Total Employees', reportData.totalEmployees],
      ['Working Days', reportData.totalWorkDays],
      ['Total Attendance Records', reportData.totalAttendanceRecords],
      ['Verified v2 Records', reportData.verifiedAttendanceRecords],
      [
        'GPS + Photo Records',
        reportData.locationPhotoAttendanceRecords
      ],
      ['Unverified / Legacy Records', reportData.unverifiedAttendanceRecords],
      [''],
      ['Average Recorded Attendance Rate', reportData.avgAttendance],
      ['Average Work Hours/Day', reportData.avgWorkHours],
      ['Total On Time', reportData.totalOnTime],
      ['Total Late', reportData.totalLate],
      ['Total Absent Days', reportData.totalAbsent],
      ['Canonical Early Leave', reportData.totalEarlyLeave],
      ['Cross-Day Shifts', reportData.totalCrossDayShifts],
      [
        'Approved Manual Corrections (not device verified)',
        reportData.totalManualCorrections
      ],
      [
        'Rejected Invalid Correction Projections',
        reportData.invalidCorrectionProjections
      ],
      [''],
      [
        'Complete Recorded Attendance Count (Verified + GPS/photo)',
        reportData.perfectAttendance.length
      ]
    ];
    // Sheet 2: Employee Details
    const employeeHeaders = [
      'Name', 'Email', 'Department', 'Position',
      'Present Days', 'Late Days', 'Absent Days',
      'Canonical Early Leave', 'Cross-Day Shifts', 'Manual Corrections',
      'Recorded Attendance Rate (%)', 'Total Work Hours'
    ];
    const employeeRows = reportData.employeeDetails.map(emp => [
      emp.name,
      emp.email,
      emp.department,
      emp.position,
      emp.presentDays,
      emp.lateDays,
      emp.absentDays,
      emp.earlyLeaveDays,
      emp.crossDayShifts,
      emp.manualCorrections,
      emp.attendanceRate,
      emp.totalWorkHours.toFixed(2)
    ]);
    const employeeData = [employeeHeaders, ...employeeRows];

    // Sheet 3: Daily Attendance Records
    const attendanceHeaders = [
      'Shift Date', 'Employee Name', 'Check In (WIB)',
      'Stored Check Out (WIB)', 'Effective Check Out (WIB)',
      'Cross-Day', 'Status', 'Raw verificationStatus',
      'Attendance Mode', 'Check-In Assurance', 'Manual Correction',
      'Completion Source', 'Device-Verified Completion', 'Work Hours',
      'Early Leave (Canonical)', 'Early Leave Reason',
      'Check In Photo', 'Check Out Photo',
      'Check In Latitude', 'Check In Longitude', 'Check In Accuracy (m)', 'Check In Google Maps',
      'Check Out Latitude', 'Check Out Longitude', 'Check Out Accuracy (m)', 'Check Out Google Maps',
      'Assigned Location', 'Distance from Assigned Location (m)'
    ];
    const attendanceRows = attendanceData.map(record => {
      const checkIn = getTimestampDate(record.checkIn);
      const storedCheckOut = getTimestampDate(record.checkOut);
      const completion = resolveAttendanceCompletion(record);
      const effectiveCheckOut = completion.isComplete
        ? getTimestampDate(completion.checkOut)
        : null;
      const effectiveRecord = getEffectiveCompletionRecord(
        record,
        completion
      );
      const checkInCoordinates = getCoordinates(record.checkInLocation);
      const checkOutCoordinates = getCoordinates(record.checkOutLocation);
      const checkInMapsUrl = getGoogleMapsUrl(record.checkInLocation);
      const checkOutMapsUrl = getGoogleMapsUrl(record.checkOutLocation);
      const verified = isVerifiedAttendance(record);
      const locationPhoto = isLocationPhotoAttendance(record);
      const hasCheckInProof = isReviewableAttendancePhoto(record, 'checkIn');
      const hasCheckOutProof = isReviewableAttendancePhoto(record, 'checkOut');
      const hasBlockedCheckInReference = Boolean(
        record.checkInPhoto || (!hasCheckInProof && record.checkInPhotoPath)
      );
      const hasBlockedCheckOutReference = Boolean(
        record.checkOutPhoto || (!hasCheckOutProof && record.checkOutPhotoPath)
      );
      const earlyLeave = getCanonicalEarlyLeaveDetails(record);

      return [
        record.date,
        record.userName,
        formatAttendanceWibDateTime(checkIn, 'N/A'),
        formatAttendanceWibDateTime(storedCheckOut, 'N/A'),
        formatAttendanceWibDateTime(effectiveCheckOut, 'Open'),
        completion.isComplete
          ? isCrossDayAttendance(effectiveRecord) ? 'Yes' : 'No'
          : 'N/A',
        record.status === 'ontime' ? 'On Time' : 'Late',
        record.verificationStatus || 'missing',
        verified
          ? record.verificationMode || 'geofence_onsite'
          : locationPhoto
            ? 'location_photo'
            : 'legacy',
        verified
          ? 'Verified v2'
          : locationPhoto
            ? 'GPS + photo'
            : 'Unverified / legacy',
        completion.manualCorrection ? 'Yes — administrative' : 'No',
        verified || locationPhoto
          ? completion.completionSource
          : 'unverified-legacy',
        completion.deviceVerified ? 'Yes' : 'No',
        completion.isComplete ? completion.workHours : 'N/A',
        earlyLeave.isEarlyLeave ? 'Yes' : 'No',
        earlyLeave.isEarlyLeave
          ? earlyLeave.reason || 'Reason unavailable'
          : '',
        hasCheckInProof
          ? verified
            ? 'Verified protected proof (open in app)'
            : 'Protected GPS/photo proof (open in app)'
          : hasBlockedCheckInReference ? 'Unverified / legacy proof blocked' : 'N/A',
        hasCheckOutProof
          ? verified
            ? 'Verified protected proof (open in app)'
            : 'Protected GPS/photo proof (open in app)'
          : hasBlockedCheckOutReference ? 'Unverified / legacy proof blocked' : 'N/A',
        checkInCoordinates?.lat ?? 'N/A',
        checkInCoordinates?.lng ?? 'N/A',
        getAccuracyValue(record.checkInLocation, record.locationAccuracy) ?? 'N/A',
        createExcelHyperlink('Open Check In Location', checkInMapsUrl),
        checkOutCoordinates?.lat ?? 'N/A',
        checkOutCoordinates?.lng ?? 'N/A',
        getAccuracyValue(record.checkOutLocation) ?? 'N/A',
        createExcelHyperlink('Open Check Out Location', checkOutMapsUrl),
        getAttendanceLocationLabel(record, { fallback: 'N/A' }),
        record.distanceFromGeofence != null &&
          Number.isFinite(Number(record.distanceFromGeofence))
          ? Number(record.distanceFromGeofence).toFixed(1)
          : 'N/A'
      ];
    });
    const attendanceSheetData = [attendanceHeaders, ...attendanceRows];
    const wideAttendanceColumns = new Set([
      'Check In (WIB)',
      'Stored Check Out (WIB)',
      'Effective Check Out (WIB)',
      'Completion Source',
      'Early Leave Reason',
      'Check In Photo',
      'Check Out Photo',
      'Check In Google Maps',
      'Check Out Google Maps',
    ]);
    const attendancePreferredWidths = attendanceHeaders.map((header) => (
      wideAttendanceColumns.has(header)
        ? 24
        : Math.max(12, Math.min(header.length + 2, 22))
    ));
    const sheets = [
      {
        data: summaryData,
        sheet: 'Summary',
      },
      {
        data: employeeData,
        sheet: 'Employee Details',
        stickyRowsCount: 1,
      },
      {
        data: attendanceSheetData,
        preferredWidths: attendancePreferredWidths,
        sheet: 'Attendance Records',
        stickyRowsCount: 1,
      },
    ];

    // Sheet 4: complete operational records (not necessarily Verified v2).
    if (reportData.perfectAttendance.length > 0) {
      const perfectHeaders = ['Name', 'Email', 'Department', 'Position'];
      const perfectRows = reportData.perfectAttendance.map(emp => [
        emp.name, emp.email, emp.department, emp.position
      ]);
      sheets.push({
        data: [perfectHeaders, ...perfectRows],
        sheet: 'Complete Recorded',
        stickyRowsCount: 1,
      });
    }

    // Save file
    const fileName = `Attendance_Report_${reportData.month}_${reportData.year}.xlsx`;
    try {
      await downloadExcelWorkbook(sheets, fileName);
      alert(`Report exported successfully as ${fileName}`);
    } catch (error) {
      console.error('Error exporting report:', error);
      alert('Failed to export report');
    }
  };

  const sendReportNotifications = async () => {
    if (!reportData) {
      alert('Please generate report first');
      return;
    }

    const adminPhone = '081234567890'; // Replace with actual admin phone
    const adminEmail = 'admin@suryaabadi.com'; // Replace with actual admin email

    try {
      // Send WhatsApp notification
      sendMonthlyReportWhatsApp(adminPhone, reportData);

      // Send Email notification if configured
      const emailResult = await sendMonthlyReport(adminEmail, {
        ...reportData,
        recipientName: 'Admin'
      });

      if (emailResult.success) {
        alert('✅ Report notifications sent successfully!');
      } else {
        alert('⚠️ WhatsApp opened, but email failed. Please check email configuration.');
      }
    } catch (error) {
      console.error('Error sending notifications:', error);
      alert('Failed to send notifications');
    }
  };

  const getMonthName = (month) => {
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return months[month - 1];
  };

  return (
    <div className="space-y-6">
      {/* Report Controls */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <h2 className="text-xl font-bold text-gray-800 mb-4">📊 Monthly Attendance Report</h2>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Month</label>
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
            >
              {[...Array(12)].map((_, i) => (
                <option key={i + 1} value={i + 1}>
                  {getMonthName(i + 1)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Year</label>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(parseInt(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
            >
              {[2024, 2025, 2026].map(year => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <button
              onClick={generateReport}
              disabled={loading}
              className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Generating...' : 'Generate Report'}
            </button>
          </div>

          <div className="flex items-end space-x-2">
            <button
              onClick={exportToExcel}
              disabled={!reportData}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              📥 Export
            </button>
            <button
              onClick={sendReportNotifications}
              disabled={!reportData}
              className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              📨 Send
            </button>
          </div>
        </div>
      </div>

      {/* Report Display */}
      {reportData && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-4">
            <div className="bg-white rounded-lg shadow-md p-4">
              <p className="text-sm text-gray-600">Total Employees</p>
              <p className="text-2xl font-bold text-gray-800">{reportData.totalEmployees}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4">
              <p className="text-sm text-gray-600">Working Days</p>
              <p className="text-2xl font-bold text-gray-800">{reportData.totalWorkDays}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4">
              <p className="text-sm text-gray-600">Avg Attendance</p>
              <p className="text-2xl font-bold text-green-600">{reportData.avgAttendance}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4">
              <p className="text-sm text-gray-600">Total Late</p>
              <p className="text-2xl font-bold text-orange-600">{reportData.totalLate}</p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4">
              <p className="text-sm text-gray-600">Pulang Awal</p>
              <p className="text-2xl font-bold text-orange-700">
                {reportData.totalEarlyLeave}
              </p>
              <p className="mt-1 text-[10px] text-gray-500">
                Penanda canonical
              </p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4">
              <p className="text-sm text-gray-600">Cross-Day Shifts</p>
              <p className="text-2xl font-bold text-cyan-700">
                {reportData.totalCrossDayShifts}
              </p>
            </div>
            <div className="bg-white rounded-lg shadow-md p-4">
              <p className="text-sm text-gray-600">Manual Corrections</p>
              <p className="text-2xl font-bold text-amber-700">
                {reportData.totalManualCorrections}
              </p>
              <p className="mt-1 text-[10px] text-gray-500">
                Administratif; bukan verifikasi perangkat
              </p>
            </div>
          </div>

          {reportData.invalidCorrectionProjections > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {reportData.invalidCorrectionProjections} projection koreksi
              ditolak karena tidak lolos validasi dan tidak dihitung.
            </div>
          )}

          {/* Complete operational attendance, including GPS/photo records. */}
          {reportData.perfectAttendance.length > 0 && (
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">
                Catatan Kehadiran Lengkap ({reportData.perfectAttendance.length})
              </h3>
              <p className="mb-4 text-xs text-gray-500">
                Dihitung dari record operasional yang lengkap.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {reportData.perfectAttendance.map((emp, index) => (
                  <div key={index} className="flex items-center space-x-3 p-3 bg-green-50 rounded-lg">
                    <div className="w-10 h-10 bg-green-600 rounded-full flex items-center justify-center">
                      <span className="text-white font-semibold">
                        {emp.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <p className="font-medium text-gray-800">{emp.name}</p>
                      <p className="text-sm text-gray-600">{emp.department}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Employee Details Table */}
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Employee Attendance Details</h3>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Employee</th>
                    <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Present</th>
                    <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Late</th>
                    <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Absent</th>
                    <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Pulang Awal</th>
                    <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Cross-Day</th>
                    <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Manual</th>
                    <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Rate</th>
                    <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Avg Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {reportData.employeeDetails.map((emp, index) => (
                    <tr key={index} className="border-b hover:bg-gray-50">
                      <td className="py-3 px-4">
                        <div>
                          <p className="font-medium text-gray-800">{emp.name}</p>
                          <p className="text-xs text-gray-500">{emp.department}</p>
                        </div>
                      </td>
                      <td className="text-center py-3 px-4">
                        <span className="text-green-600 font-medium">{emp.presentDays}</span>
                      </td>
                      <td className="text-center py-3 px-4">
                        <span className="text-orange-600 font-medium">{emp.lateDays}</span>
                      </td>
                      <td className="text-center py-3 px-4">
                        <span className="text-red-600 font-medium">{emp.absentDays}</span>
                      </td>
                      <td className="text-center py-3 px-4 text-orange-700">
                        {emp.earlyLeaveDays}
                      </td>
                      <td className="text-center py-3 px-4 text-cyan-700">
                        {emp.crossDayShifts}
                      </td>
                      <td
                        className="text-center py-3 px-4 text-amber-700"
                        title="Koreksi administratif; bukan verifikasi perangkat"
                      >
                        {emp.manualCorrections}
                      </td>
                      <td className="text-center py-3 px-4">
                        <span className={`font-medium ${
                          parseFloat(emp.attendanceRate) >= 90 ? 'text-green-600' :
                          parseFloat(emp.attendanceRate) >= 75 ? 'text-orange-600' :
                          'text-red-600'
                        }`}>
                          {emp.attendanceRate}%
                        </span>
                      </td>
                      <td className="text-center py-3 px-4 text-gray-600">
                        {emp.presentDays > 0
                          ? (emp.totalWorkHours / emp.presentDays).toFixed(1)
                          : '0'}h
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Daily photo and location evidence */}
          <div className="bg-white rounded-lg shadow-md p-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-gray-800">Daily Attendance Evidence</h3>
              <p className="text-sm text-gray-500">
                Foto dan titik GPS check-in/check-out untuk setiap catatan kehadiran pada periode laporan.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1250px]">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-left py-3 px-3 text-sm font-medium text-gray-700">Shift Date</th>
                    <th className="text-left py-3 px-3 text-sm font-medium text-gray-700">Employee</th>
                    <th className="text-left py-3 px-3 text-sm font-medium text-gray-700">Check In</th>
                    <th className="text-left py-3 px-3 text-sm font-medium text-gray-700">Check Out</th>
                    <th className="text-left py-3 px-3 text-sm font-medium text-gray-700">Status</th>
                    <th className="text-left py-3 px-3 text-sm font-medium text-gray-700">Completion</th>
                    <th className="text-left py-3 px-3 text-sm font-medium text-gray-700">Photos</th>
                    <th className="text-left py-3 px-3 text-sm font-medium text-gray-700">Locations</th>
                  </tr>
                </thead>
                <tbody>
                  {attendanceData.length > 0 ? (
                    attendanceData.map(record => {
                      const attendanceVerified = isVerifiedAttendance(record);
                      const attendanceLocationPhoto =
                        isLocationPhotoAttendance(record);
                      const completion = resolveAttendanceCompletion(record);
                      const effectiveRecord = getEffectiveCompletionRecord(
                        record,
                        completion
                      );
                      const canOpenCheckInPhoto =
                        isReviewableAttendancePhoto(record, 'checkIn');
                      const canOpenCheckOutPhoto =
                        isReviewableAttendancePhoto(record, 'checkOut');
                      const hasBlockedPhotoReference = Boolean(
                        record.checkInPhoto ||
                        record.checkOutPhoto ||
                        (!canOpenCheckInPhoto && record.checkInPhotoPath) ||
                        (!canOpenCheckOutPhoto && record.checkOutPhotoPath)
                      );
                      const checkInMapsUrl = getGoogleMapsUrl(record.checkInLocation);
                      const checkOutMapsUrl = getGoogleMapsUrl(record.checkOutLocation);
                      const checkInAccuracy = getAccuracyValue(
                        record.checkInLocation,
                        record.locationAccuracy
                      );
                      const checkOutAccuracy = getAccuracyValue(record.checkOutLocation);
                      const distance = record.distanceFromGeofence == null
                        ? null
                        : Number(record.distanceFromGeofence);
                      const assignmentName =
                        getAttendanceLocationLabel(record) || null;
                      const earlyLeave =
                        getCanonicalEarlyLeaveDetails(record);

                      return (
                        <tr key={record.id} className="border-b align-top hover:bg-gray-50">
                          <td className="py-3 px-3 text-sm text-gray-700">{record.date || '-'}</td>
                          <td className="py-3 px-3">
                            <p className="font-medium text-gray-800">{record.userName}</p>
                            <span className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              attendanceVerified
                                ? 'bg-emerald-100 text-emerald-800'
                                : attendanceLocationPhoto
                                  ? 'bg-amber-100 text-amber-900'
                                : 'bg-red-100 text-red-800'
                            }`}>
                              {attendanceVerified
                                ? 'Check-in Verified v2'
                                : attendanceLocationPhoto
                                  ? 'GPS + foto'
                                : 'Unverified / legacy'}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-sm text-gray-600">
                            {formatAttendanceWibDateTime(record.checkIn)}
                          </td>
                          <td className="py-3 px-3 text-sm text-gray-600">
                            {completion.isComplete
                              ? formatAttendanceWibDateTime(completion.checkOut)
                              : 'Belum selesai'}
                            {completion.isComplete &&
                              isCrossDayAttendance(effectiveRecord) && (
                              <span className="mt-1 block text-xs font-medium text-blue-700">
                                Lintas hari
                              </span>
                            )}
                            {completion.manualCorrection && (
                              <span className="mt-1 block text-xs font-medium text-amber-700">
                                Koreksi manual
                              </span>
                            )}
                            {earlyLeave.isEarlyLeave && (
                              <span className="mt-1 block max-w-[260px] text-xs text-orange-800">
                                <span className="font-semibold">Pulang awal</span>
                                {' — '}
                                <span title={earlyLeave.reason || 'Alasan tidak tersedia'}>
                                  {earlyLeave.reason || 'Alasan tidak tersedia'}
                                </span>
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3">
                            <span className={`inline-block rounded-full px-2 py-1 text-xs font-medium ${
                              record.status === 'ontime'
                                ? 'bg-green-100 text-green-800'
                                : 'bg-yellow-100 text-yellow-800'
                            }`}>
                              {record.status === 'ontime' ? 'On Time' : 'Late'}
                            </span>
                          </td>
                          <td className="py-3 px-3">
                            <span className={`inline-block rounded px-2 py-1 text-xs font-medium ${
                              completion.deviceVerified
                                ? 'bg-emerald-100 text-emerald-800'
                                : completion.manualCorrection
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-gray-100 text-gray-700'
                            }`}>
                              {completion.deviceVerified
                                ? 'Perangkat terverifikasi'
                                : completion.manualCorrection
                                  ? 'Administratif — bukan verifikasi perangkat'
                                  : getCompletionSourceLabel(record, completion)}
                            </span>
                          </td>
                          <td className="py-3 px-3">
                            <div className="flex gap-3">
                              {canOpenCheckInPhoto && (
                                <button
                                  type="button"
                                  onClick={() => handleOpenAttendancePhoto(record, 'checkIn')}
                                  className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                                >
                                  Foto masuk
                                </button>
                              )}
                              {canOpenCheckOutPhoto && (
                                <button
                                  type="button"
                                  onClick={() => handleOpenAttendancePhoto(record, 'checkOut')}
                                  className="rounded bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
                                >
                                  Foto pulang
                                </button>
                              )}
                              {hasBlockedPhotoReference && (
                                <span className="text-xs text-red-600" title="URL/foto non-canonical diblokir">
                                  Bukti tidak valid diblokir
                                </span>
                              )}
                              {!canOpenCheckInPhoto &&
                                !canOpenCheckOutPhoto &&
                                !hasBlockedPhotoReference && (
                                <span className="text-xs text-gray-400">Tidak ada foto</span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-3">
                            <div className="flex flex-col items-start gap-1">
                              {checkInMapsUrl && (
                                <a
                                  href={checkInMapsUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                                >
                                  📍 Masuk {checkInAccuracy != null && `(±${checkInAccuracy} m)`}
                                </a>
                              )}
                              {checkOutMapsUrl && (
                                <a
                                  href={checkOutMapsUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="rounded bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
                                >
                                  📍 Pulang {checkOutAccuracy != null && `(±${checkOutAccuracy} m)`}
                                </a>
                              )}
                              {!checkInMapsUrl && !checkOutMapsUrl && (
                                <span className="text-xs text-gray-400">Tidak ada lokasi</span>
                              )}
                              {assignmentName && (
                                <span className="max-w-[220px] truncate text-xs text-gray-500" title={assignmentName}>
                                  Penugasan: {assignmentName}
                                </span>
                              )}
                              {distance != null && Number.isFinite(distance) && (
                                <span className="text-xs text-gray-500">Jarak saat masuk: {Math.round(distance)} m</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan="8" className="py-8 text-center text-gray-500">
                        Tidak ada catatan absensi pada periode ini.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default MonthlyReports;
