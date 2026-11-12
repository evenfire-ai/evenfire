// Deleting the files the Host keeps for a user, only after the user approves
// the call on a card that names every file, and the no-room offer that
// proposes them when a message's attachments could not be kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentStateMachine } from '../agent/stateMachine'
import { keptFilesDeleteAsks, liveApprovalTools } from '../agent/taskExecutor'
import { ApprovalController } from '../core/extensions/approvalController'
import { UnifiedApprovalGateController } from '../core/extensions/mcpApprovalGateController'
import { buildTurnContextBlock } from '../core/orchestration/turnContext'
import { MAKE_ROOM_SENTENCE, NativeToolRegistry } from '../core/tools/nativeToolRegistry'
import { type Conversation, ConversationState, type PendingApproval } from '../core/types'
import {
  KEPT_FILES_DELETE_APPROVAL_TOOL,
  projectApprovalInputPreview,
} from '../progress/approvalInputPreview'
import type { InternalToolDefinition } from '../workflow/types'
import { CALLER_OUTPUTS_DIR, KEPT_UPLOADS_DIR } from '../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../workspace/scopedWorkspace'
import {
  ATTACH_AGAIN_SENTENCE,
  type GfscWriteClient,
  KEPT_FILES_DELETE_TOOL,
  buildGfsWriteTools,
  buildKeptFilesDeleteTool,
  buildKeptFilesListTool,
} from './gfs'
import {
  SAVE_LEDGER_DIR,
  buildKeepOffer,
  keepMessageAttachments,
  keptFileNotFound,
  ledgerRecordFileName,
  listKeptFiles,
} from './keptFiles'

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
const HOUR = 3_600_000

let hostBase: string
let provider: ScopedWorkspaceProvider

function setScopes(scopes: string[]): void {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  process.env[ACCESS_ENV] =
    `${header}.${Buffer.from(JSON.stringify({ scopes })).toString('base64url')}.sig`
}

beforeEach(() => {
  hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-kept-delete-')))
  provider = new ScopedWorkspaceProvider(hostBase)
  setScopes(['gfs.read', 'gfs.write'])
})

afterEach(() => {
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
  fs.rmSync(hostBase, { recursive: true, force: true })
})

function rootOf(userId: string): string {
  const binding = resolveCallerRootBinding(provider, { sender: userId, channelType: 'rpc' })
  if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
  return binding.root
}

function outputsOf(root: string): string {
  return path.join(root, CALLER_OUTPUTS_DIR)
}

/** A generated file with its record, as the adapter leaves them, `ageMs` old. */
function generated(
  root: string,
  name: string,
  bytes: number,
  ageMs = HOUR
): { id: string; file: string; record: string } {
  const out = outputsOf(root)
  fs.mkdirSync(path.join(out, SAVE_LEDGER_DIR), { recursive: true, mode: 0o700 })
  const at = new Date(Date.now() - ageMs)
  const file = path.join(out, name)
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61))
  fs.utimesSync(file, at, at)
  const id = Math.random().toString(16).slice(2, 14).padEnd(12, '0')
  const record = path.join(out, SAVE_LEDGER_DIR, ledgerRecordFileName(name))
  fs.writeFileSync(
    record,
    JSON.stringify({
      id,
      name,
      format: 'md',
      outcome: 'delivered',
      createdAt: at.toISOString(),
      deliveredSha256: '0'.repeat(64),
    })
  )
  return { id, file, record }
}

async function del(
  root: string | undefined,
  files: Array<{ kind: string; id: string; name: string }>,
  keepRefused = false
) {
  return buildKeptFilesDeleteTool(root, { keepRefused }).execute({ files }, '')
}

function payload(result: { success: boolean; content?: string; error?: string }) {
  expect(result.success, result.error).toBe(true)
  return JSON.parse(result.content!) as {
    files: Array<{ result: string; id: string }>
    freedBytes: number
    note?: string
  }
}

function registryFor(root: string, deleteConfirmed: boolean): NativeToolRegistry {
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
    'conv-delete',
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
    root,
    deleteConfirmed
  )
}

