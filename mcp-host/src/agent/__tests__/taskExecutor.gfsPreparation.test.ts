import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGfsFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import type { PreparedGfsFile } from '../../core/orchestration/turnContext'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { GfsDownloadStore } from '../../internalTools/gfsDownloadStore'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import type { Task } from '../../queue/types'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

const { clientFactory } = vi.hoisted(() => ({ clientFactory: vi.fn() }))
// Only GFSC's external HTTP/token-file boundary is doubled. The real client,
// store, registry, approval gate, TaskExecutor and shell all execute.
vi.mock('../../internalTools/gfsClient', async importOriginal => ({
  ...(await importOriginal<typeof import('../../internalTools/gfsClient')>()),
  getGfsToolScopes: () => new Set(['gfs.read']),
  createGfscClient: clientFactory,
}))

const rid = '1234567890abcdef1234567890abcdef'
const uri = `gfs://main/${rid}`
const bytes = Buffer.from(`name,value\nfirst,preparation-proof\nsecond,"${'p'.repeat(10000)}"\n`)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const saved = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}
const stores: GfsDownloadStore[] = []
const roots: string[] = []

beforeEach(() =>
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
)
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
  Object.assign(appConfig, saved)
  vi.clearAllMocks()
})

function preparedFiles(messages: ChatMessage[]): PreparedGfsFile[] {
  return messages.flatMap(message =>
    message.content
      .split('\n')
      .filter(line => line.startsWith('prepared_gfs_file:'))
      .map(line => {
        const referenceId = JSON.parse(/id=("(?:[^"\\]|\\.)*") status=/.exec(line)![1]!) as string
        if (line.includes(' status=ready ')) {
          const encoded = line.slice(line.indexOf(' receipt=') + ' receipt='.length)
          return {
            referenceId,
            status: 'ready',
            receipt: JSON.parse(JSON.parse(encoded)),
          } as PreparedGfsFile
        }
        return {
          referenceId,
          status: 'unavailable',
          code: line.slice(line.lastIndexOf(' code=') + 6),
        } as PreparedGfsFile
      })
  )
}

