import { describe, expect, test, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { inspectImage, validateImage } from './imageValidation'
import { VISUAL_INPUT_LIMITS, VisualInputBudget, VisualInputError } from './policy'

// The wrapper delegates to the real spawn, so behaviour is unchanged; it only
// makes it observable whether a decoder child was started.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const spawnMock = vi.mocked(spawn)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Offsets inside the fixture produced by `buildPng` when no extra chunks are
 * requested: the IHDR chunk is 25 bytes, so the IDAT length field starts at 33,
 * the IDAT type at 37 and the IDAT payload at 41.
 */
const FIXTURE_IDAT_LENGTH_OFFSET = 33
const FIXTURE_IDAT_TYPE_OFFSET = 37
const FIXTURE_IDAT_DATA_OFFSET = 41

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    let value = (crc ^ byte) & 0xff
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    crc = (crc >>> 8) ^ value
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

interface PngOptions {
  width?: number
  height?: number
  bitDepth?: number
  colorType?: number
  interlace?: number
  idat?: Buffer
  extraChunks?: Array<{ type: string; data: Buffer }>
  includeEnd?: boolean
}

/** 8-bit RGB raster: one filter byte plus three bytes per pixel on each row. */
function rgbRaster(width: number, height: number): Buffer {
  const rows: Buffer[] = []
  for (let row = 0; row < height; row++) rows.push(Buffer.alloc(1 + width * 3))
  return Buffer.concat(rows)
}

/** Same layout as `rgbRaster`, with a chosen filter type for each scanline. */
function filteredRaster(width: number, height: number, filters: number[]): Buffer {
  const rowBytes = 1 + width * 3
  const raster = Buffer.alloc(height * rowBytes)
  for (let row = 0; row < height; row++) {
    raster[row * rowBytes] = filters[row % filters.length]
  }
  return raster
}

function buildPng(options: PngOptions = {}): Buffer {
  const width = options.width ?? 2
  const height = options.height ?? 2
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = options.bitDepth ?? 8
  header[9] = options.colorType ?? 2
  header[12] = options.interlace ?? 0

  const parts = [PNG_SIGNATURE, pngChunk('IHDR', header)]
  for (const extra of options.extraChunks ?? []) parts.push(pngChunk(extra.type, extra.data))
  parts.push(pngChunk('IDAT', options.idat ?? deflateSync(rgbRaster(width, height))))
  if (options.includeEnd !== false) parts.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/**
 * Minimal progressive JPEG framing: two scans and an explicit EOI. The scan data
 * is not a decodable image, so this fixture pins structural acceptance only.
 */
function buildProgressiveJpeg(width: number, height: number): Buffer {
  const frame = (marker: number): Buffer => {
    const payload = Buffer.alloc(9)
    payload[0] = 8
    payload.writeUInt16BE(height, 1)
    payload.writeUInt16BE(width, 3)
    payload[5] = 1
    payload[6] = 1
    payload[7] = 0x11
    payload[8] = 0
    const length = Buffer.alloc(2)
    length.writeUInt16BE(payload.length + 2)
    return Buffer.concat([Buffer.from([0xff, marker]), length, payload])
  }
  const scan = (): Buffer => {
    // Ns(1) + one component spec pair + Ss/Se/Ah-Al for a single-component scan.
    const payload = Buffer.from([1, 1, 0, 0, 63, 0])
    const length = Buffer.alloc(2)
    length.writeUInt16BE(payload.length + 2)
    return Buffer.concat([Buffer.from([0xff, 0xda]), length, payload])
  }
  // Entropy data exercises byte stuffing and a restart marker.
  const entropy = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    frame(0xc2),
    scan(),
    entropy,
    scan(),
    entropy,
    Buffer.from([0xff, 0xd9]),
  ])
}

/** Same framing as above but carrying an unsupported arithmetic frame marker. */
function buildArithmeticJpeg(width: number, height: number): Buffer {
  const progressive = buildProgressiveJpeg(width, height)
  const copy = Buffer.from(progressive)
  const frameIndex = copy.indexOf(Buffer.from([0xff, 0xc2]))
  copy[frameIndex + 1] = 0xc9
  return copy
}

