// src/App.jsx
import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './config/firebase';
import { initEmailJS } from './services/emailService';
import { FEATURES } from './config/projectConfig';

// Components
import Login from './components/Auth/Login';
import Register from './components/Auth/Register';
import RegisterErrorBoundary from './components/Auth/RegisterErrorBoundary';
import PendingApproval from './components/Auth/PendingApproval';
import ForcePasswordChange from './components/Auth/ForcePasswordChange';
import LoadingScreen from './components/Common/LoadingScreen';
import ErrorBoundary from './components/Common/ErrorBoundary';
import WhiteScreenFallback from './components/Common/WhiteScreenFallback';
import Header from './components/Common/Header';
import EmployeeDashboard from './components/Employee/Dashboard';
import EmployeeProfile from './components/Employee/EmployeeProfile';
import LeaveRequest from './components/Employee/LeaveRequest';
import LocationUpdate from './components/Employee/LocationUpdate';
import PayrollRequest from './components/Employee/PayrollRequest';
import AdminDashboard from './components/Admin/Dashboard';
import LeaveManagement from './components/Admin/LeaveManagement';
import PayrollManagement from './components/Admin/PayrollManagement';
import Footer from './components/Common/Footer';
import AppUpdateNotification from './components/Common/AppUpdateNotification';
import AttendanceFlashNotification from './components/Common/AttendanceFlashNotification';
import CacheClearedToast from './components/Common/CacheClearedToast';
import DeliverablesHub from './components/Deliverables/DeliverablesHub';
import DeliverablePublicView from './components/Deliverables/DeliverablePublicView';
import {
  hasActiveAccount,
  hasAdminAccess,
  canManageAdminOperations,
  hasEmployeeAccess,
  hasDeliverablesAccess,
} from './utils/authorization';

