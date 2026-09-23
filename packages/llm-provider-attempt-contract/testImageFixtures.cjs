'use strict'

/**
 * Shared test-only image containers for Codex visual-budget suites.
 *
 * These bytes are for parsers and hop tests. They do not change JWT issuance,
 * hostRef binding, or the Desktop/rpc-proxy body allow-list. Production code
 * must not import this file.
 */

const zlib = require('node:zlib')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBytes, data])) >>> 0, 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

function pngHeader(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return ihdr
}

/** Real PNG: a deflate stream over filtered RGB scanlines plus real CRCs. */
function realPng(width, height, seed) {
  const stride = 1 + width * 3
  const raw = Buffer.alloc(height * stride)
  let state = seed >>> 0
  for (let i = 0; i < raw.length; i++) {
    if (i % stride === 0) continue
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    raw[i] = state & 0xff
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', pngHeader(width, height)),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Framed PNG whose IDAT is not a decodable stream. Used only for the declared
 * header budgets: the pixel budget is enforced on IHDR before any decode.
 */
function declaredHeaderPng(width, height) {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', pngHeader(width, height)),
    pngChunk('IDAT', Buffer.alloc(8)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Declared-header container padded to an exact byte length (signature 8,
 * IHDR 25, IDAT 12 + payload, IEND 12).
 */
function declaredHeaderPngOfSize(targetBytes) {
  const overhead = 8 + 25 + 12 + 12
  if (targetBytes <= overhead) {
    throw new Error('target must leave room for image data')
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', pngHeader(2, 2)),
    pngChunk('IDAT', Buffer.alloc(targetBytes - overhead)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Real PNG padded to an exact byte length with an ancillary tEXt chunk
 * inserted before IEND.
 */
function realPngOfSize(targetBytes, width, height, seed) {
  const base = realPng(width, height, seed)
  const padding = targetBytes - base.length
  if (padding < 0) {
    throw new Error(`target ${targetBytes} is smaller than the real PNG ${base.length}`)
  }
  if (padding === 0) return base
  if (padding < 12) {
    throw new Error('target must leave room for the padding chunk')
  }
  const iend = base.subarray(base.length - 12)
  const body = base.subarray(0, base.length - 12)
  const payloadLength = padding - 12
  const text = Buffer.concat([
    Buffer.from('pad\0', 'latin1'),
    Buffer.alloc(Math.max(payloadLength - 4, 0), 0x20),
  ])
  if (text.length !== payloadLength) {
    throw new Error('padding chunk payload length mismatch')
  }
  return Buffer.concat([body, pngChunk('tEXt', text), iend])
}

/**
 * Pad an existing PNG (Buffer or base64) to an exact byte length with a tEXt
 * chunk before IEND. Used when a suite starts from the frozen visual fixture.
 */
function padPngToSize(png, targetBytes) {
  const bytes = Buffer.isBuffer(png) ? png : Buffer.from(String(png), 'base64')
  const padding = targetBytes - bytes.length
  if (padding < 0) {
    throw new Error(`target ${targetBytes} is smaller than the PNG ${bytes.length}`)
  }
  if (padding === 0) return Buffer.from(bytes)
  if (padding < 12) {
    throw new Error('target must leave room for the padding chunk')
  }
  const payload = Buffer.alloc(padding - 12, 0x41)
  Buffer.from('Comment\0').copy(payload)
  return Buffer.concat([
    bytes.subarray(0, bytes.length - 12),
    pngChunk('tEXt', payload),
    bytes.subarray(bytes.length - 12),
  ])
}

/**
 * Grow a real JPEG to an exact byte length by inserting COM segments after SOI.
 * The original SOF/SOS/scan/EOI stay intact, so a canvas image remains
 * decodable while the container still ends on EOI for the contract parser.
 */
function padJpegToSize(jpeg, targetBytes) {
  const bytes = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(String(jpeg), 'base64')
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('JPEG SOI marker is missing')
  }
  const padding = targetBytes - bytes.length
  if (padding < 0) {
    throw new Error(`target ${targetBytes} is smaller than the JPEG ${bytes.length}`)
  }
  if (padding === 0) return Buffer.from(bytes)
  if (padding < 4) {
    throw new Error('target must leave room for a JPEG COM segment')
  }
  const comments = []
  let remaining = padding
  while (remaining > 0) {
    if (remaining < 4) {
      throw new Error('JPEG COM padding cannot finish on a short segment')
    }
    const chunk = Math.min(remaining, 4 + 65533)
    const payload = chunk - 4
    const com = Buffer.alloc(chunk)
    com[0] = 0xff
    com[1] = 0xfe
    com.writeUInt16BE(payload + 2, 2)
    comments.push(com)
    remaining -= chunk
  }
  return Buffer.concat([bytes.subarray(0, 2), ...comments, bytes.subarray(2)])
}

/**
 * Structurally framed JPEG of an exact byte length: SOI, SOF0 dimensions, SOS,
 * entropy pad, EOI. Marker framing only; scan data is not entropy-decodable.
 */
function jpegOfSize(targetBytes, width = 2, height = 2) {
  const sofPayload = Buffer.alloc(9)
  sofPayload[0] = 8
  sofPayload.writeUInt16BE(height, 1)
  sofPayload.writeUInt16BE(width, 3)
  sofPayload[5] = 1
  sofPayload[6] = 1
  sofPayload[7] = 0x11
  sofPayload[8] = 0
  const segmentLength = Buffer.alloc(2)
  segmentLength.writeUInt16BE(sofPayload.length + 2, 0)
  const sof = Buffer.concat([Buffer.from([0xff, 0xc0]), segmentLength, sofPayload])

  const sosPayload = Buffer.alloc(6)
  const sosLength = Buffer.alloc(2)
  sosLength.writeUInt16BE(sosPayload.length + 2, 0)
  const sos = Buffer.concat([Buffer.from([0xff, 0xda]), sosLength, sosPayload])

  const entropyLength = targetBytes - (2 + sof.length + sos.length + 2)
  if (entropyLength < 1) {
    throw new Error('target must leave room for entropy-coded data')
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    sos,
    Buffer.alloc(entropyLength, 0x2a),
    Buffer.from([0xff, 0xd9]),
  ])
}

module.exports = {
  PNG_SIGNATURE,
  pngChunk,
  pngHeader,
  realPng,
  declaredHeaderPng,
  declaredHeaderPngOfSize,
  realPngOfSize,
  padPngToSize,
  padJpegToSize,
  jpegOfSize,
}
