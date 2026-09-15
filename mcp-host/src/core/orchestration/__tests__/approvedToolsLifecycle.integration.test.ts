import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskExecutor, type TaskExecutorDeps } from '../../../agent/taskExecutor'
import { config as appConfig } from '../../../config'
import { TaskLifecycle } from '../../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../../llm/types'
import { McpManager } from '../../../mcp/manager'
import type { Task } from '../../../queue/types'
import * as boundedValidation from '../../adapters/boundedSchemaValidation'
import { CompositeToolRegistry, McpToolRegistryAdapter } from '../../adapters/toolRegistryAdapter'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { ConversationManager } from '../../conversation/conversation'
import { ApprovalController } from '../../extensions/approvalController'
import { InLoopContextManager, PressureContextManager } from '../../extensions/contextManager'
import { UnifiedApprovalGateController } from '../../extensions/mcpApprovalGateController'
import type { Tool } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import { NativeToolRegistry } from '../../tools/nativeToolRegistry'
import { type ChatMessage, ConversationState, type ToolCall } from '../../types'
import { FinishReason } from '../../types'
import { DeferrableToolController } from '../deferrableToolController'
import { SimpleEventEmitter } from '../eventEmitter'
import { DefaultLoopController, buildLoopConfig } from '../loopConfig'
import { validateToolLinkages } from '../toolUseLoopLinkages'
import { executeToolCalls } from '../toolUseLoopToolBatch'

type RemoteTool = { name: string; description: string; inputSchema: Record<string, unknown> }
const remote = vi.hoisted(() => ({ catalogs: new Map<string, RemoteTool[]>(), calls: vi.fn() }))
// Only MCP's external SDK boundary is simulated. All Evenfire catalog,
// presentation, validation, approval, context and execution components are real.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    server = ''
    async connect(transport: { server: string }) {
      this.server = transport.server
    }
    async close() {}
    async listTools() {
      return { tools: remote.catalogs.get(this.server) ?? [] }
    }
    async callTool(call: { name: string; arguments: Record<string, unknown> }) {
      remote.calls(this.server, call)
      return { content: [{ type: 'text', text: `receipt:${this.server}:${call.name}` }] }
    }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    server: string
    constructor(url: URL) {
      this.server = url.hostname
    }
    async close() {}
  },
}))

const managers: McpManager[] = []
const serverInfo = (name: string) => ({
  name,
  contextRef: 'test-context',
  enabled: true,
  transport: { type: 'streamableHttp' as const, url: `http://${name}/mcp` },
  status: { deployed: true, ready: true },
})

async function setup(count = 83, reverse = false) {
  const manager = new McpManager()
  managers.push(manager)
  for (const server of reverse ? ['beta', 'alpha'] : ['alpha', 'beta']) {
    const tools = Array.from({ length: count }, (_, index) => ({
      name: `record__read_${String(index).padStart(3, '0')}`,
      description: `Read category ${index} record`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })).filter((_tool, index) => index % 2 === (server === 'alpha' ? 0 : 1))
    remote.catalogs.set(server, reverse ? tools.reverse() : tools)
    await manager.addServer(serverInfo(server))
  }
  const native = new NativeToolRegistry(
    {
      workspacePath: '/tmp',
      shellTimeout: 1000,
      toolTimeout: 1000,
      toolProgressInterval: 0,
      httpAllowlist: [],
      envAllowlist: [],
      memoryMaxSize: 1000,
    },
    'lifecycle-test',
    undefined,
    undefined,
    undefined,
    () => ({}),
    undefined,
    undefined,
    undefined,
    undefined,
    manager,
    true,
    'codex-subscription'
  )
  // Match the observed 36-native workload without changing any real native
  // registration. Extra test read capabilities must never be executed.
  const initial = native.listDefinitions().length
  expect(initial).toBeLessThanOrEqual(36)
  for (let i = initial; i < 36; i++) {
    const tool: Tool = {
      name: () => `native_category_${i}`,
      description: () => `Read native category ${i}`,
      parametersSchema: () => ({ type: 'object', properties: {} }),
      requiresApproval: () => false,
      requiresSanitization: () => false,
      execute: async () => {
        throw new Error('Unrelated native operation executed')
      },
    }
    native.register(tool)
  }
  const registry = new CompositeToolRegistry(
    native,
    new McpToolRegistryAdapter(manager, 'authenticated-user', { strictValidation: true })
  )
  const conversation = makeFakeConversation({ state: ConversationState.Processing })
  const config = buildLoopConfig({
    toolRegistry: registry,
    conversation,
    reasoning: {
      respondWithTools: async () => {
        throw new Error('Unexpected LLM call')
      },
      continueWithToolResults: async () => {
        throw new Error('Unexpected LLM call')
      },
    },
    safety: new BasicSafety(),
    events: new SimpleEventEmitter(),
    toolProgressInterval: 0,
  })
  const nativeNames = new Set(native.listDefinitions().map(tool => tool.name))
  config.bridge = {
    nativeNames,
    getDeferrableCatalogNames: () => new Set(manager.getAllTools().map(tool => tool.name)),
  }
  return { manager, native, registry, config, conversation, nativeNames }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()))
  remote.catalogs.clear()
  remote.calls.mockClear()
})

