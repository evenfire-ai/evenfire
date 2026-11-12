// Saving a generated file or a workspace file to GFS: the Host reads the bytes
// from the caller's own folders, checks them, scans them and uploads them; the
// model never carries the content. Every refusal sends nothing to GFS.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import JSZip from 'jszip'
import * as os from 'os'
import * as path from 'path'
import { GFS_WORKSPACE_FILE_GUIDANCE_TEXT } from '../core/reasoning/promptBuilder'
import { NativeToolRegistry } from '../core/tools/nativeToolRegistry'
import { ShellTool } from '../core/tools/shell'
import type { ToolOutput } from '../core/types'
import type { InternalToolDefinition, InternalToolResult } from '../workflow/types'
import { CALLER_OUTPUTS_DIR } from '../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../workspace/scopedWorkspace'
import { type GfscWriteClient, buildGfsWriteTools, buildKeptFilesListTool } from './gfs'
import { GfscHttpError } from './gfsClient'
import {
  DOWNLOADS_HINT,
  FILE_CONTAINS_SECRET,
  HAS_SAVE_ID,
  KEPT_FILES_UNAVAILABLE,
  NO_SAVE_ID,
  SAVE_LEDGER_DIR,
  SCAN_TEXT_MAX_BYTES,
  SOURCE_PATH_INVALID,
  SOURCE_PATH_UNAVAILABLE,
  WITHHELD_SENTENCE,
  keptFileNotFound,
  ledgerRecordFileName,
  listKeptFiles,
  nameFormatMismatch,
} from './keptFiles'

// A roomy volume: the generators' free-space floor never refuses here.
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

const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]
const SYNTHETIC = 'synthetic-save-probe-value'
const SPLIT = 'synthetic-save-**probe**-value'

type Secrets = Array<{ name: string; value: string }>

function recordingClient(): GfscWriteClient {
  return {
    list: vi.fn(),
    accessible: vi.fn(),
    read: vi.fn(),
    stat: vi.fn(),
    resolve: vi.fn(),
    write: vi.fn(async () => ({ version: 2 })),
    writeBytes: vi.fn(async () => ({ version: 5 })),
    createFile: vi.fn(async () => ({ resourceId: 'created' })),
    createFileFromBytes: vi.fn(async () => ({ resourceId: 'created' })),
    createFolder: vi.fn(),
    rename: vi.fn(),
    copy: vi.fn(),
  } as unknown as GfscWriteClient
}

function calls(client: GfscWriteClient): number {
  return (
    vi.mocked(client.write).mock.calls.length +
    vi.mocked(client.writeBytes).mock.calls.length +
    vi.mocked(client.createFile).mock.calls.length +
    vi.mocked(client.createFileFromBytes).mock.calls.length
  )
}

function sentBytes(client: GfscWriteClient): Buffer {
  const create = vi.mocked(client.createFileFromBytes).mock.calls
  const write = vi.mocked(client.writeBytes).mock.calls
  const last = (create.at(-1)?.[0] ?? write.at(-1)?.[0]) as { contentBase64: string }
  return Buffer.from(last.contentBase64, 'base64')
}

function payload(result: InternalToolResult): Record<string, unknown> {
  expect(result.success, result.error).toBe(true)
  return JSON.parse(result.content!) as Record<string, unknown>
}

async function docx(text: string): Promise<Buffer> {
  const z = new JSZip()
  z.file('[Content_Types].xml', '<Types/>')
  z.file('word/document.xml', `<w:document><w:t>${text}</w:t></w:document>`)
  return z.generateAsync({ type: 'nodebuffer' })
}

let hostBase: string
let provider: ScopedWorkspaceProvider
let outside: string

beforeEach(() => {
  hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-kept-sources-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-kept-outside-')))
  provider = new ScopedWorkspaceProvider(hostBase)
  process.env[ACCESS_ENV] = (() => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ scopes: ['gfs.read', 'gfs.write'] })).toString(
      'base64url'
    )
    return `${header}.${body}.sig`
  })()
})

