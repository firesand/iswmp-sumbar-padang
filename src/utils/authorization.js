export const hasAdminAccess = (userData) => Boolean(
  userData &&
  (userData.role === 'admin' || userData.isAdmin === true) &&
  userData.accountStatus === 'active' &&
  userData.isActive === true &&
  userData.mustChangePassword !== true
);
