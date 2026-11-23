/**
 * git_read through TaskExecutor: cell A9, grant coverage and denials, the CRD
 * overrides it inherits, and the Host's file_read guardrail rules over the
 * files it reads. Real native registry with the probed git, a temp workspace
 * that is a git repository, and a scripted model that makes one call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as appConfig } from '../../config'
import type { ApprovalMode } from '../../core/approval/approvalMode'
import { ConversationManager } from '../../core/conversation/conversation'
import { recordDenial } from '../../core/conversation/denialPolicy'
import { pendingApprovalWireFields } from '../../core/conversation/pendingApprovalView'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import type { GuardrailRule, GuardrailsConfig } from '../../core/guardrails'
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
  appConfig.nativeTool.gitRead = probe
})
afterEach(() => {
  appConfig.enableApproval = saved.enableApproval
  appConfig.nativeTool.workspacePath = saved.workspacePath
  appConfig.nativeTool.gitRead = saved.gitRead
  rmSync(workspace, { recursive: true, force: true })
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
  completed: boolean
  /** The tool message the model saw on its second turn, if the call produced one. */
  toolMessage?: string
}

async function run(options: {
  mode: ApprovalMode
  call: ToolCall
  tools?: Record<string, boolean>
  guardrails?: GuardrailsConfig
  prepare?: (conversation: Conversation) => void
}): Promise<RunResult> {
  const manager = new ConversationManager()
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
      sender: 'reader-user',
      content: 'read the file',
      channelType: 'rpc',
      channelId: 'reader-channel',
      messageId: `msg-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      hostRef: 'reader-host',
    },
    conversationHistory: [{ role: 'user', content: 'read the file', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  const conversation = await manager.getOrCreate(resolveTaskSessionKey(task), {
    userId: 'reader-user',
    channelType: 'rpc',
    approvalMode: options.mode,
  })
  options.prepare?.(conversation)
  const approvalConfig = policy('allow_all', options.tools)
  const seen: ChatMessage[][] = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'claude',
    classifyError: () => {
      throw new Error('fixture classification is unused')
    },
    completeSingleTurn: vi.fn(async () => {
      throw new Error('the classifier is not expected for git_read')
    }),
    completeSingleTurnWithTools: vi.fn(async (messages: ChatMessage[]) => {
      seen.push(structuredClone(messages))
      const calls = seen.length === 1 ? [options.call] : null
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
  const second = seen[1] ?? []
  const toolMessage = second.find(m => m.role === 'tool')?.content
  return {
    approval: executor.pendingApproval,
    completed: executor.executorState === 'completed',
    ...(typeof toolMessage === 'string' ? { toolMessage } : {}),
  }
}

const gitRead = (args: Record<string, unknown>, id = 'gr-1'): ToolCall => ({
  id,
  name: 'git_read',
  arguments: args,
})
const shellCall: ToolCall = { id: 'sh-1', name: 'shell_exec', arguments: { command: 'ls' } }
const STATUS = gitRead({ subcommand: 'status', options: ['short'] })
const LOG_PUB = gitRead({ subcommand: 'log', options: ['patch'], paths: ['pub'] })

const allowNative: GuardrailRule = {
  id: 'allow-native',
  action: 'allow',
  match: { tool: { provenance: 'native', name: '*' } },
}
const allowTool = (name: string): GuardrailRule => ({
  id: `allow-${name}`,
  action: 'allow',
  match: { tool: { provenance: 'native', name } },
})
const fileReadRule = (id: string, action: GuardrailRule['action'], op: string, value: string) =>
  ({
    id,
    action,
    match: {
      tool: { provenance: 'native', name: 'file_read' },
      arguments: [{ type: 'path', pointer: '/path', op, value }],
    },
  }) satisfies GuardrailRule

describe('git_read admission', () => {
  it('auto runs git_read as A9 and the model sees wrapped output', async () => {
    const ran = await run({ mode: 'auto', call: LOG_PUB })
    expect(ran.approval).toBeUndefined()
    expect(ran.toolMessage).toMatch(/^<tool_output name="git_read"/)
    expect(ran.toolMessage).toContain(PUB_WITNESS)
  })

  it('manual cards git_read as M1; an always shell_exec grant runs it without a card', async () => {
    const asked = await run({ mode: 'manual', call: STATUS })
    expect(asked.approval).toMatchObject({ tool_name: 'git_read' })
    const ran = await run({
      mode: 'manual',
      call: STATUS,
      prepare: conversation => {
        // A task grant is cleared when this new task starts; the decision-table
        // rows cover task grants.
        conversation.auto_approved_tools.add('shell_exec')
      },
    })
    expect(ran.approval).toBeUndefined()
    expect(ran.toolMessage).toMatch(/^<tool_output name="git_read"/)
  })

  it('a shell Deny leaves git_read at A9 in auto', async () => {
    const denyShell = (conversation: Conversation) => recordDenial(conversation, 'shell_exec', 'u1')
    const shellAsked = await run({ mode: 'auto', call: shellCall, prepare: denyShell })
    expect(shellAsked.approval).toMatchObject({ tool_name: 'shell_exec', reask: 'denied' })
    const ran = await run({ mode: 'auto', call: LOG_PUB, prepare: denyShell })
    expect(ran.approval).toBeUndefined()
    expect(ran.toolMessage).toContain(PUB_WITNESS)
  })

  it('a git_read Deny re-asks git_read only', async () => {
    const denyGit = (conversation: Conversation) => recordDenial(conversation, 'git_read', 'u1')
    const asked = await run({ mode: 'auto', call: STATUS, prepare: denyGit })
    expect(asked.approval).toMatchObject({
      tool_name: 'git_read',
      reask: 'denied',
      authorization_scope: 'exact_invocation',
    })
    const other = await run({
      mode: 'auto',
      call: {
        id: 'jt',
        name: 'json_transform',
        arguments: { input: '{"a":1}', operation: 'keys' },
      },
      prepare: denyGit,
    })
    expect(other.approval).toBeUndefined()
  })

  it.each([
    [{ git_read: true }, true],
    [{ shell_exec: true }, true],
    [{ file_read: true }, true],
    [{ git_read: false, file_read: true }, true],
    [{ git_read: false }, false],
    [{ shell_exec: false }, false],
  ] as const)('auto with tools %j cards git_read: %s', async (tools, cards) => {
    const result = await run({ mode: 'auto', call: STATUS, tools: { ...tools } })
    expect(result.approval !== undefined).toBe(cards)
  })

  it('allow_all runs git_read as X1', async () => {
    const ran = await run({ mode: 'allow_all', call: STATUS })
    expect(ran.approval).toBeUndefined()
  })
})

describe('git_read reads follow file_read guardrail rules', () => {
  const denySecrets = {
    rules: [allowNative, fileReadRule('deny-secrets', 'deny', 'under', 'secrets')],
  }
  const BLOCKED = 'Blocked by guardrail policy (rule:deny-secrets).'

  it('a file_read deny blocks whole-workspace and REV:PATH reads; literal paths and names-only calls run', async () => {
    expect(
      (
        await run({
          mode: 'auto',
          call: gitRead({ subcommand: 'grep', pattern: 'WITNESS' }),
          guardrails: denySecrets,
        })
      ).toolMessage
    ).toBe(BLOCKED)
    expect(
      (
        await run({
          mode: 'auto',
          call: gitRead({ subcommand: 'show', revisions: ['HEAD:secrets/a.txt'] }),
          guardrails: denySecrets,
        })
      ).toolMessage
    ).toBe(BLOCKED)
    const pub = await run({ mode: 'auto', call: LOG_PUB, guardrails: denySecrets })
    expect(pub.toolMessage).toContain(PUB_WITNESS)
    const status = await run({
      mode: 'auto',
      call: gitRead({ subcommand: 'ls_files' }),
      guardrails: denySecrets,
    })
    expect(status.toolMessage).toContain('secrets/a.txt')
    expect(status.toolMessage).not.toContain(SECRET_WITNESS)

    // Control: without the file_read rule the grep reads the secret file.
    const control = await run({
      mode: 'auto',
      call: gitRead({ subcommand: 'grep', pattern: 'WITNESS' }),
      guardrails: { rules: [allowNative] },
    })
    expect(control.toolMessage).toContain(SECRET_WITNESS)
  })

  it('a rule on a path inside a declared directory applies (subtrees)', async () => {
    const guardrails = {
      rules: [allowNative, fileReadRule('deny-nested', 'deny', 'under', 'pub/secret')],
    }
    const blocked = await run({ mode: 'auto', call: LOG_PUB, guardrails })
    expect(blocked.toolMessage).toBe('Blocked by guardrail policy (rule:deny-nested).')
    // Control: the same call reads the nested file without the rule.
    const control = await run({ mode: 'auto', call: LOG_PUB, guardrails: { rules: [allowNative] } })
    expect(control.toolMessage).toContain(NESTED_WITNESS)
  })

  it('an allowlist Host asks for a read file_read is not allowed', async () => {
    const guardrails = {
      rules: [allowTool('git_read'), fileReadRule('allow-pub', 'allow', 'under', 'pub')],
    }
    const asked = await run({
      mode: 'auto',
      call: gitRead({ subcommand: 'log', options: ['patch'], paths: ['secrets'] }),
      guardrails,
    })
    expect(asked.approval).toMatchObject({
      tool_name: 'git_read',
      authorization_scope: 'exact_invocation',
      description: 'Guardrail requires approval (unmatched_ask)',
    })
    const ran = await run({
      mode: 'auto',
      call: gitRead({ subcommand: 'log', options: ['patch'], paths: ['pub/a.txt'] }),
      guardrails,
    })
    expect(ran.approval).toBeUndefined()
    expect(ran.toolMessage).toContain(PUB_WITNESS)
  })

  it('an ask on file_read cards a content call, not a names-only call', async () => {
    const guardrails = {
      rules: [
        allowTool('git_read'),
        allowTool('json_transform'),
        {
          id: 'ask-file-read',
          action: 'ask',
          match: { tool: { provenance: 'native', name: 'file_read' } },
        } satisfies GuardrailRule,
      ],
    }
    const asked = await run({ mode: 'auto', call: LOG_PUB, guardrails })
    expect(asked.approval).toMatchObject({
      tool_name: 'git_read',
      authorization_scope: 'exact_invocation',
      description: 'Guardrail requires approval (rule:ask-file-read)',
    })
    expect((await run({ mode: 'auto', call: STATUS, guardrails })).approval).toBeUndefined()
  })

  it('an outside rule blocks a whole-workspace call', async () => {
    const guardrails = {
      rules: [allowNative, fileReadRule('deny-outside-pub', 'deny', 'outside', 'pub')],
    }
    expect(
      (
        await run({
          mode: 'auto',
          call: gitRead({ subcommand: 'grep', pattern: 'WITNESS' }),
          guardrails,
        })
      ).toolMessage
    ).toBe('Blocked by guardrail policy (rule:deny-outside-pub).')
    expect(
      (
        await run({
          mode: 'auto',
          call: gitRead({ subcommand: 'log', options: ['patch'], paths: ['pub/a.txt'] }),
          guardrails,
        })
      ).toolMessage
    ).toContain(PUB_WITNESS)
  })

  it('in allow-all a derived file_read ask is the X2 card, exact and without Always', async () => {
    const guardrails = { rules: [allowNative, fileReadRule('ask-pub', 'ask', 'under', 'pub')] }
    const asked = await run({ mode: 'allow_all', call: LOG_PUB, guardrails })
    expect(asked.approval).toMatchObject({
      tool_name: 'git_read',
      authorization_scope: 'exact_invocation',
    })
    expect(pendingApprovalWireFields(asked.approval!).alwaysApproveAllowed).toBe(false)
    const ran = await run({
      mode: 'allow_all',
      call: LOG_PUB,
      guardrails: { rules: [allowNative] },
    })
    expect(ran.approval).toBeUndefined()
  })
})
