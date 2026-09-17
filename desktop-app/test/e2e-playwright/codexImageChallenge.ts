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
export function challengeImage(format: 'png' | 'jpeg'): { code: string; bytes: Buffer } {
  // Reuse the Host renderer installed for T0; do not add another dependency.
  const { createCanvas } = require('@napi-rs/canvas')
  const code = randomBytes(8).toString('hex').toUpperCase()
  const canvas = createCanvas(800, 120)
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, 800, 120)
  context.fillStyle = 'black'
  context.font = '48px monospace'
  context.fillText(code, 24, 78)
  return {
    code,
    bytes: format === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg'),
  }
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
