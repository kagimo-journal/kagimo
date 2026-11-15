/**
 * Re-encodes an image through a canvas before encryption (SPEC §4). Drawing to a canvas and
 * exporting drops every metadata block (EXIF, GPS, XMP), applies the EXIF orientation, caps the
 * long edge at 2560px, and produces JPEG q≈0.88 — or PNG when the source has transparency.
 */

export const MAX_EDGE = 2560;
export const JPEG_QUALITY = 0.88;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export interface ProcessedImage {
  bytes: Uint8Array;
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

export function isImageFile(f: File | DataTransferItem): boolean {
  return typeof f.type === 'string' && f.type.startsWith('image/');
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to <img> decoding */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new ImageError("This image format can't be read by your browser.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  // Sample with a stride on very large images; checking every pixel isn't necessary to spot alpha.
  const step = Math.max(1, Math.floor((w * h) / 1_000_000)) * 4;
  for (let i = 3; i < data.length; i += step) if (data[i] < 255) return true;
  return false;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageError('Could not encode the image.'))), type, quality),
  );
}

export async function processImage(file: Blob): Promise<ProcessedImage> {
  const src = await decode(file);
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height;
  if (!sw || !sh) throw new ImageError('That image appears to be empty.');
  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ImageError('Your browser could not process this image.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, width, height);
  if ('close' in src) src.close();

  const mayHaveAlpha = /png|webp|gif|avif|svg/.test(file.type);
  const keepPng = mayHaveAlpha && hasTransparency(ctx, width, height);
  let blob: Blob;
  if (keepPng) {
    blob = await toBlob(canvas, 'image/png');
  } else {
    // Flatten onto white in case the browser kept an alpha channel we didn't detect.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    blob = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
  }
  canvas.width = canvas.height = 0;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length + 16 > MAX_UPLOAD_BYTES) throw new ImageError('That image is too large, even after resizing (max 15 MB).');
  return { bytes, mime: keepPng ? 'image/png' : 'image/jpeg', width, height };
}

export function sniffImageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return 'application/octet-stream';
}
