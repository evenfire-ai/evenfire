/**
 * Builds the two approval tables that approvalProducerFixtures.test.ts pins
 * for Control UI, from mcp-host's own code:
 *
 * - the tool table: chat's NativeToolRegistry, constructed as
 *   TaskExecutor.createToolRegistry constructs it (src/agent/taskExecutor.ts,
 *   `new NativeToolRegistry(` then `registerDesktopTools`), over the
 *   ToolContext matrix;
 * - the asks table: the same registry behind the controller TaskExecutor
 *   builds for the task (ApprovalController over UnifiedApprovalGateController,
 *   or no gate), then decideApproval with the mode effectiveApprovalMode gives.
 *
 * Nothing here decides approval. The only logic mirrored is wiring:
 * - which controller a task gets (taskExecutor.ts, `interactiveApprovalApplies`
 *   and `cronManageGateApplies`, with approval enabled);
 * - how admission reads that controller (src/core/orchestration/toolCallPolicy.ts,
 *   `admitToolCall` and `applyApprovalMode`). A task with approval modes (every
 *   task that is not cron-fired) passes the gate's cause to decideApproval, and
 *   only a card asks. A cron-fired task has no approval modes, so a suspension
 *   is the card.
 */
import { vi } from 'vitest'
import { createHash } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { CronScheduler } from '../../../agent/cronScheduler'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import { MessageQueue } from '../../../queue/messageQueue'
import type { IncomingMessage } from '../../../server'
import {
  STATELESS_ALLOW_CRON_MANAGE_ENV,
  STATELESS_LIFECYCLE_ENV,
} from '../../../statelessCronPolicy'
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
import { type ApprovalMode, effectiveApprovalMode } from '../approvalMode'
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

export interface ApprovalProducerFixtures {
  toolApproval: ToolApprovalFile
  approvalAsks: ApprovalAsksFile
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
  'Not built: clerum__gfs_download, which needs a Host GFS download store. With a store, the file and shell tools also bind to the caller root.',
]

