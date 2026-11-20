/**
 * Approval-mode admission and grant memory through TaskExecutor.
 * Real gated tools, no tools override unless a case sets one, and an APPROVE
 * fake that counts classifier calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as appConfig } from '../../config'
import type { ApprovalMode } from '../../core/approval/approvalMode'
import { approvalLogId } from '../../core/approval/grantMemory'
import { makeFakeConversation } from '../../core/conversation/__testing__/makeFakeConversation'
import { ConversationManager } from '../../core/conversation/conversation'
import { pendingApprovalWireFields } from '../../core/conversation/pendingApprovalView'
import type { StoreHandle } from '../../core/conversation/persistence/__tests__/testHelpers'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { LlmErrorCode } from '../../core/errors'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import type { GuardrailsConfig } from '../../core/guardrails'
import { requestPinned } from '../../core/net/ssrf'
import type { LoopConfig } from '../../core/orchestration/loopConfig'
import { admitToolCall } from '../../core/orchestration/toolCallPolicy'
import type { ChatMessage, PendingApproval, ToolCall } from '../../core/types'
import { FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { FailoverEngine } from '../../llm/failover/engine'
import type { FallbackEntry, LlmPolicy } from '../../llm/failover/types'
import type { SingleTurnProvider } from '../../llm/types'
import { logger } from '../../logger'
import { MessageQueue } from '../../queue'
import type { Task, TaskError } from '../../queue/types'
import { STATELESS_ALLOW_CRON_MANAGE_ENV } from '../../statelessCronPolicy'
import { CronScheduler } from '../cronScheduler'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'
import type { ExecutorFailoverSupport } from '../types'

vi.mock('../../core/net/ssrf', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/net/ssrf')>()
  return {
    ...actual,
    resolvePinnedPublicIp: vi.fn(async () => '203.0.113.10'),
    requestPinned: vi.fn(async () => ({ statusCode: 200, body: 'http-ok' })),
  }
})

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const SENDER = 'sender-sentinel@example.test'
const THREAD = 'thread-sentinel@example.test'
const COMMAND_SENTINEL = 'SENTINEL_COMMAND'
const PARAM_SENTINEL = 'SENTINEL_PARAM'
const DESCRIPTION_SENTINEL = 'SENTINEL_DESCRIPTION'

const saved = {
  enableApproval: appConfig.enableApproval,
  statelessLifecycle: appConfig.statelessLifecycle,
  nativeStateless: appConfig.nativeTool.statelessLifecycle,
  allowlist: [...appConfig.nativeTool.httpAllowlist],
  allowCron: process.env[STATELESS_ALLOW_CRON_MANAGE_ENV],
  desktopBrowser: process.env.CLERUM_DESKTOP_BROWSER,
}

beforeEach(() => {
  appConfig.enableApproval = true
  appConfig.statelessLifecycle = false
  appConfig.nativeTool.statelessLifecycle = false
  appConfig.nativeTool.httpAllowlist = []
  vi.mocked(requestPinned).mockClear()
  vi.mocked(requestPinned).mockResolvedValue({ statusCode: 200, body: 'http-ok' })
})

afterEach(() => {
  appConfig.enableApproval = saved.enableApproval
  appConfig.statelessLifecycle = saved.statelessLifecycle
  appConfig.nativeTool.statelessLifecycle = saved.nativeStateless
  appConfig.nativeTool.httpAllowlist = saved.allowlist
  if (saved.allowCron === undefined) delete process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]
  else process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = saved.allowCron
  if (saved.desktopBrowser === undefined) delete process.env.CLERUM_DESKTOP_BROWSER
  else process.env.CLERUM_DESKTOP_BROWSER = saved.desktopBrowser
  vi.unstubAllGlobals()
})

function policy(
  ceiling: ApprovalMode,
  tools?: Record<string, boolean>,
  allowModeChange = true
): ApprovalConfig {
  return {
    defaultPolicy: 'channel_users',
    modeCeiling: ceiling,
    channels: {
      telegram: { enabled: true, allowModeChange },
      email: { enabled: true, allowModeChange },
      slack: { enabled: true, allowModeChange },
    },
    ...(tools ? { tools } : {}),
  }
}

interface PolicyHolder {
  policy: ApprovalConfig
}

interface DriveOptions {
  mode: ApprovalMode
  channelType?: 'rpc' | 'telegram' | 'slack'
  sender?: string
  threadId?: string
  ceiling?: ApprovalMode
  tools?: Record<string, boolean>
  allowModeChange?: boolean
  calls: ToolCall[]
  verdict?: string | (() => Promise<{ content: string }>)
  guardrails?: GuardrailsConfig
  prepare?: (conversation: Awaited<ReturnType<ConversationManager['getOrCreate']>>) => void
  manager?: ConversationManager
  holder?: PolicyHolder
  cron?: boolean
  stateless?: boolean
  gfs?: boolean
  /** Provider type of the primary the task is built with. Default claude. */
  primaryType?: ProviderType
  /**
   * Failover support for the executor. Gets the primary, whose tool-turn
   * script a fallback can reuse to serve the turn.
   */
  failover?: (primary: SingleTurnProvider) => ExecutorFailoverSupport
}

interface DriveResult {
  approval?: PendingApproval
  classifyCalls: number
  completed: boolean
  failed?: TaskError
  messages: ChatMessage[][]
  conversation: Awaited<ReturnType<ConversationManager['getOrCreate']>>
  executor: TaskExecutor
  manager: ConversationManager
  holder: PolicyHolder
}