function App() {
  const [user, setUser] = useState(null);
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userDataLoading, setUserDataLoading] = useState(false);
  const [whiteScreenDetected, setWhiteScreenDetected] = useState(false);

  useEffect(() => {
    console.log('App.jsx - Setting up auth listener...');

    // Initialize EmailJS when app loads
    try {
      initEmailJS();
      console.log('EmailJS initialized successfully');
    } catch (error) {
      console.error('Failed to initialize EmailJS:', error);
    }

    const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
      console.log('Auth state changed:', authUser?.email);

      if (authUser) {
        setUser(authUser);
        setUserDataLoading(true);

        // Fetch user data from Firestore
        try {
          console.log('Fetching user data for:', authUser.uid);
          const userDoc = await getDoc(doc(db, 'users', authUser.uid));

          if (userDoc.exists()) {
            const data = userDoc.data();
            console.log('User data loaded:', data);
            setUserData(data);
          } else {
            console.log('No user document found in Firestore');
            setUserData(null);
          }
        } catch (error) {
          console.error('Error fetching user data:', error);
          setUserData(null);
        } finally {
          setUserDataLoading(false);
        }
      } else {
        console.log('No authenticated user');
        setUser(null);
        setUserData(null);
        setUserDataLoading(false);
      }

      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // White screen detection
  useEffect(() => {
    const checkWhiteScreen = () => {
      const root = document.getElementById('root');
      const hasContent = root && root.children.length > 0;
      
      if (!hasContent && !loading) {
        console.log('🚨 White screen detected in App.jsx');
        setWhiteScreenDetected(true);
      }
    };

    // Check after 5 seconds
    const timer = setTimeout(checkWhiteScreen, 5000);
    
    return () => clearTimeout(timer);
  }, [loading]);

  // Show white screen fallback if detected
  if (whiteScreenDetected) {
    console.log('App.jsx - White screen detected, showing fallback');
    return <WhiteScreenFallback />;
  }

  // Show loading screen while checking auth
  if (loading) {
    console.log('App.jsx - Initial loading...');
    return <LoadingScreen />;
  }

  // Password sementara hasil reset admin tidak boleh dipakai untuk mengakses
  // fitur lain. Perubahan dilakukan oleh callable backend dan mencabut sesi lama.
  if (user && userData?.mustChangePassword === true) {
    return <ForcePasswordChange />;
  }

  // Protected Route Component
  const ProtectedRoute = ({
    children,
    requireAdmin = false,
    requireManager = false,
    requireDeliverables = false,
    requireEmployee = false,
  }) => {
    console.log('ProtectedRoute - User:', user?.email, 'UserData:', userData, 'RequireAdmin:', requireAdmin);

    if (!user) {
      console.log('ProtectedRoute - No user, redirecting to login');
      return <Navigate to="/login" replace />;
    }

    // Wait for user data to load
    if (userDataLoading) {
      console.log('ProtectedRoute - Loading user data...');
      return <LoadingScreen />;
    }

    // If user data doesn't exist in Firestore, redirect to login
    if (!userData) {
      console.log('ProtectedRoute - No user data in Firestore');
      alert('User profile not found. Please contact administrator or register again.');
      return <Navigate to="/login" replace />;
    }

    if (requireAdmin && !hasAdminAccess(userData)) {
      console.log('ProtectedRoute - User is not admin, redirecting to employee');
      return <Navigate to="/employee" replace />;
    }

    if (requireManager && !canManageAdminOperations(userData)) {
      console.log('ProtectedRoute - Monitor account cannot access a write route');
      return <Navigate to="/admin" replace />;
    }

    if (requireDeliverables && !hasDeliverablesAccess(userData)) {
      console.log('ProtectedRoute - User cannot access deliverables');
      return <Navigate to="/employee" replace />;
    }

    if (requireEmployee && !hasEmployeeAccess(userData)) {
      if (hasAdminAccess(userData)) {
        console.log('ProtectedRoute - Admin account cannot use employee write routes');
        return <Navigate to="/admin" replace />;
      }

      console.log('ProtectedRoute - Employee account is not active');
      return <Navigate to="/" replace />;
    }

    return children;
  };

  // Simple redirect based on role
  const RoleBasedRedirect = () => {
    console.log('RoleBasedRedirect - User:', user?.email, 'Role:', userData?.role, 'Status:', userData?.accountStatus);

    if (!user) {
      return <Navigate to="/login" replace />;
    }

    if (userDataLoading) {
      return <LoadingScreen />;
    }

    if (!userData) {
      return <Navigate to="/login" replace />;
    }

    // Handle pending users
    if (userData.accountStatus === 'pending') {
      console.log('User is pending approval');
      return <PendingApproval />;
    }

    // Handle every non-pending account that is not currently active. Routing
    // inactive employees back here prevents direct employee URLs from looping.
    if (!hasActiveAccount(userData)) {
      console.log('User account is inactive');
      return (
        <div className="min-h-screen bg-gradient-to-br from-red-50 to-pink-100 flex items-center justify-center">
          <div className="text-center">
            <div className="text-red-600 text-6xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold text-gray-800 mb-2">Akun Tidak Aktif</h2>
            <p className="text-gray-600 mb-4">Akun Anda telah dinonaktifkan. Silakan hubungi HR untuk informasi lebih lanjut.</p>
            <button 
              onClick={() => auth.signOut().then(() => window.location.href = '/login')}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
            >
              Kembali ke Login
            </button>
          </div>
        </div>
      );
    }

    // Redirect based on role for active users
    if (hasAdminAccess(userData)) {
      console.log('Redirecting to admin dashboard');
      return <Navigate to="/admin" replace />;
    } else {
      console.log('Redirecting to employee dashboard');
      return <Navigate to="/employee" replace />;
    }
  };

  return (
    <ErrorBoundary>
      <Router>
        <div className="min-h-screen flex flex-col">
          {/* App Update Notification Manager */}
          <AppUpdateNotification 
            userId={user?.uid} 
            userRole={userData?.role} 
          />
          <AttendanceFlashNotification
            user={user}
            userData={userData}
          />
          <CacheClearedToast />
          
          <Routes>
            {/* Auth Routes */}
            <Route
              path="/login"
              element={
                user ? <RoleBasedRedirect /> : <Login />
              }
            />
                      <Route
            path="/register"
            element={
              user ? <RoleBasedRedirect /> : (
                <RegisterErrorBoundary>
                  <Register />
                </RegisterErrorBoundary>
              )
            }
          />

            {/* Root Route - Redirect based on role */}
            <Route
              path="/"
              element={<RoleBasedRedirect />}
            />

            {/* Employee Dashboard Route */}
            <Route
              path="/employee"
              element={
                <ProtectedRoute requireEmployee={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <EmployeeDashboard />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />

            {/* Employee Profile Route */}
            <Route
              path="/employee/profile"
              element={
                <ProtectedRoute requireEmployee={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <EmployeeProfile />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />

            {/* Leave Request Route */}
            {FEATURES.leave && (
            <Route
              path="/employee/leave-request"
              element={
                <ProtectedRoute requireEmployee={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <LeaveRequest />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />
            )}

            {/* Location Update Route */}
            {FEATURES.locationUpdate && (
            <Route
              path="/employee/location-update"
              element={
                <ProtectedRoute requireEmployee={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <LocationUpdate />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />
            )}

            {/* Payroll Request Route */}
            {FEATURES.payroll && (
            <Route
              path="/employee/payroll-request"
              element={
                <ProtectedRoute requireEmployee={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <PayrollRequest />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />
            )}

            {/* Deliverables KAK Hub Route */}
            <Route
              path="/deliverables"
              element={
                <ProtectedRoute requireDeliverables={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <DeliverablesHub user={user} userData={userData} />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />
            <Route
              path="/team-leader/deliverables"
              element={
                <ProtectedRoute requireDeliverables={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <DeliverablesHub user={user} userData={userData} />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />

            {/* Public / Shareable Deliverable Document View */}
            <Route
              path="/deliverables/view/:id"
              element={
                <ErrorBoundary>
                  <DeliverablePublicView />
                </ErrorBoundary>
              }
            />
            <Route
              path="/doc/:id"
              element={
                <ErrorBoundary>
                  <DeliverablePublicView />
                </ErrorBoundary>
              }
            />

            {/* Admin Dashboard Route */}
            <Route
              path="/admin"
              element={
                <ProtectedRoute requireAdmin={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <AdminDashboard />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />

            {/* Admin Leave Management Route */}
            {FEATURES.leave && (
            <Route
              path="/admin/leave-management"
              element={
                <ProtectedRoute requireAdmin={true} requireManager={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <LeaveManagement />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />
            )}

            {/* Admin Payroll Management Route */}
            {FEATURES.payroll && (
            <Route
              path="/admin/payroll-management"
              element={
                <ProtectedRoute requireAdmin={true} requireManager={true}>
                  <ErrorBoundary>
                    <Header user={user} userData={userData} />
                    <PayrollManagement />
                  </ErrorBoundary>
                </ProtectedRoute>
              }
            />
            )}

            {/* Catch all - redirect to home */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <Footer />
        </div>
      </Router>
    </ErrorBoundary>
  );
}

export default App;
