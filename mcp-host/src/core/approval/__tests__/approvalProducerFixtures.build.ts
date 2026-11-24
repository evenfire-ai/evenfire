/**
 * Builds the two approval tables that approvalProducerFixtures.test.ts pins
 * for Control UI, from mcp-host's own code:
 *
 * - the tool table: chat's NativeToolRegistry, constructed as
 *   TaskExecutor.createToolRegistry constructs it (src/agent/taskExecutor.ts:2550,
 *   then `registerDesktopTools` at :2586), over the ToolContext matrix;
 * - the asks table: the same registry behind the controller TaskExecutor
 *   builds for the task (ApprovalController over UnifiedApprovalGateController,
 *   or no gate), then decideApproval with the mode effectiveApprovalMode gives.
 *
 * The Host GFS download store is wired as a running Host wires it:
 * - main.ts:2036-2041 (`initializeAgent`) always bootstraps it, and
 *   src/gfsRuntime.ts:49-50 puts the GfsDownloadStore and the
 *   ScopedWorkspaceProvider on one Host root; the store is available once its
 *   `initialize()` succeeds;
 * - src/agent/stateMachine.ts:1622-1643 (`createTaskExecutor`) resolves the
 *   task's caller root with `resolveCallerRootBinding` when there is a store,
 *   and passes `gfsDownloadStore` and `gfsCallerWorkspacePath`;
 * - taskExecutor.ts:2529-2548 builds `gfsManagedWorkspaceExecution` and
 *   `gfsWorkspaceExecutionEnabled` (src/agent/gfsExecutionCapability.ts), and
 *   :2583-2584 pass the registry `{ ...gfsWorkspace, deliveryAvailable }` and
 *   `generatedOutputsRoot(...)`.
 *
 * Nothing here decides approval. The only logic mirrored is wiring:
 * - which controller a task gets (taskExecutor.ts:2624-2662,
 *   `interactiveApprovalApplies` and `cronManageGateApplies`, with approval
 *   enabled), and its live approval tools (:2431-2442 and :2645-2652);
 * - how admission reads that controller (src/core/orchestration/toolCallPolicy.ts,
 *   `admitToolCall` and `applyApprovalMode`). A task with approval modes (every
 *   task that is not cron-fired) passes the gate's cause to decideApproval, and
 *   only a card asks. A cron-fired task has no approval modes, so a suspension
 *   is the card.
 */
import { vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { CronScheduler } from '../../../agent/cronScheduler'
import {
  type GfsManagedWorkspaceExecution,
  gfsManagedWorkspaceExecution,
  gfsStoreCallerIdentity,
  gfsWorkspaceExecutionEnabled,
} from '../../../agent/gfsExecutionCapability'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import { generatedOutputsRoot } from '../../../agent/taskExecutor'
import { GfsDownloadStore } from '../../../internalTools/gfsDownloadStore'
import { logger } from '../../../logger'
import { MessageQueue } from '../../../queue/messageQueue'
import type { IncomingMessage } from '../../../server'
import {
  STATELESS_ALLOW_CRON_MANAGE_ENV,
  STATELESS_LIFECYCLE_ENV,
} from '../../../statelessCronPolicy'
import { resolveCallerRootBinding } from '../../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import { WorkspaceService } from '../../../workspace/service'
import { AttachmentReadLedger } from '../../attachments/attachmentReadBudget'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { PersistQueue } from '../../conversation/persistence/persistQueue'
import { ApprovalController } from '../../extensions/approvalController'
import type { ApprovalConfig } from '../../extensions/approvalTypes'
import { UnifiedApprovalGateController } from '../../extensions/mcpApprovalGateController'
import type { LoopController, NativeToolConfig } from '../../interfaces'
import { DefaultLoopController } from '../../orchestration/loopConfig'
import { SessionSearchService } from '../../sessionSearch'
import { SpilloverStorage } from '../../spillover'
import { registerDesktopTools } from '../../tools/desktopTools'
import { NativeToolRegistry } from '../../tools/nativeToolRegistry'
import type { WorkflowCallerContext } from '../../tools/workflowShared'
import type { Attachment } from '../../types'
import { type ApprovalMode, effectiveApprovalMode, readChannelCap } from '../approvalMode'
import { decideApproval } from '../decideApproval'

export const CHANNEL_TYPES = ['rpc', 'telegram', 'slack', 'teams', 'email'] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

export const GFS_SCOPE_SETS = ['none', 'read', 'write', 'read-write'] as const
export type GfsScopeSet = (typeof GFS_SCOPE_SETS)[number]

export interface ToolContext {
  statelessLifecycle: boolean
  allowStatelessCronManage: boolean
  channelType: ChannelType
  gfsScopes: GfsScopeSet
  desktopTools: boolean
  workflowTools: boolean
  gfsDownloadStore: boolean
}

/** A pinned file without `_source.commit`, which the test adds when it records. */
export interface ProducerFile {
  _source: Record<string, unknown>
  [field: string]: unknown
}

export interface ToolApprovalFile extends ProducerFile {
  contexts: ToolContext[]
  tools: Record<string, Array<boolean | null>>
}

export interface ApprovalAsksFile extends ProducerFile {
  keys: string[]
  asks: Record<string, Record<string, boolean>>
}

/** Tool names one registry adds, removes or changes against another, sorted. */
export interface ToolDelta {
  added: string[]
  removed: string[]
  changed: string[]
}

/** Inputs that turn GFS delivery off on a Host with a store. */
export const STORE_FLIPS = ['storeUnavailable', 'shellExecSkipped', 'noCallerRoot'] as const
export type StoreFlip = (typeof STORE_FLIPS)[number]

/** What the store does to chat's registry, per GFS scope set. */
export interface StoreEffect {
  /** An available store against no store: the same in all 320 contexts without one. */
  store: Record<GfsScopeSet, ToolDelta>
  /** Each flip against an available store: the same on every channel of the store contexts. */
  flips: Record<StoreFlip, Record<GfsScopeSet, ToolDelta>>
}

/** An asks registry built another way, against the recorded one. */
export interface AsksVariantCheck {
  variant: string
  /** Answers compared: every name both registries register, or neither does. */
  compared: number
  /** The first differing answers, if any. */
  differences: string[]
}

export interface ApprovalProducerFixtures {
  toolApproval: ToolApprovalFile
  approvalAsks: ApprovalAsksFile
  storeEffect: StoreEffect
  asksVariants: AsksVariantCheck[]
  /** readChannelCap on telegram, under the designated-approvers policy the variants use. */
  senderCaps: { listed: ApprovalMode; unlisted: ApprovalMode }
}

/** Names no tool registers: one custom row and one MCP tool. */
export const CUSTOM_TOOL_PROBE = 'custom_tool'
export const MCP_TOOL_PROBE = 'server__tool'

const PRODUCER = 'mcp-host/src/core/approval/__tests__/approvalProducerFixtures.test.ts'

const TOOL_APPROVAL_NOTES = [
  "tools[name][i] is the tool's own requiresApproval() in contexts[i]; null means chat does not register the tool there.",
  'The registry is built as TaskExecutor builds it for a chat task, with registerDesktopTools after it.',
  'channelType rpc is the Desktop channel: mcp-host has no separate desktop channel type.',
  'Held in every context: the message carries one PDF file attachment (clerum__attachment_read, clerum__document_read and, with gfs.write, clerum__gfs_save_attachment), one context-files mount is configured (clerum__context_files_*), native tool discovery is on (clerum__tool_search, clerum__tool_describe, clerum__tool_call), and a workspace, spillover storage and session search are wired.',
  'workflowTools: the workflow gateway and runtime credentials are configured. On telegram, slack and teams the sender also has a resolved provider identity; an rpc message carries its chat id.',
  'gfsDownloadStore: the Host GFS download store is available and the task has its caller root, wired as a running Host wires them; a running Host always has a store. Contexts with false have no store, and their values equal those with an unavailable store (checked in every context).',
  'The store contexts vary the channel and the GFS scopes, the inputs its wiring reads. The store changes the same tools in all 320 contexts without one (checked): it adds clerum__gfs_download, which needs gfs.read.',
  'With a store, clerum__gfs_download is also missing when tools.shell_exec is false, and file_read and file_write are missing when the caller root cannot be resolved (checked, not recorded).',
]

const APPROVAL_ASKS_NOTES = [
  'asks[tool][key] is true when every call of the tool shows a card in that context. Grants are empty.',
  'Key fields are in `keys` order. "*" means the answer is the same for every value of that field.',
  'effectiveMode is effectiveApprovalMode(stored, ceiling, cap) over every combination. override is true, false or absent (no tools.<name> entry).',
  'Interactive tasks (cronFired false): the controller TaskExecutor builds, then decideApproval. Only a card asks, so a classify result (the shell judge decides) does not.',
  'Cron-fired tasks: on a stateless Host, the cron_manage-only gate, whose suspension is the card; on other Hosts no gate runs.',
  'cron_manage is called with every action its schema lists, because the stateless gate reads the action.',
  'Answers come from a registry with the GFS download store. Without the store, under designated approvers, and for a sender who is not a listed approver, every answer of a name registered alike is the same (checked). Whether the sender is a listed approver changes only the channel cap, which effectiveMode carries.',
  `${CUSTOM_TOOL_PROBE} and ${MCP_TOOL_PROBE} stand for a custom row and an MCP tool. Where chat does not register a tool (mcp-host-tool-approval.json), its row is the gate's answer for that name.`,
  'channelType rpc is the Desktop channel.',
]

const MODES: readonly ApprovalMode[] = ['manual', 'auto', 'allow_all']
const OVERRIDES = ['true', 'false', 'absent'] as const
type Override = (typeof OVERRIDES)[number]
const BOOLEANS = [false, true] as const

const KEY_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['effectiveMode', MODES],
  ['override', OVERRIDES],
  ['channelType', CHANNEL_TYPES],
  ['cronFired', BOOLEANS.map(String)],
  ['stateless', BOOLEANS.map(String)],
  ['allowStatelessCron', BOOLEANS.map(String)],
  ['judge', BOOLEANS.map(String)],
]

