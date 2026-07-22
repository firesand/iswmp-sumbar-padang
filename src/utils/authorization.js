export const hasAdminAccess = (userData) => Boolean(
  userData && (userData.role === 'admin' || userData.isAdmin === true)
);
