import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasActiveAccount,
  hasAdminAccess,
  hasEmployeeAccess,
  isMonitorOnlyAdmin,
  canManageAdminOperations,
  isTeamLeader,
  isDataManagementExpert,
  hasDeliverablesAccess,
} from './authorization.js';

test('authorization: only active non-admin accounts can use employee routes', () => {
  const activeEmployee = {
    role: 'field_staff',
    accountStatus: 'active',
    isActive: true,
    mustChangePassword: false,
  };
  const inactiveVariants = [
    { ...activeEmployee, accountStatus: 'pending', isActive: false },
    { ...activeEmployee, accountStatus: 'suspended', isActive: false },
    { ...activeEmployee, accountStatus: 'inactive', isActive: false },
    { ...activeEmployee, isActive: false },
    { ...activeEmployee, mustChangePassword: true },
  ];
  const activeAdmin = {
    ...activeEmployee,
    role: 'admin',
  };

  assert.equal(hasActiveAccount(activeEmployee), true);
  assert.equal(hasEmployeeAccess(activeEmployee), true);
  inactiveVariants.forEach((employee) => {
    assert.equal(hasActiveAccount(employee), false);
    assert.equal(hasEmployeeAccess(employee), false);
  });
  assert.equal(hasActiveAccount(activeAdmin), true);
  assert.equal(hasEmployeeAccess(activeAdmin), false);
});

test('authorization: full admin has admin access and can manage operations', () => {
  const fullAdmin = {
    role: 'admin',
    accountStatus: 'active',
    isActive: true,
    mustChangePassword: false,
  };

  assert.equal(hasAdminAccess(fullAdmin), true);
  assert.equal(isMonitorOnlyAdmin(fullAdmin), false);
  assert.equal(canManageAdminOperations(fullAdmin), true);
});

test('authorization: monitor-only admin (adminRole viewer) has admin access but cannot manage operations', () => {
  const monitorAdmin = {
    role: 'admin',
    adminRole: 'viewer',
    accountStatus: 'active',
    isActive: true,
    mustChangePassword: false,
  };

  assert.equal(hasAdminAccess(monitorAdmin), true);
  assert.equal(isMonitorOnlyAdmin(monitorAdmin), true);
  assert.equal(canManageAdminOperations(monitorAdmin), false);
});

test('authorization: monitor-only admin (isViewer flag) has admin access but cannot manage operations', () => {
  const monitorAdmin = {
    role: 'admin',
    isViewer: true,
    accountStatus: 'active',
    isActive: true,
    mustChangePassword: false,
  };

  assert.equal(hasAdminAccess(monitorAdmin), true);
  assert.equal(isMonitorOnlyAdmin(monitorAdmin), true);
  assert.equal(canManageAdminOperations(monitorAdmin), false);
});

test('authorization: role admin_viewer has admin access but cannot manage operations', () => {
  const monitorAdmin = {
    role: 'admin_viewer',
    accountStatus: 'active',
    isActive: true,
    mustChangePassword: false,
  };

  assert.equal(hasAdminAccess(monitorAdmin), true);
  assert.equal(isMonitorOnlyAdmin(monitorAdmin), true);
  assert.equal(canManageAdminOperations(monitorAdmin), false);
});

test('authorization: field staff or office staff has neither admin access nor monitor admin access', () => {
  const employee = {
    role: 'field_staff',
    accountStatus: 'active',
    isActive: true,
    mustChangePassword: false,
  };

  assert.equal(hasAdminAccess(employee), false);
  assert.equal(isMonitorOnlyAdmin(employee), false);
  assert.equal(canManageAdminOperations(employee), false);
});

test('authorization: inactive or suspended admin has no access', () => {
  const suspendedAdmin = {
    role: 'admin',
    accountStatus: 'suspended',
    isActive: false,
    mustChangePassword: false,
  };

  assert.equal(hasAdminAccess(suspendedAdmin), false);
  assert.equal(isMonitorOnlyAdmin(suspendedAdmin), false);
  assert.equal(canManageAdminOperations(suspendedAdmin), false);
});

test('authorization: admin with mustChangePassword has no access until changed', () => {
  const tempPasswordAdmin = {
    role: 'admin',
    accountStatus: 'active',
    isActive: true,
    mustChangePassword: true,
  };

  assert.equal(hasAdminAccess(tempPasswordAdmin), false);
  assert.equal(isMonitorOnlyAdmin(tempPasswordAdmin), false);
  assert.equal(canManageAdminOperations(tempPasswordAdmin), false);
});

