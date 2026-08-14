export const hasActiveAccount = (userData) => Boolean(
  userData &&
  userData.accountStatus === 'active' &&
  userData.isActive === true &&
  userData.mustChangePassword !== true
);

export const hasAdminAccess = (userData) => Boolean(
  hasActiveAccount(userData) &&
  (userData.role === 'admin' ||
   userData.isAdmin === true ||
   userData.role === 'admin_viewer' ||
   userData.role === 'viewer')
);

export const isMonitorOnlyAdmin = (userData) => Boolean(
  hasAdminAccess(userData) &&
  (userData.adminRole === 'viewer' ||
   userData.adminRole === 'monitor' ||
   userData.isViewer === true ||
   userData.role === 'viewer' ||
   userData.role === 'admin_viewer')
);

export const canManageAdminOperations = (userData) => Boolean(
  hasAdminAccess(userData) && !isMonitorOnlyAdmin(userData)
);

export const hasEmployeeAccess = (userData) => Boolean(
  hasActiveAccount(userData) && !hasAdminAccess(userData)
);

const hasCanonicalDeliverablesAssignment = (userData) => Boolean(
  hasActiveAccount(userData) &&
  userData.role === 'office_staff' &&
  userData.assignmentType === 'kantor' &&
  userData.kantorId === 'kantor-padang-kota'
);

export const isTeamLeader = (userData) => Boolean(
  hasCanonicalDeliverablesAssignment(userData) &&
  (userData.peranKantor === 'KORKOT' ||
   userData.peranKantor === 'TEAM_LEADER')
);

export const isDataManagementExpert = (userData) => Boolean(
  hasCanonicalDeliverablesAssignment(userData) &&
  (userData.peranKantor === 'ASMAN_DATA' ||
   userData.peranKantor === 'TA_DATA_MANAGEMENT')
);

export const hasDeliverablesAccess = (userData) => Boolean(
  userData && (
    hasAdminAccess(userData) ||
    isTeamLeader(userData) ||
    isDataManagementExpert(userData)
  )
);