async function scenario(
  options: {
    metadataStatus?: number
    metadataVersion?: number
    startTurnFailure?: boolean
    requireDownloadApproval?: boolean
    mode?: 'inspect' | 'script' | 'download-again'
    includeReference?: boolean
    sender?: string
    stallMetadata?: boolean
  } = {}
) {
  const root = await fs.mkdtemp(join(tmpdir(), 'gfs-preparation-task-'))
  roots.push(root)
  const callerRoot = join(root, 'users', 'unit-caller')
  await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
  const store = new GfsDownloadStore(root)
  await store.initialize()
  stores.push(store)
  const { createGfscClient } = await vi.importActual<
    typeof import('../../internalTools/gfsClient')
  >('../../internalTools/gfsClient')
  let contentRequests = 0
  let metadataRequests = 0
  let enteredMetadata!: () => void
  const metadataEntered = new Promise<void>(resolve => {
    enteredMetadata = resolve
  })
  const gfsFetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/content?')) {
      contentRequests++
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'x-gfs-uri': uri,
          'x-gfs-version': '7',
        },
      })
    }
    metadataRequests++
    enteredMetadata()
    if (options.stallMetadata)
      return new Promise<Response>((_resolve, reject) => {
        const aborted = () => reject(new DOMException('Unit metadata cancelled', 'AbortError'))
        if (init?.signal?.aborted) aborted()
        else init?.signal?.addEventListener('abort', aborted, { once: true })
      })
    if (options.metadataStatus)
      return new Response('untrusted transport detail', { status: options.metadataStatus })
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          resourceId: rid,
          rid,
          drive: 'main',
          gfsUri: uri,
          version: options.metadataVersion ?? 7,
          kind: 'file',
          name: 'unit.input',
          bytes: bytes.byteLength,
        },
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  })
  clientFactory.mockReturnValue(
    createGfscClient(
      { get: () => undefined, readFile: async () => 'unit-only-identity', fetch: gfsFetch },
      { maxRetryWaitMs: appConfig.nativeTool.toolTimeout, random: () => 0 }
    )
  )
  const parsed = buildGfsFileReference({
    drive: 'main',
    resourceId: rid,
    gfsUri: uri,
    version: 7,
    name: 'unit.input',
    byteLength: bytes.byteLength,
    digestHex: sha256,
    classification: classifyBytes({
      bytes,
      totalByteLength: bytes.byteLength,
      filename: 'unit.input',
      declaredMediaType: null,
    }),
  })
  if (!parsed.ok) throw new Error('Invalid fixture reference')
  const requests: ChatMessage[][] = []
  const observedReceipts: PreparedGfsFile[] = []
  let scriptCall: ToolCall | undefined
  const provider: SingleTurnProvider = {
    getProviderType: () => 'codex-subscription',
    classifyError: () => ({
      code: 'LLM_UNKNOWN_ERROR' as never,
      retryable: false,
      message: 'unit classification',
    }),
    completeSingleTurn: async () => {
      throw new Error('Unexpected plain completion')
    },
    completeSingleTurnWithTools: async messages => {
      requests.push(structuredClone(messages))
      const files = preparedFiles(messages)
      if (requests.length === 1) {
        observedReceipts.push(...files)
        expect(JSON.stringify(messages)).not.toContain(bytes.toString())
        expect(JSON.stringify(messages)).not.toContain(bytes.toString('base64'))
        if (files[0]?.status === 'ready') {
          const source = await fs.readFile(join(callerRoot, files[0].receipt.path))
          expect(source).toEqual(bytes)
          expect(createHash('sha256').update(source).digest('hex')).toBe(files[0].receipt.sha256)
        }
        if (options.mode === 'script' && files[0]?.status === 'ready') {
          const input = JSON.stringify(files[0].receipt.path)
          const program = `const fs=require("fs"),crypto=require("crypto");const b=fs.readFileSync(${input});process.stdout.write(JSON.stringify({bytes:b.length,sha256:crypto.createHash("sha256").update(b).digest("hex"),rows:b.toString("utf8").trimEnd().split("\\n").length-1}))`
          scriptCall = {
            id: 'unit-readonly-shell',
            name: 'shell_exec',
            arguments: {
              command: `node -e '${program}'`,
            },
          }
        }
        const call =
          options.mode === 'download-again'
            ? {
                id: 'unit-download-again',
                name: 'clerum__gfs_download',
                arguments: {
                  drive: 'main',
                  resourceId: rid,
                  expectedVersion: 7,
                },
              }
            : scriptCall
        if (call)
          return {
            content: null,
            tool_calls: [call],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            finish_reason: FinishReason.ToolUse,
          }
      }
      return {
        content: 'Preparation fixture complete.',
        tool_calls: null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: FinishReason.Stop,
      }
    },
  }
  const task: Task = {
    id: 'unit-preparation-task',
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: options.sender ?? 'unit-caller',
      content: 'Process the referenced file',
      channelType: 'rpc',
      channelId: 'unit-channel',
      messageId: 'unit-message',
      timestamp: new Date().toISOString(),
      hostRef: 'unit-host',
      ...(options.includeReference === false
        ? {}
        : {
            fileReferences: [parsed.value],
            fileReferenceResolutions: [
              {
                availability: 'available' as const,
                reference: parsed.value,
                surfaces: {
                  metadata: true as const,
                  inline: false,
                  workspace: true,
                  localExecutor: true,
                  visual: false,
                },
              },
            ],
          }),
    },
    conversationHistory: [
      { role: 'user', content: 'Process the referenced file', timestamp: new Date() },
    ],
    responseCallback: vi.fn(async () => undefined),
  }
  const manager = new ConversationManager()
  if (options.startTurnFailure)
    vi.spyOn(manager, 'startTurn').mockRejectedValue(new Error('Unit turn durability failure'))
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const onFail = vi.fn()
  const onApprovalNeeded = vi.fn()
  const deps: TaskExecutorDeps = {
    conversationManager: manager,
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    gfsDownloadStore: store,
    gfsCallerWorkspacePath: callerRoot,
    modelName: 'fixture-model',
    approvalConfig: {
      defaultPolicy: 'channel_users',
      channels: {},
      ...(options.requireDownloadApproval ? { tools: { clerum__gfs_download: true } } : {}),
    },
    config: {
      maxTaskDuration: 300_000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300_000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: lifecycle,
    onApprovalNeeded,
    onComplete: vi.fn(),
    onFail,
    dynamicEnvProvider: () => ({}),
  }
  return {
    executor: new TaskExecutor(task, deps),
    requests,
    observedReceipts,
    onFail,
    onApprovalNeeded,
    callerRoot,
    metadataEntered,
    task,
    lifecycle,
    sessionKey: resolveTaskSessionKey(task),
    createCold: () => new TaskExecutor(task, deps),
    get contentRequests() {
      return contentRequests
    },
    get metadataRequests() {
      return metadataRequests
    },
  }
}

