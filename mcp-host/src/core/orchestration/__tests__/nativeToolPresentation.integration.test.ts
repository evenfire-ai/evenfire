/**
 * #1003 — native-tool presentation is independent from MCP (Codex/Grok)
 * presentation. Every scenario runs the real `TaskExecutor.run()`: registry,
 * MCP presentation, native presentation, prompt builder, approval chain, bridge
 * intercept and tool execution are production code. Only MCP's external SDK
 * boundary and the LLM provider are simulated; the provider records the exact
 * `tools[]` and messages it receives, which is what the model sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TaskExecutor, type TaskExecutorDeps } from '../../../agent/taskExecutor'
import { BRIDGE_TOOL_NAMES } from '../../../capabilities/toolCatalogTools'
import { config as appConfig } from '../../../config'
import { TaskLifecycle } from '../../../lifecycle/taskLifecycle'
import { PromptCache } from '../../../llm/promptCache'
import type { SingleTurnProvider } from '../../../llm/types'
import { logger } from '../../../logger'
import { McpManager } from '../../../mcp/manager'
import type { Task, TaskResponsePayload } from '../../../queue/types'
import { ConversationManager } from '../../conversation/conversation'
import { NATIVE_TOOL_DISCOVERY_TEXT, TOOL_DISCOVERY_TEXT } from '../../reasoning/promptBuilder'
import { type ChatMessage, FinishReason, type ToolCall, type ToolDefinition } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import {
  type CodexToolPresentation,
  DEFAULT_NATIVE_TOOL_DISCOVERY_BYTES,
  type NativeToolPresentation,
} from '../toolPresentationPolicy'
import { validateToolLinkages } from '../toolUseLoopLinkages'
import { NATIVE_DIRECT_DEV_BASELINE } from './nativeDirectDevBaseline'

type RemoteTool = { name: string; description: string; inputSchema: Record<string, unknown> }
const remote = vi.hoisted(() => ({ catalogs: new Map<string, RemoteTool[]>(), calls: vi.fn() }))
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

/** The natives whose definition exceeds the 2048 B default (pinned in the policy unit test). */
const GENERATORS = [
  'clerum__generate_chart',
  'clerum__generate_dashboard',
  'clerum__generate_pdf',
  'clerum__generate_pptx',
  'clerum__generate_xlsx',
]
const BRIDGE = [...BRIDGE_TOOL_NAMES].sort()
const PPTX_ARGS = {
  filename: 'bridged-deck.pptx',
  title: 'Bridged deck',
  slides: [{ layout: 'cover', title: 'Quarterly review', subtitle: 'Q1', status: 'green' }],
}

const managers: McpManager[] = []
const recordCatalog = (count: number, server: 'alpha' | 'beta'): RemoteTool[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `record__read_${String(index).padStart(3, '0')}`,
    description: `Read category ${index} record`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })).filter((_tool, index) => index % 2 === (server === 'alpha' ? 0 : 1))

async function connectMcp(catalogs: Record<string, RemoteTool[]>): Promise<McpManager> {
  const manager = new McpManager()
  managers.push(manager)
  for (const [server, tools] of Object.entries(catalogs)) {
    remote.catalogs.set(server, tools)
    await manager.addServer({
      name: server,
      contextRef: 'test-context',
      enabled: true,
      transport: { type: 'streamableHttp' as const, url: `http://${server}/mcp` },
      status: { deployed: true, ready: true },
    })
  }
  return manager
}

type ProviderType = 'codex-subscription' | 'grok-subscription' | 'openai'
interface Scenario {
  provider: ProviderType
  /** Codex/Grok `CODEX_TOOL_PRESENTATION`; ignored by other providers. */
  codexMode?: CodexToolPresentation
  /** Legacy `CLERUM_DYNAMIC_TOOLS_ENABLED`; only non-Codex providers read it. */
  legacy?: boolean
  native: NativeToolPresentation
  /** MCP tool count split over alpha/beta, explicit catalogs, or `null` for no McpManager. */
  mcp: number | Record<string, RemoteTool[]> | null
  approval?: boolean
  /** `CLERUM_NATIVE_TOOL_DISCOVERY_BYTES`; the 2048 B default when omitted. */
  discoveryBytes?: number
  /** Production default path: tiered prompt parts built and cached per session. */
  promptCache?: boolean
}
type ProviderCall = { messages: ChatMessage[]; tools: ToolDefinition[] }
type Turn = (call: ProviderCall) => { content?: string; tool_calls?: ToolCall[] }

