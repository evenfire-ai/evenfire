import { spawn } from 'node:child_process'
import { VISUAL_INPUT_LIMITS, VisualInputBudget, VisualInputError } from './policy'

export interface InspectedImage {
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

/**
 * Framing detail the parent keeps after the structural pass. Only bounded
 * integers are retained: the child re-derives the IDAT payloads from the bytes,
 * so the parent never holds a second copy of the compressed stream.
 */
interface PngDetail extends InspectedImage {
  mimeType: 'image/png'
  bitsPerPixel: number
  interlace: number
  compressedBytes: number
}

/** Bounded raster descriptor, at most one entry per Adam7 pass. */
interface PngRasterPlan {
  rasterBytes: number
  rows: Array<[number, number]>
}

/** argv metadata handed to the fixed child program; primitives only. */
type ChildValidationPlan =
  | {
      kind: 'png'
      bitsPerPixel: number
      compressed: number
      raster: number
      rows: Array<[number, number]>
    }
  | { kind: 'jpeg' }

interface JpegDetail extends InspectedImage {
  mimeType: 'image/jpeg'
}

type InspectedDetail = PngDetail | JpegDetail

export interface ValidateImageOptions {
  signal?: AbortSignal
  budget: VisualInputBudget
}

/**
 * Bound on the child's reply. The reply is a fixed small JSON object, so a larger
 * payload means the channel is not reporting what this module expects.
 */
const REPLY_LIMIT_BYTES = 4 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_SIGNATURE_LENGTH = PNG_SIGNATURE.length
const PNG_HEADER_BYTES = 13
const PNG_MAX_CHUNK_BYTES = 0x7fffffff
const PNG_MAX_DIMENSION = 0x7fffffff

/**
 * Sample channels and the bit depths the PNG specification allows for each
 * colour type. Any other combination is a malformed header, not an unsupported
 * variant. Channels are also the multiplier for the raster length check.
 */
const PNG_FORMATS = new Map<number, { channels: number; bitDepths: readonly number[] }>([
  [0, { channels: 1, bitDepths: [1, 2, 4, 8, 16] }],
  [2, { channels: 3, bitDepths: [8, 16] }],
  [3, { channels: 1, bitDepths: [1, 2, 4, 8] }],
  [4, { channels: 2, bitDepths: [8, 16] }],
  [6, { channels: 4, bitDepths: [8, 16] }],
])

/**
 * Adam7 pass origin and step pairs in specification order. A pass is skipped
 * when it contains no pixels at the declared size.
 */
const PNG_ADAM7_PASSES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]

const IHDR = chunkTypeCode('IHDR')
const PLTE = chunkTypeCode('PLTE')
const IDAT = chunkTypeCode('IDAT')
const IEND = chunkTypeCode('IEND')

/**
 * Start-of-frame markers. 0xC0/0xC1/0xC2 are baseline, extended sequential and
 * progressive; the rest are lossless, arithmetic or differential variants that
 * are well-formed JPEG but outside the accepted set.
 */
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])
const JPEG_ACCEPTED_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2])

let crcTable: Uint32Array | null = null

function crcLookup(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  crcTable = table
  return table
}

