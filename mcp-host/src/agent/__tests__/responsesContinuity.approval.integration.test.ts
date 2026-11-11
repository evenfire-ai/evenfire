/**
 * T-P3: Responses continuity across an approval suspension. The official
 * driver decodes a recorded reasoning + function_call turn, the real loop
 * suspends on the MCP call, the snapshot is persisted to a temporary SQLite
 * database and reconstructed from it, and the resumed request is captured at
 * `responses.create`. Only the SDK boundary and the MCP transport are doubled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { SqliteConversationStore } from '../../core/conversation/persistence/sqliteConversationStore'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import {
  RESPONSES_MODEL,
  type RecordedItem,
  recordedResponse,
} from '../../llm/openaiFamily/__tests__/responsesFixtures'
import { makeProvider } from '../../llm/registry'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'
import { TaskExecutor, type TaskExecutorDeps, resolveTaskSessionKey } from '../taskExecutor'

const FIXTURE = 'v1-rfc-gpt-6.1-terra'
// The recorded call names a bare `get_weather`; the per-tool override gates it.
const APPROVAL = {
  defaultPolicy: 'channel_users' as const,
  channels: {},
  tools: { get_weather: true },
}

const savedConfig = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}
const handles: StoreHandle[] = []

beforeEach(() => {
  Object.assign(appConfig, {
    enableApproval: true,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
  })
})

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown()
  Object.assign(appConfig, savedConfig)
})

/** An official driver built by the real factory, answering recorded responses in order. */
function officialDriver(fixtures: string[]) {
  const driver = makeProvider('openai', { 'openai-api-key': 'unit-key' }, RESPONSES_MODEL)
  const queue = [...fixtures]
  const create = vi.fn(async (_payload: { input: RecordedItem[] }) => {
    const next = queue.shift()
    if (!next) throw new Error('no more recorded responses')
    return recordedResponse(next)
  })
  ;(driver as unknown as { client: unknown }).client = {
    baseURL: 'https://api.openai.com/v1',
    responses: { create },
    chat: { completions: { create: vi.fn() } },
  }
  return { driver, create }
}

/** The MCP transport: one server exposing the tool the recorded turn calls. */
function weatherServer() {
  const callTool = vi.fn(async (name: string) => ({
    toolName: name,
    result: { content: [{ type: 'text', text: '18C, cloudy' }] },
    isError: false,
  }))
  const manager = {
    getAllTools: () => [
      {
        name: 'get_weather',
        description: 'Current weather for a city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
        serverName: 'weather',
      },
    ],
    callTool,
    bootstrapUserCatalog: vi.fn(async () => ({
      candidates: 0,
      probed: 0,
      admitted: 0,
      pending: 0,
      skipped: {},
      waitedMs: 0,
      timedOut: false,
    })),
  }
  return { manager, callTool }
}

function task(): Task {
  return {
    id: `responses-approval-${Math.random().toString(36).slice(2, 8)}`,
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'user-1',
      content: 'Which city, and its weather?',
      channelType: 'rpc',
      channelId: 'responses-approval',
      messageId: 'responses-approval-message',
      timestamp: new Date().toISOString(),
      hostRef: 'unit-host',
    },
    conversationHistory: [
      { role: 'user', content: 'Which city, and its weather?', timestamp: new Date() },
    ],
    responseCallback: vi.fn(async () => undefined),
  }
}

/** The replayed assistant turn of a request: neither user/system text nor a tool output. */
function assistantItems(input: RecordedItem[]): RecordedItem[] {
  return input.filter(
    i =>
      i.type !== 'function_call_output' &&
      !(i.type === 'message' && (i.role === 'user' || i.role === 'system'))
  )
}

const shapeOf = (items: RecordedItem[]) => items.map(i => ({ type: i.type, id: i.id }))

/** Suspends a task on the recorded turn's MCP call, persisting to a temporary SQLite store. */
async function suspended() {
  const handle = makeSqliteStore()
  handles.push(handle)
  const primary = officialDriver([FIXTURE, 'v1-text-gpt-6.1-terra'])
  const mcp = weatherServer()
  const t = task()
  const lifecycle = new TaskLifecycle()
  lifecycle.register(t)
  const deps: TaskExecutorDeps = {
    conversationManager: new ConversationManager(handle.store),
    llmProvider: primary.driver,
    mcpManager: mcp.manager as never,
    workspaceService: undefined,
    modelName: RESPONSES_MODEL,
    approvalConfig: APPROVAL,
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
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
  }
  const executor = new TaskExecutor(t, deps)
  await executor.run()
  expect(executor.executorState).toBe('waiting_approval')
  expect(executor.pendingApproval?.tool_call_id).toBe('call_fixture0005')
  expect(primary.create).toHaveBeenCalledTimes(1)
  expect(mcp.callTool).not.toHaveBeenCalled()
  return { handle, primary, mcp, task: t, deps, sessionKey: resolveTaskSessionKey(t) }
}

