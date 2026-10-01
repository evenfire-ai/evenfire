/**
 * #666 — the Host pins `clerum__gfs_read` to the version of each GFS file the
 * turn's message referenced. The resolutions come from the real
 * `resolveFileReferences`, the tool is the one the chat registry presents
 * (through `InternalToolAdapter`), and the read runs the real
 * `readGfsContent` behind an HTTP double.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FileReferenceV1,
  buildAttachmentFileReference,
  buildGfsFileReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import {
  type FileReferenceResolution,
  resolveFileReferences,
} from '../../../agent/fileReferenceResolver'
import { referencedFilePins } from '../../../internalTools/gfs'
import { readGfsContent } from '../../../internalTools/gfsContentRead'
import type { GfsReadOptions } from '../../../internalTools/gfsReadTypes'
import type { IncomingMessage } from '../../../server'
import type { NativeToolConfig } from '../../interfaces'
import { NativeToolRegistry } from '../nativeToolRegistry'

const RID = '1234567890abcdef1234567890abcdef'
const URI = `gfs://main/${RID}`
const SENTINEL = 'SENTINEL-666-gfs-read-pin'

// The file as gfsc serves it now; each test sets its version.
const served = { version: 3 }

const gfsClient = vi.hoisted(() => ({
  accessible: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  stat: vi.fn(),
  resolve: vi.fn(),
}))

vi.mock('../../../internalTools/gfsClient', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../internalTools/gfsClient')>()),
  createGfscClient: vi.fn(() => gfsClient),
}))

const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]

function encodedClaims(scopes: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
}

const bytes = Buffer.from(SENTINEL)

async function gfscRequest(path: string): Promise<Response> {
  if (!path.includes('/content?'))
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          resourceId: RID,
          rid: RID,
          drive: 'main',
          gfsUri: URI,
          kind: 'file',
          name: 'notes.md',
          version: served.version,
          bytes: bytes.length,
        },
      })
    )
  return new Response(new Uint8Array(bytes), {
    headers: { 'x-gfs-uri': URI, 'x-gfs-version': String(served.version) },
  })
}

function gfsReference(version: number): FileReferenceV1 {
  const built = buildGfsFileReference({
    drive: 'main',
    resourceId: RID,
    gfsUri: URI,
    version,
    name: 'notes.md',
    declaredMediaType: 'text/markdown',
    byteLength: bytes.length,
    classification: classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: bytes.length,
      declaredMediaType: 'text/markdown',
      filename: 'notes.md',
    }),
  })
  if (!built.ok) throw new Error(built.message)
  return built.value
}

/** Admission's resolution of one reference against gfsc, as it runs in production. */
async function resolved(reference: FileReferenceV1): Promise<FileReferenceResolution[]> {
  const result = await resolveFileReferences([reference], {
    resolve: async () => ({
      ok: true,
      data: {
        resourceId: RID,
        rid: RID,
        drive: 'main',
        gfsUri: URI,
        kind: 'file',
        version: served.version,
        bytes: bytes.length,
      },
    }),
  })
  if (!result.ok) throw new Error(`resolution failed: ${JSON.stringify(result)}`)
  return result.resolutions
}

function message(resolutions?: FileReferenceResolution[]): IncomingMessage {
  return {
    content: 'Summarize the referenced file',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-09-24T10:00:00Z',
    messageId: 'message-1',
    hostRef: 'host-1',
    ...(resolutions ? { fileReferences: resolutions.map(r => r.reference) } : {}),
    ...(resolutions ? { fileReferenceResolutions: resolutions } : {}),
  }
}

function gfsReadTool(source?: IncomingMessage) {
  process.env[ACCESS_ENV] = encodedClaims(['gfs.read'])
  gfsClient.read.mockImplementation(
    (args: { drive: string; resourceId: string }, options?: GfsReadOptions) =>
      readGfsContent(gfscRequest, args, options ?? {})
  )
  const registry = new NativeToolRegistry(config, 'gfs-read-pin-test', undefined, source)
  const tool = registry.get('clerum__gfs_read')
  if (!tool) throw new Error('clerum__gfs_read is not registered')
  return tool
}

