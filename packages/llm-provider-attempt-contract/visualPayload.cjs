'use strict'

/**
 * Bounded visual-payload validation for codex-completion-request.v2.
 *
 * Guarantee, stated narrowly on purpose: this module proves base64
 * canonicality, byte budgets, JPEG/PNG container framing, required header and
 * terminator blocks, and the dimensions declared by those headers. It does not
 * decode pixels, verify PNG CRCs, validate entropy-coded JPEG data, or prove
 * that the image renders. "Valid" here means "syntactically well-formed
 * container inside the local budget", never "decoded and visually correct".
 *
 * The budget below is a conservative local safety/product decision. It is not
 * an upstream capability fact; the frozen ChatGPT endpoint is not certified by
 * these numbers. Codex charges patches, not file bytes: the official client
 * resizes to 2048 px and sends `detail: high`. A poorly compressed 2048 PNG
 * can exceed 10 MiB and must still be authorized; an 8192 px / 48 MP image
 * will 400 upstream even when it is only 2 MiB.
 *
 * Two layers share this object:
 *   - typical* is the usual 2048 JPEG/PNG product target (5 / 9 / 14 MiB).
 *     It is documentation and UX guidance, not a reject.
 *   - max* is the hard ceiling: one exceptional 2048 image may be larger
 *     than 10 MiB. The V2 HTTP envelope stays 24 MiB so 16 MiB decoded
 *     (~21.3 MiB base64) plus the 1 MiB non-image share still fits.
 * Model capability lists (which models accept images) belong to issue #654 /
 * PR #669 (models.dev). This package only bounds Codex transport.
 */

const VISUAL_LIMITS = Object.freeze({
  maxImages: 3,
  typicalImageBytes: 5242880,
  typicalTotalImageBytes: 9437184,
  typicalEnvelopeBytes: 14680064,
  maxImageBytes: 16777216,
  maxTotalImageBytes: 16777216,
  maxImageDimension: 2048,
  maxImagePixels: 4194304,
})

// Exact encoded length of a canonical base64 string that decodes to
// maxImageBytes octets. Compared before any decoding work happens.
const MAX_ENCODED_IMAGE_BYTES = 4 * Math.ceil(VISUAL_LIMITS.maxImageBytes / 3)

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IHDR = 'IHDR'
const PNG_IDAT = 'IDAT'
const PNG_IEND = 'IEND'

// SOF0..SOF15 except DHT (0xC4), JPG (0xC8) and DAC (0xCC), which reuse the
// same marker range without carrying frame dimensions.
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])
const JPEG_SOI = 0xd8
const JPEG_EOI = 0xd9
const JPEG_SOS = 0xda
const JPEG_TEM = 0x01

function fail(code, message) {
  return { ok: false, code, message }
}

function ok(value) {
  return { ok: true, value }
}

/**
 * Strict canonical base64. Length is bounded before `Buffer.from`, invalid
 * alphabets and padding placement are rejected, and a decode/encode round trip
 * rejects non-canonical trailing bits that a lenient decoder would accept.
 */
function decodeStrictBase64(data, maxDecodedBytes) {
  if (typeof data !== 'string') return fail('invalid', 'image data must be a base64 string')
  if (data.length === 0) return fail('invalid', 'image data must not be empty')
  if (data.length > MAX_ENCODED_IMAGE_BYTES) {
    return fail('limit', `image exceeds ${maxDecodedBytes} decoded bytes`)
  }
  if (data.length % 4 !== 0) return fail('invalid', 'image data must be canonical base64')
  if (!BASE64_PATTERN.test(data)) return fail('invalid', 'image data must be canonical base64')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) return fail('invalid', 'image data must not be empty')
  if (bytes.length > maxDecodedBytes) {
    return fail('limit', `image exceeds ${maxDecodedBytes} decoded bytes`)
  }
  if (bytes.toString('base64') !== data) {
    return fail('invalid', 'image data must be canonical base64')
  }
  return ok(bytes)
}

