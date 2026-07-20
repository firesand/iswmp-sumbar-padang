/**
 * Compress attendance selfie for slow/mobile networks.
 * Target: ~max 960px side, JPEG ~0.55–0.7, typically under ~200KB.
 */

const DEFAULTS = {
  maxWidth: 960,
  maxHeight: 960,
  quality: 0.58,
  maxBytes: 200 * 1024,
  mimeType: 'image/jpeg',
};

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Gagal membaca foto'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (!canvas.toBlob) {
      try {
        const dataUrl = canvas.toDataURL(type, quality);
        fetch(dataUrl)
          .then((r) => r.blob())
          .then(resolve)
          .catch(reject);
      } catch (e) {
        reject(e);
      }
      return;
    }
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Gagal kompres foto'))),
      type,
      quality
    );
  });
}

function calcSize(width, height, maxWidth, maxHeight) {
  const ratio = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * @param {Blob|File} input
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {Promise<Blob>}
 */
export async function compressAttendancePhoto(input, options = {}) {
  const opts = { ...DEFAULTS, ...options };

  if (!input || !(input instanceof Blob)) {
    throw new Error('File foto tidak valid');
  }

  // Already small enough — still re-encode to strip EXIF / normalize
  const img = await loadImageFromBlob(input);
  const { width, height } = calcSize(img.naturalWidth || img.width, img.naturalHeight || img.height, opts.maxWidth, opts.maxHeight);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  let quality = opts.quality;
  let blob = await canvasToBlob(canvas, opts.mimeType, quality);

  // Step down quality if still too large
  while (blob.size > opts.maxBytes && quality > 0.35) {
    quality = Math.round((quality - 0.08) * 100) / 100;
    blob = await canvasToBlob(canvas, opts.mimeType, quality);
  }

  // Last resort: shrink dimensions
  if (blob.size > opts.maxBytes) {
    const smaller = calcSize(width, height, Math.round(opts.maxWidth * 0.7), Math.round(opts.maxHeight * 0.7));
    canvas.width = smaller.width;
    canvas.height = smaller.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, smaller.width, smaller.height);
    ctx.drawImage(img, 0, 0, smaller.width, smaller.height);
    blob = await canvasToBlob(canvas, opts.mimeType, 0.45);
  }

  console.log(
    `Photo compressed: ${(input.size / 1024).toFixed(0)}KB → ${(blob.size / 1024).toFixed(0)}KB (${width}x${height}, q=${quality})`
  );

  return blob;
}
