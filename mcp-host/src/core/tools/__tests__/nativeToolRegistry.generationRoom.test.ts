// A chat generation is checked against the kept-files bounds of the download
// store: the room is read before the generator runs, a file that does not fit
// is refused with what the turn can do about it, and every generation says
// when the Host deletes the file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GfsDownloadStoreError } from '../../../internalTools/gfsDownloadStore'
import { GFS_FILE_LIMITS } from '../../../internalTools/gfsFilePolicy'
import {
  SAVE_LEDGER_DIR,
  ledgerRecordFileName,
  writeSaveLedgerRecord,
} from '../../../internalTools/keptFiles'
import { logger } from '../../../logger'
import { CALLER_OUTPUTS_DIR } from '../../../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import type { NativeToolConfig } from '../../interfaces'
import {
  KEPT_STORAGE_FULL_NO_DELETE,
  NativeToolRegistry,
  STORE_UNAVAILABLE_FOR_GENERATION,
} from '../nativeToolRegistry'

// The volume reads as roomy, so the free-space floor never decides these cases.
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
const previousQuota = process.env.CLERUM_GENERATED_FILES_QUOTA_MB
const HOURS = Math.round(GFS_FILE_LIMITS.retentionMs / 3_600_000)
const MARKDOWN = 'clerum__generate_markdown'
const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
}

let hostBase: string
let root: string

function setScopes(scopes: string[] | undefined): void {
  if (scopes === undefined) {
    delete process.env[ACCESS_ENV]
    return
  }
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  process.env[ACCESS_ENV] =
    `${header}.${Buffer.from(JSON.stringify({ scopes })).toString('base64url')}.sig`
}

beforeEach(() => {
  hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-generation-room-')))
  const binding = resolveCallerRootBinding(new ScopedWorkspaceProvider(hostBase), {
    sender: 'room-caller',
    channelType: 'rpc',
  })
  if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
  root = binding.root
  setScopes(['gfs.read', 'gfs.write'])
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
  if (previousQuota === undefined) delete process.env.CLERUM_GENERATED_FILES_QUOTA_MB
  else process.env.CLERUM_GENERATED_FILES_QUOTA_MB = previousQuota
  fs.rmSync(hostBase, { recursive: true, force: true })
})

function registry(
  room: (() => Promise<number>) | undefined,
  deleteConfirmed = true,
  withRoot = true
): NativeToolRegistry {
  return new NativeToolRegistry(
    config,
    'conv-room',
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
    withRoot ? ({ root, room } as { root: string; room: () => Promise<number> }) : undefined,
    deleteConfirmed
  )
}

const outputs = () => path.join(root, CALLER_OUTPUTS_DIR)
const fileOf = (name: string) => path.join(outputs(), name)
const recordOf = (name: string) => path.join(outputs(), SAVE_LEDGER_DIR, ledgerRecordFileName(name))

/** A kept generated file of the caller with its record, `hoursAgo` old. */
function kept(name: string, bytes: number, hoursAgo: number, id: string): void {
  fs.mkdirSync(outputs(), { recursive: true, mode: 0o700 })
  const at = new Date(Date.now() - hoursAgo * 3_600_000)
  fs.writeFileSync(fileOf(name), Buffer.alloc(bytes, 0x61))
  fs.utimesSync(fileOf(name), at, at)
  writeSaveLedgerRecord(outputs(), {
    id,
    name,
    format: 'md',
    outcome: 'delivered',
    createdAt: at.toISOString(),
    deliveredSha256: '0'.repeat(64),
  })
}

const content = 'x'.repeat(1000)
const generate = (reg: NativeToolRegistry, name = 'note.md', text = content) =>
  reg.get(MARKDOWN)!.execute({ filename: name, content: text })

