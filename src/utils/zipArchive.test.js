import assert from 'node:assert/strict';
import test from 'node:test';

import { createZipArchive, crc32, toSafeFileName } from './zipArchive.js';

const bytes = (value) => new TextEncoder().encode(value);
const readUint32 = (data, offset) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
const readUint16 = (data, offset) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);

test('crc32 matches the reference check value', () => {
  // Nilai uji baku APPNOTE/zlib untuk "123456789".
  assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('an archive carries the expected signatures and entry count', () => {
  const zip = createZipArchive([
    { name: 'index.html', data: '<p>halo</p>' },
    { name: 'foto/2026-07-13_check-in.jpg', data: new Uint8Array([1, 2, 3, 4]) },
  ], { modifiedAt: new Date(2026, 6, 13, 8, 30, 0) });

  assert.equal(readUint32(zip, 0), 0x04034b50, 'local file header');

  const eocdOffset = zip.length - 22;
  assert.equal(readUint32(zip, eocdOffset), 0x06054b50, 'end of central directory');
  assert.equal(readUint16(zip, eocdOffset + 8), 2, 'entri pada disk');
  assert.equal(readUint16(zip, eocdOffset + 10), 2, 'total entri');

  const centralSize = readUint32(zip, eocdOffset + 12);
  const centralOffset = readUint32(zip, eocdOffset + 16);
  assert.equal(readUint32(zip, centralOffset), 0x02014b50, 'central directory header');
  assert.equal(centralOffset + centralSize, eocdOffset, 'central directory berbatasan dengan EOCD');
});

test('stored entries keep their bytes verbatim', () => {
  const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const zip = createZipArchive([{ name: 'a.jpg', data: payload }]);

  const nameLength = readUint16(zip, 26);
  const extraLength = readUint16(zip, 28);
  const dataStart = 30 + nameLength + extraLength;

  assert.equal(readUint32(zip, 14), crc32(payload), 'crc tersimpan');
  assert.equal(readUint32(zip, 18), payload.length, 'ukuran terkompresi');
  assert.equal(readUint32(zip, 22), payload.length, 'ukuran asli');
  assert.equal(readUint16(zip, 8), 0, 'metode store');
  assert.deepEqual(zip.slice(dataStart, dataStart + payload.length), payload);
});

test('file names are stored as UTF-8 with the language flag set', () => {
  const zip = createZipArchive([{ name: 'berkas-péndékan.txt', data: 'x' }]);
  assert.equal(readUint16(zip, 6) & 0x0800, 0x0800, 'bendera UTF-8');
  const nameLength = readUint16(zip, 26);
  const name = new TextDecoder().decode(zip.slice(30, 30 + nameLength));
  assert.equal(name, 'berkas-péndékan.txt');
});

test('an empty archive is still a valid zip', () => {
  const zip = createZipArchive([]);
  assert.equal(zip.length, 22);
  assert.equal(readUint32(zip, 0), 0x06054b50);
});

test('duplicate or empty names are refused', () => {
  assert.throws(() => createZipArchive([
    { name: 'a.txt', data: '1' },
    { name: 'a.txt', data: '2' },
  ]), /ganda/);
  assert.throws(() => createZipArchive([{ name: '', data: '1' }]), /kosong/);
});

test('file names are sanitised for both Windows and Unix', () => {
  assert.equal(toSafeFileName('ABDUL AZIS SIKUMBANG'), 'ABDUL-AZIS-SIKUMBANG');
  assert.equal(toSafeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(toSafeFileName('  ...  '), 'berkas');
  assert.equal(toSafeFileName('', 'pegawai'), 'pegawai');
  assert.ok(toSafeFileName('x'.repeat(200)).length <= 80);
});
