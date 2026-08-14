// Pencetak dokumen lepas — ISWMP SumBar-Padang
//
// Menyalakan dialog cetak peramban atas sebuah dokumen HTML mandiri, sehingga
// pengguna bisa menyimpannya sebagai PDF. Dipakai laporan rekap periode dan
// berkas bukti per pegawai.
//
// Catatan penting yang pernah menggigit: iframe TIDAK boleh disembunyikan dan
// print() TIDAK boleh dipanggil dari `iframe.onload`. Chrome menembakkan load
// untuk about:blank saat iframe disisipkan — sebelum dokumen ditulis — sehingga
// yang tercetak halaman kosong. Dokumen ditulis sinkron, ditunggu tata letak
// dan gambarnya, baru dicetak. Konten ditulis lewat document.write ke
// about:blank, bukan blob URL, karena `frame-src` pada CSP hosting hanya
// mengizinkan reCAPTCHA.

/** Dua frame supaya tata letak selesai, dengan batas waktu bila rAF di-throttle. */
const afterNextLayout = (frameWindow) => Promise.race([
  new Promise((resolve) => {
    const raf = frameWindow.requestAnimationFrame?.bind(frameWindow);
    if (!raf) {
      window.setTimeout(resolve, 32);
      return;
    }
    raf(() => raf(() => resolve()));
  }),
  new Promise((resolve) => { window.setTimeout(resolve, 300); }),
]);

/**
 * Tunggu seluruh gambar selesai dimuat. Gambar yang gagal tetap dilepas supaya
 * satu foto bermasalah tidak menggantung seluruh proses cetak.
 */
const afterImagesSettled = (frameDocument, timeoutMs) => {
  const images = [...frameDocument.images].filter((image) => !image.complete);
  if (images.length === 0) return Promise.resolve();

  return Promise.race([
    Promise.all(images.map((image) => new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
    }))),
    new Promise((resolve) => { window.setTimeout(resolve, timeoutMs); }),
  ]);
};

/**
 * Cetak satu dokumen HTML lewat iframe di luar layar.
 *
 * `title` menjadi nama berkas bawaan saat disimpan sebagai PDF.
 */
export const printHtmlDocument = async (html, {
  title = 'dokumen',
  widthPx = 1123,
  heightPx = 794,
  imageTimeoutMs = 20000,
} = {}) => {
  if (typeof html !== 'string' || !html) {
    throw new Error('Dokumen cetak kosong.');
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.title = title;
  iframe.style.cssText = [
    'position:fixed',
    'left:-20000px',
    'top:0',
    `width:${widthPx}px`,
    `height:${heightPx}px`,
    'border:0',
    'pointer-events:none',
  ].join(';');

  document.body.appendChild(iframe);

  try {
    const frameWindow = iframe.contentWindow;
    const frameDocument = frameWindow.document;
    frameDocument.open();
    frameDocument.write(html);
    frameDocument.close();
    frameDocument.title = title;

    await afterImagesSettled(frameDocument, imageTimeoutMs);
    await afterNextLayout(frameWindow);
    frameWindow.focus();
    frameWindow.print();
  } finally {
    // Ditunda agar dialog cetak sempat membaca dokumen sebelum iframe dilepas.
    window.setTimeout(() => iframe.remove(), 2000);
  }
};

/** Unduh berkas dari byte di memori tanpa meninggalkan object URL menggantung. */
export const downloadBlob = (data, fileName, mimeType = 'application/octet-stream') => {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
};
