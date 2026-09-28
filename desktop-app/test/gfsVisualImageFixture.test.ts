/**
 * Unit tests for the issue651 visual fixture. They decode the produced PNG the
 * way a reader would (signature, chunk framing, CRCs, inflate, filter-0 rows)
 * and check what is actually painted, instead of recomputing the fixture's own
 * variant arithmetic.
 *
 * Included in Desktop's ordinary unit lane (Node 24):
 *   npm test -- test/gfsVisualImageFixture.test.ts
 */
import { it as test } from 'vitest'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import {
  type GfsVisualImageFixture,
  createGfsVisualImageFixture,
} from '../../tests/e2e/gfsVisualImageFixture'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// 6 colors x 3 shapes on the left, then 5 remaining colors x 2 remaining shapes.
const VARIANT_COUNT = 6 * 3 * 5 * 2
const WIDTH = 256
const HEIGHT = 160

// The oracle: the palette the returned `expected.color` labels refer to. It is
// stated here, independently of the fixture, so a wrong RGB value in the
// implementation cannot silently agree with the test.
const PALETTE: Readonly<Record<string, readonly [number, number, number]>> = {
  red: [255, 0, 0],
  green: [0, 166, 81],
  blue: [0, 87, 255],
  yellow: [255, 212, 0],
  orange: [255, 122, 0],
  purple: [138, 0, 224],
}
const BACKGROUND: readonly [number, number, number] = [255, 255, 255]
const SHAPES: readonly string[] = ['circle', 'square', 'triangle']

interface PngChunk {
  type: string
  data: Buffer
}

interface DecodedImage {
  width: number
  height: number
  pixels: Buffer
}

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  count: number
}

// Table-driven CRC-32 (polynomial 0xedb88320), written independently of the
// fixture's zlib.crc32 call.
const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC_TABLE[index] = value >>> 0
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

function readChunks(png: Buffer): PngChunk[] {
  assert.ok(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), 'PNG signature')
  const chunks: PngChunk[] = []
  let offset = PNG_SIGNATURE.length
  while (offset < png.length) {
    assert.ok(offset + 12 <= png.length, 'chunk header fits inside the file')
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    assert.ok(offset + 12 + length <= png.length, `payload of ${type} fits inside the file`)
    chunks.push({
      type,
      data: png.subarray(offset + 8, offset + 8 + length),
    })
    assert.equal(
      crc32(png.subarray(offset + 4, offset + 8 + length)),
      png.readUInt32BE(offset + 8 + length),
      `CRC of ${type}`
    )
    offset += 12 + length
  }
  assert.equal(offset, png.length, 'no bytes follow the last chunk')
  return chunks
}

function decodeFixture(fixture: GfsVisualImageFixture): DecodedImage {
  const chunks = readChunks(fixture.bytes)
  assert.deepEqual(
    chunks.map(chunk => chunk.type),
    ['IHDR', 'IDAT', 'IEND'],
    'chunk sequence'
  )
  for (const chunk of chunks) {
    assert.match(
      chunk.type,
      /^[A-Z]{4}$/,
      `chunk ${chunk.type} is critical, so no text or ancillary metadata chunk is present`
    )
  }

  const header = chunks[0].data
  assert.equal(header.length, 13, 'IHDR length')
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  assert.equal(width, fixture.width, 'IHDR width matches the reported width')
  assert.equal(height, fixture.height, 'IHDR height matches the reported height')
  assert.deepEqual(
    [header[8], header[9], header[10], header[11], header[12]],
    [8, 6, 0, 0, 0],
    'IHDR bit depth 8, truecolor with alpha, deflate, adaptive filtering, no interlace'
  )
  assert.equal(chunks[2].data.length, 0, 'IEND carries no payload')

  const stride = 1 + width * 4
  const raster = inflateSync(
    Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data))
  )
  assert.equal(raster.length, height * stride, 'inflated raster size')

  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    assert.equal(raster[y * stride], 0, `row ${y} uses filter type 0`)
    raster.copy(pixels, y * width * 4, y * stride + 1, y * stride + stride)
  }
  return { width, height, pixels }
}

function pixelAt(image: DecodedImage, x: number, y: number): readonly number[] {
  const offset = (y * image.width + x) * 4
  return image.pixels.subarray(offset, offset + 4)
}

function isColor(pixel: readonly number[], rgb: readonly number[]): boolean {
  return pixel[0] === rgb[0] && pixel[1] === rgb[1] && pixel[2] === rgb[2]
}

function colorBounds(image: DecodedImage, rgb: readonly number[]): Bounds {
  const bounds: Bounds = {
    minX: image.width,
    maxX: -1,
    minY: image.height,
    maxY: -1,
    count: 0,
  }
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4
      if (
        image.pixels[offset] !== rgb[0] ||
        image.pixels[offset + 1] !== rgb[1] ||
        image.pixels[offset + 2] !== rgb[2]
      ) {
        continue
      }
      bounds.count += 1
      bounds.minX = Math.min(bounds.minX, x)
      bounds.maxX = Math.max(bounds.maxX, x)
      bounds.minY = Math.min(bounds.minY, y)
      bounds.maxY = Math.max(bounds.maxY, y)
    }
  }
  return bounds
}

