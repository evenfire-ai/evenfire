/**
 * A resolved folder reference reaches the model through the real TaskExecutor
 * as a `referenced_folder` line, also with the prompt cache off and no other
 * reference. Only the model is a double; the resolution is the real resolver's
 * answer to a captured gfsc `toView` envelope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGfsLocationReference } from '@clerum/gfs-interaction-policy'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { REFERENCED_FOLDERS_INSTRUCTION } from '../../core/orchestration/turnContext'
import { type ChatMessage, FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { McpManager } from '../../mcp/manager'
import type { Task } from '../../queue/types'
import {
  type LocationReferenceResolution,
  resolveMessageReferences,
} from '../fileReferenceResolver'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'
import views from './fixtures/gfsc-resolve-views.json'

const RID = '00000000000000000000000000000001'
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }

async function resolvedFolder(): Promise<LocationReferenceResolution[]> {
  const built = buildGfsLocationReference({
    drive: 'main',
    resourceId: RID,
    gfsUri: `gfs://main/${RID}`,
    name: 'Folder-1',
  })
  if (!built.ok) throw new Error(built.message)
  const resolved = await resolveMessageReferences([], [built.value], {
    resolve: async () => views.directory['1'],
  })
  if (!resolved.ok) throw new Error(`fixture resolution failed: ${resolved.failure}`)
  return resolved.locationResolutions
}

function lastUserText(messages: ChatMessage[]): string {
  const user = [...messages].reverse().find(message => message.role === 'user')
  if (!user) throw new Error('the provider received no user message')
  return user.content ?? ''
}

async function runTask(locationReferenceResolutions: LocationReferenceResolution[] | undefined) {
  const providerCalls: ChatMessage[][] = []
  const provider: SingleTurnProvider = {
    getProviderType: () => 'openai',
    classifyError: () => {
      throw new Error('Unexpected provider failure')
    },
    completeSingleTurn: async () => {
      throw new Error('Unexpected non-tool completion')
    },
    completeSingleTurnWithTools: async messages => {
      providerCalls.push(structuredClone(messages))
      return { content: 'done', tool_calls: null, usage, finish_reason: FinishReason.Stop }
    },
  }
  const task: Task = {
    id: `location-reference-${locationReferenceResolutions?.length ?? 0}`,
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'authenticated-user',
      content: 'Create a summary file here',
      channelType: 'rpc',
      channelId: 'isolated-channel',
      messageId: 'message-1',
      timestamp: new Date().toISOString(),
      hostRef: 'fixture-host',
      ...(locationReferenceResolutions
        ? {
            locationReferences: locationReferenceResolutions.map(
              resolution => resolution.reference
            ),
            locationReferenceResolutions,
          }
        : {}),
    },
    conversationHistory: [
      { role: 'user', content: 'Create a summary file here', timestamp: new Date() },
    ],
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
  return { deps, executor, providerCalls }
}

describe('referenced_folder lines through a complete task', () => {
  const saved = {
    enableApproval: appConfig.enableApproval,
    dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
    promptCacheEnabled: appConfig.promptCacheEnabled,
  }

  afterEach(() => {
    Object.assign(appConfig, saved)
  })

  it.each([false, true])(
    'T-H7: a folder-only message lists the folder with the prompt cache %s',
    async promptCacheEnabled => {
      Object.assign(appConfig, {
        enableApproval: false,
        dynamicToolsEnabled: false,
        promptCacheEnabled,
      })
      const resolutions = await resolvedFolder()
      const { deps, executor, providerCalls } = await runTask(resolutions)

      expect(deps.onFail).not.toHaveBeenCalled()
      expect(executor.executorState).toBe('completed')
      expect(providerCalls).toHaveLength(1)
      const text = lastUserText(providerCalls[0]!)
      expect(text.startsWith('<turn-context>')).toBe(true)
      expect(text).toContain(
        `referenced_folder: id="${resolutions[0]!.reference.id}" name="Folder-1" source=gfs drive="main" resourceId="${RID}" availability=available\n`
      )
      expect(text).toContain(REFERENCED_FOLDERS_INSTRUCTION)
      expect(text.endsWith('Create a summary file here')).toBe(true)
    }
  )

  it('adds no turn-context block with the prompt cache off and no folder', async () => {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled: false,
    })
    const { deps, executor, providerCalls } = await runTask(undefined)
    // Witness: the task ran and the model received the user's message.
    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    expect(lastUserText(providerCalls[0]!)).toBe('Create a summary file here')
  })
})