async function drive(options: DriveOptions): Promise<DriveResult> {
  const channelType = options.channelType ?? 'rpc'
  const sender = options.sender ?? 'mode-user'
  const manager = options.manager ?? new ConversationManager()
  const lifecycle = new TaskLifecycle()
  const scheduler = new CronScheduler(new MessageQueue(), {
    statelessLifecycle: options.stateless === true,
    allowEnabledJobs: true,
  })
  const task: Task = {
    id: `task-${Math.random().toString(36).slice(2)}`,
    source: options.cron ? 'cron' : 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender,
      content: 'run the tool',
      channelType,
      channelId: 'mode-channel',
      messageId: `msg-${Math.random().toString(36).slice(2)}`,
      threadId: options.threadId,
      timestamp: new Date().toISOString(),
      hostRef: 'mode-host',
    },
    conversationHistory: [{ role: 'user', content: 'run the tool', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  const conversation = await manager.getOrCreate(resolveTaskSessionKey(task), {
    userId: sender,
    channelType,
    approvalMode: options.mode,
  })
  options.prepare?.(conversation)
  const holder =
    options.holder ??
    ({
      policy: policy(
        options.ceiling ?? 'allow_all',
        options.tools,
        options.allowModeChange !== false
      ),
    } satisfies PolicyHolder)
  let classifyCalls = 0
  const messages: ChatMessage[][] = []
  const verdict = options.verdict ?? 'APPROVE'
  const provider: SingleTurnProvider = {
    getProviderType: () => options.primaryType ?? 'claude',
    classifyError: () => {
      throw new Error('fixture classification is unused')
    },
    completeSingleTurn: vi.fn(async () => {
      classifyCalls += 1
      const body = typeof verdict === 'function' ? await verdict() : { content: verdict }
      return { content: body.content, usage, finish_reason: FinishReason.Stop }
    }),
    completeSingleTurnWithTools: vi.fn(async (seen: ChatMessage[]) => {
      messages.push(structuredClone(seen))
      const call = messages.length === 1 ? options.calls : null
      return {
        content: call ? null : 'done',
        tool_calls: call,
        usage,
        finish_reason: call ? FinishReason.ToolUse : FinishReason.Stop,
      }
    }),
  }
  lifecycle.register(task)
  lifecycle.transition(task.id, 'processing', 'dispatched')
  const onFail = vi.fn()
  const deps: TaskExecutorDeps = {
    conversationManager: manager,
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    ...(options.gfs
      ? {
          gfsDownloadStore: { isAvailable: () => true } as never,
          gfsCallerWorkspacePath: '/tmp/mode-caller',
        }
      : {}),
    modelName: 'claude-test',
    approvalConfig: holder.policy,
    approvalConfigProvider: () => ({ effective: holder.policy, hostSpec: holder.policy }),
    guardrailsConfig: options.guardrails,
    coreEvents: { emit: () => {}, on: () => {}, off: () => {} } as never,
    cronScheduler: scheduler,
    taskLifecycle: lifecycle,
    config: {
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 8,
      autoStart: false,
      taskDelay: 0,
      approvalTimeout: 0,
    },
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail,
    ...(options.failover ? { failover: options.failover(provider) } : {}),
  }
  const executor = new TaskExecutor(task, deps)
  await executor.run()
  scheduler.stop()
  return {
    approval: executor.pendingApproval,
    classifyCalls,
    completed: executor.executorState === 'completed',
    failed: onFail.mock.calls[0]?.[1] as TaskError | undefined,
    messages,
    conversation,
    executor,
    manager,
    holder,
  }
}

type ProviderType = ReturnType<SingleTurnProvider['getProviderType']>

function shell(id: string, command: string): ToolCall {
  return { id, name: 'shell_exec', arguments: { command } }
}

function http(id: string, url = 'https://example.test/hook'): ToolCall {
  return { id, name: 'http_request', arguments: { url } }
}

function infoEvents(spy: { mock: { calls: unknown[][] } }, event: string): unknown[] {
  return spy.mock.calls
    .map(call => call[0])
    .filter(
      (fields): fields is { event?: string } =>
        fields !== null &&
        typeof fields === 'object' &&
        (fields as { event?: string }).event === event
    )
}

describe('approval mode admission', () => {
  it('A5 suspends without classify', async () => {
    const deniedShell = await drive({
      mode: 'auto',
      calls: [shell('sh-denied', 'printf admission-ok')],
      prepare: conversation => {
        conversation.denials = new Map([['shell_exec', 'mode-user']])
        conversation.auto_shell_grants = {
          wholeTool: true,
          commands: new Set(['printf admission-ok']),
        }
      },
    })
    expect(deniedShell.approval?.tool_name).toBe('shell_exec')
    expect(deniedShell.approval?.authorization_scope).toBe('exact_invocation')
    expect(deniedShell.approval?.shellCard).toBeUndefined()
    expect(deniedShell.classifyCalls).toBe(0)

    const forced = await drive({
      mode: 'auto',
      tools: { shell_exec: true },
      calls: [shell('sh-forced', 'printf admission-ok')],
      prepare: conversation => {
        conversation.auto_shell_grants = { wholeTool: true, commands: new Set() }
      },
    })
    expect(forced.approval?.authorization_scope).toBe('exact_invocation')
    expect(forced.classifyCalls).toBe(0)

    const askShell = await drive({
      mode: 'auto',
      calls: [shell('sh-ask', 'printf admission-ok')],
      guardrails: {
        rules: [
          {
            id: 'ask-shell',
            action: 'ask',
            match: { tool: { provenance: 'native', name: 'shell_exec' } },
          },
        ],
      },
      prepare: conversation => {
        conversation.auto_shell_grants = { wholeTool: true, commands: new Set() }
      },
    })
    expect(askShell.approval?.description).toContain('Guardrail requires approval')
    expect(askShell.approval?.authorization_scope).toBe('exact_invocation')
    expect(askShell.classifyCalls).toBe(0)

    const deniedHttp = await drive({
      mode: 'auto',
      calls: [http('http-denied')],
      prepare: conversation => {
        conversation.denials = new Map([['http_request', 'mode-user']])
      },
    })
    expect(deniedHttp.approval?.tool_name).toBe('http_request')
    expect(deniedHttp.approval?.authorization_scope).toBe('exact_invocation')
    expect(deniedHttp.classifyCalls).toBe(0)

    const forcedHttp = await drive({
      mode: 'auto',
      tools: { http_request: true },
      calls: [http('http-forced')],
    })
    expect(forcedHttp.approval?.authorization_scope).toBe('exact_invocation')
    expect(forcedHttp.classifyCalls).toBe(0)
    expect(vi.mocked(requestPinned)).not.toHaveBeenCalled()

    const askHttp = await drive({
      mode: 'auto',
      calls: [http('http-ask')],
      guardrails: {
        rules: [
          {
            id: 'ask-http',
            action: 'ask',
            match: { tool: { provenance: 'native', name: 'http_request' } },
          },
        ],
      },
    })
    expect(askHttp.approval?.tool_name).toBe('http_request')
    expect(askHttp.classifyCalls).toBe(0)

    const live = await drive({
      mode: 'auto',
      gfs: true,
      calls: [
        { id: 'gfs-1', name: 'clerum__gfs_download', arguments: { drive: 'w', resourceId: 'f' } },
      ],
    })
    expect(live.approval?.tool_name).toBe('clerum__gfs_download')
    expect(live.approval?.authorization_scope).toBe('exact_invocation')
    expect(live.classifyCalls).toBe(0)

    process.env.MCP_HOST_GATEWAY_URL = 'http://gateway.invalid'
    process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN = 'token'
    const denialsActive = await drive({
      mode: 'auto',
      calls: [{ id: 'wf-1', name: 'workflow_trigger', arguments: { name: 'wf' } }],
      prepare: conversation => {
        conversation.denials = new Map([['shell_exec', 'mode-user']])
      },
    })
    expect(denialsActive.approval?.tool_name).toBe('workflow_trigger')
    expect(denialsActive.approval?.authorization_scope).toBe('exact_invocation')
    expect(denialsActive.approval?.reask).toBe('denials_active')
    expect(denialsActive.classifyCalls).toBe(0)
    delete process.env.MCP_HOST_GATEWAY_URL
    delete process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN
  })

  it('a denied http_request still cards after reconstruct and a mode change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'approval-mode-deny-'))
    const dbPath = join(root, 'state.db')
    const opens: StoreHandle[] = []
    try {
      const first = makeSqliteStore({ dbPath })
      opens.push(first)
      const denied = await drive({
        mode: 'auto',
        manager: new ConversationManager(first.store),
        sender: 'deny-user',
        calls: [http('http-recon')],
        prepare: conversation => {
          conversation.denials = new Map([['http_request', 'deny-user']])
        },
      })
      expect(denied.approval?.tool_name).toBe('http_request')
      await denied.executor.deny({ userId: 'deny-user' })
      await first.shutdown()
      opens.pop()

      const second = makeSqliteStore({ dbPath })
      opens.push(second)
      const manager = new ConversationManager(second.store)
      const changed = await drive({
        mode: 'auto',
        manager,
        sender: 'deny-user',
        calls: [http('http-recon-2')],
      })
      await manager.setApprovalMode(
        changed.conversation,
        'manual',
        { ceiling: 'allow_all', cap: 'allow_all' },
        'route',
        'deny-user'
      )
      await manager.setApprovalMode(
        changed.conversation,
        'auto',
        { ceiling: 'allow_all', cap: 'allow_all' },
        'route',
        'deny-user'
      )
      expect(changed.approval?.authorization_scope).toBe('exact_invocation')
      expect(changed.classifyCalls).toBe(0)
      const again = await drive({
        mode: 'auto',
        manager,
        sender: 'deny-user',
        calls: [http('http-recon-3')],
      })
      expect(again.approval?.tool_name).toBe('http_request')
      expect(again.approval?.reask).toBe('denied')
      expect(again.classifyCalls).toBe(0)
    } finally {
      for (const handle of opens) await handle.shutdown().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
      delete process.env.MCP_HOST_GATEWAY_URL
      delete process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN
    }
  })

  it('A2 runs HTTP with an empty and a non-empty allowlist and does not classify', async () => {
    appConfig.nativeTool.httpAllowlist = []
    const open = await drive({
      mode: 'auto',
      calls: [http('http-open', 'https://example.test/open')],
    })
    expect(open.approval).toBeUndefined()
    expect(open.completed).toBe(true)
    expect(open.classifyCalls).toBe(0)
    expect(vi.mocked(requestPinned)).toHaveBeenCalled()

    vi.mocked(requestPinned).mockClear()
    appConfig.nativeTool.httpAllowlist = ['allowed.test']
    const listed = await drive({
      mode: 'auto',
      calls: [http('http-listed', 'https://blocked.test/no')],
    })
    expect(listed.approval).toBeUndefined()
    expect(listed.completed).toBe(true)
    expect(listed.classifyCalls).toBe(0)
    expect(vi.mocked(requestPinned)).not.toHaveBeenCalled()
    expect(JSON.stringify(listed.messages)).toContain('not in allowlist')
  })

  it('A1 runs an exact post-rewrite command without classify and classifies a different command', async () => {
    const matched = await drive({
      mode: 'auto',
      calls: [shell('sh-match', 'printf admission-ok')],
      prepare: conversation => {
        conversation.auto_shell_grants = {
          wholeTool: false,
          commands: new Set(['printf admission-ok']),
        }
      },
    })
    expect(matched.classifyCalls).toBe(0)
    expect(matched.approval).toBeUndefined()
    expect(matched.completed).toBe(true)
    expect(JSON.stringify(matched.messages)).toContain('admission-ok')

    const different = await drive({
      mode: 'auto',
      calls: [shell('sh-other', 'printf other-ok')],
      prepare: conversation => {
        conversation.auto_shell_grants = {
          wholeTool: false,
          commands: new Set(['printf admission-ok']),
        }
      },
    })
    expect(different.classifyCalls).toBe(1)
    expect(different.approval).toBeUndefined()

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ updatedInput: { command: 'printf admission-ok' } }), {
            status: 200,
          })
      )
    )
    const rewritten = await drive({
      mode: 'auto',
      calls: [shell('sh-rewrite', 'printf submitted')],
      guardrails: {
        hookDescriptors: [
          {
            id: 'rewrite-command',
            endpoint: 'http://hook.local',
            path: '/',
            lifecyclePoints: ['pre_tool_use'],
            capabilities: ['may_rewrite'],
            failMode: 'open',
            order: 1,
          },
        ],
      },
      prepare: conversation => {
        conversation.auto_shell_grants = {
          wholeTool: false,
          commands: new Set(['printf admission-ok']),
        }
      },
    })
    expect(rewritten.classifyCalls).toBe(0)
    expect(rewritten.approval).toBeUndefined()
    expect(JSON.stringify(rewritten.messages)).toContain('admission-ok')
  })

  it('A3 APPROVE stores nothing, ESCALATE cards with the descriptor, and an unavailable classifier does not call classify', async () => {
    const first = await drive({
      mode: 'auto',
      calls: [shell('sh-once', 'printf admission-ok')],
    })
    expect(first.classifyCalls).toBe(1)
    expect(first.approval).toBeUndefined()
    expect(first.conversation.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
    const second = await drive({
      mode: 'auto',
      calls: [shell('sh-twice', 'printf admission-ok')],
      prepare: conversation => {
        conversation.auto_shell_grants = first.conversation.auto_shell_grants
      },
    })
    expect(second.classifyCalls).toBe(1)

    const escalated = await drive({
      mode: 'auto',
      verdict: 'ESCALATE',
      calls: [shell('sh-esc', 'printf admission-ok')],
    })
    expect(escalated.classifyCalls).toBe(1)
    expect(escalated.approval).toMatchObject({
      tool_name: 'shell_exec',
      authorization_scope: 'exact_invocation',
      shellCard: { channelCommandOffered: true, desktopCommandOffered: true },
    })

    const codex = await driveUnavailable()
    expect(codex.classifyCalls).toBe(0)
    expect(codex.approval?.shellCard).toEqual({
      channelCommandOffered: true,
      desktopCommandOffered: true,
    })
    expect(codex.approval?.authorization_scope).toBe('exact_invocation')

    const secret = await drive({
      mode: 'auto',
      verdict: 'ESCALATE',
      calls: [shell('sh-secret', 'printf sk-live-abc123def456ghi789jkl012')],
    })
    expect(secret.approval?.shellCard).toEqual({
      channelCommandOffered: true,
      desktopCommandOffered: false,
    })

    const huge = await drive({
      mode: 'auto',
      verdict: 'ESCALATE',
      calls: [shell('sh-huge', 'x'.repeat(64 * 1024 + 1))],
    })
    expect(huge.approval?.shellCard).toEqual({
      channelCommandOffered: false,
      desktopCommandOffered: false,
    })
  })

  it('A3 re-reads the mode and the tools override after classify', async () => {
    let release: ((value: { content: string }) => void) | undefined
    const holder = { policy: policy('allow_all') }
    const pending = drive({
      mode: 'auto',
      holder,
      calls: [shell('sh-reread', 'printf admission-ok')],
      verdict: () =>
        new Promise(resolve => {
          release = resolve
        }),
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    holder.policy = policy('manual')
    release!({ content: 'APPROVE' })
    const changed = await pending
    expect(changed.classifyCalls).toBe(1)
    expect(changed.approval?.tool_name).toBe('shell_exec')
    expect(changed.approval?.shellCard).toBeUndefined()
    expect(changed.completed).toBe(false)

    let releaseTools: ((value: { content: string }) => void) | undefined
    const tools = { policy: policy('allow_all') }
    const forced = drive({
      mode: 'auto',
      holder: tools,
      calls: [shell('sh-tools', 'printf admission-ok')],
      verdict: () =>
        new Promise(resolve => {
          releaseTools = resolve
        }),
    })
    await vi.waitFor(() => expect(releaseTools).toBeTypeOf('function'))
    tools.policy = policy('allow_all', { shell_exec: true })
    releaseTools!({ content: 'APPROVE' })
    const admin = await forced
    expect(admin.classifyCalls).toBe(1)
    expect(admin.approval?.authorization_scope).toBe('exact_invocation')
    expect(admin.approval?.shellCard).toBeUndefined()
  })

  it('A6 cards MCP, browser_open, and workflow_trigger exactly, including an MCP Always grant', async () => {
    process.env.CLERUM_DESKTOP_BROWSER = 'true'
    process.env.MCP_HOST_GATEWAY_URL = 'http://gateway.invalid'
    process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN = 'token'
    process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN = 'runtime-access'
    process.env.MCP_HOST_RUNTIME_REFRESH_TOKEN = 'runtime-refresh'
    try {
      const mcp = await drive({
        mode: 'auto',
        calls: [{ id: 'mcp-1', name: 'acme__search', arguments: { q: 'n' } }],
        prepare: conversation => {
          conversation.auto_approved_tools.add('acme__search')
        },
      })
      expect(mcp.approval).toMatchObject({
        tool_name: 'acme__search',
        authorization_scope: 'exact_invocation',
      })
      expect(mcp.classifyCalls).toBe(0)
      expect(mcp.conversation.auto_approved_tools.has('acme__search')).toBe(true)

      const browser = await drive({
        mode: 'auto',
        calls: [{ id: 'br-1', name: 'browser_open', arguments: { url: 'https://example.test' } }],
      })
      expect(browser.approval).toMatchObject({
        tool_name: 'browser_open',
        authorization_scope: 'exact_invocation',
      })

      const workflow = await drive({
        mode: 'auto',
        calls: [{ id: 'wf-a6', name: 'workflow_trigger', arguments: { name: 'wf' } }],
      })
      expect(workflow.approval).toMatchObject({
        tool_name: 'workflow_trigger',
        authorization_scope: 'exact_invocation',
      })
      expect(workflow.approval?.shellCard).toBeUndefined()
    } finally {
      delete process.env.MCP_HOST_GATEWAY_URL
      delete process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN
      delete process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN
      delete process.env.MCP_HOST_RUNTIME_REFRESH_TOKEN
    }
  })

  it('X1 runs shell, MCP, live download, admin_forced, denied, and denials_active without classify', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    process.env.MCP_HOST_GATEWAY_URL = 'http://gateway.invalid'
    process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN = 'token'
    try {
      const ran = await drive({
        mode: 'allow_all',
        calls: [shell('sh-x1', `printf ${COMMAND_SENTINEL}`)],
        prepare: conversation => {
          conversation.denials = new Map([['other_tool', 'mode-user']])
        },
      })
      expect(ran.approval).toBeUndefined()
      expect(ran.classifyCalls).toBe(0)
      expect(ran.completed).toBe(true)

      const mcp = await drive({
        mode: 'allow_all',
        calls: [{ id: 'mcp-x1', name: 'acme__search', arguments: { q: PARAM_SENTINEL } }],
      })
      expect(mcp.approval).toBeUndefined()
      expect(mcp.classifyCalls).toBe(0)

      const live = await drive({
        mode: 'allow_all',
        gfs: true,
        calls: [{ id: 'gfs-x1', name: 'clerum__gfs_download', arguments: { drive: 'w' } }],
      })
      expect(live.approval).toBeUndefined()
      expect(live.classifyCalls).toBe(0)

      const forced = await drive({
        mode: 'allow_all',
        tools: { shell_exec: true },
        calls: [shell('sh-admin', 'printf admission-ok')],
      })
      expect(forced.approval).toBeUndefined()
      expect(forced.classifyCalls).toBe(0)

      const denied = await drive({
        mode: 'allow_all',
        calls: [shell('sh-deny-x1', 'printf admission-ok')],
        prepare: conversation => {
          conversation.denials = new Map([['shell_exec', 'mode-user']])
        },
      })
      expect(denied.approval).toBeUndefined()
      expect(denied.classifyCalls).toBe(0)

      const workflow = await drive({
        mode: 'allow_all',
        calls: [{ id: 'wf-x1', name: 'workflow_trigger', arguments: { name: 'wf' } }],
        prepare: conversation => {
          conversation.denials = new Map([['shell_exec', 'mode-user']])
        },
      })
      expect(workflow.approval).toBeUndefined()
      expect(workflow.classifyCalls).toBe(0)
    } finally {
      info.mockRestore()
      delete process.env.MCP_HOST_GATEWAY_URL
      delete process.env.MCP_HOST_WORKFLOW_CONTROL_TOKEN
    }
  })

  it.each([
    [
      'an explicit ask rule',
      {
        id: 'ask-http-x2',
        action: 'ask' as const,
        reasonCode: DESCRIPTION_SENTINEL,
        match: { tool: { provenance: 'native' as const, name: 'http_request' } },
      },
    ],
    [
      'the unmatched default of a Host with rules',
      {
        id: 'allow-shell-x2',
        action: 'allow' as const,
        match: { tool: { provenance: 'native' as const, name: 'shell_exec' } },
      },
    ],
  ])(
    'X2 cards a guardrail ask from %s in allow-all, exactly and without classify',
    async (_label, rule) => {
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
      try {
        const asked = await drive({
          mode: 'allow_all',
          calls: [http('http-ask-x2')],
          guardrails: { rules: [rule] },
        })
        expect(asked.approval).toMatchObject({
          tool_name: 'http_request',
          authorization_scope: 'exact_invocation',
        })
        expect(pendingApprovalWireFields(asked.approval!).alwaysApproveAllowed).toBe(false)
        expect(asked.executor.executorState).toBe('waiting_approval')
        expect(asked.classifyCalls).toBe(0)
        expect(vi.mocked(requestPinned)).not.toHaveBeenCalled()
        expect(infoEvents(info, 'L4')).toHaveLength(0)

        const ran = await drive({ mode: 'allow_all', calls: [http('http-no-guardrail-x2')] })
        expect(ran.approval).toBeUndefined()
        expect(vi.mocked(requestPinned)).toHaveBeenCalledTimes(1)
      } finally {
        info.mockRestore()
      }
    }
  )

  it('C1 honors a cron task grant in auto and cards allow-all creates that manual would card', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      const grantManager = new ConversationManager()
      vi.spyOn(grantManager, 'startTurn').mockImplementation(async (conversation, ...rest) => {
        const turn = await ConversationManager.prototype.startTurn.call(
          grantManager,
          conversation,
          ...rest
        )
        conversation.task_approved_tools = new Set(['cron_manage'])
        return turn
      })
      const granted = await drive({
        mode: 'auto',
        manager: grantManager,
        calls: [
          {
            id: 'cron-grant',
            name: 'cron_manage',
            arguments: { action: 'create', name: 'job', schedule: '0 0 * * *', task: 'ping' },
          },
        ],
        prepare: conversation => {
          conversation.last_effective_approval_mode = 'auto'
        },
      })
      expect(granted.approval).toBeUndefined()
      expect(granted.completed).toBe(true)
      expect(infoEvents(info, 'L4')).toHaveLength(0)

      appConfig.statelessLifecycle = true
      appConfig.nativeTool.statelessLifecycle = true
      process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = 'true'
      for (const cause of ['forced', 'ask', 'denials'] as const) {
        const card = await drive({
          mode: 'allow_all',
          stateless: true,
          calls: [
            {
              id: `cron-${cause}`,
              name: 'cron_manage',
              arguments: { action: 'create', name: 'job', schedule: '0 0 * * *', task: 'ping' },
            },
          ],
          prepare: conversation => {
            conversation.task_approved_tools = new Set(['cron_manage'])
            if (cause === 'denials') conversation.denials = new Map([['shell_exec', 'mode-user']])
          },
          guardrails:
            cause === 'ask'
              ? {
                  rules: [
                    {
                      id: 'ask-cron',
                      action: 'ask',
                      match: { tool: { provenance: 'native', name: 'cron_manage' } },
                    },
                  ],
                }
              : undefined,
        })
        expect(card.approval?.tool_name).toBe('cron_manage')
        expect(card.approval?.authorization_scope).toBe('exact_invocation')
        expect(infoEvents(info, 'L4')).toHaveLength(0)
      }
    } finally {
      info.mockRestore()
    }
  })

  it('a cron-sourced stateless task runs shell and suspends only cron create', async () => {
    appConfig.statelessLifecycle = true
    appConfig.nativeTool.statelessLifecycle = true
    process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = 'true'
    const ran = await drive({
      mode: 'auto',
      cron: true,
      stateless: true,
      tools: { shell_exec: true },
      calls: [shell('cron-shell', 'printf admission-ok')],
      prepare: conversation => {
        conversation.approval_mode = 'auto'
      },
    })
    expect(ran.approval).toBeUndefined()
    expect(ran.completed).toBe(true)
    expect(ran.classifyCalls).toBe(0)

    const card = await drive({
      mode: 'auto',
      cron: true,
      stateless: true,
      tools: { shell_exec: true },
      calls: [
        {
          id: 'cron-create',
          name: 'cron_manage',
          arguments: { action: 'create', name: 'job', schedule: '0 0 * * *', task: 'ping' },
        },
      ],
      prepare: conversation => {
        conversation.approval_mode = 'auto'
      },
    })
    expect(card.approval?.tool_name).toBe('cron_manage')
    expect(card.classifyCalls).toBe(0)
  })

  it('channel cap at admission decides the next call as manual', async () => {
    const card = await drive({
      mode: 'allow_all',
      channelType: 'telegram',
      ceiling: 'allow_all',
      allowModeChange: false,
      calls: [http('http-cap')],
      prepare: conversation => {
        conversation.approval_mode = 'allow_all'
        conversation.last_effective_approval_mode = 'allow_all'
      },
    })
    expect(card.approval?.tool_name).toBe('http_request')
    expect(card.classifyCalls).toBe(0)
    expect(vi.mocked(requestPinned)).not.toHaveBeenCalled()
  })
})

