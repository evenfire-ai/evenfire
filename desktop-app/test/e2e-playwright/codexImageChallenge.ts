// E2E_GUARDIAN_IPC_FLOW: test-only generation/collection for Electron IPC journeys; no renderer HTTP transition.
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'

const hostRequire = createRequire(path.resolve(__dirname, '../../../mcp-host/package.json'))
const fixtures = createRequire(__filename)(
  '../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  declaredHeaderPng: (width: number, height: number) => Buffer
  jpegOfSize: (targetBytes: number, width?: number, height?: number) => Buffer
  padJpegToSize: (jpeg: Buffer | string, targetBytes: number) => Buffer
  padPngToSize: (png: Buffer | string, targetBytes: number) => Buffer
}

function loadHostCreateCanvas():
  | ((
      width: number,
      height: number
    ) => {
      getContext: (type: '2d') => {
        fillStyle: string
        fillRect: (x: number, y: number, width: number, height: number) => void
        font: string
        textBaseline: string
        fillText: (text: string, x: number, y: number) => void
      }
      toBuffer: (mime: 'image/png' | 'image/jpeg') => Buffer
    })
  | null {
  try {
    return hostRequire('@napi-rs/canvas').createCanvas
  } catch {
    return null
  }
}

export type PixelRenderingOptions = { requirePixels?: boolean }

/** A neutral image with an answer absent from the filename and user prompt. */
export function challengeImageAt(
  format: 'png' | 'jpeg',
  width: number,
  height: number,
  options: PixelRenderingOptions = {}
): { code: string; bytes: Buffer; width: number; height: number } {
  const code = randomBytes(8).toString('hex').toUpperCase()
  // Non-strict containers exist only for geometry/size unit fixtures when
  // Desktop CI lacks the Host native addon. Every visual journey opts into
  // requirePixels; an unrendered declared header cannot prove image perception.
  const createCanvas = loadHostCreateCanvas()
  if (!createCanvas) {
    if (options.requirePixels || process.env.E2E_CODEX_IMAGE_INPUT === '1') {
      throw new Error('Image challenge requires native mcp-host/@napi-rs/canvas pixels')
    }
    const bytes =
      format === 'png'
        ? fixtures.declaredHeaderPng(width, height)
        : fixtures.jpegOfSize(256, width, height)
    return { code, bytes, width, height }
  }
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, width, height)
  context.fillStyle = 'black'
  const fontSize = Math.max(24, Math.min(Math.floor(height * 0.4), Math.floor(width / 12)))
  context.font = `${fontSize}px monospace`
  context.textBaseline = 'middle'
  context.fillText(code, Math.max(16, Math.floor(width * 0.04)), Math.floor(height / 2))
  return {
    code,
    bytes: format === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg'),
    width,
    height,
  }
}

export function challengeImage(
  format: 'png' | 'jpeg',
  options: PixelRenderingOptions = {}
): { code: string; bytes: Buffer } {
  const image = challengeImageAt(format, 800, 120, options)
  return { code: image.code, bytes: image.bytes }
}

/** Same pixel challenge, grown to an exact decoded size the contract still accepts. */
export function paddedChallengeImage(
  format: 'png' | 'jpeg',
  targetBytes: number,
  options: PixelRenderingOptions = {}
): { code: string; bytes: Buffer } {
  const image = challengeImage(format, options)
  const bytes =
    format === 'png'
      ? fixtures.padPngToSize(image.bytes, targetBytes)
      : fixtures.padJpegToSize(image.bytes, targetBytes)
  return { code: image.code, bytes }
}
