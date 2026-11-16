/**
 * The live wiring of the memory write record above the tool registry.
 *
 * `nativeToolRegistry.memoryWriteLog.test.ts` starts at the registry
 * constructor. This suite covers the links above it: the state machine's
 * setter, the executor deps the state machine builds, and the registry the
 * executor builds. The `main.ts` call to the setter is outside a unit test's
 * reach (module globals) and is covered by the memory-notes Playwright lane.
 *
 * Boundary: the tool-use loop is mocked because it would otherwise call the
 * model. Inside the mock the test takes the registry from the loop config the
 * executor built and executes the real `memory_write` tool from it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolRegistry } from '../../core/interfaces'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { type ChatMessage, FinishReason, type ToolOutput } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import type { MemoryWriteEntry, MemoryWriteLog } from '../../workspace/memoryWriteLog'
import { ScopedWorkspaceProvider } from '../../workspace/scopedWorkspace'
import { AgentStateMachine } from '../stateMachine'

vi.mock('../../config', () => ({
  config: {
    devMode: true,
    enableApproval: false,
    enableNudge: false,
    nudgeMaxIterations: 3,
    devModelName: 'test-model',
    devModelProvider: 'openai',
    contextMaxTokens: 100000,
    tokenizerOffline: true,
    tokenizerDryrun: false,
    compactionStructuredSummary: false,
    promptCacheEnabled: false,
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5000,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1048576,
    },
  },
}))

vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
  extractInputPreview: vi.fn(() => ''),
  buildOutputPreview: vi.fn(() => undefined),
}))

/** sha256('rpc:user-42') cut to 16 hex characters, written out on purpose. */
const USER_KEY = '07cb72d3adff9442'

class CapturingLog implements MemoryWriteLog {
  readonly entries: MemoryWriteEntry[] = []
  async record(entry: MemoryWriteEntry): Promise<void> {
    this.entries.push(entry)
  }
}

function usage() {
  return { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
}

function stubProvider() {
  return {
    completeSingleTurn: vi.fn(async (_messages: ChatMessage[]) => ({
      content: 'ok',
      usage: usage(),
      finish_reason: FinishReason.Stop,
    })),
    completeSingleTurnWithTools: vi.fn(async (_messages: ChatMessage[], _tools: unknown[]) => ({
      content: 'ok',
      tool_calls: [],
      usage: usage(),
      finish_reason: FinishReason.Stop,
    })),
    getProviderType: () => 'openai',
  }
}

function memoryTask(): Task {
  return {
    id: `task-memory-${Math.random().toString(36).slice(2, 8)}`,
    source: 'channel',
    sourceMessage: {
      sender: 'user-42',
      content: 'remember this',
      channelType: 'rpc',
      channelId: 'chat-memory',
      messageId: 'msg-1',
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content: 'remember this', timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  } as unknown as Task
}

describe('memory_write record wiring through the state machine and the executor', () => {
  let tmpRoot: string
  let agent: AgentStateMachine

  beforeEach(async () => {
    vi.mocked(runToolUseLoop).mockReset()
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-wiring-'))
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    agent.setLLMProvider(stubProvider() as never, 'gpt-4o')
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)
    agent.setWorkspaceProvider(new ScopedWorkspaceProvider(tmpRoot))
    agent.start()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  /** Runs one task whose loop executes memory_write from the executor's registry. */
  async function writeThroughTask(): Promise<ToolOutput | undefined> {
    let output: ToolOutput | undefined
    vi.mocked(runToolUseLoop).mockImplementation(async config => {
      const registry = (config as unknown as { toolRegistry: ToolRegistry }).toolRegistry
      const tool = registry.get('memory_write')
      if (!tool) throw new Error('memory_write is not registered')
      output = await tool.execute({ content: 'zzwiring', target: 'notes.md' })
      return { type: 'response', content: 'ok', usage: usage() }
    })
    await agent.executeTask(memoryTask())
    return output
  }

  const noteFile = () => path.join(tmpRoot, 'users', USER_KEY, 'memory', 'notes.md')

  it('records the write of the task caller through the log set on the state machine', async () => {
    const log = new CapturingLog()
    agent.setMemoryWriteLog(log)

    const out = await writeThroughTask()

    expect(out?.is_error).toBe(false)
    // Witness: the write itself happened in the caller's folder.
    await expect(fs.readFile(noteFile(), 'utf-8')).resolves.toBe('zzwiring')
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]).toMatchObject({
      userKey: USER_KEY,
      scope: 'user',
      relativePath: 'memory/notes.md',
      mode: 'append',
    })
  })

  it('writes without a record when no log was set', async () => {
    const out = await writeThroughTask()

    expect(out?.is_error).toBe(false)
    expect(out?.content).toBe('Written to memory/notes.md (append)')
    await expect(fs.readFile(noteFile(), 'utf-8')).resolves.toBe('zzwiring')
  })
})
