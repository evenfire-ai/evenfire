// Chat attachments are kept at admission in the caller's own
// `.clerum-outputs/.uploads/`, so a later turn or conversation can save them
// to GFS by id. Nothing reaches another caller, and a message whose
// attachments cannot be kept is processed anyway.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { freeSpaceSizedStatfs } from '../__tests__/fixtures/gfsStoreTestKit'
import { FileReadTool } from '../core/tools/fileRead'
import { FileWriteTool } from '../core/tools/fileWrite'
import { NativeToolRegistry } from '../core/tools/nativeToolRegistry'
import type { Attachment } from '../core/types'
import type { InternalToolDefinition, InternalToolResult } from '../workflow/types'
import { CALLER_OUTPUTS_DIR, KEPT_UPLOADS_DIR } from '../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../workspace/scopedWorkspace'
import { type GfscWriteClient, buildGfsWriteTools, buildKeptFilesListTool } from './gfs'
import { GfsDownloadStore, GfsDownloadStoreError } from './gfsDownloadStore'
import {
  FILE_CONTAINS_SECRET,
  type KeptReservations,
  keepIncomingAttachments,
  keepMessageAttachments,
  keptFileNotFound,
} from './keptFiles'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, statfs: freeSpaceSizedStatfs(actual.statfs) }
})
vi.mock('fs', async original => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    statfsSync: (target: string, options: { bigint: true }) => {
      const reading = actual.statfsSync(target, options)
      return { ...reading, blocks: reading.bavail, bfree: reading.bavail }
    },
  }
})

const SYNTHETIC = 'synthetic-upload-probe-value'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let hostBase: string
let provider: ScopedWorkspaceProvider
const stores: GfsDownloadStore[] = []

beforeEach(() => {
  hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-kept-uploads-')))
  provider = new ScopedWorkspaceProvider(hostBase)
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close(0)
  fs.rmSync(hostBase, { recursive: true, force: true })
})

function rootOf(userId: string): string {
  const binding = resolveCallerRootBinding(provider, { sender: userId, channelType: 'rpc' })
  if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
  return binding.root
}

function uploadsOf(root: string): string {
  return path.join(root, CALLER_OUTPUTS_DIR, KEPT_UPLOADS_DIR)
}

async function openStore(): Promise<GfsDownloadStore> {
  const store = new GfsDownloadStore(hostBase)
  stores.push(store)
  await store.initialize()
  return store
}

function file(name: string, bytes: Buffer | string): Attachment {
  return {
    id: `file-${name}`,
    kind: 'file',
    mimeType: 'text/plain',
    encoding: 'base64',
    dataBase64: Buffer.from(bytes).toString('base64'),
    filename: name,
  } as Attachment
}

function image(bytes: Buffer = PNG): Attachment {
  return {
    id: 'img-1',
    kind: 'image',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: bytes.toString('base64'),
    filename: 'photo.png',
  } as Attachment
}

function reference(): Attachment {
  return {
    id: 'ref-1',
    kind: 'file',
    mimeType: 'text/plain',
    filename: 'ref.txt',
  } as Attachment
}

function recordingClient(): GfscWriteClient {
  return {
    write: vi.fn(),
    writeBytes: vi.fn(async () => ({ version: 2 })),
    createFile: vi.fn(),
    createFileFromBytes: vi.fn(async () => ({ resourceId: 'created' })),
  } as unknown as GfscWriteClient
}

function sent(client: GfscWriteClient): Buffer {
  const calls = [
    ...vi.mocked(client.createFileFromBytes).mock.calls,
    ...vi.mocked(client.writeBytes).mock.calls,
  ]
  return Buffer.from((calls.at(-1)![0] as { contentBase64: string }).contentBase64, 'base64')
}

function clientCalls(client: GfscWriteClient): number {
  return (
    vi.mocked(client.createFileFromBytes).mock.calls.length +
    vi.mocked(client.writeBytes).mock.calls.length
  )
}

