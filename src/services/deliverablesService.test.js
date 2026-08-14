import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KAK_DELIVERABLES_CONFIG,
  DELIVERABLE_CATEGORIES,
  MAX_DELIVERABLE_FILE_BYTES,
  buildOfflineDeliverableCache,
  buildDeliverableSubmissionPayload,
  formatFileSize,
  getSafeHttpUrl,
  getPublicDeliverableFileUrl,
  getYouTubeEmbedUrl,
  isUsableFirebaseStorage,
  mergeDeliverableFiles,
  requireRemoteDeliverablePersistence,
  resolveDeliverableContentType,
  sanitizePublicDeliverableFiles,
  validateDeliverableFile,
} from './deliverablesService.js';
import { storage } from '../config/firebase.js';

test('deliverablesService: deliverables configuration contains 15 KAK deliverables and 16 BOQ activities (total 31)', () => {
  assert.equal(KAK_DELIVERABLES_CONFIG.length, 31);
  assert.equal(DELIVERABLE_CATEGORIES.length, 5);

  const pendahuluan = KAK_DELIVERABLES_CONFIG.filter((d) => d.category === 'pendahuluan');
  const bulanan = KAK_DELIVERABLES_CONFIG.filter((d) => d.category === 'bulanan');
  const triwulanan = KAK_DELIVERABLES_CONFIG.filter((d) => d.category === 'triwulanan');
  const akhir = KAK_DELIVERABLES_CONFIG.filter((d) => d.category === 'akhir');
  const kegiatanBoq = KAK_DELIVERABLES_CONFIG.filter((d) => d.category === 'kegiatan_boq');

  assert.equal(pendahuluan.length, 1);
  assert.equal(bulanan.length, 10);
  assert.equal(triwulanan.length, 3);
  assert.equal(akhir.length, 1);
  assert.equal(kegiatanBoq.length, 16);
});

test('deliverablesService: BOQ activities include Kick Off, BimTek, 11 Kelurahan FGD, RTPS, and Piloting', () => {
  const bimtek = KAK_DELIVERABLES_CONFIG.find((d) => d.id === 'boq_bimtek_petugas_lapangan');
  assert.ok(bimtek);
  assert.equal(bimtek.code, 'BOQ-IV.4');
  assert.ok(bimtek.requiredDeliverableOutputs.some((o) => o.includes('Video')));

  const fgd11 = KAK_DELIVERABLES_CONFIG.find((d) => d.id === 'boq_fgd_rw_11_kelurahan');
  assert.ok(fgd11);
  assert.equal(fgd11.code, 'BOQ-IV.Desa.1');

  const piloting = KAK_DELIVERABLES_CONFIG.find((d) => d.id === 'boq_piloting_uji_coba_lapangan');
  assert.ok(piloting);
  assert.equal(piloting.code, 'BOQ-C.1-C.2');
});

test('deliverablesService: Inception Report has all 6 KAK scope requirements', () => {
  const inception = KAK_DELIVERABLES_CONFIG.find((d) => d.id === 'laporan_pendahuluan');
  assert.ok(inception);
  assert.equal(inception.code, 'LP');
  assert.equal(inception.copiesRequired, 3);
  assert.equal(inception.scopeItems.length, 6);
  assert.equal(inception.requiredDeliverableOutputs.length, 3);
});

test('deliverablesService: Monthly Reports span 10 periods with RTPS & Kelembagaan scope', () => {
  const monthlyReports = KAK_DELIVERABLES_CONFIG.filter((d) => d.category === 'bulanan');
  assert.equal(monthlyReports.length, 10);

  monthlyReports.forEach((m, idx) => {
    assert.equal(m.monthNumber, idx + 1);
    assert.equal(m.copiesRequired, 3);
    assert.ok(m.scopeItems.some((s) => s.includes('RTPS') || s.includes('Kelembagaan')));
  });
});

test('deliverablesService: Quarterly Reports require BPBPK presentation slide deliverables', () => {
  const quarterlyReports = KAK_DELIVERABLES_CONFIG.filter((d) => d.category === 'triwulanan');
  assert.equal(quarterlyReports.length, 3);

  quarterlyReports.forEach((q) => {
    assert.ok(q.requiredDeliverableOutputs.some((out) => out.includes('Presentasi Slide') || out.includes('.pptx')));
    assert.ok(q.scopeItems.some((s) => s.includes('RKTL') || s.includes('Rencana Kerja dan Tindak Lanjut')));
  });
});

test('deliverablesService: Final Report includes BNBA database and SSD 1TB deliverable', () => {
  const finalDoc = KAK_DELIVERABLES_CONFIG.find((d) => d.id === 'laporan_akhir');
  assert.ok(finalDoc);
  assert.equal(finalDoc.code, 'LA-FINAL');
  assert.equal(finalDoc.copiesRequired, 3);
  assert.ok(finalDoc.scopeItems.some((s) => s.includes('By Name By Address') || s.includes('BNBA')));
  assert.ok(finalDoc.requiredDeliverableOutputs.some((out) => out.includes('SSD 1TB')));
});

test('deliverablesService: formatFileSize converts bytes into human-readable strings', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1024 * 1024 * 5.5), '5.5 MB');
  assert.equal(formatFileSize(1024 * 1024 * 1024 * 1.2), '1.2 GB');
});

test('deliverablesService: recognizes modular Firebase Storage without a namespaced ref method', () => {
  assert.equal(typeof storage.ref, 'undefined');
  assert.equal(isUsableFirebaseStorage(storage), true);
  assert.equal(isUsableFirebaseStorage({ ref() {} }), false);
  assert.equal(isUsableFirebaseStorage(null), false);
});

