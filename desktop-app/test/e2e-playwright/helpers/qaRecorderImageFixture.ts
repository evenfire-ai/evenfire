// desktop-app/test/e2e-playwright/helpers/qaRecorderImageFixture.ts
//
// E2E_GUARDIAN_IPC_FLOW: fixture-only module. It renders deterministic PNG bytes
// and matchers for the caller; it never drives the Electron app, so it has no
// route or network transition to await. The journey in
// qa-recorder-image-capabilities.spec.ts owns the IPC-flow oracle.
//
// Real PNG fixture for the Desktop image-capability recorder journey.
//
// The journey needs an image whose content the test knows exactly and the model
// can only learn by reading the pixels. Nothing in the prompt or the filename
// discloses the colors: the assertion is the ordered tile sequence, so a run
// that never delivered the image cannot pass by guessing.
//
// The encoder is deliberately dependency-free (node:zlib + a local CRC32) so the
// fixture cannot drift with a third-party image library, and the bytes are a
// standards-compliant PNG that any viewer can open.
import { crc32, deflateSync } from 'node:zlib'

/** Twelve visually distinct, unambiguous, named colors. */
export const IMAGE_FIXTURE_PALETTE = [
  'red',
  'blue',
  'green',
  'yellow',
  'orange',
  'purple',
  'magenta',
  'cyan',
  'brown',
  'pink',
  'gray',
  'lime',
] as const

type Rgb = readonly [number, number, number]

/** Exact RGB values used to paint each named color. */
export const IMAGE_FIXTURE_RGB: Record<(typeof IMAGE_FIXTURE_PALETTE)[number], Rgb> = {
  red: [220, 30, 30],
  blue: [30, 70, 220],
  green: [30, 170, 60],
  yellow: [245, 220, 25],
  orange: [250, 140, 20],
  purple: [135, 60, 200],
  magenta: [230, 40, 190],
  cyan: [30, 205, 220],
  brown: [125, 80, 45],
  pink: [250, 160, 200],
  gray: [135, 135, 135],
  lime: [175, 235, 35],
}

export const IMAGE_FIXTURE_COLUMNS = 2
export const IMAGE_FIXTURE_ROWS = 3
/** Tile dimensions chosen so each color block dominates its cell. */
export const IMAGE_FIXTURE_TILE_WIDTH = 320
export const IMAGE_FIXTURE_TILE_HEIGHT = 240

export interface ImageFixture {
  /** Standards-compliant PNG bytes for the two-by-three tile grid. */
  png: Buffer
  /**
   * The tile colors in reading order (left to right, top to bottom). This is the
   * ordered sequence the model must report back; it is never sent to the model.
   */
  orderedColors: string[]
  /** Opaque file name that does not encode the colors. */
  fileName: string
}

/** Deterministic PRNG so a failing run can be reproduced from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

export function encodePng(
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => Rgb
): Buffer {
  const bytesPerRow = width * 3
  // One filter byte (0 = None) per scanline, then the RGB triples.
  const raw = Buffer.alloc((bytesPerRow + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (bytesPerRow + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y)
      const offset = rowStart + 1 + x * 3
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Builds the ordered tile grid. Pass an explicit seed to reproduce a run; the
 * default seed is random so the sequence cannot be memorized between runs.
 */
export function buildImageFixture(seed?: number): ImageFixture {
  const resolvedSeed = seed ?? Math.floor(Math.random() * 0xffffffff)
  const random = mulberry32(resolvedSeed)

  const pool = [...IMAGE_FIXTURE_PALETTE]
  const orderedColors: string[] = []
  const tileCount = IMAGE_FIXTURE_COLUMNS * IMAGE_FIXTURE_ROWS
  for (let index = 0; index < tileCount; index += 1) {
    const pick = Math.floor(random() * pool.length)
    orderedColors.push(pool.splice(pick, 1)[0]!)
  }

  const width = IMAGE_FIXTURE_COLUMNS * IMAGE_FIXTURE_TILE_WIDTH
  const height = IMAGE_FIXTURE_ROWS * IMAGE_FIXTURE_TILE_HEIGHT
  const png = encodePng(width, height, (x, y) => {
    const column = Math.floor(x / IMAGE_FIXTURE_TILE_WIDTH)
    const row = Math.floor(y / IMAGE_FIXTURE_TILE_HEIGHT)
    const color = orderedColors[row * IMAGE_FIXTURE_COLUMNS + column]!
    return IMAGE_FIXTURE_RGB[color as keyof typeof IMAGE_FIXTURE_RGB]
  })

  return {
    png,
    orderedColors,
    fileName: 'visual-input.png',
  }
}

/**
 * Case-insensitive matcher for the model's report. Tolerates a chatty sentence
 * around the list while still requiring the exact ordered sequence.
 */
export function orderedColorListRegex(orderedColors: string[]): RegExp {
  const escaped = orderedColors.map(color => color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b${escaped.join('\\s*,\\s*')}\\b`, 'i')
}