function tools(
  root: string,
  client: GfscWriteClient,
  secrets: Array<{ name: string; value: string }> = []
): Map<string, InternalToolDefinition> {
  return new Map(
    buildGfsWriteTools(client, {
      callerRoot: root,
      callerWorkspacePath: root,
      secretEntries: () => secrets,
    }).map(tool => [tool.name, tool])
  )
}

function payload(result: InternalToolResult): Record<string, unknown> {
  expect(result.success, result.error).toBe(true)
  return JSON.parse(result.content!) as Record<string, unknown>
}

async function listed(root: string): Promise<Array<Record<string, unknown>>> {
  const result = await buildKeptFilesListTool(root).execute({}, '')
  return (payload(result) as { files: Array<Record<string, unknown>> }).files
}

describe('keeping the attachments of a message', () => {
  it('keeps the file and the image that carry bytes, under one reservation, and not the reference', async () => {
    const root = rootOf('user-a')
    const reserveKept = vi.fn<KeptReservations['reserveKept']>(async () => () => undefined)
    const refusal = await keepMessageAttachments({
      attachments: [file('notes.txt', 'hello'), image(), reference()],
      callerRoot: root,
      store: { reserveKept },
    })
    expect(refusal).toBeUndefined()
    expect(reserveKept).toHaveBeenCalledTimes(1)
    expect(reserveKept.mock.calls[0]![0]).toEqual({
      callerIdentity: path.basename(root),
      sizeBytes: 5 + PNG.length,
    })
    const names = fs.readdirSync(uploadsOf(root)).sort()
    expect(names).toHaveLength(4)
    const bins = names.filter(name => name.endsWith('.bin'))
    const kept = bins.map(name => fs.readFileSync(path.join(uploadsOf(root), name)))
    expect(kept.map(bytes => bytes.toString('base64')).sort()).toEqual(
      [Buffer.from('hello').toString('base64'), PNG.toString('base64')].sort()
    )
    for (const name of names) {
      expect(fs.statSync(path.join(uploadsOf(root), name)).mode & 0o777).toBe(0o600)
    }
    expect(fs.statSync(uploadsOf(root)).mode & 0o777).toBe(0o700)
    const records = (await listed(root)).map(entry => [entry.kind, entry.name])
    expect(records.sort()).toEqual([
      ['upload', 'notes.txt'],
      ['upload', 'photo.png'],
    ])
  })

  it('gives two uploads with one name two ids', async () => {
    const root = rootOf('user-a')
    const store = { reserveKept: async () => () => undefined }
    await keepMessageAttachments({ attachments: [file('same.txt', 'a')], callerRoot: root, store })
    await keepMessageAttachments({ attachments: [file('same.txt', 'b')], callerRoot: root, store })
    const entries = await listed(root)
    expect(entries.map(entry => entry.name)).toEqual(['same.txt', 'same.txt'])
    expect(new Set(entries.map(entry => entry.id)).size).toBe(2)
  })

  it('passes a store refusal on with the bytes short, and writes nothing', async () => {
    const root = rootOf('user-a')
    const refusal = await keepMessageAttachments({
      attachments: [file('a.txt', 'aaaa')],
      callerRoot: root,
      store: {
        reserveKept: async () => {
          throw new GfsDownloadStoreError('host_quota_exceeded', 1234)
        },
      },
    })
    expect(refusal).toEqual({ code: 'host_quota_exceeded', neededBytes: 1234 })
    expect(fs.readdirSync(uploadsOf(root))).toEqual([])
  })

  it('removes what it wrote when a later write fails, and releases the reservation', async () => {
    const root = rootOf('user-a')
    const release = vi.fn()
    const realOpen = fs.promises.open
    let opens = 0
    vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof realOpen>
    ) => {
      opens += 1
      if (opens === 3) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      return realOpen(...args)
    }) as typeof realOpen)
    const refusal = await keepMessageAttachments({
      attachments: [file('one.txt', '1'), file('two.txt', '2')],
      callerRoot: root,
      store: { reserveKept: async () => release },
    })
    expect(refusal).toEqual({ code: 'write_failed_enospc' })
    expect(opens).toBe(3)
    expect(fs.readdirSync(uploadsOf(root))).toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps nothing and says nothing on a Host that cannot write to GFS', async () => {
    const root = rootOf('user-a')
    const reserveKept = vi.fn<KeptReservations['reserveKept']>(async () => () => undefined)
    const message = { sender: 'user-a', attachments: [file('a.txt', 'a')] }
    expect(
      await keepIncomingAttachments({
        message,
        canWriteGfs: false,
        callerRoot: root,
        store: { reserveKept },
      })
    ).toBeUndefined()
    expect(reserveKept).not.toHaveBeenCalled()
    expect(fs.existsSync(uploadsOf(root))).toBe(false)
    // Witness: the same message on a Host with gfs.write is kept.
    expect(
      await keepIncomingAttachments({
        message,
        canWriteGfs: true,
        callerRoot: root,
        store: { reserveKept },
      })
    ).toBeUndefined()
    expect(reserveKept).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(uploadsOf(root))).toHaveLength(2)
  })

  it('refuses with a code when there is no sender, no caller root or no store', async () => {
    const root = rootOf('user-a')
    const reserveKept = vi.fn<KeptReservations['reserveKept']>(async () => () => undefined)
    const attachments = [file('a.txt', 'a')]
    expect(
      await keepIncomingAttachments({
        message: { attachments },
        canWriteGfs: true,
        callerRoot: root,
        store: { reserveKept },
      })
    ).toEqual({ code: 'no_sender' })
    expect(
      await keepIncomingAttachments({
        message: { sender: 'u', attachments },
        canWriteGfs: true,
        callerRoot: undefined,
        store: { reserveKept },
      })
    ).toEqual({ code: 'caller_root_unavailable' })
    expect(
      await keepIncomingAttachments({
        message: { sender: 'u', attachments },
        canWriteGfs: true,
        callerRoot: root,
        store: null,
      })
    ).toEqual({ code: 'store_unavailable' })
    expect(reserveKept).not.toHaveBeenCalled()
  })
})

