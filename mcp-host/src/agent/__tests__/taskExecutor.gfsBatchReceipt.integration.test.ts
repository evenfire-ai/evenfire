import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { SqliteConversationStore } from '../../core/conversation/persistence/sqliteConversationStore'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { type GfsDownloadReceipt, GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import type { Task } from '../../queue/types'
import { resolveVisualDeliveryLimits } from '../../visualInput/deliveryLimits'
import { ScopedWorkspaceProvider } from '../../workspace/scopedWorkspace'
import { deriveUserKeyFromSource } from '../../workspace/userKey'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

// statfs reports the volume sized to its free space, so the disk's occupancy
// never meets the store's free-space floor.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  const { freeSpaceSizedStatfs } = await import('../../__tests__/fixtures/gfsStoreTestKit')
  return { ...actual, statfs: freeSpaceSizedStatfs(actual.statfs) }
})

const { clientFactory } = vi.hoisted(() => ({ clientFactory: vi.fn() }))
// Double only GFSC's external transport and the model. The native registry,
// store, decoder, shell, SQLite dispatcher and approval reconstruction stay real.
vi.mock('../../internalTools/gfsClient', async importOriginal => ({
  ...(await importOriginal<typeof import('../../internalTools/gfsClient')>()),
  getGfsToolScopes: () => new Set(['gfs.read']),
  createGfscClient: clientFactory,
}))

const { realPngOfSize } = createRequire(
  join(__dirname, 'taskExecutor.gfsBatchReceipt.integration.test.ts')
)('../../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs') as {
  realPngOfSize: (size: number, width: number, height: number, seed: number) => Buffer
}
const bytes = realPngOfSize(12 * 1024, 2, 2, 7)
const digest = createHash('sha256').update(bytes).digest('hex')
const rid = '1234567890abcdef1234567890abcdef'
const uri = `gfs://main/${rid}`
const saved = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}
let root: string | undefined
let store: GfsDownloadStore | undefined
let handle: StoreHandle | undefined
let taskOwner: { id: string; caller: string } | undefined

beforeEach(() => {
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
})
afterEach(async () => {
  await handle?.shutdown()
  // All task methods are awaited by the test. Release only this synthetic
  // owner's remaining pin when a failing assertion interrupted the journey.
  if (store && taskOwner) await store.releaseReceiptOwner(taskOwner.id, taskOwner.caller)
  await store?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
  root = undefined
  store = undefined
  handle = undefined
  taskOwner = undefined
  Object.assign(appConfig, saved)
  vi.clearAllMocks()
})