/** CRC-32 over a byte range; no allocation, so it is safe on bounded payloads. */
function crc32(bytes: Buffer, start: number, end: number): number {
  const table = crcLookup()
  let crc = 0xffffffff
  for (let index = start; index < end; index++) {
    crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunkTypeCode(type: string): number {
  return (
    ((type.charCodeAt(0) << 24) |
      (type.charCodeAt(1) << 16) |
      (type.charCodeAt(2) << 8) |
      type.charCodeAt(3)) >>>
    0
  )
}

function chunkTypeCodeAt(bytes: Buffer, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

function isChunkTypeLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

function isCriticalChunkType(code: number): boolean {
  const first = (code >>> 24) & 0xff
  return first >= 0x41 && first <= 0x5a
}

function hasPngSignature(bytes: Buffer): boolean {
  if (bytes.byteLength < PNG_SIGNATURE_LENGTH) return false
  for (let index = 0; index < PNG_SIGNATURE_LENGTH; index++) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return false
  }
  return true
}

/**
 * True when the buffer opens with the JPEG start-of-image marker. A two byte
 * `FF D8` prefix is treated as JPEG so that truncation is reported as a
 * malformed image instead of an unrecognised one.
 */
function hasJpegSignature(bytes: Buffer): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8
}

/**
 * Structural inspection only: no pixels are decoded and no image data is
 * re-encoded. Returns `null` when the bytes are neither PNG nor JPEG, throws
 * `invalid_image` for a malformed container and `unsupported_format` for a
 * well-formed variant this pipeline does not accept.
 */
function inspectDetail(bytes: Buffer): InspectedDetail | null {
  if (hasPngSignature(bytes)) return inspectPng(bytes)
  if (hasJpegSignature(bytes)) return inspectJpeg(bytes)
  return null
}

export function inspectImage(bytes: Buffer): InspectedImage | null {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Invalid visual input bytes')
  if (bytes.byteLength > VISUAL_INPUT_LIMITS.fileBytes) throw new VisualInputError('limit_exceeded')
  const detail = inspectDetail(bytes)
  if (detail === null) return null
  return { mimeType: detail.mimeType, width: detail.width, height: detail.height }
}

function inspectPng(bytes: Buffer): PngDetail {
  let offset = PNG_SIGNATURE_LENGTH
  let width = 0
  let height = 0
  let colorType = -1
  let bitsPerPixel = 0
  let interlace = 0
  let sawHeader = false
  let sawPalette = false
  let sawData = false
  let dataClosed = false
  let sawEnd = false
  let compressedBytes = 0

  while (offset < bytes.byteLength) {
    if (sawEnd) {
      // Trailing bytes after IEND are not part of the stream.
      throw new VisualInputError('invalid_image')
    }
    if (offset + 8 > bytes.byteLength) throw new VisualInputError('invalid_image')

    const length = bytes.readUInt32BE(offset)
    if (length > PNG_MAX_CHUNK_BYTES) throw new VisualInputError('invalid_image')

    const typeOffset = offset + 4
    for (let index = 0; index < 4; index++) {
      if (!isChunkTypeLetter(bytes[typeOffset + index])) {
        throw new VisualInputError('invalid_image')
      }
    }

    const dataOffset = offset + 8
    const crcOffset = dataOffset + length
    const next = crcOffset + 4
    // A length that runs past the buffer is the truncation and framing class
    // that the native decoder cannot survive, so it is rejected here.
    if (next > bytes.byteLength) throw new VisualInputError('invalid_image')

    const type = chunkTypeCodeAt(bytes, typeOffset)
    if (crc32(bytes, typeOffset, crcOffset) !== bytes.readUInt32BE(crcOffset)) {
      throw new VisualInputError('invalid_image')
    }

    if (type === IHDR) {
      if (sawHeader || offset !== PNG_SIGNATURE_LENGTH) {
        throw new VisualInputError('invalid_image')
      }
      if (length !== PNG_HEADER_BYTES) throw new VisualInputError('invalid_image')

      width = bytes.readUInt32BE(dataOffset)
      height = bytes.readUInt32BE(dataOffset + 4)
      if (width === 0 || height === 0 || width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION) {
        throw new VisualInputError('invalid_image')
      }

      const bitDepth = bytes[dataOffset + 8]
      colorType = bytes[dataOffset + 9]
      const format = PNG_FORMATS.get(colorType)
      if (!format || !format.bitDepths.includes(bitDepth)) {
        throw new VisualInputError('invalid_image')
      }
      bitsPerPixel = format.channels * bitDepth
      if (bytes[dataOffset + 10] !== 0) throw new VisualInputError('invalid_image')
      if (bytes[dataOffset + 11] !== 0) throw new VisualInputError('invalid_image')
      interlace = bytes[dataOffset + 12]
      // Interlaced PNG (Adam7) is accepted: it is verified to decode correctly
      // in the pinned canvas build. Any other value is not a defined method.
      if (interlace !== 0 && interlace !== 1) throw new VisualInputError('invalid_image')
      sawHeader = true
    } else if (type === PLTE) {
      if (!sawHeader || sawData) throw new VisualInputError('invalid_image')
      // A palette is meaningless for greyscale and required for indexed colour.
      if (colorType === 0 || colorType === 4) throw new VisualInputError('invalid_image')
      if (length === 0 || length % 3 !== 0 || length > 256 * 3) {
        throw new VisualInputError('invalid_image')
      }
      sawPalette = true
    } else if (type === IDAT) {
      if (!sawHeader || dataClosed) throw new VisualInputError('invalid_image')
      if (colorType === 3 && !sawPalette) throw new VisualInputError('invalid_image')
      // Only the total is retained; the child re-reads the payloads itself.
      compressedBytes += length
      sawData = true
    } else if (type === IEND) {
      if (!sawHeader || !sawData || length !== 0) throw new VisualInputError('invalid_image')
      sawEnd = true
    } else {
      if (!sawHeader) throw new VisualInputError('invalid_image')
      // A conforming decoder must reject unknown critical chunks. The pinned
      // decoder does not, so the check has to live here.
      if (isCriticalChunkType(type)) throw new VisualInputError('unsupported_format')
    }

    if (sawData && type !== IDAT && type !== IEND) dataClosed = true
    offset = next
  }

  if (!sawHeader || !sawData || !sawEnd) throw new VisualInputError('invalid_image')
  return { mimeType: 'image/png', width, height, bitsPerPixel, interlace, compressedBytes }
}

/**
 * Walks entropy-coded scan data to the next marker. Byte stuffing (`FF 00`) and
 * restart markers are skipped; the returned offset points at a marker's `FF`.
 */
function scanJpegEntropy(bytes: Buffer, offset: number): number {
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    if (offset + 1 >= bytes.byteLength) throw new VisualInputError('invalid_image')
    const next = bytes[offset + 1]
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      offset += 2
      continue
    }
    if (next === 0xff) {
      offset++
      continue
    }
    return offset
  }
  throw new VisualInputError('invalid_image')
}