function readPngDimensions(buffer) {
  const length = buffer.length
  if (length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return fail('invalid', 'PNG signature is missing')
  }
  let pos = 8
  let header = null
  let sawImageData = false
  let sawEnd = false
  while (pos < length) {
    if (pos + 8 > length) return fail('invalid', 'PNG chunk header is truncated')
    const chunkLength = buffer.readUInt32BE(pos)
    const type = buffer.toString('latin1', pos + 4, pos + 8)
    if (pos + 12 + chunkLength > length) return fail('invalid', 'PNG chunk is truncated')
    if (header === null) {
      if (type !== PNG_IHDR || chunkLength !== 13) {
        return fail('invalid', 'PNG first chunk must be a 13-byte IHDR')
      }
      const width = buffer.readUInt32BE(pos + 8)
      const height = buffer.readUInt32BE(pos + 12)
      if (width < 1 || height < 1) return fail('invalid', 'PNG dimensions must be positive')
      header = { width, height }
    } else if (type === PNG_IHDR) {
      return fail('invalid', 'PNG repeats IHDR')
    }
    if (type === PNG_IDAT) sawImageData = true
    if (type === PNG_IEND) {
      if (chunkLength !== 0) return fail('invalid', 'PNG IEND must be empty')
      if (pos + 12 !== length) return fail('invalid', 'PNG IEND must be the last chunk')
      sawEnd = true
      break
    }
    pos += 12 + chunkLength
  }
  // IHDR alone (or signature-only) is header-only pretending: the container
  // must also carry image data and terminate.
  if (header === null) return fail('invalid', 'PNG has no IHDR')
  if (!sawImageData) return fail('invalid', 'PNG has no IDAT image data')
  if (!sawEnd) return fail('invalid', 'PNG has no IEND terminator')
  return ok(header)
}

function readJpegDimensions(buffer) {
  const length = buffer.length
  if (length < 4 || buffer[0] !== 0xff || buffer[1] !== JPEG_SOI) {
    return fail('invalid', 'JPEG SOI marker is missing')
  }
  if (buffer[length - 2] !== 0xff || buffer[length - 1] !== JPEG_EOI) {
    return fail('invalid', 'JPEG EOI marker is missing')
  }
  let pos = 2
  let frame = null
  let scanEnd = -1
  while (pos < length) {
    if (buffer[pos] !== 0xff) return fail('invalid', 'JPEG marker framing is malformed')
    while (pos < length && buffer[pos] === 0xff) pos += 1
    if (pos >= length) return fail('invalid', 'JPEG marker is truncated')
    const marker = buffer[pos]
    pos += 1
    if (marker === 0x00) return fail('invalid', 'JPEG marker framing is malformed')
    if (marker === JPEG_EOI) break
    if (marker === JPEG_SOI) return fail('invalid', 'JPEG repeats SOI')
    if (marker === JPEG_TEM || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (pos + 2 > length) return fail('invalid', 'JPEG segment length is truncated')
    const segmentLength = buffer.readUInt16BE(pos)
    if (segmentLength < 2 || pos + segmentLength > length) {
      return fail('invalid', 'JPEG segment is truncated')
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) return fail('invalid', 'JPEG frame header is truncated')
      const height = buffer.readUInt16BE(pos + 3)
      const width = buffer.readUInt16BE(pos + 5)
      if (width < 1 || height < 1) return fail('invalid', 'JPEG dimensions must be positive')
      frame = { width, height }
    }
    if (marker === JPEG_SOS) {
      scanEnd = pos + segmentLength
      break
    }
    pos += segmentLength
  }
  // Frame header plus scan header plus at least one entropy-coded byte: a
  // header-only file must not pass as an image.
  if (frame === null) return fail('invalid', 'JPEG has no frame header')
  if (scanEnd < 0) return fail('invalid', 'JPEG has no start-of-scan segment')
  if (scanEnd >= length - 2) return fail('invalid', 'JPEG has no entropy-coded image data')
  return ok(frame)
}

function assertWithinDimensionBudget(dimensions) {
  if (
    dimensions.width > VISUAL_LIMITS.maxImageDimension ||
    dimensions.height > VISUAL_LIMITS.maxImageDimension
  ) {
    return fail('limit', `image dimension exceeds ${VISUAL_LIMITS.maxImageDimension}`)
  }
  if (dimensions.width * dimensions.height > VISUAL_LIMITS.maxImagePixels) {
    return fail('limit', `image pixel count exceeds ${VISUAL_LIMITS.maxImagePixels}`)
  }
  return null
}

/**
 * Per-image gate: MIME, strict base64, octet budget, container framing and
 * dimension/pixel budget. Aggregate image count and total bytes stay with the
 * caller because they span the complete request, including history messages.
 */
function inspectVisualImage(input) {
  if (input.mimeType !== 'image/jpeg' && input.mimeType !== 'image/png') {
    return fail('invalid', 'image mimeType is not allowed')
  }
  const decoded = decodeStrictBase64(input.data, VISUAL_LIMITS.maxImageBytes)
  if (!decoded.ok) return decoded
  const dimensions =
    input.mimeType === 'image/png'
      ? readPngDimensions(decoded.value)
      : readJpegDimensions(decoded.value)
  if (!dimensions.ok) return dimensions
  const budget = assertWithinDimensionBudget(dimensions.value)
  if (budget) return budget
  return ok({
    bytes: decoded.value.length,
    width: dimensions.value.width,
    height: dimensions.value.height,
  })
}

module.exports = {
  VISUAL_LIMITS,
  MAX_ENCODED_IMAGE_BYTES,
  decodeStrictBase64,
  inspectVisualImage,
}