/**
 * Reads the silhouette out of the pixels alone. All three shapes fill the same
 * square bounding box, so the corners of that box are what separate them: only
 * a square reaches the top-left corner, and only a square or triangle reaches
 * the bottom-right one.
 */
function identifyShape(image: DecodedImage, bounds: Bounds, rgb: readonly number[]): string {
  const centreX = bounds.minX + (bounds.maxX - bounds.minX) / 2
  const centreY = bounds.minY + (bounds.maxY - bounds.minY) / 2
  assert.ok(
    isColor(pixelAt(image, centreX, centreY), rgb),
    'the silhouette covers the centre of its bounding box'
  )
  const topLeft = isColor(pixelAt(image, bounds.minX + 5, bounds.minY + 5), rgb)
  const bottomRight = isColor(pixelAt(image, bounds.maxX - 7, bounds.maxY - 5), rgb)
  if (topLeft) {
    assert.ok(bottomRight, 'a square silhouette fills its whole bounding box')
    return 'square'
  }
  return bottomRight ? 'triangle' : 'circle'
}

function validateFixture(fixture: GfsVisualImageFixture): void {
  const image = decodeFixture(fixture)
  const left = PALETTE[fixture.expected.left.color]
  const right = PALETTE[fixture.expected.right.color]
  assert.ok(left, `left color ${fixture.expected.left.color} is a documented palette color`)
  assert.ok(right, `right color ${fixture.expected.right.color} is a documented palette color`)
  assert.ok(SHAPES.includes(fixture.expected.left.shape), 'left shape is documented')
  assert.ok(SHAPES.includes(fixture.expected.right.shape), 'right shape is documented')
  assert.notDeepEqual(left, right, 'the two sides use different colors')

  let background = 0
  let leftPixels = 0
  let rightPixels = 0
  const stray = new Set<string>()
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4
      const alpha = image.pixels[offset + 3]
      if (alpha !== 255) {
        stray.add(`alpha ${alpha} at ${x},${y}`)
        continue
      }
      const pixel = image.pixels.subarray(offset, offset + 4)
      if (isColor(pixel, BACKGROUND)) {
        background += 1
      } else if (isColor(pixel, left)) {
        leftPixels += 1
      } else if (isColor(pixel, right)) {
        rightPixels += 1
      } else {
        stray.add(`rgb ${pixel[0]},${pixel[1]},${pixel[2]} at ${x},${y}`)
      }
    }
  }
  assert.equal(stray.size, 0, `unexpected pixels: ${[...stray].slice(0, 5).join('; ')}`)
  assert.ok(background > image.width * image.height * 0.7, 'the white background dominates')
  assert.ok(leftPixels > 1000, 'the left silhouette is visible')
  assert.ok(rightPixels > 1000, 'the right silhouette is visible')

  const leftBounds = colorBounds(image, left)
  const rightBounds = colorBounds(image, right)
  assert.equal(leftBounds.count, leftPixels, 'left silhouette pixel count')
  assert.equal(rightBounds.count, rightPixels, 'right silhouette pixel count')
  for (const [side, bounds] of [
    ['left', leftBounds],
    ['right', rightBounds],
  ] as const) {
    const spanX = bounds.maxX - bounds.minX
    const spanY = bounds.maxY - bounds.minY
    assert.equal(spanX, spanY, `${side} silhouette bounding box is square`)
    assert.equal(spanX % 2, 0, `${side} silhouette bounding box is centred on one pixel`)
    assert.ok(spanX >= 39 && spanX <= 99, `${side} silhouette is clearly visible (span ${spanX})`)
    assert.ok(
      bounds.minX >= 5 &&
        bounds.minY >= 5 &&
        bounds.maxX <= image.width - 6 &&
        bounds.maxY <= image.height - 6,
      `${side} silhouette keeps a margin from the canvas edge`
    )
  }
  assert.ok(leftBounds.maxX < image.width / 2, 'the left silhouette stays in the left half')
  assert.ok(rightBounds.minX >= image.width / 2, 'the right silhouette stays in the right half')
  assert.ok(rightBounds.minX - leftBounds.maxX >= 21, 'a white band separates the two silhouettes')

  assert.equal(
    identifyShape(image, leftBounds, left),
    fixture.expected.left.shape,
    'left silhouette matches the expected shape'
  )
  assert.equal(
    identifyShape(image, rightBounds, right),
    fixture.expected.right.shape,
    'right silhouette matches the expected shape'
  )
}

test('frames the image with IHDR, IDAT and IEND chunks whose CRCs match', () => {
  const fixture = createGfsVisualImageFixture(0)
  const chunks = readChunks(fixture.bytes)
  assert.deepEqual(
    chunks.map(chunk => chunk.type),
    ['IHDR', 'IDAT', 'IEND']
  )
  assert.equal(chunks[2].data.length, 0, 'IEND carries no payload')
})

