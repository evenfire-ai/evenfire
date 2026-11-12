// A chat generation records what the attachment check decided, in the
// caller's own `.clerum-outputs/.save-ledger/`, so the file can be saved to
// GFS later only if the chat received it. A generation whose record cannot be
// written is discarded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  SAVE_LEDGER_DIR,
  type SaveLedgerRecord,
  ledgerRecordFileName,
} from '../../../internalTools/keptFiles'
import { INTERNAL_TOOLS } from '../../../workflow/internalTools'
import { CALLER_OUTPUTS_DIR } from '../../../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import { NativeToolRegistry } from '../nativeToolRegistry'

// Every record write passes through, unless a test sets `ledgerHook.beforeFail`:
// then the hook runs and the write fails, as a write that throws.
const ledgerHook = vi.hoisted(() => ({ beforeFail: undefined as undefined | (() => void) }))
vi.mock('../../../internalTools/keptFiles', async original => {
  const actual = await original<typeof import('../../../internalTools/keptFiles')>()
  return {
    ...actual,
    writeSaveLedgerRecord: (outputDir: string, record: SaveLedgerRecord) => {
      if (ledgerHook.beforeFail) {
        ledgerHook.beforeFail()
        throw new actual.SaveLedgerWriteError('EIO')
      }
      return actual.writeSaveLedgerRecord(outputDir, record)
    },
  }
})

// The volume is sized to its free space, so the free-space floor never refuses.
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
const SYNTHETIC_SECRET = 'synthetic-ledger-probe-value'
const DISCARDED =
  /^Error: Generated file discarded: its save record could not be written \(ledger [A-Z]+\)\. Try again; if it keeps failing, the Host's storage needs attention\.$/

