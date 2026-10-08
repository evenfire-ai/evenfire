import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDevStore } from '../../__tests__/fixtures/devGfsStoreFixture'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { ShellTool } from '../../core/tools/shell'
import { type ChatMessage, FinishReason, type ToolCall } from '../../core/types'
import { GfsDownloadStore, GfsDownloadStoreError } from '../../internalTools/gfsDownloadStore'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { logger } from '../../logger'
import type { Task, TaskSource } from '../../queue/types'
import { resolveCallerRootBinding } from '../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../workspace/scopedWorkspace'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const { clientFactory } = vi.hoisted(() => ({ clientFactory: vi.fn() }))
// Only GFSC's external boundary is doubled; the store, registry, approval gate,
// TaskExecutor and shell are real.
vi.mock('../../internalTools/gfsClient', async importOriginal => ({
  ...(await importOriginal<typeof import('../../internalTools/gfsClient')>()),
  getGfsToolScopes: () => new Set(['gfs.read']),
  createGfscClient: clientFactory,
}))

const largeResourceId = 'c'.repeat(32)
const largeFile = {
  source: {
    kind: 'gfs' as const,
    drive: 'main',
    resourceId: largeResourceId,
    gfsUri: `gfs://main/${largeResourceId}`,
    name: 'large.csv',
    version: 7,
  },
  size: 3_836_961,
}
let gfsClient: {
  accessible: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  readMetadata: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
}

const savedConfig = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}
const savedNativeTool = { ...appConfig.nativeTool }
const roots: string[] = []
const stores: GfsDownloadStore[] = []
/** Spies installed with vi.spyOn by a test; restored before the stores close. */
const installedSpies: Array<{ mockRestore: () => void }> = []

beforeEach(() => {
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
  vi.clearAllMocks()
  const unexpected = (name: string) =>
    vi.fn(async () => {
      throw new Error(`Unexpected GFSC ${name} call`)
    })
  gfsClient = {
    accessible: unexpected('accessible'),
    list: unexpected('list'),
    read: unexpected('read'),
    readMetadata: vi.fn(async () => structuredClone(largeFile)),
    download: unexpected('download'),
    stat: unexpected('stat'),
    resolve: unexpected('resolve'),
  }
  clientFactory.mockReturnValue(gfsClient)
})

afterEach(async () => {
  for (const spy of installedSpies.splice(0)) spy.mockRestore()
  for (const store of stores.splice(0)) await store.close().catch(() => undefined)
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
  Object.assign(appConfig, savedConfig)
  Object.assign(appConfig.nativeTool, savedNativeTool)
})

/**
 * A store whose Host root is a symlink: initialize refuses it with
 * workspace_unavailable. The shell workspace stays on the real temp root.
 */
async function unavailableStore() {
  const root = await fs.mkdtemp(join(tmpdir(), 'gfs-shell-safety-'))
  roots.push(root)
  const target = join(root, 'store-target')
  await fs.mkdir(target, { mode: 0o700 })
  const link = join(root, 'store-link')
  await fs.symlink(target, link)
  const store = new GfsDownloadStore(link)
  stores.push(store)
  // Capture the rejection instead of swallowing it so tests can assert which
  // failure the store reported; an initialize that resolves breaks the fixture
  // loudly.
  const initError = await store.initialize().then(
    () => {
      throw new Error('unavailableStore fixture: initialize() resolved on a symlinked Host root')
    },
    (error: unknown) => error
  )
  expect(initError).toMatchObject({ code: 'workspace_unavailable' })
  return { root, store, initError }
}

/**
 * A store whose Host root still holds what the pre-#1028 image left on disk: a
 * ledger with an empty processing lease written by a crashed Host, the v2
 * writer fence and its database. By default the lease is expired; `live`
 * seeds one whose expiry is still in the future.
 */