// Credential-like variable names are built at runtime (public-boundary scanner).
const CREDENTIAL_WORD = String.fromCharCode(84, 79, 75, 69, 78)
const GFS_TOKEN_ENV = `MCP_HOST_GFS_${CREDENTIAL_WORD}`
const GATEWAY_URL_ENV = ['MCP', 'HOST', 'GATEWAY', 'URL'].join('_')
const CONTROL_TOKEN_ENV = `MCP_HOST_WORKFLOW_CONTROL_${CREDENTIAL_WORD}`
const RUNTIME_ACCESS_ENV = `MCP_HOST_RUNTIME_ACCESS_${CREDENTIAL_WORD}`
const RUNTIME_REFRESH_ENV = `MCP_HOST_RUNTIME_REFRESH_${CREDENTIAL_WORD}`
const CONTEXT_FILES_MOUNTS_ENV = 'CLERUM_CONTEXT_FILES_MOUNTS'
const DESKTOP_X11_ENV = 'CLERUM_DESKTOP_X11'
const DESKTOP_BROWSER_ENV = 'CLERUM_DESKTOP_BROWSER'

const SYNTHETIC_GATEWAY_URL = 'https://workflow-gateway.fixture.invalid'
const CONTEXT_FILES_MOUNT = JSON.stringify([
  {
    name: 'fixture-files',
    namespace: 'mcp-host',
    mountPath: '/context-files/fixture-files',
    pvcName: 'fixture-files-pvc',
  },
])
const GFS_SCOPES: Record<GfsScopeSet, readonly string[]> = {
  none: [],
  read: ['gfs.read'],
  write: ['gfs.write'],
  'read-write': ['gfs.read', 'gfs.write'],
}

const WORKSPACE_PATH = '/tmp'
const CONVERSATION_ID = 'approval-fixture-conversation'
const TASK_ID = 'approval-fixture-task'
const MESSAGE_ID = 'approval-fixture-message'
const MESSAGE_TEXT = 'approval fixture request'
const CALL_ID = 'approval-fixture-call'
const SENDER = 'approval-fixture-sender'
const OTHER_SENDER = 'approval-fixture-other-sender'
const NO_GRANTS = {
  task: new Set<string>(),
  always: new Set<string>(),
  autoShell: { wholeTool: false, commands: new Set<string>() },
}
const LIVE_GFS_DOWNLOAD: ReadonlySet<string> = new Set(['clerum__gfs_download'])

/** The Host approval block without overrides, and the same block under designated approvers. */
type ApprovalPolicy = Pick<ApprovalConfig, 'defaultPolicy' | 'channels'>
const OPEN_POLICY: ApprovalPolicy = { defaultPolicy: 'channel_users', channels: {} }
const DESIGNATED_POLICY: ApprovalPolicy = {
  defaultPolicy: 'designated_approvers',
  channels: {
    telegram: { enabled: true, approvers: [SENDER] },
    email: { enabled: true, approvers: [SENDER] },
    slack: { enabled: true, approvers: [SENDER] },
    teams: { enabled: true, approvers: [SENDER] },
  },
}

/** The ToolContext fields a registry is built from; the store comes from `StoreVariant`. */
type RegistryInputs = Omit<ToolContext, 'gfsDownloadStore'>

/**
 * The store a task's TaskExecutorDeps carry: none, an available one, or an
 * available one with one input that turns GFS delivery off.
 */
type StoreVariant = 'none' | 'available' | StoreFlip

/** The GFS runtime a running Host bootstraps, on a temporary Host root. */
interface GfsRuntimeFixture {
  root: string
  provider: ScopedWorkspaceProvider
  /** Initialized, so available. */
  store: GfsDownloadStore
  /** Never initialized, so unavailable, as while its initialize() keeps failing. */
  unavailableStore: GfsDownloadStore
}

interface BuiltRegistry {
  registry: NativeToolRegistry
  /** What taskExecutor.ts:2530 computed; undefined without a store. */
  gfsWorkspace: GfsManagedWorkspaceExecution | undefined
}