afterEach(() => {
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
  fs.rmSync(hostBase, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function rootOf(userId: string): string {
  const binding = resolveCallerRootBinding(provider, { sender: userId, channelType: 'rpc' })
  if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
  return binding.root
}

function outputsOf(root: string): string {
  return path.join(root, CALLER_OUTPUTS_DIR)
}

function registryFor(root: string, secrets: Secrets = []): NativeToolRegistry {
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
    'conv-sources',
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    { maxBytes: 52_428_800, secretEntriesProvider: () => secrets },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    root
  )
}

async function generate(
  root: string,
  tool: string,
  args: Record<string, unknown>,
  secrets: Secrets = []
): Promise<{ output: ToolOutput; id?: string }> {
  const output = await registryFor(root, secrets).get(tool)!.execute(args)
  expect(output.is_error, output.content).toBe(false)
  const id = /\nSave id: ([0-9a-f]{12})/.exec(output.content)?.[1]
  return { output, id }
}

function writeTools(
  root: string | undefined,
  client: GfscWriteClient,
  secrets: Secrets = [],
  workspace: string | undefined = root
): Map<string, InternalToolDefinition> {
  return new Map(
    buildGfsWriteTools(client, {
      callerRoot: root,
      callerWorkspacePath: workspace,
      secretEntries: () => secrets,
    }).map(tool => [tool.name, tool])
  )
}

function create(
  tools: Map<string, InternalToolDefinition>,
  args: Record<string, unknown>
): Promise<InternalToolResult> {
  return tools
    .get('clerum__gfs_create_file')!
    .execute({ drive: 'main', parentResourceId: 'folder', name: 'out.bin', ...args }, '')
}

function replace(
  tools: Map<string, InternalToolDefinition>,
  args: Record<string, unknown>
): Promise<InternalToolResult> {
  return tools
    .get('clerum__gfs_write')!
    .execute({ drive: 'main', resourceId: 'rid', ifMatch: 3, ...args }, '')
}

const GENERATIONS = [
  ['clerum__generate_markdown', 'r.md', { content: '# report\n' }, 'scanned'],
  ['clerum__generate_docx', 'r.docx', { title: 'Report', body: 'Hello' }, 'scanned'],
  ['clerum__generate_xlsx', 'r.xlsx', { sheets: [{ name: 'S', rows: [['a'], ['b']] }] }, 'scanned'],
  [
    'clerum__generate_pptx',
    'r.pptx',
    { slides: [{ layout: 'title-bullets', title: 'Deck', bullets: ['a'] }] },
    'scanned',
  ],
  ['clerum__generate_pdf', 'r.pdf', { body: 'Hello' }, 'binary_format'],
  [
    'clerum__generate_chart',
    'r.png',
    { type: 'bar', data: { labels: ['A'], datasets: [{ label: 'S', data: [1] }] } },
    'binary_format',
  ],
] as const

describe('saving a generated file', () => {
  it.each(GENERATIONS)(
    '%s: sends the bytes the chat received',
    async (tool, filename, args, scan) => {
      const root = rootOf('user-a')
      const { output, id } = await generate(root, tool, { filename, ...args })
      expect(id).toBeDefined()
      const client = recordingClient()
      const result = await create(writeTools(root, client), {
        name: filename,
        generatedFile: filename,
        generatedFileId: id,
      })
      const body = payload(result)
      expect(body.source).toBe('generated_file')
      expect(body.secretScan).toEqual(
        scan === 'scanned' ? { state: 'scanned' } : { state: 'not_scanned', reason: scan }
      )
      expect(calls(client)).toBe(1)
      expect(
        sentBytes(client).equals(Buffer.from(output.attachments![0]!.dataBase64!, 'base64'))
      ).toBe(true)
      if (filename.endsWith('.pdf'))
        expect(sentBytes(client).subarray(0, 5).toString()).toBe('%PDF-')
    }
  )

  it('sends the redacted bytes of a markdown file that prints an entry whole', async () => {
    const root = rootOf('user-a')
    const secrets = [{ name: 'PROBE', value: SYNTHETIC }]
    const { id } = await generate(
      root,
      'clerum__generate_markdown',
      { filename: 'r.md', content: `key ${SYNTHETIC}\n` },
      secrets
    )
    const client = recordingClient()
    payload(
      await create(writeTools(root, client, secrets), {
        name: 'r.md',
        generatedFile: 'r.md',
        generatedFileId: id,
      })
    )
    expect(sentBytes(client).toString('utf8')).toBe('key [REDACTED:PROBE]\n')
  })

  it('replaces a file with ifMatch, and reports a version conflict after one call', async () => {
    const root = rootOf('user-a')
    const { id } = await generate(root, 'clerum__generate_markdown', {
      filename: 'r.md',
      content: '# a\n',
    })
    const client = recordingClient()
    payload(await replace(writeTools(root, client), { generatedFile: 'r.md', generatedFileId: id }))
    expect(vi.mocked(client.writeBytes).mock.calls[0]![0]).toMatchObject({
      drive: 'main',
      resourceId: 'rid',
      ifMatch: 3,
    })
    const conflicted = recordingClient()
    vi.mocked(conflicted.writeBytes).mockRejectedValueOnce(new GfscHttpError(409, 'conflict'))
    const refused = await replace(writeTools(root, conflicted), {
      generatedFile: 'r.md',
      generatedFileId: id,
    })
    expect(refused.success).toBe(false)
    expect(refused.error).toContain('gfsc 409: conflict')
    expect(calls(conflicted)).toBe(1)
  })

  it('saves the same bytes from a later conversation', async () => {
    const root = rootOf('user-a')
    const { output, id } = await generate(root, 'clerum__generate_markdown', {
      filename: 'r.md',
      content: '# a\n',
    })
    // A new set of tools, as a new registry builds for a later conversation.
    const client = recordingClient()
    payload(
      await create(writeTools(root, client), {
        name: 'r.md',
        generatedFile: 'r.md',
        generatedFileId: id,
      })
    )
    expect(
      sentBytes(client).equals(Buffer.from(output.attachments![0]!.dataBase64!, 'base64'))
    ).toBe(true)
  })

  it('refuses an id that is not the latest generation of the name', async () => {
    const root = rootOf('user-a')
    const first = await generate(root, 'clerum__generate_markdown', {
      filename: 'r.md',
      content: '# one\n',
    })
    const client = recordingClient()
    const wrong = await create(writeTools(root, client), {
      name: 'r.md',
      generatedFile: 'r.md',
      generatedFileId: '0123456789ab',
    })
    expect(wrong.error).toMatch(/^kept_file_replaced: /)
    payload(
      await create(writeTools(root, client), {
        name: 'r.md',
        generatedFile: 'r.md',
        generatedFileId: first.id,
      })
    )
    expect(calls(client)).toBe(1)

    const second = await generate(root, 'clerum__generate_markdown', {
      filename: 'r.md',
      content: '# two\n',
    })
    const stale = await create(writeTools(root, client), {
      name: 'r.md',
      generatedFile: 'r.md',
      generatedFileId: first.id,
    })
    expect(stale.error).toMatch(
      /^kept_file_replaced: a newer file was generated under this name at /
    )
    expect(calls(client)).toBe(1)
    payload(
      await create(writeTools(root, client), {
        name: 'r.md',
        generatedFile: 'r.md',
        generatedFileId: second.id,
      })
    )
    expect(sentBytes(client).toString('utf8')).toContain('two')
  })

  it('refuses a withheld file with its reason and a sentence the model can relay', async () => {
    const root = rootOf('user-a')
    const secrets = [{ name: 'PROBE', value: SYNTHETIC }]
    await generate(
      root,
      'clerum__generate_pdf',
      { filename: 'h.pdf', body: `v ${SYNTHETIC}` },
      secrets
    )
    const record = JSON.parse(
      fs.readFileSync(
        path.join(outputsOf(root), SAVE_LEDGER_DIR, ledgerRecordFileName('h.pdf')),
        'utf8'
      )
    )
    const client = recordingClient()
    const result = await create(writeTools(root, client, secrets), {
      name: 'h.pdf',
      generatedFile: 'h.pdf',
      generatedFileId: record.id,
    })
    expect(result.error).toBe(`kept_file_withheld (${record.outcome}): ${WITHHELD_SENTENCE}`)
    expect(calls(client)).toBe(0)
  })

  it('refuses a file whose bytes or whose protected values changed since it was generated', async () => {
    const root = rootOf('user-a')
    const before = [{ name: 'OLD', value: 'synthetic-old-entry-value' }]
    const { id } = await generate(
      root,
      'clerum__generate_markdown',
      { filename: 'r.md', content: 'prefix-word-1234 x synthetic-old-entry-value y\n' },
      before
    )
    const client = recordingClient()
    const save = (secrets: Secrets) =>
      create(writeTools(root, client, secrets), {
        name: 'r.md',
        generatedFile: 'r.md',
        generatedFileId: id,
      })
    // Unchanged: saves.
    payload(await save(before))
    // An entry removed: the redacted bytes differ from what the chat received.
    expect((await save([])).error).toMatch(/^kept_file_changed: /)
    // An entry added that redaction changes.
    expect((await save([...before, { name: 'NEW', value: 'prefix-word-1234' }])).error).toMatch(
      /^kept_file_changed: /
    )
    // The file itself changed.
    fs.appendFileSync(path.join(outputsOf(root), 'r.md'), 'more\n')
    expect((await save(before)).error).toMatch(/^kept_file_changed: /)
    expect(calls(client)).toBe(1)
  })

  it('refuses a markdown file that shows a later entry only split by markup', async () => {
    const root = rootOf('user-a')
    const { id } = await generate(root, 'clerum__generate_markdown', {
      filename: 'r.md',
      content: `k ${SPLIT}\n`,
    })
    const client = recordingClient()
    payload(
      await create(writeTools(root, client), {
        name: 'r.md',
        generatedFile: 'r.md',
        generatedFileId: id,
      })
    )
    const result = await create(
      writeTools(root, client, [{ name: 'P', value: 'synthetic-save-probe-value' }]),
      {
        name: 'r.md',
        generatedFile: 'r.md',
        generatedFileId: id,
      }
    )
    expect(result.error).toBe(FILE_CONTAINS_SECRET)
    expect(calls(client)).toBe(1)
  })

  it('refuses a new GFS name whose ending is not the generated format, and names the right one', async () => {
    const root = rootOf('user-a')
    const { id } = await generate(root, 'clerum__generate_docx', {
      filename: 'r.docx',
      title: 'T',
      body: 'B',
    })
    const client = recordingClient()
    const wrong = await create(writeTools(root, client), {
      name: 'x.pdf',
      generatedFile: 'r.docx',
      generatedFileId: id,
    })
    expect(wrong.error).toBe(nameFormatMismatch('docx').error)
    expect(wrong.error).toContain('.docx')
    expect(calls(client)).toBe(0)
    payload(
      await create(writeTools(root, client), {
        name: 'x.docx',
        generatedFile: 'r.docx',
        generatedFileId: id,
      })
    )
  })

  it('saves a file with no record by its name, through the scan', async () => {
    const root = rootOf('user-a')
    await generate(root, 'clerum__generate_dashboard', {
      filename: 'd.html',
      data: { title: 'Review', charts: [] },
    })
    const client = recordingClient()
    const tools = writeTools(root, client)
    const body = payload(await create(tools, { name: 'd.html', generatedFile: 'd.html' }))
    expect(body).toMatchObject({ source: 'generated_file', secretScan: { state: 'scanned' } })
    expect(sentBytes(client).equals(fs.readFileSync(path.join(outputsOf(root), 'd.html')))).toBe(
      true
    )
    // The same name with an id it does not have is an argument to correct.
    const withId = await create(tools, {
      name: 'd.html',
      generatedFile: 'd.html',
      generatedFileId: '0123456789ab',
    })
    expect(withId.error).toBe(NO_SAVE_ID)
    // An id for a name with no file at all.
    expect(
      (
        await create(tools, {
          name: 'n.md',
          generatedFile: 'none.md',
          generatedFileId: '0123456789ab',
        })
      ).error
    ).toBe(keptFileNotFound().error)
    expect(calls(client)).toBe(1)
  })

  it('scans a file with no record: a secret refuses it, an image uploads unscanned', async () => {
    const root = rootOf('user-a')
    const out = outputsOf(root)
    fs.mkdirSync(out, { mode: 0o700 })
    fs.writeFileSync(path.join(out, 'old.md'), `k ${SYNTHETIC}\n`)
    fs.writeFileSync(
      path.join(out, 'old.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    )
    const client = recordingClient()
    const tools = writeTools(root, client, [{ name: 'P', value: SYNTHETIC }])
    expect((await create(tools, { name: 'old.md', generatedFile: 'old.md' })).error).toBe(
      FILE_CONTAINS_SECRET
    )
    expect(
      payload(await create(tools, { name: 'old.png', generatedFile: 'old.png' })).secretScan
    ).toEqual({
      state: 'not_scanned',
      reason: 'binary_format',
    })
    expect(calls(client)).toBe(1)
  })

  it('refuses a recorded file named without its id, before opening it', async () => {
    const root = rootOf('user-a')
    const { id } = await generate(root, 'clerum__generate_markdown', {
      filename: 'r.md',
      content: '# a\n',
    })
    // Unreadable: a read would fail with a read error, not with the argument text.
    fs.chmodSync(path.join(outputsOf(root), 'r.md'), 0o000)
    const client = recordingClient()
    try {
      expect(
        (await create(writeTools(root, client), { name: 'r.md', generatedFile: 'r.md' })).error
      ).toBe(HAS_SAVE_ID)
    } finally {
      fs.chmodSync(path.join(outputsOf(root), 'r.md'), 0o600)
    }
    expect(calls(client)).toBe(0)
    payload(
      await create(writeTools(root, client), {
        name: 'r.md',
        generatedFile: 'r.md',
        generatedFileId: id,
      })
    )
  })

  it('settles at once on a FIFO planted as a generated file or as its record', async () => {
    const root = rootOf('user-a')
    const { id } = await generate(root, 'clerum__generate_markdown', {
      filename: 'r.md',
      content: '# a\n',
    })
    const out = outputsOf(root)
    execFileSync('mkfifo', [path.join(out, 'pipe.md')])
    fs.rmSync(path.join(out, SAVE_LEDGER_DIR, ledgerRecordFileName('r.md')))
    execFileSync('mkfifo', [path.join(out, SAVE_LEDGER_DIR, ledgerRecordFileName('r.md'))])
    const client = recordingClient()
    const tools = writeTools(root, client)
    const started = Date.now()
    expect((await create(tools, { name: 'p.md', generatedFile: 'pipe.md' })).error).toBe(
      keptFileNotFound().error
    )
    // The record is a FIFO, so the file reads as one with no record: the id is refused.
    expect(
      (await create(tools, { name: 'r.md', generatedFile: 'r.md', generatedFileId: id })).error
    ).toBe(NO_SAVE_ID)
    expect(listKeptFiles(root).map(entry => entry.name)).toEqual(['r.md'])
    expect(Date.now() - started).toBeLessThan(1000)
    expect(calls(client)).toBe(0)
  })
})

describe('saving a workspace file', () => {
  function seed(root: string, rel: string, data: string | Buffer): void {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), data)
  }

  it('uploads a file at the root or nested, scanned from its bytes', async () => {
    const root = rootOf('user-a')
    seed(root, 'notes.txt', 'plain notes\n')
    seed(root, 'outputs/deep/report.docx', await docx('quarterly'))
    const client = recordingClient()
    const tools = writeTools(root, client, [{ name: 'P', value: SYNTHETIC }])
    expect(payload(await create(tools, { name: 'n.txt', sourcePath: 'notes.txt' }))).toMatchObject({
      source: 'source_path',
      bytes: 12,
      secretScan: { state: 'scanned' },
    })
    expect(
      payload(await create(tools, { name: 'r.docx', sourcePath: 'outputs/deep/report.docx' }))
    ).toMatchObject({
      source: 'source_path',
      secretScan: { state: 'scanned' },
    })
    expect(
      sentBytes(client).equals(fs.readFileSync(path.join(root, 'outputs/deep/report.docx')))
    ).toBe(true)
  })

  it('refuses text and an Office file holding an entry, whole or split by markup', async () => {
    const root = rootOf('user-a')
    seed(root, 'a.txt', `k ${SYNTHETIC}\n`)
    seed(root, 'b.md', `k ${SPLIT}\n`)
    seed(root, 'c.docx', await docx(`k ${SYNTHETIC}`))
    seed(root, 'clean.docx', await docx('k none'))
    const client = recordingClient()
    const tools = writeTools(root, client, [{ name: 'P', value: SYNTHETIC }])
    for (const rel of ['a.txt', 'b.md', 'c.docx']) {
      expect((await create(tools, { name: 'x', sourcePath: rel })).error, rel).toBe(
        FILE_CONTAINS_SECRET
      )
    }
    expect(calls(client)).toBe(0)
    payload(await create(tools, { name: 'x', sourcePath: 'clean.docx' }))
    expect(calls(client)).toBe(1)
  })

  it('refuses absolute paths, .., links out of the root, reserved folders and a hidden first part', async () => {
    const root = rootOf('user-a')
    seed(root, 'ok.txt', 'ok\n')
    seed(root, '.config/x', 'cfg\n')
    seed(root, '.env', 'A=1\n')
    fs.writeFileSync(path.join(outside, 'target.txt'), 'outside\n')
    fs.symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'link.txt'))
    fs.symlinkSync(outside, path.join(root, 'linkdir'))
    await generate(root, 'clerum__generate_markdown', { filename: 'report.md', content: '# r\n' })
    const client = recordingClient()
    const tools = writeTools(root, client)
    for (const rel of [
      path.join(root, 'ok.txt'),
      '../ok.txt',
      'link.txt',
      'linkdir/target.txt',
      '.config/x',
      '.env',
      '.clerum-outputs/report.md',
      `${CALLER_OUTPUTS_DIR}/${SAVE_LEDGER_DIR}/${ledgerRecordFileName('report.md')}`,
    ]) {
      expect((await create(tools, { name: 'x', sourcePath: rel })).error, rel).toBe(
        SOURCE_PATH_INVALID
      )
    }
    expect(calls(client)).toBe(0)
    payload(await create(tools, { name: 'x', sourcePath: 'ok.txt' }))
    expect(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe('outside\n')
  })

  it('takes a hidden part deeper in the path, and still scans it', async () => {
    const root = rootOf('user-a')
    seed(root, 'repo/.github/workflows/ci.yml', 'on: push\n')
    seed(root, 'a/.b/c', 'c\n')
    seed(root, 'repo/.env.example', `TOKEN=${SYNTHETIC}\n`)
    const client = recordingClient()
    const tools = writeTools(root, client, [{ name: 'P', value: SYNTHETIC }])
    payload(await create(tools, { name: 'ci.yml', sourcePath: 'repo/.github/workflows/ci.yml' }))
    payload(await create(tools, { name: 'c', sourcePath: 'a/.b/c' }))
    expect((await create(tools, { name: 'e', sourcePath: 'repo/.env.example' })).error).toBe(
      FILE_CONTAINS_SECRET
    )
    expect(calls(client)).toBe(2)
  })

  it('answers a path into .gfs-downloads with the way to save a changed copy', async () => {
    const root = rootOf('user-a')
    seed(root, '.gfs-downloads/t1/data.csv', 'a,b\n1,2\n')
    seed(root, 'x/.gfs-downloads/y', 'y\n')
    seed(root, '.config/x', 'cfg\n')
    const client = recordingClient()
    const tools = writeTools(root, client)
    expect(
      (await create(tools, { name: 'd', sourcePath: '.gfs-downloads/t1/data.csv' })).error
    ).toBe(DOWNLOADS_HINT)
    expect((await create(tools, { name: 'd', sourcePath: 'x/.gfs-downloads/y' })).error).toBe(
      DOWNLOADS_HINT
    )
    expect((await create(tools, { name: 'd', sourcePath: '.config/x' })).error).toBe(
      SOURCE_PATH_INVALID
    )
    expect(calls(client)).toBe(0)
    // The same bytes written outside the downloads upload.
    seed(root, 'outputs/data.csv', fs.readFileSync(path.join(root, '.gfs-downloads/t1/data.csv')))
    expect(payload(await create(tools, { name: 'd', sourcePath: 'outputs/data.csv' })).source).toBe(
      'source_path'
    )
  })

  it('reports a missing file as invalid and a file it cannot read with its code', async () => {
    const root = rootOf('user-a')
    seed(root, 'locked.txt', 'locked\n')
    const client = recordingClient()
    const tools = writeTools(root, client)
    expect((await create(tools, { name: 'm', sourcePath: 'missing.txt' })).error).toBe(
      SOURCE_PATH_INVALID
    )
    fs.chmodSync(path.join(root, 'locked.txt'), 0o000)
    try {
      expect((await create(tools, { name: 'l', sourcePath: 'locked.txt' })).error).toBe(
        'could not read the file (EACCES)'
      )
    } finally {
      fs.chmodSync(path.join(root, 'locked.txt'), 0o600)
    }
    expect(calls(client)).toBe(0)
    payload(await create(tools, { name: 'l', sourcePath: 'locked.txt' }))
  })

  it('scans a file from its bytes, not from its name', async () => {
    const root = rootOf('user-a')
    seed(root, 'text.docx', `k ${SYNTHETIC}\n`)
    seed(root, 'clean-text.docx', 'k none\n')
    seed(
      root,
      'zip.txt',
      await (async () => {
        const z = new JSZip()
        z.file('a.txt', SYNTHETIC)
        return z.generateAsync({ type: 'nodebuffer' })
      })()
    )
    seed(root, 'doc.png', await docx(`k ${SYNTHETIC}`))
    seed(root, 'clean-doc.png', await docx('k none'))
    const client = recordingClient()
    const tools = writeTools(root, client, [{ name: 'P', value: SYNTHETIC }])
    expect((await create(tools, { name: 'x', sourcePath: 'text.docx' })).error).toBe(
      FILE_CONTAINS_SECRET
    )
    expect((await create(tools, { name: 'x', sourcePath: 'doc.png' })).error).toBe(
      FILE_CONTAINS_SECRET
    )
    expect(
      payload(await create(tools, { name: 'x', sourcePath: 'clean-text.docx' })).secretScan
    ).toEqual({ state: 'scanned' })
    expect(
      payload(await create(tools, { name: 'x', sourcePath: 'clean-doc.png' })).secretScan
    ).toEqual({ state: 'scanned' })
    expect(payload(await create(tools, { name: 'x', sourcePath: 'zip.txt' })).secretScan).toEqual({
      state: 'not_scanned',
      reason: 'binary_format',
    })
  })

  it('scans text of exactly 4 MiB and uploads one byte more unscanned', async () => {
    const root = rootOf('user-a')
    const tail = ` ${SYNTHETIC}\n`
    const exact = Buffer.alloc(SCAN_TEXT_MAX_BYTES, 0x61)
    exact.write(tail, SCAN_TEXT_MAX_BYTES - tail.length)
    seed(root, 'exact.txt', exact)
    seed(root, 'over.txt', Buffer.concat([Buffer.from('a'), exact]))
    const client = recordingClient()
    const tools = writeTools(root, client, [{ name: 'P', value: SYNTHETIC }])
    expect((await create(tools, { name: 'x', sourcePath: 'exact.txt' })).error).toBe(
      FILE_CONTAINS_SECRET
    )
    expect(payload(await create(tools, { name: 'x', sourcePath: 'over.txt' })).secretScan).toEqual({
      state: 'not_scanned',
      reason: 'too_large_to_scan',
    })
  })
})

describe('choosing the source of a write', () => {
  it('takes exactly one source, and an id only with generatedFile', async () => {
    const root = rootOf('user-a')
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
    const client = recordingClient()
    const tools = writeTools(root, client)
    const one = 'give exactly one of content, generatedFile, sourcePath'
    expect((await create(tools, {})).error).toBe(one)
    expect((await create(tools, { content: 'x', sourcePath: 'a.txt' })).error).toBe(one)
    expect(
      (await create(tools, { sourcePath: 'a.txt', generatedFileId: '0123456789ab' })).error
    ).toBe(one)
    expect((await replace(tools, { content: 'x', generatedFile: 'a.md' })).error).toBe(one)
    expect(calls(client)).toBe(0)
    payload(await create(tools, { sourcePath: 'a.txt' }))
    expect(calls(client)).toBe(1)
  })

  it('creates an empty file from empty content, as before', async () => {
    const root = rootOf('user-a')
    const client = recordingClient()
    payload(await create(writeTools(root, client), { name: 'empty.txt', content: '' }))
    expect(vi.mocked(client.createFile).mock.calls).toEqual([
      [
        { drive: 'main', parentResourceId: 'folder', name: 'empty.txt', content: '' },
        expect.anything(),
      ],
    ])
  })

  it('answers that the sources are unavailable without a caller folder', async () => {
    const client = recordingClient()
    const tools = writeTools(undefined, client)
    expect(
      (await create(tools, { generatedFile: 'r.md', generatedFileId: '0123456789ab' })).error
    ).toBe(KEPT_FILES_UNAVAILABLE)
    expect((await create(tools, { sourcePath: 'a.txt' })).error).toBe(SOURCE_PATH_UNAVAILABLE)
    expect(calls(client)).toBe(0)
    // The tools are still there for content.
    payload(await create(tools, { name: 'n.txt', content: 'n' }))
  })

  it('reports a body gfsc refuses as too large', async () => {
    const root = rootOf('user-a')
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
    const client = recordingClient()
    vi.mocked(client.createFileFromBytes).mockRejectedValueOnce(new GfscHttpError(413, 'too large'))
    const result = await create(writeTools(root, client), { sourcePath: 'a.txt' })
    expect(result.error).toContain('gfsc 413: limit_exceeded')
    expect(calls(client)).toBe(1)
  })

  it('keeps the schema and behaviour of the workflow runtime, which passes no sources', async () => {
    const client = recordingClient()
    const tools = new Map(buildGfsWriteTools(client).map(tool => [tool.name, tool]))
    const schema = tools.get('clerum__gfs_create_file')!.parameters as {
      required: string[]
      properties: object
    }
    expect(schema.required).toEqual(['drive', 'parentResourceId', 'name', 'content'])
    expect(Object.keys(schema.properties)).not.toContain('sourcePath')
    payload(await create(tools, { name: 'n.txt', content: 'n', sourcePath: 'ignored' }))
    expect(vi.mocked(client.createFile)).toHaveBeenCalledTimes(1)
  })
})

describe('the kept-files listing', () => {
  async function list(root: string | undefined, args: Record<string, unknown> = {}) {
    const result = await buildKeptFilesListTool(root).execute(args, '')
    return payload(result) as {
      files: Array<Record<string, unknown>>
      truncated: boolean
    }
  }

  function seedFiles(root: string, count: number, prefix = 'f'): void {
    const out = outputsOf(root)
    fs.mkdirSync(out, { recursive: true, mode: 0o700 })
    for (let n = 0; n < count; n++) {
      const file = path.join(out, `${prefix}-${String(n).padStart(3, '0')}.md`)
      fs.writeFileSync(file, `# ${n}\n`)
      const at = new Date(Date.UTC(2026, 0, 1, 0, n))
      fs.utimesSync(file, at, at)
    }
  }

  it('lists delivered, withheld and unrecorded files with exactly their fields', async () => {
    const root = rootOf('user-a')
    const secrets = [{ name: 'P', value: SYNTHETIC }]
    const { id } = await generate(root, 'clerum__generate_markdown', {
      filename: 'a.md',
      content: '# a\n',
    })
    await generate(
      root,
      'clerum__generate_pdf',
      { filename: 'b.pdf', body: `v ${SYNTHETIC}` },
      secrets
    )
    await generate(root, 'clerum__generate_dashboard', {
      filename: 'c.html',
      data: { title: 'T', charts: [] },
    })
    const { files, truncated } = await list(root)
    expect(truncated).toBe(false)
    const byName = new Map(files.map(file => [file.name, file]))
    expect(Object.keys(byName.get('a.md')!).sort()).toEqual(
      ['canSave', 'createdAt', 'format', 'id', 'kind', 'name', 'sizeBytes'].sort()
    )
    expect(byName.get('a.md')).toMatchObject({ kind: 'generated', id, format: 'md', canSave: true })
    expect(byName.get('b.pdf')).toMatchObject({
      format: 'pdf',
      canSave: false,
      reason: 'binary_redaction_unavailable',
    })
    expect(byName.get('b.pdf')!.id).toMatch(/^[0-9a-f]{12}$/)
    expect(byName.get('c.html')).toMatchObject({
      format: 'html',
      canSave: true,
      reason: 'no_record',
    })
    expect(byName.get('c.html')).not.toHaveProperty('id')
    expect(JSON.stringify(files)).not.toContain(root)
  })

  it('lists the oldest first, at most 100, and finds any file by part of its name', async () => {
    const root = rootOf('user-a')
    seedFiles(root, 101)
    const first = await list(root)
    expect(first.files).toHaveLength(100)
    expect(first.truncated).toBe(true)
    expect(first.files[0]!.name).toBe('f-000.md')
    expect(first.files.map(file => file.name)).not.toContain('f-100.md')
    const found = await list(root, { nameContains: 'F-100' })
    expect(found.files.map(file => file.name)).toEqual(['f-100.md'])
    expect(found.truncated).toBe(false)
    expect(listKeptFiles(root)).toHaveLength(101)
    // A file past the first 100 is saved by name.
    const client = recordingClient()
    payload(await create(writeTools(root, client), { name: 'x.md', generatedFile: 'f-100.md' }))
    expect(sentBytes(client).toString()).toBe('# 100\n')
  })

  it('applies the name filter before the cap', async () => {
    const root = rootOf('user-a')
    seedFiles(root, 145, 'other')
    seedFiles(root, 5, 'match')
    const found = await list(root, { nameContains: 'match' })
    expect(found.files).toHaveLength(5)
    expect(found.truncated).toBe(false)
    const exact = rootOf('user-b')
    seedFiles(exact, 100)
    expect(await list(exact)).toMatchObject({ truncated: false })
    expect((await list(exact)).files).toHaveLength(100)
  })

  it('skips a file still being written, and lists nothing for a caller with no folder', async () => {
    const root = rootOf('user-a')
    seedFiles(root, 1)
    fs.writeFileSync(path.join(outputsOf(root), '.clerum-partial-123-x.md'), 'half')
    expect((await list(root)).files.map(file => file.name)).toEqual(['f-000.md'])
    expect((await list(rootOf('user-new'))).files).toEqual([])
    const unavailable = await buildKeptFilesListTool(undefined).execute({}, '')
    expect(unavailable.error).toBe(KEPT_FILES_UNAVAILABLE)
  })

  it('is registered with the write tools of a chat registry only', () => {
    const names = (scopes: string[]) => {
      const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
      process.env[ACCESS_ENV] =
        `${header}.${Buffer.from(JSON.stringify({ scopes })).toString('base64url')}.sig`
      return registryFor(rootOf('user-a'))
        .listDefinitions()
        .map(definition => definition.name)
    }
    expect(names(['gfs.read', 'gfs.write'])).toContain('clerum__kept_files_list')
    const readOnly = names(['gfs.read'])
    expect(readOnly).not.toContain('clerum__kept_files_list')
    expect(readOnly).toContain('clerum__gfs_read')
    const workflow = buildGfsWriteTools(recordingClient()).map(tool => tool.name)
    expect(workflow).toContain('clerum__gfs_write')
    expect(workflow).not.toContain('clerum__kept_files_list')
  })
})

describe("one user never reaches another user's kept or workspace files", () => {
  it('refuses every source, the listing and the save for another caller', async () => {
    const a = rootOf('user-a')
    const b = rootOf('user-b')
    const { id } = await generate(a, 'clerum__generate_markdown', {
      filename: 'a-only.md',
      content: '# a\n',
    })
    await generate(a, 'clerum__generate_dashboard', {
      filename: 'a-dash.html',
      data: { title: 'A', charts: [] },
    })
    fs.writeFileSync(path.join(a, 'a-work.txt'), 'a work\n')
    await generate(b, 'clerum__generate_markdown', { filename: 'b-own.md', content: '# b\n' })

    const clientB = recordingClient()
    const asB = writeTools(b, clientB)
    expect((await create(asB, { generatedFile: 'a-only.md', generatedFileId: id })).error).toBe(
      keptFileNotFound().error
    )
    expect((await create(asB, { generatedFile: 'a-dash.html' })).error).toBe(
      keptFileNotFound().error
    )
    expect((await create(asB, { sourcePath: `../${path.basename(a)}/a-work.txt` })).error).toBe(
      SOURCE_PATH_INVALID
    )
    expect((await create(asB, { sourcePath: path.join(a, 'a-work.txt') })).error).toBe(
      SOURCE_PATH_INVALID
    )
    const listedB = payload(await buildKeptFilesListTool(b).execute({}, '')) as {
      files: Array<{ name: string; id?: string }>
    }
    expect(listedB.files.map(file => file.name)).toEqual(['b-own.md'])
    expect(JSON.stringify(listedB)).not.toContain(id!)
    expect(calls(clientB)).toBe(0)

    // Witness: A's own calls save and list the same files.
    const clientA = recordingClient()
    const asA = writeTools(a, clientA)
    payload(await create(asA, { name: 'a.md', generatedFile: 'a-only.md', generatedFileId: id }))
    payload(await create(asA, { generatedFile: 'a-dash.html' }))
    payload(await create(asA, { sourcePath: 'a-work.txt' }))
    expect(calls(clientA)).toBe(3)
    const listedA = payload(await buildKeptFilesListTool(a).execute({}, '')) as {
      files: Array<{ name: string }>
    }
    expect(listedA.files.map(file => file.name).sort()).toEqual(['a-dash.html', 'a-only.md'])
  })

  it("answers for the caller's own file when both hold the same name", async () => {
    const a = rootOf('user-a')
    const b = rootOf('user-b')
    const { id: idA } = await generate(a, 'clerum__generate_markdown', {
      filename: 'same.md',
      content: '# a\n',
    })
    await generate(b, 'clerum__generate_markdown', { filename: 'same.md', content: '# b\n' })
    const client = recordingClient()
    const refused = await create(writeTools(b, client), {
      generatedFile: 'same.md',
      generatedFileId: idA,
    })
    expect(refused.error).toMatch(/^kept_file_replaced: /)
    expect(calls(client)).toBe(0)
  })
})

describe('fixed texts', () => {
  // A Desktop step strips text between angle brackets and keeps 200 characters.
  it('carry no angle brackets and say what to do in their first 200 characters', () => {
    const texts: Array<[string, string]> = [
      [keptFileNotFound().error, 'it expired after'],
      [KEPT_FILES_UNAVAILABLE, 'no kept file can be used'],
      [SOURCE_PATH_UNAVAILABLE, 'sourcePath cannot be used'],
      [SOURCE_PATH_INVALID, 'give the relative path of a regular file in your workspace'],
      [DOWNLOADS_HINT, 'save that path with sourcePath'],
      [NO_SAVE_ID, 'call again with generatedFile only'],
      [HAS_SAVE_ID, 'pass its id as generatedFileId'],
      [
        `kept_file_withheld (binary_source_payload_unavailable): ${WITHHELD_SENTENCE}`,
        'cannot be saved; generate it again',
      ],
      [FILE_CONTAINS_SECRET, 'it was not saved'],
      [nameFormatMismatch('docx').error, 'give it a name that ends in .docx'],
      ['give exactly one of content, generatedFile, sourcePath', 'give exactly one of'],
    ]
    for (const [text, instruction] of texts) {
      expect(text, text).not.toMatch(/[<>]/)
      expect(text.slice(0, 200), text).toContain(instruction)
    }
  })
})

describe('a shell result saved by its workspace path', () => {
  it('uploads what an approved command wrote outside the downloads, and refuses the download itself', async () => {
    const root = rootOf('user-a')
    fs.mkdirSync(path.join(root, '.gfs-downloads', 't1'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(root, '.gfs-downloads', 't1', 'data.csv'), 'a,b\n1,2\n')
    const shell = new ShellTool(root, 5_000, ['PATH'], () => ({}), undefined, true)
    const ran = await shell.execute({
      command: 'mkdir -p outputs && tr a-z A-Z < .gfs-downloads/t1/data.csv > outputs/upper.csv',
    })
    expect(ran.is_error, ran.content).toBe(false)

    const client = recordingClient()
    const tools = writeTools(root, client)
    const saved = payload(
      await create(tools, { name: 'upper.csv', sourcePath: 'outputs/upper.csv' })
    )
    expect(saved.source).toBe('source_path')
    expect(sentBytes(client).equals(fs.readFileSync(path.join(root, 'outputs', 'upper.csv')))).toBe(
      true
    )
    expect(sentBytes(client).toString()).toBe('A,B\n1,2\n')

    const refused = await create(tools, {
      name: 'data.csv',
      sourcePath: '.gfs-downloads/t1/data.csv',
    })
    expect(refused.error).toBe(DOWNLOADS_HINT)
    expect(calls(client)).toBe(1)
  })
})

describe('guidance for changing a file that is in EvenDrive', () => {
  it('states the shell-then-sourcePath route, in order, in the workspace guidance', () => {
    const text = GFS_WORKSPACE_FILE_GUIDANCE_TEXT
    const outside = text.indexOf('writes the new file outside .gfs-downloads')
    const save = text.indexOf('clerum__gfs_write with sourcePath')
    const never = text.indexOf('Never paste a whole file into content')
    expect(outside).toBeGreaterThan(-1)
    expect(save).toBeGreaterThan(outside)
    expect(never).toBeGreaterThan(save)
    expect(text).toContain('sourcePath uploads it')
    // The rule the model followed before stays.
    expect(text).toContain('Do not print, `file_read`, or paste the whole source.')
  })
})