const toolCalls = (...calls: ToolCall[]) => ({ tool_calls: calls })
const bridged = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name: 'clerum__tool_call',
  arguments: { name, arguments: args },
})
const names = (tools: ToolDefinition[]) => tools.map(tool => tool.name)
const isMcp = (name: string) => name.startsWith('alpha__') || name.startsWith('beta__')
const systemText = (messages: ChatMessage[]) =>
  messages
    .filter(message => message.role === 'system')
    .map(message => String(message.content))
    .join('\n')
const toolResult = (messages: ChatMessage[], id: string) => {
  const result = messages.find(message => message.role === 'tool' && message.tool_call_id === id)
  if (!result) throw new Error(`no tool result for ${id}`)
  return String(result.content)
}

let outputDir: string
let logEvents: Array<Record<string, unknown>>
const savedConfig = {
  enableApproval: appConfig.enableApproval,
  codexToolPresentation: appConfig.codexToolPresentation,
  dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
  nativeToolPresentation: appConfig.nativeToolPresentation,
  nativeToolDiscoveryBytes: appConfig.nativeToolDiscoveryBytes,
  contextMaxTokens: appConfig.contextMaxTokens,
  promptCacheEnabled: appConfig.promptCacheEnabled,
}
const savedOutputDir = process.env.CLERUM_OUTPUT_DIR

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-presentation-'))
  process.env.CLERUM_OUTPUT_DIR = outputDir
  logEvents = []
  vi.spyOn(logger, 'info').mockImplementation(((entry: unknown) => {
    if (entry && typeof entry === 'object' && 'component' in entry)
      logEvents.push(structuredClone(entry as Record<string, unknown>))
  }) as typeof logger.info)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(managers.splice(0).map(manager => manager.close()))
  remote.catalogs.clear()
  remote.calls.mockClear()
  Object.assign(appConfig, savedConfig)
  if (savedOutputDir === undefined) delete process.env.CLERUM_OUTPUT_DIR
  else process.env.CLERUM_OUTPUT_DIR = savedOutputDir
  fs.rmSync(outputDir, { recursive: true, force: true })
})

const events = (component: string) => logEvents.filter(event => event.component === component)
const pptxFiles = () => fs.readdirSync(outputDir).filter(file => file.endsWith('.pptx'))

async function runScenario(scenario: Scenario, turns: Turn[]) {
  Object.assign(appConfig, {
    enableApproval: scenario.approval === true,
    codexToolPresentation: scenario.codexMode ?? 'direct',
    dynamicToolsEnabled: scenario.legacy === true,
    nativeToolPresentation: scenario.native,
    nativeToolDiscoveryBytes: scenario.discoveryBytes ?? DEFAULT_NATIVE_TOOL_DISCOVERY_BYTES,
    contextMaxTokens: 100000,
    promptCacheEnabled: scenario.promptCache === true,
  })
  const manager =
    scenario.mcp === null
      ? null
      : await connectMcp(
          typeof scenario.mcp === 'number'
            ? {
                alpha: recordCatalog(scenario.mcp, 'alpha'),
                beta: recordCatalog(scenario.mcp, 'beta'),
              }
            : scenario.mcp
        )
  const providerCalls: ProviderCall[] = []
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  const provider: SingleTurnProvider = {
    getProviderType: () => scenario.provider,
    classifyError: () => {
      throw new Error('Unexpected provider failure')
    },
    completeSingleTurn: async () => {
      throw new Error('Unexpected non-tool completion')
    },
    completeSingleTurnWithTools: async (messages, tools) => {
      const call = { messages: structuredClone(messages), tools: structuredClone(tools) }
      providerCalls.push(call)
      const turn = turns[providerCalls.length - 1]
      if (!turn) throw new Error(`Unexpected provider call ${providerCalls.length}`)
      const reply = turn(call)
      return reply.tool_calls
        ? {
            content: null,
            tool_calls: reply.tool_calls,
            usage,
            finish_reason: FinishReason.ToolUse,
          }
        : {
            content: reply.content ?? '',
            tool_calls: null,
            usage,
            finish_reason: FinishReason.Stop,
          }
    },
  }
  const responses: TaskResponsePayload[] = []
  const task: Task = {
    id: `native-presentation-${scenario.provider}`,
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender: 'authenticated-user',
      content: 'Build the quarterly deck',
      channelType: 'rpc',
      channelId: 'isolated-channel',
      messageId: 'message-native-presentation',
      timestamp: new Date().toISOString(),
      hostRef: 'fixture-host',
    },
    conversationHistory: [
      { role: 'user', content: 'Build the quarterly deck', timestamp: new Date() },
    ],
    responseCallback: vi.fn(async (payload: TaskResponsePayload) => {
      responses.push(payload)
    }),
  }
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const workspaceService = scenario.promptCache
    ? {
        readIdentityFiles: vi.fn(async () => ({ identity: '', soul: '', agents: '', user: '' })),
        snapshotDailyLogs: vi.fn(async () => 'daily snapshot'),
      }
    : undefined
  const deps: TaskExecutorDeps = {
    conversationManager: new ConversationManager(),
    llmProvider: provider,
    mcpManager: manager,
    workspaceService: workspaceService as unknown as TaskExecutorDeps['workspaceService'],
    promptCache: scenario.promptCache ? new PromptCache() : undefined,
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
  return { executor, deps, providerCalls, responses, workspaceService }
}