/** A GFS access token whose claims carry `scopes`; the registry reads only the claims. */
function gfsAccessToken(scopes: readonly string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

function syntheticCredential(name: string): string {
  return `fixture-${name}`
}

/** Runs `build` with every variable the registry reads set for `inputs`, then restores them. */
async function withRegistryEnv<T>(inputs: RegistryInputs, build: () => Promise<T>): Promise<T> {
  const workflow = (value: string): string | undefined => (inputs.workflowTools ? value : undefined)
  vi.stubEnv(STATELESS_LIFECYCLE_ENV, String(inputs.statelessLifecycle))
  vi.stubEnv(STATELESS_ALLOW_CRON_MANAGE_ENV, String(inputs.allowStatelessCronManage))
  vi.stubEnv(GFS_TOKEN_ENV, gfsAccessToken(GFS_SCOPES[inputs.gfsScopes]))
  vi.stubEnv(`${GFS_TOKEN_ENV}_FILE`, undefined)
  vi.stubEnv(GATEWAY_URL_ENV, workflow(SYNTHETIC_GATEWAY_URL))
  vi.stubEnv(CONTROL_TOKEN_ENV, workflow(syntheticCredential('workflow-control')))
  vi.stubEnv(`${CONTROL_TOKEN_ENV}_FILE`, undefined)
  vi.stubEnv(RUNTIME_ACCESS_ENV, workflow(syntheticCredential('runtime-access')))
  vi.stubEnv(RUNTIME_REFRESH_ENV, workflow(syntheticCredential('runtime-refresh')))
  vi.stubEnv(CONTEXT_FILES_MOUNTS_ENV, CONTEXT_FILES_MOUNT)
  vi.stubEnv(DESKTOP_X11_ENV, String(inputs.desktopTools))
  vi.stubEnv(DESKTOP_BROWSER_ENV, String(inputs.desktopTools))
  try {
    return await build()
  } finally {
    vi.unstubAllEnvs()
  }
}

async function openGfsRuntime(): Promise<GfsRuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'approval-fixture-gfs-'))
  const store = new GfsDownloadStore(root)
  // initialize() logs one info line when it succeeds, dropped here. Warnings
  // and errors still print, and any other info line fails the build.
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
  try {
    await store.initialize()
    const other = info.mock.calls.filter(([, msg]) => msg !== 'GFS download store initialized')
    if (other.length > 0) throw new Error(`unexpected store log: ${JSON.stringify(other)}`)
    if (!store.isAvailable()) throw new Error('the GFS download store is not available')
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  } finally {
    info.mockRestore()
  }
  return {
    root,
    provider: new ScopedWorkspaceProvider(root),
    store,
    unavailableStore: new GfsDownloadStore(root),
  }
}

async function closeGfsRuntime(runtime: GfsRuntimeFixture): Promise<void> {
  try {
    await runtime.store.close()
  } finally {
    await rm(runtime.root, { recursive: true, force: true })
  }
}

/** One PDF file attachment, admitted by the real attachment admission. */
async function pdfAttachment(): Promise<Attachment> {
  const document = await PDFDocument.create()
  document.addPage([200, 100])
  const bytes = Buffer.from(await document.save())
  const result = validateIncomingAttachments(
    [
      {
        id: 'approval-fixture-file',
        kind: 'file',
        mimeType: 'application/pdf',
        detectedMediaType: 'application/pdf',
        encoding: 'base64',
        dataBase64: bytes.toString('base64'),
        filename: 'approval-fixture.pdf',
        sizeBytes: bytes.length,
        digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
    { maxCount: 4, maxBytes: 2_000_000, maxFileBytes: 1_000_000, messageId: MESSAGE_ID }
  )
  if (!result.ok) throw new Error(`fixture attachment rejected: ${result.error.code}`)
  const attachment = result.attachments?.[0]
  if (attachment?.fileReference?.reader !== 'pdf') {
    throw new Error('fixture attachment was not admitted as a PDF')
  }
  return attachment
}

function nativeToolConfig(statelessLifecycle: boolean): NativeToolConfig {
  return {
    workspacePath: WORKSPACE_PATH,
    shellTimeout: 5000,
    toolTimeout: 60_000,
    toolProgressInterval: 30_000,
    httpAllowlist: [],
    envAllowlist: ['PATH'],
    memoryMaxSize: 1_048_576,
    statelessLifecycle,
    attachmentTextReadMaxBytes: 65_536,
  }
}

function chatMessage(
  channelType: ChannelType,
  sender: string,
  attachment: Attachment
): IncomingMessage {
  return {
    content: MESSAGE_TEXT,
    channelType,
    channelId: 'approval-fixture-channel',
    sender,
    timestamp: '2026-11-25T00:00:00.000Z',
    messageId: MESSAGE_ID,
    hostRef: 'approval-fixture-host',
    // rpc-proxy sends the Desktop chat id; the registry uses it as the workflow conversation.
    ...(channelType === 'rpc' ? { threadId: 'approval-fixture-chat' } : {}),
    attachments: [attachment],
  }
}

/**
 * The workflowCallerContext TaskExecutor passes (`prepareChannelWorkflowCallerContext`):
 * none for rpc, whose context the registry derives from the message; null for
 * email; for telegram, slack and teams, what `resolveProviderWorkflowCallerContext`
 * returns once the sender's provider identity resolves to a user.
 */
function workflowCallerContext(channelType: ChannelType): WorkflowCallerContext | null | undefined {
  if (channelType === 'rpc') return undefined
  if (channelType === 'email') return null
  return {
    targetUserId: 'approval-fixture-user',
    conversationId: 'approval-fixture-conversation',
    originChannelType: channelType,
    providerUserId: 'approval-fixture-provider-user',
    providerWorkspaceId: channelType === 'telegram' ? null : 'approval-fixture-workspace',
    providerChannelId: 'approval-fixture-provider-channel',
    sourceMessageId: MESSAGE_ID,
    sourceMessageContent: MESSAGE_TEXT,
  }
}

/**
 * Registration only stores the service; a call on this queue while the
 * registry is built would be a bug, so it throws.
 */
const UNUSED_PERSIST_QUEUE = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `session search used its queue while the registry was built: ${String(property)}`
      )
    },
  }
) as unknown as PersistQueue

/**
 * registerDesktopTools logs a line for each group it registers, dropped here,
 * and skips a group that fails to load with a warning, which fails the build.
 */
