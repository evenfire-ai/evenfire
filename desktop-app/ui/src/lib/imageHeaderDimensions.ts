/**
 * Header-only PNG/JPEG dimensions for the composer resolution guard.
 * This does not prove the file decodes; the hop still validates the container.
 */

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

export type ImageHeaderDimensions = {
  width: number
  height: number
}

export function readImageHeaderDimensions(
  mimeType: 'image/png' | 'image/jpeg',
  bytes: Uint8Array
): ImageHeaderDimensions | null {
  if (mimeType === 'image/png') return readPngDimensions(bytes)
  if (mimeType === 'image/jpeg') return readJpegDimensions(bytes)
  const exhaustive: never = mimeType
  return exhaustive
}

function readPngDimensions(bytes: Uint8Array): ImageHeaderDimensions | null {
  if (bytes.length < 24) return null
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(8) !== 13) return null
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null
  }
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width < 1 || height < 1) return null
  return { width, height }
}

function readJpegDimensions(bytes: Uint8Array): ImageHeaderDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 2
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) return null
    while (pos < bytes.length && bytes[pos] === 0xff) pos += 1
    if (pos >= bytes.length) return null
    const marker = bytes[pos]
    pos += 1
    if (marker === 0x00) return null
    if (marker === 0xd9) break
    if (marker === 0xd8) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (pos + 2 > bytes.length) return null
    const segmentLength = view.getUint16(pos)
    if (segmentLength < 2 || pos + segmentLength > bytes.length) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) return null
      const height = view.getUint16(pos + 3)
      const width = view.getUint16(pos + 5)
      if (width < 1 || height < 1) return null
      return { width, height }
    }
    if (marker === 0xda) break
    pos += segmentLength
  }
  return null
}