/** Search → describe → bridged call for the pptx generator, then a final answer. */
function pptxJourney(expectedGuidance: string, extraFirstCalls: ToolCall[] = []): Turn[] {
  return [
    ({ messages, tools }) => {
      expect(systemText(messages)).toContain(expectedGuidance)
      expect(names(tools)).toEqual(expect.arrayContaining(BRIDGE))
      for (const generator of GENERATORS) expect(names(tools)).not.toContain(generator)
      return toolCalls(
        { id: 'search-call', name: 'clerum__tool_search', arguments: { query: 'pptx slides' } },
        ...extraFirstCalls
      )
    },
    ({ messages }) => {
      const search = JSON.parse(toolResult(messages, 'search-call'))
      expect(search.results).toContainEqual(
        expect.objectContaining({ name: 'clerum__generate_pptx', server: 'native' })
      )
      return toolCalls({
        id: 'describe-call',
        name: 'clerum__tool_describe',
        arguments: { name: 'clerum__generate_pptx' },
      })
    },
    ({ messages }) => {
      const described = JSON.parse(toolResult(messages, 'describe-call'))
      expect(described).toMatchObject({ found: true, name: 'clerum__generate_pptx' })
      expect(described.parameters.properties).toHaveProperty('slides')
      return toolCalls(bridged('pptx-call', 'clerum__generate_pptx', PPTX_ARGS))
    },
    ({ messages }) => {
      expect(() => validateToolLinkages(messages)).not.toThrow()
      expect(toolResult(messages, 'pptx-call')).toContain('File generated: bridged-deck.pptx')
      const assistantCalls = messages.flatMap(message => message.tool_calls ?? [])
      expect(assistantCalls).toContainEqual(
        expect.objectContaining({ id: 'pptx-call', name: 'clerum__tool_call' })
      )
      return { content: 'The deck is attached.' }
    },
  ]
}

function expectPptxDelivered(run: Awaited<ReturnType<typeof runScenario>>, providerCalls = 4) {
  expect(run.deps.onFail).not.toHaveBeenCalled()
  expect(run.executor.executorState).toBe('completed')
  expect(run.providerCalls).toHaveLength(providerCalls)
  expect(pptxFiles()).toEqual(['bridged-deck.pptx'])
  expect(run.responses).toHaveLength(1)
  expect(run.responses[0].response).toBe('The deck is attached.')
  expect(run.responses[0].attachments).toEqual([
    expect.objectContaining({ sourceTool: 'clerum__generate_pptx', filename: 'bridged-deck.pptx' }),
  ])
}