describe('generation against the kept-files room', () => {
  it('refuses a file larger than the room with the offer, writes nothing and keeps the earlier file', async () => {
    kept('old-a.md', 600, 30, 'aaaaaaaaaaaa')
    kept('old-b.md', 600, 20, 'bbbbbbbbbbbb')
    fs.writeFileSync(fileOf('note.md'), 'earlier')
    const refused = await generate(registry(async () => 100))
    expect(refused.is_error).toBe(true)
    // The earlier note.md (7 bytes) is replaced, so it is credited.
    const needed = content.length - 7 - 100
    expect(refused.content).toContain(`needed_bytes=${needed}`)
    expect(refused.content).toContain(
      `file_not_generated: code=host_quota_exceeded needed_bytes=${needed} your_deletable_bytes=1200`
    )
    const offered = refused.content.split('\n').filter(line => line.startsWith('deletable_file:'))
    expect(offered.map(line => /id=([0-9a-f]+)/.exec(line)![1])).toEqual([
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb',
    ])
    expect(refused.content).toContain('Afterwards generate the file again.')
    expect(refused.content).not.toContain('attach')
    expect(fs.readFileSync(fileOf('note.md'), 'utf8')).toBe('earlier')
    expect(fs.existsSync(recordOf('note.md'))).toBe(false)
    // Witness: with a large room the same call writes the file and its record.
    const written = await generate(registry(async () => 1_000_000))
    expect(written.is_error, written.content).toBe(false)
    expect(fs.readFileSync(fileOf('note.md'), 'utf8')).toBe(content)
    expect(fs.existsSync(recordOf('note.md'))).toBe(true)
  })

  it("says the user cannot free enough when the user's own files do not cover the bytes", async () => {
    kept('small.md', 10, 30, 'cccccccccccc')
    const refused = await generate(registry(async () => 0))
    expect(refused.content).toContain('user_cannot_free_enough')
    expect(refused.content).not.toContain('deletable_file:')
  })

  it('caps the generation offer and still closes it by generating again', async () => {
    for (let n = 0; n < 12; n++) kept(`k${n}.md`, 100, 40 - n, String(n).padStart(12, 'd'))
    const refused = await generate(registry(async () => content.length - 1100))
    expect(refused.content).toContain('more_deletable_files: call clerum__kept_files_list')
    expect(refused.content).toContain('free only part of needed_bytes')
    expect(refused.content.trimEnd().endsWith('Afterwards generate the file again.')).toBe(true)
    expect(refused.content).not.toContain('attach')
  })

  it.each([
    ['without the delete', ['gfs.read', 'gfs.write'], false],
    ['without any kept-files tool', ['gfs.read'], true],
  ])('refuses with the fixed sentence %s', async (_label, scopes, deleteConfirmed) => {
    setScopes(scopes)
    kept('old.md', 5000, 30, 'eeeeeeeeeeee')
    const refused = await generate(registry(async () => 0, deleteConfirmed))
    // Witness: the refusal line itself.
    expect(refused.content).toContain('Host storage for kept files is full')
    expect(refused.content).toContain(KEPT_STORAGE_FULL_NO_DELETE)
    expect(refused.content).toContain(`${HOURS} hours`)
    expect(refused.content).not.toContain('deletable_file')
    expect(refused.content).not.toContain('clerum__kept_files_delete')
  })

  it.each(['download_busy', 'workspace_unavailable'] as const)(
    'refuses while the store is not available (%s) and writes nothing',
    async code => {
      const refused = await generate(
        registry(async () => {
          throw new GfsDownloadStoreError(code)
        })
      )
      expect(refused.content).toBe(`Error: ${STORE_UNAVAILABLE_FOR_GENERATION}`)
      expect(fs.existsSync(fileOf('note.md'))).toBe(false)
      // Witness: a resolving room writes the file.
      expect((await generate(registry(async () => 1_000_000))).is_error).toBe(false)
      expect(fs.existsSync(fileOf('note.md'))).toBe(true)
    }
  )

  it('generates as before when the volume cannot be measured, and says so once in the log', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const unmeasurable = registry(async () => {
      throw new GfsDownloadStoreError('volume_unmeasurable')
    })
    const first = await generate(unmeasurable)
    expect(first.is_error, first.content).toBe(false)
    expect(first.content).not.toMatch(/storage|kept files/i)
    expect(first.content).toContain(
      `The Host deletes this file ${HOURS} hours after it was generated`
    )
    expect(fs.existsSync(recordOf('note.md'))).toBe(true)
    await generate(unmeasurable, 'second.md')
    const lines = warn.mock.calls.filter(
      call =>
        call[1] ===
        'Could not measure the Host volume; generated files are written without the kept-files check'
    )
    expect(lines).toHaveLength(1)
    // Witness: the folder quota still applies on this path.
    process.env.CLERUM_GENERATED_FILES_QUOTA_MB = '1'
    expect((await generate(unmeasurable, 'third.md', 'q'.repeat(2 * 1024 * 1024))).content).toMatch(
      /^Error: Output quota exceeded/
    )
  })

  it('refuses with only the code when the room fails for another reason', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const failure = Object.assign(new Error(`EACCES: permission denied, lstat '${hostBase}/x'`), {
      code: 'EACCES',
    })
    const refused = await generate(
      registry(async () => {
        throw failure
      })
    )
    expect(refused.content).toBe(
      'Error: The Host could not check its storage (EACCES), so the file was not generated. Tell the user; an operator has to look at the Host.'
    )
    expect(refused.content).not.toContain('/')
    expect(fs.existsSync(fileOf('note.md'))).toBe(false)
    // Witness: the log has the error name and code.
    expect(
      warn.mock.calls.some(
        call =>
          (call[0] as { errorCode?: string }).errorCode === 'EACCES' &&
          (call[0] as { errorName?: string }).errorName === 'Error'
      )
    ).toBe(true)
  })

  it('cannot be built with a root and no room; without either, generators refuse as before', async () => {
    expect(() => registry(undefined)).toThrow('kept-files room')
    const bare = registry(undefined, true, false)
    expect(bare.listDefinitions().map(definition => definition.name)).toContain(MARKDOWN)
    const result = await generate(bare)
    expect(result.is_error).toBe(true)
    expect(fs.existsSync(fileOf('note.md'))).toBe(false)
  })
})