/** Resumes the suspended task from a conversation rebuilt out of SQLite. */
async function resumeFromSqlite(
  s: Awaited<ReturnType<typeof suspended>>,
  llmProvider: TaskExecutorDeps['llmProvider']
) {
  const manager = new ConversationManager(
    new SqliteConversationStore(s.handle.persistQueue, { cacheSize: 8 })
  )
  const rebuilt = await manager.getOrCreate(s.sessionKey)
  expect(rebuilt.pending_approval?.tool_call_id).toBe('call_fixture0005')
  const resumed = new TaskExecutor(s.task, { ...s.deps, conversationManager: manager, llmProvider })
  await resumed.rehydrateWaitingApproval(s.sessionKey, rebuilt.pending_approval!)
  await resumed.resumeAfterApproval(false)
  expect(s.deps.onFail).not.toHaveBeenCalled()
  expect(resumed.executorState).toBe('completed')
  expect(s.mcp.callTool).toHaveBeenCalledTimes(1)
}

describe('T-P3 continuity survives an approval persisted to SQLite', () => {
  it('a resume with the same driver instance replays the reasoning in layout order with its ids', async () => {
    const s = await suspended()

    await resumeFromSqlite(s, s.primary.driver)

    expect(s.primary.create).toHaveBeenCalledTimes(2)
    const replayed = assistantItems(s.primary.create.mock.calls[1]![0].input)
    expect(shapeOf(replayed)).toEqual(shapeOf(recordedResponse(FIXTURE).output))
    expect(replayed[0]!.encrypted_content).toBe(
      recordedResponse(FIXTURE).output[0]!.encrypted_content
    )
    expect(s.primary.create.mock.calls[1]![0].input).toContainEqual(
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_fixture0005' })
    )
  })

  it('a cold resume with a new driver instance replays no reasoning and no item ids', async () => {
    const s = await suspended()
    const coldDriver = officialDriver(['v1-text-gpt-6.1-terra'])

    await resumeFromSqlite(s, coldDriver.driver)

    expect(s.primary.create).toHaveBeenCalledTimes(1)
    expect(coldDriver.create).toHaveBeenCalledTimes(1)
    const replayed = assistantItems(coldDriver.create.mock.calls[0]![0].input)
    expect(replayed.map(i => i.type)).toEqual(['function_call'])
    expect(replayed.some(i => i.id !== undefined)).toBe(false)
    expect(replayed[0]).toMatchObject({ call_id: 'call_fixture0005', name: 'get_weather' })
  })
})

describe('T-P3 (R-36) a credential reload during the suspension', () => {
  it('the agent resumes the suspended task with its original driver instance and replays', async () => {
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    const agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    const original = officialDriver([FIXTURE, 'v1-text-gpt-6.1-terra'])
    const reloaded = officialDriver(['v1-text-gpt-6.1-terra'])
    const mcp = weatherServer()
    agent.setLLMProvider(original.driver, RESPONSES_MODEL)
    agent.setMcpManager(mcp.manager as never)
    agent.setApprovalConfig(APPROVAL)
    agent.start()
    const t = task()

    await agent.executeTask(t)
    expect(agent.getState()).toBe('waiting_approval')
    const [pending] = agent.getPendingApprovals()
    expect(pending).toMatchObject({ toolName: 'get_weather', parameters: { city: 'Lima' } })
    expect(original.create).toHaveBeenCalledTimes(1)

    // A rotated key rebuilds the Host provider while the approval waits.
    agent.setLLMProvider(reloaded.driver, RESPONSES_MODEL)
    const decision = await agent.handleApproval(
      'user-1',
      pending!.requestId,
      false,
      'rpc',
      'responses-approval'
    )
    expect(decision.success).toBe(true)
    await vi.waitFor(() => expect(original.create).toHaveBeenCalledTimes(2))

    expect(reloaded.create).not.toHaveBeenCalled()
    const replayed = assistantItems(original.create.mock.calls[1]![0].input)
    expect(shapeOf(replayed)).toEqual(shapeOf(recordedResponse(FIXTURE).output))
    agent.stop()
  })
})