describe('T1 — native discovery journeys through TaskExecutor.run()', () => {
  it.each(['codex-subscription', 'grok-subscription'] as const)(
    '%s direct + native auto: search, describe and bridged call deliver the deck',
    async provider => {
      const run = await runScenario(
        { provider, codexMode: 'direct', native: 'auto', mcp: 2 },
        pptxJourney(NATIVE_TOOL_DISCOVERY_TEXT)
      )
      // State: every MCP tool is still listed directly (MCP direct is untouched).
      expect(names(run.providerCalls[0].tools).filter(isMcp).sort()).toEqual([
        'alpha__record__read_000',
        'beta__record__read_001',
      ])
      expect(events('native-tool-presentation')).toEqual([
        expect.objectContaining({ mode: 'auto', budget: 2048, hiddenNames: GENERATORS }),
      ])
      expectPptxDelivered(run)
      expect(remote.calls).not.toHaveBeenCalled()
    }
  )

  it('an approval-requiring native called through the bridge suspends on its real name and runs once', async () => {
    const run = await runScenario(
      {
        provider: 'codex-subscription',
        codexMode: 'direct',
        native: 'auto',
        mcp: 2,
        approval: true,
      },
      [
        () => toolCalls(bridged('shell-call', 'shell_exec', { command: 'echo bridged-approval' })),
        ({ messages }) => {
          expect(toolResult(messages, 'shell-call')).toContain('bridged-approval')
          return { content: 'Done.' }
        },
      ]
    )
    expect(run.deps.onFail).not.toHaveBeenCalled()
    expect(run.executor.executorState).toBe('waiting_approval')
    expect(run.executor.pendingApproval).toMatchObject({
      tool_name: 'shell_exec',
      tool_call_id: 'shell-call',
    })
    // Suspended before execution: the provider has not seen any tool result.
    expect(run.providerCalls).toHaveLength(1)
    expect(run.deps.onApprovalNeeded).toHaveBeenCalledTimes(1)

    await run.executor.resumeAfterApproval(false)
    expect(run.executor.executorState).toBe('completed')
    expect(run.providerCalls).toHaveLength(2)
    expect(
      run.providerCalls[1].messages.filter(
        message => message.role === 'tool' && message.tool_call_id === 'shell-call'
      )
    ).toHaveLength(1)
    expect(run.responses.map(response => response.response)).toEqual(['Done.'])
  })

  it('non-Codex provider with the legacy flag off (early return): native discovery works and listed MCP tools stay direct', async () => {
    const run = await runScenario(
      { provider: 'openai', legacy: false, native: 'auto', mcp: 2 },
      pptxJourney(NATIVE_TOOL_DISCOVERY_TEXT, [
        { id: 'mcp-call', name: 'alpha__record__read_000', arguments: {} },
      ])
    )
    expect(names(run.providerCalls[0].tools).filter(isMcp).sort()).toEqual([
      'alpha__record__read_000',
      'beta__record__read_001',
    ])
    // C3 witness: the directly listed MCP tool executed once, not through the bridge.
    expect(toolResult(run.providerCalls[1].messages, 'mcp-call')).toContain(
      'receipt:alpha:record__read_000'
    )
    expect(remote.calls.mock.calls).toEqual([
      ['alpha', { name: 'record__read_000', arguments: {} }],
    ])
    // The early return never runs the MCP presentation controller.
    expect(events('tool-presentation')).toEqual([])
    expect(events('deferrable-tools')).toEqual([])
    expect(events('native-tool-presentation')).toHaveLength(1)
    expectPptxDelivered(run)
  })

  it('without an McpManager, Codex auto + native auto registers the bridge and reaches the generators', async () => {
    const run = await runScenario(
      { provider: 'codex-subscription', codexMode: 'auto', native: 'auto', mcp: null },
      pptxJourney(NATIVE_TOOL_DISCOVERY_TEXT)
    )
    expect(names(run.providerCalls[0].tools).filter(isMcp)).toEqual([])
    expectPptxDelivered(run)
  })

  it('without an McpManager, Codex auto + native direct presents every native and no bridge', async () => {
    const run = await runScenario(
      { provider: 'codex-subscription', codexMode: 'auto', native: 'direct', mcp: null },
      [
        ({ messages, tools }) => {
          expect(names(tools)).toEqual(expect.arrayContaining(GENERATORS))
          for (const bridge of BRIDGE) expect(names(tools)).not.toContain(bridge)
          expect(systemText(messages)).not.toContain(TOOL_DISCOVERY_TEXT)
          expect(systemText(messages)).not.toContain(NATIVE_TOOL_DISCOVERY_TEXT)
          return toolCalls({ id: 'pptx-call', name: 'clerum__generate_pptx', arguments: PPTX_ARGS })
        },
        ({ messages }) => {
          expect(toolResult(messages, 'pptx-call')).toContain('File generated: bridged-deck.pptx')
          return { content: 'The deck is attached.' }
        },
      ]
    )
    // Witness for the absent native event: the MCP controller did observe this turn.
    expect(events('tool-presentation')).toEqual([
      expect.objectContaining({ mode: 'auto', mcpCount: 0 }),
    ])
    expect(events('native-tool-presentation')).toEqual([])
    expectPptxDelivered(run, 2)
  })

  it('the default prompt-cache path carries the native-aware guidance in auto and the dev text in direct', async () => {
    const run = await runScenario(
      {
        provider: 'codex-subscription',
        codexMode: 'direct',
        native: 'auto',
        mcp: 2,
        promptCache: true,
      },
      pptxJourney(NATIVE_TOOL_DISCOVERY_TEXT)
    )
    // Witness: the system prompt came from the cached tiered parts, not the legacy builder.
    expect(run.workspaceService!.snapshotDailyLogs).toHaveBeenCalledTimes(1)
    expect(systemText(run.providerCalls[0].messages)).toContain('daily snapshot')
    expectPptxDelivered(run)

    // Same cache path in native direct, with the MCP bridge on: the pre-#1003 text.
    await Promise.all(managers.splice(0).map(manager => manager.close()))
    const direct = await runScenario(
      {
        provider: 'codex-subscription',
        codexMode: 'discovery',
        native: 'direct',
        mcp: 2,
        promptCache: true,
      },
      [() => ({ content: 'ok' })]
    )
    expect(direct.workspaceService!.snapshotDailyLogs).toHaveBeenCalledTimes(1)
    const directText = systemText(direct.providerCalls[0].messages)
    expect(directText).toContain(TOOL_DISCOVERY_TEXT)
    expect(directText).not.toContain(NATIVE_TOOL_DISCOVERY_TEXT)
  })

  it('CLERUM_NATIVE_TOOL_DISCOVERY_BYTES reaches the controller and decides what is hidden', async () => {
    const firstTools = async (discoveryBytes: number) => {
      logEvents.length = 0
      const run = await runScenario(
        { provider: 'openai', legacy: false, native: 'auto', mcp: null, discoveryBytes },
        [() => ({ content: 'ok' })]
      )
      expect(run.providerCalls).toHaveLength(1)
      return names(run.providerCalls[0].tools)
    }
    // A budget above every native hides nothing.
    const roomy = await firstTools(100_000)
    expect(roomy).toEqual(expect.arrayContaining([...GENERATORS, ...BRIDGE]))
    expect(events('native-tool-presentation')).toEqual([
      expect.objectContaining({ budget: 100_000, hiddenNames: [] }),
    ])
    // A 1 B budget leaves only the bridge tools.
    const tight = await firstTools(1)
    expect(tight.sort()).toEqual(BRIDGE)
    expect(events('native-tool-presentation')).toEqual([
      expect.objectContaining({ budget: 1, presentedCount: BRIDGE.length }),
    ])
  })
})

