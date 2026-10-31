import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AuthorityBindingV2 } from '@clerum/action-context-contracts'
import { validateIncomingAttachments } from '../agent/incomingAttachments'
import { AttachmentReadLedger } from '../core/attachments/attachmentReadBudget'
import type { ExecutionContext, Tool, ToolRegistry } from '../core/interfaces'
import { SimpleEventEmitter } from '../core/orchestration/eventEmitter'
import { executeWithTimeout } from '../core/orchestration/toolExecutionTimeout'
import { executeSingleTool } from '../core/orchestration/toolUseLoop'
import { BasicSafety } from '../core/safety/safety'
import { DefaultToolOutputProcessor } from '../core/safety/toolOutputProcessor'
import { SpilloverStorage } from '../core/spillover'
import { AttachmentReadTool } from '../core/tools/attachmentRead'
import { ShellTool } from '../core/tools/shell'
import type { ToolOutput } from '../core/types'
import type { IncomingMessage } from '../server'
import { withRuntimeActionAuthorityForToolRegistry } from './actionAuthority'

const THRESHOLD = 8192
const PAGE_BYTES = 20 * 1024
const MESSAGE_ID = '6f1c2a9e-4b7d-4c1e-9a53-2f8e7d6c5b4a'
const ATTACHMENT_ID = 'c3d9e8f7-1a2b-4c5d-8e9f-0a1b2c3d4e5f'
const binding = { operationId: 'chat.message.invoke' } as AuthorityBindingV2

function admittedFile(bytes: Buffer) {
  const result = validateIncomingAttachments(
    [
      {
        id: ATTACHMENT_ID,
        kind: 'file',
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64',
        dataBase64: bytes.toString('base64'),
        filename: 'notes.txt',
        sizeBytes: bytes.length,
        digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
    { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 3_145_728, messageId: MESSAGE_ID }
  )
  if (!result.ok)
    throw new Error(`attachment producer rejected the test input: ${result.error.code}`)
  return result.attachments![0]!
}

function readerFor(bytes: Buffer, ledger: AttachmentReadLedger): AttachmentReadTool {
  const message: IncomingMessage = {
    content: 'Analyze the attached file',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-09-24T10:00:00Z',
    messageId: MESSAGE_ID,
    hostRef: 'host-1',
    attachments: [admittedFile(bytes)],
  }
  return new AttachmentReadTool(message, 65_536, {
    contextWindowTokens: 100_000,
    ledger,
    redactor: new BasicSafety(),
  })
}

function registryFor(tool: Tool): ToolRegistry {
  return {
    get: name => (name === tool.name() ? tool : null),
    listDefinitions: () => [],
    register: () => undefined,
  }
}

function execRegistryTool(
  toolRegistry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  storage: SpilloverStorage,
  taskId: string
) {
  const safety = new BasicSafety()
  return executeSingleTool(
    { id: 'tool-call-1', name, arguments: args },
    {
      toolRegistry,
      toolOutputProcessor: new DefaultToolOutputProcessor(safety),
      safety,
      events: new SimpleEventEmitter(),
      toolTimeout: 1000,
      progressReporter: undefined,
      toolProgressInterval: 0,
      spilloverStorage: storage,
      taskId,
      measureToolMessage: message =>
        Math.max(Math.ceil(Buffer.byteLength(message.content ?? '', 'utf8') / 4) + 4, 1),
    }
  )
}

describe('V2 action-authority tool lifecycle', () => {
  let workspace: string | undefined
  let storage: SpilloverStorage | undefined

  afterEach(async () => {
    storage?.stopGc()
    storage = undefined
    if (workspace) await fs.rm(workspace, { recursive: true, force: true })
    workspace = undefined
    vi.restoreAllMocks()
  })

  it('keeps AttachmentRead finalization, accounting, and inline paging in the real tool loop', async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'r67-h1-tool-loop-'))
    storage = new SpilloverStorage({
      workspacePath: workspace,
      thresholdBytes: THRESHOLD,
      ttlMs: 60_000,
      gcIntervalMs: 0,
    })
    const text = 'line of notes\n'.repeat(3000)
    const ledger = new AttachmentReadLedger()
    const reader = readerFor(Buffer.from(text), ledger)
    const finalizeResult = vi.spyOn(reader, 'finalizeResult')
    const checkpoint = vi.fn(async () => 'allowed' as const)
    const v2Registry = withRuntimeActionAuthorityForToolRegistry(
      registryFor(reader),
      binding,
      checkpoint
    )
    const v2Tool = v2Registry.get(reader.name())!

    expect(v2Tool.spilloverExempt?.()).toBe(true)
    const result = await execRegistryTool(
      v2Registry,
      reader.name(),
      { attachmentId: ATTACHMENT_ID, maxBytes: PAGE_BYTES },
      storage,
      'r67-h1-v2'
    )

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('line of notes')
    expect(result.spillover_ref).toBeUndefined()
    expect(finalizeResult).toHaveBeenCalledOnce()
    expect(ledger.snapshot()).toMatchObject({ reads: 1, bytesRead: PAGE_BYTES })
    expect(ledger.snapshot().spentTokens).toBeGreaterThan(0)
    expect(checkpoint).toHaveBeenCalledOnce()

    const legacyLedger = new AttachmentReadLedger()
    const legacyReader = readerFor(Buffer.from(text), legacyLedger)
    const legacy = await execRegistryTool(
      registryFor(legacyReader),
      legacyReader.name(),
      { attachmentId: ATTACHMENT_ID, maxBytes: PAGE_BYTES },
      storage,
      'r67-h1-v1'
    )
    expect(legacy.content).toBe(result.content)
    expect(legacyLedger.snapshot().bytesRead).toBe(PAGE_BYTES)
    expect(checkpoint).toHaveBeenCalledOnce()
  })

  it('preserves ShellTool cancellation settlement and method binding', async () => {
    const shell = new ShellTool(os.tmpdir(), 2000, ['PATH'])
    const futureOptionalHook = function (this: ShellTool): string {
      return this.name()
    }
    const extendedShell = Object.assign(shell, { futureOptionalHook })
    const checkpoint = vi.fn(async () => 'allowed' as const)
    const v2Registry = withRuntimeActionAuthorityForToolRegistry(
      registryFor(extendedShell),
      binding,
      checkpoint
    )
    const v2Tool = v2Registry.get(shell.name())! as Tool & {
      futureOptionalHook(): string
    }

    expect(v2Tool.joinsAbortSettlement?.()).toBe(true)
    expect(v2Tool.futureOptionalHook()).toBe(shell.name())
    expect(v2Tool.timeoutCleanupMs?.()).toBe(shell.timeoutCleanupMs())

    const context: ExecutionContext = { onOutput: () => undefined }
    const controller = new AbortController()
    const pending: Promise<ToolOutput> = executeWithTimeout(
      v2Tool,
      { command: "printf '%s\\n' $$; sleep 60" },
      context,
      1000,
      controller.signal
    )
    const abortTimer = setTimeout(() => controller.abort(new Error('test cancellation')), 25)
    const result = await pending.finally(() => clearTimeout(abortTimer))

    expect(result.is_error).toBe(true)
    const shellPid = Number(result.content.match(/\b(\d{2,})\b/)?.[1])
    expect(Number.isInteger(shellPid)).toBe(true)
    expect(() => process.kill(shellPid, 0)).toThrow()
    expect(checkpoint).toHaveBeenCalledOnce()
  })
})