const bridgeCall = (name: string, id = 'selected-call', args = {}): ToolCall => ({
  id,
  name: 'clerum__tool_call',
  arguments: { name, arguments: args },
})

describe('approved catalog across presentation and lifecycle', () => {
  for (const mode of ['direct', 'auto', 'discovery'] as const) {
    for (const count of [83, 90, 150, 250]) {
      it.each([false, true])(`${mode}: ${count} MCP + 36 natives, reversed=%s`, async reverse => {
        const { registry, config, nativeNames, conversation } = await setup(count, reverse)
        const controller = new DeferrableToolController(
          new DefaultLoopController(),
          nativeNames,
          { dynamicToolsEnabled: false, dynamicToolsThreshold: 60, codexMode: mode },
          {
            get: () => conversation.dynamicToolsBridgeActive,
            set: value => {
              conversation.dynamicToolsBridgeActive = value
            },
          }
        )
        const presented = await controller.refreshTools(registry.listDefinitions())
        expect(presented).toHaveLength(mode === 'direct' ? count + 36 : 36)
        expect(presented.filter(tool => nativeNames.has(tool.name))).toHaveLength(36)
        const target = `alpha__record__read_${String(count % 2 ? count - 1 : count - 2).padStart(3, '0')}`
        expect(registry.get(target)).not.toBeNull()
        const call =
          mode === 'direct'
            ? { id: 'selected-call', name: target, arguments: {} }
            : bridgeCall(target)
        const result = await executeToolCalls([call], config, 0)
        expect(result.toolResults).toMatchObject([
          { tool_call_id: 'selected-call', is_error: false },
        ])
        expect(remote.calls.mock.calls).toEqual([
          ['alpha', { name: target.slice('alpha__'.length), arguments: {} }],
        ])
      })
    }
  }

  it('reuses a described schema for repeated calls without mandatory discovery', async () => {
    const { registry, config } = await setup(250)
    const name = 'alpha__record__read_248'
    const described = await registry.get('clerum__tool_describe')!.execute({ name })
    expect(described.content).toContain(name)
    const outputs = await executeToolCalls(
      [bridgeCall(name, 'first'), bridgeCall(name, 'second')],
      config,
      0
    )
    expect(outputs.toolResults.map(result => result.tool_call_id)).toEqual(['first', 'second'])
    expect(outputs.toolResults.every(result => !result.is_error)).toBe(true)
    expect(remote.calls).toHaveBeenCalledTimes(2)
  })

  it('late catalog admission overrides another provider latch and mode changes retain every approved target', async () => {
    const { manager, registry, config, conversation, nativeNames } = await setup(0)
    conversation.dynamicToolsBridgeActive = false // Prior non-Codex session decision.
    const latch = {
      get: () => conversation.dynamicToolsBridgeActive,
      set: (value: boolean) => {
        conversation.dynamicToolsBridgeActive = value
      },
    }
    const auto = new DeferrableToolController(
      new DefaultLoopController(),
      nativeNames,
      { dynamicToolsEnabled: false, dynamicToolsThreshold: 60, codexMode: 'auto' },
      latch
    )
    const cold = await auto.refreshTools(registry.listDefinitions())
    expect(cold).toHaveLength(36)
    remote.catalogs.set(
      'alpha',
      Array.from({ length: 250 }, (_, i) => ({
        name: `record_${i}`,
        description: 'Read one record',
        inputSchema: { type: 'object', properties: {} },
      }))
    )
    await manager.replaceServer(serverInfo('alpha'))
    const warm = await auto.refreshTools(registry.listDefinitions())
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold))
    const direct = new DeferrableToolController(
      new DefaultLoopController(),
      nativeNames,
      { dynamicToolsEnabled: false, dynamicToolsThreshold: 60, codexMode: 'direct' },
      latch
    )
    expect(await direct.refreshTools(registry.listDefinitions())).toHaveLength(286)
    const result = await executeToolCalls([bridgeCall('alpha__record_249')], config, 0)
    expect(result.toolResults[0].is_error).toBe(false)
    expect(remote.calls).toHaveBeenCalledTimes(1)
    expect(conversation.dynamicToolsBridgeActive).toBe(false)
  })

  it('late disconnect removes a previously described target from bridge scope', async () => {
    const { manager, registry, config } = await setup()
    const name = 'alpha__record__read_082'
    expect((await registry.get('clerum__tool_describe')!.execute({ name })).content).toContain(name)
    await manager.removeServer('alpha')
    const result = await executeToolCalls([bridgeCall(name)], config, 0)
    expect(result.toolResults[0].is_error).toBe(true)
    expect(result.toolResults[0].content).toContain('not in the current tool catalog')
    expect(remote.calls).not.toHaveBeenCalled()
  })

  it('validates the live schema before dispatch after a previously described schema changes', async () => {
    const { manager, registry, config } = await setup()
    const name = 'alpha__record__read_082'
    const initial = await registry.get('clerum__tool_describe')!.execute({ name })
    expect(initial.content).not.toContain('recordId')
    const witness = await executeToolCalls([bridgeCall(name, 'before-schema-change')], config, 0)
    expect(witness.toolResults[0].is_error).toBe(false)
    expect(witness.toolResults[0].content).toContain('receipt:alpha:record__read_082')
    expect(remote.calls).toHaveBeenCalledTimes(1)
    remote.calls.mockClear()
    const updated = remote.catalogs.get('alpha')!.map(tool =>
      tool.name === 'record__read_082'
        ? {
            ...tool,
            inputSchema: {
              type: 'object',
              properties: { recordId: { type: 'string' } },
              required: ['recordId'],
              additionalProperties: false,
            },
          }
        : tool
    )
    remote.catalogs.set('alpha', updated)
    await manager.replaceServer(serverInfo('alpha'))
    registry.listDefinitions()
    expect((await registry.get('clerum__tool_describe')!.execute({ name })).content).toContain(
      'recordId'
    )
    const stale = await executeToolCalls([bridgeCall(name)], config, 0)
    expect(stale.toolResults[0].is_error).toBe(true)
    expect(remote.calls).not.toHaveBeenCalled()
  })

  it.each([83, 250])(
    'validates only the selected schema out of %i across repeated calls without mutating arguments',
    async count => {
      const compile = vi.spyOn(boundedValidation, 'validateBoundedSchema')
      try {
        const { manager, registry, config } = await setup(count)
        const target = 'alpha__record__read_000'
        const definition = remote.catalogs.get('alpha')![0]
        definition.inputSchema = {
          type: 'object',
          properties: { limit: { type: 'integer', default: 3 } },
          additionalProperties: false,
        }
        await manager.replaceServer(serverInfo('alpha'))
        registry.listDefinitions()
        expect(compile).not.toHaveBeenCalled()
        const args = {}
        const first = await executeToolCalls([bridgeCall(target, 'first', args)], config, 0)
        const second = await executeToolCalls([bridgeCall(target, 'second', args)], config, 1)
        expect(first.toolResults[0].is_error).toBe(false)
        expect(second.toolResults[0].is_error).toBe(false)
        expect(compile).toHaveBeenCalled()
        expect(
          compile.mock.calls.every(
            ([schema]) =>
              JSON.stringify(JSON.parse(schema)) === JSON.stringify(definition.inputSchema)
          )
        ).toBe(true)
        expect(args).toEqual({})
        const coerced = await executeToolCalls(
          [bridgeCall(target, 'wrong-type', { limit: '3' })],
          config,
          2
        )
        expect(coerced.toolResults[0].is_error).toBe(true)
        expect(remote.calls).toHaveBeenCalledTimes(2)
        expect(compile).toHaveBeenCalled()
        expect(
          compile.mock.calls.every(
            ([schema]) =>
              JSON.stringify(JSON.parse(schema)) === JSON.stringify(definition.inputSchema)
          )
        ).toBe(true)
      } finally {
        compile.mockRestore()
      }
    }
  )

  it.each([
    { type: 'not-a-valid-type' },
    { $ref: 'https://unresolvable.example/schema' },
    { $async: true, type: 'object' },
  ])(
    'rejects unsupported selected schema before approval and remote dispatch: %j',
    async schema => {
      const { manager, registry, native, config, conversation } = await setup()
      const target = 'alpha__record__read_000'
      remote.catalogs.get('alpha')![0].inputSchema = schema
      await manager.replaceServer(serverInfo('alpha'))
      registry.listDefinitions()
      config.loopController = new ApprovalController(
        conversation,
        new UnifiedApprovalGateController(registry, undefined, native)
      )
      const result = await executeToolCalls([bridgeCall(target)], config, 0)
      expect(result.pendingApproval).toBeUndefined()
      expect(result.toolResults[0].is_error).toBe(true)
      expect(result.toolResults[0].content).toContain(
        '$async' in schema ? 'unsupported by local validation' : 'could not be compiled locally'
      )
      expect(result.toolResults[0].content.length).toBeLessThan(150)
      expect(result.toolResults[0].content).not.toContain('unresolvable.example')
      expect(remote.calls).not.toHaveBeenCalled()
    }
  )

  it.each([
    'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2019-09/schema#',
    'https://json-schema.org/draft/2020-12/schema',
    'https://json-schema.org/draft/2020-12/schema#',
  ])('accepts a supported dialect including its equivalent empty fragment: %s', async dialect => {
    const { manager, registry, config } = await setup()
    remote.catalogs.get('alpha')![0].inputSchema = {
      $schema: dialect,
      type: 'object',
      properties: { recordId: { type: 'string' } },
      required: ['recordId'],
    }
    await manager.replaceServer(serverInfo('alpha'))
    registry.listDefinitions()
    const result = await executeToolCalls(
      [bridgeCall('alpha__record__read_000', 'dialect-call', { recordId: 'record-1' })],
      config,
      0
    )
    expect(result.toolResults[0].is_error).toBe(false)
    expect(remote.calls).toHaveBeenCalledTimes(1)
  })

  for (const mode of ['direct', 'discovery'] as const) {
    it.each(['default', '2020-12', 'draft-07'] as const)(
      `${mode}: validates tuple arguments using the declared or MCP-default dialect: %s`,
      async dialect => {
        const { manager, registry, config } = await setup()
        const target = 'alpha__record__read_000'
        const tuple =
          dialect === 'draft-07'
            ? { items: [{ type: 'string' }], additionalItems: false }
            : { prefixItems: [{ type: 'string' }], items: false }
        remote.catalogs.get('alpha')![0].inputSchema = {
          ...(dialect === 'default'
            ? {}
            : {
                $schema:
                  dialect === 'draft-07'
                    ? 'http://json-schema.org/draft-07/schema#'
                    : 'https://json-schema.org/draft/2020-12/schema',
              }),
          type: 'object',
          properties: { tuple: { type: 'array', ...tuple, minItems: 1 } },
          required: ['tuple'],
          additionalProperties: false,
        }
        await manager.replaceServer(serverInfo('alpha'))
        registry.listDefinitions()
        const call = (id: string, args: Record<string, unknown>): ToolCall =>
          mode === 'direct' ? { id, name: target, arguments: args } : bridgeCall(target, id, args)
        const valid = { tuple: ['example'] }
        const accepted = await executeToolCalls([call('valid-tuple', valid)], config, 0)
        expect(accepted.toolResults[0].is_error).toBe(false)
        expect(valid).toEqual({ tuple: ['example'] })
        expect(remote.calls).toHaveBeenCalledTimes(1)
        for (const args of [{ tuple: [] }, { tuple: [1] }, { tuple: ['a', 'b'] }]) {
          const rejected = await executeToolCalls([call('invalid-tuple', args)], config, 1)
          expect(rejected.toolResults[0].is_error).toBe(true)
          expect(remote.calls).toHaveBeenCalledTimes(1)
        }
      }
    )
  }

  it('a captured adapter rechecks an in-place changed schema immediately before execution', async () => {
    const { manager, registry } = await setup()
    const target = 'alpha__record__read_000'
    const captured = registry.get(target)!
    expect(await captured.validateParams!({})).toMatchObject({ is_valid: true })
    const schema = manager.getAllTools().find(tool => tool.name === target)!.inputSchema
    Object.assign(schema, { properties: { recordId: { type: 'string' } }, required: ['recordId'] })
    const rejected = await captured.execute({})
    expect(rejected.is_error).toBe(true)
    expect(remote.calls).not.toHaveBeenCalled()
    const accepted = await captured.execute({ recordId: 'record-1' })
    expect(accepted.is_error).toBe(false)
    expect(remote.calls).toHaveBeenCalledTimes(1)
  })

  it('approval freezes context, resumes the same call once and preserves result linkage through compaction', async () => {
    const { registry, native, config, conversation } = await setup()
    config.loopController = new ApprovalController(
      conversation,
      new UnifiedApprovalGateController(registry, undefined, native)
    )
    const call = bridgeCall('alpha__record__read_082')
    const history: ChatMessage[] = [
      { role: 'system', content: 'Use only the approved record service.' },
    ]
    for (let i = 0; i < 25; i++)
      history.push(
        { role: 'user', content: `Old request ${i} ${'history '.repeat(200)}` },
        { role: 'assistant', content: 'Old answer' }
      )
    history.push(
      { role: 'user', content: 'Read the selected receipt' },
      { role: 'assistant', content: '', tool_calls: [call] }
    )
    const suspended = await executeToolCalls([call], config, 0, history)
    expect(suspended.pendingApproval).toMatchObject({
      tool_name: 'alpha__record__read_082',
      tool_call_id: call.id,
    })
    expect(remote.calls).not.toHaveBeenCalled()
    const conversations = new ConversationManager()
    await conversations.suspendForApproval(conversation, suspended.pendingApproval!)
    const requestId = conversation.pending_approval!.request_id
    const pressure = new PressureContextManager(100)
    expect(await pressure.manage(history, conversation)).toBe(history)
    expect(conversation.pending_approval!.request_id).toBe(requestId)
    await conversations.approve(conversation, false)
    const resumed = await executeToolCalls([call], config, 1, history)
    expect(resumed.toolResults).toMatchObject([{ tool_call_id: call.id, is_error: false }])
    expect(remote.calls).toHaveBeenCalledTimes(1)
    await conversations.completeTurn(conversation, resumed.toolResults[0].content)
    const complete: ChatMessage[] = [
      ...history,
      { role: 'tool', content: resumed.toolResults[0].content, tool_call_id: call.id },
    ]
    const compacted = new InLoopContextManager(100, 2).manage(complete, conversation)
    expect(compacted.length).toBeLessThan(complete.length)
    expect(() => validateToolLinkages(compacted)).not.toThrow()
    expect(compacted.find(message => message.tool_call_id === call.id)?.content).toContain(
      'receipt:alpha:record__read_082'
    )
    expect(compacted.flatMap(message => message.tool_calls ?? []).map(tool => tool.id)).toContain(
      call.id
    )
  })

  it.each(['approve', 'direct', 'deny', 'cancel', 'revoke', 'schema-change'] as const)(
    'TaskExecutor %s uses the actual loop and never duplicates the MCP call',
    async decision => {
      const saved = {
        enableApproval: appConfig.enableApproval,
        codexToolPresentation: appConfig.codexToolPresentation,
        contextMaxTokens: appConfig.contextMaxTokens,
        promptCacheEnabled: appConfig.promptCacheEnabled,
      }
      Object.assign(appConfig, {
        enableApproval: true,
        codexToolPresentation: decision === 'direct' ? 'direct' : 'discovery',
        contextMaxTokens: 100000,
        promptCacheEnabled: false,
      })
      try {
        const { manager } = await setup(83)
        const target = 'alpha__record__read_082'
        const call: ToolCall =
          decision === 'direct'
            ? { id: 'durable-call', name: target, arguments: {} }
            : bridgeCall(target, 'durable-call')
        const providerCalls: ChatMessage[][] = []
        const provider: SingleTurnProvider = {
          getProviderType: () => 'codex-subscription',
          classifyError: () => {
            throw new Error('Unexpected provider failure')
          },
          completeSingleTurn: async () => {
            throw new Error('Unexpected non-tool completion')
          },
          completeSingleTurnWithTools: async (messages, tools) => {
            providerCalls.push(structuredClone(messages))
            expect(tools.some(tool => tool.name === 'clerum__tool_call')).toBe(
              decision !== 'direct'
            )
            const connectorDefinitions = tools.filter(
              tool => tool.name.startsWith('alpha__') || tool.name.startsWith('beta__')
            )
            expect(connectorDefinitions.length).toBe(decision === 'direct' ? 83 : 0)
            const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            if (providerCalls.length === 1)
              return {
                content: null,
                tool_calls: [call],
                usage,
                finish_reason: FinishReason.ToolUse,
              }
            expect(providerCalls).toHaveLength(2)
            expect(() => validateToolLinkages(messages)).not.toThrow()
            const result = messages.find(
              message => message.role === 'tool' && message.tool_call_id === call.id
            )
            if (decision === 'schema-change')
              expect(result?.content).toContain('Arguments do not match the current MCP schema')
            else if (decision === 'revoke')
              expect(result?.content).toMatch(/not found|not available/i)
            else expect(result?.content).toContain('receipt:alpha:record__read_082')
            return {
              content:
                decision === 'revoke' || decision === 'schema-change'
                  ? 'The approved operation could not execute.'
                  : 'Verified receipt',
              tool_calls: null,
              usage,
              finish_reason: FinishReason.Stop,
            }
          },
        }
        const task: Task = {
          id: `lifecycle-${decision}`,
          source: 'channel',
          status: 'pending',
          priority: 'normal',
          createdAt: new Date(),
          sourceMessage: {
            sender: 'authenticated-user',
            content: 'Read the selected receipt',
            channelType: 'rpc',
            channelId: 'isolated-channel',
            messageId: `message-${decision}`,
            timestamp: new Date().toISOString(),
            hostRef: 'fixture-host',
          },
          conversationHistory: [
            { role: 'user', content: 'Read the selected receipt', timestamp: new Date() },
          ],
          responseCallback: vi.fn(async () => {}),
        }
        const lifecycle = new TaskLifecycle()
        lifecycle.register(task)
        const deps: TaskExecutorDeps = {
          conversationManager: new ConversationManager(),
          llmProvider: provider,
          mcpManager: manager,
          workspaceService: undefined,
          modelName: 'gpt-5.6-luna',
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
        expect(deps.onFail).not.toHaveBeenCalled()
        expect(executor.executorState).toBe('waiting_approval')
        expect(executor.pendingApproval).toMatchObject({ tool_name: target, tool_call_id: call.id })
        const approvalId = executor.pendingApproval!.request_id
        expect(approvalId).toBeTruthy()
        expect(remote.calls).not.toHaveBeenCalled()
        if (decision === 'approve' || decision === 'direct') {
          await executor.resumeAfterApproval(false)
          expect(executor.executorState).toBe('completed')
          expect(remote.calls).toHaveBeenCalledTimes(1)
          expect(providerCalls).toHaveLength(2)
          expect(
            providerCalls[1].flatMap(message => message.tool_calls ?? []).map(tool => tool.id)
          ).toContain(call.id)
          expect(deps.onApprovalNeeded).toHaveBeenCalledTimes(1)
        } else if (decision === 'schema-change') {
          const selected = remote.catalogs
            .get('alpha')!
            .find(tool => tool.name === 'record__read_082')!
          selected.inputSchema = {
            type: 'object',
            properties: { recordId: { type: 'string' } },
            required: ['recordId'],
          }
          await manager.replaceServer(serverInfo('alpha'))
          await executor.resumeAfterApproval(false)
          expect(executor.executorState).toBe('completed')
          expect(remote.calls).not.toHaveBeenCalled()
          expect(providerCalls).toHaveLength(2)
          expect(deps.onApprovalNeeded).toHaveBeenCalledTimes(1)
        } else if (decision === 'revoke') {
          // Manager removal is the actual authorization-reconcile effect;
          // this test does not pretend to exercise the upstream grant API.
          await manager.removeServer('alpha')
          await executor.resumeAfterApproval(false)
          expect(executor.executorState).toBe('completed')
          expect(remote.calls).not.toHaveBeenCalled()
          expect(providerCalls).toHaveLength(2)
        } else if (decision === 'deny') {
          await executor.deny()
          expect(executor.executorState).toBe('completed')
          expect(remote.calls).not.toHaveBeenCalled()
          expect(providerCalls).toHaveLength(1)
        } else {
          executor.abort()
          await executor.resumeAfterApproval(false)
          expect(executor.signal.aborted).toBe(true)
          expect(remote.calls).not.toHaveBeenCalled()
          expect(providerCalls).toHaveLength(1)
        }
        expect(deps.onFail).not.toHaveBeenCalled()
      } finally {
        Object.assign(appConfig, saved)
      }
    }
  )
})