afterEach(() => {
  gfsClient.read.mockReset()
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
})

describe('clerum__gfs_read pinned through the chat registry (#666)', () => {
  it('reads an available reference at its version and refuses another one', async () => {
    served.version = 3
    const resolutions = await resolved(gfsReference(3))
    expect(resolutions[0]!.availability).toBe('available')
    const tool = gfsReadTool(message(resolutions))

    const refused = await tool.execute({ drive: 'main', resourceId: RID, expectedVersion: 7 })
    expect(refused).toMatchObject({
      is_error: true,
      content:
        'Error: This file is referenced in the current message at version 3. Omit expectedVersion or pass 3.',
    })
    expect(gfsClient.read).not.toHaveBeenCalled()

    const read = await tool.execute({ drive: 'main', resourceId: RID })
    expect(read).toMatchObject({ is_error: false, content: SENTINEL })
    expect(gfsClient.read).toHaveBeenCalledTimes(1)
    expect(gfsClient.read.mock.calls[0]![1]).toMatchObject({ expectedVersion: 3 })
  })

  it('answers stale at the referenced version and reads the current_version on request', async () => {
    served.version = 4
    const resolutions = await resolved(gfsReference(3))
    expect(resolutions[0]).toMatchObject({ availability: 'stale', resolvedVersion: 4 })
    const tool = gfsReadTool(message(resolutions))

    const stale = await tool.execute({ drive: 'main', resourceId: RID })
    expect(stale.is_error).toBe(false)
    expect(JSON.parse(stale.content)).toMatchObject({ availability: 'stale', expectedVersion: 3 })
    expect(stale.content).not.toContain(SENTINEL)

    const current = await tool.execute({ drive: 'main', resourceId: RID, expectedVersion: 4 })
    expect(current).toMatchObject({ is_error: false, content: SENTINEL })
    expect(gfsClient.read.mock.calls.map(([, options]) => options?.expectedVersion)).toEqual([3, 4])
  })

  it('leaves the read unpinned for a turn without a source message', async () => {
    served.version = 5
    const tool = gfsReadTool(undefined)
    const read = await tool.execute({ drive: 'main', resourceId: RID })
    expect(read).toMatchObject({ is_error: false, content: SENTINEL })
    expect(gfsClient.read).toHaveBeenCalledTimes(1)
    expect(gfsClient.read.mock.calls[0]![1]).not.toHaveProperty('expectedVersion')
  })
})

describe('referencedFilePins (#666)', () => {
  it('pins every GFS reference, carries the current version of a stale one, and skips attachments', () => {
    const attachmentBytes = new TextEncoder().encode('hello')
    const attachment = buildAttachmentFileReference({
      attachmentId: 'a1',
      messageId: 'm1',
      name: 'hello.txt',
      declaredMediaType: 'text/plain',
      byteLength: attachmentBytes.length,
      digestHex: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      classification: classifyBytes({
        bytes: attachmentBytes,
        totalByteLength: attachmentBytes.length,
        declaredMediaType: 'text/plain',
        filename: 'hello.txt',
      }),
    })
    if (!attachment.ok) throw new Error(attachment.message)
    const pins = referencedFilePins([
      { availability: 'stale', reference: gfsReference(3), resolvedVersion: 4 },
      { availability: 'unsupported', reference: attachment.value },
    ])
    expect([...pins]).toEqual([[`main/${RID}`, { version: 3, currentVersion: 4 }]])
  })

  it('pins an unavailable reference at its version without a current version', () => {
    const pins = referencedFilePins([{ availability: 'denied', reference: gfsReference(3) }])
    expect([...pins]).toEqual([[`main/${RID}`, { version: 3 }]])
  })

  it('pins nothing for a message without references', () => {
    expect(referencedFilePins(undefined).size).toBe(0)
  })
})
