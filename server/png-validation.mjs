import { inflateSync } from 'node:zlib';

// Deliberately restricted PNG ingestion. This is a full bounded decode, not an
// extension/MIME/signature probe. Unsupported PNG features fail closed.
export const PNG_LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, maxDimension: 2048, maxPixels: 4_194_304, maxChunks: 4096 });
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function reject(code, message) { throw Object.assign(new Error(message), { name: 'ImageValidationError', status: 400, code }); }
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Accepts only 8-bit, noninterlaced grayscale/RGB/grayscale-alpha/RGBA PNG.
 * Only IHDR, consecutive IDAT, IEND and one optional sRGB chunk are accepted.
 * Palette, tRNS, metadata, ICC, EXIF and APNG are explicitly unsupported.
 * Every scanline is reconstructed under a <=16 MiB pixel allocation cap.
 * Caller-provided limits can tighten, never relax, the documented ceilings.
 */
export function validatePng(input, { mediaType = 'image/png', limits = {} } = {}) {
  if (mediaType !== 'image/png') reject('IMAGE_MIME', 'Only image/png uploads are supported');
  if (!(input instanceof Uint8Array)) reject('IMAGE_BYTES', 'Image bytes must be a Uint8Array');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const cap = {};
  for (const [key, value] of Object.entries(PNG_LIMITS)) {
    const candidate = limits[key] ?? value;
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > value) throw new TypeError(`Invalid PNG limit: ${key}`);
    cap[key] = candidate;
  }
  if (bytes.length > cap.maxBytes) reject('IMAGE_TOO_LARGE', 'PNG exceeds the byte limit');
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) reject('IMAGE_FORMAT', 'Expected PNG image bytes');
  let offset = 8, chunks = 0, width, height, channels, sawHeader = false, sawData = false, sawEnd = false, sawSrgb = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (++chunks > cap.maxChunks) reject('IMAGE_CHUNKS', 'PNG contains too many chunks');
    if (bytes.length - offset < 12) reject('IMAGE_TRUNCATED', 'Truncated PNG chunk');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) reject('IMAGE_TRUNCATED', 'PNG chunk exceeds available bytes');
    const end = offset + 8 + length;
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (!typeBytes.every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) reject('IMAGE_CHUNK_TYPE', 'PNG chunk names must be ASCII letters');
    const type = typeBytes.toString('ascii');
    if (crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) reject('IMAGE_CRC', 'PNG chunk checksum failed');
    if (!sawHeader && type !== 'IHDR') reject('IMAGE_ORDER', 'PNG must begin with IHDR');
    const data = bytes.subarray(offset + 8, end);
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) reject('IMAGE_HEADER', 'Invalid or repeated PNG header');
      sawHeader = true;
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || width > cap.maxDimension || height > cap.maxDimension || width * height > cap.maxPixels) reject('IMAGE_DIMENSIONS', 'PNG dimensions exceed the supported bounds');
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[data[9]];
      if (data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) reject('IMAGE_UNSUPPORTED', 'Use a noninterlaced 8-bit grayscale, RGB or RGBA PNG');
    } else if (type === 'sRGB') {
      if (sawSrgb || sawData || length !== 1 || data[0] > 3) reject('IMAGE_UNSUPPORTED', 'Invalid PNG sRGB chunk');
      sawSrgb = true;
    } else if (type === 'IDAT') {
      sawData = true;
      compressed.push(data);
    } else if (type === 'IEND') {
      if (!sawData || length !== 0 || end + 4 !== bytes.length) reject('IMAGE_ORDER', 'Invalid PNG end or trailing bytes');
      sawEnd = true;
    } else {
      reject('IMAGE_UNSUPPORTED', `PNG chunk ${JSON.stringify(type)} is not supported; export a plain nonanimated PNG`);
    }
    offset = end + 4;
  }
  if (!sawHeader || !sawData || !sawEnd) reject('IMAGE_TRUNCATED', 'PNG is missing required chunks');
  const rowBytes = width * channels, scanlineBytes = height * (rowBytes + 1);
  const encoded = Buffer.concat(compressed);
  let inflated;
  try { inflated = inflateSync(encoded, { maxOutputLength: scanlineBytes, info: true }); }
  catch { reject('IMAGE_DECODE', 'PNG image data could not be decoded within its declared dimensions'); }
  if (inflated.buffer.length !== scanlineBytes || inflated.engine.bytesWritten !== encoded.length) reject('IMAGE_DECODE', 'PNG has an incorrect scanline length or trailing compressed data');
  const pixels = Buffer.allocUnsafe(height * rowBytes);
  let anyTransparent = false;
  for (let y = 0; y < height; y++) {
    const source = y * (rowBytes + 1), target = y * rowBytes, filter = inflated.buffer[source];
    if (filter > 4) reject('IMAGE_FILTER', 'PNG contains an unsupported scanline filter');
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= channels ? pixels[target + x - channels] : 0;
      const b = y ? pixels[target + x - rowBytes] : 0;
      const c = y && x >= channels ? pixels[target + x - rowBytes - channels] : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      pixels[target + x] = (inflated.buffer[source + 1 + x] + prediction) & 255;
      if ((channels === 2 || channels === 4) && x % channels === channels - 1 && pixels[target + x] !== 255) anyTransparent = true;
    }
  }
  return Object.freeze({ mediaType: 'image/png', width, height, byteLength: bytes.length, hasAlpha: channels === 2 || channels === 4, hasTransparency: anyTransparent });
}