describe('grant memory through admission', () => {
  it('a ceiling drop and a kill-switch dip both make the next shell call classify', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      const holder = { policy: policy('manual') }
      const dropped = await drive({
        mode: 'auto',
        holder,
        calls: [shell('sh-low', 'printf admission-ok')],
        prepare: conversation => {
          conversation.auto_shell_grants = {
            wholeTool: true,
            commands: new Set(['printf admission-ok']),
          }
          conversation.last_effective_approval_mode = 'auto'
        },
      })
      expect(dropped.approval?.tool_name).toBe('shell_exec')
      expect(dropped.classifyCalls).toBe(0)
      expect(dropped.conversation.auto_shell_grants.wholeTool).toBe(false)
      await dropped.executor.deny({ record: false })
      holder.policy = policy('allow_all')
      const again = await drive({
        mode: 'auto',
        holder,
        manager: dropped.manager,
        calls: [shell('sh-back', 'printf admission-ok')],
      })
      expect(again.classifyCalls).toBe(1)
      expect(again.approval).toBeUndefined()
      expect(infoEvents(info, 'L2').length).toBeGreaterThan(0)
    } finally {
      info.mockRestore()
    }
  })

  it('allowModeChange off and back on, with no tool call, makes the next shell call classify', async () => {
    const manager = new ConversationManager()
    const conversation = await manager.getOrCreate('cap-user:slack:mode-channel:default', {
      userId: 'cap-user',
      channelType: 'slack',
      approvalMode: 'auto',
    })
    conversation.auto_shell_grants = { wholeTool: true, commands: new Set(['printf admission-ok']) }
    conversation.last_effective_approval_mode = 'auto'
    const agentTools = policy('allow_all', undefined, false)
    const { effectiveApprovalMode } = await import('../../core/approval/approvalMode')
    const { syncEffectiveMode } = await import('../../core/approval/grantMemory')
    const low = effectiveApprovalMode('auto', 'allow_all', 'manual')
    syncEffectiveMode(conversation, low)
    const high = effectiveApprovalMode('auto', 'allow_all', 'allow_all')
    syncEffectiveMode(conversation, high)
    expect(conversation.auto_shell_grants.wholeTool).toBe(false)
    const next = await drive({
      mode: 'auto',
      channelType: 'slack',
      sender: 'cap-user',
      manager,
      calls: [shell('sh-restored', 'printf admission-ok')],
    })
    expect(next.classifyCalls).toBe(1)
    expect(next.approval).toBeUndefined()
    void agentTools
  })

  it('PATCH manual then auto clears the shell grant, and the same mode twice keeps it', async () => {
    const manager = new ConversationManager()
    const conversation = await manager.getOrCreate('writer-user:rpc:mode-channel:default', {
      userId: 'writer-user',
      channelType: 'rpc',
      approvalMode: 'auto',
    })
    conversation.auto_shell_grants = { wholeTool: true, commands: new Set() }
    conversation.last_effective_approval_mode = 'auto'
    const live = { ceiling: 'allow_all' as const, cap: 'allow_all' as const }
    await manager.setApprovalMode(conversation, 'manual', live, 'route', 'writer-user')
    await manager.setApprovalMode(conversation, 'auto', live, 'route', 'writer-user')
    const cleared = await drive({
      mode: 'auto',
      sender: 'writer-user',
      manager,
      calls: [shell('sh-writer', 'printf admission-ok')],
    })
    expect(cleared.classifyCalls).toBe(1)

    const kept = await manager.getOrCreate('same-user:rpc:mode-channel:default', {
      userId: 'same-user',
      channelType: 'rpc',
      approvalMode: 'auto',
    })
    kept.auto_shell_grants = { wholeTool: true, commands: new Set() }
    kept.last_effective_approval_mode = 'auto'
    await manager.setApprovalMode(kept, 'auto', live, 'route', 'same-user')
    await manager.setApprovalMode(kept, 'auto', live, 'route', 'same-user')
    const same = await drive({
      mode: 'auto',
      sender: 'same-user',
      manager,
      calls: [shell('sh-same', 'printf admission-ok')],
    })
    expect(same.classifyCalls).toBe(0)
    expect(same.approval).toBeUndefined()
    expect(same.conversation.auto_shell_grants.wholeTool).toBe(true)
  })

  it('a shell denial clears the command grant and a timeout keeps it', async () => {
    const card = await drive({
      mode: 'auto',
      verdict: 'ESCALATE',
      calls: [shell('sh-card', 'printf other-ok')],
      prepare: conversation => {
        conversation.auto_shell_grants = {
          wholeTool: false,
          commands: new Set(['printf admission-ok']),
        }
      },
    })
    expect(card.approval?.tool_name).toBe('shell_exec')
    await card.executor.deny({ userId: 'mode-user' })
    expect(card.conversation.auto_shell_grants.commands.size).toBe(0)
    const reask = await drive({
      mode: 'auto',
      manager: card.manager,
      calls: [shell('sh-reask', 'printf admission-ok')],
    })
    expect(reask.approval?.reask).toBe('denied')
    expect(reask.classifyCalls).toBe(0)
    await reask.executor.resumeAfterApproval(false, 'mode-user')
    const after = await drive({
      mode: 'auto',
      manager: reask.manager,
      calls: [shell('sh-after-deny', 'printf admission-ok')],
    })
    expect(after.classifyCalls).toBe(1)

    const timeoutCard = await drive({
      mode: 'auto',
      verdict: 'ESCALATE',
      calls: [shell('sh-timeout', 'printf other-ok')],
      prepare: conversation => {
        conversation.auto_shell_grants = {
          wholeTool: false,
          commands: new Set(['printf admission-ok']),
        }
      },
    })
    await timeoutCard.executor.deny({ record: false })
    expect(timeoutCard.conversation.auto_shell_grants.commands).toEqual(
      new Set(['printf admission-ok'])
    )
    const kept = await drive({
      mode: 'auto',
      manager: timeoutCard.manager,
      calls: [shell('sh-kept', 'printf admission-ok')],
    })
    expect(kept.classifyCalls).toBe(0)
    expect(kept.approval).toBeUndefined()
  })

  it('a non-shell Always grant survives a mode change and is honored again in manual', async () => {
    const autoCard = await drive({
      mode: 'auto',
      calls: [{ id: 'mcp-auto', name: 'acme__search', arguments: { q: 'n' } }],
      prepare: conversation => {
        conversation.auto_approved_tools.add('acme__search')
        conversation.last_effective_approval_mode = 'auto'
      },
    })
    expect(autoCard.approval?.authorization_scope).toBe('exact_invocation')
    const manual = await drive({
      mode: 'manual',
      ceiling: 'manual',
      calls: [{ id: 'mcp-manual', name: 'acme__search', arguments: { q: 'n' } }],
      prepare: conversation => {
        conversation.auto_approved_tools.add('acme__search')
        conversation.last_effective_approval_mode = 'manual'
      },
    })
    expect(manual.approval).toBeUndefined()
    expect(manual.completed).toBe(true)
  })

  it('a cron task grant survives a mode change and does not log L4 in auto or allow-all', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    try {
      for (const mode of ['auto', 'allow_all'] as const) {
        const grantManager = new ConversationManager()
        vi.spyOn(grantManager, 'startTurn').mockImplementation(async (conversation, ...rest) => {
          const turn = await ConversationManager.prototype.startTurn.call(
            grantManager,
            conversation,
            ...rest
          )
          conversation.task_approved_tools = new Set(['cron_manage', 'shell_exec'])
          return turn
        })
        const ran = await drive({
          mode,
          manager: grantManager,
          calls: [
            {
              id: `cron-${mode}`,
              name: 'cron_manage',
              arguments: { action: 'create', name: 'job', schedule: '0 0 * * *', task: 'ping' },
            },
          ],
          prepare: conversation => {
            conversation.last_effective_approval_mode = mode === 'auto' ? 'manual' : 'auto'
            conversation.approval_mode = mode
          },
        })
        expect(ran.approval).toBeUndefined()
        expect(ran.completed).toBe(true)
        expect(ran.conversation.task_approved_tools?.has('cron_manage')).toBe(true)
      }
      expect(infoEvents(info, 'L4')).toHaveLength(0)
    } finally {
      info.mockRestore()
    }
  })
})

