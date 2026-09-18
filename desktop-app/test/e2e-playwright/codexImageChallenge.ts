import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.resolve(__dirname, '../../../mcp-host/package.json'))
const fixtures = createRequire(__filename)(
  '../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  padJpegToSize: (jpeg: Buffer | string, targetBytes: number) => Buffer
  padPngToSize: (png: Buffer | string, targetBytes: number) => Buffer
}

/** A neutral image with an answer absent from the filename and user prompt. */
export function challengeImageAt(
  format: 'png' | 'jpeg',
  width: number,
  height: number
): { code: string; bytes: Buffer; width: number; height: number } {
  // Reuse the Host renderer installed for T0; do not add another dependency.
  const { createCanvas } = require('@napi-rs/canvas')
  const code = randomBytes(8).toString('hex').toUpperCase()
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

export function challengeImage(format: 'png' | 'jpeg'): { code: string; bytes: Buffer } {
  const image = challengeImageAt(format, 800, 120)
  return { code: image.code, bytes: image.bytes }
}

/** Same pixel challenge, grown to an exact decoded size the contract still accepts. */
export function paddedChallengeImage(
  format: 'png' | 'jpeg',
  targetBytes: number
): { code: string; bytes: Buffer } {
  const image = challengeImage(format)
  const bytes =
    format === 'png'
      ? fixtures.padPngToSize(image.bytes, targetBytes)
      : fixtures.padJpegToSize(image.bytes, targetBytes)
  return { code: image.code, bytes }
}
