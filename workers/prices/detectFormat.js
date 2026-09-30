// workers/prices/detectFormat.js
// Content-based compression format detector using magic bytes.

export const FORMAT = Object.freeze({
  GZIP:    'gzip',
  ZIP:     'zip',
  XML:     'xml',
  UNKNOWN: 'unknown',
});

/**
 * Detect compression format from the first bytes of a file.
 * @param {Buffer} header - At least 16 bytes from the start of the file.
 * @returns {string} One of FORMAT.*
 */
export function detectFormatFromBytes(header) {
  if (header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b) return FORMAT.GZIP;
  if (header.length >= 4 &&
      header[0] === 0x50 && header[1] === 0x4b &&
      header[2] === 0x03 && header[3] === 0x04) return FORMAT.ZIP;
  // Check for XML: allow UTF-8 BOM then leading ASCII whitespace/newlines before <
  let offset = 0;
  if (header.length >= 3 && header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf) offset = 3;
  while (offset < header.length &&
         (header[offset] === 0x20 || header[offset] === 0x09 ||
          header[offset] === 0x0d || header[offset] === 0x0a)) offset++;
  if (offset < header.length && header[offset] === 0x3c) return FORMAT.XML;
  return FORMAT.UNKNOWN;
}
