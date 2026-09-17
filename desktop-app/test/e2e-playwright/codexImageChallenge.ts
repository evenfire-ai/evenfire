import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'

/** A neutral image with an answer absent from the filename and user prompt. */
export function challengeImage(format: 'png' | 'jpeg'): { code: string; bytes: Buffer } {
  // Reuse the Host renderer installed for T0; do not add another dependency.
  const { createCanvas } = createRequire(path.resolve(__dirname, '../../../mcp-host/package.json'))(
    '@napi-rs/canvas'
  )
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