/**
 * Real encoder fixtures, produced with ImageMagick 7:
 *
 *   magick -size 8x8 xc:black -fill '#ff0000' -draw 'point 0,0' \
 *     -fill '#00ff00' -draw 'point 1,0' -fill '#0000ff' -draw 'point 0,1' \
 *     -fill '#ffff00' -draw 'point 7,7' -fill '#ff00ff' -draw 'point 6,1' \
 *     -fill '#00ffff' -draw 'point 3,4' -fill '#808080' -draw 'rectangle 2,2 4,3' \
 *     -define png:compression-level=0 plain8.png
 *   magick plain8.png -interlace PNG interlaced8.png
 *   magick -size 16x16 xc:'#3366cc' -fill '#ffcc00' -draw 'rectangle 4,4 11,11' \
 *     -interlace JPEG -quality 35 progressive.jpg
 *
 * Both PNGs are palette images (colour type 3, bit depth 4) and the pair anchors
 * the filtered-raster length against real encoder output, including the Adam7
 * pass table. The progressive JPEG anchors multi-scan framing. They are embedded
 * because the pinned canvas build can emit neither an interlaced PNG nor a
 * progressive JPEG.
 */
const PLAIN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIBAMAAAA2IaO4AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAbUExURf8AAAD/AAAAAAAA//8A/4CAgAD/////AP///2ZLB6AAAAABYktHRAiG3pV6AAAAB3RJTUUH6gkQFCc3X1W7bAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOS0xNlQyMDozOTo1NSswMDowMOpYq60AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDktMTZUMjA6Mzk6NTUrMDA6MDCbBRMRAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA5LTE2VDIwOjM5OjU1KzAwOjAwzBAyzgAAADNJREFUCB0BKADX/wABIiIiADIiIkIAIlVSIgAiVVIiACImIiIAIiIiIgAiIiIiACIiIidpxwUfko1JSgAAAABJRU5ErkJggg=='
const INTERLACED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIBAMAAAFBJpMuAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAbUExURf8AAAD/AAAAAAAA//8A/4CAgAD/////AP///2ZLB6AAAAABYktHRAiG3pV6AAAAB3RJTUUH6gkQFCc3X1W7bAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOS0xNlQyMDozOTo1NSswMDowMOpYq60AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDktMTZUMjA6Mzk6NTUrMDA6MDCbBRMRAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA5LTE2VDIwOjM5OjU1KzAwOjAwzBAyzgAAACtJREFUCNdjYGBQYFACQ9UgBiUlBiEgQ4lBTQnENlJScmJQCg0CcZTAhDoAZ6EFAeISxioAAAAASUVORK5CYII='
// 752 base64 characters, split into fixed-width chunks so the fixture stays
// reviewable. The decoded bytes are 564 bytes with sha256
// e6757be029f37915975c49e70823f5149a333e2e18ee08f047fbaef9680b3190, and carry
// a single SOF2 frame with ten scans.
const PROGRESSIVE_JPEG_BASE64 = [
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABcQERQRDhcUEhQaGBcbIjklIh8fIkYyNSk5UkhXVVFIUE5bZoNvW2F8Yk5QcptzfIeLkpSSWG2grJ+OqoOPko3/2wBDARgaGiIeIkMlJUONXlBejY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2N',
  'jY2NjY2NjY2NjY2NjY2NjY3/wgARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAH/xAAUAQEAAAAAAAAAAAAAAAAAAAAC/9oADAMBAAIQAxAAAAGBj//EABYQAQEBAAAAAAAAAAAAAAAAAAIAEv/aAAgBAQABBQInUjmKzJav/8QA',
  'FxEAAwEAAAAAAAAAAAAAAAAAABIiYf/aAAgBAwEBPwGV0//EABcRAAMBAAAAAAAAAAAAAAAAAAATI2L/2gAIAQIBAT8BozJ//8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQAGPwIf/8QAFhABAQEAAAAAAAAAAAAAAAAAESEA/9oACAEBAAE/IbqG',
  'mq66LpoG/9oADAMBAAIAAwAAABAH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxAP/8QAGREAAQUAAAAAAAAAAAAAAAAAABExUZHw/9oACAECAQE/ENki3P/EABcQAAMBAAAAAAAAAAAAAAAAAAARQXH/2gAIAQEAAT8Qy5GbciMuVG3Kz//Z',
].join('')

