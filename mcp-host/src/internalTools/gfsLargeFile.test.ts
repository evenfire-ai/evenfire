import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { InternalToolDefinition } from '../workflow/types'
import { type GfscReadClient, buildGfsReadTools } from './gfs'
import { GfsDownloadError } from './gfsContentDownload'
import type { GfsMetadataSnapshot } from './gfsContentRead'
import type { GfsDownloadStore } from './gfsDownloadStore'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'
import type { GfsFileContent } from './gfsReadTypes'

const target = { drive: 'main', resourceId: 'a'.repeat(32) }
let callerWorkspace: string

beforeEach(() => {
  callerWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-large-file-'))
})

afterEach(() => {
  fs.rmSync(callerWorkspace, { recursive: true, force: true })
})
const source = {
  kind: 'gfs' as const,
  ...target,
  gfsUri: `gfs://${target.drive}/${target.resourceId}`,
  name: 'input.csv',
  version: 7,
}

function content(bytes: Buffer): GfsFileContent {
  return { source, bytes, reservation: { release: vi.fn() } }
}

function snapshot(sizeBytes: number): GfsMetadataSnapshot {
  return { source, size: sizeBytes }
}

function client(
  options: { read?: GfscReadClient['read']; download?: GfscReadClient['download'] } = {}
) {
  return {
    accessible: vi.fn(),
    list: vi.fn(),
    read: options.read ?? vi.fn(async () => content(Buffer.from('text'))),
    readMetadata: vi.fn(async (): Promise<GfsMetadataSnapshot> => snapshot(0)),
    download: options.download,
    stat: vi.fn(),
    resolve: vi.fn(),
  } satisfies GfscReadClient
}

function result(tool: InternalToolDefinition, args: Record<string, unknown>) {
  return tool.execute(args, '/tmp').then(outcome => ({
    outcome,
    parsed: outcome.content?.startsWith('{') ? JSON.parse(outcome.content) : undefined,
  }))
}

function fakeDownloadStore(): GfsDownloadStore {
  return {
    readManagedFilePrefix: async () => Buffer.from('not-an-image'),
  } as unknown as GfsDownloadStore
}

function spyDownloadStore() {
  return {
    reusableReceipt: vi.fn(),
    createTransfer: vi.fn(),
    publish: vi.fn(),
    fail: vi.fn(),
    readManagedFilePrefix: vi.fn(),
  }
}