describe('classifier pair while failover serves a fallback', () => {
  /**
   * A fallback provider that serves the tool turn with the primary's script
   * and answers classify calls itself.
   */
  function fallbackProvider(
    type: ProviderType,
    primary: SingleTurnProvider,
    onTurn?: () => void
  ): SingleTurnProvider & { classifyCalls: () => number } {
    let calls = 0
    return {
      getProviderType: () => type,
      classifyError: () => {
        throw new Error('fixture classification is unused')
      },
      completeSingleTurn: vi.fn(async () => {
        calls += 1
        return { content: 'APPROVE', usage, finish_reason: FinishReason.Stop }
      }),
      completeSingleTurnWithTools: vi.fn(
        async (...args: Parameters<SingleTurnProvider['completeSingleTurnWithTools']>) => {
          const response = await primary.completeSingleTurnWithTools(...args)
          onTurn?.()
          return response
        }
      ),
      classifyCalls: () => calls,
    }
  }

  /**
   * The primary failed and is cooling down, so the engine serves the first
   * fallback entry that can be built, and keeps serving it for the task.
   */
  async function engineServingFallback(
    policy: LlmPolicy,
    buildable: (provider: string) => boolean = () => true
  ): Promise<FailoverEngine> {
    const engine = new FailoverEngine(policy, { metricInc: () => {} })
    await engine.run(
      { provider: 'primary', model: 'claude-test' },
      target =>
        target.kind === 'primary'
          ? async () => {
              throw new Error('rate limit fixture')
            }
          : buildable(target.provider)
            ? async () => 'warmed'
            : null,
      () => ({ code: LlmErrorCode.RateLimited, retryable: true })
    )
    return engine
  }

  it('judges and calls the serving fallback, not the primary or another fallback entry', async () => {
    const policy: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['rate_limited'],
      fallbacks: [
        { provider: 'gemini', model: 'gemini-fixture' },
        { provider: 'openai', model: 'gpt-4.1' },
      ],
    }
    // Only the openai entry can be built, so the second entry serves.
    const engine = await engineServingFallback(policy, provider => provider === 'openai')
    expect(engine.servedBy()).toEqual({ provider: 'openai', model: 'gpt-4.1', fallback: true })
    let openai: ReturnType<typeof fallbackProvider> | undefined
    const builds: FallbackEntry[] = []
    const result = await drive({
      mode: 'auto',
      calls: [shell('sh-fallback', 'printf admission-ok')],
      failover: primary => {
        openai = fallbackProvider('openai', primary)
        return {
          engine,
          policy,
          buildProvider: entry => {
            builds.push(entry)
            return entry.provider === 'openai' ? openai! : null
          },
        }
      },
    })

    expect(result.approval).toBeUndefined()
    expect(result.completed).toBe(true)
    expect(openai!.classifyCalls()).toBe(1)
    expect(result.classifyCalls).toBe(0)
    expect(builds).toContainEqual({ provider: 'openai', model: 'gpt-4.1' })
  })

  it('shows the shell card when the serving fallback is one the table refuses, though the primary is eligible', async () => {
    const policy: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['rate_limited'],
      fallbacks: [{ provider: 'zai', model: 'glm-4.6' }],
    }
    const engine = await engineServingFallback(policy)
    expect(engine.servedBy()).toEqual({ provider: 'zai', model: 'glm-4.6', fallback: true })
    let zai: ReturnType<typeof fallbackProvider> | undefined
    const result = await drive({
      mode: 'auto',
      calls: [shell('sh-refused', 'printf admission-ok')],
      failover: primary => {
        zai = fallbackProvider('zai', primary)
        return { engine, policy, buildProvider: () => zai! }
      },
    })

    expect(result.approval).toMatchObject({
      tool_name: 'shell_exec',
      authorization_scope: 'exact_invocation',
      shellCard: { channelCommandOffered: true, desktopCommandOffered: true },
    })
    expect(vi.mocked(zai!.completeSingleTurnWithTools)).toHaveBeenCalledTimes(1)
    expect(zai!.classifyCalls()).toBe(0)
    expect(result.classifyCalls).toBe(0)
  })

  it('shows the shell card when the serving fallback can no longer be built for the classifier', async () => {
    const policy: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['rate_limited'],
      fallbacks: [{ provider: 'claude', model: 'claude-fallback' }],
    }
    const engine = await engineServingFallback(policy)
    // Its credential is removed after it served the turn and before admission.
    let credentialPresent = true
    let claude: ReturnType<typeof fallbackProvider> | undefined
    const result = await drive({
      mode: 'auto',
      primaryType: 'zai',
      calls: [shell('sh-unbuilt', 'printf admission-ok')],
      failover: primary => {
        claude = fallbackProvider('claude', primary, () => {
          credentialPresent = false
        })
        return { engine, policy, buildProvider: () => (credentialPresent ? claude! : null) }
      },
    })

    expect(result.approval).toMatchObject({
      tool_name: 'shell_exec',
      shellCard: { channelCommandOffered: true, desktopCommandOffered: true },
    })
    expect(claude!.classifyCalls()).toBe(0)
    expect(result.classifyCalls).toBe(0)
    expect(vi.mocked(claude!.completeSingleTurnWithTools)).toHaveBeenCalledTimes(1)
    expect(engine.servedBy()).toEqual({
      provider: 'claude',
      model: 'claude-fallback',
      fallback: true,
    })
  })
})