function countMarkers(bytes: Buffer, marker: number): number {
  let count = 0
  for (let index = 0; index + 1 < bytes.byteLength; index++) {
    if (bytes[index] === 0xff && bytes[index + 1] === marker) count++
  }
  return count
}

function canvasPng(width = 32, height = 24): Buffer {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#3366cc'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#ffcc00'
  context.fillRect(4, 4, 10, 8)
  return canvas.toBuffer('image/png')
}

function canvasJpeg(width = 32, height = 24): Buffer {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#3366cc'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#ffcc00'
  context.fillRect(4, 4, 10, 8)
  return canvas.toBuffer('image/jpeg', 80)
}

function newBudget(residentLimit?: number, readLimit?: number): VisualInputBudget {
  return new VisualInputBudget(
    residentLimit ?? VISUAL_INPUT_LIMITS.residentBytesPerTurn,
    readLimit ?? VISUAL_INPUT_LIMITS.readBytesPerTurn
  )
}

function inspectFailureCode(bytes: Buffer): string {
  try {
    inspectImage(bytes)
  } catch (error) {
    if (error instanceof VisualInputError) return error.code
    throw error
  }
  return 'no_error'
}

async function validationFailureCode(
  bytes: Buffer,
  info: { mimeType: 'image/png' | 'image/jpeg'; width: number; height: number },
  options?: { signal?: AbortSignal; budget?: VisualInputBudget }
): Promise<string> {
  try {
    await validateImage(bytes, info, {
      signal: options?.signal,
      budget: options?.budget ?? newBudget(),
    })
  } catch (error) {
    if (error instanceof VisualInputError) return error.code
    throw error
  }
  return 'no_error'
}