async function preRedesignStore({ live = false }: { live?: boolean } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'gfs-shell-safety-legacy-'))
  roots.push(root)
  const devStore = await buildDevStore(root, {
    ledger: 'processingLeasesEmpty',
    fence: 'v2-matching',
    sqlite: true,
    userDirs: [],
    lease: live ? 'live' : 'expired',
  })
  if (devStore.ledgerText === undefined)
    throw new Error('preRedesignStore fixture: no ledger was written')
  const ledger = JSON.parse(devStore.ledgerText) as {
    processingLeases: Record<string, { expiresAt: string }>
  }
  const [seededLease] = Object.values(ledger.processingLeases)
  if (seededLease === undefined)
    throw new Error('preRedesignStore fixture: no processing lease was written')
  // Witness for every X1 case: the old store is on disk before the start and
  // the start retires it, so availability cannot come from a missing fixture.
  await expect(fs.lstat(devStore.storeRoot)).resolves.toBeDefined()
  const warn = vi.spyOn(logger, 'warn')
  const store = new GfsDownloadStore(root)
  stores.push(store)
  await store.initialize()
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ component: 'GfsDownloadStore' }),
    'Retired the pre-#1028 GFS download store'
  )
  warn.mockRestore()
  await expect(fs.lstat(join(root, '.gfs-download-store'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  return { root, store, seededLease }
}

type StoreFixture = { root: string; store: GfsDownloadStore; initError?: unknown }

async function healthyStore() {
  const root = await fs.mkdtemp(join(tmpdir(), 'gfs-shell-safety-healthy-'))
  roots.push(root)
  const store = new GfsDownloadStore(root)
  stores.push(store)
  await store.initialize()
  return { root, store }
}

/** Hooks called by the scripted provider at the start and end of every model turn. */
type TurnObserver = {
  turnStarted(turn: number): void
  turnReturned(turn: number, toolCall: ToolCall | undefined): void
}

async function shellScenario({
  source,
  approvalEnabled = true,
  shellApprovalDisabled = false,
  healthy = false,
  preRedesign = false,
  channelCaller = false,
  missingCallerRoot = false,
  calls = [{ id: 'shell-safety', name: 'shell_exec', arguments: { command: 'pwd' } }],
  turnObserver,
  dynamicEnv = {},
  storeFixture,
}: {
  source: TaskSource
  approvalEnabled?: boolean
  shellApprovalDisabled?: boolean
  healthy?: boolean
  preRedesign?: boolean
  channelCaller?: boolean
  missingCallerRoot?: boolean
  calls?: ToolCall[]
  turnObserver?: TurnObserver
  /** Operator-managed env the shell receives through `dynamicEnvProvider`. */
  dynamicEnv?: Record<string, string>
  /** Builds the store the executor is wired to; overrides the flags above. */
  storeFixture?: () => Promise<StoreFixture>
}) {
  appConfig.enableApproval = approvalEnabled
  const fixture: StoreFixture = storeFixture
    ? await storeFixture()
    : preRedesign
      ? await preRedesignStore()
      : healthy
        ? await healthyStore()
        : await unavailableStore()
  const { root, store } = fixture
  const storeInitError = fixture.initError
  const sourceMessage = channelCaller
    ? {
        sender: 'gfs-safety-caller',
        content: 'run pwd',
        channelType: 'rpc' as const,
        channelId: 'gfs-safety-channel',
        messageId: 'gfs-safety-message',
        timestamp: new Date().toISOString(),
        hostRef: 'gfs-safety-host',
      }
    : undefined
  let callerWorkspace = join(root, 'users', '_system')
  if (sourceMessage) {
    const binding = resolveCallerRootBinding(new ScopedWorkspaceProvider(root), sourceMessage)
    if (!binding.root) throw new Error(`Test caller binding failed: ${binding.failureCode}`)
    callerWorkspace = binding.root
  }
  await fs.mkdir(callerWorkspace, { recursive: true, mode: 0o700 })
  const providerCalls: ChatMessage[][] = []
  const advertisedTools: string[][] = []
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
    completeSingleTurnWithTools: async (messages, tools) => {
      const turn = providerCalls.length
      turnObserver?.turnStarted(turn)
      providerCalls.push(structuredClone(messages))
      advertisedTools.push(tools.map(tool => tool.name))
      const call = calls[turn]
      turnObserver?.turnReturned(turn, call)
      return {
        content: call ? null : 'Shell finished.',
        tool_calls: call ? [call] : null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: call ? FinishReason.ToolUse : FinishReason.Stop,
      }
    },
  }
  const task: Task = {
    id: '22222222-2222-4222-8222-222222222222',
    source,
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    ...(sourceMessage ? { sourceMessage } : {}),
    conversationHistory: [{ role: 'user', content: 'run pwd', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const onFail = vi.fn()
  const onApprovalNeeded = vi.fn()
  const deps: TaskExecutorDeps = {
    conversationManager: new ConversationManager(),
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    gfsDownloadStore: store,
    gfsCallerWorkspacePath: missingCallerRoot ? undefined : callerWorkspace,
    modelName: 'fixture-model',
    approvalConfig: {
      defaultPolicy: 'channel_users',
      channels: {},
      ...(shellApprovalDisabled ? { tools: { shell_exec: false } } : {}),
    },
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
    onComplete: vi.fn(),
    onFail,
    dynamicEnvProvider: () => ({ ...dynamicEnv }),
  }
  return {
    executor: new TaskExecutor(task, deps),
    providerCalls,
    advertisedTools,
    onFail,
    onApprovalNeeded,
    callerWorkspace,
    root,
    store,
    storeInitError,
  }
}

it.each([
  ['cron source', { source: 'cron' as TaskSource }],
  ['internal source', { source: 'internal' as TaskSource, approvalEnabled: false }],
  ['approval disabled', { source: 'channel' as TaskSource, approvalEnabled: false }],
  ['shell approval disabled', { source: 'channel' as TaskSource, shellApprovalDisabled: true }],
] as const)(
  'runs managed shell on the caller root while the GFS store needs recovery: %s',
  async (_name, options) => {
    const scenario = await shellScenario(options)
    expect(scenario.store.isAvailable()).toBe(false)
    await scenario.executor.run()

    expect(scenario.onFail).not.toHaveBeenCalled()
    expect(JSON.stringify(scenario.providerCalls)).toContain(scenario.callerWorkspace)
    expect(spawn).toHaveBeenCalledOnce()
  }
)

it('X1: a store left by the pre-#1028 image no longer blocks an approved shell or GFS delivery', async () => {
  const scenario = await shellScenario({
    source: 'channel',
    preRedesign: true,
    channelCaller: true,
  })
  expect(scenario.store.isAvailable()).toBe(true)
  await scenario.executor.run()
  expect(scenario.executor.executorState).toBe('waiting_approval')
  expect(scenario.onApprovalNeeded).toHaveBeenCalledTimes(1)
  expect(scenario.advertisedTools[0]).toContain('clerum__gfs_download')
  expect(scenario.advertisedTools[0]).toContain('shell_exec')

  await scenario.executor.resumeAfterApproval(false)

  expect(scenario.onFail).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledOnce()
  const toolResult = JSON.stringify(scenario.providerCalls.at(-1))
  expect(toolResult).toContain(scenario.callerWorkspace)
  expect(toolResult).not.toContain('Processing lease failed')
  expect(toolResult).not.toContain('download_busy')
})

it('X2: a store at workspace_unavailable keeps shell and GFS reads but withdraws delivery', async () => {
  const scenario = await shellScenario({
    source: 'cron',
    calls: [
      {
        id: 'gfs-read-large',
        name: 'clerum__gfs_read',
        arguments: { drive: 'main', resourceId: largeResourceId },
      },
      { id: 'shell-safety', name: 'shell_exec', arguments: { command: 'pwd' } },
    ],
  })
  // Witness: the store refused to initialize with exactly workspace_unavailable,
  // not with any other initialize failure.
  expect(scenario.storeInitError).toBeInstanceOf(GfsDownloadStoreError)
  expect(scenario.storeInitError).toMatchObject({ code: 'workspace_unavailable' })
  expect(scenario.store.isAvailable()).toBe(false)
  await scenario.executor.run()

  expect(scenario.onFail).not.toHaveBeenCalled()
  const firstTools = scenario.advertisedTools[0]!
  expect(firstTools).toEqual(
    expect.arrayContaining([
      'shell_exec',
      'clerum__gfs_read',
      'clerum__gfs_list',
      'clerum__gfs_stat',
    ])
  )
  expect(firstTools).not.toContain('clerum__gfs_download')
  expect(gfsClient.readMetadata).toHaveBeenCalledOnce()
  expect(gfsClient.download).not.toHaveBeenCalled()
  expect(JSON.stringify(scenario.providerCalls[1])).toContain('workspace_delivery_unavailable')
  expect(spawn).toHaveBeenCalledOnce()
  expect(JSON.stringify(scenario.providerCalls.at(-1))).toContain(scenario.callerWorkspace)
})

it('X2b: a store at workspace_unavailable still answers admitted inline reads, accessible and resolve', async () => {
  const smallResourceId = 'd'.repeat(32)
  const smallSource = {
    kind: 'gfs' as const,
    drive: 'main',
    resourceId: smallResourceId,
    gfsUri: `gfs://main/${smallResourceId}`,
    name: 'small.txt',
    version: 3,
  }
  const smallText = 'inline-admitted-sentinel region=north total=42'
  const accessibleUri = 'gfs://main/accessible-sentinel'
  const resolvedPath = '/reports/resolve-sentinel'
  gfsClient.readMetadata.mockImplementation(async () => ({
    source: structuredClone(smallSource),
    size: Buffer.byteLength(smallText),
  }))
  const releaseReservation = vi.fn()
  gfsClient.read.mockImplementation(async () => ({
    source: structuredClone(smallSource),
    bytes: Buffer.from(smallText, 'utf8'),
    reservation: { release: releaseReservation },
  }))
  gfsClient.accessible.mockImplementation(async () => ({
    items: [{ gfsUri: accessibleUri, permissions: ['read'] }],
  }))
  gfsClient.resolve.mockImplementation(async () => ({
    gfsUri: accessibleUri,
    pathCache: resolvedPath,
  }))
  const scenario = await shellScenario({
    source: 'cron',
    calls: [
      {
        id: 'gfs-read-small',
        name: 'clerum__gfs_read',
        arguments: { drive: 'main', resourceId: smallResourceId },
      },
      { id: 'gfs-accessible', name: 'clerum__gfs_accessible', arguments: { drive: 'main' } },
      { id: 'gfs-resolve', name: 'clerum__gfs_resolve', arguments: { uri: accessibleUri } },
    ],
  })
  // Same fixture as X2: the store refused to initialize with workspace_unavailable.
  expect(scenario.storeInitError).toBeInstanceOf(GfsDownloadStoreError)
  expect(scenario.storeInitError).toMatchObject({ code: 'workspace_unavailable' })
  expect(scenario.store.isAvailable()).toBe(false)
  await scenario.executor.run()

  expect(scenario.onFail).not.toHaveBeenCalled()
  const firstTools = scenario.advertisedTools[0]!
  expect(firstTools).toEqual(
    expect.arrayContaining(['clerum__gfs_read', 'clerum__gfs_accessible', 'clerum__gfs_resolve'])
  )
  expect(firstTools).not.toContain('clerum__gfs_download')
  // Four model turns: three tool calls and the closing answer.
  expect(scenario.providerCalls).toHaveLength(4)

  const toolResult = (turn: number, toolCallId: string) => {
    const message = scenario.providerCalls[turn]!.find(
      m => m.role === 'tool' && m.tool_call_id === toolCallId
    )
    if (!message) throw new Error(`No tool result for ${toolCallId} in turn ${turn}`)
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  }

  // (a) The inline read went through metadata admission, then the in-memory
  // read, and its exact text reached the model; delivery was never attempted.
  expect(gfsClient.readMetadata).toHaveBeenCalledOnce()
  expect(gfsClient.readMetadata.mock.calls[0]![0]).toMatchObject({ resourceId: smallResourceId })
  expect(gfsClient.read).toHaveBeenCalledOnce()
  expect(gfsClient.read.mock.calls[0]![0]).toMatchObject({ resourceId: smallResourceId })
  expect(releaseReservation).toHaveBeenCalledOnce()
  expect(gfsClient.download).not.toHaveBeenCalled()
  const readResult = toolResult(1, 'gfs-read-small')
  expect(readResult).toContain(smallText)
  expect(readResult).not.toContain('workspace_delivery_unavailable')

  // (b) accessible and resolve return their normal client result.
  expect(gfsClient.accessible).toHaveBeenCalledOnce()
  expect(gfsClient.accessible.mock.calls[0]![0]).toMatchObject({ drive: 'main' })
  expect(toolResult(2, 'gfs-accessible')).toContain(accessibleUri)
  expect(gfsClient.resolve).toHaveBeenCalledOnce()
  expect(gfsClient.resolve.mock.calls[0]![0]).toMatchObject({ uri: accessibleUri })
  expect(toolResult(3, 'gfs-resolve')).toContain(resolvedPath)
})

it.each([
  ['cron source', { source: 'cron' as TaskSource }],
  ['internal source', { source: 'internal' as TaskSource, approvalEnabled: false }],
  ['approval disabled', { source: 'channel' as TaskSource, approvalEnabled: false }],
  ['shell consent disabled', { source: 'channel' as TaskSource, shellApprovalDisabled: true }],
] as const)(
  'keeps healthy non-GFS shell behavior on the trusted system root: %s',
  async (_name, options) => {
    const scenario = await shellScenario({ ...options, healthy: true })
    await scenario.executor.run()

    expect(scenario.onFail).not.toHaveBeenCalled()
    expect(JSON.stringify(scenario.providerCalls)).toContain(scenario.callerWorkspace)
    expect(spawn).toHaveBeenCalledOnce()
  }
)

it.each(['cron', 'internal'] as const)(
  'denies %s shell when the trusted caller root is absent',
  async source => {
    const scenario = await shellScenario({
      source,
      healthy: true,
      approvalEnabled: false,
      missingCallerRoot: true,
    })
    await scenario.executor.run()

    expect(scenario.onFail).not.toHaveBeenCalled()
    expect(JSON.stringify(scenario.providerCalls)).toContain('no verified caller workspace')
    expect(spawn).not.toHaveBeenCalled()
  }
)

// ---------------------------------------------------------------------------
// Vacuity falsifiers (#1019 / #1021). Before #1019, TaskExecutor built a
// processing-lease provider from the store and handed it to the shell, so a
// registry-level test cannot reproduce the pre-#1019 behaviour on its own.
// These four tests drive TaskExecutor.run() and must go red when every #1019
// production file is reverted.
// ---------------------------------------------------------------------------

/**
 * Spy on every GfsDownloadStore method, enumerated at runtime so a method that
 * exists only in another revision (the pre-#1019 processing-lease methods, for
 * example) is still covered.
 */
function storeSpyNet(store: GfsDownloadStore) {
  const names = Object.getOwnPropertyNames(GfsDownloadStore.prototype).filter(
    name =>
      name !== 'constructor' &&
      typeof Object.getOwnPropertyDescriptor(GfsDownloadStore.prototype, name)?.value === 'function'
  )
  const spies = new Map(
    names.map(name => {
      const spy = vi.spyOn(
        store as unknown as Record<string, (...args: unknown[]) => unknown>,
        name
      )
      installedSpies.push(spy)
      return [name, spy] as const
    })
  )
  const counts = () => new Map([...spies].map(([name, spy]) => [name, spy.mock.calls.length]))
  return { names, spies, counts }
}

/**
 * Record, for every ShellTool.execute call, the timeout the executor passed and
 * the store methods called between entering and leaving execute.
 */
function shellExecuteWindows(net: ReturnType<typeof storeSpyNet>, timeline?: string[]) {
  const windows: Array<{ timeoutMs: number | undefined; storeCalls: string[] }> = []
  const original = ShellTool.prototype.execute
  const spy = vi.spyOn(ShellTool.prototype, 'execute').mockImplementation(async function (
    this: ShellTool,
    params,
    context
  ) {
    timeline?.push('shell execute entered')
    const before = net.counts()
    try {
      return await original.call(this, params, context)
    } finally {
      timeline?.push('shell execute returned')
      const after = net.counts()
      windows.push({
        timeoutMs: context?.timeoutMs,
        storeCalls: [...after]
          .filter(([name, calls]) => calls > (before.get(name) ?? 0))
          .map(([name]) => name),
      })
    }
  })
  installedSpies.push(spy)
  return windows
}

/**
 * Record the store methods called during the whole TaskExecutor dispatch of
 * every shell_exec call: the window opens when the scripted model returns the
 * call to the executor and closes when the executor sends the next model turn,
 * which carries the tool result. Everything the executor does for that call
 * (tool loop, approval gate, registry lookup, ShellTool.execute, output
 * processing) falls inside it. Registry construction before the first turn and
 * the terminal retention settlement after the last turn fall outside it by
 * construction, because no shell call is in flight then.
 */
function shellDispatchWindows(timeline: string[]) {
  let net: ReturnType<typeof storeSpyNet> | undefined
  let open: { toolCallId: string; before: Map<string, number> } | undefined
  const windows: Array<{ toolCallId: string; storeCalls: string[] }> = []
  const liveNet = () => {
    if (!net) throw new Error('shellDispatchWindows: the store spy net was never attached')
    return net
  }
  const observer: TurnObserver = {
    turnStarted(turn) {
      if (open) {
        const after = liveNet().counts()
        const before = open.before
        windows.push({
          toolCallId: open.toolCallId,
          storeCalls: [...after]
            .filter(([name, calls]) => calls > (before.get(name) ?? 0))
            .map(([name]) => name),
        })
        open = undefined
      }
      timeline.push(`turn ${turn} started`)
    },
    turnReturned(turn, toolCall) {
      timeline.push(`turn ${turn} returned ${toolCall?.name ?? 'final answer'}`)
      if (toolCall?.name === 'shell_exec')
        open = { toolCallId: toolCall.id, before: liveNet().counts() }
    },
  }
  return {
    observer,
    windows,
    attach(spyNet: ReturnType<typeof storeSpyNet>) {
      net = spyNet
    },
    /** A window still open after run() means the tool result never reached the model. */
    unclosed: () => open?.toolCallId,
  }
}

it('X1-shell: a store left by the pre-#1028 image does not stop an approved shell (#1019)', async () => {
  const scenario = await shellScenario({
    source: 'channel',
    preRedesign: true,
    channelCaller: true,
  })
  await scenario.executor.run()
  // Witness: the executor reached the live approval gate for shell_exec.
  expect(scenario.onApprovalNeeded).toHaveBeenCalledTimes(1)

  await scenario.executor.resumeAfterApproval(false)

  // Claim: the approved command spawned in the caller root and its stdout returned.
  expect(spawn).toHaveBeenCalledOnce()
  expect(vi.mocked(spawn).mock.calls[0]![2]).toMatchObject({ cwd: scenario.callerWorkspace })
  expect(JSON.stringify(scenario.providerCalls.at(-1))).toContain(scenario.callerWorkspace)
  expect(scenario.onFail).not.toHaveBeenCalled()
})

it('X1-delivery: a store left by the pre-#1028 image is ignored and GFS delivery stays advertised (#1019)', async () => {
  const scenario = await shellScenario({
    source: 'channel',
    preRedesign: true,
    channelCaller: true,
  })
  await scenario.executor.run()
  // Witness: the provider received a tool list built by the executor's registry.
  expect(scenario.advertisedTools.length).toBeGreaterThan(0)
  expect(scenario.advertisedTools[0]).toContain('shell_exec')
  // Claim: delivery is advertised because the store came up available.
  expect(scenario.advertisedTools[0]).toContain('clerum__gfs_download')
  expect(scenario.store.isAvailable()).toBe(true)
})

/**
 * A shell call whose stdout marker never appears verbatim in the command text,
 * so finding the marker in the tool result proves the command ran.
 */
function markerCall(id: string, prefix: string): { call: ToolCall; marker: string } {
  return {
    call: { id, name: 'shell_exec', arguments: { command: `printf '%s_%s' ${prefix} STDOUT` } },
    marker: `${prefix}_STDOUT`,
  }
}

function shellToolResult(providerCalls: ChatMessage[][], toolCallId: string): string {
  const message = providerCalls.flat().find(m => m.role === 'tool' && m.tool_call_id === toolCallId)
  if (!message) throw new Error(`No tool result for ${toolCallId}`)
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

async function livePreRedesignScenario(call: ToolCall) {
  let seededLease: { expiresAt: string } | undefined
  const scenario = await shellScenario({
    source: 'channel',
    channelCaller: true,
    calls: [call],
    storeFixture: async () => {
      const fixture = await preRedesignStore({ live: true })
      seededLease = fixture.seededLease
      return fixture
    },
  })
  // Witness: the seeded lease is live by its own expiry, so ignoring it cannot
  // be explained by expiry.
  expect(seededLease).toBeDefined()
  expect(Date.parse(seededLease!.expiresAt)).toBeGreaterThan(Date.now())
  return scenario
}

it('X1-shell-live: a store with a non-expired legacy lease left by the pre-#1028 image does not stop an approved shell (#1019)', async () => {
  const { call, marker } = markerCall('shell-live', 'X1_SHELL_LIVE')
  const scenario = await livePreRedesignScenario(call)
  await scenario.executor.run()
  // Witness: the executor reached the live approval gate for shell_exec.
  expect(scenario.onApprovalNeeded).toHaveBeenCalledTimes(1)
  expect(scenario.advertisedTools[0]).toContain('clerum__gfs_download')

  await scenario.executor.resumeAfterApproval(false)

  expect(spawn).toHaveBeenCalledOnce()
  expect(vi.mocked(spawn).mock.calls[0]![2]).toMatchObject({ cwd: scenario.callerWorkspace })
  expect(shellToolResult(scenario.providerCalls, call.id)).toContain(marker)
  expect(scenario.onFail).not.toHaveBeenCalled()
})

it('X1-delivery-live: a store with a non-expired legacy lease left by the pre-#1028 image is ignored and GFS delivery stays advertised (#1019)', async () => {
  const { call, marker } = markerCall('shell-live-delivery', 'X1_DELIVERY_LIVE')
  const scenario = await livePreRedesignScenario(call)
  await scenario.executor.run()
  // Witness: the provider received a tool list built by the executor's registry.
  expect(scenario.advertisedTools.length).toBeGreaterThan(0)
  expect(scenario.advertisedTools[0]).toContain('shell_exec')
  expect(scenario.advertisedTools[0]).toContain('clerum__gfs_download')
  expect(scenario.store.isAvailable()).toBe(true)
  expect(scenario.onApprovalNeeded).toHaveBeenCalledTimes(1)

  await scenario.executor.resumeAfterApproval(false)

  expect(shellToolResult(scenario.providerCalls, call.id)).toContain(marker)
  expect(scenario.onFail).not.toHaveBeenCalled()
})

describe('U5-TE: TaskExecutor runs a managed shell with a timeout above the former lease ceiling (#1021)', () => {
  it.each([
    ['exactly one hour', 3_600_000],
    ['one millisecond over one hour', 3_600_001],
  ])('%s', async (_label, timeoutMs) => {
    Object.assign(appConfig.nativeTool, { shellTimeout: timeoutMs, toolTimeout: timeoutMs })
    const scenario = await shellScenario({ source: 'cron', healthy: true })
    const windows = shellExecuteWindows(storeSpyNet(scenario.store))

    await scenario.executor.run()

    // Witness: the effective timeout reached ShellTool.execute unchanged.
    expect(windows).toHaveLength(1)
    expect(windows[0]!.timeoutMs).toBe(timeoutMs)
    // Claim: the command spawned and its stdout reached the model.
    expect(spawn).toHaveBeenCalledOnce()
    expect(JSON.stringify(scenario.providerCalls.at(-1))).toContain(scenario.callerWorkspace)
    expect(scenario.onFail).not.toHaveBeenCalled()
  })
})

it('X3-TE: a shell dispatch inside TaskExecutor makes zero GFS download store calls (#1019)', async () => {
  const timeline: string[] = []
  const dispatch = shellDispatchWindows(timeline)
  const scenario = await shellScenario({
    source: 'cron',
    healthy: true,
    turnObserver: dispatch.observer,
  })
  const net = storeSpyNet(scenario.store)
  dispatch.attach(net)
  const executeWindows = shellExecuteWindows(net, timeline)

  await scenario.executor.run()

  // Witnesses: the net is attached to the store instance the executor wired
  // (isAvailable is read while the registry is built, outside the dispatch
  // window), exactly one shell dispatch window opened and closed with
  // ShellTool.execute nested inside it, and the command's stdout reached the model.
  expect(net.names).toContain('isAvailable')
  expect(net.spies.get('isAvailable')!.mock.calls.length).toBeGreaterThan(0)
  expect(dispatch.unclosed()).toBeUndefined()
  expect(dispatch.windows).toEqual([{ toolCallId: 'shell-safety', storeCalls: expect.any(Array) }])
  expect(executeWindows).toHaveLength(1)
  expect(timeline).toEqual([
    'turn 0 started',
    'turn 0 returned shell_exec',
    'shell execute entered',
    'shell execute returned',
    'turn 1 started',
    'turn 1 returned final answer',
  ])
  expect(spawn).toHaveBeenCalledOnce()
  expect(JSON.stringify(scenario.providerCalls.at(-1))).toContain(scenario.callerWorkspace)
  // Claim: no store method ran from the moment the executor received the shell
  // call until it returned the shell result to the model.
  expect(dispatch.windows[0]!.storeCalls).toEqual([])
  expect(executeWindows[0]!.storeCalls).toEqual([])
})

/** A store that was constructed but never initialized. */
async function uninitializedStore(): Promise<StoreFixture> {
  const root = await fs.mkdtemp(join(tmpdir(), 'gfs-shell-safety-uninitialized-'))
  roots.push(root)
  const store = new GfsDownloadStore(root)
  stores.push(store)
  // Witness: a store that never ran initialize() reports itself unavailable.
  expect(store.isAvailable()).toBe(false)
  return { root, store }
}

/** A store that initialized and was then closed. */
async function closedStore(): Promise<StoreFixture> {
  const { root, store } = await healthyStore()
  // Witness: the store was available before close, so close made it unavailable.
  expect(store.isAvailable()).toBe(true)
  await store.close()
  return { root, store }
}

describe('X6: an approved shell runs while the store is unavailable', () => {
  it.each([
    ['never initialized', uninitializedStore],
    ['store closed', closedStore],
    ['initialize rejected with workspace_unavailable', unavailableStore],
  ] as const)('%s', async (_label, storeFixture) => {
    const { call, marker } = markerCall('shell-unavailable', 'X6_SHELL')
    const timeline: string[] = []
    const dispatch = shellDispatchWindows(timeline)
    const scenario = await shellScenario({
      source: 'cron',
      calls: [call],
      turnObserver: dispatch.observer,
      storeFixture,
    })
    // Witness: the store the executor is wired to is unavailable.
    expect(scenario.store.isAvailable()).toBe(false)
    const net = storeSpyNet(scenario.store)
    dispatch.attach(net)
    const executeWindows = shellExecuteWindows(net, timeline)

    await scenario.executor.run()

    // Witnesses: the executor read the unavailable store while building the
    // registry and withdrew delivery; exactly one shell dispatch window opened
    // and closed with ShellTool.execute nested inside it.
    expect(net.spies.get('isAvailable')!.mock.calls.length).toBeGreaterThan(0)
    expect(scenario.advertisedTools[0]).toContain('shell_exec')
    expect(scenario.advertisedTools[0]).not.toContain('clerum__gfs_download')
    expect(dispatch.unclosed()).toBeUndefined()
    expect(dispatch.windows).toEqual([{ toolCallId: call.id, storeCalls: expect.any(Array) }])
    expect(executeWindows).toHaveLength(1)
    expect(timeline).toEqual([
      'turn 0 started',
      'turn 0 returned shell_exec',
      'shell execute entered',
      'shell execute returned',
      'turn 1 started',
      'turn 1 returned final answer',
    ])
    // Claim: the command ran and its stdout reached the model.
    expect(spawn).toHaveBeenCalledOnce()
    expect(shellToolResult(scenario.providerCalls, call.id)).toContain(marker)
    expect(scenario.onFail).not.toHaveBeenCalled()
    // Claim: no store method ran while the shell call was dispatched.
    expect(dispatch.windows[0]!.storeCalls).toEqual([])
    expect(executeWindows[0]!.storeCalls).toEqual([])
  })
})

it('X5-env: a NUL secret in the dynamic shell environment fails to start without exposing its value (#1020)', async () => {
  const secretTail = 's3cr3t-marker-1028'
  const secretFragments = ['s3cr3t', 'marker-1028', secretTail]
  const envCall: ToolCall = {
    id: 'shell-env-nul',
    name: 'shell_exec',
    arguments: { command: 'printf "%s" "$CLERUM_TEST_SECRET"' },
  }
  const logCalls: unknown[][] = []
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    const spy = vi.spyOn(logger, level)
    installedSpies.push(spy)
    logCalls.push(spy.mock.calls as unknown as unknown[])
  }
  const loggedText = () =>
    JSON.stringify(logCalls.flat(), (_key, value) =>
      value instanceof Error ? { message: value.message, stack: value.stack } : value
    )
  const toolResult = (providerCalls: ChatMessage[][]) => {
    const message = providerCalls[1]?.find(m => m.role === 'tool' && m.tool_call_id === envCall.id)
    if (!message) throw new Error(`No tool result for ${envCall.id} in turn 1`)
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  }

  // Witness: the same dynamic variable without the NUL reaches the shell, so the
  // provider is wired and the command would print the secret if it could start.
  const clean = await shellScenario({
    source: 'cron',
    healthy: true,
    calls: [envCall],
    dynamicEnv: { CLERUM_TEST_SECRET: `a${secretTail}` },
  })
  await clean.executor.run()
  expect(clean.onFail).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledOnce()
  expect(toolResult(clean.providerCalls)).toContain(`a${secretTail}`)

  vi.mocked(spawn).mockClear()
  for (const calls of logCalls) calls.splice(0)
  const scenario = await shellScenario({
    source: 'cron',
    healthy: true,
    calls: [envCall],
    dynamicEnv: { CLERUM_TEST_SECRET: `a\0${secretTail}` },
  })
  await scenario.executor.run()

  expect(scenario.onFail).not.toHaveBeenCalled()
  // The model sees only the key, never the value, inside the tool-output envelope.
  const result = toolResult(scenario.providerCalls)
  expect(result).toBe(
    [
      '<tool_output name="shell_exec" sanitized="false">',
      'Command failed to start: environment variable CLERUM_TEST_SECRET contains a NUL character',
      '</tool_output>',
    ].join('\n')
  )
  expect(result).not.toContain('Tool execution failed:')
  const modelVisible = JSON.stringify(scenario.providerCalls)
  // Witness for the log assertions: the shell logged its own start failure.
  expect(loggedText()).toContain('ENV_VALUE_CONTAINS_NUL')
  for (const fragment of secretFragments) {
    expect(result).not.toContain(fragment)
    expect(modelVisible).not.toContain(fragment)
    expect(loggedText()).not.toContain(fragment)
  }
  expect(loggedText()).not.toContain('Tool execution failed')
  expect(spawn).not.toHaveBeenCalled()
})