function inspectJpeg(bytes: Buffer): JpegDetail {
  let offset = 2
  let width = -1
  let height = -1
  let sawFrame = false
  let sawScan = false
  let sawEnd = false

  while (!sawEnd) {
    if (offset + 1 >= bytes.byteLength) throw new VisualInputError('invalid_image')
    if (bytes[offset] !== 0xff) throw new VisualInputError('invalid_image')

    let markerIndex = offset + 1
    while (bytes[markerIndex] === 0xff) {
      markerIndex++
      if (markerIndex >= bytes.byteLength) throw new VisualInputError('invalid_image')
    }
    const marker = bytes[markerIndex]
    offset = markerIndex + 1

    if (marker === 0x00) throw new VisualInputError('invalid_image')
    if (marker === 0xd9) {
      sawEnd = true
      break
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue

    if (offset + 2 > bytes.byteLength) throw new VisualInputError('invalid_image')
    const length = bytes.readUInt16BE(offset)
    if (length < 2) throw new VisualInputError('invalid_image')
    const segmentEnd = offset + length
    if (segmentEnd > bytes.byteLength) throw new VisualInputError('invalid_image')
    const payload = offset + 2

    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (sawFrame) throw new VisualInputError('invalid_image')
      if (!JPEG_ACCEPTED_FRAME_MARKERS.has(marker)) {
        throw new VisualInputError('unsupported_format')
      }
      if (length < 8) throw new VisualInputError('invalid_image')
      const precision = bytes[payload]
      height = bytes.readUInt16BE(payload + 1)
      width = bytes.readUInt16BE(payload + 3)
      const componentCount = bytes[payload + 5]
      if (componentCount === 0) throw new VisualInputError('invalid_image')
      if (length !== 8 + 3 * componentCount) throw new VisualInputError('invalid_image')
      if (width === 0) throw new VisualInputError('invalid_image')
      // A zero height means the size arrives later in a DNL segment; that
      // variant is well-formed but not handled here.
      if (height === 0) throw new VisualInputError('unsupported_format')
      if (marker === 0xc0) {
        if (precision !== 8) throw new VisualInputError('invalid_image')
      } else if (precision !== 8 && precision !== 12) {
        throw new VisualInputError('invalid_image')
      }
      sawFrame = true
      offset = segmentEnd
    } else if (marker === 0xda) {
      if (!sawFrame) throw new VisualInputError('invalid_image')
      const componentCount = bytes[payload]
      if (length !== 6 + 2 * componentCount) throw new VisualInputError('invalid_image')
      sawScan = true
      offset = scanJpegEntropy(bytes, segmentEnd)
    } else {
      offset = segmentEnd
    }
  }

  // A missing EOI is a truncated stream even though the pinned decoder tolerates
  // it, because the bytes after the last scan are then unverifiable.
  if (!sawFrame || !sawScan || !sawEnd) throw new VisualInputError('invalid_image')
  return { mimeType: 'image/jpeg', width, height }
}

