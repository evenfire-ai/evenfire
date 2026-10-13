import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildGfsFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { bootstrapGfsRuntime } from '../../gfsRuntime'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import { resolveCallerRootBinding } from '../../workspace/callerRootBinding'
import { type IncomingAdmissionDeps, createIncomingAdmission } from '../incomingAdmission'
import { AgentStateMachine } from '../stateMachine'

vi.mock('../../config', () => ({
  config: {
    enableApproval: false,
    codexToolPresentation: 'direct',
    dynamicToolsEnabled: false,
    promptCacheEnabled: false,
    contextMaxTokens: 100_000,
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5_000,
      toolTimeout: 60_000,
      toolProgressInterval: 0,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1_048_576,
    },
  },
}))

vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
}))

function textTask(): Task {
  return {
    id: '11111111-1111-4111-8111-111111111112',
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'alice',
      content: 'ordinary text only',
      channelType: 'rpc',
      channelId: 'agent',
      messageId: 'message-1',
      timestamp: new Date().toISOString(),
      hostRef: 'host-1',
    },
    conversationHistory: [{ role: 'user', content: 'ordinary text only', timestamp: new Date() }],
    responseCallback: vi.fn(async () => undefined),
  }
}

describe('degraded GFS caller-root binding', () => {
  beforeEach(() => {
    vi.mocked(runToolUseLoop).mockResolvedValue({
      type: 'response',
      content: 'ordinary text completed',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
  })

  it('keeps ordinary text running while managed file/shell roots fail closed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-degraded-binding-'))
    try {
      // `users` as a file: the store starts, but no caller root can be bound.
      fs.writeFileSync(path.join(root, 'users'), 'not-a-directory', 'utf-8')
      const runtime = await bootstrapGfsRuntime(root)
      expect(runtime.store.isAvailable()).toBe(true)
      const queue = new MessageQueue()
      const lifecycle = new TaskLifecycle()
      const agent = new AgentStateMachine(queue, lifecycle, { autoStart: false, taskDelay: 0 })
      const provider = {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools: vi.fn(),
        getProviderType: () => 'openai' as const,
      }
      agent.setLLMProvider(provider as never)
      agent.setGfsWorkspaceProvider(runtime.workspaceProvider)
      agent.setGfsDownloadStore(runtime.store)

      const task = textTask()
      lifecycle.register(task)
      lifecycle.transition(task.id, 'processing', 'dispatched')
      vi.mocked(runToolUseLoop).mockImplementationOnce(async config => {
        expect(config.toolRegistry.get('file_read')).toBeNull()
        expect(config.toolRegistry.get('file_write')).toBeNull()
        const shell = await config.toolRegistry.get('shell_exec')!.execute({ command: 'pwd' })
        expect(shell.is_error).toBe(true)
        expect(shell.content).toContain('Managed shell unavailable')
        return {
          type: 'response',
          content: 'ordinary text completed',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }
      })
      await agent.executeTask(task)

      expect(runToolUseLoop).toHaveBeenCalledTimes(1)
      expect(task.responseCallback).toHaveBeenCalledWith(
        expect.objectContaining({ response: 'ordinary text completed' })
      )
      expect(fs.existsSync(path.join(root, 'host-root-write.txt'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps real incoming admission dispatching when the GFS caller root is degraded', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-degraded-admission-'))
    try {
      // `users` as a file: the store starts, but no caller root can be bound.
      fs.writeFileSync(path.join(root, 'users'), 'not-a-directory', 'utf-8')
      const runtime = await bootstrapGfsRuntime(root)
      expect(runtime.store.isAvailable()).toBe(true)
      const reference = buildGfsFileReference({
        drive: 'main',
        resourceId: 'a'.repeat(32),
        gfsUri: `gfs://main/${'a'.repeat(32)}`,
        version: 7,
        name: 'input.csv',
        byteLength: 10_240,
        classification: classifyBytes({
          bytes: Buffer.alloc(10_240),
          totalByteLength: 10_240,
          filename: 'input.csv',
          declaredMediaType: null,
        }),
      })
      if (!reference.ok) throw new Error(reference.message)
      const bindingRoots: unknown[] = []
      const dispatch = vi.fn(() => ({
        success: true,
        taskId: 'task-1',
        status: 'pending' as const,
      }))
      const deps: IncomingAdmissionDeps = {
        limits: { maxCount: 4, maxBytes: 1_000_000, maxFileBytes: 1_000_000 },
        queueReady: () => true,
        degradedReason: () => null,
        hostProvider: () => 'openai',
        getConversationByKey: async () => undefined,
        resolveTaskModel: () => null,
        resolveImageInput: () => undefined,
        applySessionModelSelection: vi.fn(),
        dispatch,
        fileReferenceGfs: () => ({ status: 'unsupported' }),
        gfsSurfaceRuntimeCapability: message => {
          const binding = resolveCallerRootBinding(runtime.workspaceProvider, message)
          bindingRoots.push(binding.root)
          const workspaceFile = Boolean(runtime.store.isAvailable() && binding.root)
          return { workspaceFile, localExecutor: workspaceFile, visual: false }
        },
        logger: { info: vi.fn(), warn: vi.fn() },
      }

      const admit = createIncomingAdmission(deps)
      const response = await admit({
        content: 'read referenced file',
        channelType: 'rpc',
        channelId: 'agent',
        sender: 'alice',
        timestamp: new Date().toISOString(),
        messageId: 'message-2',
        hostRef: 'host-1',
        fileReferences: [reference.value],
      })

      expect(response).toMatchObject({ success: true, taskId: 'task-1' })
      expect(dispatch).toHaveBeenCalledTimes(1)
      // Witness: admission asked for the caller root and the binding failed closed.
      expect(bindingRoots.length).toBeGreaterThan(0)
      expect(bindingRoots.every(bound => !bound)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