describe('clerum__kept_files_delete', () => {
  it('removes a generated file and its record; a later save answers not found', async () => {
    const root = rootOf('user-a')
    const kept = generated(root, 'old.md', 100)
    const result = payload(await del(root, [{ kind: 'generated', id: kept.id, name: 'old.md' }]))
    expect(result.files.map(file => file.result)).toEqual(['deleted'])
    expect(result.freedBytes).toBeGreaterThanOrEqual(100)
    expect([fs.existsSync(kept.file), fs.existsSync(kept.record)]).toEqual([false, false])
    expect(result).not.toHaveProperty('note')
    const client = {
      createFileFromBytes: vi.fn(),
      writeBytes: vi.fn(),
    } as unknown as GfscWriteClient
    const save = await new Map<string, InternalToolDefinition>(
      buildGfsWriteTools(client, {
        callerRoot: root,
        callerWorkspacePath: root,
        secretEntries: () => [],
      }).map(t => [t.name, t])
    )
      .get('clerum__gfs_create_file')!
      .execute(
        {
          drive: 'm',
          parentResourceId: 'f',
          name: 'old.md',
          generatedFile: 'old.md',
          generatedFileId: kept.id,
        },
        ''
      )
    expect(save.error).toBe(keptFileNotFound().error)
  })

  it('deletes nothing when a name does not match its id', async () => {
    const root = rootOf('user-a')
    const a = generated(root, 'a.md', 10)
    const b = generated(root, 'b.md', 10)
    const refused = await del(root, [
      { kind: 'generated', id: a.id, name: 'a.md' },
      { kind: 'generated', id: b.id, name: 'not-b.md' },
    ])
    expect(refused.error).toMatch(/^kept_file_mismatch: /)
    expect([fs.existsSync(a.file), fs.existsSync(b.file)]).toEqual([true, true])
    payload(await del(root, [{ kind: 'generated', id: b.id, name: 'b.md' }]))
    expect(fs.existsSync(b.file)).toBe(false)
  })

  it("answers not found for another caller's id and leaves that file", async () => {
    const a = rootOf('user-a')
    const b = rootOf('user-b')
    const kept = generated(a, 'a-only.md', 10)
    const asB = payload(await del(b, [{ kind: 'generated', id: kept.id, name: 'a-only.md' }]))
    expect(asB.files.map(file => file.result)).toEqual(['not_found'])
    expect(asB.freedBytes).toBe(0)
    expect([fs.existsSync(kept.file), fs.existsSync(kept.record)]).toEqual([true, true])
    // Witness: its owner deletes it.
    payload(await del(a, [{ kind: 'generated', id: kept.id, name: 'a-only.md' }]))
    expect(fs.existsSync(kept.file)).toBe(false)
  })

  it('answers not found for an id gone or regenerated since the listing, and deletes the rest', async () => {
    const root = rootOf('user-a')
    const gone = generated(root, 'gone.md', 10)
    const regenerating = generated(root, 'busy.md', 10)
    const other = generated(root, 'other.md', 10)
    fs.rmSync(gone.file)
    // A regeneration in progress: the file is newer than its record.
    fs.writeFileSync(regenerating.file, 'new bytes')
    const result = payload(
      await del(root, [
        { kind: 'generated', id: gone.id, name: 'gone.md' },
        { kind: 'generated', id: regenerating.id, name: 'busy.md' },
        { kind: 'generated', id: other.id, name: 'other.md' },
      ])
    )
    expect(result.files.map(file => file.result)).toEqual(['not_found', 'not_found', 'deleted'])
    expect(fs.readFileSync(regenerating.file, 'utf8')).toBe('new bytes')
    expect(fs.existsSync(other.file)).toBe(false)
  })

  it('deletes a file past the first 100 the listing shows', async () => {
    const root = rootOf('user-a')
    const files = Array.from({ length: 101 }, (_, n) =>
      generated(root, `f-${String(n).padStart(3, '0')}.md`, 1, (200 - n) * 60_000)
    )
    const listed = JSON.parse((await buildKeptFilesListTool(root).execute({}, '')).content!) as {
      files: Array<{ name: string }>
    }
    expect(listed.files.map(file => file.name)).not.toContain('f-100.md')
    const newest = files[100]!
    payload(await del(root, [{ kind: 'generated', id: newest.id, name: 'f-100.md' }]))
    expect([fs.existsSync(newest.file), fs.existsSync(newest.record)]).toEqual([false, false])
    expect(buildKeepOffer(root, 1, Date.now()).deletable[0]!.name).toBe('f-000.md')
  })

  it('cannot delete a file with no record', async () => {
    const root = rootOf('user-a')
    fs.mkdirSync(outputsOf(root), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(outputsOf(root), 'dashboard.html'), '<html/>')
    const result = payload(
      await del(root, [{ kind: 'generated', id: '0123456789ab', name: 'dashboard.html' }])
    )
    expect(result.files.map(file => file.result)).toEqual(['not_found'])
    expect(fs.existsSync(path.join(outputsOf(root), 'dashboard.html'))).toBe(true)
  })

  it('in the turn whose keep was refused, frees the room, keeps nothing and asks to attach again', async () => {
    const root = rootOf('user-a')
    const old = generated(root, 'old.md', 1000)
    const result = payload(
      await del(root, [{ kind: 'generated', id: old.id, name: 'old.md' }], true)
    )
    expect(result.freedBytes).toBeGreaterThanOrEqual(1000)
    expect(result.note).toBe(ATTACH_AGAIN_SENTENCE)
    expect(fs.existsSync(path.join(outputsOf(root), KEPT_UPLOADS_DIR))).toBe(false)
    expect(listKeptFiles(root)).toEqual([])
    // Witness: the same attachment sent again is kept.
    expect(
      await keepMessageAttachments({
        attachments: [
          {
            id: 'f',
            kind: 'file',
            mimeType: 'text/plain',
            encoding: 'base64',
            dataBase64: Buffer.from('again').toString('base64'),
            filename: 'again.txt',
          } as never,
        ],
        callerRoot: root,
        store: { reserveKept: async () => () => undefined },
      })
    ).toBeUndefined()
    const bin = fs
      .readdirSync(path.join(outputsOf(root), KEPT_UPLOADS_DIR))
      .find(name => name.endsWith('.bin'))!
    expect(fs.readFileSync(path.join(outputsOf(root), KEPT_UPLOADS_DIR, bin), 'utf8')).toBe('again')
  })

  it('refuses ids and kinds that are not from the listing before touching any file', async () => {
    const root = rootOf('user-a')
    const kept = generated(root, 'a.md', 10)
    for (const files of [
      [{ kind: 'generated', id: '../a.md', name: 'a.md' }],
      [{ kind: 'download', id: kept.id, name: 'a.md' }],
      [],
    ]) {
      const result = await del(root, files)
      expect(result.success, JSON.stringify(files)).toBe(false)
    }
    expect(fs.existsSync(kept.file)).toBe(true)
  })
})

