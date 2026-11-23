import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ChildProcess } from 'child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronScheduler } from '../../../agent/cronScheduler'
import {
  TaskExecutor,
  type TaskExecutorDeps,
  resolveTaskSessionKey,
} from '../../../agent/taskExecutor'
import { config as appConfig } from '../../../config'
import { TaskLifecycle } from '../../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../../llm/types'
import { MessageQueue } from '../../../queue/messageQueue'
import type { Task, TaskError } from '../../../queue/types'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { ConversationManager } from '../../conversation/conversation'
import { LlmErrorCode } from '../../errors'
import { UnifiedApprovalGateController } from '../../extensions/mcpApprovalGateController'
import type { Tool, ToolRegistry } from '../../interfaces'
import { SimpleEventEmitter } from '../../orchestration/eventEmitter'
import { buildLoopConfig } from '../../orchestration/loopConfig'
import { admitToolCall, executeAdmittedTool } from '../../orchestration/toolCallPolicy'
import { BasicSafety } from '../../safety/safety'
import { type ChatMessage, FinishReason, type ToolCall } from '../../types'
import { ShellTool } from '../shell'

// Never starts a process. A real spawn here would run the blocked commands.
const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: spawnMock as typeof actual.spawn }
})

const BLOCKED_MESSAGE =
  'Command blocked: it matches an obvious destructive shell pattern and was not run.'

const BLOCKED = [
  'rm -rf /',
  'rm -rf /*',
  'rm -fr /',
  'rm -r -f /',
  'rm --no-preserve-root -rf /',
  'rm -rf /; ls',
  'ls && rm -rf /*&& ls',
  'rm -rf \\\n/',
  'dd if=/dev/zero \\\nof=/dev/sda',
  ':(){ :|:& };:',
  'dd if=/dev/zero of=/dev/sda',
  'echo x > /dev/nvme0n1',
] as const

const RUNS = [
  'ls',
  'rm -rf ./build',
  'rm -rf /tmp/x',
  'dd if=a of=b.img',
  'dd if=a of=/dev/null',
  'echo x > /dev/stderr',
] as const

// sh removes a backslash-newline before it splits words, so each of these is
// the joined command on the right.
const BLOCKED_JOINED_LINES = [
  ['rm flags split mid-token (rm -rf /*)', 'rm -r\\\nf /*'],
  ['rm command word split (rm -rf /)', 'r\\\nm -rf /'],
  ['rm root operand split (rm -rf /*)', 'rm -rf /\\\n*'],
  ['dd command word split (dd ... of=/dev/sda)', 'd\\\nd if=/dev/zero of=/dev/sda'],
  ['dd of= split mid-token (of=/dev/sda)', 'dd if=/dev/zero o\\\nf=/dev/sda'],
  ['dd device path split mid-token (of=/dev/sda)', 'dd if=/dev/zero of=/dev/s\\\nda'],
  ['redirect device path split mid-token (> /dev/sda)', 'echo x > /dev/s\\\nda'],
  ['fork bomb split mid-token', ':(\\\n){ :|:& };:'],
  // sh keeps the CR and ends the command here. The joined text still matches,
  // and either match blocks.
  ['rm flags split by backslash-CRLF', 'rm -r\\\r\nf /*'],
] as const

// sh does not join these lines. A `#` comment ends at the newline even when
// its last character is a backslash, and `\<CR><LF>` escapes the CR, so the LF
// still ends the command. Line 2 runs as its own command.
const BLOCKED_UNJOINED_LINES = [
  ['rm after a comment ending in a backslash', 'ls # list\\\nrm -rf /'],
  ['dd after a comment ending in a backslash', 'ls # list\\\ndd if=/dev/zero of=/dev/sda'],
  ['device redirect after a comment ending in a backslash', 'ls # list\\\necho y > /dev/sda'],
  ['fork bomb after a comment ending in a backslash', 'ls # list\\\n:(){ :|:& };:'],
  ['rm after backslash-CRLF', 'echo x\\\r\nrm -rf /'],
  ['dd after backslash-CRLF', 'echo x\\\r\ndd if=/dev/zero of=/dev/sda'],
  ['device redirect after backslash-CRLF', 'echo x\\\r\necho y > /dev/sda'],
  ['fork bomb after backslash-CRLF', 'echo x\\\r\n:(){ :|:& };:'],
] as const

