import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import {
  challengeImage,
  challengeImageAt,
  paddedChallengeImage,
} from './e2e-playwright/codexImageChallenge.js'

const renderer = vi.hoisted(() => ({ unavailable: false }))
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (filename: string | URL) => {
      const require = actual.createRequire(filename)
      return (id: string) => {
        if (id === '@napi-rs/canvas' && renderer.unavailable)
          throw new Error('native renderer absent')
        return require(id)
      }
    },
  }
})

afterEach(() => {
  renderer.unavailable = false
  vi.unstubAllEnvs()
})

const MIB = 1024 * 1024
const { inspectVisualImage } = createRequire(import.meta.url)(
  '../../packages/llm-provider-attempt-contract/visualPayload.cjs'
) as {
  inspectVisualImage: (input: { mimeType: string; data: string }) => {
    ok: boolean
    message?: string
  }
}

describe('Codex image challenge fixtures', () => {
  it('keeps the answer out of the small PNG/JPEG containers', () => {
    for (const format of ['png', 'jpeg'] as const) {
      const image = challengeImage(format)
      expect(image.code).toMatch(/^[0-9A-F]{16}$/)
      expect(image.bytes.includes(Buffer.from(image.code))).toBe(false)
      expect(
        inspectVisualImage({
          mimeType: `image/${format}`,
          data: image.bytes.toString('base64'),
        }).ok
      ).toBe(true)
    }
  })

  it('keeps a 2048 px JPEG inside the hop pixel bound', () => {
    const image = challengeImageAt('jpeg', 2048, 256)
    expect(image.width).toBe(2048)
    expect(image.height).toBe(256)
    expect(image.bytes.includes(Buffer.from(image.code))).toBe(false)
    const inspected = inspectVisualImage({
      mimeType: 'image/jpeg',
      data: image.bytes.toString('base64'),
    })
    expect(inspected.ok, inspected.message).toBe(true)
  })

  it('keeps a 2048 by 2048 JPEG at the pixel ceiling', () => {
    const image = challengeImageAt('jpeg', 2048, 2048)
    const inspected = inspectVisualImage({
      mimeType: 'image/jpeg',
      data: image.bytes.toString('base64'),
    })
    expect(inspected.ok, inspected.message).toBe(true)
  })

  it('builds a 2049 px PNG the hop must refuse', () => {
    const image = challengeImageAt('png', 2049, 128)
    const inspected = inspectVisualImage({
      mimeType: 'image/png',
      data: image.bytes.toString('base64'),
    })
    expect(inspected.ok).toBe(false)
    expect(inspected.message).toMatch(/dimension/)
  })

  it('pads a 5 MiB JPEG without putting the answer in the file bytes as text', () => {
    const image = paddedChallengeImage('jpeg', 5 * MIB)
    expect(image.bytes).toHaveLength(5 * MIB)
    expect(image.bytes.includes(Buffer.from(image.code))).toBe(false)
    const inspected = inspectVisualImage({
      mimeType: 'image/jpeg',
      data: image.bytes.toString('base64'),
    })
    expect(inspected.ok, inspected.message).toBe(true)
  })
})

describe('strict pixel rendering admission', () => {
  it.each(['png', 'jpeg'] as const)(
    'refuses missing native %s pixels independently of Codex opt-in',
    format => {
      renderer.unavailable = true
      vi.stubEnv('E2E_CODEX_IMAGE_INPUT', undefined)
      expect(() => challengeImage(format, { requirePixels: true })).toThrow(/native.*pixels/i)
      expect(() => challengeImageAt(format, 800, 120, { requirePixels: true })).toThrow(
        /native.*pixels/i
      )
      expect(() => paddedChallengeImage(format, MIB, { requirePixels: true })).toThrow(
        /native.*pixels/i
      )
    }
  )

  it('preserves the explicitly non-strict container-only geometry fixture', () => {
    renderer.unavailable = true
    vi.stubEnv('E2E_CODEX_IMAGE_INPUT', undefined)
    const image = challengeImageAt('png', 2049, 128)
    expect(
      inspectVisualImage({ mimeType: 'image/png', data: image.bytes.toString('base64') }).ok
    ).toBe(false)
  })
})

describe('strict native image content', () => {
  it.each(['png', 'jpeg'] as const)('contains painted pixels in strict %s output', async format => {
    const native = createRequire(new URL('../../mcp-host/package.json', import.meta.url))(
      '@napi-rs/canvas'
    )
    const image = challengeImage(format, { requirePixels: true })
    const decoded = await native.loadImage(image.bytes)
    const canvas = native.createCanvas(800, 120),
      context = canvas.getContext('2d')
    context.drawImage(decoded, 0, 0)
    const rgba = context.getImageData(0, 0, 800, 120).data
    let darkPixels = 0
    for (let offset = 0; offset < rgba.length; offset += 4) {
      if (rgba[offset] < 100 && rgba[offset + 1] < 100 && rgba[offset + 2] < 100) darkPixels++
    }
    expect(darkPixels).toBeGreaterThan(1000)
    expect(decoded.width).toBe(800)
    expect(decoded.height).toBe(120)
  })
})