/**
 * Every buffer a single validation is known to hold at once: the encoded payload
 * as held by the caller plus the copy handed to the child, three RGBA surfaces
 * (decoder raster, draw target and pixel readback), and, for PNG, the
 * concatenated IDAT stream together with the filtered raster the child
 * materialises. This is an accounting estimate used for admission, not a process
 * RSS cap: native decoder overhead is not observable from here.
 */
function validationReservationBytes(
  byteLength: number,
  pixelCount: number,
  streamBytes: number,
  rasterBytes: number
): number {
  return 2 * byteLength + 12 * pixelCount + streamBytes + rasterBytes
}

/**
 * Describes what the child must verify and what it will allocate, without
 * touching the image bytes.
 */
function describeValidation(detail: InspectedDetail): {
  plan: ChildValidationPlan
  streamBytes: number
  rasterBytes: number
} {
  if (detail.mimeType === 'image/jpeg') {
    return { plan: { kind: 'jpeg' }, streamBytes: 0, rasterBytes: 0 }
  }
  const raster = pngRasterPlan(detail)
  return {
    plan: {
      kind: 'png',
      bitsPerPixel: detail.bitsPerPixel,
      compressed: detail.compressedBytes,
      raster: raster.rasterBytes,
      rows: raster.rows,
    },
    streamBytes: detail.compressedBytes,
    rasterBytes: raster.rasterBytes,
  }
}

function assertWithinLimits(bytes: Buffer, inspected: InspectedImage): void {
  if (bytes.byteLength > VISUAL_INPUT_LIMITS.fileBytes) {
    throw new VisualInputError('limit_exceeded')
  }
  if (
    inspected.width > VISUAL_INPUT_LIMITS.dimension ||
    inspected.height > VISUAL_INPUT_LIMITS.dimension
  ) {
    throw new VisualInputError('limit_exceeded')
  }
  if (inspected.width * inspected.height > VISUAL_INPUT_LIMITS.pixels) {
    throw new VisualInputError('limit_exceeded')
  }
}

/** One scanline is a filter byte followed by the packed samples of that row. */
function pngScanlineBytes(width: number, bitsPerPixel: number): number {
  return 1 + Math.ceil((width * bitsPerPixel) / 8)
}

/**
 * Describes the filtered raster the header implies: its exact length and one
 * `[rowWidth, rowHeight]` pair per Adam7 pass (a single pair when the image is
 * not interlaced). The length was verified against real encoder output for
 * colour types 0/2/3/6, bit depths 1/4/8/16 and both interlace methods.
 *
 * This is the only work the parent does for the stream check: arithmetic and at
 * most seven integer pairs. The bytes themselves are inspected by the child, so
 * no decode or decompression runs on the parent's event loop.
 */
function pngRasterPlan(detail: PngDetail): PngRasterPlan {
  const rows: Array<[number, number]> = []
  if (detail.interlace === 0) {
    rows.push([detail.width, detail.height])
  } else {
    for (const [xOrigin, yOrigin, xStep, yStep] of PNG_ADAM7_PASSES) {
      const passWidth = Math.ceil((detail.width - xOrigin) / xStep)
      const passHeight = Math.ceil((detail.height - yOrigin) / yStep)
      if (passWidth <= 0 || passHeight <= 0) continue
      rows.push([passWidth, passHeight])
    }
  }

  let rasterBytes = 0
  for (const [rowWidth, rowHeight] of rows) {
    rasterBytes += rowHeight * pngScanlineBytes(rowWidth, detail.bitsPerPixel)
  }
  return { rasterBytes, rows }
}