// sh joins some lines and not others here. Line 1 ends as in
// BLOCKED_UNJOINED_LINES, then lines 2 and 3 run as one command, so the operand
// on line 3 belongs to the command on line 2. Line 1's last word touches the
// backslash, so joining every line glues it to that command word.
const BLOCKED_MIXED_LINES = [
  ['rm with its root operand on a continuation after a comment line', 'ls # list\\\nrm -rf \\\n/'],
  [
    'dd with its device target on a continuation after a comment line',
    'ls # list\\\ndd if=/dev/zero \\\nof=/dev/sda',
  ],
  ['rm with its root operand on a continuation after backslash-CRLF', 'echo x\\\r\nrm -rf \\\n/'],
  // A `#` inside a word starts no comment, so sh joins the rm line.
  [
    'rm with a # inside an argument and its root operand on a continuation after a comment line',
    'ls # list\\\nrm -rf tmp#1 \\\n/',
  ],
  [
    'dd with a # inside an argument and its device target on a continuation after backslash-CRLF',
    'echo x\\\r\ndd if=/dev/zero bs=1#x \\\nof=/dev/sda',
  ],
] as const

const RUNS_JOINED_LINES = [
  // sh reads `rm -rf /tmp/x`, not `/` and `tmp/x`.
  ['rm operand split mid-token (rm -rf /tmp/x)', 'rm -rf /\\\ntmp/x'],
  // A bare newline ends the command: sh runs `rm -r`, then `f /*`.
  ['rm flags split by a bare newline', 'rm -r\nf /*'],
  ['a benign line after a comment ending in a backslash', 'ls # list\\\nls -la'],
  ['a benign line after backslash-CRLF', 'echo x\\\r\nls -la'],
] as const

// The benign twins of BLOCKED_MIXED_LINES. sh runs `rm -rf /tmp/x` and
// `dd if=/dev/sda of=disk.img` on lines 2 and 3.
const RUNS_MIXED_LINES = [
  [
    'rm with a /tmp/x operand split mid-token after a comment line',
    'ls # list\\\nrm -rf /\\\ntmp/x',
  ],
  [
    'dd reading a disk into an image file after a comment line',
    'ls # list\\\ndd if=/dev/sda \\\nof=disk.img',
  ],
  [
    'rm with a /tmp/x operand split mid-token after backslash-CRLF',
    'echo x\\\r\nrm -rf /\\\ntmp/x',
  ],
  // The # twin: sh runs `rm -rf tmp#1 /tmp/x`.
  [
    'rm with a # inside an argument and a /tmp/x operand split mid-token after a comment line',
    'ls # list\\\nrm -rf tmp#1 /\\\ntmp/x',
  ],
] as const

function fakeChild(): ChildProcess {
  const emitter = new EventEmitter()
  const stdout = new EventEmitter() as NonNullable<ChildProcess['stdout']>
  const stderr = new EventEmitter() as NonNullable<ChildProcess['stderr']>
  stdout.destroy = () => stdout
  stderr.destroy = () => stderr
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    pid: undefined as number | undefined,
    kill: () => {
      child.killed = true
      return true
    },
  })
  setImmediate(() => {
    child.exitCode = 0
    emitter.emit('exit', 0, null)
    emitter.emit('close', 0, null)
  })
  return child as ChildProcess
}

spawnMock.mockImplementation(() => fakeChild())

let workspacePath: string
const saved = {
  enableApproval: appConfig.enableApproval,
  statelessLifecycle: appConfig.statelessLifecycle,
  nativeStateless: appConfig.nativeTool.statelessLifecycle,
  shellTimeout: appConfig.nativeTool.shellTimeout,
  toolTimeout: appConfig.nativeTool.toolTimeout,
}

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'clerum-shell-ux-'))
  spawnMock.mockClear()
  spawnMock.mockImplementation(() => fakeChild())
  appConfig.enableApproval = true
  appConfig.statelessLifecycle = false
  appConfig.nativeTool.statelessLifecycle = false
  appConfig.nativeTool.shellTimeout = 5_000
  appConfig.nativeTool.toolTimeout = 5_000
})

afterEach(async () => {
  appConfig.enableApproval = saved.enableApproval
  appConfig.statelessLifecycle = saved.statelessLifecycle
  appConfig.nativeTool.statelessLifecycle = saved.nativeStateless
  appConfig.nativeTool.shellTimeout = saved.shellTimeout
  appConfig.nativeTool.toolTimeout = saved.toolTimeout
  await rm(workspacePath, { recursive: true, force: true })
})

function shellSpawnCount(): number {
  return spawnMock.mock.calls.filter(call => {
    const args = call[1]
    return Array.isArray(args) && args[0] === '-c'
  }).length
}