describe('the no-room offer', () => {
  const at = new Date('2026-11-01T00:00:00Z')

  it('names the oldest files that cover the bytes short', () => {
    const block = buildTurnContextBlock({
      date: at,
      channel: { type: 'rpc', sender: null },
      keepRefusal: {
        code: 'host_quota_exceeded',
        offer: {
          neededBytes: 150,
          deletable: [
            { kind: 'generated', id: 'aaaaaaaaaaaa', name: 'old.md', sizeBytes: 100, ageHours: 9 },
            { kind: 'upload', id: 'bbbbbbbbbbbb', name: 'mid.pdf', sizeBytes: 100, ageHours: 5 },
            { kind: 'generated', id: 'cccccccccccc', name: 'new.md', sizeBytes: 100, ageHours: 1 },
          ],
        },
      },
    })
    expect(block).toContain(
      'attachments_not_kept: code=host_quota_exceeded needed_bytes=150 your_deletable_bytes=300'
    )
    expect(block).toContain(
      'deletable_file: kind=generated id=aaaaaaaaaaaa name="old.md" bytes=100 age_hours=9'
    )
    expect(block).toContain('deletable_file: kind=upload id=bbbbbbbbbbbb')
    expect(block).not.toContain('cccccccccccc')
    expect(block).toContain('clerum__kept_files_delete')
    // Witness: a kept message has none of these lines.
    const kept = buildTurnContextBlock({ date: at, channel: { type: 'rpc', sender: null } })
    expect(kept).not.toContain('deletable_file')
  })

  it('says the user cannot free enough when their own files are not enough', () => {
    const block = buildTurnContextBlock({
      date: at,
      channel: { type: 'rpc', sender: null },
      keepRefusal: {
        code: 'host_quota_exceeded',
        offer: {
          neededBytes: 500,
          deletable: [
            { kind: 'generated', id: 'aaaaaaaaaaaa', name: 'old.md', sizeBytes: 100, ageHours: 9 },
          ],
        },
      },
    })
    expect(block).toContain('needed_bytes=500')
    expect(block).toContain('user_cannot_free_enough')
    expect(block).not.toContain('deletable_file')
    expect(block).toContain('by other users of this agent')
  })

  it('names at most ten files and points to the listing for more', () => {
    const block = buildTurnContextBlock({
      date: at,
      channel: { type: 'rpc', sender: null },
      keepRefusal: {
        code: 'host_quota_exceeded',
        offer: {
          neededBytes: 1500,
          deletable: Array.from({ length: 15 }, (_, n) => ({
            kind: 'generated' as const,
            id: String(n).padStart(12, 'a'),
            name: `f${n}.md`,
            sizeBytes: 100,
            ageHours: 20 - n,
          })),
        },
      },
    })
    expect(block.match(/deletable_file:/g)).toHaveLength(10)
    expect(block).toContain('more_deletable_files: call clerum__kept_files_list')
  })

  it("offers only the caller's own files with an id, not a dashboard and not another user's", () => {
    const a = rootOf('user-a')
    const b = rootOf('user-b')
    generated(b, 'b-older.md', 10, 50 * HOUR)
    const own = generated(a, 'a.md', 10, 2 * HOUR)
    fs.writeFileSync(path.join(outputsOf(a), 'dash.html'), Buffer.alloc(500))
    const offer = buildKeepOffer(a, 5, Date.now())
    expect(offer.deletable.map(file => file.id)).toEqual([own.id])
    expect(offer.deletable[0]!.ageHours).toBe(2)
  })
})

