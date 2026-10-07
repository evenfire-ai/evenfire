import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  decodeTileChallenge,
  requirePixelRenderer,
  tileChallengeImage,
} from './e2e-playwright/subscriptionImageChallenge.js'

const native = createRequire(new URL('../../mcp-host/package.json', import.meta.url))(
  '@napi-rs/canvas'
)

describe('subscription fixture pixel oracle', () => {
  it.each(['png', 'jpeg'] as const)(
    'decodes the received %s pixels without an answer registry',
    async format => {
      requirePixelRenderer()
      const image = tileChallengeImage(format, { requirePixels: true })
      expect(image.code).toMatch(/^[0-9A-F]{16}$/)
      expect(image.bytes.includes(Buffer.from(image.code))).toBe(false)
      expect(await decodeTileChallenge(image.bytes)).toBe(image.code)
      const other = tileChallengeImage(format, { requirePixels: true })
      expect(other.code).not.toBe(image.code)
      expect(await decodeTileChallenge(other.bytes)).toBe(other.code)
    }
  )

  it('fails the original answer after changing an actual tile', async () => {
    const image = tileChallengeImage('png', { requirePixels: true })
    const canvas = native.createCanvas(512, 512)
    const context = canvas.getContext('2d')
    context.drawImage(await native.loadImage(image.bytes), 0, 0)
    const digit = image.code[0] === '0' ? '1' : '0'
    context.fillStyle = digit === '0' ? 'rgb(32,32,80)' : 'rgb(32,96,80)'
    context.fillRect(64, 64, 96, 96)
    const decoded = await decodeTileChallenge(canvas.toBuffer('image/png'))
    expect(decoded).toBe(digit + image.code.slice(1))
    expect(decoded).not.toBe(image.code)
  })

  it('rejects undecodable data and a real image without a challenge', async () => {
    await expect(decodeTileChallenge(Buffer.from([1, 2, 3]))).rejects.toThrow(/image|decode/i)
    const canvas = native.createCanvas(512, 512)
    const context = canvas.getContext('2d')
    context.fillStyle = 'white'
    context.fillRect(0, 0, 512, 512)
    await expect(decodeTileChallenge(canvas.toBuffer('image/png'))).rejects.toThrow(
      /marker|challenge/i
    )
  })

  it('makes removal and reordering observably different from the original visual result', async () => {
    const images = [
      tileChallengeImage('png', { requirePixels: true }),
      tileChallengeImage('jpeg', { requirePixels: true }),
    ]
    const expected = images.map(image => image.code).join('\n')
    expect(
      (
        await Promise.all([...images].reverse().map(image => decodeTileChallenge(image.bytes)))
      ).join('\n')
    ).not.toBe(expected)
    expect(await decodeTileChallenge(images[0]!.bytes)).not.toBe(expected)
  })
})
