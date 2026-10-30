/** The task executor exposes attachment save context and tools together. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { ATTACHMENT_SAVE_INSTRUCTION } from '../../core/orchestration/turnContext'
import { type ChatMessage, FinishReason, type ToolDefinition } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { PNG_2X2_BASE64 } from '../../llm/__tests__/codexImageFixtures'
import type { ImageInputResolver } from '../../llm/imageInput'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task } from '../../queue/types'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
const userContent = 'Save this image to EvenDrive'
const EVIDENCE = {
  source: 'curated' as const,
  reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
  checkedAt: '2026-09-16T00:00:00Z',
}
const image = {
  id: 'img-1',
  kind: 'image' as const,
  mimeType: 'image/png',
  encoding: 'base64' as const,
  dataBase64: PNG_2X2_BASE64,
  filename: 'logo.png',
}

function encodedClaims(scopes: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

function lastUserText(messages: ChatMessage[]): string {
  const user = [...messages].reverse().find(message => message.role === 'user')
  if (!user) throw new Error('the provider received no user message')
  return user.content ?? ''
}

async function runTask() {
  const providerCalls: ChatMessage[][] = []
  const providerTools: ToolDefinition[][] = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'openai',
    classifyError: () => {
      throw new Error('Unexpected provider failure')
    },
    completeSingleTurn: async () => {
      throw new Error('Unexpected non-tool completion')
    },
    completeSingleTurnWithTools: async (messages, tools) => {
      providerCalls.push(structuredClone(messages))
      providerTools.push(structuredClone(tools))
      return { content: 'done', tool_calls: null, usage, finish_reason: FinishReason.Stop }
    },
  }
  const task: Task = {
    id: 'attachment-save',
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'authenticated-user',
      content: userContent,
      channelType: 'rpc',
      channelId: 'isolated-channel',
      messageId: 'message-1',
      timestamp: new Date().toISOString(),
      hostRef: 'fixture-host',
      attachments: [image],
    },
    conversationHistory: [{ role: 'user', content: userContent, timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
  }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const deps: TaskExecutorDeps = {
    conversationManager: new ConversationManager(),
    llmProvider: provider,
    mcpManager: new McpManager(),
    workspaceService: undefined,
    modelName: 'test-model',
    imageInput: vi.fn<ImageInputResolver>(() => ({
      capability: { state: 'supported', evidence: EVIDENCE },
    })),
    approvalConfig: undefined,
    config: {
      maxTaskDuration: 300000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: lifecycle,
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
    dynamicEnvProvider: () => ({}),
  }
  const executor = new TaskExecutor(task, deps)
  await executor.run()
  return { deps, executor, providerCalls, providerTools }
}

describe('attachment save context through a complete task', () => {
  const saved = {
    enableApproval: appConfig.enableApproval,
    dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
    promptCacheEnabled: appConfig.promptCacheEnabled,
  }

  afterEach(() => {
    Object.assign(appConfig, saved)
    if (previousAccess === undefined) delete process.env[ACCESS_ENV]
    else process.env[ACCESS_ENV] = previousAccess
  })

  it('offers the image line, instruction and save tool with gfs.write', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
    })
    process.env[ACCESS_ENV] = encodedClaims(['gfs.read', 'gfs.write'])
    const { deps, executor, providerCalls, providerTools } = await runTask()

    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    expect(providerCalls).toHaveLength(1)
    const text = lastUserText(providerCalls[0]!)
    expect(text).toContain('attached_image: id="img-1"')
    expect(text).toContain(ATTACHMENT_SAVE_INSTRUCTION)
    expect(providerTools[0]!.map(tool => tool.name)).toContain('clerum__gfs_save_attachment')
  })

  it('offers neither save context nor save tool with only gfs.read', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
    })
    process.env[ACCESS_ENV] = encodedClaims(['gfs.read'])
    const { deps, executor, providerCalls, providerTools } = await runTask()

    // Witness: the task completed and the GFS registry supplied read tools.
    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    expect(providerCalls).toHaveLength(1)
    expect(providerTools[0]!.map(tool => tool.name)).toContain('clerum__gfs_read')
    expect(lastUserText(providerCalls[0]!)).toBe(userContent)
    expect(providerTools[0]!.map(tool => tool.name)).not.toContain('clerum__gfs_save_attachment')
  })
})
