import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAttendanceErrorMessage,
  getAttendanceErrorReason,
  wrapAttendanceError,
} from './attendanceErrors.js';

// Bentuk error yang dikirim Firebase callable ke klien: kode ber-prefix
// `functions/`, pesan dari server, dan `details.reason` dari callableError().
const callableError = (code, message, reason) => {
  const error = new Error(message);
  error.code = `functions/${code}`;
  error.details = reason ? { reason } : undefined;
  return error;
};

test('pesan khusus reason menang atas pesan generik per-kode', () => {
  const message = getAttendanceErrorMessage(
    callableError(
      'failed-precondition',
      'Tidak ada shift aktif yang dapat di-check-out.',
      'CHECK_IN_REQUIRED'
    )
  );
  assert.match(message, /Tidak ada shift aktif yang bisa di-check-out/);
  assert.doesNotMatch(message, /Pastikan geofence aktif/);
});

test('reason tanpa pesan khusus memakai pesan spesifik dari server', () => {
  const message = getAttendanceErrorMessage(
    callableError(
      'failed-precondition',
      'Ambang khusus dari server.',
      'SOME_UNMAPPED_REASON'
    )
  );
  assert.match(message, /Ambang khusus dari server\./);
  assert.doesNotMatch(message, /Pastikan geofence aktif/);
});

test('pesan server dinamis dipertahankan untuk LOCATION_ACCURACY', () => {
  const message = getAttendanceErrorMessage(
    callableError(
      'invalid-argument',
      'Akurasi GPS harus 75 meter atau lebih baik.',
      'LOCATION_ACCURACY'
    )
  );
  assert.match(message, /75 meter/);
});

test('kode reason ikut ditampilkan agar bisa dilacak di log keamanan', () => {
  const message = getAttendanceErrorMessage(
    callableError('already-exists', 'Shift aktif sudah memiliki check-out.', 'ALREADY_CHECKED_OUT')
  );
  assert.match(message, /\(Kode: ALREADY_CHECKED_OUT\)/);
});

test('tanpa reason, kode callable dipakai sebagai penanda diagnostik', () => {
  const message = getAttendanceErrorMessage(callableError('unauthenticated', 'internal'));
  assert.match(message, /Sesi login berakhir/);
  assert.match(message, /\(Kode: unauthenticated\)/);
});

test('error validasi lokal tampil apa adanya tanpa kode', () => {
  const message = getAttendanceErrorMessage(new Error('Foto selfie tidak valid.'));
  assert.equal(message, 'Foto selfie tidak valid.');
});

test('error tanpa informasi apa pun memakai pesan cadangan', () => {
  assert.equal(getAttendanceErrorMessage(undefined), 'Gagal memproses absensi.');
});

test('reason terbaca dari details maupun dari error yang sudah dibungkus', () => {
  const original = callableError('failed-precondition', 'pesan server', 'UNVERIFIED_CHECK_IN');
  assert.equal(getAttendanceErrorReason(original), 'UNVERIFIED_CHECK_IN');
  assert.equal(getAttendanceErrorReason(wrapAttendanceError(original)), 'UNVERIFIED_CHECK_IN');
});

test('error yang dibungkus mempertahankan pesan spesifik saat dipetakan ulang', () => {
  const wrapped = wrapAttendanceError(
    callableError(
      'failed-precondition',
      'Check-in lama atau belum terverifikasi tidak dapat di-check-out.',
      'UNVERIFIED_CHECK_IN'
    )
  );
  // Komponen memanggil getAttendanceErrorMessage sekali lagi atas error hasil
  // bungkus ini; sebelumnya langkah itulah yang mengembalikan pesan generik.
  const remapped = getAttendanceErrorMessage(wrapped);
  assert.equal(remapped, wrapped.message);
  assert.match(remapped, /belum lengkap terverifikasi/);
  assert.doesNotMatch(remapped, /Pastikan geofence aktif/);
});

test('kode diagnostik tidak digandakan pada pemetaan berulang', () => {
  const wrapped = wrapAttendanceError(
    callableError('failed-precondition', 'pesan server', 'CHALLENGE_CONSUMED')
  );
  const remapped = getAttendanceErrorMessage(wrapped);
  const rewrapped = wrapAttendanceError(wrapped);
  assert.equal(remapped.match(/\(Kode: CHALLENGE_CONSUMED\)/g).length, 1);
  assert.equal(rewrapped.message.match(/\(Kode: CHALLENGE_CONSUMED\)/g).length, 1);
});

test('reason bawaan Object.prototype tidak bocor jadi pesan', () => {
  const message = getAttendanceErrorMessage(
    callableError('failed-precondition', 'pesan server nyata', 'constructor')
  );
  assert.equal(typeof message, 'string');
  assert.match(message, /pesan server nyata/);
});

test('error yang dibungkus membawa kode dan penyebab aslinya', () => {
  const original = callableError('resource-exhausted', 'Tunggu sebentar.', 'SUBMIT_RATE_LIMIT');
  const wrapped = wrapAttendanceError(original);
  assert.equal(wrapped.code, 'functions/resource-exhausted');
  assert.equal(wrapped.reason, 'SUBMIT_RATE_LIMIT');
  assert.equal(wrapped.cause, original);
  assert.match(wrapped.message, /Tunggu sekitar 15 detik/);
});

test('kode numerik warisan DOMException tidak ditampilkan ke pengguna', () => {
  const cameraError = new Error('Camera tidak dapat diakses.');
  cameraError.code = 8;
  const message = getAttendanceErrorMessage(cameraError);
  assert.equal(message, 'Camera tidak dapat diakses.');
});
