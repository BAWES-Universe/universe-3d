import { deflateSync } from 'node:zlib';

// Local generated test data, never an ingestion validator.
export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function pngChunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
export function pngHeader(width, height, { colorType = 6, bitDepth = 8, interlace = 0 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = bitDepth; header[9] = colorType; header[12] = interlace;
  return pngChunk('IHDR', header);
}
function paeth(a, b, c) {
  const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return distances[0] <= distances[1] && distances[0] <= distances[2] ? a : distances[1] <= distances[2] ? b : c;
}
export function makePng({ width = 64, height = 96, colorType = 6, filter = 0, pixel = (x, y) => [x % 256, y % 256, 80, x % 2 ? 255 : 0], extraChunks = [] } = {}) {
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType];
  const rowBytes = width * channels, raw = Buffer.alloc(height * rowBytes), scanlines = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const values = pixel(x, y);
    for (let c = 0; c < channels; c++) raw[y * rowBytes + x * channels + c] = values[c] ?? 255;
  }
  for (let y = 0; y < height; y++) {
    const kind = typeof filter === 'function' ? filter(y) : filter;
    scanlines[y * (rowBytes + 1)] = kind;
    for (let x = 0; x < rowBytes; x++) {
      const at = y * rowBytes + x, a = x >= channels ? raw[at - channels] : 0, b = y ? raw[at - rowBytes] : 0, c = y && x >= channels ? raw[at - rowBytes - channels] : 0;
      const prediction = kind === 0 ? 0 : kind === 1 ? a : kind === 2 ? b : kind === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      scanlines[y * (rowBytes + 1) + x + 1] = (raw[at] - prediction) & 255;
    }
  }
  return Buffer.concat([pngSignature, pngHeader(width, height, { colorType }), ...extraChunks, pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND')]);
}
export const transparentPng = () => makePng({ width: 35, height: 47, pixel: () => [0, 0, 0, 0] });
