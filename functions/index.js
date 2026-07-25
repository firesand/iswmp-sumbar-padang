// functions/index.js
// Use Firebase Functions v2 APIs
const { onCall } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const {
    FieldValue,
    Timestamp,
    getFirestore,
} = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { createAttendanceHandlers } = require('./attendance');
const { createAdminHandlers } = require('./admin-operations');
const {
    createGeofenceVerificationHandlers,
} = require('./geofence-verification');
const {
    createAttendanceCorrectionHandlers,
} = require('./attendance-corrections');

initializeApp();

// Keep the narrow dependency-injection interface used by the handler
// factories while relying only on Firebase Admin's supported modular APIs.
const adminServices = {
    auth: () => getAuth(),
    firestore: Object.assign(() => getFirestore(), {
        FieldValue,
        Timestamp,
    }),
    storage: () => getStorage(),
};

const attendanceHandlers = createAttendanceHandlers(adminServices);
const adminHandlers = createAdminHandlers(adminServices);
const geofenceVerificationHandlers =
    createGeofenceVerificationHandlers(adminServices);
const attendanceCorrectionHandlers =
    createAttendanceCorrectionHandlers(adminServices);
const callableRegion = 'asia-southeast2';
const attendanceRuntimeServiceAccount =
    'attendance-runtime@iswmp-sumbar-padang.iam.gserviceaccount.com';

// Security-sensitive writes are accepted only through App Check protected
// callables. Mutation endpoints consume limited-use App Check tokens.
exports.createAttendanceChallenge = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    timeoutSeconds: 30,
}, attendanceHandlers.createAttendanceChallenge);

exports.submitAttendance = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    timeoutSeconds: 60,
    memory: '512MiB',
}, attendanceHandlers.submitAttendance);

exports.getAttendancePhotoUrl = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    timeoutSeconds: 30,
}, attendanceHandlers.getAttendancePhotoUrl);

exports.getOnsitePresenceCode = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    timeoutSeconds: 30,
}, adminHandlers.getOnsitePresenceCode);

exports.adminResetUserPassword = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    timeoutSeconds: 30,
}, adminHandlers.adminResetUserPassword);

exports.adminArchiveEmployee = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    timeoutSeconds: 30,
}, adminHandlers.adminArchiveEmployee);

exports.changeTemporaryPassword = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    timeoutSeconds: 30,
}, adminHandlers.changeTemporaryPassword);

exports.proposeGeofenceVerification = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    timeoutSeconds: 30,
}, geofenceVerificationHandlers.proposeGeofenceVerification);

exports.reviewGeofenceVerification = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    timeoutSeconds: 30,
}, geofenceVerificationHandlers.reviewGeofenceVerification);

exports.proposeMissingCheckoutCorrection = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    timeoutSeconds: 30,
}, attendanceCorrectionHandlers.proposeMissingCheckoutCorrection);

exports.reviewAttendanceCorrection = onCall({
    region: callableRegion,
    serviceAccount: attendanceRuntimeServiceAccount,
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    timeoutSeconds: 30,
}, attendanceCorrectionHandlers.reviewAttendanceCorrection);