function registryWith(tool: Tool): ToolRegistry {
  return {
    get: name => (name === tool.name() ? tool : null),
    listDefinitions: () => [
      { name: tool.name(), description: tool.description(), parameters: tool.parametersSchema() },
    ],
    register: vi.fn(),
  }
}

async function runAdmitted(command: string) {
  const registry = registryWith(new ShellTool(workspacePath, 5_000, ['PATH']))
  const config = buildLoopConfig({
    reasoning: {
      respondWithTools: vi.fn(),
      continueWithToolResults: vi.fn(),
    },
    toolRegistry: registry,
    safety: new BasicSafety(),
    events: new SimpleEventEmitter(),
    conversation: makeFakeConversation({ approval_mode: 'allow_all' }),
    loopController: new UnifiedApprovalGateController(registry),
  })
  config.approvalMode = {
    storedMode: () => 'allow_all',
    ceiling: () => 'allow_all',
    channelCap: () => 'allow_all',
    classifierAvailable: () => false,
    classify: async () => 'ESCALATE',
  }
  const call: ToolCall = { id: 'ux-allow-all', name: 'shell_exec', arguments: { command } }
  const admission = await admitToolCall(call, config, 0)
  expect(admission.kind).toBe('execute')
  if (admission.kind !== 'execute') throw new Error('allow-all did not admit shell_exec')
  return executeAdmittedTool(admission, config, 0)
}