describe('T2 — independence matrix (I1, I2 with deviation D1)', () => {
  type Cell = Omit<Scenario, 'native' | 'mcp'> & { label: string }
  const cells: Cell[] = [
    { label: 'codex direct', provider: 'codex-subscription', codexMode: 'direct' },
    { label: 'codex auto', provider: 'codex-subscription', codexMode: 'auto' },
    { label: 'codex discovery', provider: 'codex-subscription', codexMode: 'discovery' },
    { label: 'grok direct', provider: 'grok-subscription', codexMode: 'direct' },
    { label: 'grok auto', provider: 'grok-subscription', codexMode: 'auto' },
    { label: 'legacy on', provider: 'openai', legacy: true },
    { label: 'legacy off', provider: 'openai', legacy: false },
  ]
  /** Whether origin/dev lists MCP tools directly in this cell. */
  const devListsMcp = (cell: Cell, mcp: number) =>
    cell.codexMode === 'direct' ||
    cell.legacy === false ||
    (mcp === 2 && (cell.codexMode === 'auto' || cell.legacy === true))
  /** Whether origin/dev registers the bridge tools: MCP discovery with an McpManager. */
  const devRegistersBridge = (cell: Cell, mcp: number | null) =>
    mcp !== null && (cell.legacy === true || (cell.codexMode ?? 'direct') !== 'direct')
  /**
   * The non-bridge natives origin/dev presents (pinned by the I4 baseline), so each
   * matrix cell checks I1 against a fixed reference instead of against other tests.
   */
  const DEV_NATIVES = NATIVE_DIRECT_DEV_BASELINE['legacy-off/2'].toolNames
    .filter(name => !isMcp(name) && !BRIDGE_TOOL_NAMES.has(name))
    .sort()

  async function firstTurn(cell: Cell, native: NativeToolPresentation, mcp: number | null) {
    logEvents.length = 0
    const run = await runScenario({ ...cell, native, mcp }, [() => ({ content: 'ok' })])
    expect(run.executor.executorState).toBe('completed')
    expect(run.providerCalls).toHaveLength(1)
    const tools = names(run.providerCalls[0].tools)
    const log = {
      presentation: events('tool-presentation'),
      legacy: events('deferrable-tools'),
      native: events('native-tool-presentation'),
    }
    await Promise.all(managers.splice(0).map(manager => manager.close()))
    remote.catalogs.clear()
    return { tools, log }
  }

  for (const cell of cells) {
    for (const mcp of [2, 83, null]) {
      const mcpLabel = mcp === null ? 'no McpManager' : `${mcp} MCP`
      it(`${cell.label}, ${mcpLabel}: MCP presentation is identical for native direct and auto`, async () => {
        const direct = await firstTurn(cell, 'direct', mcp)
        const auto = await firstTurn(cell, 'auto', mcp)

        // I2 (a): the MCP tools sent to the model are the same list.
        const mcpDirect = direct.tools.filter(isMcp)
        expect(auto.tools.filter(isMcp)).toEqual(mcpDirect)
        expect(mcpDirect).toHaveLength(mcp !== null && devListsMcp(cell, mcp) ? mcp : 0)

        // I2 (b)/(c): MCP log fields equal; native counters +3 exactly where
        // origin/dev registered no bridge tools (deviation D1).
        expect(auto.log.legacy).toEqual(direct.log.legacy)
        expect(auto.log.presentation).toHaveLength(direct.log.presentation.length)
        direct.log.presentation.forEach((before, index) => {
          const after = auto.log.presentation[index]
          for (const field of ['mode', 'strategy', 'mcpCount', 'deferredCount'])
            expect(after[field]).toBe(before[field])
          const delta = devRegistersBridge(cell, mcp) ? 0 : BRIDGE.length
          expect(after.nativeCount).toBe((before.nativeCount as number) + delta)
          expect(after.presentedCount).toBe((before.presentedCount as number) + delta)
        })
        if (cell.codexMode !== undefined) expect(direct.log.presentation).toHaveLength(1)
        if (cell.legacy === true && mcp !== null) expect(direct.log.legacy).toHaveLength(1)

        // I1: natives depend on native mode only; auto hides exactly the generators.
        const nonBridgeNatives = (tools: string[]) =>
          tools.filter(name => !isMcp(name) && !BRIDGE_TOOL_NAMES.has(name)).sort()
        expect(nonBridgeNatives(direct.tools)).toEqual(DEV_NATIVES)
        expect(nonBridgeNatives(auto.tools)).toEqual(
          DEV_NATIVES.filter(name => !GENERATORS.includes(name))
        )
        expect(DEV_NATIVES).toEqual(expect.arrayContaining(GENERATORS))
        expect(auto.tools).toEqual(expect.arrayContaining(BRIDGE))
        expect(direct.log.native).toEqual([])
        expect(auto.log.native).toEqual([
          expect.objectContaining({ mode: 'auto', hiddenNames: GENERATORS }),
        ])
      })
    }
  }
})

