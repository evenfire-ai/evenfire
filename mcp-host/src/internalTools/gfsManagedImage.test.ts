import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { JPEG_2X2_BASE64, PNG_2X2_BASE64 } from '../llm/__tests__/codexImageFixtures'
import { resolveVisualDeliveryLimits } from '../visualInput/deliveryLimits'
import { VisualInputBudget } from '../visualInput/policy'
import { type GfscReadClient, buildGfsReadTools } from './gfs'
import { type GfsDownloadStore, GfsDownloadStoreError } from './gfsDownloadStore'

const MIB = 1024 * 1024
const target = { drive: 'main', resourceId: 'a'.repeat(32) }
const source = {
  kind: 'gfs' as const,
  ...target,
  version: 7,
  gfsUri: `gfs://main/${target.resourceId}`,
  name: 'image-without-extension',
}
const { realPngOfSize, padJpegToSize } = createRequire(join(__dirname, 'gfsManagedImage.test.ts'))(
  '../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  realPngOfSize: (size: number, width: number, height: number, seed: number) => Buffer
  padJpegToSize: (bytes: Buffer, size: number) => Buffer
}
const largePng = realPngOfSize(3 * MIB + 1, 2, 2, 7)
const largeJpeg = padJpegToSize(Buffer.from(JPEG_2X2_BASE64, 'base64'), 3 * MIB + 1)
const smallPng = Buffer.from(PNG_2X2_BASE64, 'base64')

