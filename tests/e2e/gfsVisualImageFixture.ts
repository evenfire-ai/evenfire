/**
 * Deterministic visual fixture for the issue651 GFS E2E journey.
 *
 * Every variant is an opaque white 256x160 PNG holding exactly two flat,
 * unlabelled shapes: one entirely inside the left half and one entirely inside
 * the right half, separated by a white band. `variant` chooses the color and
 * the silhouette of both sides. The ground truth is returned in `expected`; it
 * is never written into the image, its chunks, or any metadata, so a reader has
 * to interpret the pixels to answer.
 *
 * The image carries only IHDR, IDAT and IEND. Callers own the file name, so no
 * name, seed, or answer ever reaches the bytes handed to a model.
 */
import { randomInt } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const WIDTH = 256
const HEIGHT = 160

// Each shape is painted inside a (2 * SHAPE_HALF + 1) box: 77x77 for a half of
// 38. All three silhouettes fill the same box, so the two sides always match in
// size and differ only in color and outline.
const SHAPE_HALF = 38
const LEFT_CENTER_X = 64
const RIGHT_CENTER_X = 192
const CENTER_Y = 80

const RGBA_CHANNELS = 4
const OPAQUE = 0xff

const COLORS = [
  { name: 'red', rgb: [255, 0, 0] },
  { name: 'green', rgb: [0, 166, 81] },
  { name: 'blue', rgb: [0, 87, 255] },
  { name: 'yellow', rgb: [255, 212, 0] },
  { name: 'orange', rgb: [255, 122, 0] },
  { name: 'purple', rgb: [138, 0, 224] },
] as const

const SHAPES = ['circle', 'square', 'triangle'] as const

export type GfsVisualImageColor = (typeof COLORS)[number]['name']
export type GfsVisualImageShape = (typeof SHAPES)[number]

export interface GfsVisualImageExpectation {
  color: GfsVisualImageColor
  shape: GfsVisualImageShape
}

export interface GfsVisualImageFixture {
  bytes: Buffer
  width: number
  height: number
  expected: { left: GfsVisualImageExpectation; right: GfsVisualImageExpectation }
}

// 6 colors x 3 shapes for the left side, then 5 remaining colors x 2 remaining
// shapes for the right side, so every variant has two colors and two shapes.
const RIGHT_COMBINATIONS = (COLORS.length - 1) * (SHAPES.length - 1)
const VARIANT_COUNT = COLORS.length * SHAPES.length * RIGHT_COMBINATIONS

export function createGfsVisualImageFixture(
  variant: number = randomInt(VARIANT_COUNT)
): GfsVisualImageFixture {
  if (!Number.isInteger(variant) || variant < 0 || variant >= VARIANT_COUNT) {
    throw new RangeError(
      `gfs visual image fixture variant must be an integer in [0, ${VARIANT_COUNT - 1}], received ${String(variant)}`
    )
  }

  const leftCombination = Math.floor(variant / RIGHT_COMBINATIONS)
  const rightCombination = variant % RIGHT_COMBINATIONS
  const leftColorIndex = Math.floor(leftCombination / SHAPES.length)
  const leftShapeIndex = leftCombination % SHAPES.length
  const rightColorIndex =
    (leftColorIndex + 1 + Math.floor(rightCombination / (SHAPES.length - 1))) % COLORS.length
  const rightShapeIndex =
    (leftShapeIndex + 1 + (rightCombination % (SHAPES.length - 1))) % SHAPES.length

  const leftColor = COLORS[leftColorIndex]
  const leftShape = SHAPES[leftShapeIndex]
  const rightColor = COLORS[rightColorIndex]
  const rightShape = SHAPES[rightShapeIndex]

  // Opaque white canvas: every byte at 0xff is RGBA (255, 255, 255, 255).
  const pixels = Buffer.alloc(WIDTH * HEIGHT * RGBA_CHANNELS, OPAQUE)
  paintShape(pixels, LEFT_CENTER_X, leftShape, leftColor.rgb)
  paintShape(pixels, RIGHT_CENTER_X, rightShape, rightColor.rgb)

  return {
    bytes: encodePng(pixels),
    width: WIDTH,
    height: HEIGHT,
    expected: {
      left: { color: leftColor.name, shape: leftShape },
      right: { color: rightColor.name, shape: rightShape },
    },
  }
}

function paintShape(
  pixels: Buffer,
  centerX: number,
  shape: GfsVisualImageShape,
  rgb: readonly number[]
): void {
  for (let y = CENTER_Y - SHAPE_HALF; y <= CENTER_Y + SHAPE_HALF; y++) {
    for (let x = centerX - SHAPE_HALF; x <= centerX + SHAPE_HALF; x++) {
      if (!coversPixel(shape, x - centerX, y - CENTER_Y)) continue
      const offset = (y * WIDTH + x) * RGBA_CHANNELS
      pixels[offset] = rgb[0]
      pixels[offset + 1] = rgb[1]
      pixels[offset + 2] = rgb[2]
      pixels[offset + 3] = OPAQUE
    }
  }
}

function coversPixel(shape: GfsVisualImageShape, dx: number, dy: number): boolean {
  switch (shape) {
    case 'circle':
      return dx * dx + dy * dy <= SHAPE_HALF * SHAPE_HALF
    case 'square':
      return Math.abs(dx) <= SHAPE_HALF && Math.abs(dy) <= SHAPE_HALF
    case 'triangle': {
      // Apex at the top-centre of the box, base on the bottom edge.
      const progress = (dy + SHAPE_HALF) / (2 * SHAPE_HALF)
      return progress >= 0 && progress <= 1 && Math.abs(dx) <= progress * SHAPE_HALF
    }
  }
}

function encodePng(pixels: Buffer): Buffer {
  const stride = 1 + WIDTH * RGBA_CHANNELS
  // Buffer.alloc zero-fills, so each row already starts with filter type 0.
  const raster = Buffer.alloc(HEIGHT * stride)
  for (let y = 0; y < HEIGHT; y++) {
    pixels.copy(raster, y * stride + 1, y * WIDTH * RGBA_CHANNELS, (y + 1) * WIDTH * RGBA_CHANNELS)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', imageHeader()),
    pngChunk('IDAT', deflateSync(raster)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function imageHeader(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(WIDTH, 0)
  header.writeUInt32BE(HEIGHT, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // color type: truecolor with alpha
  header[10] = 0 // compression: deflate
  header[11] = 0 // filter method: adaptive
  header[12] = 0 // interlace: none
  return header
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'latin1')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
  return chunk
}
