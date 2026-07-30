#!/usr/bin/env node

/**
 * Semantic security tests for the local Firestore and Storage rules.
 *
 * The Firebase Rules REST API only evaluates the inline rules and mocked
 * resources below; it does not create, update, delete, or upload production
 * data. A logged-in Firebase CLI session is required.
 *
 * Usage:
 *   node scripts/test-security-rules.mjs
 *   node scripts/test-security-rules.mjs --project=my-project-id
 */

import { readFileSync } from 'node:fs';
import authModule from 'firebase-tools/lib/auth.js';

const DEFAULT_PROJECT_ID = 'iswmp-sumbar-padang';
const DEFAULT_BUCKET = 'iswmp-sumbar-padang.firebasestorage.app';
const projectArg = process.argv.find((arg) => arg.startsWith('--project='));
const projectId = projectArg?.slice('--project='.length) || DEFAULT_PROJECT_ID;
const bucket = process.env.FIREBASE_STORAGE_BUCKET || DEFAULT_BUCKET;

const account = authModule.getGlobalDefaultAccount();
if (!account?.tokens?.refresh_token) {
  console.error('Firebase CLI belum login. Jalankan: npx firebase login');
  process.exit(1);
}

authModule.setRefreshToken(account.tokens.refresh_token);

const tokenResult = await authModule.getAccessToken(
  account.tokens.refresh_token,
  [],
);

if (!tokenResult?.access_token) {
  throw new Error('Tidak dapat memperoleh access token Firebase CLI.');
}

const rulesApi =
  `https://firebaserules.googleapis.com/v1/projects/${projectId}:test`;