/** A valid one-bit grayscale PNG whose real decoder verifies the raster. */
function compressed2048Png(): Buffer {
  const chunk = (name: string, data: Buffer): Buffer => {
    const type = Buffer.from(name, 'ascii')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.byteLength)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
    return Buffer.concat([length, type, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2048, 0)
  header.writeUInt32BE(2048, 4)
  header[8] = 1
  header[9] = 0
  const raster = Buffer.alloc((1 + 2048 / 8) * 2048)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raster, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function scenario(
  bytes: Buffer,
  options: {
    budget?: VisualInputBudget
    provider?: string
    signal?: AbortSignal
    declaredSize?: number
    readManaged?: () => Promise<Buffer>
  } = {}
) {
  const budget = options.budget ?? new VisualInputBudget()
  const receipt = {
    id: 'managed-image',
    source,
    path: '.gfs-downloads/managed-image/source',
    sizeBytes: options.declaredSize ?? bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const store = {
    readManagedFilePrefix: vi.fn(async () => bytes.subarray(0, 16)),
    readManagedFile: vi.fn(options.readManaged ?? (async () => bytes)),
  }
  const client = {
    accessible: vi.fn(),
    list: vi.fn(),
    stat: vi.fn(),
    resolve: vi.fn(),
    readMetadata: vi.fn(async () => ({ source, size: receipt.sizeBytes })),
    download: vi.fn(async () => receipt),
    read: vi.fn(async () => {
      const reservation = budget.reserve(bytes.byteLength)
      budget.consumeRead(bytes.byteLength)
      return { source, bytes, reservation }
    }),
  } satisfies GfscReadClient
  const capability = vi.fn(async () => ({
    status: 'supported' as const,
    provider: options.provider ?? 'codex-subscription',
    deliveryLimits: resolveVisualDeliveryLimits(options.provider ?? 'codex-subscription'),
    model: 'fixture-model',
    evidence: 'fixture-catalog',
  }))
  const tool = buildGfsReadTools(client, {
    referencedFiles: new Map(),
    downloadStore: store as unknown as GfsDownloadStore,
    callerIdentity: 'caller-a',
    callerWorkspacePath: '/tmp/managed-image-caller',
  }).find(item => item.name === 'clerum__gfs_read')!

  return {
    budget,
    store,
    client,
    receipt,
    capability,
    run: () =>
      tool.execute(target, '/tmp', {
        signal: options.signal,
        visualInput: { budget, resolveCapability: capability },
      }),
  }
}

describe('GFS managed image projection', () => {
  it.each([
    ['PNG', largePng],
    ['JPEG', largeJpeg],
  ])(
    'delivers a decoded valid %s beyond 3 MiB under the effective Codex profile',
    async (_format, bytes) => {
      const subject = scenario(bytes)
      const result = await subject.run()

      expect(result.success).toBe(true)
      expect(JSON.parse(result.content!).visualReason).toBeUndefined()
      expect(JSON.parse(result.content!)).toMatchObject({
        ...subject.receipt,
        delivery: 'workspace_file',
        visualDelivery: 'included',
        usage: { visualDelivery: 'included', wholeFileToContextAllowed: false },
      })
      expect(result.images).toHaveLength(1)
      expect(
        createHash('sha256')
          .update(Buffer.from(result.images![0]!.dataBase64, 'base64'))
          .digest('hex')
      ).toBe(subject.receipt.sha256)
      expect(subject.client.read).not.toHaveBeenCalled()
      expect(subject.store.readManagedFile).toHaveBeenCalledOnce()
      expect(subject.budget.readBytes).toBe(bytes.byteLength)
      expect(subject.budget.residentBytes).toBe(4 * Math.ceil(bytes.byteLength / 3) * 2)
    }
  )

  it.each([8 * MIB, 16 * MIB])(
    'accepts %i source bytes through the Codex visual boundary',
    async size => {
      const png = realPngOfSize(size, 2, 2, 7)
      const subject = scenario(png)
      const result = await subject.run()

      expect(result.success).toBe(true)
      expect(JSON.parse(result.content!)).toMatchObject({
        sizeBytes: size,
        visualDelivery: 'included',
        usage: { visualDelivery: 'included' },
      })
      expect(result.images![0]!.sizeBytes).toBe(size)
      expect(
        createHash('sha256')
          .update(Buffer.from(result.images![0]!.dataBase64, 'base64'))
          .digest('hex')
      ).toBe(subject.receipt.sha256)
      expect(subject.budget.readBytes).toBe(size)
      expect(subject.budget.residentBytes).toBe(4 * Math.ceil(size / 3) * 2)
    },
    // Fixture construction, two framing passes and proof hashing surround the
    // decoder's independent 5-second runtime deadline; they need their own time.
    15_000
  )

  it('accepts a real 2048-square PNG without double-charging inline classification', async () => {
    const png = compressed2048Png()
    expect(png.byteLength).toBeLessThanOrEqual(8192)
    const subject = scenario(png)
    const result = await subject.run()

    expect(result.success).toBe(true)
    expect(result.images).toMatchObject([{ width: 2048, height: 2048 }])
    expect(subject.client.read).toHaveBeenCalledOnce()
    expect(subject.store.readManagedFile).not.toHaveBeenCalled()
    expect(subject.budget.readBytes).toBe(png.byteLength)
    expect(subject.budget.residentBytes).toBe(4 * Math.ceil(png.byteLength / 3) * 2)
  })

  it('reserves and charges raw bytes before starting the managed-file read', async () => {
    const budget = new VisualInputBudget()
    const subject = scenario(largePng, {
      budget,
      readManaged: async () => {
        expect(budget.residentBytes).toBe(largePng.byteLength)
        expect(budget.readBytes).toBe(largePng.byteLength)
        return largePng
      },
    })
    expect((await subject.run()).success).toBe(true)
  })

  it('preserves an admitted source above the visual profile without loading its body', async () => {
    // The injected GFSC client represents a deployment with raised source
    // admission; this test targets projection rather than metadata admission.
    const subject = scenario(smallPng, { declaredSize: 16 * MIB + 1 })
    const result = await subject.run()

    expect(JSON.parse(result.content!)).toMatchObject({
      ...subject.receipt,
      visualDelivery: 'not_included',
      visualReason: 'provider_visual_limit_exceeded',
      usage: { visualDelivery: 'not_included' },
    })
    expect(result.images).toBeUndefined()
    expect(subject.store.readManagedFile).not.toHaveBeenCalled()
    expect(subject.budget.readBytes).toBe(0)
    expect(subject.budget.residentBytes).toBe(0)
  })

  it('keeps an unmeasured provider receipt without applying the legacy 3 MiB profile', async () => {
    const subject = scenario(largePng, { provider: 'openai' })
    const result = await subject.run()

    expect(JSON.parse(result.content!)).toMatchObject({
      ...subject.receipt,
      visualReason: 'provider_visual_profile_unavailable',
      visualDelivery: 'not_included',
    })
    expect(subject.store.readManagedFile).not.toHaveBeenCalled()
    expect(subject.budget.residentBytes).toBe(0)
    expect(result.images).toBeUndefined()
  })

  it.each([
    ['resident', () => new VisualInputBudget(largePng.byteLength - 1)],
    ['read', () => new VisualInputBudget(96 * MIB, largePng.byteLength - 1)],
    [
      'closed',
      () => {
        const budget = new VisualInputBudget()
        budget.close()
        return budget
      },
    ],
  ])('rejects an insufficient %s budget before loading the source', async (_kind, makeBudget) => {
    const subject = scenario(largePng, { budget: makeBudget() })
    const result = await subject.run()

    expect(JSON.parse(result.content!)).toMatchObject({
      ...subject.receipt,
      visualDelivery: 'not_included',
      visualReason: 'local_visual_resources_exceeded',
    })
    expect(subject.store.readManagedFile).not.toHaveBeenCalled()
    expect(subject.budget.residentBytes).toBe(0)
    expect(result.images).toBeUndefined()
  })

  it('releases its raw reservation when cancellation arrives during the read', async () => {
    const controller = new AbortController()
    const subject = scenario(largePng, {
      signal: controller.signal,
      readManaged: async () => {
        controller.abort()
        return largePng
      },
    })
    const result = await subject.run()

    expect(result.success).toBe(false)
    expect(result.error).toContain('cancelled')
    expect(result.images).toBeUndefined()
    expect(subject.budget.residentBytes).toBe(0)
    expect(subject.budget.readBytes).toBe(largePng.byteLength)
  })

  it('does not expose a receipt as usable when the retained file fails integrity', async () => {
    const subject = scenario(largePng, {
      readManaged: async () => {
        throw new GfsDownloadStoreError('download_missing')
      },
    })
    const result = await subject.run()

    expect(result.success).toBe(false)
    expect(result.error).toContain('download_missing')
    expect(result.content).toBeUndefined()
    expect(subject.budget.residentBytes).toBe(0)
  })
})