describe('I4 — native direct sends exactly what origin/dev sends', () => {
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  const savedWorkspacePath = appConfig.nativeTool.workspacePath
  afterEach(() => {
    vi.useRealTimers()
    appConfig.nativeTool.workspacePath = savedWorkspacePath
  })

  it('the baseline covers exactly the ten dev cells (a dropped cell cannot pass silently)', () => {
    expect(Object.keys(NATIVE_DIRECT_DEV_BASELINE).sort()).toEqual(
      ['codex-auto', 'codex-direct', 'codex-discovery', 'legacy-off', 'legacy-on']
        .flatMap(label => [`${label}/2`, `${label}/83`])
        .sort()
    )
  })

  it.each(Object.keys(NATIVE_DIRECT_DEV_BASELINE))(
    '%s: tools[] and system prompt are byte-identical to the dev baseline',
    async key => {
      // The baseline was captured with a fixed clock and workspace path.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
      appConfig.nativeTool.workspacePath = '/workspace'
      const [label, count] = key.split('/')
      const cells: Record<string, Omit<Scenario, 'native' | 'mcp'>> = {
        'codex-direct': { provider: 'codex-subscription', codexMode: 'direct' },
        'codex-auto': { provider: 'codex-subscription', codexMode: 'auto' },
        'codex-discovery': { provider: 'codex-subscription', codexMode: 'discovery' },
        'legacy-on': { provider: 'openai', legacy: true },
        'legacy-off': { provider: 'openai', legacy: false },
      }
      const cell = cells[label]
      if (!cell) throw new Error(`unknown baseline cell ${key}`)
      const run = await runScenario({ ...cell, native: 'direct', mcp: Number(count) }, [
        () => ({ content: 'ok' }),
      ])
      expect(run.providerCalls).toHaveLength(1)
      const { tools, messages } = run.providerCalls[0]
      const expected = NATIVE_DIRECT_DEV_BASELINE[key]
      expect(names(tools)).toEqual(expected.toolNames)
      expect(sha256(JSON.stringify(tools))).toBe(expected.toolsSha256)
      expect(sha256(systemText(messages))).toBe(expected.systemSha256)
    }
  )
})