describe('registration and approval of the delete', () => {
  const names = (registry: NativeToolRegistry) => registry.listDefinitions().map(d => d.name)

  it('exists only with the listing, where every call will ask the user', () => {
    const root = rootOf('user-a')
    expect(names(registryFor(root, true))).toContain(KEPT_FILES_DELETE_TOOL)
    expect(names(registryFor(root, false))).not.toContain(KEPT_FILES_DELETE_TOOL)
    setScopes(['gfs.read'])
    const readOnly = names(registryFor(root, true))
    expect(readOnly).not.toContain(KEPT_FILES_DELETE_TOOL)
    expect(readOnly).toContain('clerum__gfs_read')
  })

  it('asks only for a channel task with approval on and no override turning it off', () => {
    const asks = (
      approvalEnabled: boolean,
      taskSource: string,
      approvalTools?: Record<string, boolean>
    ) => keptFilesDeleteAsks({ approvalEnabled, taskSource, approvalTools })
    expect(asks(true, 'channel')).toBe(true)
    expect(asks(false, 'channel')).toBe(false)
    expect(asks(true, 'cron')).toBe(false)
    expect(asks(true, 'internal')).toBe(false)
    expect(asks(true, 'channel', { [KEPT_FILES_DELETE_TOOL]: false })).toBe(false)
    expect(liveApprovalTools(false, true)).toEqual(new Set([KEPT_FILES_DELETE_TOOL]))
    expect(liveApprovalTools(true, true)).toEqual(
      new Set(['clerum__gfs_download', KEPT_FILES_DELETE_TOOL])
    )
    expect(liveApprovalTools(false, false)).toBeUndefined()
  })

  it('suspends every call for the user, even with approve-all and an always grant', () => {
    const root = rootOf('user-a')
    const registry = registryFor(root, true)
    expect(registry.get(KEPT_FILES_DELETE_TOOL)!.requiresApproval()).toBe(true)
    const conversation: Conversation = {
      id: 'conv',
      user_id: 'user-a',
      state: ConversationState.Processing,
      turns: [],
      auto_approved_tools: new Set(['*', KEPT_FILES_DELETE_TOOL]),
      created_at: new Date(),
      updated_at: new Date(),
    }
    const gate = new UnifiedApprovalGateController(
      registry,
      { defaultPolicy: 'channel_users', channels: {}, tools: {} },
      registry
    )
    const controller = new ApprovalController(
      conversation,
      gate,
      liveApprovalTools(false, true),
      gate
    )
    const args = { files: [{ kind: 'generated', id: 'aaaaaaaaaaaa', name: 'a.md' }] }
    const decision = controller.beforeTool(KEPT_FILES_DELETE_TOOL, args) as {
      type: string
      approval: PendingApproval
    }
    expect(decision.type).toBe('suspend')
    expect(decision.approval.authorization_scope).toBe('exact_invocation')
    // Witness: another tool proceeds under the same approve-all.
    expect(controller.beforeTool('json_transform', {})).toBe('proceed')
  })

  it('appends how to make room to a generator space refusal only where the delete exists', async () => {
    const root = rootOf('user-a')
    const quota = process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
    process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = '1'
    try {
      fs.mkdirSync(outputsOf(root), { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(outputsOf(root), 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
      const withDelete = await registryFor(root, true)
        .get('clerum__generate_markdown')!
        .execute({ filename: 'x.md', content: '# x' })
      expect(withDelete.content).toMatch(/^Error: Output quota exceeded/)
      expect(withDelete.content).toContain(MAKE_ROOM_SENTENCE)
      const without = await registryFor(root, false)
        .get('clerum__generate_markdown')!
        .execute({ filename: 'x.md', content: '# x' })
      expect(without.content).toMatch(/^Error: Output quota exceeded/)
      expect(without.content).not.toContain('clerum__kept_files_delete')
    } finally {
      if (quota === undefined) delete process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB
      else process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB = quota
    }
  })
})

describe('the delete approval names every file', () => {
  const SECRET = 'synthetic-delete-name-secret'
  const redact = (text: string) => text.split(SECRET).join('[REDACTED:P]')

  function preview(files: Array<{ kind: string; name: string }>) {
    return projectApprovalInputPreview(
      KEPT_FILES_DELETE_APPROVAL_TOOL,
      { files: files.map((file, n) => ({ ...file, id: String(n).padStart(12, '0') })) },
      redact
    )!
  }

  function notification(
    files: Array<{ kind: string; name: string }>,
    channelType = 'slack'
  ): string {
    const proto = AgentStateMachine.prototype as unknown as {
      buildApprovalNotification(a: PendingApproval, u: string, c?: string): string
    }
    return proto.buildApprovalNotification.call(
      {
        approvalConfig: { defaultPolicy: 'channel_users', channels: {}, tools: {} },
        secretEntriesProvider: () => [{ name: 'P', value: SECRET }],
      },
      {
        request_id: 'r',
        tool_name: KEPT_FILES_DELETE_APPROVAL_TOOL,
        parameters: {
          files: files.map((file, n) => ({ ...file, id: String(n).padStart(12, '0') })),
        },
        description: 'delete',
        tool_call_id: 'c',
        context_snapshot: [],
      },
      'user-1',
      channelType
    )
  }

  it('lists twenty names of 60 characters in full, in Desktop and in a channel', () => {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'generated',
      name: `${'n'.repeat(55)}-${String(n).padStart(2, '0')}.md`,
    }))
    const desktop = preview(files).text.split('\n')
    expect(desktop[0]).toBe('Delete these files permanently:')
    expect(desktop.filter(line => line.startsWith('generated: '))).toHaveLength(20)
    expect(desktop).toContain('Total files: 20')
    expect(desktop).not.toContain('Names ending in … are shortened')
    const channel = notification(files).split('\n')
    expect(channel[0]).toBe('Delete these files permanently:')
    expect(channel.filter(line => line.startsWith('generated: '))).toHaveLength(20)
    // Witness: another tool's approval keeps the generic text with parameters cut at 200.
    const generic = (
      AgentStateMachine.prototype as unknown as {
        buildApprovalNotification(a: PendingApproval, u: string, c?: string): string
      }
    ).buildApprovalNotification.call(
      { approvalConfig: { defaultPolicy: 'channel_users', channels: {}, tools: {} } },
      {
        request_id: 'r',
        tool_name: 'other_tool',
        parameters: { files },
        description: 'x',
        tool_call_id: 'c',
        context_snapshot: [],
      },
      'user-1',
      'slack'
    )
    expect(generic).toMatch(/^Tool `other_tool` requires approval\. Parameters: /)
  })

  it('cuts long names to 80 characters with an ellipsis and says so', () => {
    const files = Array.from({ length: 20 }, (_, n) => ({
      kind: 'upload',
      name: `${'x'.repeat(250)}${String(n).padStart(5, '0')}`,
    }))
    for (const lines of [preview(files).text.split('\n'), notification(files).split('\n')]) {
      const named = lines.filter(line => line.startsWith('upload: '))
      expect(named).toHaveLength(20)
      for (const line of named) {
        const name = line.slice('upload: '.length)
        expect([...name]).toHaveLength(80)
        expect(name.endsWith('…')).toBe(true)
      }
      expect(lines).toContain('Total files: 20')
      expect(lines).toContain('Names ending in … are shortened')
      expect(lines.join('\n').length).toBeLessThan(2000)
    }
  })

  it('redacts a protected value in a name in both', () => {
    const files = [{ kind: 'generated', name: `report-${SECRET}.md` }]
    expect(preview(files).text).not.toContain(SECRET)
    expect(preview(files).text).toContain('[REDACTED:P]')
    expect(notification(files)).not.toContain(SECRET)
    // Witness: a name without it is shown as written.
    expect(preview([{ kind: 'generated', name: 'report.md' }]).text).toContain(
      'generated: report.md'
    )
  })
})