describe('GFS large-file tool routing', () => {
  it('does not expose generic workspace delivery without a store', () => {
    expect(
      buildGfsReadTools(client(), { referencedFiles: new Map() }).map(tool => tool.name)
    ).not.toContain('clerum__gfs_download')
  })

  it('routes the incident-sized CSV to a workspace receipt without inline content', async () => {
    const read = vi.fn()
    const download = vi.fn(async () => ({
      id: 'download-1',
      source,
      path: '.gfs-downloads/input-download-1/source',
      sizeBytes: 3_836_961,
      sha256: 'a'.repeat(64),
      expiresAt: '2026-10-08T00:00:00.000Z',
    }))
    const gfs = client({ read, download })
    gfs.readMetadata = vi.fn(async () => snapshot(3_836_961))
    const managedFile = path.join(callerWorkspace, '.gfs-downloads/input-download-1/source')
    fs.mkdirSync(path.dirname(managedFile), { recursive: true })
    fs.writeFileSync(managedFile, 'not-an-image-prefix', 'utf8')
    const store = fakeDownloadStore()
    const tool = buildGfsReadTools(gfs, {
      referencedFiles: new Map(),
      downloadStore: store,
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerWorkspace,
    }).find(item => item.name === 'clerum__gfs_read')!

    const { outcome, parsed } = await result(tool, target)

    expect(outcome.success).toBe(true)
    expect(parsed).toMatchObject({
      delivery: 'workspace_file',
      sizeBytes: 3_836_961,
      sha256: 'a'.repeat(64),
    })
    expect(parsed.usage).toMatchObject({
      pathSemantics: 'relative-to-caller-workspace',
      nextTool: 'shell_exec_when_local_processing_is_needed',
      wholeFileToContextAllowed: false,
    })
    expect(JSON.stringify(parsed)).not.toContain('AAAAAAA')
    expect(read).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        store,
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerWorkspace,
        expectedVersion: 7,
      })
    )
  })

  it('keeps exactly the inline threshold in memory and downloads one byte above it', async () => {
    const download = vi.fn(async () => ({
      id: 'download-2',
      source,
      path: '.gfs-downloads/input-download-2/source',
      sizeBytes: 8193,
      sha256: 'b'.repeat(64),
      expiresAt: '2026-10-08T00:00:00.000Z',
    }))
    const gfs = client({ download })
    gfs.readMetadata = vi.fn(async () => snapshot(8192))
    const managedFile = path.join(callerWorkspace, '.gfs-downloads/input-download-2/source')
    fs.mkdirSync(path.dirname(managedFile), { recursive: true })
    fs.writeFileSync(managedFile, 'not-an-image-prefix', 'utf8')
    const store = fakeDownloadStore()
    const tool = buildGfsReadTools(gfs, {
      referencedFiles: new Map(),
      downloadStore: store,
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerWorkspace,
    }).find(item => item.name === 'clerum__gfs_read')!

    const { outcome } = await result(tool, target)
    expect(outcome.content).toBe('text')
    expect(download).not.toHaveBeenCalled()
    expect(gfs.read).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        expectedVersion: 7,
        metadataSnapshot: snapshot(8192),
      })
    )

    gfs.readMetadata = vi.fn(async () => snapshot(GFS_FILE_LIMITS.inlineTextBytes + 1))
    const { parsed: large } = await result(tool, target)
    expect(large).toMatchObject({ delivery: 'workspace_file' })
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('exposes an explicit generic download tool for admitted sources', async () => {
    const download = vi.fn(async () => ({
      id: 'download-3',
      source,
      path: '.gfs-downloads/input-download-3/source',
      sizeBytes: 1,
      sha256: 'c'.repeat(64),
      expiresAt: '2026-10-08T00:00:00.000Z',
    }))
    const store = fakeDownloadStore()
    const tool = buildGfsReadTools(client({ download }), {
      referencedFiles: new Map(),
      downloadStore: store,
      callerIdentity: 'caller-a',
      callerWorkspacePath: '/tmp/caller-a',
    }).find(item => item.name === 'clerum__gfs_download')!

    const { parsed } = await result(tool, target)
    expect(parsed).toMatchObject({ delivery: 'workspace_file', sizeBytes: 1 })
    expect(download).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ store, callerIdentity: 'caller-a' })
    )
  })

  it.each([
    ['path', { drive: 'main', resourceId: '/private/path/input.csv' }],
    ['GFS URI', { drive: 'main', resourceId: `gfs://main/${target.resourceId}` }],
    ['missing resourceId', { drive: 'main' }],
    ['invalid resourceId', { drive: 'main', resourceId: 'input.csv' }],
    [
      'malformed hyphen groups',
      { drive: 'main', resourceId: `${'a'.repeat(8)}-${'b'.repeat(24)}` },
    ],
  ])('rejects a %s before client or store work', async (_kind, args) => {
    const download = vi.fn()
    const store = spyDownloadStore()
    const gfs = client({ download })
    const tool = buildGfsReadTools(gfs, {
      referencedFiles: new Map(),
      downloadStore: store as unknown as GfsDownloadStore,
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerWorkspace,
    }).find(item => item.name === 'clerum__gfs_download')!
    const properties = tool.parameters.properties as {
      resourceId: { pattern?: string }
    }

    const result = await tool.execute(args, '/tmp')

    const pattern = new RegExp(String(properties.resourceId.pattern))
    expect(pattern.test(target.resourceId)).toBe(true)
    expect(pattern.test('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')).toBe(true)
    expect(pattern.test(`${'a'.repeat(8)}-${'b'.repeat(24)}`)).toBe(false)
    expect(result).toEqual({
      success: false,
      error:
        'resourceId must be the observed 32-hex or dashed UUID from clerum__gfs_accessible/clerum__gfs_list; filenames, paths, and gfs:// URIs are not resource IDs.',
    })
    expect(download).not.toHaveBeenCalled()
    expect(gfs.accessible).not.toHaveBeenCalled()
    expect(gfs.list).not.toHaveBeenCalled()
    expect(gfs.read).not.toHaveBeenCalled()
    expect(gfs.readMetadata).not.toHaveBeenCalled()
    expect(gfs.stat).not.toHaveBeenCalled()
    expect(gfs.resolve).not.toHaveBeenCalled()
    expect(store.reusableReceipt).not.toHaveBeenCalled()
    expect(store.createTransfer).not.toHaveBeenCalled()
    expect(store.publish).not.toHaveBeenCalled()
    expect(store.fail).not.toHaveBeenCalled()
  })

  it('keeps dashed UUID input working', async () => {
    const dashed = [
      target.resourceId.slice(0, 8),
      target.resourceId.slice(8, 12),
      target.resourceId.slice(12, 16),
      target.resourceId.slice(16, 20),
      target.resourceId.slice(20),
    ]
      .join('-')
      .toUpperCase()
    const download = vi.fn(async () => ({
      id: 'download-dashed',
      source,
      path: '.gfs-downloads/download-dashed/source',
      sizeBytes: 1,
      sha256: 'd'.repeat(64),
      expiresAt: '2026-10-08T00:00:00.000Z',
    }))
    const store = spyDownloadStore()
    const tool = buildGfsReadTools(client({ download }), {
      referencedFiles: new Map(),
      downloadStore: store as unknown as GfsDownloadStore,
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerWorkspace,
    }).find(item => item.name === 'clerum__gfs_download')!

    const { outcome } = await result(tool, { drive: target.drive, resourceId: dashed })

    expect(outcome.success).toBe(true)
    expect(download).toHaveBeenCalledWith(
      { drive: target.drive, resourceId: dashed },
      expect.objectContaining({ store, callerIdentity: 'caller-a' })
    )
  })

  it.each([
    ['binary', Buffer.from([0xff, 0x00, 0xfe, 0x01])],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
  ])(
    'preserves a small %s source as a workspace file without inline content',
    async (_kind, bytes) => {
      const file = content(bytes)
      const receipt = {
        id: 'download-small',
        source,
        path: '.gfs-downloads/input-download-small/source',
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        expiresAt: '2026-10-08T00:00:00.000Z',
      }
      const download = vi.fn(async () => receipt)
      const gfs = client({ read: vi.fn(async () => file), download })
      gfs.readMetadata = vi.fn(async () => snapshot(bytes.byteLength))
      const store = fakeDownloadStore()
      const tool = buildGfsReadTools(gfs, {
        referencedFiles: new Map(),
        downloadStore: store,
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerWorkspace,
      }).find(item => item.name === 'clerum__gfs_read')!

      const { outcome, parsed } = await result(tool, target)

      expect(outcome.success).toBe(true)
      expect(parsed).toMatchObject({
        delivery: 'workspace_file',
        ...receipt,
        usage: {
          approval: 'user-approval-required',
          wholeFileToContextAllowed: false,
          boundedOutputOnly: true,
        },
      })
      expect(outcome.images).toBeUndefined()
      expect(download).toHaveBeenCalledWith(
        target,
        expect.objectContaining({ expectedVersion: source.version, store })
      )
      expect(file.reservation.release).toHaveBeenCalledOnce()
    }
  )

  it.each([
    [Buffer.from([0xff, 0x00, 0xfe, 0x01]), 'unsupported_binary_format'],
    [Buffer.from('<svg></svg>'), 'svg_visual_input_not_supported'],
  ])(
    'keeps a small non-inline source reference-only when workspace delivery is unavailable',
    async (bytes, reason) => {
      const file = content(bytes)
      const gfs = client({ read: vi.fn(async () => file) })
      gfs.readMetadata = vi.fn(async () => snapshot(bytes.byteLength))
      const tool = buildGfsReadTools(gfs, { referencedFiles: new Map() }).find(
        item => item.name === 'clerum__gfs_read'
      )!

      const { parsed } = await result(tool, target)

      expect(parsed).toMatchObject({ delivery: 'reference_only', reason })
      expect(parsed.resource).toEqual(source)
      expect(file.reservation.release).toHaveBeenCalledOnce()
    }
  )

  it('does not download a newer small binary version after its classification read', async () => {
    const file = content(Buffer.from([0xff, 0x00]))
    const download = vi.fn(async () => {
      throw new GfsDownloadError('version_conflict')
    })
    const gfs = client({ read: vi.fn(async () => file), download })
    gfs.readMetadata = vi.fn(async () => snapshot(file.bytes.byteLength))
    const tool = buildGfsReadTools(gfs, {
      referencedFiles: new Map(),
      downloadStore: fakeDownloadStore(),
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerWorkspace,
    }).find(item => item.name === 'clerum__gfs_read')!

    const { outcome, parsed } = await result(tool, target)

    expect(outcome.success).toBe(true)
    expect(parsed).toMatchObject({ availability: 'stale', expectedVersion: source.version })
    expect(download).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ expectedVersion: source.version })
    )
    expect(file.reservation.release).toHaveBeenCalledOnce()
  })

  it('preserves a workspace receipt before projecting a byte-classified image', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    const download = vi.fn(async () => ({
      id: 'download-image',
      source,
      path: '.gfs-downloads/input-download-image/source',
      sizeBytes: png.byteLength,
      sha256: createHash('sha256').update(png).digest('hex'),
      expiresAt: '2026-10-08T00:00:00.000Z',
    }))
    const gfs = client({ read: vi.fn(async () => content(png)), download })
    gfs.readMetadata = vi.fn(async () => snapshot(png.byteLength))
    const store = fakeDownloadStore()
    const tool = buildGfsReadTools(gfs, {
      referencedFiles: new Map(),
      downloadStore: store,
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerWorkspace,
    }).find(item => item.name === 'clerum__gfs_read')!

    const { parsed } = await result(tool, target)
    expect(parsed).toMatchObject({
      delivery: 'workspace_file',
      sizeBytes: png.byteLength,
      visualDelivery: 'not_included',
      visualReason: 'image_input_unavailable_in_this_execution',
    })
    expect(parsed.usage).toMatchObject({
      visualDelivery: 'not_included',
      wholeFileToContextAllowed: false,
    })
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('reports a pinned explicit download as stale on version conflict', async () => {
    const download = vi.fn(async () => {
      throw new GfsDownloadError('version_conflict')
    })
    const store = fakeDownloadStore()
    const tool = buildGfsReadTools(client({ download }), {
      referencedFiles: new Map(),
      downloadStore: store,
      callerIdentity: 'caller-a',
      callerWorkspacePath: '/tmp/caller-a',
    }).find(item => item.name === 'clerum__gfs_download')!

    const { parsed } = await result(tool, { ...target, expectedVersion: 7 })
    expect(parsed).toMatchObject({
      availability: 'stale',
      expectedVersion: 7,
    })
  })
})