function encodedClaims(scopes: string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

describe('save records of chat generations', () => {
  let hostBase: string
  let outside: string
  let provider: ScopedWorkspaceProvider

  beforeEach(() => {
    hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-save-ledger-')))
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-save-ledger-out-')))
    provider = new ScopedWorkspaceProvider(hostBase)
    process.env[ACCESS_ENV] = encodedClaims(['gfs.read', 'gfs.write'])
  })

  afterEach(() => {
    ledgerHook.beforeFail = undefined
    if (previousAccess === undefined) delete process.env[ACCESS_ENV]
    else process.env[ACCESS_ENV] = previousAccess
    for (const dir of [hostBase, outside]) {
      try {
        fs.chmodSync(path.join(dir, 'users'), 0o700)
      } catch {
        // Not every test makes a users folder.
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function rootOf(userId: string): string {
    const binding = resolveCallerRootBinding(provider, { sender: userId, channelType: 'rpc' })
    if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
    return binding.root
  }

  function registryFor(
    callerRoot: string,
    secrets: Array<{ name: string; value: string }> = []
  ): NativeToolRegistry {
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
      'conv-ledger',
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
      callerRoot
    )
  }

  function outputsOf(root: string): string {
    return path.join(root, CALLER_OUTPUTS_DIR)
  }

  function recordOf(root: string, name: string): SaveLedgerRecord {
    const file = path.join(outputsOf(root), SAVE_LEDGER_DIR, ledgerRecordFileName(name))
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SaveLedgerRecord
  }

  it('records a delivered generation with the hash of the bytes the chat received, and names its save id', async () => {
    const root = rootOf('user-a')
    const result = await registryFor(root)
      .get('clerum__generate_markdown')!
      .execute({ filename: 'report.md', content: '# report\n' })

    expect(result.is_error, result.content).toBe(false)
    expect(result.attachments).toHaveLength(1)
    const record = recordOf(root, 'report.md')
    expect(Object.keys(record).sort()).toEqual([
      'createdAt',
      'deliveredSha256',
      'format',
      'id',
      'name',
      'outcome',
    ])
    expect(record).toMatchObject({ name: 'report.md', format: 'md', outcome: 'delivered' })
    expect(record.id).toMatch(/^[0-9a-f]{12}$/)
    expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false)
    const delivered = Buffer.from(result.attachments![0]!.dataBase64!, 'base64')
    expect(record.deliveredSha256).toBe(createHash('sha256').update(delivered).digest('hex'))
    expect(result.content).toContain(`\nSave id: ${record.id}`)
    // The record folder holds only the record: no temporary file is left.
    expect(fs.readdirSync(path.join(outputsOf(root), SAVE_LEDGER_DIR))).toEqual([
      ledgerRecordFileName('report.md'),
    ])
    expect(fs.statSync(path.join(outputsOf(root), SAVE_LEDGER_DIR)).mode & 0o777).toBe(0o700)
  })

  it('gives each generation a new id, also for identical arguments', async () => {
    const root = rootOf('user-a')
    const md = registryFor(root).get('clerum__generate_markdown')!
    await md.execute({ filename: 'same.md', content: '# same\n' })
    const first = recordOf(root, 'same.md').id
    await md.execute({ filename: 'same.md', content: '# same\n' })
    const second = recordOf(root, 'same.md').id
    expect(second).toMatch(/^[0-9a-f]{12}$/)
    expect(second).not.toBe(first)
  })

  it('records a withheld generation with the reason, and names no save id', async () => {
    const root = rootOf('user-a')
    const result = await registryFor(root, [{ name: 'PROBE', value: SYNTHETIC_SECRET }])
      .get('clerum__generate_pdf')!
      .execute({ filename: 'held.pdf', body: `value ${SYNTHETIC_SECRET}` })

    expect(result.is_error, result.content).toBe(false)
    expect(result.attachments ?? []).toHaveLength(0)
    const record = recordOf(root, 'held.pdf')
    expect(record).toMatchObject({
      name: 'held.pdf',
      format: 'pdf',
      outcome: 'binary_redaction_unavailable',
    })
    expect(record).not.toHaveProperty('deliveredSha256')
    expect(result.content).not.toContain('Save id:')
    // The file itself stays: only its later save is refused.
    expect(fs.existsSync(path.join(outputsOf(root), 'held.pdf'))).toBe(true)
  })

  it('writes the record but names no save id where the Host token cannot write to GFS', async () => {
    const root = rootOf('user-a')
    process.env[ACCESS_ENV] = encodedClaims(['gfs.read'])
    const readOnly = await registryFor(root)
      .get('clerum__generate_markdown')!
      .execute({ filename: 'a.md', content: '# a\n' })
    expect(readOnly.is_error, readOnly.content).toBe(false)
    expect(recordOf(root, 'a.md').outcome).toBe('delivered')
    expect(readOnly.content).not.toContain('Save id:')

    process.env[ACCESS_ENV] = encodedClaims(['gfs.read', 'gfs.write'])
    const writable = await registryFor(root)
      .get('clerum__generate_markdown')!
      .execute({ filename: 'b.md', content: '# b\n' })
    expect(writable.content).toContain(`Save id: ${recordOf(root, 'b.md').id}`)
  })

  it('writes no record for a workflow run of the same generator', async () => {
    const workflowOutput = fs.mkdtempSync(path.join(hostBase, 'workflow-output-'))
    const generator = INTERNAL_TOOLS.find(tool => tool.name === 'clerum__generate_markdown')!
    const run = await generator.execute({ filename: 'w.md', content: '# w\n' }, workflowOutput)
    expect(run.success).toBe(true)
    expect(fs.readdirSync(workflowOutput)).toEqual(['w.md'])

    const root = rootOf('user-a')
    await registryFor(root)
      .get('clerum__generate_markdown')!
      .execute({ filename: 'w.md', content: '# w\n' })
    expect(recordOf(root, 'w.md').outcome).toBe('delivered')
  })

  it('discards the generation when the record folder is a regular file', async () => {
    const root = rootOf('user-a')
    const md = registryFor(root).get('clerum__generate_markdown')!
    const kept = await md.execute({ filename: 'kept.md', content: '# kept\n' })
    expect(kept.is_error, kept.content).toBe(false)
    expect(kept.content).toContain('Save id:')

    fs.rmSync(path.join(outputsOf(root), SAVE_LEDGER_DIR), { recursive: true })
    fs.writeFileSync(path.join(outputsOf(root), SAVE_LEDGER_DIR), 'not a folder')
    const result = await md.execute({ filename: 'lost.md', content: '# lost\n' })

    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(DISCARDED)
    expect(result.attachments).toBeUndefined()
    expect(fs.existsSync(path.join(outputsOf(root), 'lost.md'))).toBe(false)
    // The earlier generation is untouched.
    expect(fs.existsSync(path.join(outputsOf(root), 'kept.md'))).toBe(true)
  })

  it('discards the generation and writes nothing through a record folder that is a link', async () => {
    const root = rootOf('user-a')
    fs.mkdirSync(outputsOf(root), { mode: 0o700 })
    fs.symlinkSync(outside, path.join(outputsOf(root), SAVE_LEDGER_DIR))
    const result = await registryFor(root)
      .get('clerum__generate_markdown')!
      .execute({ filename: 'linked.md', content: '# linked\n' })

    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(DISCARDED)
    expect(fs.existsSync(path.join(outputsOf(root), 'linked.md'))).toBe(false)
    expect(fs.readdirSync(outside)).toEqual([])

    // The same generation with a real record folder keeps file and record.
    fs.unlinkSync(path.join(outputsOf(root), SAVE_LEDGER_DIR))
    const again = await registryFor(root)
      .get('clerum__generate_markdown')!
      .execute({ filename: 'linked.md', content: '# linked\n' })
    expect(again.is_error, again.content).toBe(false)
    expect(fs.existsSync(path.join(outputsOf(root), 'linked.md'))).toBe(true)
    expect(recordOf(root, 'linked.md').outcome).toBe('delivered')
  })

  it.skipIf(process.getuid?.() === 0)(
    'discards the generation when the record cannot be created',
    async () => {
      const root = rootOf('user-a')
      fs.mkdirSync(path.join(outputsOf(root), SAVE_LEDGER_DIR), { recursive: true, mode: 0o700 })
      fs.chmodSync(path.join(outputsOf(root), SAVE_LEDGER_DIR), 0o500)
      try {
        const result = await registryFor(root)
          .get('clerum__generate_markdown')!
          .execute({ filename: 'denied.md', content: '# denied\n' })
        expect(result.is_error).toBe(true)
        expect(result.content).toContain('(ledger EACCES)')
        expect(result.attachments).toBeUndefined()
        expect(fs.existsSync(path.join(outputsOf(root), 'denied.md'))).toBe(false)
      } finally {
        fs.chmodSync(path.join(outputsOf(root), SAVE_LEDGER_DIR), 0o700)
      }
    }
  )

  it('removes only the file it generated: a file that replaced it meanwhile stays', async () => {
    const root = rootOf('user-a')
    const target = path.join(outputsOf(root), 'race.md')
    // Another writer replaces the file the way generators write: a sibling
    // file renamed over the name, so the old file is still linked while the
    // new one is created.
    ledgerHook.beforeFail = () => {
      const sibling = path.join(outputsOf(root), '.race-replacement')
      fs.writeFileSync(sibling, '# replaced by another writer\n')
      fs.renameSync(sibling, target)
    }
    const result = await registryFor(root)
      .get('clerum__generate_markdown')!
      .execute({ filename: 'race.md', content: '# mine\n' })

    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(DISCARDED)
    expect(fs.readFileSync(target, 'utf8')).toBe('# replaced by another writer\n')

    // Without the replacement the same failure removes the generated file.
    ledgerHook.beforeFail = () => undefined
    const plain = await registryFor(root)
      .get('clerum__generate_markdown')!
      .execute({ filename: 'plain.md', content: '# plain\n' })
    expect(plain.content).toMatch(DISCARDED)
    expect(fs.existsSync(path.join(outputsOf(root), 'plain.md'))).toBe(false)
  })
})