describe('L2 and L4', () => {
  it('emits L2 once when the ceiling changes at admission', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const result = await drive({
        mode: 'allow_all',
        channelType: 'slack',
        sender: SENDER,
        threadId: THREAD,
        ceiling: 'manual',
        calls: [http('http-l2', `https://example.test/${PARAM_SENTINEL}`)],
        prepare: conversation => {
          conversation.approval_mode = 'allow_all'
          conversation.last_effective_approval_mode = 'allow_all'
        },
      })
      const l2 = infoEvents(info, 'L2')
      expect(l2).toHaveLength(1)
      expect(l2[0]).toMatchObject({
        event: 'L2',
        session: approvalLogId(result.conversation.id),
        storedMode: 'allow_all',
        previousEffectiveMode: 'allow_all',
        effectiveApprovalMode: 'manual',
      })
      expect(result.conversation.id.startsWith('conv-')).toBe(true)
      expect(String((l2[0] as { session: string }).session)).toMatch(/^[0-9a-f]{64}$/)
      const line = JSON.stringify(l2[0])
      expect(line).not.toContain(SENDER)
      expect(line).not.toContain(THREAD)
      expect(line).not.toContain(PARAM_SENTINEL)
      expect(line).not.toContain(COMMAND_SENTINEL)
      expect(line).not.toContain(DESCRIPTION_SENTINEL)
      expect(warn.mock.calls.some(call => (call[0] as { event?: string }).event === 'L2')).toBe(
        false
      )
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  it('emits L4 once for an allow-all run', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const result = await drive({
        mode: 'allow_all',
        channelType: 'slack',
        sender: SENDER,
        threadId: THREAD,
        calls: [shell('sh-l4', `printf ${COMMAND_SENTINEL} ${PARAM_SENTINEL}`)],
        prepare: conversation => {
          conversation.last_effective_approval_mode = 'allow_all'
        },
        tools: { shell_exec: true },
      })
      const l4 = infoEvents(info, 'L4')
      expect(l4).toHaveLength(1)
      expect(l4[0]).toMatchObject({
        event: 'L4',
        session: approvalLogId(result.conversation.id),
        tool: 'shell_exec',
        cause: 'admin_forced',
        mode: 'allow_all',
      })
      expect(String((l4[0] as { session: string }).session)).toMatch(/^[0-9a-f]{64}$/)
      const line = JSON.stringify(l4[0])
      expect(line).not.toContain(SENDER)
      expect(line).not.toContain(THREAD)
      expect(line).not.toContain(COMMAND_SENTINEL)
      expect(line).not.toContain(PARAM_SENTINEL)
      expect(line).not.toContain(DESCRIPTION_SENTINEL)
      expect(warn.mock.calls.some(call => (call[0] as { event?: string }).event === 'L4')).toBe(
        false
      )
      expect(result.approval).toBeUndefined()
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  it('U1 warns and cards when a suspension has no cause', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const conversation = makeFakeConversation({ id: 'conv-u1', approval_mode: 'allow_all' })
      const approval: PendingApproval = {
        request_id: 'u1',
        tool_name: 'http_request',
        authorization_scope: 'turn_tools',
        parameters: { url: 'https://example.test' },
        description: 'needs approval',
        tool_call_id: 'tc-u1',
        context_snapshot: [],
      }
      const config = {
        reasoning: {} as never,
        toolRegistry: { get: () => null, register: () => {}, listDefinitions: () => [] },
        safety: {
          validateInput: () => ({ is_valid: true, errors: [] }),
          validateToolParams: () => ({ is_valid: true, errors: [] }),
          sanitizeOutput: (_name: string, output: string) => ({
            content: output,
            was_modified: false,
            warnings: [],
          }),
          wrapForLlm: (_name: string, content: string) => content,
        },
        events: { emit: () => {}, on: () => {}, off: () => {} },
        conversation,
        loopController: {
          shouldAccept: () => true,
          onTextRejected: () => null,
          beforeTool: () => ({ type: 'suspend', approval }),
          onExhaustion: () => '',
          refreshTools: async (tools: unknown[]) => tools,
        },
        contextManager: {} as never,
        toolOutputProcessor: {
          beforeExecution: () => ({ is_valid: true, errors: [] }),
          afterExecution: (_name: string, output: { content: string }) => output.content,
        },
        maxIterations: 1,
        toolTimeout: 1000,
        toolProgressInterval: 0,
        approvalMode: {
          storedMode: () => 'allow_all' as const,
          ceiling: () => 'allow_all' as const,
          channelCap: () => 'allow_all' as const,
          classifierAvailable: () => true,
          classify: async () => 'APPROVE' as const,
        },
      } as LoopConfig
      const admission = await admitToolCall(
        { id: 'tc-u1', name: 'http_request', arguments: { url: 'https://example.test' } },
        config,
        0
      )
      expect(admission.kind).toBe('suspend')
      if (admission.kind === 'suspend')
        expect(admission.approval.authorization_scope).toBe('exact_invocation')
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'U1', tool: 'http_request' }),
        expect.any(String)
      )
    } finally {
      warn.mockRestore()
    }
  })
})