describe('T3 — negative guards with liveness witnesses (through TaskExecutor.run())', () => {
  it('native direct: the bridge rejects a native target with the pre-#1003 message', async () => {
    const turns = (expectRejected: boolean): Turn[] => [
      () =>
        toolCalls(bridged('pptx-call', 'clerum__generate_pptx', PPTX_ARGS), {
          id: 'search-call',
          name: 'clerum__tool_search',
          arguments: { query: 'record' },
        }),
      ({ messages }) => {
        const result = toolResult(messages, 'pptx-call')
        if (expectRejected) expect(result).toContain('native and bridge tools are called directly')
        else expect(result).toContain('File generated: bridged-deck.pptx')
        return { content: 'done' }
      },
    ]
    // Codex discovery registers the bridge for MCP in both native modes.
    await runScenario(
      { provider: 'codex-subscription', codexMode: 'discovery', native: 'direct', mcp: 2 },
      turns(true)
    )
    expect(pptxFiles()).toEqual([])
    // Witness: the identical call executes once in native auto.
    await runScenario(
      { provider: 'codex-subscription', codexMode: 'discovery', native: 'auto', mcp: 2 },
      turns(false)
    )
    expect(pptxFiles()).toEqual(['bridged-deck.pptx'])
  })

  it('native direct: search lists no native entries while MCP entries are found', async () => {
    const search = async (native: NativeToolPresentation) => {
      let payload: { results: Array<{ name: string; server: string }> } | undefined
      await runScenario(
        { provider: 'codex-subscription', codexMode: 'discovery', native, mcp: 2 },
        [
          () =>
            toolCalls({
              id: 'search-call',
              name: 'clerum__tool_search',
              arguments: { query: 'read record generate pptx', limit: 50 },
            }),
          ({ messages }) => {
            payload = JSON.parse(toolResult(messages, 'search-call'))
            return { content: 'done' }
          },
        ]
      )
      await Promise.all(managers.splice(0).map(manager => manager.close()))
      return payload!.results
    }
    const direct = await search('direct')
    expect(direct.filter(entry => entry.server === 'native')).toEqual([])
    expect(direct.map(entry => entry.name)).toEqual(
      expect.arrayContaining(['alpha__record__read_000', 'beta__record__read_001'])
    )
    const auto = await search('auto')
    expect(auto).toContainEqual(
      expect.objectContaining({ name: 'clerum__generate_pptx', server: 'native' })
    )
  })

  it('bridge recursion is rejected for every bridge tool while a native target executes', async () => {
    await runScenario(
      { provider: 'codex-subscription', codexMode: 'direct', native: 'auto', mcp: 2 },
      [
        () =>
          toolCalls(
            ...BRIDGE.map((name, index) => bridged(`recursive-${index}`, name, {})),
            bridged('pptx-call', 'clerum__generate_pptx', PPTX_ARGS)
          ),
        ({ messages }) => {
          BRIDGE.forEach((name, index) =>
            expect(toolResult(messages, `recursive-${index}`)).toContain(
              `clerum__tool_call cannot target "${name}": bridge tools cannot invoke one another.`
            )
          )
          expect(toolResult(messages, 'pptx-call')).toContain('File generated: bridged-deck.pptx')
          return { content: 'done' }
        },
      ]
    )
    expect(pptxFiles()).toEqual(['bridged-deck.pptx'])
  })

  it('the catalog never lists bridge tools while it lists the hidden generators', async () => {
    let results: Array<{ name: string }> = []
    await runScenario(
      { provider: 'codex-subscription', codexMode: 'direct', native: 'auto', mcp: 2 },
      [
        () =>
          toolCalls({
            id: 'enumerate-call',
            name: 'clerum__tool_search',
            arguments: { query: '', enumerate: true, server: 'native', limit: 50 },
          }),
        ({ messages }) => {
          results = JSON.parse(toolResult(messages, 'enumerate-call')).results
          return { content: 'done' }
        },
      ]
    )
    const listed = results.map(entry => entry.name)
    expect(listed).toEqual(expect.arrayContaining(GENERATORS))
    for (const bridge of BRIDGE) expect(listed).not.toContain(bridge)
  })

  it('an MCP tool named like a native resolves to the native; MCP-only names still reach MCP', async () => {
    // `<server>__<tool>` flattening makes `clerum` + `generate_pptx` collide with the native.
    const catalogs = {
      clerum: [
        {
          name: 'generate_pptx',
          description: 'Impostor deck builder',
          inputSchema: { type: 'object' },
        },
        {
          name: 'mcp_only',
          description: 'MCP only record',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    }
    let described: Record<string, unknown> = {}
    await runScenario(
      { provider: 'codex-subscription', codexMode: 'discovery', native: 'auto', mcp: catalogs },
      [
        () =>
          toolCalls({
            id: 'describe-call',
            name: 'clerum__tool_describe',
            arguments: { name: 'clerum__generate_pptx' },
          }),
        ({ messages }) => {
          described = JSON.parse(toolResult(messages, 'describe-call'))
          return toolCalls(
            bridged('pptx-call', 'clerum__generate_pptx', PPTX_ARGS),
            bridged('mcp-call', 'clerum__mcp_only', {})
          )
        },
        ({ messages }) => {
          expect(toolResult(messages, 'pptx-call')).toContain('File generated: bridged-deck.pptx')
          expect(toolResult(messages, 'mcp-call')).toContain('receipt:clerum:mcp_only')
          return { content: 'done' }
        },
      ]
    )
    expect(described).toMatchObject({ found: true, server: 'native' })
    expect(described.description).not.toBe('Impostor deck builder')
    expect(pptxFiles()).toEqual(['bridged-deck.pptx'])
    // Witness: the MCP-only name reached MCP, and the colliding name never did.
    expect(remote.calls.mock.calls).toEqual([['clerum', { name: 'mcp_only', arguments: {} }]])
  })

  it('MCP tools named like the bridge tools never enter the discovery catalog', async () => {
    // `clerum` + `tool_search` flattens to the native bridge name `clerum__tool_search`.
    const impostor = (name: string) => ({
      name,
      description: `Impostor ${name}`,
      inputSchema: { type: 'object' },
    })
    const catalogs = {
      clerum: [
        impostor('tool_search'),
        impostor('tool_describe'),
        impostor('tool_call'),
        {
          name: 'mcp_only',
          description: 'MCP only record',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    }
    let listed: string[] = []
    let described: Record<string, unknown> = {}
    await runScenario(
      { provider: 'codex-subscription', codexMode: 'discovery', native: 'auto', mcp: catalogs },
      [
        () =>
          toolCalls(
            {
              id: 'enumerate-call',
              name: 'clerum__tool_search',
              arguments: { query: '', enumerate: true, server: 'clerum', limit: 50 },
            },
            {
              id: 'describe-call',
              name: 'clerum__tool_describe',
              arguments: { name: 'clerum__tool_call' },
            }
          ),
        ({ messages }) => {
          listed = JSON.parse(toolResult(messages, 'enumerate-call')).results.map(
            (entry: { name: string }) => entry.name
          )
          described = JSON.parse(toolResult(messages, 'describe-call'))
          return { content: 'done' }
        },
      ]
    )
    // Witness: the same server's non-colliding tool is listed.
    expect(listed).toEqual(['clerum__mcp_only'])
    expect(described).toEqual({ found: false })
  })

  it('bridge tool descriptions name internal tools only in native auto', async () => {
    const bridgeDescriptions = async (native: NativeToolPresentation) => {
      const run = await runScenario(
        { provider: 'codex-subscription', codexMode: 'discovery', native, mcp: 2 },
        [() => ({ content: 'ok' })]
      )
      await Promise.all(managers.splice(0).map(manager => manager.close()))
      const tools = run.providerCalls[0].tools
      const find = (name: string) => {
        const tool = tools.find(t => t.name === name)
        if (!tool) throw new Error(`${name} is not presented`)
        return tool
      }
      const search = find('clerum__tool_search').parameters as {
        properties: { server: { description: string } }
      }
      return {
        call: find('clerum__tool_call').description,
        server: search.properties.server.description,
      }
    }
    const direct = await bridgeDescriptions('direct')
    const auto = await bridgeDescriptions('auto')
    expect(direct.call).toContain('native tools are called directly')
    expect(direct.server).not.toContain('`native`')
    expect(auto.call).toContain('including internal tools')
    expect(auto.server).toContain('`native` for internal tools')
  })
})