describe('the retention sentence of a chat generation', () => {
  it('names the save route and the Save id on a delivered file, with the Save id line last', async () => {
    const result = await generate(registry(async () => 1_000_000))
    const [first, ...rest] = result.content.split('\n')
    expect(first).toContain(
      `The Host deletes this file ${HOURS} hours after it was generated; to keep it longer, save it to EvenDrive with clerum__gfs_create_file (generatedFile and this Save id). Tell the user.`
    )
    expect(rest.at(-1)).toMatch(/^Save id: ([0-9a-f]{12})$/)
    expect(result.content).toMatch(/^Save id: ([0-9a-f]{12})$/m)
  })

  it('names the save route by name for a dashboard', async () => {
    const result = await registry(async () => 1_000_000)
      .get('clerum__generate_dashboard')!
      .execute({ filename: 'd.html', data: { title: 'Review', charts: [] } })
    expect(result.is_error, result.content).toBe(false)
    expect(result.content).toContain(
      'save it to EvenDrive with clerum__gfs_create_file (generatedFile). Tell the user.'
    )
    expect(result.content).not.toContain('Save id')
  })

  it('says only when the file is deleted where no save tool exists', async () => {
    setScopes(undefined)
    const result = await generate(registry(async () => 1_000_000))
    expect(result.is_error, result.content).toBe(false)
    expect(result.content).toContain(
      `The Host deletes this file ${HOURS} hours after it was generated. Tell the user.`
    )
    expect(result.content).not.toContain('clerum__gfs_create_file')
  })
})

describe('every generator applies the room', () => {
  it.each([
    ['clerum__generate_markdown', { filename: 'g.md', content: '# g' }],
    ['clerum__generate_pdf', { filename: 'g.pdf', body: 'g' }],
    ['clerum__generate_docx', { filename: 'g.docx', body: 'g' }],
    ['clerum__generate_xlsx', { filename: 'g.xlsx', sheets: [{ name: 'S', rows: [['a'], [1]] }] }],
    ['clerum__generate_pptx', { filename: 'g.pptx', slides: [{ layout: 'cover', title: 'g' }] }],
    [
      'clerum__generate_chart',
      {
        filename: 'g.png',
        type: 'bar',
        data: { labels: ['a', 'b'], datasets: [{ data: [1, 2] }] },
      },
    ],
    ['clerum__generate_dashboard', { filename: 'g.html', data: { title: 'G', charts: [] } }],
  ])(
    '%s refuses a file with no room',
    async (tool, args) => {
      const refused = await registry(async () => 0, false)
        .get(tool)!
        .execute(args)
      expect(refused.is_error).toBe(true)
      expect(refused.content).toContain('Host storage for kept files is full')
      // Witness: the same call with room writes the file.
      const written = await registry(async () => 50_000_000, false)
        .get(tool)!
        .execute(args)
      expect(written.is_error, written.content).toBe(false)
    },
    60_000
  )
})
