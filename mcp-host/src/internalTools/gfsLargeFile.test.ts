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
    const store = {} as GfsDownloadStore
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
    const store = {} as GfsDownloadStore
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
    const store = {} as GfsDownloadStore
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
    const store = {} as GfsDownloadStore
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
    const store = {} as GfsDownloadStore
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