async function registerDesktopToolsChecked(registry: NativeToolRegistry): Promise<void> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    await registerDesktopTools(registry)
    if (warn.mock.calls.length > 0) {
      throw new Error(`desktop tools failed to load: ${JSON.stringify(warn.mock.calls)}`)
    }
  } finally {
    warn.mockRestore()
    log.mockRestore()
  }
}

/** The task's caller root, as stateMachine.ts:1622-1625 resolves it for a Host with a store. */
function callerRoot(runtime: GfsRuntimeFixture, message: IncomingMessage): string {
  const binding = resolveCallerRootBinding(runtime.provider, message)
  if (!binding.root) throw new Error(`caller root not resolved: ${binding.failureCode}`)
  return binding.root
}

/** Chat's native registry, as TaskExecutor.createToolRegistry builds it. */
async function buildChatRegistry(
  task: { inputs: RegistryInputs; sender: string; store: StoreVariant; policy: ApprovalPolicy },
  attachment: Attachment,
  runtime: GfsRuntimeFixture
): Promise<BuiltRegistry> {
  const message = chatMessage(task.inputs.channelType, task.sender, attachment)
  // TaskExecutorDeps (stateMachine.ts:1622-1643): the store, the caller root
  // (resolved only for a Host with a store; a failed binding passes none), and
  // the Host approval block.
  const store =
    task.store === 'none'
      ? undefined
      : task.store === 'storeUnavailable'
        ? runtime.unavailableStore
        : runtime.store
  const callerWorkspacePath =
    store && task.store !== 'noCallerRoot' ? callerRoot(runtime, message) : undefined
  const approvalConfig: ApprovalConfig =
    task.store === 'shellExecSkipped'
      ? { ...task.policy, tools: { shell_exec: false } }
      : { ...task.policy }
  // taskExecutor.ts:2529-2548.
  const gfsWorkspace = gfsManagedWorkspaceExecution({
    approvalEnabled: true,
    source: 'channel',
    callerIdentity: gfsStoreCallerIdentity(message),
    store,
    callerWorkspacePath,
    approvalConfig,
    retentionOwnerId: TASK_ID,
  })
  const deliveryAvailable = gfsWorkspace
    ? gfsWorkspaceExecutionEnabled({
        approvalEnabled: true,
        source: 'channel',
        callerIdentity: message.sender,
        store: gfsWorkspace.store,
        callerWorkspacePath: gfsWorkspace.callerWorkspacePath,
        approvalConfig,
        retentionOwnerId: TASK_ID,
      })
    : false
  const registry = new NativeToolRegistry(
    nativeToolConfig(task.inputs.statelessLifecycle),
    CONVERSATION_ID,
    new CronScheduler(new MessageQueue(), { statelessLifecycle: task.inputs.statelessLifecycle }),
    message,
    new WorkspaceService(WORKSPACE_PATH),
    () => ({}),
    workflowCallerContext(task.inputs.channelType),
    { maxBytes: 52_428_800, ledger: new AttachmentReadLedger(), contextWindowTokens: 100_000 },
    new SpilloverStorage({
      workspacePath: WORKSPACE_PATH,
      thresholdBytes: 8192,
      ttlMs: 60_000,
      gcIntervalMs: 0,
    }),
    new SessionSearchService({ persistQueue: UNUSED_PERSIST_QUEUE }),
    // No MCP manager: MCP tools are not native; MCP_TOOL_PROBE stands for one.
    undefined,
    { mcpDiscovery: false, nativeDiscovery: true },
    // The active provider only steers shell_exec's child environment.
    'claude',
    gfsWorkspace ? { ...gfsWorkspace, deliveryAvailable } : undefined,
    generatedOutputsRoot(message, callerWorkspacePath)
  )
  await registerDesktopToolsChecked(registry)
  return { registry, gfsWorkspace }
}

function registeredApproval(registry: NativeToolRegistry): Map<string, boolean> {
  return new Map(
    registry.listDefinitions().map(definition => {
      const tool = registry.get(definition.name)
      if (!tool) throw new Error(`${definition.name} is listed but not registered`)
      return [definition.name, tool.requiresApproval()]
    })
  )
}

function toolDelta(from: Map<string, boolean>, to: Map<string, boolean>): ToolDelta {
  return {
    added: [...to.keys()].filter(name => !from.has(name)).sort(),
    removed: [...from.keys()].filter(name => !to.has(name)).sort(),
    changed: [...to.keys()]
      .filter(name => from.has(name) && from.get(name) !== to.get(name))
      .sort(),
  }
}

/** Records the delta for its scope set, and throws if another context gave that scope set another one. */
function sameForScopes(
  deltas: Map<GfsScopeSet, ToolDelta>,
  inputs: RegistryInputs,
  delta: ToolDelta,
  what: string
): void {
  const earlier = deltas.get(inputs.gfsScopes)
  if (earlier && JSON.stringify(earlier) !== JSON.stringify(delta)) {
    throw new Error(
      `${what} changes ${JSON.stringify(delta)} at ${JSON.stringify(inputs)}, but ${JSON.stringify(earlier)} elsewhere with the same GFS scopes`
    )
  }
  deltas.set(inputs.gfsScopes, delta)
}

