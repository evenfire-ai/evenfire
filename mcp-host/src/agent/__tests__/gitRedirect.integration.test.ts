/**
 * The typed-git redirect through TaskExecutor (P1-T8): in auto, a typed
 * read-only git shell command that would be classified or carded gets a fixed
 * text pointing to git_read, once per command text per task. A scripted model
 * makes the listed calls turn by turn; an APPROVE classifier counts its calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as appConfig } from '../../config'
import type { ApprovalMode } from '../../core/approval/approvalMode'
import { GIT_REDIRECT_TEXT } from '../../core/approval/gitRedirect'
import { ConversationManager } from '../../core/conversation/conversation'
import { recordDenial } from '../../core/conversation/denialPolicy'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import type { GuardrailsConfig } from '../../core/guardrails'
import type { LoopConfig } from '../../core/orchestration/loopConfig'
import { admitToolCall } from '../../core/orchestration/toolCallPolicy'
import { probeGitRead } from '../../core/tools/gitRead/probe'
import type { ChatMessage, Conversation, PendingApproval, ToolCall } from '../../core/types'
import { FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import { CronScheduler } from '../cronScheduler'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const PUB_WITNESS = 'PUB_WITNESS_7d21'
const NESTED_WITNESS = 'NESTED_SECRET_a40e'
const SECRET_WITNESS = 'SECRET_WITNESS_93fc'
let registerGitRead = true

const saved = {
  enableApproval: appConfig.enableApproval,
  workspacePath: appConfig.nativeTool.workspacePath,
  gitRead: appConfig.nativeTool.gitRead,
}
let workspace: string

function git(...args: string[]): void {
  const result = spawnSync(
    '/usr/bin/git',
    ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: workspace,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    }
  )
  if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`)
}

beforeEach(() => {
  const probe = probeGitRead()
  if (!probe.available) throw new Error(`git_read probe unavailable: ${probe.reason}`)
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'git-read-admission-')))
  mkdirSync(join(workspace, 'pub', 'secret'), { recursive: true })
  mkdirSync(join(workspace, 'secrets'))
  writeFileSync(join(workspace, 'pub', 'a.txt'), `${PUB_WITNESS}\n`)
  writeFileSync(join(workspace, 'pub', 'secret', 'b.txt'), `${NESTED_WITNESS}\n`)
  writeFileSync(join(workspace, 'secrets', 'a.txt'), `${SECRET_WITNESS}\n`)
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'c1')
  appConfig.enableApproval = true
  appConfig.nativeTool.workspacePath = workspace
  appConfig.nativeTool.gitRead = registerGitRead ? probe : undefined
})
afterEach(() => {
  appConfig.enableApproval = saved.enableApproval
  appConfig.nativeTool.workspacePath = saved.workspacePath
  appConfig.nativeTool.gitRead = saved.gitRead
  rmSync(workspace, { recursive: true, force: true })
  registerGitRead = true
})

function policy(ceiling: ApprovalMode, tools?: Record<string, boolean>): ApprovalConfig {
  return {
    defaultPolicy: 'channel_users',
    modeCeiling: ceiling,
    channels: {},
    ...(tools ? { tools } : {}),
  }
}

interface RunResult {
  approval?: PendingApproval
  classifyCalls: number
  /** Every tool message the model saw, in order. */
  toolMessages: string[]
  conversation: Conversation
  executor: TaskExecutor
}