function messageText(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

interface TaskRun {
  executor: TaskExecutor
  toolText: () => string
  failed?: TaskError
}

async function runShellTask(command: string, cron: boolean): Promise<TaskRun> {
  if (cron) {
    appConfig.statelessLifecycle = true
    appConfig.nativeTool.statelessLifecycle = true
  }
  const manager = new ConversationManager()
  const lifecycle = new TaskLifecycle()
  const scheduler = new CronScheduler(new MessageQueue(), {
    statelessLifecycle: cron,
    allowEnabledJobs: true,
  })
  const task: Task = {
    id: `ux-${cron ? 'cron' : 'resume'}-${Math.random().toString(36).slice(2)}`,
    source: cron ? 'cron' : 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'ux-user',
      content: 'run the command',
      channelType: 'rpc',
      channelId: 'ux-channel',
      messageId: 'ux-message',
      timestamp: new Date().toISOString(),
      hostRef: 'ux-host',
    },
    conversationHistory: [{ role: 'user', content: 'run the command', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
  await manager.getOrCreate(resolveTaskSessionKey(task), {
    userId: 'ux-user',
    channelType: 'rpc',
    approvalMode: 'manual',
  })
  const seen: ChatMessage[][] = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'claude',
    classifyError: () => ({
      code: LlmErrorCode.ApiCallFailed,
      message: 'unused',
      retryable: false,
    }),
    completeSingleTurn: vi.fn(async () => ({
      content: 'done',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: FinishReason.Stop,
    })),
    completeSingleTurnWithTools: vi.fn(async (messages: ChatMessage[]) => {
      seen.push(structuredClone(messages))
      const call =
        seen.length === 1 ? [{ id: 'ux-shell', name: 'shell_exec', arguments: { command } }] : null
      return {
        content: call ? null : 'done',
        tool_calls: call,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
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
    modelName: 'claude-test',
    approvalConfig: {
      defaultPolicy: 'channel_users',
      modeCeiling: 'manual',
      channels: {},
    },
    approvalConfigProvider: () => ({
      effective: {
        defaultPolicy: 'channel_users',
        modeCeiling: 'manual',
        channels: {},
      },
      hostSpec: {
        defaultPolicy: 'channel_users',
        modeCeiling: 'manual',
        channels: {},
      },
    }),
    coreEvents: new SimpleEventEmitter(),
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
  }
  const executor = new TaskExecutor(task, deps)
  try {
    await executor.run()
    return {
      executor,
      toolText: () =>
        seen
          .flat()
          .filter(message => message.role === 'tool')
          .map(messageText)
          .join('\n'),
      failed: onFail.mock.calls[0]?.[1] as TaskError | undefined,
    }
  } finally {
    scheduler.stop()
  }
}

describe('ShellTool.execute', () => {
  it.each(BLOCKED)('blocks %s before spawn', async command => {
    const result = await new ShellTool(workspacePath, 5_000, ['PATH']).execute({ command })

    expect(result.is_error).toBe(true)
    expect(result.content).toBe(BLOCKED_MESSAGE)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(RUNS)('runs %s', async command => {
    const result = await new ShellTool(workspacePath, 5_000, ['PATH']).execute({ command })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['-c', command])
    expect(result.is_error).toBe(false)
  })

  it.each(BLOCKED_JOINED_LINES)('blocks %s before spawn', async (_label, command) => {
    const result = await new ShellTool(workspacePath, 5_000, ['PATH']).execute({ command })

    expect(result.is_error).toBe(true)
    expect(result.content).toBe(BLOCKED_MESSAGE)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(BLOCKED_UNJOINED_LINES)('blocks %s before spawn', async (_label, command) => {
    const result = await new ShellTool(workspacePath, 5_000, ['PATH']).execute({ command })

    expect(result.is_error).toBe(true)
    expect(result.content).toBe(BLOCKED_MESSAGE)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(RUNS_JOINED_LINES)('runs %s', async (_label, command) => {
    const result = await new ShellTool(workspacePath, 5_000, ['PATH']).execute({ command })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['-c', command])
    expect(result.is_error).toBe(false)
  })

  it.each(BLOCKED_MIXED_LINES)('blocks %s before spawn', async (_label, command) => {
    const result = await new ShellTool(workspacePath, 5_000, ['PATH']).execute({ command })

    expect(result.is_error).toBe(true)
    expect(result.content).toBe(BLOCKED_MESSAGE)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(RUNS_MIXED_LINES)('runs %s', async (_label, command) => {
    const result = await new ShellTool(workspacePath, 5_000, ['PATH']).execute({ command })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['-c', command])
    expect(result.is_error).toBe(false)
  })

  // The guard runs on the Host event loop. A check that rescans to the end of
  // the segment for every `rm`/`dd` start is quadratic: about 150 KB took
  // seconds and stalled every session on the Host.
  it.each([
    ['rm', 'rm '.repeat(50_000)],
    ['dd', 'dd '.repeat(50_000)],
    // The joined and raw text differ, so all three passes run. The third keeps
    // every line unjoined.
    ['rm backslash-CRLF', 'rm \\\r\n'.repeat(25_000)],
    // All three passes run, and the third joins every line.
    ['rm backslash-LF', 'rm \\\n'.repeat(30_000)],
    // All three passes run, and the third joins every other line.
    ['comment line and rm backslash-LF', '# c\\\nrm \\\n'.repeat(15_000)],
  ])('checks a 150 KB repeated %s command in linear time', async (_word, command) => {
    const started = performance.now()
    const result = await new ShellTool(workspacePath, 5_000, ['PATH']).execute({ command })
    const elapsedMs = performance.now() - started

    expect(result.content).not.toBe(BLOCKED_MESSAGE)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(elapsedMs).toBeLessThan(500)
  })
})

describe('executeAdmittedTool in allow-all', () => {
  it.each(BLOCKED)('blocks %s before spawn', async command => {
    const result = await runAdmitted(command)

    expect(result.is_error).toBe(true)
    expect(result.content).toContain(BLOCKED_MESSAGE)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(RUNS)('runs %s', async command => {
    const result = await runAdmitted(command)

    expect(shellSpawnCount()).toBe(1)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(result.is_error).toBe(false)
  })
})

describe('resumeAfterApproval', () => {
  it.each(BLOCKED)('blocks %s before spawn', async command => {
    const suspended = await runShellTask(command, false)
    expect(suspended.failed).toBeUndefined()
    expect(suspended.executor.executorState).toBe('waiting_approval')
    expect(spawnMock).not.toHaveBeenCalled()

    await suspended.executor.resumeAfterApproval(false, 'ux-user')

    expect(suspended.executor.executorState).toBe('completed')
    expect(suspended.toolText()).toContain(BLOCKED_MESSAGE)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(RUNS)('runs %s once', async command => {
    const suspended = await runShellTask(command, false)
    expect(suspended.executor.executorState).toBe('waiting_approval')
    expect(spawnMock).not.toHaveBeenCalled()

    await suspended.executor.resumeAfterApproval(false, 'ux-user')

    expect(suspended.executor.executorState).toBe('completed')
    expect(shellSpawnCount()).toBe(1)
  })
})

describe('cron-sourced shell_exec', () => {
  it.each(BLOCKED)('blocks %s before spawn', async command => {
    const ran = await runShellTask(command, true)

    expect(ran.failed).toBeUndefined()
    expect(ran.executor.executorState).toBe('completed')
    expect(ran.executor.pendingApproval).toBeUndefined()
    expect(ran.toolText()).toContain(BLOCKED_MESSAGE)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each(RUNS)('runs %s once', async command => {
    const ran = await runShellTask(command, true)

    expect(ran.failed).toBeUndefined()
    expect(ran.executor.executorState).toBe('completed')
    expect(shellSpawnCount()).toBe(1)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})