interface ChildReply {
  ok: boolean
  width?: number
  height?: number
}

function parseChildReply(chunks: Buffer[]): ChildReply | null {
  if (chunks.length === 0) return null
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const record = parsed as Record<string, unknown>
  if (record.ok === false) return { ok: false }
  if (record.ok !== true) return null
  if (!Number.isInteger(record.width) || !Number.isInteger(record.height)) return null
  return { ok: true, width: record.width as number, height: record.height as number }
}

/**
 * Fixed child program. Every operation on the image bytes happens here: the
 * compressed stream is reassembled and inflated under a hard output cap, the
 * scanline filter bytes are checked against the parent's row descriptors, and the
 * pinned canvas build decodes, rasterises and materialises the pixels so a real
 * decode is forced before the dimensions are reported.
 *
 * The parent passes only bounded integers as metadata, so nothing in argv can
 * widen the work this program does.
 */
const CHILD_SOURCE = [
  'const canvasPath = process.argv[1]',
  'const plan = JSON.parse(process.argv[2])',
  'const zlib = require("zlib")',
  'const chunks = []',
  'process.stdin.on("data", (chunk) => { chunks.push(chunk) })',
  'process.stdin.on("error", () => { process.exitCode = 3 })',
  'process.stdin.on("end", async () => {',
  '  const fail = () => { process.stdout.write(\'{"ok":false}\') }',
  '  try {',
  '    const bytes = Buffer.concat(chunks)',
  '    if (plan.kind === "png") {',
  '      let offset = 8',
  '      const parts = []',
  '      let compressedBytes = 0',
  '      while (offset + 8 <= bytes.length) {',
  '        const length = bytes.readUInt32BE(offset)',
  '        const type = bytes.toString("latin1", offset + 4, offset + 8)',
  '        const dataStart = offset + 8',
  '        const dataEnd = dataStart + length',
  '        if (dataEnd + 4 > bytes.length) { fail(); return }',
  '        if (type === "IDAT") {',
  '          parts.push(bytes.subarray(dataStart, dataEnd))',
  '          compressedBytes += length',
  '        }',
  '        if (type === "IEND") break',
  '        offset = dataEnd + 4',
  '      }',
  '      if (parts.length === 0 || compressedBytes !== plan.compressed) { fail(); return }',
  '      const compressed = parts.length === 1 ? parts[0] : Buffer.concat(parts)',
  '      const inflated = zlib.inflateSync(compressed, { info: true, maxOutputLength: plan.raster })',
  '      // A complete zlib stream consumes its whole compressed input, so a',
  '      // shortfall means trailing bytes followed the end of the stream.',
  '      if (inflated.engine.bytesWritten !== compressed.length) { fail(); return }',
  '      const raster = inflated.buffer',
  '      if (raster.length !== plan.raster) { fail(); return }',
  '      let cursor = 0',
  '      for (const row of plan.rows) {',
  '        const stride = 1 + Math.ceil((row[0] * plan.bitsPerPixel) / 8)',
  '        for (let index = 0; index < row[1]; index++) {',
  '          if (cursor >= raster.length || raster[cursor] > 4) { fail(); return }',
  '          cursor += stride',
  '        }',
  '      }',
  '      if (cursor !== raster.length) { fail(); return }',
  '    }',
  '    const canvas = require(canvasPath)',
  '    const image = await canvas.loadImage(bytes)',
  '    const width = image.width',
  '    const height = image.height',
  '    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {',
  '      fail()',
  '      return',
  '    }',
  '    const surface = canvas.createCanvas(width, height)',
  '    const context = surface.getContext("2d")',
  '    context.drawImage(image, 0, 0)',
  '    const pixels = context.getImageData(0, 0, width, height).data',
  '    if (!pixels || pixels.length !== width * height * 4) { fail(); return }',
  '    process.stdout.write(\'{"ok":true,"width":\' + width + \',"height":\' + height + \'}\')',
  '  } catch {',
  '    fail()',
  '  }',
  '})',
].join('\n')

