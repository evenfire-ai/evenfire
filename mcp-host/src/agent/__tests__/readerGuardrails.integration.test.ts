/**
 * json_transform's `file` input through TaskExecutor: the Host's `file_read`
 * guardrail rules and CRD override apply to the file it reads, and its output
 * reaches the model sanitized. Real native registry, a temp workspace per test,
 * and a scripted model that makes one tool call and then answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as appConfig } from '../../config'
import type { ApprovalMode } from '../../core/approval/approvalMode'
import { ConversationManager } from '../../core/conversation/conversation'
import { pendingApprovalWireFields } from '../../core/conversation/pendingApprovalView'
import type { ApprovalConfig } from '../../core/extensions/approvalTypes'
import type { GuardrailRule, GuardrailsConfig } from '../../core/guardrails'
import type { ChatMessage, PendingApproval, ToolCall } from '../../core/types'
import { FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import { CronScheduler } from '../cronScheduler'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const PUB_WITNESS = 'PUB_WITNESS_51c9'
const SECRET_WITNESS = 'SECRET_WITNESS_0be2'

const saved = {
  enableApproval: appConfig.enableApproval,
  workspacePath: appConfig.nativeTool.workspacePath,
}
let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'reader-guardrails-'))
  mkdirSync(join(workspace, 'pub'))
  mkdirSync(join(workspace, 'secrets'))
  writeFileSync(join(workspace, 'pub', 'a.json'), JSON.stringify({ value: PUB_WITNESS }))
  writeFileSync(join(workspace, 'secrets', 'a.json'), JSON.stringify({ value: SECRET_WITNESS }))
  appConfig.enableApproval = true
  appConfig.nativeTool.workspacePath = workspace
})
afterEach(() => {
  appConfig.enableApproval = saved.enableApproval
  appConfig.nativeTool.workspacePath = saved.workspacePath
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
  await manager.getOrCreate(resolveTaskSessionKey(task), {
    userId: 'reader-user',
    channelType: 'rpc',
    approvalMode: options.mode,
  })
  const approvalConfig = policy('allow_all', options.tools)
  const seen: ChatMessage[][] = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'claude',
    classifyError: () => {
      throw new Error('fixture classification is unused')
    },
    completeSingleTurn: vi.fn(async () => {
      throw new Error('the classifier is not expected for json_transform')
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

const readFile = (file: string): ToolCall => ({
  id: `jt-${file.replace(/\W/g, '-')}`,
  name: 'json_transform',
  arguments: { file, operation: 'get', path: 'value' },
})
const readInput: ToolCall = {
  id: 'jt-input',
  name: 'json_transform',
  arguments: { input: JSON.stringify({ value: 'INPUT_WITNESS' }), operation: 'get', path: 'value' },
}

const allowNative: GuardrailRule = {
  id: 'allow-native',
  action: 'allow',
  match: { tool: { provenance: 'native', name: '*' } },
}
const fileReadRule = (id: string, action: GuardrailRule['action'], op: string, value: string) =>
  ({
    id,
    action,
    match: {
      tool: { provenance: 'native', name: 'file_read' },
      arguments: [{ type: 'path', pointer: '/path', op, value }],
    },
  }) satisfies GuardrailRule

describe('json_transform file reads follow file_read', () => {
  it('a file read runs and reaches the model wrapped as untrusted tool output', async () => {
    const ran = await run({ mode: 'manual', call: readFile('pub/a.json') })
    expect(ran.approval).toBeUndefined()
    expect(ran.completed).toBe(true)
    expect(ran.toolMessage).toContain(PUB_WITNESS)
    expect(ran.toolMessage).toMatch(/^<tool_output name="json_transform"/)
  })

  it('a file_read deny under secrets blocks json_transform on that file only', async () => {
    const guardrails = {
      rules: [allowNative, fileReadRule('deny-secrets', 'deny', 'under', 'secrets')],
    }
    const blocked = await run({ mode: 'manual', call: readFile('secrets/a.json'), guardrails })
    expect(blocked.approval).toBeUndefined()
    expect(blocked.toolMessage).toBe('Blocked by guardrail policy (rule:deny-secrets).')
    expect(blocked.toolMessage).not.toContain(SECRET_WITNESS)

    const ran = await run({ mode: 'manual', call: readFile('pub/a.json'), guardrails })
    expect(ran.toolMessage).toContain(PUB_WITNESS)

    // Control: without the file_read rule the same call reads the secret file.
    const control = await run({
      mode: 'manual',
      call: readFile('secrets/a.json'),
      guardrails: { rules: [allowNative] },
    })
    expect(control.toolMessage).toContain(SECRET_WITNESS)
  })

  it('an allowlist Host cards a file file_read is not allowed, as file_read would', async () => {
    const guardrails = {
      rules: [
        {
          id: 'allow-json',
          action: 'allow',
          match: { tool: { provenance: 'native', name: 'json_transform' } },
        } satisfies GuardrailRule,
        fileReadRule('allow-pub', 'allow', 'under', 'pub'),
      ],
    }
    const asked = await run({ mode: 'manual', call: readFile('secrets/a.json'), guardrails })
    expect(asked.approval).toMatchObject({
      tool_name: 'json_transform',
      authorization_scope: 'exact_invocation',
      description: 'Guardrail requires approval (unmatched_ask)',
    })
    expect(asked.toolMessage).toBeUndefined()

    const ran = await run({ mode: 'manual', call: readFile('pub/a.json'), guardrails })
    expect(ran.approval).toBeUndefined()
    expect(ran.toolMessage).toContain(PUB_WITNESS)
  })

  it('an ask on file_read cards a file read but not an input call', async () => {
    const guardrails = {
      rules: [
        {
          id: 'allow-json',
          action: 'allow',
          match: { tool: { provenance: 'native', name: 'json_transform' } },
        } satisfies GuardrailRule,
        {
          id: 'ask-file-read',
          action: 'ask',
          match: { tool: { provenance: 'native', name: 'file_read' } },
        } satisfies GuardrailRule,
      ],
    }
    const asked = await run({ mode: 'auto', call: readFile('pub/a.json'), guardrails })
    expect(asked.approval).toMatchObject({
      tool_name: 'json_transform',
      authorization_scope: 'exact_invocation',
      description: 'Guardrail requires approval (rule:ask-file-read)',
    })

    const ran = await run({ mode: 'auto', call: readInput, guardrails })
    expect(ran.approval).toBeUndefined()
    expect(ran.toolMessage).toContain('INPUT_WITNESS')
  })

  it('in allow-all a derived file_read ask is the X2 card, exact and without Always', async () => {
    const guardrails = { rules: [allowNative, fileReadRule('ask-pub', 'ask', 'under', 'pub')] }
    const asked = await run({ mode: 'allow_all', call: readFile('pub/a.json'), guardrails })
    expect(asked.approval).toMatchObject({
      tool_name: 'json_transform',
      authorization_scope: 'exact_invocation',
    })
    expect(pendingApprovalWireFields(asked.approval!).alwaysApproveAllowed).toBe(false)
    expect(asked.toolMessage).toBeUndefined()

    // Control: allow-all without the file_read rule runs the read.
    const ran = await run({
      mode: 'allow_all',
      call: readFile('pub/a.json'),
      guardrails: { rules: [allowNative] },
    })
    expect(ran.approval).toBeUndefined()
    expect(ran.toolMessage).toContain(PUB_WITNESS)
  })

  it.each(['manual', 'auto'] as const)(
    '%s: tools.file_read true cards a json_transform file read and leaves input calls alone',
    async mode => {
      const asked = await run({ mode, call: readFile('pub/a.json'), tools: { file_read: true } })
      expect(asked.approval?.tool_name).toBe('json_transform')
      expect(asked.toolMessage).toBeUndefined()

      const ran = await run({ mode, call: readInput, tools: { file_read: true } })
      expect(ran.approval).toBeUndefined()
      expect(ran.toolMessage).toContain('INPUT_WITNESS')
    }
  )

  it('tools.file_read false does not loosen json_transform true', async () => {
    const asked = await run({
      mode: 'manual',
      call: readFile('pub/a.json'),
      tools: { file_read: false, json_transform: true },
    })
    expect(asked.approval?.tool_name).toBe('json_transform')

    // Control: file_read false alone leaves json_transform card-free, as before.
    const ran = await run({
      mode: 'manual',
      call: readFile('pub/a.json'),
      tools: { file_read: false },
    })
    expect(ran.approval).toBeUndefined()
    expect(ran.toolMessage).toContain(PUB_WITNESS)
  })
})