describe('inspectImage', () => {
  test('reports the declared dimensions for canvas-encoded images', () => {
    expect(inspectImage(canvasPng(32, 24))).toEqual({
      mimeType: 'image/png',
      width: 32,
      height: 24,
    })
    expect(inspectImage(canvasJpeg(48, 12))).toEqual({
      mimeType: 'image/jpeg',
      width: 48,
      height: 12,
    })
  })

  test('returns null only for bytes that are neither PNG nor JPEG', () => {
    expect(inspectImage(Buffer.from('plain text, not an image'))).toBeNull()
    expect(inspectImage(Buffer.alloc(0))).toBeNull()
    // GIF magic is a real container, but not one this pipeline accepts.
    expect(inspectImage(Buffer.from('GIF89a....'))).toBeNull()
  })

  test('accepts interlaced PNG and rejects an undefined interlace method', () => {
    // A 1x1 image keeps its only pixel in Adam7 pass one, so the same scanline
    // layout is a valid interlaced stream and remains decodable.
    const interlaced = buildPng({ width: 1, height: 1, interlace: 1 })
    expect(inspectImage(interlaced)).toEqual({ mimeType: 'image/png', width: 1, height: 1 })
    expect(inspectFailureCode(buildPng({ width: 1, height: 1, interlace: 2 }))).toBe(
      'invalid_image'
    )
  })

  test('rejects truncated PNG framing', () => {
    const png = canvasPng()
    expect(inspectFailureCode(png.subarray(0, 40))).toBe('invalid_image')
    expect(inspectFailureCode(png.subarray(0, png.length - 1))).toBe('invalid_image')
    expect(inspectFailureCode(buildPng({ includeEnd: false }))).toBe('invalid_image')
  })

  test('rejects a PNG chunk whose CRC does not match its contents', () => {
    // Flipping IDAT payload byte 41 cannot change framing or declared dimensions,
    // so the chunk CRC is the only check that can reject this file.
    const png = buildPng({ width: 2, height: 2 })
    const corrupted = Buffer.from(png)
    corrupted[FIXTURE_IDAT_DATA_OFFSET] = corrupted[FIXTURE_IDAT_DATA_OFFSET] ^ 0xff
    expect(inspectFailureCode(corrupted)).toBe('invalid_image')
  })

  test('rejects a PNG chunk type that is not a letter', () => {
    // The pinned decoder terminates on this input rather than reporting a decode
    // error, so the framing check is what keeps the process alive.
    const png = Buffer.from(buildPng({ width: 2, height: 2 }))
    png[FIXTURE_IDAT_TYPE_OFFSET] = 0xab
    expect(inspectFailureCode(png)).toBe('invalid_image')
  })

  test('rejects a PNG chunk length that runs past the end of the file', () => {
    const corrupted = Buffer.from(buildPng({ width: 2, height: 2 }))
    corrupted.writeUInt32BE(0x00ffffff, FIXTURE_IDAT_LENGTH_OFFSET)
    expect(inspectFailureCode(corrupted)).toBe('invalid_image')
  })

  test('rejects an unknown critical chunk instead of trusting the decoder', () => {
    // The pinned decoder ignores this chunk and returns pixels, so the rejection
    // has to come from the structural check.
    const png = buildPng({ extraChunks: [{ type: 'ZZZZ', data: Buffer.from([1, 2, 3]) }] })
    expect(inspectFailureCode(png)).toBe('unsupported_format')
  })

  test('rejects a malformed PNG header colour type and bit depth pair', () => {
    expect(inspectFailureCode(buildPng({ colorType: 2, bitDepth: 4 }))).toBe('invalid_image')
    expect(inspectFailureCode(buildPng({ colorType: 9, bitDepth: 8 }))).toBe('invalid_image')
  })

  test('accepts progressive JPEG framing and rejects unsupported frame markers', () => {
    expect(inspectImage(buildProgressiveJpeg(20, 10))).toEqual({
      mimeType: 'image/jpeg',
      width: 20,
      height: 10,
    })
    expect(inspectFailureCode(buildArithmeticJpeg(20, 10))).toBe('unsupported_format')
  })

  test('rejects truncated JPEG framing', () => {
    const jpeg = canvasJpeg()
    expect(inspectFailureCode(jpeg.subarray(0, Math.floor(jpeg.length * 0.6)))).toBe(
      'invalid_image'
    )
    // Removing the EOI marker leaves unverifiable trailing scan data.
    expect(inspectFailureCode(jpeg.subarray(0, jpeg.length - 2))).toBe('invalid_image')
    expect(
      inspectFailureCode(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('junk')]))
    ).toBe('invalid_image')
  })
})

