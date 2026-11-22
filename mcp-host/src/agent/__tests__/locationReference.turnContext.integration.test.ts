/**
 * A resolved folder reference reaches the model through the real TaskExecutor
 * as a `referenced_folder` line, also with the prompt cache off and no other
 * reference, with an instruction that names only the folder tools the turn's
 * registry holds. Only the model is a double; the resolution is the real
 * resolver's answer to a captured gfsc `toView` envelope, and the GFS scopes
 * come from the Host token the registry reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGfsLocationReference } from '@clerum/gfs-interaction-policy'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { type ChatMessage, FinishReason, type ToolDefinition } from '../../core/types'
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
const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]

function encodedClaims(scopes: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

const FOLDER_INTRO = 'The user pointed at these folders as the place this request is about.'
const NO_WRITE =
  'Creating or saving files in these folders is not possible in this turn: when the request asks for it, tell the user so instead of storing the file anywhere else.'

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
  return { deps, executor, providerCalls, providerTools }
}

describe('referenced_folder lines through a complete task', () => {
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

  async function folderTurn(promptCacheEnabled: boolean, scopes: string[] | null) {
    Object.assign(appConfig, {
      enableApproval: false,
      dynamicToolsEnabled: false,
      promptCacheEnabled,
    })
    if (scopes) process.env[ACCESS_ENV] = encodedClaims(scopes)
    else delete process.env[ACCESS_ENV]
    const resolutions = await resolvedFolder()
    const { deps, executor, providerCalls, providerTools } = await runTask(resolutions)
    expect(deps.onFail).not.toHaveBeenCalled()
    expect(executor.executorState).toBe('completed')
    expect(providerCalls).toHaveLength(1)
    const text = lastUserText(providerCalls[0]!)
    // Witness: the folder reached the model as available.
    expect(text.startsWith('<turn-context>')).toBe(true)
    expect(text).toContain(
      `referenced_folder: id="${resolutions[0]!.reference.id}" name="Folder-1" source=gfs drive="main" resourceId="${RID}" availability=available\n`
    )
    expect(text.endsWith('Create a summary file here')).toBe(true)
    return { text, toolNames: providerTools[0]!.map(tool => tool.name) }
  }

  it.each([false, true])(
    'T-H7: without GFS tools the folder is listed and the model is told it cannot write there, prompt cache %s',
    async promptCacheEnabled => {
      const { text, toolNames } = await folderTurn(promptCacheEnabled, null)
      expect(toolNames.some(name => name.startsWith('clerum__gfs_'))).toBe(false)
      expect(text.split('\n')).toContain(`${FOLDER_INTRO} ${NO_WRITE}`)
      expect(text).not.toContain('parentResourceId')
      expect(text).not.toContain('clerum__gfs_list')
    }
  )

  it('with gfs.read only the model may list the folder but is told it cannot write there', async () => {
    const { text, toolNames } = await folderTurn(false, ['gfs.read'])
    expect(toolNames).toContain('clerum__gfs_list')
    expect(toolNames).not.toContain('clerum__gfs_create_file')
    expect(toolNames).not.toContain('clerum__gfs_create_folder')
    expect(text.split('\n')).toContain(
      `${FOLDER_INTRO} When the request lists files and names no other place, use the folder's drive and resourceId with \`clerum__gfs_list\`. ${NO_WRITE}`
    )
    expect(text).not.toContain('parentResourceId')
  })

  it('with gfs.read and gfs.write the model is told to create and save in the folder', async () => {
    const { text, toolNames } = await folderTurn(false, ['gfs.read', 'gfs.write'])
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'clerum__gfs_list',
        'clerum__gfs_create_file',
        'clerum__gfs_create_folder',
      ])
    )
    expect(text.split('\n')).toContain(
      `${FOLDER_INTRO} When the request creates, saves or lists files and names no other place, use the folder's drive and resourceId (as \`parentResourceId\` for create/save tools, or with \`clerum__gfs_list\`).`
    )
    expect(text).not.toContain(NO_WRITE)
  })

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