describe('saving a kept attachment', () => {
  async function keep(
    root: string,
    attachments: Attachment[]
  ): Promise<Array<Record<string, unknown>>> {
    const store = await openStore()
    expect(await keepMessageAttachments({ attachments, callerRoot: root, store })).toBeUndefined()
    return listed(root)
  }

  it('saves the uploaded bytes from a later conversation, as a new file and as a new version', async () => {
    const root = rootOf('user-a')
    const [entry] = await keep(root, [file('notes.txt', 'kept notes\n')])
    const client = recordingClient()
    const created = await tools(root, client)
      .get('clerum__gfs_create_file')!
      .execute(
        { drive: 'main', parentResourceId: 'f', name: 'notes.txt', uploadedFileId: entry!.id },
        ''
      )
    expect(payload(created)).toMatchObject({
      source: 'kept_upload',
      secretScan: { state: 'scanned' },
    })
    expect(sent(client).toString()).toBe('kept notes\n')
    const replaced = await tools(root, client)
      .get('clerum__gfs_write')!
      .execute({ drive: 'main', resourceId: 'r', ifMatch: 1, uploadedFileId: entry!.id }, '')
    expect(payload(replaced).source).toBe('kept_upload')
    expect(clientCalls(client)).toBe(2)
  })

  it('scans an upload: a secret refuses it, an image and a pdf upload unscanned', async () => {
    const root = rootOf('user-a')
    const entries = await keep(root, [
      file('secret.txt', `token ${SYNTHETIC}`),
      image(),
      file('doc.pdf', `%PDF-1.7\n${SYNTHETIC}`),
    ])
    const byName = new Map(entries.map(entry => [entry.name, entry.id as string]))
    const client = recordingClient()
    const save = (id: string) =>
      tools(root, client, [{ name: 'P', value: SYNTHETIC }])
        .get('clerum__gfs_create_file')!
        .execute({ drive: 'main', parentResourceId: 'f', name: 'x', uploadedFileId: id }, '')
    expect((await save(byName.get('secret.txt')!)).error).toBe(FILE_CONTAINS_SECRET)
    expect(payload(await save(byName.get('photo.png')!)).secretScan).toEqual({
      state: 'not_scanned',
      reason: 'binary_format',
    })
    expect(payload(await save(byName.get('doc.pdf')!)).secretScan).toEqual({
      state: 'not_scanned',
      reason: 'binary_format',
    })
    expect(clientCalls(client)).toBe(2)
  })

  it('scans a record and bytes planted by hand like any upload', async () => {
    const root = rootOf('user-a')
    fs.mkdirSync(uploadsOf(root), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(uploadsOf(root), 'abcdefabcdef.bin'), `k ${SYNTHETIC}`)
    fs.writeFileSync(
      path.join(uploadsOf(root), 'abcdefabcdef.json'),
      JSON.stringify({
        id: 'abcdefabcdef',
        name: 'planted.txt',
        createdAt: new Date().toISOString(),
      })
    )
    const client = recordingClient()
    const result = await tools(root, client, [{ name: 'P', value: SYNTHETIC }])
      .get('clerum__gfs_create_file')!
      .execute(
        { drive: 'main', parentResourceId: 'f', name: 'x', uploadedFileId: 'abcdefabcdef' },
        ''
      )
    expect(result.error).toBe(FILE_CONTAINS_SECRET)
    expect(clientCalls(client)).toBe(0)
  })

  it('lists an upload only when both its bytes and its record exist', async () => {
    const root = rootOf('user-a')
    fs.mkdirSync(uploadsOf(root), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(uploadsOf(root), '111111111111.bin'), 'half')
    fs.writeFileSync(
      path.join(uploadsOf(root), '222222222222.json'),
      JSON.stringify({ id: '222222222222', name: 'r.txt', createdAt: new Date().toISOString() })
    )
    expect(await listed(root)).toEqual([])
    const [entry] = await keep(root, [file('whole.txt', 'w')])
    expect((await listed(root)).map(item => item.name)).toEqual(['whole.txt'])
    expect(Object.keys(entry!).sort()).toEqual(
      ['canSave', 'createdAt', 'format', 'id', 'kind', 'name', 'sizeBytes'].sort()
    )
  })

  it("never reaches another caller's upload", async () => {
    const a = rootOf('user-a')
    const b = rootOf('user-b')
    const [entryA] = await keep(a, [file('a-private.txt', 'only a')])
    const clientB = recordingClient()
    const asB = await tools(b, clientB)
      .get('clerum__gfs_create_file')!
      .execute({ drive: 'main', parentResourceId: 'f', name: 'x', uploadedFileId: entryA!.id }, '')
    expect(asB.error).toBe(keptFileNotFound().error)
    expect(clientCalls(clientB)).toBe(0)
    expect(await listed(b)).toEqual([])
    // Witness: A saves the bytes A attached.
    const clientA = recordingClient()
    payload(
      await tools(a, clientA)
        .get('clerum__gfs_create_file')!
        .execute(
          { drive: 'main', parentResourceId: 'f', name: 'x', uploadedFileId: entryA!.id },
          ''
        )
    )
    expect(sent(clientA).toString()).toBe('only a')
  })

  it('refuses an id that is not one the listing gives', async () => {
    const root = rootOf('user-a')
    const client = recordingClient()
    const result = await tools(root, client)
      .get('clerum__gfs_create_file')!
      .execute({ drive: 'main', parentResourceId: 'f', name: 'x', uploadedFileId: '../x' }, '')
    expect(result.error).toMatch(/^uploadedFileId must be the 12-character id/)
    expect(clientCalls(client)).toBe(0)
  })
})