describe('validateImage', () => {
  test('validates real PNG and JPEG bytes and releases its reservation', async () => {
    const budget = newBudget()
    const png = canvasPng(32, 24)
    await expect(
      validateImage(png, { mimeType: 'image/png', width: 32, height: 24 }, { budget })
    ).resolves.toBeUndefined()
    expect(budget.residentBytes).toBe(0)

    const jpeg = canvasJpeg(32, 24)
    await expect(
      validateImage(jpeg, { mimeType: 'image/jpeg', width: 32, height: 24 }, { budget })
    ).resolves.toBeUndefined()
    expect(budget.residentBytes).toBe(0)
  })

  test('decodes an interlaced 1x1 PNG that the parser accepted', async () => {
    const budget = newBudget()
    const interlaced = buildPng({ width: 1, height: 1, interlace: 1 })
    await expect(
      validateImage(interlaced, { mimeType: 'image/png', width: 1, height: 1 }, { budget })
    ).resolves.toBeUndefined()
    expect(budget.residentBytes).toBe(0)
  })

  test('validates an image at a realistic size within the decode deadline', async () => {
    const budget = newBudget()
    const png = canvasPng(1200, 800)
    await expect(
      validateImage(png, { mimeType: 'image/png', width: 1200, height: 800 }, { budget })
    ).resolves.toBeUndefined()
    expect(budget.residentBytes).toBe(0)
  })

  test('rejects declared dimensions that disagree with the encoded header', async () => {
    const png = canvasPng(32, 24)
    await expect(
      validationFailureCode(png, { mimeType: 'image/png', width: 32, height: 25 })
    ).resolves.toBe('invalid_image')
    await expect(
      validationFailureCode(png, { mimeType: 'image/jpeg', width: 32, height: 24 })
    ).resolves.toBe('invalid_image')
  })

  test('enforces file, dimension and pixel limits before decoding', async () => {
    // These fixtures are rejected before decoding, so a tiny placeholder payload
    // keeps the test cheap while leaving the framing valid.
    const oversizeDimension = buildPng({
      width: VISUAL_INPUT_LIMITS.dimension + 1,
      height: 2,
      idat: Buffer.from([1, 2, 3]),
    })
    expect(inspectImage(oversizeDimension)).toEqual({
      mimeType: 'image/png',
      width: VISUAL_INPUT_LIMITS.dimension + 1,
      height: 2,
    })
    const budget = newBudget()
    await expect(
      validationFailureCode(
        oversizeDimension,
        { mimeType: 'image/png', width: VISUAL_INPUT_LIMITS.dimension + 1, height: 2 },
        { budget }
      )
    ).resolves.toBe('limit_exceeded')
    expect(budget.residentBytes).toBe(0)

    // Both edges are inside the dimension limit, but the product is not.
    const oversizePixels = buildPng({ width: 4096, height: 2000, idat: Buffer.from([1, 2, 3]) })
    await expect(
      validationFailureCode(
        oversizePixels,
        { mimeType: 'image/png', width: 4096, height: 2000 },
        { budget: newBudget() }
      )
    ).resolves.toBe('limit_exceeded')

    const oversizeFile = buildPng({ idat: Buffer.alloc(VISUAL_INPUT_LIMITS.fileBytes + 1) })
    expect(oversizeFile.byteLength).toBeGreaterThan(VISUAL_INPUT_LIMITS.fileBytes)
    expect(inspectFailureCode(oversizeFile)).toBe('limit_exceeded')
    await expect(
      validationFailureCode(
        oversizeFile,
        { mimeType: 'image/png', width: 2, height: 2 },
        { budget: newBudget() }
      )
    ).resolves.toBe('limit_exceeded')
  })

  test('rejects an image that does not fit the caller budget', async () => {
    const budget = new VisualInputBudget(1024, VISUAL_INPUT_LIMITS.readBytesPerTurn)
    await expect(
      validationFailureCode(
        canvasPng(32, 24),
        { mimeType: 'image/png', width: 32, height: 24 },
        {
          budget,
        }
      )
    ).resolves.toBe('limit_exceeded')
    expect(budget.residentBytes).toBe(0)
  })

  test('rejects malformed framing without spawning a decoder process', async () => {
    spawnMock.mockClear()

    // Positive control: without this, a mock that never intercepts the module
    // the implementation imports would make the assertion below vacuous.
    await validateImage(
      canvasPng(8, 8),
      { mimeType: 'image/png', width: 8, height: 8 },
      {
        budget: newBudget(),
      }
    )
    expect(spawnMock).toHaveBeenCalledTimes(1)

    // A chunk type byte that is not a letter terminates the pinned decoder, so it
    // must be rejected by the framing check before the child is started.
    const corrupted = Buffer.from(buildPng({ width: 2, height: 2 }))
    corrupted[FIXTURE_IDAT_TYPE_OFFSET] = 0xab
    expect(
      await validationFailureCode(corrupted, {
        mimeType: 'image/png',
        width: 2,
        height: 2,
      })
    ).toBe('invalid_image')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  test('kills the validation child when the caller aborts mid-flight', async () => {
    spawnMock.mockClear()
    const budget = newBudget()
    const controller = new AbortController()
    const pending = validateImage(
      canvasPng(32, 24),
      { mimeType: 'image/png', width: 32, height: 24 },
      { budget, signal: controller.signal }
    )
    // The child is already running when the caller aborts.
    expect(spawnMock).toHaveBeenCalledTimes(1)
    // Aborting immediately after the call races the child that was just spawned;
    // the reply must never win.
    controller.abort()
    const code = await pending.catch((error: unknown) => (error as VisualInputError).code)
    expect(code).toBe('cancelled')
    // The reservation is only released once that child has actually exited.
    const child = spawnMock.mock.results[0].value
    expect(child.signalCode).toBe('SIGKILL')
    expect(budget.residentBytes).toBe(0)
  })

  test('rejects a pre-aborted signal without reserving memory', async () => {
    const budget = newBudget()
    const controller = new AbortController()
    controller.abort()
    await expect(
      validationFailureCode(
        canvasPng(32, 24),
        { mimeType: 'image/png', width: 32, height: 24 },
        {
          budget,
          signal: controller.signal,
        }
      )
    ).resolves.toBe('cancelled')
    expect(budget.residentBytes).toBe(0)
  })

  test('leaves the source bytes untouched on success and on failure', async () => {
    const png = canvasPng(32, 24)
    const expected = Buffer.from(png)
    await validateImage(
      png,
      { mimeType: 'image/png', width: 32, height: 24 },
      { budget: newBudget() }
    )
    expect(png.equals(expected)).toBe(true)

    const malformed = Buffer.from([0xff, 0xd8, 0xff, 0x11, 0x22])
    const malformedExpected = Buffer.from(malformed)
    await expect(
      validationFailureCode(malformed, { mimeType: 'image/jpeg', width: 1, height: 1 })
    ).resolves.toBe('invalid_image')
    expect(malformed.equals(malformedExpected)).toBe(true)
  })

  test('requires the caller to supply a real budget', async () => {
    await expect(
      validateImage(
        canvasPng(8, 8),
        { mimeType: 'image/png', width: 8, height: 8 },
        { budget: {} as VisualInputBudget }
      )
    ).rejects.toThrow(TypeError)
  })
})

describe('PNG stream integrity', () => {
  test('accepts real encoder output for a plain and an Adam7 raster', async () => {
    const budget = newBudget()
    const fixtures = [
      ['non-interlaced', PLAIN_PNG_BASE64],
      ['interlaced', INTERLACED_PNG_BASE64],
    ] as const

    for (const [label, base64] of fixtures) {
      const bytes = Buffer.from(base64, 'base64')
      expect(inspectImage(bytes), label).toEqual({ mimeType: 'image/png', width: 8, height: 8 })
      await expect(
        validateImage(bytes, { mimeType: 'image/png', width: 8, height: 8 }, { budget }),
        label
      ).resolves.toBeUndefined()
    }
    expect(budget.residentBytes).toBe(0)
  })

  test('accepts every valid colour type and bit depth combination', async () => {
    const cases: Array<{ colorType: number; bitDepth: number; channels: number }> = [
      { colorType: 0, bitDepth: 1, channels: 1 },
      { colorType: 0, bitDepth: 2, channels: 1 },
      { colorType: 0, bitDepth: 4, channels: 1 },
      { colorType: 0, bitDepth: 8, channels: 1 },
      { colorType: 0, bitDepth: 16, channels: 1 },
      { colorType: 2, bitDepth: 8, channels: 3 },
      { colorType: 2, bitDepth: 16, channels: 3 },
      { colorType: 3, bitDepth: 1, channels: 1 },
      { colorType: 3, bitDepth: 2, channels: 1 },
      { colorType: 3, bitDepth: 4, channels: 1 },
      { colorType: 3, bitDepth: 8, channels: 1 },
      { colorType: 4, bitDepth: 8, channels: 2 },
      { colorType: 4, bitDepth: 16, channels: 2 },
      { colorType: 6, bitDepth: 8, channels: 4 },
      { colorType: 6, bitDepth: 16, channels: 4 },
    ]
    const width = 2
    const height = 2

    for (const { colorType, bitDepth, channels } of cases) {
      const rowBytes = 1 + Math.ceil((width * channels * bitDepth) / 8)
      const png = buildPng({
        width,
        height,
        colorType,
        bitDepth,
        idat: deflateSync(Buffer.alloc(height * rowBytes)),
        extraChunks:
          colorType === 3 ? [{ type: 'PLTE', data: Buffer.from([0, 0, 0, 255, 0, 0]) }] : [],
      })
      await expect(
        validateImage(png, { mimeType: 'image/png', width, height }, { budget: newBudget() }),
        `colour type ${colorType} bit depth ${bitDepth}`
      ).resolves.toBeUndefined()
    }
  })

  test('rejects a PNG whose IDAT chunks are not a zlib stream', async () => {
    const png = buildPng({ width: 2, height: 2, idat: Buffer.from([0xde, 0xad, 0xbe, 0xef]) })
    // Framing and CRCs are satisfied, so only the stream check can reject this.
    expect(inspectImage(png)).toEqual({ mimeType: 'image/png', width: 2, height: 2 })
    await expect(
      validationFailureCode(png, { mimeType: 'image/png', width: 2, height: 2 })
    ).resolves.toBe('invalid_image')
  })

  test('rejects a PNG whose raster is shorter than its header declares', async () => {
    const png = buildPng({ width: 32, height: 24, idat: deflateSync(Buffer.alloc(16)) })
    await expect(
      validationFailureCode(png, { mimeType: 'image/png', width: 32, height: 24 })
    ).resolves.toBe('invalid_image')
  })

  test('rejects a PNG whose raster is longer than its header declares', async () => {
    const png = buildPng({ width: 2, height: 2, idat: deflateSync(Buffer.alloc(64)) })
    await expect(
      validationFailureCode(png, { mimeType: 'image/png', width: 2, height: 2 })
    ).resolves.toBe('invalid_image')
  })

  test('rejects a PNG with an empty IDAT payload', async () => {
    const png = buildPng({ width: 2, height: 2, idat: Buffer.alloc(0) })
    await expect(
      validationFailureCode(png, { mimeType: 'image/png', width: 2, height: 2 })
    ).resolves.toBe('invalid_image')
  })

  test('rejects a PNG whose IDAT payload trails the zlib stream', async () => {
    const stream = deflateSync(rgbRaster(2, 2))
    const png = buildPng({
      width: 2,
      height: 2,
      idat: Buffer.concat([stream, Buffer.from([1, 2, 3, 4])]),
    })
    // Framing, CRCs and the inflated length are all intact, so the bytes after
    // the end of the zlib stream are the only thing wrong with this file.
    expect(inspectImage(png)).toEqual({ mimeType: 'image/png', width: 2, height: 2 })
    await expect(
      validationFailureCode(png, { mimeType: 'image/png', width: 2, height: 2 })
    ).resolves.toBe('invalid_image')
  })

  test('rejects a PNG whose scanline filter type is undefined', async () => {
    // Filter types are 0..4, so 5 is not a defined scanline filter.
    const png = buildPng({
      width: 2,
      height: 2,
      idat: deflateSync(filteredRaster(2, 2, [5])),
    })
    expect(inspectImage(png)).toEqual({ mimeType: 'image/png', width: 2, height: 2 })
    await expect(
      validationFailureCode(png, { mimeType: 'image/png', width: 2, height: 2 })
    ).resolves.toBe('invalid_image')
  })

  test('accepts a PNG whose scanlines use every defined filter type', async () => {
    const png = buildPng({
      width: 4,
      height: 4,
      idat: deflateSync(filteredRaster(4, 4, [0, 1, 2, 3, 4])),
    })
    const budget = newBudget()
    await expect(
      validateImage(png, { mimeType: 'image/png', width: 4, height: 4 }, { budget })
    ).resolves.toBeUndefined()
    expect(budget.residentBytes).toBe(0)
  })

  test('accepts a PNG whose image data spans consecutive IDAT chunks', async () => {
    // Encoders split the stream across IDAT chunks, so the child has to
    // reassemble it before inflating.
    const stream = deflateSync(rgbRaster(2, 2))
    const split = Math.floor(stream.byteLength / 2)
    const png = buildPng({
      width: 2,
      height: 2,
      extraChunks: [{ type: 'IDAT', data: stream.subarray(0, split) }],
      idat: stream.subarray(split),
    })
    expect(inspectImage(png)).toEqual({ mimeType: 'image/png', width: 2, height: 2 })

    const budget = newBudget()
    await expect(
      validateImage(png, { mimeType: 'image/png', width: 2, height: 2 }, { budget })
    ).resolves.toBeUndefined()
    expect(budget.residentBytes).toBe(0)
  })
})

describe('validation reservation', () => {
  test('covers the compressed stream and the filtered raster before spawning', async () => {
    const width = 2
    const height = 2
    const png = buildPng({ width, height })
    const compressedBytes = png.readUInt32BE(FIXTURE_IDAT_LENGTH_OFFSET)
    // Two RGB8 scanlines as the coded image data section stores them.
    const rasterBytes = height * (1 + width * 3)
    const payloadAndSurfaces = 2 * png.byteLength + 12 * (width * height)
    const required = payloadAndSurfaces + compressedBytes + rasterBytes
    expect(required).toBeGreaterThan(payloadAndSurfaces)

    spawnMock.mockClear()
    // A budget that would have fitted the payload and the decode surfaces alone
    // must now be refused, and the refusal must precede the child process.
    const tight = new VisualInputBudget(required - 1, VISUAL_INPUT_LIMITS.readBytesPerTurn)
    expect(
      await validationFailureCode(png, { mimeType: 'image/png', width, height }, { budget: tight })
    ).toBe('limit_exceeded')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(tight.residentBytes).toBe(0)

    // The reserved amount is exactly that sum, so this budget just fits.
    const exact = new VisualInputBudget(required, VISUAL_INPUT_LIMITS.readBytesPerTurn)
    await expect(
      validateImage(png, { mimeType: 'image/png', width, height }, { budget: exact })
    ).resolves.toBeUndefined()
    expect(exact.residentBytes).toBe(0)
  })

  test('reserves only the payload and decode surfaces for JPEG', async () => {
    const width = 16
    const height = 16
    const jpeg = canvasJpeg(width, height)
    const required = 2 * jpeg.byteLength + 12 * (width * height)

    spawnMock.mockClear()
    const tight = new VisualInputBudget(required - 1, VISUAL_INPUT_LIMITS.readBytesPerTurn)
    expect(
      await validationFailureCode(
        jpeg,
        { mimeType: 'image/jpeg', width, height },
        { budget: tight }
      )
    ).toBe('limit_exceeded')
    expect(spawnMock).not.toHaveBeenCalled()

    const exact = new VisualInputBudget(required, VISUAL_INPUT_LIMITS.readBytesPerTurn)
    await expect(
      validateImage(jpeg, { mimeType: 'image/jpeg', width, height }, { budget: exact })
    ).resolves.toBeUndefined()
    expect(exact.residentBytes).toBe(0)
  })
})

describe('progressive JPEG', () => {
  test('accepts and decodes a real multi-scan progressive JPEG', async () => {
    const jpeg = Buffer.from(PROGRESSIVE_JPEG_BASE64, 'base64')

    // The fixture only proves anything while it stays progressive and multi-scan.
    expect(countMarkers(jpeg, 0xc2)).toBeGreaterThan(0)
    expect(countMarkers(jpeg, 0xc0)).toBe(0)
    expect(countMarkers(jpeg, 0xda)).toBeGreaterThan(1)
    expect(jpeg.subarray(jpeg.byteLength - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true)

    expect(inspectImage(jpeg)).toEqual({ mimeType: 'image/jpeg', width: 16, height: 16 })

    const budget = newBudget()
    await expect(
      validateImage(jpeg, { mimeType: 'image/jpeg', width: 16, height: 16 }, { budget })
    ).resolves.toBeUndefined()
    expect(budget.residentBytes).toBe(0)
  })

  test('rejects a truncated progressive JPEG', () => {
    const jpeg = Buffer.from(PROGRESSIVE_JPEG_BASE64, 'base64')
    // Dropping the EOI leaves scan data that cannot be verified.
    expect(inspectFailureCode(jpeg.subarray(0, jpeg.byteLength - 2))).toBe('invalid_image')
    // Cutting inside the marker structure loses the frame before any scan ends.
    expect(inspectFailureCode(jpeg.subarray(0, 200))).toBe('invalid_image')
  })
})
