/**
 * What an image file actually is, read from its bytes.
 *
 * Every social-card defect in this fleet survived because something trusted a
 * label instead of the file. ssatcy.com shipped `og-image.png` that was JPEG
 * data with a PNG name, at 768x1024. promptboi.com declared
 * `og:image:width=1200` and `og:image:height=630` over a file that is 1006x1006.
 * A check that reads the extension, or believes the meta tag, passes both.
 *
 * So this reads magic bytes and the real dimension fields, and has no
 * dependencies — the sites that need it most have no `node_modules`.
 */

const asciiAt = (buffer, offset, length) => buffer.subarray(offset, offset + length).toString('latin1')

function png(buffer) {
  if (buffer.length < 24) return null
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buffer.subarray(0, 8).equals(signature)) return null
  // IHDR is required by the spec to be the first chunk: length+type occupy
  // bytes 8..15, so width and height sit at 16 and 20, big-endian.
  if (asciiAt(buffer, 12, 4) !== 'IHDR') return null
  return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function gif(buffer) {
  if (buffer.length < 10) return null
  const header = asciiAt(buffer, 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return null
  // Logical screen descriptor, little-endian — the one format here that is.
  return { format: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
}

function jpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    // Start Of Frame carries the dimensions. C4 (Huffman table), C8 (JPG
    // extension) and CC (arithmetic conditioning) share the numeric range and
    // are not frame headers, which is the usual off-by-one in readers like this.
    const isFrameHeader =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isFrameHeader) {
      return {
        format: 'jpeg',
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      }
    }
    const segmentLength = buffer.readUInt16BE(offset + 2)
    // A zero or negative advance would spin forever on a truncated file.
    if (segmentLength < 2) return null
    offset += 2 + segmentLength
  }
  return null
}

function webp(buffer) {
  if (buffer.length < 30) return null
  if (asciiAt(buffer, 0, 4) !== 'RIFF' || asciiAt(buffer, 8, 4) !== 'WEBP') return null
  const chunk = asciiAt(buffer, 12, 4)
  if (chunk === 'VP8 ') {
    return {
      format: 'webp',
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    const width = 1 + (buffer.readUIntLE(24, 3) & 0xffffff)
    const height = 1 + (buffer.readUIntLE(27, 3) & 0xffffff)
    return { format: 'webp', width, height }
  }
  return null
}

function svg(buffer) {
  const head = buffer.subarray(0, 2048).toString('utf8')
  if (!/<svg\b/i.test(head)) return null
  // Vector: no pixel dimensions to assert. Reported so a caller can say "this
  // is an SVG, which scrapers will not render" rather than "unreadable".
  return { format: 'svg', width: null, height: null }
}

/**
 * Format and pixel size, or null when the bytes are not an image this
 * understands. Null is a failure for the caller to report — never a pass.
 */
export function imageMeta(buffer) {
  return png(buffer) ?? jpeg(buffer) ?? gif(buffer) ?? webp(buffer) ?? svg(buffer)
}

/** The formats an extension may legitimately name, so `.jpg` accepts JPEG. */
export const EXTENSION_FORMATS = {
  '.png': ['png'],
  '.jpg': ['jpeg'],
  '.jpeg': ['jpeg'],
  '.gif': ['gif'],
  '.webp': ['webp'],
  '.svg': ['svg'],
}

/** The MIME types an `og:image:type` may legitimately declare per format. */
export const FORMAT_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}