function shellCall(id: string, command: string): ToolCall {
  return { id, name: 'shell_exec', arguments: { command } }
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

it('keeps the exact workspace receipt through same-batch image suspension, SQLite cold resume and one turn-wide shell approval', async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'gfs-batch-receipt-'))
  store = new GfsDownloadStore(root)
  await store.initialize()
  const createTransfer = vi.spyOn(store, 'createTransfer')
  const readManagedFile = vi.spyOn(store, 'readManagedFile')
  const releaseOwner = vi.spyOn(store, 'releaseReceiptOwner')
  handle = makeSqliteStore()
  const manager = new ConversationManager(handle.store)
  const receipts: GfsDownloadReceipt[] = []
  let contentRequests = 0
  const gfsFetch = vi.fn(async (url: string) => {
    if (url.includes('/content?')) {
      contentRequests += 1
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'x-gfs-uri': uri,
          'x-gfs-version': '7',
        },
      })
    }
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          resourceId: rid,
          rid,
          drive: 'main',
          gfsUri: uri,
          version: 7,
          kind: 'file',
          name: 'synthetic.png',
          bytes: bytes.byteLength,
        },
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  })
  const { createGfscClient } = await vi.importActual<
    typeof import('../../internalTools/gfsClient')
  >('../../internalTools/gfsClient')
  const client = createGfscClient(
    { get: () => undefined, readFile: async () => 'unit-only-identity', fetch: gfsFetch },
    { maxRetryWaitMs: 30_000, random: () => 0 }
  )
  const download = client.download!.bind(client)
  vi.spyOn(client, 'download').mockImplementation(async (...args) => {
    const receipt = await download(...args)
    receipts.push(structuredClone(receipt))
    return receipt
  })
  clientFactory.mockReturnValue(client)

  const firstShell = shellCall('first-shell', 'printf batch-approved')
  const readCall: ToolCall = {
    id: 'read-image',
    name: 'clerum__gfs_read',
    arguments: { drive: 'main', resourceId: rid, expectedVersion: 7 },
  }
  const requests: ChatMessage[][] = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'codex-subscription',
    getVisualDeliveryLimits: () => resolveVisualDeliveryLimits('codex-subscription'),
    classifyError: () => ({
      code: 'LLM_UNKNOWN_ERROR' as never,
      retryable: false,
      message: 'fixture classification',
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected plain completion')
    },
    completeSingleTurnWithTools: async messages => {
      requests.push(structuredClone(messages))
      let calls: ToolCall[] | null = null
      if (requests.length === 1) calls = [readCall, firstShell]
      if (requests.length === 2) {
        const completed = messages.find(
          message => message.tool_call_id === readCall.id && message.role === 'tool'
        )!
        const receipt = JSON.parse(completed.content) as GfsDownloadReceipt & { delivery: string }
        expect(receipt.delivery).toBe('workspace_file')
        expect(receipt).toMatchObject(receipts[0]!)
        const program = `const fs=require("fs"),crypto=require("crypto");const b=fs.readFileSync(${JSON.stringify(receipt.path)});process.stdout.write(JSON.stringify({bytes:b.length,sha256:crypto.createHash("sha256").update(b).digest("hex")}))`
        calls = [
          shellCall(
            'process-retained',
            `${shellQuote(process.execPath)} -e ${shellQuote(program)}`
          ),
        ]
      }
      return {
        content: calls ? null : 'Retained input processed.',
        tool_calls: calls,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: calls ? FinishReason.ToolUse : FinishReason.Stop,
      }
    },
  }
  const task: Task = {
    id: randomUUID(),
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'batch-receipt-caller',
      channelType: 'rpc',
      channelId: 'batch-receipt-chat',
      messageId: 'batch-receipt-message',
      hostRef: 'unit-host',
      timestamp: new Date().toISOString(),
      content: 'Process the synthetic input',
    },
    conversationHistory: [
      { role: 'user', content: 'Process the synthetic input', timestamp: new Date() },
    ],
    responseCallback: vi.fn(async () => undefined),
  }
  const callerRoot = new ScopedWorkspaceProvider(root).forSource(task.sourceMessage).userRootPath
  // The store keys the caller like its root: the channel-namespaced key, never the raw sender.
  const storeCaller = deriveUserKeyFromSource(task.sourceMessage)
  expect(basename(callerRoot)).toBe(storeCaller)
  taskOwner = { id: task.id, caller: storeCaller }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const onFail = vi.fn()
  const onApprovalNeeded = vi.fn()
  const onComplete = vi.fn()
  const deps: TaskExecutorDeps = {
    conversationManager: manager,
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    gfsDownloadStore: store,
    gfsCallerWorkspacePath: callerRoot,
    imageInput: () => ({}),
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
    cronScheduler: null,
    taskLifecycle: lifecycle,
    onApprovalNeeded,
    onComplete,
    onFail,
    dynamicEnvProvider: () => ({}),
  }
  const first = new TaskExecutor(task, deps)
  await first.run()
  expect(onFail).not.toHaveBeenCalled()
  expect(first.executorState).toBe('waiting_approval')
  expect(first.pendingApproval?.tool_call_id).toBe(firstShell.id)
  expect(receipts).toHaveLength(1)
  expect(createTransfer).toHaveBeenCalledWith(
    expect.objectContaining({ retentionOwnerId: task.id })
  )
  expect(readManagedFile).toHaveBeenCalledOnce()
  expect(contentRequests).toBe(1)
  const completed = first.pendingApproval!.completed_results!.find(
    item => item.tool_call_id === readCall.id
  )!
  const expected = {
    ...receipts[0],
    delivery: 'workspace_file',
    visualDelivery: 'not_included',
    visualReason: 'new_gfs_read_required_after_suspension',
    usage: {
      pathSemantics: 'relative-to-caller-workspace',
      nextTool: 'shell_exec_when_local_processing_is_needed',
      approval: 'user-approval-required',
      visualDelivery: 'not_included',
      visualReason: 'new_gfs_read_required_after_suspension',
      writeOutputsTo: 'outputs/',
      processLocally: true,
      boundedOutputOnly: true,
      wholeFileToContextAllowed: false,
    },
  }
  expect(JSON.parse(completed.content)).toMatchObject(expected)
  expect(completed.attachments).toBeUndefined()
  expect(completed.spillover_ref).toBeUndefined()
  expect(JSON.stringify(first.pendingApproval)).not.toContain(bytes.toString('base64'))
  expect(releaseOwner).not.toHaveBeenCalled()

  const coldManager = new ConversationManager(
    new SqliteConversationStore(handle.persistQueue, { cacheSize: 8 })
  )
  const sessionKey = resolveTaskSessionKey(task)
  const coldConversation = await coldManager.getOrCreate(sessionKey)
  expect(coldConversation).not.toBe(manager.getStore().get(sessionKey))
  expect(
    JSON.parse(coldConversation.pending_approval!.completed_results![0].content)
  ).toMatchObject(expected)
  const cold = new TaskExecutor(task, { ...deps, conversationManager: coldManager })
  await cold.rehydrateWaitingApproval(sessionKey, coldConversation.pending_approval!)
  // The shell approval covers the rest of the turn, so the follow-up shell
  // that processes the retained copy runs without a second approval.
  await cold.resumeAfterApproval(false)
  expect(onFail).not.toHaveBeenCalled()
  expect(requests[1].find(message => message.tool_call_id === firstShell.id)?.content).toContain(
    'batch-approved'
  )
  expect(
    requests[1].flatMap(message => message.contentParts ?? []).some(part => part.type === 'image')
  ).toBe(false)
  expect(cold.executorState).toBe('completed')
  expect(onComplete).toHaveBeenCalledExactlyOnceWith(task)
  expect(onApprovalNeeded).toHaveBeenCalledTimes(1)
  const output = requests[2].find(message => message.tool_call_id === 'process-retained')!.content
  // Shell output keeps the production safety envelope around the bounded proof.
  const proof = /\{"bytes":\d+,"sha256":"[0-9a-f]{64}"\}/.exec(output)?.[0]
  expect(proof).toBeDefined()
  expect(JSON.parse(proof!)).toEqual({ bytes: bytes.byteLength, sha256: digest })
  expect(contentRequests).toBe(1)
  expect(releaseOwner).toHaveBeenCalledExactlyOnceWith(task.id, storeCaller)
  expect(JSON.stringify(requests)).not.toContain(bytes.toString('base64'))
})
