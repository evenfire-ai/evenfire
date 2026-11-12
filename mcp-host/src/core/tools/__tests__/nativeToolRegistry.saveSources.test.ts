// Saving a file by sourcePath, generatedFile or uploadedFileId through the
// registry the turn builds: the Host's protected values and the caller's
// workspace reach the save tools, and the real gfsc client sends one create
// request only for a file that holds no protected value.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Attachment } from '../../../core/types'
import { FILE_CONTAINS_SECRET, keepMessageAttachments } from '../../../internalTools/keptFiles'
import { CALLER_OUTPUTS_DIR } from '../../../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import { NativeToolRegistry } from '../nativeToolRegistry'

const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]
const SYNTHETIC_SECRET = { name: 'SYNTHETIC_API_KEY', value: 'synthetic-value-7Qk2Lm9Xw4' }
const CREATE = 'clerum__gfs_create_file'

interface CreateRequest {
  url: string
  body: { name: string; kind: string; contentBase64?: string }
}

let hostBase: string
let provider: ScopedWorkspaceProvider
let requests: CreateRequest[]

beforeEach(() => {
  hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-save-sources-')))
  provider = new ScopedWorkspaceProvider(hostBase)
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({ scopes: ['gfs.read', 'gfs.write'] })).toString(
    'base64url'
  )
  process.env[ACCESS_ENV] = `${header}.${claims}.sig`
  requests = []
  // An in-memory gfsc writer: every create of a child file is recorded and answered.
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    if (init?.method !== 'POST' || !/\/v1\/resources\/[^/]+\/children\?/.test(target)) {
      return new Response('unexpected request', { status: 500 })
    }
    requests.push({ url: target, body: JSON.parse(String(init.body)) as CreateRequest['body'] })
    return new Response(JSON.stringify({ resourceId: `created-${requests.length}` }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
  fs.rmSync(hostBase, { recursive: true, force: true })
})

function callerRoot(): string {
  const binding = resolveCallerRootBinding(provider, { sender: 'save-caller', channelType: 'rpc' })
  if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
  return binding.root
}

/** The registry as TaskExecutor builds it for a chat turn with a caller workspace. */
function registryFor(root: string): NativeToolRegistry {
  return new NativeToolRegistry(
    {
      workspacePath: hostBase,
      shellTimeout: 5000,
      toolTimeout: 60000,
      toolProgressInterval: 30000,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1048576,
    },
    'conv-save-sources',
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    { maxBytes: 52_428_800, secretEntriesProvider: () => [SYNTHETIC_SECRET] },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      deliveryAvailable: false,
      callerIdentity: path.basename(root),
      callerWorkspacePath: root,
    },
    root
  )
}

async function create(root: string, source: Record<string, unknown>) {
  const tool = registryFor(root).get(CREATE)
  if (!tool) throw new Error(`${CREATE} is not registered`)
  return tool.execute({ drive: 'main', parentResourceId: 'folder', name: 'saved.txt', ...source })
}

function textAttachment(name: string, text: string): Attachment {
  return {
    id: `file-${name}`,
    kind: 'file',
    mimeType: 'text/plain',
    encoding: 'base64',
    dataBase64: Buffer.from(text).toString('base64'),
    filename: name,
  }
}

/** Keeps one text attachment for the caller and returns the id the listing gives it. */
async function keptUpload(root: string, name: string, text: string): Promise<string> {
  const refusal = await keepMessageAttachments({
    attachments: [textAttachment(name, text)],
    callerRoot: root,
    store: { reserveKept: async () => () => undefined },
  })
  expect(refusal).toBeUndefined()
  const listing = await registryFor(root).get('clerum__kept_files_list')!.execute({})
  const files = (JSON.parse(listing.content) as { files: Array<{ id?: string; name: string }> })
    .files
  const id = files.find(entry => entry.name === name)?.id
  if (!id) throw new Error(`kept upload ${name} is not listed`)
  return id
}

describe('saving through the registry', () => {
  it('refuses a workspace file that holds a protected value and sends nothing', async () => {
    const root = callerRoot()
    fs.writeFileSync(path.join(root, 'report.txt'), `key=${SYNTHETIC_SECRET.value}\n`)
    const output = await create(root, { sourcePath: 'report.txt' })
    expect(output.is_error).toBe(true)
    expect(output.content).toContain(FILE_CONTAINS_SECRET)
    expect(requests).toHaveLength(0)
  })

  it('saves a clean workspace file with one create request carrying its bytes', async () => {
    const root = callerRoot()
    fs.writeFileSync(path.join(root, 'clean.txt'), 'quarterly figures\n')
    const output = await create(root, { sourcePath: 'clean.txt' })
    expect(output.is_error, output.content).toBe(false)
    expect(JSON.parse(output.content)).toMatchObject({ secretScan: { state: 'scanned' } })
    expect(requests).toHaveLength(1)
    expect(Buffer.from(requests[0].body.contentBase64!, 'base64').toString()).toBe(
      'quarterly figures\n'
    )
  })

  it('refuses a generated file with no record that holds a protected value', async () => {
    const root = callerRoot()
    const outputs = path.join(root, CALLER_OUTPUTS_DIR)
    fs.mkdirSync(outputs, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(outputs, 'notes.md'), `# Notes\n${SYNTHETIC_SECRET.value}\n`)
    const output = await create(root, { generatedFile: 'notes.md', name: 'notes.md' })
    expect(output.is_error).toBe(true)
    expect(output.content).toContain(FILE_CONTAINS_SECRET)
    expect(requests).toHaveLength(0)
  })

  it('refuses a kept upload that holds a protected value', async () => {
    const root = callerRoot()
    const id = await keptUpload(root, 'secret.txt', `token ${SYNTHETIC_SECRET.value}\n`)
    const output = await create(root, { uploadedFileId: id })
    expect(output.is_error).toBe(true)
    expect(output.content).toContain(FILE_CONTAINS_SECRET)
    expect(requests).toHaveLength(0)
  })

  it('saves a clean kept upload with one create request', async () => {
    const root = callerRoot()
    const id = await keptUpload(root, 'clean.txt', 'kept notes\n')
    const output = await create(root, { uploadedFileId: id })
    expect(output.is_error, output.content).toBe(false)
    expect(requests).toHaveLength(1)
    expect(Buffer.from(requests[0].body.contentBase64!, 'base64').toString()).toBe('kept notes\n')
  })
})