describe('TaskExecutor prepares admitted GFS files before its first model call', () => {
  it('publishes a real byte-free receipt before invoking the provider', async () => {
    const test = await scenario()
    await test.executor.run()
    expect(test.onFail).not.toHaveBeenCalled()
    expect(test.observedReceipts).toMatchObject([
      {
        status: 'ready',
        receipt: {
          source: { kind: 'gfs', drive: 'main', resourceId: rid, version: 7 },
          sha256,
          sizeBytes: bytes.byteLength,
          usage: { visualDelivery: 'not_included', wholeFileToContextAllowed: false },
        },
      },
    ])
    expect(test.contentRequests).toBe(1)
    expect(clientFactory).toHaveBeenCalledTimes(1)
  })

  it('keeps a fresh shell approval and then reads the exact checksum and row count from the prepared path', async () => {
    const test = await scenario({ mode: 'script' })
    await test.executor.run()
    expect(test.onFail).not.toHaveBeenCalled()
    expect(test.executor.executorState).toBe('waiting_approval')
    expect(test.onApprovalNeeded).toHaveBeenCalledTimes(1)
    expect(test.requests).toHaveLength(1)
    expect(JSON.stringify(test.executor.pendingApproval)).not.toContain(bytes.toString())
    expect(JSON.stringify(test.executor.pendingApproval)).not.toContain(bytes.toString('base64'))
    await test.executor.resumeAfterApproval(false)
    expect(test.onFail).not.toHaveBeenCalled()
    const output = test.requests.at(-1)!.find(message => message.role === 'tool')!
    const proof = /\{"bytes":\d+,"sha256":"[0-9a-f]{64}","rows":\d+\}/.exec(output.content)?.[0]
    expect(proof).toBeDefined()
    expect(JSON.parse(proof!)).toEqual({ bytes: bytes.byteLength, sha256, rows: 2 })
    expect(test.contentRequests).toBe(1)
  })

  it('reuses the same prepared version through its cached native registry without downloading again', async () => {
    const test = await scenario({ mode: 'download-again' })
    await test.executor.run()
    expect(test.onFail).not.toHaveBeenCalled()
    const prepared = test.observedReceipts[0]!
    if (prepared.status !== 'ready') throw new Error('Expected a prepared fixture')
    const second = JSON.parse(
      test.requests.at(-1)!.find(message => message.role === 'tool')!.content
    )
    expect(second).toMatchObject({
      id: prepared.receipt.id,
      path: prepared.receipt.path,
      sha256,
      expiresAt: prepared.receipt.expiresAt,
    })
    expect(test.metadataRequests).toBe(2)
    expect(test.contentRequests).toBe(1)
    expect(clientFactory).toHaveBeenCalledTimes(1)
  })

  it('cold-resumes a byte-free opaque receipt and approved command without preparing another copy', async () => {
    const test = await scenario({ mode: 'script' })
    await test.executor.run()
    expect(test.executor.executorState).toBe('waiting_approval')
    const approval = test.executor.pendingApproval!
    const parameters = structuredClone(approval.parameters)
    const cold = test.createCold()
    await cold.rehydrateWaitingApproval(test.sessionKey, approval)
    expect(cold.pendingApproval!.parameters).toEqual(parameters)
    expect(JSON.stringify(cold.pendingApproval)).not.toContain(bytes.toString())
    expect(JSON.stringify(cold.pendingApproval)).not.toContain(bytes.toString('base64'))
    await cold.resumeAfterApproval(false)
    expect(test.onFail).not.toHaveBeenCalled()
    const output = test.requests.at(-1)!.find(message => message.role === 'tool')!
    const proof = /\{"bytes":\d+,"sha256":"[0-9a-f]{64}","rows":\d+\}/.exec(output.content)?.[0]
    expect(proof).toBeDefined()
    expect(JSON.parse(proof!)).toEqual({ bytes: bytes.byteLength, sha256, rows: 2 })
    expect(test.contentRequests).toBe(1)
    expect(test.metadataRequests).toBe(1)
  })

  it('cancels metadata preparation through the task signal before any content or provider request', async () => {
    const test = await scenario({ stallMetadata: true })
    const run = test.executor.run()
    await test.metadataEntered
    test.executor.abort()
    await run
    expect(test.requests).toEqual([])
    expect(test.contentRequests).toBe(0)
    expect(test.lifecycle.getStatus(test.task.id)).toBe('cancelled')
  })

  it.each([
    [{ metadataStatus: 403 }, 'denied'],
    [{ metadataVersion: 8 }, 'stale'],
  ] as const)(
    'reports fresh authorization/version failures without fetching content: %s',
    async (options, code) => {
      const test = await scenario(options)
      await test.executor.run()
      expect(test.observedReceipts).toMatchObject([{ status: 'unavailable', code }])
      expect(test.contentRequests).toBe(0)
      expect(JSON.stringify(test.requests)).not.toContain('untrusted transport detail')
    }
  )

  it('publishes no copy and invokes no model when startTurn fails', async () => {
    const test = await scenario({ startTurnFailure: true })
    await test.executor.run()
    expect(test.onFail).toHaveBeenCalledTimes(1)
    expect(test.requests).toEqual([])
    expect(test.contentRequests).toBe(0)
    expect(test.metadataRequests).toBe(0)
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('defers to the ordinary tool approval flow when download approval is configured', async () => {
    const test = await scenario({ requireDownloadApproval: true })
    await test.executor.run()
    expect(test.observedReceipts).toMatchObject([
      { status: 'unavailable', code: 'approval_required' },
    ])
    expect(test.metadataRequests).toBe(0)
    expect(test.contentRequests).toBe(0)
  })

  it('does not infer a preparation target from ordinary user text', async () => {
    const test = await scenario({ includeReference: false })
    await test.executor.run()
    expect(test.onFail).not.toHaveBeenCalled()
    expect(test.requests).toHaveLength(1)
    expect(test.observedReceipts).toEqual([])
    expect(test.contentRequests).toBe(0)
    expect(test.metadataRequests).toBe(0)
  })
})