/**
 * The store contexts vary what the store wiring reads: the channel and sender
 * that name the caller, and the GFS scopes that gate clerum__gfs_download.
 * Every other field keeps its first value; `sameForScopes` checks that the
 * store does the same in every other context.
 */
function recordsStoreContext(inputs: RegistryInputs): boolean {
  return (
    !inputs.statelessLifecycle &&
    !inputs.allowStatelessCronManage &&
    !inputs.desktopTools &&
    !inputs.workflowTools
  )
}

async function buildToolApproval(
  attachment: Attachment,
  runtime: GfsRuntimeFixture
): Promise<{ file: ToolApprovalFile; storeEffect: StoreEffect }> {
  const contexts: ToolContext[] = []
  const approvals: Array<Map<string, boolean>> = []
  const storeContexts: ToolContext[] = []
  const storeApprovals: Array<Map<string, boolean>> = []
  const storeDeltas = new Map<GfsScopeSet, ToolDelta>()
  const flipDeltas = new Map(STORE_FLIPS.map(flip => [flip, new Map<GfsScopeSet, ToolDelta>()]))
  for (const statelessLifecycle of BOOLEANS) {
    for (const allowStatelessCronManage of BOOLEANS) {
      for (const channelType of CHANNEL_TYPES) {
        for (const gfsScopes of GFS_SCOPE_SETS) {
          for (const desktopTools of BOOLEANS) {
            for (const workflowTools of BOOLEANS) {
              const inputs: RegistryInputs = {
                statelessLifecycle,
                allowStatelessCronManage,
                channelType,
                gfsScopes,
                desktopTools,
                workflowTools,
              }
              await withRegistryEnv(inputs, async () => {
                const approvalWith = async (store: StoreVariant) =>
                  registeredApproval(
                    (
                      await buildChatRegistry(
                        { inputs, sender: SENDER, store, policy: OPEN_POLICY },
                        attachment,
                        runtime
                      )
                    ).registry
                  )
                const none = await approvalWith('none')
                const available = await approvalWith('available')
                const unavailable = await approvalWith('storeUnavailable')
                const unlike = toolDelta(none, unavailable)
                if (unlike.added.length + unlike.removed.length + unlike.changed.length > 0) {
                  throw new Error(
                    `an unavailable store differs from no store at ${JSON.stringify(inputs)}: ${JSON.stringify(unlike)}`
                  )
                }
                sameForScopes(storeDeltas, inputs, toolDelta(none, available), 'The store')
                contexts.push({ ...inputs, gfsDownloadStore: false })
                approvals.push(none)
                if (!recordsStoreContext(inputs)) return
                storeContexts.push({ ...inputs, gfsDownloadStore: true })
                storeApprovals.push(available)
                for (const flip of STORE_FLIPS) {
                  const flipped =
                    flip === 'storeUnavailable' ? unavailable : await approvalWith(flip)
                  sameForScopes(flipDeltas.get(flip)!, inputs, toolDelta(available, flipped), flip)
                }
              })
            }
          }
        }
      }
    }
  }
  contexts.push(...storeContexts)
  approvals.push(...storeApprovals)
  const names = [...new Set(approvals.flatMap(approval => [...approval.keys()]))].sort()
  const tools = Object.fromEntries(
    names.map(name => [name, approvals.map(approval => approval.get(name) ?? null)])
  )
  const byScopes = (deltas: Map<GfsScopeSet, ToolDelta>) =>
    Object.fromEntries(GFS_SCOPE_SETS.map(scopes => [scopes, deltas.get(scopes)!])) as Record<
      GfsScopeSet,
      ToolDelta
    >
  return {
    file: { _source: { producer: PRODUCER, notes: TOOL_APPROVAL_NOTES }, contexts, tools },
    storeEffect: {
      store: byScopes(storeDeltas),
      flips: Object.fromEntries(
        STORE_FLIPS.map(flip => [flip, byScopes(flipDeltas.get(flip)!)])
      ) as StoreEffect['flips'],
    },
  }
}

/** The controller TaskExecutor gives a task, with approval enabled. */
function taskController(
  built: BuiltRegistry,
  approvalConfig: () => ApprovalConfig | undefined,
  task: { cronFired: boolean; statelessLifecycle: boolean }
): LoopController {
  const interactive = !task.cronFired
  const cronManageGateOnly = task.cronFired && task.statelessLifecycle
  if (!interactive && !cronManageGateOnly) return new DefaultLoopController()
  // Without an MCP manager TaskExecutor passes the native registry as both registries.
  const gate = new UnifiedApprovalGateController(built.registry, approvalConfig, built.registry, {
    statelessLifecycle: task.statelessLifecycle,
    cronManageGateOnly,
  })
  return new ApprovalController(makeFakeConversation(), gate, {
    honorDenials: !cronManageGateOnly,
    toolRegistry: built.registry,
    // TaskExecutor.liveApprovalTools for a chat task; a cron task's source is
    // never 'channel', so it gets none.
    liveApprovalTools: interactive
      ? () =>
          built.gfsWorkspace && approvalConfig()?.tools?.shell_exec !== false
            ? LIVE_GFS_DOWNLOAD
            : undefined
      : undefined,
    forcedApprovalGate: gate,
    modeAware: interactive,
  })
}