test('authorization: canonical TEAM_LEADER office assignment has deliverables access', () => {
  const misdarTeamLeader = {
    name: 'Misdar Putra',
    role: 'office_staff',
    assignmentType: 'kantor',
    kantorId: 'kantor-padang-kota',
    peranKantor: 'TEAM_LEADER',
    accountStatus: 'active',
    isActive: true,
  };

  const genericEmployee = {
    name: 'Staff Lapangan',
    role: 'field_staff',
    accountStatus: 'active',
    isActive: true,
  };

  const admin = {
    role: 'admin',
    accountStatus: 'active',
    isActive: true,
    mustChangePassword: false,
  };

  assert.equal(isTeamLeader(misdarTeamLeader), true);
  assert.equal(hasDeliverablesAccess(misdarTeamLeader), true);
  assert.equal(hasAdminAccess(misdarTeamLeader), false);

  assert.equal(isTeamLeader(genericEmployee), false);
  assert.equal(hasDeliverablesAccess(genericEmployee), false);

  assert.equal(isTeamLeader(admin), false);
  assert.equal(hasDeliverablesAccess(admin), true);
});

test('authorization: existing KORKOT assignment maps to team-leader access', () => {
  const existingTeamLeader = {
    name: 'Misdar Putra',
    role: 'office_staff',
    assignmentType: 'kantor',
    kantorId: 'kantor-padang-kota',
    peranKantor: 'KORKOT',
    accountStatus: 'active',
    isActive: true,
  };

  assert.equal(isTeamLeader(existingTeamLeader), true);
  assert.equal(hasDeliverablesAccess(existingTeamLeader), true);
});

test('authorization: canonical TA_DATA_MANAGEMENT office assignment has deliverables access', () => {
  const abdulAzizDataExpert = {
    name: 'ABDUL AZIS SIKUMBANG',
    role: 'office_staff',
    assignmentType: 'kantor',
    kantorId: 'kantor-padang-kota',
    peranKantor: 'TA_DATA_MANAGEMENT',
    position: 'Tenaga Ahli Manajemen Data',
    accountStatus: 'active',
    isActive: true,
  };

  assert.equal(isDataManagementExpert(abdulAzizDataExpert), true);
  assert.equal(hasDeliverablesAccess(abdulAzizDataExpert), true);
  assert.equal(hasAdminAccess(abdulAzizDataExpert), false);
});

test('authorization: existing ASMAN_DATA assignment retains deliverables access', () => {
  const existingDataExpert = {
    name: 'Abdul Aziz Sikumbang',
    role: 'office_staff',
    assignmentType: 'kantor',
    kantorId: 'kantor-padang-kota',
    peranKantor: 'ASMAN_DATA',
    accountStatus: 'active',
    isActive: true,
  };

  assert.equal(isDataManagementExpert(existingDataExpert), true);
  assert.equal(hasDeliverablesAccess(existingDataExpert), true);
});

test('authorization: names and editable position text cannot grant deliverables access', () => {
  const nameOnlyTeamLeader = {
    name: 'Misdar Putra',
    role: 'office_staff',
    assignmentType: 'kantor',
    kantorId: 'kantor-padang-kota',
    position: 'Team Leader',
    peranKantor: 'OPERATOR',
    accountStatus: 'active',
    isActive: true,
  };
  const nameOnlyDataExpert = {
    name: 'Abdul Aziz Sikumbang',
    role: 'office_staff',
    assignmentType: 'kantor',
    kantorId: 'kantor-padang-kota',
    position: 'Tenaga Ahli Manajemen Data',
    peranKantor: 'OPERATOR',
    accountStatus: 'active',
    isActive: true,
  };

  assert.equal(isTeamLeader(nameOnlyTeamLeader), false);
  assert.equal(isDataManagementExpert(nameOnlyDataExpert), false);
  assert.equal(hasDeliverablesAccess(nameOnlyTeamLeader), false);
  assert.equal(hasDeliverablesAccess(nameOnlyDataExpert), false);
});

test('authorization: pending or inactive deliverables roles cannot access the hub', () => {
  const pendingTeamLeader = {
    role: 'office_staff',
    assignmentType: 'kantor',
    kantorId: 'kantor-padang-kota',
    peranKantor: 'TEAM_LEADER',
    accountStatus: 'pending',
    isActive: false,
  };
  const inactiveDataExpert = {
    role: 'office_staff',
    assignmentType: 'kantor',
    kantorId: 'kantor-padang-kota',
    peranKantor: 'TA_DATA_MANAGEMENT',
    accountStatus: 'inactive',
    isActive: false,
  };

  assert.equal(isTeamLeader(pendingTeamLeader), false);
  assert.equal(isDataManagementExpert(inactiveDataExpert), false);
  assert.equal(hasDeliverablesAccess(pendingTeamLeader), false);
  assert.equal(hasDeliverablesAccess(inactiveDataExpert), false);
});

test('authorization: non-canonical role aliases cannot bypass deliverables rules', () => {
  const roleAlias = {
    role: 'team_leader',
    accountStatus: 'active',
    isActive: true,
  };
  const wrongOffice = {
    role: 'office_staff',
    assignmentType: 'kantor',
    kantorId: 'kantor-lain',
    peranKantor: 'TEAM_LEADER',
    accountStatus: 'active',
    isActive: true,
  };

  assert.equal(hasDeliverablesAccess(roleAlias), false);
  assert.equal(hasDeliverablesAccess(wrongOffice), false);
});