async function run(options: {
  mode: ApprovalMode
  turns: ToolCall[][]
  tools?: Record<string, boolean>
  guardrails?: GuardrailsConfig
  prepare?: (conversation: Conversation) => void
  manager?: ConversationManager
}): Promise<RunResult> {
  const manager = options.manager ?? new ConversationManager()
  const lifecycle = new TaskLifecycle()
  const scheduler = new CronScheduler(new MessageQueue(), {
    statelessLifecycle: false,
    allowEnabledJobs: true,
  })
  const task: Task = {
    id: `task-${Math.random().toString(36).slice(2)}`,
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'redirect-user',
      content: 'check the repo',
      channelType: 'rpc',
      channelId: 'redirect-channel',
      messageId: `msg-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      hostRef: 'redirect-host',
    },
    conversationHistory: [{ role: 'user', content: 'check the repo', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  const conversation = await manager.getOrCreate(resolveTaskSessionKey(task), {
    userId: 'redirect-user',
    channelType: 'rpc',
    approvalMode: options.mode,
  })
  options.prepare?.(conversation)
  const approvalConfig = policy('allow_all', options.tools)
  const seen: ChatMessage[][] = []
  let classifyCalls = 0
  const provider: SingleTurnProvider = {
    getProviderType: () => 'claude',
    classifyError: () => {
      throw new Error('fixture classification is unused')
    },
    completeSingleTurn: vi.fn(async () => {
      classifyCalls += 1
      return { content: 'APPROVE', usage, finish_reason: FinishReason.Stop }
    }),
    completeSingleTurnWithTools: vi.fn(async (messages: ChatMessage[]) => {
      seen.push(structuredClone(messages))
      const calls = options.turns[seen.length - 1] ?? null
      return {
        content: calls ? null : 'done',
        tool_calls: calls,
        usage,
        finish_reason: calls ? FinishReason.ToolUse : FinishReason.Stop,
      }
    }),
  }
  lifecycle.register(task)
  lifecycle.transition(task.id, 'processing', 'dispatched')
  const deps: TaskExecutorDeps = {
    conversationManager: manager,
    llmProvider: provider,
    mcpManager: null,
    workspaceService: undefined,
    modelName: 'claude-test',
    approvalConfig,
    approvalConfigProvider: () => ({ effective: approvalConfig, hostSpec: approvalConfig }),
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
    onFail: vi.fn(),
  }
  const executor = new TaskExecutor(task, deps)
  await executor.run()
  scheduler.stop()
  const last = seen[seen.length - 1] ?? []
  return {
    approval: executor.pendingApproval,
    classifyCalls,
    toolMessages: last
      .filter(m => m.role === 'tool')
      .map(m => (typeof m.content === 'string' ? m.content : '')),
    conversation,
    executor,
  }
}

const shell = (command: string, id = `sh-${Math.random().toString(36).slice(2)}`): ToolCall => ({
  id,
  name: 'shell_exec',
  arguments: { command },
})
const redirected = (message: string | undefined): boolean =>
  message !== undefined && message.includes(GIT_REDIRECT_TEXT)

describe('typed-git redirect', () => {
  it('the first git status is redirected, with no card and no classifier call', async () => {
    const result = await run({ mode: 'auto', turns: [[shell('git status')]] })
    expect(result.approval).toBeUndefined()
    expect(result.classifyCalls).toBe(0)
    expect(result.toolMessages).toHaveLength(1)
    expect(redirected(result.toolMessages[0])).toBe(true)
    expect(result.toolMessages[0]).not.toContain('On branch')
    // The model answered in text next: the compliance flag is cleared, not counted.
    expect(result.conversation.git_redirect_pending).toBe(false)
  })

  it('the same text again takes the normal path; a different git text is redirected', async () => {
    const result = await run({
      mode: 'auto',
      turns: [[shell('git status')], [shell('git status')], [shell('git log -3')]],
    })
    expect(result.toolMessages.map(redirected)).toEqual([true, false, true])
    expect(result.classifyCalls).toBe(1)
    expect(result.toolMessages[1]).toContain('On branch')
  })

  it('a whitespace variant of a redirected command takes the normal path', async () => {
    const result = await run({
      mode: 'auto',
      turns: [[shell('git status')], [shell('  git   status ')]],
    })
    expect(result.toolMessages.map(redirected)).toEqual([true, false])
    expect(result.classifyCalls).toBe(1)
  })

  it('a new user message redirects the same text again', async () => {
    const manager = new ConversationManager()
    const first = await run({ mode: 'auto', turns: [[shell('git status')]], manager })
    expect(redirected(first.toolMessages[0])).toBe(true)
    const second = await run({ mode: 'auto', turns: [[shell('git status')]], manager })
    expect(redirected(second.toolMessages[0])).toBe(true)
  })

  it('a denied shell is redirected', async () => {
    const result = await run({
      mode: 'auto',
      turns: [[shell('git status')]],
      prepare: conversation => recordDenial(conversation, 'shell_exec', 'u1'),
    })
    expect(result.approval).toBeUndefined()
    expect(redirected(result.toolMessages[0])).toBe(true)
  })

  it('a non-git command is not redirected', async () => {
    const result = await run({ mode: 'auto', turns: [[shell('ls')]] })
    expect(result.classifyCalls).toBe(1)
    expect(redirected(result.toolMessages[0])).toBe(false)
  })

  describe('no redirect', () => {
    it('in manual', async () => {
      const result = await run({ mode: 'manual', turns: [[shell('git status')]] })
      expect(result.approval?.tool_name).toBe('shell_exec')
    })

    it('in allow_all', async () => {
      const result = await run({ mode: 'allow_all', turns: [[shell('git status')]] })
      expect(result.toolMessages[0]).toContain('On branch')
    })

    it('with a whole-tool shell grant (A1)', async () => {
      const result = await run({
        mode: 'auto',
        turns: [[shell('git status')]],
        prepare: conversation => {
          conversation.auto_shell_grants = { wholeTool: true, commands: new Set() }
        },
      })
      expect(result.toolMessages[0]).toContain('On branch')
      expect(result.classifyCalls).toBe(0)
    })

    it('with an exact command grant (A1)', async () => {
      const result = await run({
        mode: 'auto',
        turns: [[shell('git status')]],
        prepare: conversation => {
          conversation.auto_shell_grants = { wholeTool: false, commands: new Set(['git status']) }
        },
      })
      expect(result.toolMessages[0]).toContain('On branch')
    })

    it.each([
      ['tools.shell_exec true (A5 admin_forced)', { shell_exec: true }],
      ['tools.git_read true', { git_read: true }],
      ['tools.file_read true', { file_read: true }],
    ])('with %s', async (_label, tools) => {
      const result = await run({ mode: 'auto', turns: [[shell('git status')]], tools })
      expect(redirected(result.toolMessages[0])).toBe(false)
    })

    it('when git_read is not registered', async () => {
      registerGitRead = false
      appConfig.nativeTool.gitRead = undefined
      const result = await run({ mode: 'auto', turns: [[shell('git status')]] })
      expect(result.classifyCalls).toBe(1)
      expect(redirected(result.toolMessages[0])).toBe(false)
    })

    it('when git_read is denied', async () => {
      const result = await run({
        mode: 'auto',
        turns: [[shell('git status')]],
        prepare: conversation => recordDenial(conversation, 'git_read', 'u1'),
      })
      expect(redirected(result.toolMessages[0])).toBe(false)
    })

    it('when any guardrail rule is configured', async () => {
      const result = await run({
        mode: 'auto',
        turns: [[shell('git status')]],
        guardrails: {
          rules: [
            {
              id: 'allow-all',
              action: 'allow',
              match: { tool: { provenance: 'native', name: '*' } },
            },
          ],
        },
      })
      expect(redirected(result.toolMessages[0])).toBe(false)
    })

    it('when the admission inputs carry no approvalTools', async () => {
      const { conversation } = await run({ mode: 'auto', turns: [] })
      const gitReadStub = { requiresApproval: () => true }
      const config = {
        toolRegistry: {
          get: (name: string) => (name === 'git_read' ? gitReadStub : null),
          listDefinitions: () => [],
          register: () => {},
        },
        conversation,
        safety: {
          sanitizeOutput: (_name: string, content: string) => ({
            content,
            was_modified: false,
            warnings: [],
          }),
        },
        toolOutputProcessor: { beforeExecution: () => ({ is_valid: true, errors: [] }) },
        events: { emit: () => {} },
        loopController: {
          beforeTool: (_name: string, parameters: Record<string, unknown>, id: string) => ({
            type: 'suspend',
            cause: 'ordinary',
            approval: {
              request_id: `r-${id}`,
              tool_name: 'shell_exec',
              parameters,
              description: 'shell',
              tool_call_id: id,
              context_snapshot: [],
            },
          }),
        },
        approvalMode: {
          storedMode: () => 'auto',
          ceiling: () => 'allow_all',
          channelCap: () => 'allow_all',
          classifierAvailable: () => false,
          classify: async () => 'APPROVE',
        },
      } as unknown as LoopConfig
      expect((await admitToolCall(shell('git status', 'c1'), config, 0)).kind).toBe('suspend')
      // Control: the same inputs with approvalTools redirect.
      config.approvalMode!.approvalTools = () => undefined
      expect(await admitToolCall(shell('git status', 'c2'), config, 0)).toMatchObject({
        kind: 'result',
        report: true,
        toolResult: { content: GIT_REDIRECT_TEXT, is_error: false },
      })
    })

    it('liveApprovalTools never holds git_read', async () => {
      const result = await run({ mode: 'auto', turns: [] })
      const live = (
        result.executor as unknown as {
          liveApprovalTools(gfs: unknown): ReadonlySet<string> | undefined
        }
      ).liveApprovalTools({})
      expect(live === undefined || !live.has('git_read')).toBe(true)
      expect(live === undefined ? [] : [...live]).toEqual(['clerum__gfs_download'])
    })
  })
})