describe('the kept attachments folder', () => {
  it('is refused to file_read and file_write, directly and through a link, while a sibling file is read', async () => {
    const root = rootOf('user-a')
    await keepMessageAttachments({
      attachments: [file('a.txt', 'kept')],
      callerRoot: root,
      store: { reserveKept: async () => () => undefined },
    })
    const bin = fs.readdirSync(uploadsOf(root)).find(name => name.endsWith('.bin'))!
    fs.symlinkSync(uploadsOf(root), path.join(root, 'shortcut'))
    fs.writeFileSync(path.join(root, 'sibling.txt'), 'visible')
    const read = new FileReadTool(root)
    const write = new FileWriteTool(root)
    for (const target of [`.clerum-outputs/.uploads/${bin}`, `shortcut/${bin}`]) {
      expect((await read.execute({ path: target })).is_error, target).toBe(true)
      expect((await write.execute({ path: target, content: 'x' })).is_error, target).toBe(true)
    }
    expect(fs.readFileSync(path.join(uploadsOf(root), bin), 'utf8')).toBe('kept')
    const sibling = await read.execute({ path: 'sibling.txt' })
    expect(sibling.is_error).toBe(false)
    expect(sibling.content).toContain('visible')
  })

  it('leaves the Host base with only the users folder and the caller root with only its kept folder', async () => {
    const root = rootOf('user-a')
    const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
    const previous = process.env[ACCESS_ENV]
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    process.env[ACCESS_ENV] =
      `${header}.${Buffer.from(JSON.stringify({ scopes: ['gfs.read', 'gfs.write'] })).toString('base64url')}.sig`
    try {
      const registry = new NativeToolRegistry(
        {
          workspacePath: hostBase,
          shellTimeout: 5000,
          toolTimeout: 60000,
          toolProgressInterval: 30000,
          httpAllowlist: [],
          envAllowlist: ['PATH'],
          memoryMaxSize: 1048576,
        },
        'conv-layout',
        undefined,
        undefined,
        undefined,
        undefined,
        null,
        { maxBytes: 52_428_800 },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { root: root, room: async () => Number.MAX_SAFE_INTEGER }
      )
      const generated = await registry
        .get('clerum__generate_markdown')!
        .execute({ filename: 'layout.md', content: '# layout\n' })
      expect(generated.is_error, generated.content).toBe(false)
    } finally {
      if (previous === undefined) delete process.env[ACCESS_ENV]
      else process.env[ACCESS_ENV] = previous
    }
    const store = await openStore()
    expect(
      await keepIncomingAttachments({
        message: { sender: 'user-a', attachments: [file('kept.txt', 'kept bytes')] },
        canWriteGfs: true,
        callerRoot: root,
        store,
      })
    ).toBeUndefined()

    expect(fs.readdirSync(hostBase)).toEqual(['users'])
    expect(fs.readdirSync(root)).toEqual(['.clerum-outputs'])
    expect(fs.readdirSync(path.join(root, CALLER_OUTPUTS_DIR)).sort()).toEqual([
      '.save-ledger',
      '.uploads',
      'layout.md',
    ])
    const reserved = ['.clerum-state', '.gfs-download-store', '.gfs-downloads', '.clerum-outputs']
    for (const name of fs.readdirSync(root)) expect(reserved).toContain(name)
    // Witness: the generated file and the kept bytes are there.
    expect(fs.readFileSync(path.join(root, CALLER_OUTPUTS_DIR, 'layout.md'), 'utf8')).toContain(
      'layout'
    )
    const bin = fs.readdirSync(uploadsOf(root)).find(name => name.endsWith('.bin'))!
    expect(fs.readFileSync(path.join(uploadsOf(root), bin), 'utf8')).toBe('kept bytes')
  })
})
