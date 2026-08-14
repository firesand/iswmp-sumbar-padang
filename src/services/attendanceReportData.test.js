import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isReportEmployeeProfile,
  mergeHistoricalReportEmployees,
} from './attendanceReportData.js';

test('attendanceReportData: admin and monitor account variants are not employees', () => {
  const excludedProfiles = [
    { role: 'admin' },
    { role: 'viewer' },
    { role: 'admin_viewer' },
    { role: 'monitor' },
    { role: 'office_staff', adminRole: 'viewer' },
    { role: 'office_staff', adminRole: 'monitor' },
    { role: 'office_staff', isAdmin: true },
    { role: 'office_staff', isViewer: true },
  ];

  excludedProfiles.forEach((profile) => {
    assert.equal(isReportEmployeeProfile(profile), false);
  });
  assert.equal(isReportEmployeeProfile({ role: 'office_staff' }), true);
  assert.equal(isReportEmployeeProfile({ role: 'field_staff' }), true);
});

test('attendanceReportData: historical attendance restores only represented employees', () => {
  const currentEmployees = [
    { id: 'active-employee', role: 'field_staff', accountStatus: 'active' },
    { id: 'viewer-in-input', role: 'viewer', accountStatus: 'active' },
  ];
  const attendances = [
    { id: 'att-active', userId: 'active-employee' },
    { id: 'att-resigned', userId: 'resigned-employee' },
    { id: 'att-suspended', userId: 'suspended-employee' },
    { id: 'att-admin', userId: 'admin-account' },
    { id: 'att-monitor', userId: 'monitor-account' },
  ];
  const historicalProfiles = [
    {
      id: 'resigned-employee',
      role: 'field_staff',
      accountStatus: 'resigned',
      isActive: false,
    },
    {
      id: 'suspended-employee',
      role: 'office_staff',
      accountStatus: 'suspended',
      isActive: false,
    },
    {
      id: 'inactive-without-record',
      role: 'field_staff',
      accountStatus: 'inactive',
      isActive: false,
    },
    {
      id: 'admin-account',
      role: 'admin',
      accountStatus: 'active',
      isActive: true,
    },
    {
      id: 'monitor-account',
      role: 'admin',
      adminRole: 'monitor',
      isAdmin: true,
      isViewer: true,
      accountStatus: 'active',
      isActive: true,
    },
    // Duplicate input must not create a duplicate employee row.
    {
      id: 'resigned-employee',
      role: 'field_staff',
      accountStatus: 'resigned',
      isActive: false,
    },
  ];

  const result = mergeHistoricalReportEmployees(
    currentEmployees,
    attendances,
    historicalProfiles
  );

  assert.deepEqual(
    result.map((employee) => employee.id),
    ['active-employee', 'resigned-employee', 'suspended-employee']
  );
  assert.equal(currentEmployees.length, 2, 'pure helper does not mutate its input');
});