async function driveUnavailable(): Promise<DriveResult> {
  const manager = new ConversationManager()
  const lifecycle = new TaskLifecycle()
  const task: Task = {
    id: 'task-unavailable',
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'mode-user',
      content: 'run the tool',
      channelType: 'rpc',
      channelId: 'mode-channel',
      messageId: 'msg-unavailable',
      timestamp: new Date().toISOString(),
      hostRef: 'mode-host',
    },
    conversationHistory: [{ role: 'user', content: 'run the tool', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  const conversation = await manager.getOrCreate(resolveTaskSessionKey(task), {
    userId: 'mode-user',
    channelType: 'rpc',
    approvalMode: 'auto',
  })
  const host = policy('allow_all')
  let classifyCalls = 0
  const provider: SingleTurnProvider = {
    getProviderType: () => 'codex-subscription',
    classifyError: () => {
      throw new Error('unused')
    },
    completeSingleTurn: vi.fn(async () => {
      classifyCalls += 1
      return { content: 'APPROVE', usage, finish_reason: FinishReason.Stop }
    }),
    completeSingleTurnWithTools: vi.fn(async () => ({
      content: null,
      tool_calls: [shell('sh-unavail-2', 'printf admission-ok')],
      usage,
      finish_reason: FinishReason.ToolUse,
    })),
  }
  let calls = 0
  provider.completeSingleTurnWithTools = vi.fn(async () => {
    calls += 1
    if (calls > 1) {
      return { content: 'done', tool_calls: null, usage, finish_reason: FinishReason.Stop }
    }
    return {
      content: null,
      tool_calls: [shell('sh-unavail-2', 'printf admission-ok')],
      usage,
      finish_reason: FinishReason.ToolUse,
    }
  })
  lifecycle.register(task)
  lifecycle.transition(task.id, 'processing', 'dispatched')
  const executor = new TaskExecutor(task, {
    conversationManager: manager,
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    modelName: 'gpt-5.4-mini',
    approvalConfig: host,
    approvalConfigProvider: () => ({ effective: host, hostSpec: host }),
    coreEvents: { emit: () => {}, on: () => {}, off: () => {} } as never,
    cronScheduler: null,
    taskLifecycle: lifecycle,
    config: {
      maxTaskDuration: 30_000,
      maxToolCallsPerTask: 4,
      autoStart: false,
      taskDelay: 0,
      approvalTimeout: 0,
    },
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
  })
  await executor.run()
  return {
    approval: executor.pendingApproval,
    classifyCalls,
    completed: executor.executorState === 'completed',
    messages: [],
    conversation,
    executor,
    manager,
    holder: { policy: host },
  }
}
