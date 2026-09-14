/**
 * Format sniffing, against bytes built here rather than fixture files.
 *
 * The cases that matter are the disagreements: JPEG data with a `.png` name
 * (ssatcy.com) and a file whose real size contradicts its declared size
 * (promptboi.com). Both were shipped and both passed every check that read a
 * label, so these assert on the bytes.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { EXTENSION_FORMATS, FORMAT_MIME, imageMeta } from '../lib/imageMeta.mjs'

function pngBytes(width, height) {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function jpegBytes(width, height, { marker = 0xc0, precedingSegment = false } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])]
  if (precedingSegment) {
    // An APP0 block ahead of the frame header, which is what a real JFIF file
    // looks like — the reader has to walk segments rather than assume offset 2.
    const app0 = Buffer.alloc(4 + 14)
    app0.writeUInt8(0xff, 0)
    app0.writeUInt8(0xe0, 1)
    app0.writeUInt16BE(16, 2)
    app0.write('JFIF\0', 4, 'latin1')
    parts.push(app0)
  }
  const sof = Buffer.alloc(11)
  sof.writeUInt8(0xff, 0)
  sof.writeUInt8(marker, 1)
  sof.writeUInt16BE(9, 2)
  sof.writeUInt8(8, 4)
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([...parts, sof, Buffer.alloc(16)])
}

function gifBytes(width, height) {
  const buffer = Buffer.alloc(13)
  buffer.write('GIF89a', 0, 'latin1')
  buffer.writeUInt16LE(width, 6)
  buffer.writeUInt16LE(height, 8)
  return buffer
}

describe('imageMeta', () => {
  it('reads PNG dimensions from IHDR', () => {
    assert.deepEqual(imageMeta(pngBytes(1200, 630)), { format: 'png', width: 1200, height: 630 })
  })

  it('reads JPEG dimensions from the frame header', () => {
    assert.deepEqual(imageMeta(jpegBytes(1200, 630)), { format: 'jpeg', width: 1200, height: 630 })
  })

  it('walks past earlier segments to find the JPEG frame header', () => {
    const meta = imageMeta(jpegBytes(768, 1024, { precedingSegment: true }))
    assert.deepEqual(meta, { format: 'jpeg', width: 768, height: 1024 })
  })

  it('does not mistake a Huffman table for a frame header', () => {
    // 0xC4 sits inside the SOF numeric range and is not a frame header. A reader
    // that treats the whole range as SOF reports whatever bytes follow it.
    const withTable = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      (() => {
        const dht = Buffer.alloc(4)
        dht.writeUInt8(0xff, 0)
        dht.writeUInt8(0xc4, 1)
        dht.writeUInt16BE(2, 2)
        return dht
      })(),
      jpegBytes(1200, 630).subarray(2),
    ])
    assert.deepEqual(imageMeta(withTable), { format: 'jpeg', width: 1200, height: 630 })
  })

  it('reads GIF dimensions little-endian', () => {
    assert.deepEqual(imageMeta(gifBytes(205, 94)), { format: 'gif', width: 205, height: 94 })
  })

  it('names JPEG data as JPEG however the file is called', () => {
    // The ssatcy.com defect: the caller compares this against the extension.
    const meta = imageMeta(jpegBytes(768, 1024))
    assert.equal(meta.format, 'jpeg')
    assert.ok(!EXTENSION_FORMATS['.png'].includes(meta.format))
    assert.equal(FORMAT_MIME[meta.format], 'image/jpeg')
  })

  it('reports SVG as vector with no pixel size', () => {
    const meta = imageMeta(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))
    assert.deepEqual(meta, { format: 'svg', width: null, height: null })
  })

  it('returns null rather than guessing for bytes it cannot read', () => {
    assert.equal(imageMeta(Buffer.from('not an image at all')), null)
  })

  it('returns null on a truncated JPEG instead of looping', () => {
    // A zero-length segment would advance the cursor by nothing forever.
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    assert.equal(imageMeta(truncated), null)
  })
})