test('deliverablesService: public video URLs fail closed and YouTube URLs embed safely', () => {
  assert.equal(getSafeHttpUrl('youtube.com/watch?v=abcdefghijk'), null);
  assert.equal(getSafeHttpUrl('javascript:alert(1)'), null);
  assert.equal(
    getYouTubeEmbedUrl('https://www.youtube.com/watch?v=abcdefghijk'),
    'https://www.youtube-nocookie.com/embed/abcdefghijk'
  );
  assert.equal(
    getYouTubeEmbedUrl('https://youtu.be/abcdefghijk?t=10'),
    'https://www.youtube-nocookie.com/embed/abcdefghijk'
  );
  assert.equal(getYouTubeEmbedUrl('https://example.com/youtube.com'), null);
});

test('deliverablesService: public files expose tokenless rule-checked paths only', () => {
  const publicFiles = sanitizePublicDeliverableFiles([{
    name: 'laporan.pdf',
    size: 1024,
    type: 'application/pdf',
    storagePath: 'deliverables/laporan_pendahuluan/upload_laporan.pdf',
    url: 'https://example.test/?token=secret',
    uploadReservationId: 'private-reservation',
    uploadedAt: '2026-08-14T12:00:00.000Z',
  }]);

  assert.equal(publicFiles.length, 1);
  assert.equal(Object.hasOwn(publicFiles[0], 'url'), false);
  assert.equal(Object.hasOwn(publicFiles[0], 'uploadReservationId'), false);
  const publicUrl = getPublicDeliverableFileUrl(publicFiles[0]);
  assert.match(publicUrl, /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\//);
  assert.equal(publicUrl.includes('token='), false);
  assert.equal(
    getPublicDeliverableFileUrl({ storagePath: '../admin/private.pdf' }),
    null
  );
});

test('deliverablesService: concurrent upload merge preserves latest server files', () => {
  const latestFiles = [{
    name: 'terbaru.pdf',
    storagePath: 'deliverables/laporan_pendahuluan/server_terbaru.pdf',
  }];
  const uploadedFiles = [{
    name: 'tambahan.pdf',
    storagePath: 'deliverables/laporan_pendahuluan/upload_tambahan.pdf',
    uploadReservationId: '11111111-2222-4333-8444-555555555555',
  }];

  assert.deepEqual(
    mergeDeliverableFiles(latestFiles, uploadedFiles),
    [...latestFiles, ...uploadedFiles]
  );
  assert.throws(
    () => mergeDeliverableFiles(latestFiles, [{
      name: 'invalid.pdf',
      storagePath: '../admin/invalid.pdf',
    }]),
    /path Storage yang valid/
  );
});

test('deliverablesService: offline cache preserves the last server revision for retry', () => {
  const cached = buildOfflineDeliverableCache(
    { status: 'draft', revision: 8, notes: 'Perubahan offline' },
    7
  );
  assert.equal(cached.revision, 7);
  assert.equal(cached.notes, 'Perubahan offline');
});

test('deliverablesService: validates supported uploads and derives missing MIME types', () => {
  assert.equal(
    resolveDeliverableContentType({ name: 'laporan.docx', type: '' }),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  assert.equal(
    validateDeliverableFile({ name: 'video.mp4', type: 'video/mp4', size: 1024 }),
    'video/mp4'
  );
  assert.throws(
    () => validateDeliverableFile({ name: 'kosong.pdf', type: 'application/pdf', size: 0 }),
    /Berkas kosong/
  );
  assert.throws(
    () => validateDeliverableFile({
      name: 'terlalu-besar.mp4',
      type: 'video/mp4',
      size: MAX_DELIVERABLE_FILE_BYTES + 1,
    }),
    /maksimal 250 MB/
  );
  assert.throws(
    () => validateDeliverableFile({ name: 'program.exe', type: '', size: 1024 }),
    /tidak diizinkan/
  );
  assert.throws(
    () => validateDeliverableFile({
      name: 'script.svg',
      type: 'image/svg+xml',
      size: 1024,
    }),
    /tidak diizinkan/
  );
});

test('deliverablesService: remote persistence failures are surfaced with local-cache state', async () => {
  await assert.rejects(
    requireRemoteDeliverablePersistence(
      async () => {
        throw new Error('permission-denied');
      },
      { cachedLocally: true }
    ),
    (error) => {
      assert.equal(error.code, 'deliverables/remote-persistence-failed');
      assert.equal(error.cachedLocally, true);
      assert.match(error.message, /belum tersinkron ke server/);
      return true;
    }
  );
});

test('deliverablesService: explicit offline mode never invokes a remote write', async () => {
  let invoked = false;
  await assert.rejects(
    requireRemoteDeliverablePersistence(
      async () => {
        invoked = true;
      },
      { cachedLocally: true, offline: true }
    ),
    (error) => error.code === 'deliverables/offline-local-only'
  );
  assert.equal(invoked, false);
});

test('deliverablesService: direct approval receives publication timestamp and actor', () => {
  const now = new Date('2026-08-14T12:00:00.000Z');
  const payload = buildDeliverableSubmissionPayload(
    'laporan_pendahuluan',
    { status: 'approved', files: [], scopeChecklist: {} },
    { uid: 'team-leader-1', email: 'leader@example.test' },
    {
      name: 'Misdar Putra',
      role: 'office_staff',
      peranKantor: 'KORKOT',
    },
    now
  );

  assert.equal(payload.submittedAt, now.toISOString());
  assert.equal(payload.submittedBy, 'Misdar Putra');
  assert.equal(payload.updatedBy.uid, 'team-leader-1');
});
