// Penulis arsip ZIP minimal — ISWMP SumBar-Padang
//
// Dipakai untuk membungkus paket bukti kehadiran (foto, index, manifes) jadi
// satu berkas yang bisa diserahkan ke pemberi kerja atau auditor. Ditulis
// sendiri, bukan menambah dependensi, karena yang dibutuhkan hanya metode
// "store": foto JPEG sudah terkompresi, memampatkannya lagi tidak menghemat
// apa pun. Format mengikuti APPNOTE PKWARE 6.3.3 tanpa ZIP64 — ukuran berkas
// dan jumlah entri paket bukti jauh di bawah batas 4 GB / 65.535 entri.

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const encodeUtf8 = (value) => new TextEncoder().encode(value);

/** Waktu berkas dalam format DOS: detik berpresisi 2 detik, tahun sejak 1980. */
const toDosDateTime = (date) => {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11)
      | (date.getMinutes() << 5)
      | (Math.floor(date.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  pushHeader(fields) {
    const size = fields.reduce((sum, [, width]) => sum + width, 0);
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    let offset = 0;
    fields.forEach(([value, width]) => {
      if (width === 2) view.setUint16(offset, value, true);
      else view.setUint32(offset, value, true);
      offset += width;
    });
    this.push(new Uint8Array(buffer));
  }

  toUint8Array() {
    const output = new Uint8Array(this.length);
    let offset = 0;
    this.chunks.forEach((chunk) => {
      output.set(chunk, offset);
      offset += chunk.length;
    });
    return output;
  }
}

/**
 * Bangun arsip ZIP dari daftar `{ name, data }`, dengan `data` berupa
 * Uint8Array atau string. Mengembalikan Uint8Array isi berkas .zip.
 */
export const createZipArchive = (entries = [], { modifiedAt = new Date() } = {}) => {
  if (entries.length > MAX_ENTRIES) {
    throw new Error('Terlalu banyak berkas untuk satu arsip ZIP.');
  }

  const { time, date } = toDosDateTime(modifiedAt);
  const local = new ByteWriter();
  const central = new ByteWriter();
  const seenNames = new Set();

  entries.forEach((entry) => {
    const name = String(entry?.name ?? '').replace(/^\/+/, '');
    if (!name) throw new Error('Nama berkas dalam arsip tidak boleh kosong.');
    if (seenNames.has(name)) {
      throw new Error(`Nama berkas ganda dalam arsip: ${name}`);
    }
    seenNames.add(name);

    const nameBytes = encodeUtf8(name);
    const data = typeof entry.data === 'string'
      ? encodeUtf8(entry.data)
      : new Uint8Array(entry.data ?? []);
    if (data.length > MAX_UINT32 || local.length > MAX_UINT32) {
      throw new Error('Arsip melampaui batas ukuran ZIP tanpa ZIP64.');
    }

    const checksum = crc32(data);
    const headerOffset = local.length;

    // Local file header. Bendera 0x0800 menandai nama berkas UTF-8.
    local.pushHeader([
      [0x04034b50, 4], [20, 2], [0x0800, 2], [0, 2],
      [time, 2], [date, 2],
      [checksum, 4], [data.length, 4], [data.length, 4],
      [nameBytes.length, 2], [0, 2],
    ]);
    local.push(nameBytes);
    local.push(data);

    central.pushHeader([
      [0x02014b50, 4], [20, 2], [20, 2], [0x0800, 2], [0, 2],
      [time, 2], [date, 2],
      [checksum, 4], [data.length, 4], [data.length, 4],
      [nameBytes.length, 2], [0, 2], [0, 2],
      [0, 2], [0, 2], [0, 4],
      [headerOffset, 4],
    ]);
    central.push(nameBytes);
  });

  const output = new ByteWriter();
  output.push(local.toUint8Array());
  const centralOffset = output.length;
  output.push(central.toUint8Array());

  output.pushHeader([
    [0x06054b50, 4], [0, 2], [0, 2],
    [entries.length, 2], [entries.length, 2],
    [central.length, 4], [centralOffset, 4], [0, 2],
  ]);

  return output.toUint8Array();
};

/** Nama berkas aman untuk ZIP dan untuk sistem berkas Windows maupun Unix. */
export const toSafeFileName = (value, fallback = 'berkas') => {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
};