test('declares a 256x160 8-bit RGBA image that inflates to filter-0 rows', () => {
  const image = decodeFixture(createGfsVisualImageFixture(179))
  assert.equal(image.width, WIDTH)
  assert.equal(image.height, HEIGHT)
  assert.equal(image.pixels.length, WIDTH * HEIGHT * 4)
})

test('carries no textual or ancillary metadata chunk in any variant', () => {
  for (let variant = 0; variant < VARIANT_COUNT; variant++) {
    const chunks = readChunks(createGfsVisualImageFixture(variant).bytes)
    assert.deepEqual(
      chunks.map(chunk => chunk.type),
      ['IHDR', 'IDAT', 'IEND'],
      `variant ${variant} chunk sequence`
    )
  }
})

test('is deterministic for an explicit variant', () => {
  const first = createGfsVisualImageFixture(97)
  const second = createGfsVisualImageFixture(97)
  assert.ok(Buffer.isBuffer(first.bytes), 'bytes is a Buffer')
  assert.deepEqual(
    Object.keys(first).sort(),
    ['bytes', 'expected', 'height', 'width'],
    'the fixture exposes only bytes, width, height and expected'
  )
  assert.deepEqual(
    Object.keys(first.expected).sort(),
    ['left', 'right'],
    'expected carries the left and right labels only'
  )
  for (const side of ['left', 'right'] as const) {
    assert.deepEqual(
      Object.keys(first.expected[side]).sort(),
      ['color', 'shape'],
      `${side} expectation carries a color and a shape only`
    )
  }
  assert.deepEqual(first.expected, second.expected)
  assert.ok(first.bytes.equals(second.bytes), 'the same variant renders the same bytes')
  assert.equal(first.width, WIDTH)
  assert.equal(first.height, HEIGHT)
  assert.ok(
    !first.bytes.equals(createGfsVisualImageFixture(98).bytes),
    'a different variant renders different bytes'
  )
})

test('paints the expected color and silhouette on each side for every variant', () => {
  for (let variant = 0; variant < VARIANT_COUNT; variant++) {
    const fixture = createGfsVisualImageFixture(variant)
    try {
      validateFixture(fixture)
    } catch (error) {
      throw new Error(`variant ${variant} failed: ${(error as Error).message}`, { cause: error })
    }
  }
})

test('produces 180 distinct variants with different left and right color and shape', () => {
  const digests = new Set<string>()
  const combinations = new Set<string>()
  const leftColors = new Set<string>()
  const rightColors = new Set<string>()
  const leftShapes = new Set<string>()
  const rightShapes = new Set<string>()

  for (let variant = 0; variant < VARIANT_COUNT; variant++) {
    const { expected, bytes } = createGfsVisualImageFixture(variant)
    assert.notEqual(expected.left.color, expected.right.color, `variant ${variant} colors differ`)
    assert.notEqual(expected.left.shape, expected.right.shape, `variant ${variant} shapes differ`)
    digests.add(createHash('sha256').update(bytes).digest('hex'))
    combinations.add(
      `${expected.left.color}/${expected.left.shape}|${expected.right.color}/${expected.right.shape}`
    )
    leftColors.add(expected.left.color)
    rightColors.add(expected.right.color)
    leftShapes.add(expected.left.shape)
    rightShapes.add(expected.right.shape)
  }

  assert.equal(digests.size, VARIANT_COUNT, 'every variant renders unique bytes')
  assert.equal(combinations.size, VARIANT_COUNT, 'every variant has a unique label pair')
  assert.equal(leftColors.size, 6, 'all six colors can appear on the left')
  assert.equal(rightColors.size, 6, 'all six colors can appear on the right')
  assert.equal(leftShapes.size, 3, 'all three shapes can appear on the left')
  assert.equal(rightShapes.size, 3, 'all three shapes can appear on the right')
})

test('draws a random in-range variant by default', () => {
  const seen = new Set<string>()
  for (let attempt = 0; attempt < 40; attempt++) {
    const fixture = createGfsVisualImageFixture()
    validateFixture(fixture)
    seen.add(`${fixture.expected.left.shape}|${fixture.expected.right.shape}`)
  }
  assert.ok(seen.size > 1, 'the default variant is drawn at random from the variant space')
})

test('rejects an out-of-range or non-integer variant', () => {
  for (const variant of [
    -1,
    VARIANT_COUNT,
    VARIANT_COUNT + 1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.throws(() => createGfsVisualImageFixture(variant), RangeError, `variant ${variant}`)
  }
  assert.throws(
    () => createGfsVisualImageFixture('red' as unknown as number),
    RangeError,
    'a non-numeric variant'
  )
  assert.throws(
    () => createGfsVisualImageFixture(null as unknown as number),
    RangeError,
    'a null variant'
  )
})