const testRules = async (fileName, cases) => {
  const response = await fetch(rulesApi, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenResult.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: {
        files: [{
          name: fileName,
          content: readFileSync(fileName, 'utf8'),
        }],
      },
      testSuite: {
        testCases: cases.map(({ name: _name, ...testCase }) => testCase),
      },
    }),
  });

  const report = await response.json();
  if (!response.ok) {
    throw new Error(`${fileName}: ${JSON.stringify(report)}`);
  }

  const errors = (report.issues || []).filter(
    (issue) => issue.severity === 'ERROR',
  );
  if (errors.length > 0) {
    for (const issue of errors) {
      console.error(
        `${fileName}:${issue.sourcePosition?.line || '?'} ` +
        `${issue.description}`,
      );
    }
    return false;
  }

  let passed = true;
  cases.forEach((testCase, index) => {
    const result = report.testResults?.[index];
    const ok = result?.state === 'SUCCESS';
    passed &&= ok;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.name}`);
    if (!ok && result?.debugMessages?.length) {
      console.error(`      ${result.debugMessages.join('\n      ')}`);
    }
  });

  return passed;
};

const firestorePath = (collection, documentId) =>
  `/databases/(default)/documents/${collection}/${documentId}`;

const firestoreDocumentMock = (collection, documentId, data) => ({
  function: 'get',
  args: [{ exactValue: firestorePath(collection, documentId) }],
  result: { value: { data } },
});

const firestoreUserMock = (uid, data) =>
  firestoreDocumentMock('users', uid, data);

const firestoreAfterMock = (collection, documentId, data) => ({
  function: 'getAfter',
  args: [{ exactValue: firestorePath(collection, documentId) }],
  result: { value: { data } },
});

const firestoreExistsAfterMock = (collection, documentId, value) => ({
  function: 'existsAfter',
  args: [{ exactValue: firestorePath(collection, documentId) }],
  result: { value },
});

const canonicalKelurahanId = 'kel-alang-laweh';
const canonicalKelurahanName = 'Alang Laweh';
const canonicalKantorId = 'kantor-padang-kota';

const activeEmployee = {
  accountStatus: 'active',
  isActive: true,
  role: 'field_staff',
  email: 'employee@example.test',
  name: 'Rules Employee',
  assignmentType: 'kelurahan',
  kelurahanId: canonicalKelurahanId,
  kelurahanNama: canonicalKelurahanName,
  jenisTenagaAhli: 'TA_PERSAMP',
};
const inactiveEmployee = {
  accountStatus: 'inactive',
  isActive: false,
  role: 'field_staff',
};
const passwordChangeEmployee = {
  ...activeEmployee,
  mustChangePassword: true,
};
const activeAdmin = {
  accountStatus: 'active',
  isActive: true,
  role: 'admin',
};
const inactiveAdmin = {
  accountStatus: 'inactive',
  isActive: false,
  role: 'admin',
};
const passwordChangeAdmin = {
  ...activeAdmin,
  mustChangePassword: true,
};

const employeeUid = 'rules-employee';
const adminUid = 'rules-admin';
const recoveryUid = 'rules-recovery-user';
const recoveryEmail = 'recovery@example.test';
const registrationUid = 'rules-registration-user';
const registrationEmail = 'registration@example.test';
const rulesRequestTime = '2026-07-23T00:00:00Z';
const attendanceId = `${employeeUid}_2026-07-23`;
const attendancePath = firestorePath('attendances', attendanceId);
const attendanceData = {
  userId: employeeUid,
  date: '2026-07-23',
  status: 'ontime',
};
const correctionProposalPath = firestorePath(
  'attendanceCorrectionProposals',
  '11111111-1111-4111-8111-111111111111',
);
const correctionDecisionPath = firestorePath(
  'attendanceCorrectionDecisions',
  '11111111-1111-4111-8111-111111111111',
);
const correctionEffectivePath = firestorePath(
  'attendanceCorrectionEffectiveViews',
  attendanceId,
);
const correctionProposalData = {
  attendanceId,
  userId: employeeUid,
  status: 'pending',
  reason: 'Perangkat mati saat checkout.',
};
const correctionEffectiveData = {
  attendanceId,
  userId: employeeUid,
  workDate: '2026-07-23',
  manualCorrection: true,
  deviceVerified: false,
};
const geofenceProposalPath = firestorePath(
  'geofenceVerificationProposals',
  'proposal-1',
);
const geofenceProposalData = {
  schemaVersion: 2,
  status: 'pending',
  geofenceCollection: 'kelurahan',
  geofenceId: canonicalKelurahanId,
};
const pendingEmployee = {
  ...activeEmployee,
  accountStatus: 'pending',
  isActive: false,
};
const suspendedEmployee = {
  ...activeEmployee,
  accountStatus: 'suspended',
  isActive: false,
  statusChangedAt: '2026-07-22T00:00:00Z',
  statusChangedBy: adminUid,
};
const recoveryQueueData = {
  userId: recoveryUid,
  email: recoveryEmail,
  disabled: false,
};
const recoveryOfficeProfile = {
  uid: recoveryUid,
  name: 'Recovered Office User',
  email: recoveryEmail,
  role: 'office_staff',
  accountStatus: 'pending',
  isActive: false,
  createdAt: '2026-07-23T00:00:00Z',
  recoveredBy: adminUid,
  recoveredAt: '2026-07-23T00:00:00Z',
  recoverySource: 'admin-assisted',
  assignmentType: 'kantor',
  kantorId: canonicalKantorId,
  peranKantor: 'OPERATOR',
};
const recoveryRegistrationAfter = {
  userId: recoveryUid,
  requestedBy: adminUid,
  requestedAt: rulesRequestTime,
  status: 'pending',
  recoverySource: 'admin-assisted',
};
const recoveryAuditAfter = {
  action: 'queued_for_approval',
  targetUserId: recoveryUid,
  targetEmail: recoveryEmail,
  performedBy: adminUid,
  performedAt: rulesRequestTime,
  source: 'admin-assisted-recovery',
};
const registrationFieldProfile = {
  uid: registrationUid,
  name: 'Registration User',
  email: registrationEmail,
  role: 'field_staff',
  accountStatus: 'pending',
  isActive: false,
  assignmentType: 'kelurahan',
  kelurahanId: canonicalKelurahanId,
  kelurahanNama: canonicalKelurahanName,
  jenisTenagaAhli: 'TA_PERSAMP',
};
const registrationOfficeProfile = {
  uid: registrationUid,
  name: 'Registration User',
  email: registrationEmail,
  role: 'office_staff',
  accountStatus: 'pending',
  isActive: false,
  assignmentType: 'kantor',
  kantorId: canonicalKantorId,
  peranKantor: 'OPERATOR',
};

const canonicalAssignmentMocks = [
  firestoreDocumentMock('kelurahan', canonicalKelurahanId, {
    nama: canonicalKelurahanName,
  }),
  firestoreDocumentMock('kantor', canonicalKantorId, {
    nama: 'Kantor ISWMP Kota Padang',
  }),
];

const recoveryTransactionMocks = (
  queueData = recoveryQueueData,
  queueExistsAfter = false,
) => [
  firestoreUserMock(adminUid, activeAdmin),
  firestoreDocumentMock('incompleteRegistrations', recoveryUid, queueData),
  firestoreExistsAfterMock(
    'incompleteRegistrations',
    recoveryUid,
    queueExistsAfter,
  ),
  firestoreAfterMock(
    'registrationRequests',
    recoveryUid,
    recoveryRegistrationAfter,
  ),
  firestoreAfterMock('recoveryAuditLogs', recoveryUid, recoveryAuditAfter),
  ...canonicalAssignmentMocks,
];

const firestoreCases = [
  {
    name: 'employee cannot create attendance directly',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: attendancePath,
      method: 'create',
      resource: { data: attendanceData },
    },
  },
  {
    name: 'employee cannot update attendance directly',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: attendancePath,
      method: 'update',
      resource: { data: { ...attendanceData, workHours: 24 } },
    },
    resource: { data: attendanceData },
  },
  {
    name: 'active employee can read own attendance',
    expectation: 'ALLOW',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: attendancePath,
      method: 'get',
    },
    resource: { data: attendanceData },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'inactive employee cannot read own attendance',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: attendancePath,
      method: 'get',
    },
    resource: { data: attendanceData },
    functionMocks: [firestoreUserMock(employeeUid, inactiveEmployee)],
  },
  {
    name: 'employee with temporary password cannot read attendance',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: attendancePath,
      method: 'get',
    },
    resource: { data: attendanceData },
    functionMocks: [firestoreUserMock(employeeUid, passwordChangeEmployee)],
  },
  {
    name: 'active admin can read employee attendance',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: attendancePath,
      method: 'get',
    },
    resource: { data: attendanceData },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'inactive admin cannot read employee attendance',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: attendancePath,
      method: 'get',
    },
    resource: { data: attendanceData },
    functionMocks: [firestoreUserMock(adminUid, inactiveAdmin)],
  },
  {
    name: 'active admin cannot delete immutable attendance',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: attendancePath,
      method: 'delete',
    },
    resource: { data: attendanceData },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'admin with temporary password cannot read attendance',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: attendancePath,
      method: 'get',
    },
    resource: { data: attendanceData },
    functionMocks: [firestoreUserMock(adminUid, passwordChangeAdmin)],
  },
  {
    name: 'inactive admin cannot delete attendance',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: attendancePath,
      method: 'delete',
    },
    resource: { data: attendanceData },
    functionMocks: [firestoreUserMock(adminUid, inactiveAdmin)],
  },
  {
    name: 'client cannot read backend attendance challenge',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('attendanceChallenges', 'private-challenge'),
      method: 'get',
    },
    resource: { data: { uid: employeeUid, status: 'pending' } },
  },
  {
    name: 'client cannot mutate attendance challenge lock',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('attendanceChallengeLocks', `${employeeUid}_checkIn`),
      method: 'create',
      resource: { data: { uid: employeeUid } },
    },
  },
  {
    name: 'client cannot read attendance proof hash',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('attendanceProofHashes', 'private-digest'),
      method: 'get',
    },
    resource: { data: { uid: employeeUid, sha256: 'private' } },
  },
  {
    name: 'client cannot read perceptual attendance proof hash',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('attendanceProofPerceptualHashes', 'private-digest'),
      method: 'get',
    },
    resource: { data: { uid: employeeUid, perceptualHash: 'private' } },
  },
  {
    name: 'client cannot read perceptual replay band guard',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath(
        'attendanceProofPerceptualBandGuards',
        'dh144v1_b0_deadbeefdead',
      ),
      method: 'get',
    },
    resource: {
      data: {
        bandKey: 'dh144v1_b0_deadbeefdead',
        hashVersion: 'dh144v1',
        proofCount: 1,
      },
    },
  },
  {
    name: 'client cannot read own GPS signal trace',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath(
        'attendanceGpsTraces',
        `${employeeUid}_2026-07-30_checkIn`,
      ),
      method: 'get',
    },
    resource: { data: { uid: employeeUid, samples: [] } },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'browser admin cannot read a GPS signal trace',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath(
        'attendanceGpsTraces',
        `${employeeUid}_2026-07-30_checkIn`,
      ),
      method: 'get',
    },
    resource: { data: { uid: employeeUid, samples: [] } },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'client cannot forge a GPS signal trace',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath(
        'attendanceGpsTraces',
        `${employeeUid}_2026-07-30_checkIn`,
      ),
      method: 'create',
      resource: { data: { uid: employeeUid, samples: [] } },
    },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'client cannot read or seed a GPS trace replay digest',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('attendanceGpsTraceDigests', 'a'.repeat(64)),
      method: 'get',
    },
    resource: { data: { digest: 'a'.repeat(64), occurrences: 1 } },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'client cannot read private same-user perceptual replay state',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('attendancePerceptualReplayStates', employeeUid),
      method: 'get',
    },
    resource: { data: { uid: employeeUid, entries: [] } },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'client cannot read private active shift pointer',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('attendanceOpenShifts', employeeUid),
      method: 'get',
    },
    resource: { data: { uid: employeeUid, status: 'open' } },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'browser admin cannot mutate active shift pointer',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('attendanceOpenShifts', employeeUid),
      method: 'update',
      resource: {
        data: { uid: employeeUid, status: 'closed' },
      },
    },
    resource: { data: { uid: employeeUid, status: 'open' } },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin can read attendance correction proposal',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: correctionProposalPath,
      method: 'get',
    },
    resource: { data: correctionProposalData },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'employee cannot read attendance correction proposal reason',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: correctionProposalPath,
      method: 'get',
    },
    resource: { data: correctionProposalData },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'active admin can read attendance correction decision',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: correctionDecisionPath,
      method: 'get',
    },
    resource: {
      data: { attendanceId, userId: employeeUid, status: 'approved' },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'employee can read own privacy-reduced correction effective view',
    expectation: 'ALLOW',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: correctionEffectivePath,
      method: 'get',
    },
    resource: { data: correctionEffectiveData },
    functionMocks: [
      firestoreUserMock(employeeUid, activeEmployee),
      firestoreDocumentMock('attendances', attendanceId, attendanceData),
    ],
  },
  {
    name: 'employee can safely get an absent own correction effective view',
    expectation: 'ALLOW',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: correctionEffectivePath,
      method: 'get',
    },
    functionMocks: [
      firestoreUserMock(employeeUid, activeEmployee),
      firestoreDocumentMock('attendances', attendanceId, attendanceData),
    ],
  },
  {
    name: 'other employee cannot read correction effective view',
    expectation: 'DENY',
    request: {
      auth: { uid: 'rules-other-employee', token: {} },
      path: correctionEffectivePath,
      method: 'get',
    },
    resource: { data: correctionEffectiveData },
    functionMocks: [
      firestoreUserMock('rules-other-employee', activeEmployee),
      firestoreDocumentMock('attendances', attendanceId, attendanceData),
    ],
  },
  {
    name: 'inactive owner cannot read correction effective view',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: correctionEffectivePath,
      method: 'get',
    },
    resource: { data: correctionEffectiveData },
    functionMocks: [
      firestoreUserMock(employeeUid, inactiveEmployee),
      firestoreDocumentMock('attendances', attendanceId, attendanceData),
    ],
  },
  {
    name: 'browser admin cannot create correction effective view',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: correctionEffectivePath,
      method: 'create',
      resource: { data: correctionEffectiveData },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'admin cannot read private full attendance correction event',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath(
        'attendanceCorrectionEvents',
        '11111111-1111-4111-8111-111111111111',
      ),
      method: 'get',
    },
    resource: {
      data: {
        attendanceId,
        reason: 'Perangkat mati saat checkout.',
        proposerUid: adminUid,
      },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'client cannot read challenge-bound onsite grant',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('attendancePresenceGrants', 'private-grant'),
      method: 'get',
    },
    resource: { data: { uid: employeeUid, status: 'active' } },
  },
  {
    name: 'client cannot read geofence presence secret',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('geofencePresenceSecrets', 'kelurahan_secret'),
      method: 'get',
    },
    resource: { data: { secret: 'never-returned-to-client' } },
  },
  {
    name: 'active admin can get geofence verification proposal',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: geofenceProposalPath,
      method: 'get',
    },
    resource: { data: geofenceProposalData },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin can list geofence verification proposals',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: geofenceProposalPath,
      method: 'list',
    },
    resource: { data: geofenceProposalData },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active employee cannot read geofence verification proposal',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: geofenceProposalPath,
      method: 'get',
    },
    resource: { data: geofenceProposalData },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'inactive admin cannot read geofence verification proposal',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: geofenceProposalPath,
      method: 'get',
    },
    resource: { data: geofenceProposalData },
    functionMocks: [firestoreUserMock(adminUid, inactiveAdmin)],
  },
  {
    name: 'temporary-password admin cannot read geofence verification proposal',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: geofenceProposalPath,
      method: 'get',
    },
    resource: { data: geofenceProposalData },
    functionMocks: [firestoreUserMock(adminUid, passwordChangeAdmin)],
  },
  {
    name: 'active admin cannot create geofence verification proposal',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: geofenceProposalPath,
      method: 'create',
      resource: { data: geofenceProposalData },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot update geofence verification proposal',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: geofenceProposalPath,
      method: 'update',
      resource: {
        data: { ...geofenceProposalData, status: 'approved' },
      },
    },
    resource: { data: geofenceProposalData },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot delete geofence verification proposal',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: geofenceProposalPath,
      method: 'delete',
    },
    resource: { data: geofenceProposalData },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot read private geofence verification audit log',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('geofenceVerificationAuditLogs', 'private-audit'),
      method: 'get',
    },
    resource: { data: { schemaVersion: 2, status: 'approved' } },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'employee cannot promote own account to admin',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: {
        data: { ...activeEmployee, role: 'admin', isAdmin: true },
      },
    },
    resource: { data: activeEmployee },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'pending employee cannot activate own account',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: {
        data: { ...activeEmployee },
      },
    },
    resource: {
      data: {
        ...activeEmployee,
        accountStatus: 'pending',
        isActive: false,
      },
    },
    functionMocks: [firestoreUserMock(employeeUid, {
      accountStatus: 'pending',
      isActive: false,
      role: 'field_staff',
    })],
  },
  {
    name: 'employee cannot change own geofence assignment',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: {
        data: {
          ...activeEmployee,
          assignmentType: 'kelurahan',
          kelurahanId: 'attacker-selected-location',
        },
      },
    },
    resource: {
      data: {
        ...activeEmployee,
        assignmentType: 'kelurahan',
        kelurahanId: canonicalKelurahanId,
      },
    },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'self-registration can create canonical field assignment',
    expectation: 'ALLOW',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('users', registrationUid),
      method: 'create',
      resource: { data: registrationFieldProfile },
    },
    functionMocks: canonicalAssignmentMocks,
  },
  {
    name: 'self-registration can create canonical office assignment',
    expectation: 'ALLOW',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('users', registrationUid),
      method: 'create',
      resource: { data: registrationOfficeProfile },
    },
    functionMocks: canonicalAssignmentMocks,
  },
  {
    name: 'self-registration cannot select an unknown geofence',
    expectation: 'DENY',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('users', registrationUid),
      method: 'create',
      resource: {
        data: {
          ...registrationFieldProfile,
          kelurahanId: 'kel-attacker-location',
          kelurahanNama: 'Attacker Location',
        },
      },
    },
  },
  {
    name: 'self-registration cannot forge canonical geofence name',
    expectation: 'DENY',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('users', registrationUid),
      method: 'create',
      resource: {
        data: {
          ...registrationFieldProfile,
          kelurahanNama: 'Forged Name',
        },
      },
    },
    functionMocks: canonicalAssignmentMocks,
  },
  {
    name: 'self-registration cannot forge assignment subtype',
    expectation: 'DENY',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('users', registrationUid),
      method: 'create',
      resource: {
        data: {
          ...registrationFieldProfile,
          jenisTenagaAhli: 'ATTACKER_SELECTED_ROLE',
        },
      },
    },
    functionMocks: canonicalAssignmentMocks,
  },
  {
    name: 'self-registration cannot use legacy unassigned employee role',
    expectation: 'DENY',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('users', registrationUid),
      method: 'create',
      resource: {
        data: {
          uid: registrationUid,
          name: 'Unassigned User',
          email: registrationEmail,
          role: 'employee',
          accountStatus: 'pending',
          isActive: false,
        },
      },
    },
  },
  {
    name: 'self-registration can create one UID-bound queue item',
    expectation: 'ALLOW',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('registrationRequests', registrationUid),
      method: 'create',
      time: rulesRequestTime,
      resource: {
        data: {
          userId: registrationUid,
          requestedBy: registrationUid,
          requestedAt: rulesRequestTime,
          status: 'pending',
        },
      },
    },
    functionMocks: [
      firestoreAfterMock('users', registrationUid, registrationFieldProfile),
    ],
  },
  {
    name: 'self-registration cannot spam arbitrary queue document IDs',
    expectation: 'DENY',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('registrationRequests', 'attacker-selected-id'),
      method: 'create',
      time: rulesRequestTime,
      resource: {
        data: {
          userId: registrationUid,
          requestedBy: registrationUid,
          requestedAt: rulesRequestTime,
          status: 'pending',
        },
      },
    },
    functionMocks: [
      firestoreAfterMock('users', registrationUid, registrationFieldProfile),
    ],
  },
  {
    name: 'self-registration cannot backdate queue creation',
    expectation: 'DENY',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('registrationRequests', registrationUid),
      method: 'create',
      time: rulesRequestTime,
      resource: {
        data: {
          userId: registrationUid,
          requestedBy: registrationUid,
          requestedAt: '2026-07-22T00:00:00Z',
          status: 'pending',
        },
      },
    },
    functionMocks: [
      firestoreAfterMock('users', registrationUid, registrationFieldProfile),
    ],
  },
  {
    name: 'self-registration cannot mismatch role and assignment type',
    expectation: 'DENY',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('users', registrationUid),
      method: 'create',
      resource: {
        data: {
          ...registrationOfficeProfile,
          role: 'field_staff',
        },
      },
    },
  },
  {
    name: 'self-registration cannot forge password security metadata',
    expectation: 'DENY',
    request: {
      auth: {
        uid: registrationUid,
        token: { email: registrationEmail },
      },
      path: firestorePath('users', registrationUid),
      method: 'create',
      resource: {
        data: {
          ...registrationFieldProfile,
          mustChangePassword: false,
          passwordResetAt: rulesRequestTime,
          passwordResetBy: registrationUid,
        },
      },
    },
  },
  {
    name: 'active employee can update allowed own profile fields',
    expectation: 'ALLOW',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...activeEmployee,
          bpjsNumber: 'BPJS-001',
          address: 'Updated address',
          updatedAt: rulesRequestTime,
        },
      },
    },
    resource: { data: activeEmployee },
    functionMocks: [firestoreUserMock(employeeUid, activeEmployee)],
  },
  {
    name: 'active admin can approve a pending non-admin account',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...activeEmployee,
          approvedAt: '2026-07-23T00:00:00Z',
          approvedBy: adminUid,
          assignmentReviewedAt: '2026-07-23T00:00:00Z',
          assignmentReviewedBy: adminUid,
        },
      },
    },
    resource: {
      data: {
        ...activeEmployee,
        accountStatus: 'pending',
        isActive: false,
      },
    },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      ...canonicalAssignmentMocks,
    ],
  },
  {
    name: 'active admin cannot approve without assignment review audit',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...activeEmployee,
          approvedAt: rulesRequestTime,
          approvedBy: adminUid,
        },
      },
    },
    resource: { data: pendingEmployee },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      ...canonicalAssignmentMocks,
    ],
  },
  {
    name: 'active admin can edit allowed non-admin profile fields',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...activeEmployee,
          name: 'Updated Employee',
          department: 'Operations',
          updatedAt: rulesRequestTime,
          updatedBy: adminUid,
        },
      },
    },
    resource: {
      data: {
        ...activeEmployee,
        name: 'Original Employee',
        department: 'Field',
      },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot edit profile without audit metadata',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: { ...activeEmployee, name: 'Unaudited Edit' },
      },
    },
    resource: { data: activeEmployee },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot backdate profile audit metadata',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...activeEmployee,
          name: 'Backdated Edit',
          updatedAt: '2026-07-22T00:00:00Z',
          updatedBy: adminUid,
        },
      },
    },
    resource: { data: activeEmployee },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot promote an employee to admin',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: {
        data: { ...activeEmployee, role: 'admin', isAdmin: true },
      },
    },
    resource: { data: activeEmployee },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot change an employee geofence assignment',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: {
        data: {
          ...activeEmployee,
          assignmentType: 'kelurahan',
          kelurahanId: 'attacker-selected-location',
        },
      },
    },
    resource: {
      data: {
        ...activeEmployee,
        assignmentType: 'kelurahan',
        kelurahanId: canonicalKelurahanId,
      },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot edit another admin account',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', 'rules-second-admin'),
      method: 'update',
      resource: {
        data: { ...activeAdmin, name: 'Tampered Admin' },
      },
    },
    resource: {
      data: { ...activeAdmin, name: 'Second Admin' },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin can create queued pending recovery user',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', recoveryUid),
      method: 'create',
      time: rulesRequestTime,
      resource: {
        data: {
          uid: recoveryUid,
          name: 'Recovered User',
          email: recoveryEmail,
          role: 'field_staff',
          accountStatus: 'pending',
          isActive: false,
          createdAt: '2026-07-23T00:00:00Z',
          recoveredBy: adminUid,
          recoveredAt: '2026-07-23T00:00:00Z',
          recoverySource: 'admin-assisted',
          assignmentType: 'kelurahan',
          kelurahanId: canonicalKelurahanId,
          kelurahanNama: canonicalKelurahanName,
          jenisTenagaAhli: 'TA_PERSAMP',
        },
      },
    },
    functionMocks: recoveryTransactionMocks(),
  },
  {
    name: 'active admin cannot create an admin from recovery queue',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', recoveryUid),
      method: 'create',
      resource: {
        data: {
          uid: recoveryUid,
          name: 'Forged Admin',
          email: recoveryEmail,
          role: 'admin',
          accountStatus: 'pending',
          isActive: false,
          createdAt: '2026-07-23T00:00:00Z',
          recoveredBy: adminUid,
          recoveredAt: '2026-07-23T00:00:00Z',
          recoverySource: 'admin-assisted',
          assignmentType: 'kantor',
          kantorId: 'kantor-padang-kota',
          peranKantor: 'OPERATOR',
        },
      },
    },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      firestoreDocumentMock('incompleteRegistrations', recoveryUid, {
        userId: recoveryUid,
        email: recoveryEmail,
        disabled: false,
      }),
    ],
  },
  {
    name: 'active admin cannot create recovery user without matching queue',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', recoveryUid),
      method: 'create',
      resource: {
        data: {
          uid: recoveryUid,
          name: 'Unqueued User',
          email: recoveryEmail,
          role: 'office_staff',
          accountStatus: 'pending',
          isActive: false,
          createdAt: '2026-07-23T00:00:00Z',
          recoveredBy: adminUid,
          recoveredAt: '2026-07-23T00:00:00Z',
          recoverySource: 'admin-assisted',
          assignmentType: 'kantor',
          kantorId: 'kantor-padang-kota',
          peranKantor: 'OPERATOR',
        },
      },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin can create queued office recovery user',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', recoveryUid),
      method: 'create',
      time: rulesRequestTime,
      resource: { data: recoveryOfficeProfile },
    },
    functionMocks: recoveryTransactionMocks(),
  },
  {
    name: 'admin recovery must delete queue in same atomic transaction',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', recoveryUid),
      method: 'create',
      time: rulesRequestTime,
      resource: { data: recoveryOfficeProfile },
    },
    functionMocks: recoveryTransactionMocks(recoveryQueueData, true),
  },
  {
    name: 'browser admin cannot forge recovery queue prerequisite',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('incompleteRegistrations', 'forged-user'),
      method: 'create',
      resource: {
        data: {
          userId: 'forged-user',
          email: 'forged@example.test',
          disabled: false,
        },
      },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'valid recovery audit is allowed only with same atomic transaction',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('recoveryAuditLogs', recoveryUid),
      method: 'create',
      time: rulesRequestTime,
      resource: { data: recoveryAuditAfter },
    },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      firestoreAfterMock('users', recoveryUid, recoveryOfficeProfile),
      firestoreAfterMock(
        'registrationRequests',
        recoveryUid,
        recoveryRegistrationAfter,
      ),
      firestoreExistsAfterMock(
        'incompleteRegistrations',
        recoveryUid,
        false,
      ),
    ],
  },
  {
    name: 'browser admin cannot precreate standalone recovery audit',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('recoveryAuditLogs', recoveryUid),
      method: 'create',
      time: rulesRequestTime,
      resource: { data: recoveryAuditAfter },
    },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      firestoreAfterMock('users', recoveryUid, {
        ...recoveryOfficeProfile,
        recoveredAt: '2026-07-22T00:00:00Z',
      }),
      firestoreAfterMock(
        'registrationRequests',
        recoveryUid,
        recoveryRegistrationAfter,
      ),
      firestoreExistsAfterMock(
        'incompleteRegistrations',
        recoveryUid,
        false,
      ),
    ],
  },
  {
    name: 'admin can delete recovery queue only while materializing user',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('incompleteRegistrations', recoveryUid),
      method: 'delete',
      time: rulesRequestTime,
    },
    resource: { data: recoveryQueueData },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      firestoreAfterMock('users', recoveryUid, recoveryOfficeProfile),
    ],
  },
  {
    name: 'admin cannot delete recovery queue as standalone action',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('incompleteRegistrations', recoveryUid),
      method: 'delete',
      time: rulesRequestTime,
    },
    resource: { data: recoveryQueueData },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'account owner can delete own recovery queue during self-recovery',
    expectation: 'ALLOW',
    request: {
      auth: { uid: recoveryUid, token: {} },
      path: firestorePath('incompleteRegistrations', recoveryUid),
      method: 'delete',
    },
    resource: { data: recoveryQueueData },
  },
  {
    name: 'active admin cannot create non-admin with isAdmin alias',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', recoveryUid),
      method: 'create',
      resource: {
        data: { ...recoveryOfficeProfile, isAdmin: true },
      },
    },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      firestoreDocumentMock(
        'incompleteRegistrations',
        recoveryUid,
        recoveryQueueData,
      ),
    ],
  },
  {
    name: 'active admin cannot recover user from mismatched queue email',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', recoveryUid),
      method: 'create',
      resource: { data: recoveryOfficeProfile },
    },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      firestoreDocumentMock('incompleteRegistrations', recoveryUid, {
        ...recoveryQueueData,
        email: 'different@example.test',
      }),
    ],
  },
  {
    name: 'active admin cannot add isAdmin alias to employee',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: { data: { ...activeEmployee, isAdmin: true } },
    },
    resource: { data: activeEmployee },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot change employee role between non-admin roles',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: { data: { ...activeEmployee, role: 'office_staff' } },
    },
    resource: { data: activeEmployee },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin can reject pending non-admin account',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...pendingEmployee,
          accountStatus: 'rejected',
          rejectedAt: '2026-07-23T00:00:00Z',
          rejectedBy: adminUid,
        },
      },
    },
    resource: { data: pendingEmployee },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin can suspend active non-admin account',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...activeEmployee,
          accountStatus: 'suspended',
          isActive: false,
          statusChangedAt: '2026-07-23T00:00:00Z',
          statusChangedBy: adminUid,
        },
      },
    },
    resource: { data: activeEmployee },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'same active admin can reactivate suspended non-admin account',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...suspendedEmployee,
          accountStatus: 'active',
          isActive: true,
          statusChangedAt: '2026-07-23T00:00:00Z',
          statusChangedBy: adminUid,
        },
      },
    },
    resource: { data: suspendedEmployee },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot reactivate archived account',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: {
        data: {
          ...activeEmployee,
          statusChangedAt: '2026-07-23T00:00:00Z',
          statusChangedBy: adminUid,
        },
      },
    },
    resource: {
      data: {
        ...activeEmployee,
        accountStatus: 'archived',
        isActive: false,
      },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'active admin cannot forge approval actor',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...activeEmployee,
          approvedAt: '2026-07-23T00:00:00Z',
          approvedBy: 'forged-admin',
          assignmentReviewedAt: rulesRequestTime,
          assignmentReviewedBy: adminUid,
        },
      },
    },
    resource: { data: pendingEmployee },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      ...canonicalAssignmentMocks,
    ],
  },
  {
    name: 'active admin cannot mix forged rejection audit into approval',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      time: rulesRequestTime,
      resource: {
        data: {
          ...activeEmployee,
          approvedAt: '2026-07-23T00:00:00Z',
          approvedBy: adminUid,
          assignmentReviewedAt: rulesRequestTime,
          assignmentReviewedBy: adminUid,
          rejectedAt: '2026-07-23T00:00:00Z',
          rejectedBy: 'forged-admin',
        },
      },
    },
    resource: { data: pendingEmployee },
    functionMocks: [
      firestoreUserMock(adminUid, activeAdmin),
      ...canonicalAssignmentMocks,
    ],
  },
  {
    name: 'active admin cannot change Firestore email independently of Auth',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: {
        data: { ...activeEmployee, email: 'desynced@example.test' },
      },
    },
    resource: { data: activeEmployee },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'inactive employee cannot edit own profile',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: firestorePath('users', employeeUid),
      method: 'update',
      resource: {
        data: { ...inactiveEmployee, name: 'Changed While Inactive' },
      },
    },
    resource: { data: { ...inactiveEmployee, name: 'Inactive Employee' } },
    functionMocks: [firestoreUserMock(employeeUid, inactiveEmployee)],
  },
  {
    name: 'application admin cannot self-verify a kelurahan geofence',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('kelurahan', 'geofence-1'),
      method: 'update',
      resource: {
        data: {
          lat: -0.9,
          lng: 100.3,
          radius: 2000,
          isActive: true,
          coordinateStatus: 'verified',
          verifiedAt: '2026-07-23T00:00:00Z',
          presenceProofRequired: true,
        },
      },
    },
    resource: {
      data: {
        lat: -0.8,
        lng: 100.2,
        radius: 100,
        isActive: false,
        coordinateStatus: 'provisional',
        verifiedAt: null,
        presenceProofRequired: true,
      },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'application admin cannot self-verify an office geofence',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('kantor', 'office-1'),
      method: 'update',
      resource: {
        data: {
          lat: -0.9,
          lng: 100.3,
          radius: 2000,
          isActive: true,
          coordinateStatus: 'verified',
          verifiedAt: '2026-07-23T00:00:00Z',
          presenceProofRequired: true,
        },
      },
    },
    resource: {
      data: {
        lat: -0.8,
        lng: 100.2,
        radius: 100,
        isActive: false,
        coordinateStatus: 'provisional',
        verifiedAt: null,
        presenceProofRequired: true,
      },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
  {
    name: 'application admin cannot lower server attendance policy',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: firestorePath('projectConfig', 'default'),
      method: 'update',
      resource: {
        data: {
          attendanceSecurityVersion: 0,
          geofenceTransitionMode: true,
        },
      },
    },
    resource: {
      data: {
        attendanceSecurityVersion: 2,
        geofenceTransitionMode: false,
      },
    },
    functionMocks: [firestoreUserMock(adminUid, activeAdmin)],
  },
];

const storageUserMock = (uid, data) => ({
  function: 'firestore.get',
  args: [{ exactValue: firestorePath('users', uid) }],
  result: { value: { data } },
});

const challengeId = '11111111-1111-4111-8111-111111111111';
const proofObjectPath = `attendanceProofs/${employeeUid}/${challengeId}`;
const proofRequestPath = `/b/${bucket}/o/${proofObjectPath}`;
const validProof = {
  name: proofRequestPath,
  bucket,
  size: 100 * 1024,
  contentType: 'image/jpeg',
  metadata: {
    challengeId,
    uid: employeeUid,
    action: 'checkIn',
  },
};

const storageChallengeMock = (overrides = {}) => ({
  function: 'firestore.get',
  args: [{
    exactValue: firestorePath('attendanceChallenges', challengeId),
  }],
  result: {
    value: {
      data: {
        uid: employeeUid,
        action: 'checkIn',
        status: 'pending',
        photoPath: proofObjectPath,
        expiresAt: '2099-01-01T00:00:00Z',
        consumedAt: null,
        attendanceId: null,
        ...overrides,
      },
    },
  },
});

const validStorageMocks = [
  storageChallengeMock(),
  storageUserMock(employeeUid, activeEmployee),
];

const storageWriteRequest = (resource = validProof) => ({
  auth: { uid: employeeUid, token: {} },
  path: proofRequestPath,
  method: 'create',
  time: '2026-07-23T00:00:00Z',
  resource,
});

const storageCases = [
  {
    name: 'valid one-time JPEG proof upload is allowed',
    expectation: 'ALLOW',
    request: storageWriteRequest(),
    functionMocks: validStorageMocks,
    pathEncoding: 'PLAIN',
  },
  {
    name: 'upload without backend challenge is denied',
    expectation: 'DENY',
    request: storageWriteRequest(),
    functionMocks: [storageUserMock(employeeUid, activeEmployee)],
    pathEncoding: 'PLAIN',
  },
  {
    name: 'temporary-password account cannot upload attendance proof',
    expectation: 'DENY',
    request: storageWriteRequest(),
    functionMocks: [
      storageChallengeMock(),
      storageUserMock(employeeUid, passwordChangeEmployee),
    ],
    pathEncoding: 'PLAIN',
  },
  {
    name: 'expired challenge is denied',
    expectation: 'DENY',
    request: storageWriteRequest(),
    functionMocks: [
      storageChallengeMock({ expiresAt: '2026-07-22T23:59:59Z' }),
      storageUserMock(employeeUid, activeEmployee),
    ],
    pathEncoding: 'PLAIN',
  },
  {
    name: 'consumed challenge is denied',
    expectation: 'DENY',
    request: storageWriteRequest(),
    functionMocks: [
      storageChallengeMock({
        status: 'consumed',
        consumedAt: '2026-07-23T00:00:00Z',
        attendanceId,
      }),
      storageUserMock(employeeUid, activeEmployee),
    ],
    pathEncoding: 'PLAIN',
  },
  {
    name: 'forged proof metadata owner is denied',
    expectation: 'DENY',
    request: storageWriteRequest({
      ...validProof,
      metadata: { ...validProof.metadata, uid: 'another-user' },
    }),
    functionMocks: validStorageMocks,
    pathEncoding: 'PLAIN',
  },
  {
    name: 'extra proof metadata is denied',
    expectation: 'DENY',
    request: storageWriteRequest({
      ...validProof,
      metadata: { ...validProof.metadata, untrusted: 'value' },
    }),
    functionMocks: validStorageMocks,
    pathEncoding: 'PLAIN',
  },
  {
    name: 'non-JPEG proof is denied',
    expectation: 'DENY',
    request: storageWriteRequest({
      ...validProof,
      contentType: 'image/png',
    }),
    functionMocks: validStorageMocks,
    pathEncoding: 'PLAIN',
  },
  {
    name: 'tiny proof is denied',
    expectation: 'DENY',
    request: storageWriteRequest({ ...validProof, size: 1024 }),
    functionMocks: validStorageMocks,
    pathEncoding: 'PLAIN',
  },
  {
    name: 'proof overwrite is denied',
    expectation: 'DENY',
    request: {
      ...storageWriteRequest(),
      method: 'update',
    },
    resource: validProof,
    pathEncoding: 'PLAIN',
  },
  {
    name: 'proof deletion is denied',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: proofRequestPath,
      method: 'delete',
    },
    resource: validProof,
    pathEncoding: 'PLAIN',
  },
  {
    name: 'legacy arbitrary attendance upload is denied',
    expectation: 'DENY',
    request: {
      ...storageWriteRequest(),
      path: `/b/${bucket}/o/attendances/${employeeUid}/fake.jpg`,
      resource: {
        ...validProof,
        name: `/b/${bucket}/o/attendances/${employeeUid}/fake.jpg`,
      },
    },
    pathEncoding: 'PLAIN',
  },
  {
    name: 'active employee can read own historical proof',
    expectation: 'ALLOW',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: `/b/${bucket}/o/attendances/${employeeUid}/old.jpg`,
      method: 'get',
    },
    resource: {
      ...validProof,
      name: `/b/${bucket}/o/attendances/${employeeUid}/old.jpg`,
    },
    functionMocks: [storageUserMock(employeeUid, activeEmployee)],
    pathEncoding: 'PLAIN',
  },
  {
    name: 'inactive employee cannot read own historical proof',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: `/b/${bucket}/o/attendances/${employeeUid}/old.jpg`,
      method: 'get',
    },
    resource: {
      ...validProof,
      name: `/b/${bucket}/o/attendances/${employeeUid}/old.jpg`,
    },
    functionMocks: [storageUserMock(employeeUid, inactiveEmployee)],
    pathEncoding: 'PLAIN',
  },
  {
    name: 'temporary-password account cannot read historical proof',
    expectation: 'DENY',
    request: {
      auth: { uid: employeeUid, token: {} },
      path: `/b/${bucket}/o/attendances/${employeeUid}/old.jpg`,
      method: 'get',
    },
    resource: {
      ...validProof,
      name: `/b/${bucket}/o/attendances/${employeeUid}/old.jpg`,
    },
    functionMocks: [storageUserMock(employeeUid, passwordChangeEmployee)],
    pathEncoding: 'PLAIN',
  },
  {
    name: 'active admin can read employee proof',
    expectation: 'ALLOW',
    request: {
      auth: { uid: adminUid, token: {} },
      path: proofRequestPath,
      method: 'get',
    },
    resource: validProof,
    functionMocks: [storageUserMock(adminUid, activeAdmin)],
    pathEncoding: 'PLAIN',
  },
  {
    name: 'inactive admin cannot read employee proof',
    expectation: 'DENY',
    request: {
      auth: { uid: adminUid, token: {} },
      path: proofRequestPath,
      method: 'get',
    },
    resource: validProof,
    functionMocks: [storageUserMock(adminUid, inactiveAdmin)],
    pathEncoding: 'PLAIN',
  },
];

console.log('Firestore rules');
const firestorePassed = await testRules('firestore.rules', firestoreCases);
console.log('\nStorage rules');
const storagePassed = await testRules('storage.rules', storageCases);

if (!firestorePassed || !storagePassed) {
  process.exitCode = 1;
} else {
  console.log(
    `\nAll ${firestoreCases.length + storageCases.length} security tests passed.`,
  );
}
