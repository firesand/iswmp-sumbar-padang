// src/components/Admin/AttendanceRecap.jsx
import React, { useState, useEffect } from 'react';
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
import { isVerifiedAttendance } from '../../utils/attendanceIntegrity';
import { downloadExcelWorkbook } from '../../utils/excelExport';
import {
  getWibDateString,
} from '../../utils/attendanceTime';
import {
  classifyAttendanceCheckout,
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

const formatDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

function AttendanceRecap() {
  const [currentWibYear, currentWibMonth] = getWibDateString()
    .split('-')
    .map(Number);
  const [selectedMonth, setSelectedMonth] = useState(currentWibMonth);
  const [selectedYear, setSelectedYear] = useState(currentWibYear);
  const [selectedDepartment, setSelectedDepartment] = useState('all');
  const [viewMode, setViewMode] = useState('summary'); // summary, detailed, calendar, analytics
  const [reportData, setReportData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState(['all']);

  // Fetch initial data
  useEffect(() => {
    fetchEmployees();
  }, []);

  const fetchEmployees = async () => {
    try {
      const employeesQuery = query(
        collection(db, 'users'),
        where('role', '==', 'employee'),
        where('accountStatus', '==', 'active')
      );
      const snapshot = await getDocs(employeesQuery);
      const employeesList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setEmployees(employeesList);

      // Extract unique departments
      const uniqueDepts = [...new Set(employeesList.map(emp => emp.department).filter(Boolean))];
      setDepartments(['all', ...uniqueDepts]);
    } catch (error) {
      console.error('Error fetching employees:', error);
    }
  };

  const generateReport = async () => {
    setLoading(true);
    try {
      const startDate = new Date(selectedYear, selectedMonth - 1, 1);
      const endDate = new Date(selectedYear, selectedMonth, 0);
      const startDateStr = formatDateKey(startDate);
      const endDateStr = formatDateKey(endDate);

      // Fetch attendance records
      const attendanceQuery = query(
        collection(db, 'attendances'),
        where('date', '>=', startDateStr),
        where('date', '<=', endDateStr),
        orderBy('date', 'asc')
      );

      const attendanceSnapshot = await getDocs(attendanceQuery);
      const canonicalAttendances = attendanceSnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }));
      const attendances = (await attachCorrectionViews(canonicalAttendances))
        .filter(isVerifiedAttendance);

      // Filter employees by department if needed
      let filteredEmployees = employees;
      if (selectedDepartment !== 'all') {
        filteredEmployees = employees.filter(emp => emp.department === selectedDepartment);
      }

      // Process data
      const processedData = processAttendanceData(
        attendances,
        filteredEmployees,
        startDate,
        endDate
      );

      setReportData(processedData);
    } catch (error) {
      console.error('Error generating report:', error);
      alert('Failed to generate report');
    } finally {
      setLoading(false);
    }
  };

  const processAttendanceData = (attendances, employees, startDate, endDate) => {
    // Calculate working days
    let workingDays = 0;
    const dateList = [];

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) { // Exclude weekends
        workingDays++;
        dateList.push(formatDateKey(d));
      }
    }

    // Initialize employee data
    const employeeData = {};
    employees.forEach(emp => {
      employeeData[emp.id] = {
        id: emp.id,
        name: emp.name,
        employeeId: emp.employeeId || emp.nik,
        department: emp.department || '-',
        position: emp.position || '-',
        email: emp.email,
        phone: emp.phoneNumber || '-',
        totalPresent: 0,
        totalOnTime: 0,
        totalLate: 0,
        totalAbsent: 0,
        totalEarlyLeave: 0,
        totalOvertime: 0,
        totalCrossDayShifts: 0,
        totalManualCorrections: 0,
        totalDeviceVerifiedCompletions: 0,
        totalOpenShifts: 0,
        invalidCorrectionProjections: 0,
        totalWorkHours: 0,
        attendanceRate: 0,
        punctualityRate: 0,
        dailyRecords: {},
        performance: 'Good' // Will be calculated
      };
    });

    // Process each attendance record
    attendances.forEach(record => {
      const empId = record.userId;
      if (employeeData[empId]) {
        const emp = employeeData[empId];
        const completion = resolveAttendanceCompletion(record);
        const effectiveRecord = getEffectiveCompletionRecord(
          record,
          completion
        );
        const earlyLeave = getCanonicalEarlyLeaveDetails(record);
        emp.totalPresent++;

        if (record.status === 'late') {
          emp.totalLate++;
        } else {
          emp.totalOnTime++;
        }

        if (record.correctionProjectionInvalid) {
          emp.invalidCorrectionProjections++;
        }
        if (completion.manualCorrection) {
          emp.totalManualCorrections++;
        } else if (completion.deviceVerified) {
          emp.totalDeviceVerifiedCompletions++;
        } else {
          emp.totalOpenShifts++;
        }

        // Only validated completion sources may affect work-hour and
        // checkout-derived metrics.
        if (completion.isComplete) {
          const hours = Number(completion.workHours);
          if (Number.isFinite(hours) && hours >= 0) {
            emp.totalWorkHours += hours;
          }

          const checkoutClassification =
            classifyAttendanceCheckout(effectiveRecord);
          if (checkoutClassification.crossDay) {
            // Without a shift schedule, 00:xx cannot be interpreted as early
            // leave or overtime. Track it separately instead.
            emp.totalCrossDayShifts++;
          } else {
            if (checkoutClassification.overtime) {
              emp.totalOvertime++;
            }
          }
        }
        if (earlyLeave.isEarlyLeave) {
          emp.totalEarlyLeave++;
        }

        // Store daily record
        emp.dailyRecords[record.date] = {
          checkIn: record.checkIn,
          checkOut: completion.isComplete ? completion.checkOut : null,
          status: record.status,
          workHours: completion.isComplete ? completion.workHours : 0,
          crossDay: completion.isComplete &&
            isCrossDayAttendance(effectiveRecord),
          completionSource: completion.completionSource,
          locationLabel: getAttendanceLocationLabel(record),
          deviceVerified: completion.deviceVerified,
          isComplete: completion.isComplete,
          manualCorrection: completion.manualCorrection,
          earlyLeave: earlyLeave.isEarlyLeave,
          earlyLeaveReason: earlyLeave.reason,
        };
      }
    });

    // Calculate final metrics for each employee
    Object.values(employeeData).forEach(emp => {
      emp.totalAbsent = workingDays - emp.totalPresent;
      emp.attendanceRate = workingDays > 0
        ? ((emp.totalPresent / workingDays) * 100).toFixed(1)
        : 0;
      emp.punctualityRate = emp.totalPresent > 0
        ? ((emp.totalOnTime / emp.totalPresent) * 100).toFixed(1)
        : 0;
      emp.avgWorkHours = emp.totalPresent > 0
        ? (emp.totalWorkHours / emp.totalPresent).toFixed(1)
        : 0;

      // Calculate performance rating
      if (emp.attendanceRate >= 95 && emp.punctualityRate >= 90) {
        emp.performance = 'Excellent';
      } else if (emp.attendanceRate >= 90 && emp.punctualityRate >= 80) {
        emp.performance = 'Very Good';
      } else if (emp.attendanceRate >= 85 && emp.punctualityRate >= 70) {
        emp.performance = 'Good';
      } else if (emp.attendanceRate >= 80) {
        emp.performance = 'Fair';
      } else {
        emp.performance = 'Needs Improvement';
      }
    });

    // Calculate summary statistics
    const totalEmployees = employees.length;
    const avgAttendanceRate = totalEmployees > 0
      ? (Object.values(employeeData).reduce((sum, emp) =>
          sum + parseFloat(emp.attendanceRate), 0) / totalEmployees).toFixed(1)
      : 0;

    const avgPunctualityRate = totalEmployees > 0
      ? (Object.values(employeeData).reduce((sum, emp) =>
          sum + parseFloat(emp.punctualityRate), 0) / totalEmployees).toFixed(1)
      : 0;

    const startStr = formatDateKey(new Date(startDate));
    const endStr = formatDateKey(new Date(endDate));

    return {
      month: getMonthName(selectedMonth),
      year: selectedYear,
      department: selectedDepartment === 'all' ? 'All Departments' : selectedDepartment,
      period: `${startStr} - ${endStr}`,
      workingDays,
      dateList,
      summary: {
        totalEmployees,
        avgAttendanceRate,
        avgPunctualityRate,
        totalPresent: Object.values(employeeData).reduce((sum, emp) => sum + emp.totalPresent, 0),
        totalAbsent: Object.values(employeeData).reduce((sum, emp) => sum + emp.totalAbsent, 0),
        totalLate: Object.values(employeeData).reduce((sum, emp) => sum + emp.totalLate, 0),
        totalOnTime: Object.values(employeeData).reduce((sum, emp) => sum + emp.totalOnTime, 0),
        totalEarlyLeave: Object.values(employeeData).reduce((sum, emp) => sum + emp.totalEarlyLeave, 0),
        totalOvertime: Object.values(employeeData).reduce((sum, emp) => sum + emp.totalOvertime, 0),
        totalCrossDayShifts: Object.values(employeeData).reduce(
          (sum, emp) => sum + emp.totalCrossDayShifts,
          0
        ),
        totalManualCorrections: Object.values(employeeData).reduce(
          (sum, emp) => sum + emp.totalManualCorrections,
          0
        ),
        totalDeviceVerifiedCompletions: Object.values(employeeData).reduce(
          (sum, emp) => sum + emp.totalDeviceVerifiedCompletions,
          0
        ),
        totalOpenShifts: Object.values(employeeData).reduce(
          (sum, emp) => sum + emp.totalOpenShifts,
          0
        ),
        invalidCorrectionProjections: Object.values(employeeData).reduce(
          (sum, emp) => sum + emp.invalidCorrectionProjections,
          0
        )
      },
      employees: Object.values(employeeData),
      topPerformers: Object.values(employeeData)
        .filter(emp => emp.performance === 'Excellent')
        .sort((a, b) => b.attendanceRate - a.attendanceRate)
        .slice(0, 5),
      needsAttention: Object.values(employeeData)
        .filter(emp => parseFloat(emp.attendanceRate) < 80)
        .sort((a, b) => a.attendanceRate - b.attendanceRate),
      perfectAttendance: Object.values(employeeData)
        .filter(emp => emp.totalAbsent === 0 && emp.totalLate === 0)
    };
  };

  const getMonthName = (month) => {
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return months[month - 1];
  };

  const getPerformanceColor = (performance) => {
    switch (performance) {
      case 'Excellent': return 'text-green-600 bg-green-50';
      case 'Very Good': return 'text-blue-600 bg-blue-50';
      case 'Good': return 'text-teal-600 bg-teal-50';
      case 'Fair': return 'text-yellow-600 bg-yellow-50';
      case 'Needs Improvement': return 'text-red-600 bg-red-50';
      default: return 'text-gray-600 bg-gray-50';
    }
  };

  const exportToExcel = async () => {
    if (!reportData) {
      alert('Please generate report first');
      return;
    }

    // Sheet 1: Executive Summary
    const summaryData = [
      ['ATTENDANCE REKAPITULASI REPORT'],
      [''],
      ['Period', `${reportData.month} ${reportData.year}`],
      ['Department', reportData.department],
      ['Working Days', reportData.workingDays],
      [''],
      ['OVERALL STATISTICS'],
      ['Total Employees', reportData.summary.totalEmployees],
      ['Average Attendance Rate', `${reportData.summary.avgAttendanceRate}%`],
      ['Average Punctuality Rate', `${reportData.summary.avgPunctualityRate}%`],
      [''],
      ['ATTENDANCE BREAKDOWN'],
      ['Total Present', reportData.summary.totalPresent],
      ['Total Absent', reportData.summary.totalAbsent],
      ['Total On Time', reportData.summary.totalOnTime],
      ['Total Late', reportData.summary.totalLate],
      ['Canonical Early Leave', reportData.summary.totalEarlyLeave],
      ['Total Overtime', reportData.summary.totalOvertime],
      ['Cross-Day Shifts (excluded from early/overtime)', reportData.summary.totalCrossDayShifts],
      ['Device-Verified Completions', reportData.summary.totalDeviceVerifiedCompletions],
      [
        'Approved Manual Corrections (not device verified)',
        reportData.summary.totalManualCorrections
      ],
      ['Open Verified Check-Ins', reportData.summary.totalOpenShifts],
      [
        'Rejected Invalid Correction Projections',
        reportData.summary.invalidCorrectionProjections
      ],
      [''],
      ['Perfect Attendance', reportData.perfectAttendance.length],
      ['Top Performers', reportData.topPerformers.length],
      ['Needs Attention', reportData.needsAttention.length]
    ];
    // Sheet 2: Employee Details
    const employeeHeaders = [
      'Employee ID', 'Name', 'Department', 'Position',
      'Present', 'Absent', 'On Time', 'Late', 'Early Leave', 'Overtime', 'Cross-Day Shifts',
      'Device-Verified Completions', 'Manual Corrections', 'Open Shifts',
      'Attendance %', 'Punctuality %', 'Avg Hours/Day', 'Performance'
    ];
    const employeeRows = reportData.employees.map(emp => [
      emp.employeeId,
      emp.name,
      emp.department,
      emp.position,
      emp.totalPresent,
      emp.totalAbsent,
      emp.totalOnTime,
      emp.totalLate,
      emp.totalEarlyLeave,
      emp.totalOvertime,
      emp.totalCrossDayShifts,
      emp.totalDeviceVerifiedCompletions,
      emp.totalManualCorrections,
      emp.totalOpenShifts,
      `${emp.attendanceRate}%`,
      `${emp.punctualityRate}%`,
      emp.avgWorkHours,
      emp.performance
    ]);
    const employeeData = [employeeHeaders, ...employeeRows];

    // Sheet 3: Daily Matrix
    const matrixHeaders = ['Employee Name', ...reportData.dateList];
    const matrixRows = reportData.employees.map(emp => {
      const row = [emp.name];
      reportData.dateList.forEach(date => {
        const record = emp.dailyRecords[date];
        if (record) {
          const attendanceCode = record.status === 'ontime' ? 'P' : 'L';
          const annotations = [];
          if (record.crossDay) annotations.push('Cross-Day');
          if (record.manualCorrection) {
            annotations.push('Manual Correction — not device verified');
          }
          if (record.earlyLeave) {
            annotations.push(
              `Early Leave — ${record.earlyLeaveReason || 'Reason unavailable'}`
            );
          }
          row.push(annotations.length > 0
            ? `${attendanceCode} (${annotations.join('; ')})`
            : attendanceCode);
        } else {
          row.push('A');
        }
      });
      return row;
    });
    const matrixData = [matrixHeaders, ...matrixRows];
    const completionHeaders = [
      'Shift Date',
      'Employee ID',
      'Employee Name',
      'Check In (WIB)',
      'Effective Check Out (WIB)',
      'Work Hours',
      'Cross-Day',
      'Manual Correction',
      'Completion Source',
      'Operational Location',
      'Device Verified',
      'Early Leave (Canonical)',
      'Early Leave Reason',
    ];
    const completionRows = reportData.employees.flatMap((emp) =>
      Object.entries(emp.dailyRecords)
        .sort(([leftDate], [rightDate]) =>
          leftDate.localeCompare(rightDate)
        )
        .map(([date, record]) => [
          date,
          emp.employeeId,
          emp.name,
          formatAttendanceWibDateTime(record.checkIn, 'N/A'),
          formatAttendanceWibDateTime(record.checkOut, 'Open'),
          record.isComplete ? record.workHours : 'N/A',
          record.isComplete ? record.crossDay ? 'Yes' : 'No' : 'N/A',
          record.manualCorrection ? 'Yes — administrative' : 'No',
          record.completionSource,
          record.locationLabel || '',
          record.deviceVerified ? 'Yes' : 'No',
          record.earlyLeave ? 'Yes' : 'No',
          record.earlyLeave
            ? record.earlyLeaveReason || 'Reason unavailable'
            : '',
        ])
    );
    const completionData = [completionHeaders, ...completionRows];

    // Save file
    const fileName = `Attendance_Recap_${reportData.month}_${reportData.year}_${reportData.department.replace(/\s+/g, '_')}.xlsx`;
    try {
      await downloadExcelWorkbook([
        {
          data: summaryData,
          sheet: 'Executive Summary',
        },
        {
          data: employeeData,
          sheet: 'Employee Details',
          stickyRowsCount: 1,
        },
        {
          data: matrixData,
          sheet: 'Daily Matrix',
          stickyRowsCount: 1,
          stickyColumnsCount: 1,
        },
        {
          data: completionData,
          preferredWidths: completionHeaders.map((header) =>
            header.includes('(WIB)') || header === 'Completion Source'
              ? 28
              : 18
          ),
          sheet: 'Completion Audit',
          stickyRowsCount: 1,
        },
      ], fileName);
    } catch (error) {
      console.error('Error exporting attendance recap:', error);
      alert('Failed to export attendance recap');
    }
  };

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      {/* Header Controls */}
      <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
        <h1 className="text-2xl font-bold text-gray-800 mb-6">📊 Rekapitulasi Kehadiran Karyawan</h1>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Month</label>
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
            >
              {[...Array(12)].map((_, i) => (
                <option key={i + 1} value={i + 1}>{getMonthName(i + 1)}</option>
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Department</label>
            <select
              value={selectedDepartment}
              onChange={(e) => setSelectedDepartment(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
            >
              {departments.map(dept => (
                <option key={dept} value={dept}>
                  {dept === 'all' ? 'All Departments' : dept}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <button
              onClick={generateReport}
              disabled={loading}
              className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              {loading ? 'Generating...' : '🔄 Generate'}
            </button>
          </div>

          <div className="flex items-end">
            <button
              onClick={exportToExcel}
              disabled={!reportData}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              📥 Export Excel
            </button>
          </div>
        </div>

        {/* View Mode Tabs */}
        <div className="flex space-x-4 border-t pt-4">
          <button
            onClick={() => setViewMode('summary')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              viewMode === 'summary'
                ? 'bg-green-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            📊 Summary
          </button>
          <button
            onClick={() => setViewMode('detailed')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              viewMode === 'detailed'
                ? 'bg-green-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            📋 Detailed
          </button>
          <button
            onClick={() => setViewMode('calendar')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              viewMode === 'calendar'
                ? 'bg-green-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            📅 Calendar View
          </button>
          <button
            onClick={() => setViewMode('analytics')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              viewMode === 'analytics'
                ? 'bg-green-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            📈 Analytics
          </button>
        </div>
      </div>

      {/* Report Content */}
      {reportData && (
        <>
          {/* Summary View */}
          {viewMode === 'summary' && (
            <div className="space-y-6">
              {/* Key Metrics */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-xl shadow-md p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Total Employees</p>
                      <p className="text-3xl font-bold text-gray-800">{reportData.summary.totalEmployees}</p>
                    </div>
                    <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                      <span className="text-2xl">👥</span>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-xl shadow-md p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Avg Attendance</p>
                      <p className="text-3xl font-bold text-green-600">{reportData.summary.avgAttendanceRate}%</p>
                    </div>
                    <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                      <span className="text-2xl">✅</span>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-xl shadow-md p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Avg Punctuality</p>
                      <p className="text-3xl font-bold text-blue-600">{reportData.summary.avgPunctualityRate}%</p>
                    </div>
                    <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                      <span className="text-2xl">⏰</span>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-xl shadow-md p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600">Perfect Attendance</p>
                      <p className="text-3xl font-bold text-purple-600">{reportData.perfectAttendance.length}</p>
                    </div>
                    <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                      <span className="text-2xl">🏆</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Attendance Breakdown */}
              <div className="bg-white rounded-xl shadow-md p-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">Attendance Breakdown</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4">
                  <div className="text-center p-4 bg-green-50 rounded-lg">
                    <p className="text-2xl font-bold text-green-600">{reportData.summary.totalPresent}</p>
                    <p className="text-sm text-gray-600">Total Present</p>
                  </div>
                  <div className="text-center p-4 bg-red-50 rounded-lg">
                    <p className="text-2xl font-bold text-red-600">{reportData.summary.totalAbsent}</p>
                    <p className="text-sm text-gray-600">Total Absent</p>
                  </div>
                  <div className="text-center p-4 bg-blue-50 rounded-lg">
                    <p className="text-2xl font-bold text-blue-600">{reportData.summary.totalOnTime}</p>
                    <p className="text-sm text-gray-600">On Time</p>
                  </div>
                  <div className="text-center p-4 bg-yellow-50 rounded-lg">
                    <p className="text-2xl font-bold text-yellow-600">{reportData.summary.totalLate}</p>
                    <p className="text-sm text-gray-600">Late</p>
                  </div>
                  <div className="text-center p-4 bg-orange-50 rounded-lg">
                    <p className="text-2xl font-bold text-orange-600">{reportData.summary.totalEarlyLeave}</p>
                    <p className="text-sm text-gray-600">Pulang Awal</p>
                    <p className="mt-1 text-[10px] text-gray-500">
                      Penanda canonical
                    </p>
                  </div>
                  <div className="text-center p-4 bg-purple-50 rounded-lg">
                    <p className="text-2xl font-bold text-purple-600">{reportData.summary.totalOvertime}</p>
                    <p className="text-sm text-gray-600">Overtime</p>
                  </div>
                  <div className="text-center p-4 bg-cyan-50 rounded-lg">
                    <p className="text-2xl font-bold text-cyan-700">{reportData.summary.totalCrossDayShifts}</p>
                    <p className="text-sm text-gray-600">Cross-Day</p>
                    <p className="mt-1 text-[10px] text-gray-500">
                      Tidak dinilai early/overtime
                    </p>
                  </div>
                  <div className="text-center p-4 bg-amber-50 rounded-lg">
                    <p className="text-2xl font-bold text-amber-700">
                      {reportData.summary.totalManualCorrections}
                    </p>
                    <p className="text-sm text-gray-600">Manual Correction</p>
                    <p className="mt-1 text-[10px] text-gray-500">
                      Administratif; bukan verifikasi perangkat
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-md">
                <span className="font-medium">
                  Sumber penyelesaian shift:
                </span>{' '}
                {reportData.summary.totalDeviceVerifiedCompletions} perangkat
                terverifikasi, {reportData.summary.totalManualCorrections}{' '}
                koreksi administratif, dan {reportData.summary.totalOpenShifts}{' '}
                check-in masih terbuka.
              </div>

              {reportData.summary.invalidCorrectionProjections > 0 && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                  {reportData.summary.invalidCorrectionProjections} projection
                  koreksi ditolak karena tidak lolos validasi dan tidak dihitung.
                </div>
              )}

              {/* Top Performers */}
              {reportData.topPerformers.length > 0 && (
                <div className="bg-white rounded-xl shadow-md p-6">
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">🏆 Top Performers</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {reportData.topPerformers.map((emp, index) => (
                      <div key={emp.id} className="flex items-center space-x-3 p-4 bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg border border-green-200">
                        <div className="w-10 h-10 bg-green-600 rounded-full flex items-center justify-center">
                          <span className="text-white font-bold">#{index + 1}</span>
                        </div>
                        <div className="flex-1">
                          <p className="font-semibold text-gray-800">{emp.name}</p>
                          <p className="text-sm text-gray-600">{emp.department}</p>
                          <div className="flex space-x-2 mt-1">
                            <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">
                              {emp.attendanceRate}% attendance
                            </span>
                            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
                              {emp.punctualityRate}% punctual
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Needs Attention */}
              {reportData.needsAttention.length > 0 && (
                <div className="bg-white rounded-xl shadow-md p-6">
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">⚠️ Needs Attention</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {reportData.needsAttention.map((emp) => (
                      <div key={emp.id} className="flex items-center justify-between p-4 bg-red-50 rounded-lg border border-red-200">
                        <div>
                          <p className="font-semibold text-gray-800">{emp.name}</p>
                          <p className="text-sm text-gray-600">{emp.department}</p>
                          <div className="flex space-x-2 mt-1">
                            <span className="text-xs text-red-700">
                              {emp.attendanceRate}% attendance
                            </span>
                            <span className="text-xs text-orange-700">
                              {emp.totalAbsent} days absent
                            </span>
                          </div>
                        </div>
                        <button className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700">
                          Contact
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Detailed View */}
          {viewMode === 'detailed' && (
            <div className="bg-white rounded-xl shadow-md p-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">Employee Attendance Details</h3>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Employee</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Present</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Absent</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">On Time</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Late</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Pulang Awal</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Overtime</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Cross-Day</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Manual</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Attendance %</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Punctuality %</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-gray-700">Performance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportData.employees.map((emp) => (
                      <tr key={emp.id} className="border-b hover:bg-gray-50">
                        <td className="py-3 px-4">
                          <div>
                            <p className="font-medium text-gray-800">{emp.name}</p>
                            <p className="text-xs text-gray-500">{emp.department} • {emp.position}</p>
                          </div>
                        </td>
                        <td className="text-center py-3 px-4 text-green-600 font-medium">{emp.totalPresent}</td>
                        <td className="text-center py-3 px-4 text-red-600 font-medium">{emp.totalAbsent}</td>
                        <td className="text-center py-3 px-4 text-blue-600">{emp.totalOnTime}</td>
                        <td className="text-center py-3 px-4 text-yellow-600">{emp.totalLate}</td>
                        <td className="text-center py-3 px-4 text-orange-600">{emp.totalEarlyLeave}</td>
                        <td className="text-center py-3 px-4 text-purple-600">{emp.totalOvertime}</td>
                        <td className="text-center py-3 px-4 text-cyan-700">{emp.totalCrossDayShifts}</td>
                        <td
                          className="text-center py-3 px-4 text-amber-700"
                          title="Koreksi administratif; bukan verifikasi perangkat"
                        >
                          {emp.totalManualCorrections}
                        </td>
                        <td className="text-center py-3 px-4">
                          <span className={`font-medium ${
                            parseFloat(emp.attendanceRate) >= 90 ? 'text-green-600' :
                            parseFloat(emp.attendanceRate) >= 80 ? 'text-yellow-600' :
                            'text-red-600'
                          }`}>
                            {emp.attendanceRate}%
                          </span>
                        </td>
                        <td className="text-center py-3 px-4">
                          <span className={`font-medium ${
                            parseFloat(emp.punctualityRate) >= 90 ? 'text-green-600' :
                            parseFloat(emp.punctualityRate) >= 80 ? 'text-yellow-600' :
                            'text-red-600'
                          }`}>
                            {emp.punctualityRate}%
                          </span>
                        </td>
                        <td className="text-center py-3 px-4">
                          <span className={`px-2 py-1 text-xs rounded-full ${getPerformanceColor(emp.performance)}`}>
                            {emp.performance}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Calendar View */}
          {viewMode === 'calendar' && (
            <div className="bg-white rounded-xl shadow-md p-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">📅 Daily Attendance Matrix</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="text-left py-2 px-2 font-medium text-gray-700 sticky left-0 bg-gray-50">Employee</th>
                      {reportData.dateList.map(date => (
                        <th key={date} className="text-center py-2 px-1 font-medium text-gray-600">
                          {new Date(date).getDate()}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reportData.employees.map((emp) => (
                      <tr key={emp.id} className="border-b hover:bg-gray-50">
                        <td className="py-2 px-2 font-medium text-gray-800 sticky left-0 bg-white">
                          {emp.name.split(' ')[0]}
                        </td>
                        {reportData.dateList.map(date => {
                          const record = emp.dailyRecords[date];
                          return (
                            <td key={date} className="text-center py-2 px-1">
                              {record ? (
                                <span
                                  title={[
                                    record.crossDay
                                      ? 'Shift lintas hari; tidak dinilai early leave/overtime'
                                      : '',
                                    record.manualCorrection
                                      ? 'Koreksi administratif; bukan verifikasi perangkat'
                                      : '',
                                    record.earlyLeave
                                      ? `Pulang awal: ${record.earlyLeaveReason || 'Alasan tidak tersedia'}`
                                      : '',
                                    `Sumber penyelesaian: ${record.completionSource}`,
                                  ].filter(Boolean).join('. ')}
                                  className={`inline-block min-w-6 h-6 rounded px-1 ${
                                    record.status === 'ontime'
                                      ? 'bg-green-500 text-white'
                                      : 'bg-yellow-500 text-white'
                                  }`}
                                >
                                  {record.status === 'ontime' ? 'P' : 'L'}
                                  {record.crossDay ? '↗' : ''}
                                  {record.manualCorrection ? 'M' : ''}
                                  {record.earlyLeave ? 'PA' : ''}
                                </span>
                              ) : (
                                <span className="inline-block w-6 h-6 rounded bg-red-500 text-white">
                                  A
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-4 flex space-x-4 text-sm">
                  <span className="flex items-center">
                    <span className="w-4 h-4 bg-green-500 rounded mr-2"></span> P = Present (On Time)
                  </span>
                  <span className="flex items-center">
                    <span className="w-4 h-4 bg-yellow-500 rounded mr-2"></span> L = Late
                  </span>
                  <span className="flex items-center">
                    <span className="w-4 h-4 bg-red-500 rounded mr-2"></span> A = Absent
                  </span>
                  <span className="flex items-center">
                    <span className="mr-2 font-medium text-cyan-700">↗</span>
                    Cross-Day
                  </span>
                  <span className="flex items-center">
                    <span className="mr-2 font-medium text-amber-700">M</span>
                    Manual correction (bukan verifikasi perangkat)
                  </span>
                  <span className="flex items-center">
                    <span className="mr-2 font-medium text-orange-700">PA</span>
                    Pulang awal (penanda canonical; arahkan kursor untuk alasan)
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Analytics View */}
          {viewMode === 'analytics' && (
            <div className="space-y-6">
              {/* Department Analysis */}
              <div className="bg-white rounded-xl shadow-md p-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">📊 Department Analysis</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Group employees by department */}
                  {Object.entries(
                    reportData.employees.reduce((acc, emp) => {
                      const dept = emp.department || 'Unknown';
                      if (!acc[dept]) {
                        acc[dept] = {
                          name: dept,
                          employees: [],
                          totalPresent: 0,
                          totalAbsent: 0,
                          avgAttendance: 0
                        };
                      }
                      acc[dept].employees.push(emp);
                      acc[dept].totalPresent += emp.totalPresent;
                      acc[dept].totalAbsent += emp.totalAbsent;
                      return acc;
                    }, {})
                  ).map(([dept, data]) => {
                    data.avgAttendance = (
                      data.employees.reduce((sum, emp) => sum + parseFloat(emp.attendanceRate), 0) /
                      data.employees.length
                    ).toFixed(1);

                    return (
                      <div key={dept} className="p-4 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg">
                        <h4 className="font-semibold text-gray-800 mb-2">{dept}</h4>
                        <div className="space-y-1 text-sm">
                          <p>Employees: <span className="font-medium">{data.employees.length}</span></p>
                          <p>Avg Attendance: <span className="font-medium text-green-600">{data.avgAttendance}%</span></p>
                          <p>Total Present: <span className="font-medium">{data.totalPresent}</span></p>
                          <p>Total Absent: <span className="font-medium text-red-600">{data.totalAbsent}</span></p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Trend Analysis */}
              <div className="bg-white rounded-xl shadow-md p-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">📈 Attendance Trends</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="text-center p-4 bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg">
                    <p className="text-3xl font-bold text-green-600">
                      {((reportData.summary.totalOnTime / reportData.summary.totalPresent) * 100).toFixed(0)}%
                    </p>
                    <p className="text-sm text-gray-600 mt-2">On-Time Rate</p>
                  </div>
                  <div className="text-center p-4 bg-gradient-to-br from-yellow-50 to-orange-50 rounded-lg">
                    <p className="text-3xl font-bold text-yellow-600">
                      {((reportData.summary.totalLate / reportData.summary.totalPresent) * 100).toFixed(0)}%
                    </p>
                    <p className="text-sm text-gray-600 mt-2">Late Rate</p>
                  </div>
                  <div className="text-center p-4 bg-gradient-to-br from-red-50 to-pink-50 rounded-lg">
                    <p className="text-3xl font-bold text-red-600">
                      {((reportData.summary.totalAbsent / (reportData.summary.totalPresent + reportData.summary.totalAbsent)) * 100).toFixed(0)}%
                    </p>
                    <p className="text-sm text-gray-600 mt-2">Absence Rate</p>
                  </div>
                  <div className="text-center p-4 bg-gradient-to-br from-purple-50 to-indigo-50 rounded-lg">
                    <p className="text-3xl font-bold text-purple-600">
                      {reportData.perfectAttendance.length}
                    </p>
                    <p className="text-sm text-gray-600 mt-2">Perfect Records</p>
                  </div>
                </div>
              </div>

              {/* Recommendations */}
              <div className="bg-white rounded-xl shadow-md p-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">💡 Recommendations</h3>
                <div className="space-y-3">
                  {reportData.summary.avgAttendanceRate < 85 && (
                    <div className="p-4 bg-red-50 border-l-4 border-red-500 rounded">
                      <p className="font-semibold text-red-700">Low Overall Attendance</p>
                      <p className="text-sm text-gray-700 mt-1">
                        Average attendance is below 85%. Consider implementing attendance improvement programs or reviewing workplace policies.
                      </p>
                    </div>
                  )}
                  {reportData.summary.avgPunctualityRate < 80 && (
                    <div className="p-4 bg-yellow-50 border-l-4 border-yellow-500 rounded">
                      <p className="font-semibold text-yellow-700">Punctuality Issues</p>
                      <p className="text-sm text-gray-700 mt-1">
                        Many employees are arriving late. Consider flexible working hours or addressing transportation challenges.
                      </p>
                    </div>
                  )}
                  {reportData.perfectAttendance.length > 0 && (
                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <p className="font-semibold text-green-700">Recognize Top Performers</p>
                      <p className="text-sm text-gray-700 mt-1">
                        {reportData.perfectAttendance.length} employees have perfect attendance. Consider recognition or rewards to motivate others.
                      </p>
                    </div>
                  )}
                  {reportData.needsAttention.length > 0 && (
                    <div className="p-4 bg-orange-50 border-l-4 border-orange-500 rounded">
                      <p className="font-semibold text-orange-700">Follow Up Required</p>
                      <p className="text-sm text-gray-700 mt-1">
                        {reportData.needsAttention.length} employees have attendance below 80%. Individual counseling or support may be needed.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default AttendanceRecap;