function runValidationChild(
  bytes: Buffer,
  inspected: InspectedImage,
  plan: ChildValidationPlan,
  signal: AbortSignal | undefined
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let failure: VisualInputError | null = null
    let settled = false
    let stdoutBytes = 0
    const stdoutChunks: Buffer[] = []

    const child = spawn(
      process.execPath,
      ['-e', CHILD_SOURCE, require.resolve('@napi-rs/canvas'), JSON.stringify(plan)],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        // No inherited environment: the child needs no credentials, proxy or
        // registry configuration to decode bytes that arrive on stdin.
        env: {},
        shell: false,
        windowsHide: true,
      }
    )

    const timer = setTimeout(() => {
      failure = new VisualInputError('timeout')
      child.kill('SIGKILL')
    }, VISUAL_INPUT_LIMITS.validationTimeoutMs)

    const onAbort = () => {
      failure = new VisualInputError('cancelled')
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const settle = (outcome: VisualInputError | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // Cancellation outranks a reply: a result that lands after the caller
      // aborted must never be reported as validated.
      if (failure) reject(failure)
      else if (signal?.aborted) reject(new VisualInputError('cancelled'))
      else if (outcome) reject(outcome)
      else resolve()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > REPLY_LIMIT_BYTES) {
        if (!failure) failure = new VisualInputError('invalid_response')
        child.kill('SIGKILL')
        return
      }
      stdoutChunks.push(chunk)
    })
    // Drained so the child cannot block on a full stderr pipe; never surfaced.
    child.stderr.on('data', () => {})
    // The child may exit before the payload is fully written.
    child.stdin.on('error', () => {})

    child.on('error', () => {
      settle(new VisualInputError('invalid_response'))
    })
    child.on('close', (code, signalName) => {
      const reply = parseChildReply(stdoutChunks)
      if (reply === null) {
        // No usable reply. A signal means the native decoder did not survive
        // this input; every other silent exit is a failure of the reply channel,
        // because the child writes a result on every decode outcome it survives.
        settle(new VisualInputError(signalName !== null ? 'invalid_image' : 'invalid_response'))
        return
      }
      if (!reply.ok) {
        settle(new VisualInputError('invalid_image'))
        return
      }
      if (reply.width !== inspected.width || reply.height !== inspected.height) {
        // The header and the decoder disagree, so the container is not trusted.
        settle(new VisualInputError('invalid_image'))
        return
      }
      settle(null)
    })

    // The payload is bounded before this point, so this write is capped too.
    child.stdin.end(bytes)
  })
}

/**
 * Confirms that `bytes` really is the declared image by validating its framing
 * and then handing the bytes to an isolated child process, which inflates and
 * checks the PNG stream and decodes the image. The child is the only place a
 * native decoder or a decompressor runs: malformed input can terminate that
 * process outright, which is reported as an image error instead of taking down
 * the host, and neither operation ever blocks the parent's event loop.
 *
 * The source buffer is never modified and no re-encoded output is produced.
 */
export async function validateImage(
  bytes: Buffer,
  info: InspectedImage,
  options: ValidateImageOptions
): Promise<void> {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Invalid visual input bytes')
  const { budget, signal } = options
  if (!(budget instanceof VisualInputBudget)) throw new TypeError('Invalid visual input budget')
  if (signal?.aborted) throw new VisualInputError('cancelled')

  // Re-derive the structure from the bytes so that framing corruption is
  // rejected before any reservation, allocation or child process.
  const inspected = inspectDetail(bytes)
  if (
    !inspected ||
    inspected.mimeType !== info.mimeType ||
    inspected.width !== info.width ||
    inspected.height !== info.height
  ) {
    throw new VisualInputError('invalid_image')
  }

  assertWithinLimits(bytes, inspected)
  // Descriptors only: arithmetic over the header, bounded by the limits above.
  const validation = describeValidation(inspected)
  // Reserved before the child is spawned and before any buffer is allocated, and
  // large enough to cover every buffer this validation is known to hold.
  const reservation = budget.reserve(
    validationReservationBytes(
      bytes.byteLength,
      inspected.width * inspected.height,
      validation.streamBytes,
      validation.rasterBytes
    )
  )
  try {
    await runValidationChild(bytes, inspected, validation.plan, signal)
  } finally {
    // Released only after the child has exited and been reaped.
    reservation.release()
  }
}