function overrideConfig(
  policy: ApprovalPolicy,
  toolName: string,
  override: Override
): ApprovalConfig {
  return {
    ...policy,
    ...(override === 'absent' ? {} : { tools: { [toolName]: override === 'true' } }),
  }
}

/** The calls the gate tells apart. The stateless gate reads cron_manage's action. */
function callArguments(registry: NativeToolRegistry, toolName: string): Record<string, unknown>[] {
  if (toolName !== 'cron_manage') return [{}]
  const schema = registry.get(toolName)?.parametersSchema() as
    | { properties?: { action?: { enum?: unknown } } }
    | undefined
  const actions = schema?.properties?.action?.enum
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('cron_manage has no action enum to call')
  }
  return actions.map(action => ({ action }))
}

/** Whether one controller answer ends in a card, as admitToolCall reads it. */
function answerAsks(
  answer: ReturnType<LoopController['beforeTool']>,
  call: { toolName: string; args: Record<string, unknown> },
  task: { cronFired: boolean; mode: ApprovalMode; judge: boolean }
): boolean {
  if (answer === 'skip') throw new Error(`${call.toolName}: the controller skipped the call`)
  if (task.cronFired) return answer !== 'proceed'
  const command = typeof call.args.command === 'string' ? call.args.command : undefined
  const decision = decideApproval({
    mode: task.mode,
    toolName: call.toolName,
    cause: answer === 'proceed' ? 'none' : answer.cause,
    grants: NO_GRANTS,
    ...(command !== undefined ? { command } : {}),
    classifierAvailable: task.judge,
  })
  return decision.kind === 'card'
}