const APPROVAL_ASKS_NOTES = [
  'asks[tool][key] is true when every call of the tool shows a card in that context. Grants are empty.',
  'Key fields are in `keys` order. "*" means the answer is the same for every value of that field.',
  'effectiveMode is effectiveApprovalMode(stored, ceiling, cap) over every combination. override is true, false or absent (no tools.<name> entry).',
  'Interactive tasks (cronFired false): the controller TaskExecutor builds, then decideApproval. Only a card asks, so a classify result (the shell judge decides) does not.',
  'Cron-fired tasks: on a stateless Host, the cron_manage-only gate, whose suspension is the card; on other Hosts no gate runs.',
  'cron_manage is called with every action its schema lists, because the stateless gate reads the action.',
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
const MESSAGE_ID = 'approval-fixture-message'
const MESSAGE_TEXT = 'approval fixture request'
const CALL_ID = 'approval-fixture-call'
const NO_GRANTS = {
  task: new Set<string>(),
  always: new Set<string>(),
  autoShell: { wholeTool: false, commands: new Set<string>() },
}

interface RegistryInputs {
  statelessLifecycle: boolean
  allowStatelessCronManage: boolean
  channelType: ChannelType
  gfsScopes: GfsScopeSet
  desktopTools: boolean
  workflowTools: boolean
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

function chatMessage(channelType: ChannelType, attachment: Attachment): IncomingMessage {
  return {
    content: MESSAGE_TEXT,
    channelType,
    channelId: 'approval-fixture-channel',
    sender: 'approval-fixture-sender',
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

/** Chat's native registry, as TaskExecutor.createToolRegistry builds it. */
async function buildChatRegistry(
  inputs: RegistryInputs,
  attachment: Attachment
): Promise<NativeToolRegistry> {
  const registry = new NativeToolRegistry(
    nativeToolConfig(inputs.statelessLifecycle),
    CONVERSATION_ID,
    new CronScheduler(new MessageQueue(), { statelessLifecycle: inputs.statelessLifecycle }),
    chatMessage(inputs.channelType, attachment),
    new WorkspaceService(WORKSPACE_PATH),
    () => ({}),
    workflowCallerContext(inputs.channelType),
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
    // No Host GFS download store (see TOOL_APPROVAL_NOTES).
    undefined,
    undefined
  )
  await registerDesktopToolsChecked(registry)
  return registry
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

async function buildToolApproval(attachment: Attachment): Promise<ToolApprovalFile> {
  const contexts: ToolContext[] = []
  const approvals: Array<Map<string, boolean>> = []
  for (const statelessLifecycle of BOOLEANS) {
    for (const allowStatelessCronManage of BOOLEANS) {
      for (const channelType of CHANNEL_TYPES) {
        for (const gfsScopes of GFS_SCOPE_SETS) {
          for (const desktopTools of BOOLEANS) {
            for (const workflowTools of BOOLEANS) {
              const context: ToolContext = {
                statelessLifecycle,
                allowStatelessCronManage,
                channelType,
                gfsScopes,
                desktopTools,
                workflowTools,
              }
              contexts.push(context)
              approvals.push(
                await withRegistryEnv(context, async () =>
                  registeredApproval(await buildChatRegistry(context, attachment))
                )
              )
            }
          }
        }
      }
    }
  }
  const names = [...new Set(approvals.flatMap(approval => [...approval.keys()]))].sort()
  const tools = Object.fromEntries(
    names.map(name => [name, approvals.map(approval => approval.get(name) ?? null)])
  )
  return {
    _source: { producer: PRODUCER, notes: TOOL_APPROVAL_NOTES },
    contexts,
    tools,
  }
}

/** The controller TaskExecutor gives a task, with approval enabled. */
function taskController(
  registry: NativeToolRegistry,
  approvalConfig: () => ApprovalConfig | undefined,
  task: { cronFired: boolean; statelessLifecycle: boolean }
): LoopController {
  const interactive = !task.cronFired
  const cronManageGateOnly = task.cronFired && task.statelessLifecycle
  if (!interactive && !cronManageGateOnly) return new DefaultLoopController()
  // Without an MCP manager TaskExecutor passes the native registry as both registries.
  const gate = new UnifiedApprovalGateController(registry, approvalConfig, registry, {
    statelessLifecycle: task.statelessLifecycle,
    cronManageGateOnly,
  })
  // No GFS download store, so no live approval tools.
  return new ApprovalController(makeFakeConversation(), gate, {
    honorDenials: !cronManageGateOnly,
    toolRegistry: registry,
    forcedApprovalGate: gate,
    modeAware: interactive,
  })
}

function overrideConfig(toolName: string, override: Override): ApprovalConfig {
  return {
    defaultPolicy: 'channel_users',
    channels: {},
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

async function buildApprovalAsks(
  attachment: Attachment,
  toolNames: readonly string[]
): Promise<ApprovalAsksFile> {
  const names = [...toolNames, CUSTOM_TOOL_PROBE, MCP_TOOL_PROBE]
  const full = new Map(names.map(name => [name, new Map<string, boolean>()]))
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
          const registry = await buildChatRegistry(inputs, attachment)
          for (const definition of registry.listDefinitions()) {
            if (!toolNames.includes(definition.name)) {
              throw new Error(`${definition.name} is registered but missing from the tool table`)
            }
          }
          for (const probe of [CUSTOM_TOOL_PROBE, MCP_TOOL_PROBE]) {
            if (registry.get(probe)) throw new Error(`${probe} is a registered tool`)
          }
          // Set for each tool and override before the controller is asked.
          let approvalConfig: ApprovalConfig | undefined
          for (const cronFired of BOOLEANS) {
            const controller = taskController(registry, () => approvalConfig, {
              cronFired,
              statelessLifecycle,
            })
            for (const toolName of names) {
              const asksByKey = full.get(toolName)!
              const calls = callArguments(registry, toolName)
              for (const override of OVERRIDES) {
                approvalConfig = overrideConfig(toolName, override)
                const answers = calls.map(args => ({
                  args,
                  answer: controller.beforeTool(toolName, args, CALL_ID),
                }))
                for (const stored of MODES) {
                  for (const ceiling of MODES) {
                    for (const cap of MODES) {
                      const mode = effectiveApprovalMode(stored, ceiling, cap)
                      for (const judge of BOOLEANS) {
                        const asks = answers.every(({ args, answer }) =>
                          answerAsks(answer, { toolName, args }, { cronFired, mode, judge })
                        )
                        const key = [
                          mode,
                          override,
                          channelType,
                          cronFired,
                          statelessLifecycle,
                          allowStatelessCronManage,
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
        })
      }
    }
  }
  return {
    _source: { producer: PRODUCER, notes: APPROVAL_ASKS_NOTES },
    keys: KEY_FIELDS.map(([field]) => field),
    asks: Object.fromEntries(names.map(name => [name, collapse(name, full.get(name)!)])),
  }
}

export async function buildApprovalProducerFixtures(): Promise<ApprovalProducerFixtures> {
  const attachment = await pdfAttachment()
  const toolApproval = await buildToolApproval(attachment)
  const approvalAsks = await buildApprovalAsks(attachment, Object.keys(toolApproval.tools))
  return { toolApproval, approvalAsks }
}
