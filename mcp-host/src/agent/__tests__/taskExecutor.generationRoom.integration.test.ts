// A chat generation through the real TaskExecutor, registry and download
// store, on a simulated volume of fixed size: other callers' kept files over
// the Host bound refuse it, and once they pass their retention the same call
// is admitted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import {
  KEPT_STORAGE_FULL_NO_DELETE,
  STORE_UNAVAILABLE_FOR_GENERATION,
} from '../../core/tools/nativeToolRegistry'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import { GFS_FILE_LIMITS } from '../../internalTools/gfsFilePolicy'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import { resolveCallerRootBinding } from '../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../workspace/scopedWorkspace'
import { CronScheduler } from '../cronScheduler'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

// The store's volume: 200 MiB whose free space is its size minus every
// regular file under the Host root (budget 140 MiB, Host kept bound 105 MiB).
const { statfsBoundary } = vi.hoisted(() => ({ statfsBoundary: vi.fn() }))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof import('node:fs/promises')>()),
  statfs: statfsBoundary,
}))
// The generators' free-space floor reads the volume as roomy.
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

const MIB = 1024 * 1024
const TOTAL = 200 * MIB
const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}
const stores: GfsDownloadStore[] = []
let hostRoot: string

function regularBytes(directory: string): number {
  let sum = 0
  for (const child of syncFs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, child.name)
    if (child.isDirectory()) sum += regularBytes(target)
    else if (child.isFile()) sum += syncFs.lstatSync(target).size
  }
  return sum
}

function setScopes(scopes: string[] | undefined): void {
  if (scopes === undefined) {
    delete process.env[ACCESS_ENV]
    return
  }
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  process.env[ACCESS_ENV] =
    `${header}.${Buffer.from(JSON.stringify({ scopes })).toString('base64url')}.sig`
}

beforeEach(async () => {
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
  hostRoot = syncFs.realpathSync(syncFs.mkdtempSync(path.join(tmpdir(), 'generation-room-')))
  const nativeFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  statfsBoundary.mockReset()
  statfsBoundary.mockImplementation(async (target: string) => {
    const real = await nativeFs.statfs(target, { bigint: true })
    return {
      ...real,
      bsize: 1n,
      blocks: BigInt(TOTAL),
      bavail: BigInt(TOTAL - regularBytes(hostRoot)),
    }
  })
  setScopes(['gfs.read', 'gfs.write'])
})

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close(0)
  await fs.rm(hostRoot, { recursive: true, force: true })
  Object.assign(appConfig, savedConfig)
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
})

/** Kept files of three other callers, 36 MiB each: 108 MiB, over the 105 MiB Host bound. */
function othersKeep(): string[] {
  return ['other-1', 'other-2', 'other-3'].map(key => {
    const outputs = path.join(hostRoot, 'users', key, '.clerum-outputs')
    syncFs.mkdirSync(outputs, { recursive: true, mode: 0o700 })
    const file = path.join(outputs, 'big.md')
    syncFs.writeFileSync(file, Buffer.alloc(36 * MIB, 0x61))
    return file
  })
}

const generateCall: ToolCall = {
  id: 'generate-notes',
  name: 'clerum__generate_markdown',
  arguments: { filename: 'notes.md', content: '# Notes\nfirst line\n' },
}

async function turn(store: GfsDownloadStore) {
  const task: Task = {
    id: randomUUID(),
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'room-caller',
      content: 'Write my notes',
      channelType: 'rpc',
      channelId: 'room-channel',
      messageId: `room-message-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      hostRef: 'room-host',
    },
    conversationHistory: [{ role: 'user', content: 'Write my notes', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  const binding = resolveCallerRootBinding(
    new ScopedWorkspaceProvider(hostRoot),
    task.sourceMessage
  )
  if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
  const providerCalls: ChatMessage[][] = []
  const calls = [generateCall, null]
  const provider: SingleTurnProvider = {
    getProviderType: () => 'codex-subscription',
    classifyError: () => ({
      code: 'LLM_UNKNOWN_ERROR' as never,
      retryable: false,
      message: 'fixture classification is never used',
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected non-tool completion')
    },
    completeSingleTurnWithTools: async messages => {
      providerCalls.push(structuredClone(messages))
      const call = calls[providerCalls.length - 1]
      return {
        content: call ? null : 'Done.',
        tool_calls: call ? [call] : null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: call ? FinishReason.ToolUse : FinishReason.Stop,
      }
    },
  }
  const conversationManager = new ConversationManager()
  await conversationManager.getOrCreate(resolveTaskSessionKey(task), {
    userId: task.sourceMessage!.sender,
    channelType: task.sourceMessage!.channelType,
    channelId: task.sourceMessage!.channelId,
  })
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const onFail = vi.fn()
  const deps: TaskExecutorDeps = {
    conversationManager,
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    gfsDownloadStore: store,
    gfsCallerWorkspacePath: binding.root,
    modelName: 'fixture-model',
    approvalConfig: { defaultPolicy: 'channel_users', channels: {} },
    config: {
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 30_000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: new CronScheduler(new MessageQueue()),
    taskLifecycle: lifecycle,
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail,
    dynamicEnvProvider: () => ({}),
  }
  const executor = new TaskExecutor(task, deps)
  await executor.run()
  const result = providerCalls
    .flat()
    .find(message => message.role === 'tool' && message.tool_call_id === generateCall.id)
  return {
    executor,
    onFail,
    result: result?.content ?? '',
    notes: path.join(binding.root, '.clerum-outputs', 'notes.md'),
  }
}

async function openStore(): Promise<GfsDownloadStore> {
  const store = new GfsDownloadStore(hostRoot)
  stores.push(store)
  await store.initialize()
  return store
}

describe('a chat generation checked against the kept bounds of the Host', () => {
  it('is refused while other callers hold the bound, and admitted once their files expire', async () => {
    const others = othersKeep()
    const store = await openStore()
    const refused = await turn(store)
    expect(refused.onFail).not.toHaveBeenCalled()
    expect(refused.result).toContain('Host storage for kept files is full')
    expect(refused.result).toContain('user_cannot_free_enough')
    expect(syncFs.existsSync(refused.notes)).toBe(false)
    // The other callers' files pass their retention: the sweep of the next
    // generation removes them first.
    const old = new Date(Date.now() - GFS_FILE_LIMITS.retentionMs - 3_600_000)
    for (const file of others) syncFs.utimesSync(file, old, old)
    const admitted = await turn(store)
    expect(admitted.result).toContain('File generated: notes.md')
    expect(syncFs.existsSync(admitted.notes)).toBe(true)
    expect(others.filter(file => syncFs.existsSync(file))).toEqual([])
  }, 60_000)

  it('applies on a token with no GFS scope, with the fixed sentence', async () => {
    setScopes(undefined)
    othersKeep()
    const store = await openStore()
    const refused = await turn(store)
    expect(refused.onFail).not.toHaveBeenCalled()
    expect(refused.result).toContain(KEPT_STORAGE_FULL_NO_DELETE)
    expect(syncFs.existsSync(refused.notes)).toBe(false)
  }, 60_000)

  it('is refused while the store is closed, and the turn completes', async () => {
    const store = await openStore()
    await store.close(0)
    const refused = await turn(store)
    expect(refused.onFail).not.toHaveBeenCalled()
    expect(refused.executor.executorState).toBe('completed')
    expect(refused.result).toBe(`Error: ${STORE_UNAVAILABLE_FOR_GENERATION}`)
    expect(syncFs.existsSync(refused.notes)).toBe(false)
  }, 60_000)
})