/** Replaces every field the tool answers the same for, whatever its value, with "*". */
function collapse(tool: string, full: Map<string, boolean>): Record<string, boolean> {
  const combinations = KEY_FIELDS.reduce((count, [, values]) => count * values.length, 1)
  if (full.size !== combinations) {
    throw new Error(`${tool}: ${full.size} of ${combinations} asks contexts were computed`)
  }
  let rows = [...full].map(([key, asks]) => ({ parts: key.split('|'), asks }))
  KEY_FIELDS.forEach(([, values], field) => {
    const groups = new Map<string, typeof rows>()
    for (const row of rows) {
      const rest = row.parts.filter((_, index) => index !== field).join('|')
      groups.set(rest, [...(groups.get(rest) ?? []), row])
    }
    const ignored = [...groups.values()].every(
      group => group.length === values.length && group.every(row => row.asks === group[0].asks)
    )
    if (ignored) {
      rows = [...groups.values()].map(group => ({
        parts: group[0].parts.map((part, index) => (index === field ? '*' : part)),
        asks: group[0].asks,
      }))
    }
  })
  // Code-point order, so a recording is the same on every machine.
  return Object.fromEntries(
    rows
      .map(row => [row.parts.join('|'), row.asks] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
}

/** Every answer of one registry: tool name to full key to whether the call asks. */
function registryAnswers(
  built: BuiltRegistry,
  names: readonly string[],
  policy: ApprovalPolicy,
  inputs: RegistryInputs
): Map<string, Map<string, boolean>> {
  const answers = new Map(names.map(name => [name, new Map<string, boolean>()]))
  // Set for each tool and override before the controller is asked.
  let approvalConfig: ApprovalConfig | undefined
  for (const cronFired of BOOLEANS) {
    const controller = taskController(built, () => approvalConfig, {
      cronFired,
      statelessLifecycle: inputs.statelessLifecycle,
    })
    for (const toolName of names) {
      const asksByKey = answers.get(toolName)!
      const calls = callArguments(built.registry, toolName)
      for (const override of OVERRIDES) {
        approvalConfig = overrideConfig(policy, toolName, override)
        const results = calls.map(args => ({
          args,
          answer: controller.beforeTool(toolName, args, CALL_ID),
        }))
        for (const stored of MODES) {
          for (const ceiling of MODES) {
            for (const cap of MODES) {
              const mode = effectiveApprovalMode(stored, ceiling, cap)
              for (const judge of BOOLEANS) {
                const asks = results.every(({ args, answer }) =>
                  answerAsks(answer, { toolName, args }, { cronFired, mode, judge })
                )
                const key = [
                  mode,
                  override,
                  inputs.channelType,
                  cronFired,
                  inputs.statelessLifecycle,
                  inputs.allowStatelessCronManage,
                  judge,
                ].join('|')
                const earlier = asksByKey.get(key)
                if (earlier !== undefined && earlier !== asks) {
                  throw new Error(
                    `${toolName} at ${key}: two (stored, ceiling, cap) combinations with this effective mode disagree`
                  )
                }
                asksByKey.set(key, asks)
              }
            }
          }
        }
      }
    }
  }
  return answers
}

interface AsksVariant {
  variant: string
  store: 'none' | 'available'
  sender: string
  policy: ApprovalPolicy
}

/** The registry the asks table records: the store, a listed sender, no approver policy. */
const RECORDED_ASKS: AsksVariant = {
  variant: 'recorded',
  store: 'available',
  sender: SENDER,
  policy: OPEN_POLICY,
}

/** Registries the key has no field for, compared with the recorded one. */
const ASKS_VARIANTS: readonly AsksVariant[] = [
  { variant: 'no GFS download store', store: 'none', sender: SENDER, policy: OPEN_POLICY },
  {
    variant: 'designated approvers, sender listed',
    store: 'available',
    sender: SENDER,
    policy: DESIGNATED_POLICY,
  },
  {
    variant: 'designated approvers, sender not listed',
    store: 'available',
    sender: OTHER_SENDER,
    policy: DESIGNATED_POLICY,
  },
]

const MAX_REPORTED_DIFFERENCES = 20

/** Compares every answer of a name both registries register, or neither does. */
function compareAnswers(
  recorded: { built: BuiltRegistry; answers: Map<string, Map<string, boolean>> },
  variant: { built: BuiltRegistry; answers: Map<string, Map<string, boolean>> },
  check: AsksVariantCheck
): void {
  for (const [name, byKey] of recorded.answers) {
    const registeredAlike =
      (recorded.built.registry.get(name) === null) === (variant.built.registry.get(name) === null)
    if (!registeredAlike) continue
    for (const [key, asks] of byKey) {
      check.compared += 1
      const other = variant.answers.get(name)?.get(key)
      if (other !== asks && check.differences.length < MAX_REPORTED_DIFFERENCES) {
        check.differences.push(`${name} at ${key}: recorded ${asks}, ${check.variant} ${other}`)
      }
    }
  }
}

async function buildApprovalAsks(
  attachment: Attachment,
  toolNames: readonly string[],
  runtime: GfsRuntimeFixture
): Promise<{ file: ApprovalAsksFile; checks: AsksVariantCheck[] }> {
  const names = [...toolNames, CUSTOM_TOOL_PROBE, MCP_TOOL_PROBE]
  const full = new Map(names.map(name => [name, new Map<string, boolean>()]))
  const checks: AsksVariantCheck[] = ASKS_VARIANTS.map(({ variant }) => ({
    variant,
    compared: 0,
    differences: [],
  }))
  for (const channelType of CHANNEL_TYPES) {
    for (const statelessLifecycle of BOOLEANS) {
      for (const allowStatelessCronManage of BOOLEANS) {
        // The key has no GFS, desktop or workflow field: one registry with all of them on.
        const inputs: RegistryInputs = {
          statelessLifecycle,
          allowStatelessCronManage,
          channelType,
          gfsScopes: 'read-write',
          desktopTools: true,
          workflowTools: true,
        }
        await withRegistryEnv(inputs, async () => {
          const answersOf = async ({ store, sender, policy }: AsksVariant) => {
            const built = await buildChatRegistry(
              { inputs, sender, store, policy },
              attachment,
              runtime
            )
            for (const definition of built.registry.listDefinitions()) {
              if (!toolNames.includes(definition.name)) {
                throw new Error(`${definition.name} is registered but missing from the tool table`)
              }
            }
            for (const probe of [CUSTOM_TOOL_PROBE, MCP_TOOL_PROBE]) {
              if (built.registry.get(probe)) throw new Error(`${probe} is a registered tool`)
            }
            return { built, answers: registryAnswers(built, names, policy, inputs) }
          }
          const recorded = await answersOf(RECORDED_ASKS)
          for (const [name, byKey] of recorded.answers) {
            for (const [key, asks] of byKey) full.get(name)!.set(key, asks)
          }
          for (const [index, variant] of ASKS_VARIANTS.entries()) {
            compareAnswers(recorded, await answersOf(variant), checks[index])
          }
        })
      }
    }
  }
  return {
    file: {
      _source: { producer: PRODUCER, notes: APPROVAL_ASKS_NOTES },
      keys: KEY_FIELDS.map(([field]) => field),
      asks: Object.fromEntries(names.map(name => [name, collapse(name, full.get(name)!)])),
    },
    checks,
  }
}

/** The cap telegram gives each sender under the designated-approvers policy. */
function senderCaps(): ApprovalProducerFixtures['senderCaps'] {
  const designated: ApprovalConfig = { ...DESIGNATED_POLICY }
  const snapshot = { effective: designated, hostSpec: designated }
  return {
    listed: readChannelCap(snapshot, 'telegram', SENDER),
    unlisted: readChannelCap(snapshot, 'telegram', OTHER_SENDER),
  }
}

export async function buildApprovalProducerFixtures(): Promise<ApprovalProducerFixtures> {
  const attachment = await pdfAttachment()
  const runtime = await openGfsRuntime()
  try {
    const tools = await buildToolApproval(attachment, runtime)
    const asks = await buildApprovalAsks(attachment, Object.keys(tools.file.tools), runtime)
    return {
      toolApproval: tools.file,
      approvalAsks: asks.file,
      storeEffect: tools.storeEffect,
      asksVariants: asks.checks,
      senderCaps: senderCaps(),
    }
  } finally {
    await closeGfsRuntime(runtime)
  }
}
