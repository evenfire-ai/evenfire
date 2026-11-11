import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { register } from 'prom-client'
import {
  hashGrokCompletionRequest,
  parseGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import {
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequest,
  parseCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { ConversationManager } from '../../core/conversation/conversation'
import type { ChatMessage, ToolDefinition } from '../../core/types'
import { logger } from '../../logger'
import type { PromptBridgeTarget } from '../../pluginWorkloadSdk/domain/types'
import { LlmBridge } from '../../pluginWorkloadSdk/promptBridge/llmBridge'
import type { ApiKeys } from '../../types'
import { FailoverSingleTurnProvider } from '../../workflow/failoverProvider'
import { WorkflowService } from '../../workflow/workflowService'
import { AzureOpenAIProvider } from '../azure'
import { ClaudeProvider } from '../claude'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { ALL_FAILOVER_CLASSES } from '../failover/classify'
import { GrokSubscriptionProvider } from '../grokSubscription'
import { createLLMProvider } from '../index'
import { OpenAIProvider } from '../openai'
import { OpenAICompatibleProvider } from '../openaiCompatible'
import { descriptorFor, makeProvider, primarySlot } from '../registry'

// Issue #1433: a lone UTF-16 surrogate in any request text made every provider
// reject the whole request with HTTP 400. makeProvider must hand out providers
// that send only well-formed text, and say so when it repairs something.

// Same deterministic request ids as subscriptionRequestHash.test.ts, so the
// golden hashes captured there are reproducible through makeProvider.
const uuid = vi.hoisted(() => ({ next: 0 }))
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid.next).padStart(12, '0')}`,
  }
})

const HIGH = '\uD83D'
const LOW = '\uDC00'
const LONE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i
const FFFD = '�'

/** Every string in `value` (keys included) is well-formed. */
function allWellFormed(value: unknown): boolean {
  if (typeof value === 'string') return value.isWellFormed()
  if (Array.isArray(value)) return value.every(allWellFormed)
  if (value && typeof value === 'object') {
    return Object.entries(value).every(([k, v]) => k.isWellFormed() && allWellFormed(v))
  }
  return true
}

async function counterValue(provider: string, role: string): Promise<number> {
  const metric = register.getSingleMetric('clerum_llm_request_text_repaired_total')
  if (!metric) return 0
  const { values } = await metric.get()
  return values.find(v => v.labels.provider === provider && v.labels.role === role)?.value ?? 0
}

// ─── Local HTTP fixtures (the real SDKs, only the network endpoint is local) ───

const servers: Server[] = []
const savedEnv: Record<string, string | undefined> = {}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete savedEnv[name]
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
})

type Capture = { bodies: string[] }

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** A server that records every raw request body and answers with `reply`. */
async function fixtureServer(reply: unknown, status = 200): Promise<{ url: string } & Capture> {
  const capture: Capture = { bodies: [] }
  const server = createServer((request, response) => {
    void readBody(request).then(body => {
      capture.bodies.push(body)
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(reply))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...capture }
}

const OPENAI_REPLY = {
  id: 'chatcmpl-fixture',
  object: 'chat.completion',
  created: 0,
  model: 'fixture-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const ANTHROPIC_REPLY = {
  id: 'msg_fixture',
  type: 'message',
  role: 'assistant',
  model: 'fixture-model',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}

async function openaiFixture(): Promise<Capture> {
  const server = await fixtureServer(OPENAI_REPLY)
  setEnv('OPENAI_BASE_URL', `${server.url}/v1`)
  return server
}

async function anthropicFixture(): Promise<Capture> {
  const server = await fixtureServer(ANTHROPIC_REPLY)
  setEnv('ANTHROPIC_BASE_URL', server.url)
  return server
}

function openaiProvider() {
  return makeProvider(
    'openai',
    { [primarySlot(descriptorFor('openai')).dataKey]: 'local-http-fixture' },
    'fixture-model'
  )
}

function claudeProvider() {
  return makeProvider(
    'claude',
    { [primarySlot(descriptorFor('claude')).dataKey]: 'local-http-fixture' },
    'fixture-model'
  )
}

// ─── Subscription fixtures (authorizer/proxy deps below the provider) ───

function subscriptionDeps() {
  const authorize = vi.fn().mockResolvedValue({
    providerAttemptId: 'attempt-1',
    requestHash: 'f'.repeat(64),
    executionTicket: 'ticket-123456',
    expiresAt: '2026-08-20T10:00:00.000Z',
  })
  const stream = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [], outcome: 'success' })
  return {
    authorizer: { authorize },
    proxy: { stream },
    attemptContext: vi.fn(() => ({ policyRevision: 1, policyHash: 'b'.repeat(64) })),
    authorize,
    stream,
  }
}

const SUBSCRIPTIONS = [
  {
    name: 'codex-subscription' as const,
    model: 'gpt-5.3-codex',
    flag: 'MCP_HOST_CODEX_SUBSCRIPTION_ENABLED',
    make: (wired: ReturnType<typeof subscriptionDeps>) =>
      makeProvider('codex-subscription', {}, 'gpt-5.3-codex', { codex: wired as never }),
    serverHash: (wire: unknown) => {
      const parsed = parseCodexCompletionRequestV1(wire)
      if (!parsed.ok) throw new Error(parsed.message)
      return hashCodexCompletionRequestV1(parsed.value)
    },
    parse: parseCodexCompletionRequestV1,
    // Same values as subscriptionRequestHash.test.ts (captured at a42dedf8).
    goldenToolsHash: 'ec9146face0ad4024b88c72906b47135e5cc986c64c700e8f1c3377dade3f4f2',
    goldenHistoryHash: 'e3c5a1f3317dd601c5aeab17c5b4914a180a5b40164059584004725701212cb2',
  },
  {
    name: 'grok-subscription' as const,
    model: 'grok-4.6',
    flag: 'MCP_HOST_GROK_SUBSCRIPTION_ENABLED',
    make: (wired: ReturnType<typeof subscriptionDeps>) =>
      makeProvider('grok-subscription', {}, 'grok-4.6', { grok: wired as never }),
    serverHash: (wire: unknown) => {
      const parsed = parseGrokCompletionRequestV1(wire)
      if (!parsed.ok) throw new Error(parsed.message)
      return hashGrokCompletionRequest(parsed.value)
    },
    parse: parseGrokCompletionRequestV1,
    goldenToolsHash: '507c127d04e04544ce92b2417e6d30c84033aef8609b501bfe305c1e61a526af',
    goldenHistoryHash: '76e9df10e95d15c489c713aa44a41163d8a346711ee97fdb9e53f4e575929b8e',
  },
]

const TOOLS: ToolDefinition[] = [
  {
    name: 'eventasks__read',
    description: 'Read a record',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['id'],
    },
  },
]

/** A tool result carrying a lone high surrogate, as the incident's page read did. */
function toolTurn(content: string): ChatMessage[] {
  return [
    { role: 'user', content: 'read the page' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', name: 'page_read', arguments: { id: 'p1' } }],
    },
    { role: 'tool', name: 'page_read', tool_call_id: 'c1', content },
  ]
}

beforeEach(() => {
  uuid.next = 0
})

describe('makeProvider sends only well-formed text (#1433)', () => {
  it('T1: repairs a lone surrogate in a tool result on the OpenAI wire, and reports it', async () => {
    const server = await openaiFixture()
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue('openai', 'tool')

    await openaiProvider().completeSingleTurnWithTools(toolTurn(`a${HIGH}b`), TOOLS)

    expect(server.bodies).toHaveLength(1)
    const body = server.bodies[0]
    expect(body).not.toMatch(LONE_ESCAPE)
    expect(allWellFormed(JSON.parse(body))).toBe(true)
    expect(body).toContain(`a${FFFD}b`)
    const repairs = warn.mock.calls.filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))
    expect(repairs).toHaveLength(1)
    expect(repairs[0][0]).toMatchObject({
      provider: 'openai',
      role: 'tool',
      toolName: 'page_read',
      toolCallId: 'c1',
      repairedUnits: 1,
    })
    // The log carries counts and identifiers, never the text itself.
    expect(JSON.stringify(repairs[0][0])).not.toContain(`a${FFFD}b`)
    expect(Object.keys(repairs[0][0]).sort()).toEqual(
      ['component', 'provider', 'repairedUnits', 'role', 'toolCallId', 'toolName'].sort()
    )
    expect(await counterValue('openai', 'tool')).toBe(before + 1)
  })

  it('T2: repairs the system prompt parts and the messages on the Anthropic cache path', async () => {
    const server = await anthropicFixture()
    const warn = vi.spyOn(logger, 'warn')
    const provider = claudeProvider()
    expect(provider.completeSingleTurnWithToolsAndCache).toBeTypeOf('function')

    await provider.completeSingleTurnWithToolsAndCache!(
      {
        stable: `x${LOW}y`,
        context: 'ctx',
        stableHash: 'a'.repeat(64),
        contextHash: 'b'.repeat(64),
      },
      toolTurn(`a${HIGH}b`),
      TOOLS
    )

    expect(server.bodies).toHaveLength(1)
    const body = server.bodies[0]
    expect(body).not.toMatch(LONE_ESCAPE)
    expect(allWellFormed(JSON.parse(body))).toBe(true)
    expect(body).toContain(`x${FFFD}y`)
    expect(body).toContain(`a${FFFD}b`)
    const roles = warn.mock.calls
      .filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))
      .map(([fields]) => (fields as { role: string }).role)
      .sort()
    expect(roles).toEqual(['system_prompt', 'tool'])
  })

  it.each(SUBSCRIPTIONS)(
    'T3: $name authorizes and streams the repaired request with a matching hash',
    async p => {
      setEnv(p.flag, 'true')
      const wired = subscriptionDeps()

      await p.make(wired).completeSingleTurnWithTools(toolTurn(`a${HIGH}b`), TOOLS)

      expect(wired.authorize).toHaveBeenCalledTimes(1)
      expect(wired.stream).toHaveBeenCalledTimes(1)
      const authorized = wired.authorize.mock.calls[0][0]
      const streamed = wired.stream.mock.calls[0][0].request
      expect(JSON.stringify(streamed)).not.toMatch(LONE_ESCAPE)
      expect(allWellFormed(streamed)).toBe(true)
      expect(JSON.stringify(streamed)).toContain(`a${FFFD}b`)
      expect(p.serverHash(JSON.parse(JSON.stringify(authorized)).request)).toBe(
        authorized.requestHash
      )
    }
  )

  it.each(SUBSCRIPTIONS)(
    'T4: $name keeps the golden hashes for well-formed requests built by makeProvider',
    async p => {
      setEnv(p.flag, 'true')
      const warn = vi.spyOn(logger, 'warn')

      const tools = subscriptionDeps()
      await p
        .make(tools)
        .completeSingleTurnWithTools([{ role: 'user', content: 'find it' }], TOOLS, {
          temperature: 0.2,
          max_tokens: 512,
          tool_choice: 'auto',
        })
      expect(tools.authorize).toHaveBeenCalledTimes(1)
      expect(tools.authorize.mock.calls[0][0].requestHash).toBe(p.goldenToolsHash)

      uuid.next = 0
      const history = subscriptionDeps()
      await p.make(history).completeSingleTurnWithTools(
        [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'café 漢字 🎵' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call-1', name: 'eventasks__read', arguments: { id: 'A-1' } }],
          },
          { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1', name: 'eventasks__read' },
        ],
        TOOLS
      )
      expect(history.authorize).toHaveBeenCalledTimes(1)
      expect(history.authorize.mock.calls[0][0].requestHash).toBe(p.goldenHistoryHash)
      expect(warn.mock.calls.filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))).toHaveLength(
        0
      )
    }
  )

  it('T4: leaves valid surrogate pairs untouched, passing the same references through', async () => {
    const server = await openaiFixture()
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue('openai', 'user')
    // The spy must exist before makeProvider: the wrap binds the method at construction.
    const inner = vi.spyOn(OpenAIProvider.prototype, 'completeSingleTurnWithTools')
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a😀b' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'page_read', arguments: { q: '😀' } }],
      },
      { role: 'tool', name: 'page_read', tool_call_id: 'c1', content: 'ok 😀' },
    ]
    const tools: ToolDefinition[] = [{ ...TOOLS[0], description: 'Read 😀' }]

    await openaiProvider().completeSingleTurnWithTools(messages, tools)
    await new OpenAIProvider('local-http-fixture', 'fixture-model').completeSingleTurnWithTools(
      messages,
      tools
    )

    expect(inner).toHaveBeenCalledTimes(2)
    expect(inner.mock.calls[0][0]).toBe(messages)
    expect(inner.mock.calls[0][1]).toBe(tools)
    expect(server.bodies).toHaveLength(2)
    expect(server.bodies[0]).toBe(server.bodies[1])
    expect(warn.mock.calls.filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))).toHaveLength(0)
    expect(await counterValue('openai', 'user')).toBe(before)
  })

  it('T5: repairs every text field and keeps image bytes, without mutating the inputs', async () => {
    const inner = vi
      .spyOn(OpenAIProvider.prototype, 'completeSingleTurnWithTools')
      .mockResolvedValue({ content: 'ok', tool_calls: null, finish_reason: 'stop' } as never)
    const imageData = Buffer.from('not really a png').toString('base64')
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: `see ${HIGH}`,
        contentParts: [
          { type: 'text', text: `see ${HIGH}` },
          {
            type: 'image',
            mimeType: 'image/png',
            data: imageData,
            source: { kind: 'attachment', attachmentId: `att${LOW}`, messageId: 'm1' },
          },
        ],
      },
      {
        role: 'assistant',
        content: '',
        reasoning_content: `why${HIGH}`,
        tool_calls: [{ id: 'c1', name: 'page_read', arguments: { [`k${HIGH}`]: `v${LOW}`, n: 3 } }],
      },
      { role: 'tool', name: 'page_read', tool_call_id: 'c1', content: 'ok' },
    ]
    const tools: ToolDefinition[] = [
      {
        name: 'page_read',
        description: `Read${HIGH}`,
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: `id${LOW}` } },
        },
      },
    ]
    const snapshot = structuredClone({ messages, tools })

    await openaiProvider().completeSingleTurnWithTools(messages, tools)

    expect(inner).toHaveBeenCalledTimes(1)
    const [sentMessages, sentTools] = inner.mock.calls[0] as [ChatMessage[], ToolDefinition[]]
    expect(allWellFormed(sentMessages)).toBe(true)
    expect(allWellFormed(sentTools)).toBe(true)
    const user = sentMessages[0]
    expect(user.content).toBe(`see ${FFFD}`)
    expect(user.contentParts?.[0]).toEqual({ type: 'text', text: `see ${FFFD}` })
    const image = user.contentParts?.[1]
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png', data: imageData })
    expect(image && image.type === 'image' && image.source).toEqual({
      kind: 'attachment',
      attachmentId: `att${FFFD}`,
      messageId: 'm1',
    })
    expect(sentMessages[1].reasoning_content).toBe(`why${FFFD}`)
    expect(sentMessages[1].tool_calls?.[0].arguments).toEqual({ [`k${FFFD}`]: `v${FFFD}`, n: 3 })
    expect(sentMessages[2]).toBe(messages[2])
    expect(sentTools[0].description).toBe(`Read${FFFD}`)
    expect(sentTools[0].parameters).toEqual({
      type: 'object',
      properties: { id: { type: 'string', description: `id${FFFD}` } },
    })
    // Inputs are untouched.
    expect({ messages, tools }).toEqual(snapshot)
  })

  it('T6: keeps the class, the provider type and exactly the optional methods the class has', () => {
    setEnv('MCP_HOST_CODEX_SUBSCRIPTION_ENABLED', 'true')
    setEnv('MCP_HOST_GROK_SUBSCRIPTION_ENABLED', 'true')
    const key = (id: Parameters<typeof descriptorFor>[0]) => ({
      [primarySlot(descriptorFor(id)).dataKey]: 'local-http-fixture',
    })
    const arms = [
      { id: 'openai', cls: OpenAIProvider, make: () => makeProvider('openai', key('openai'), 'm') },
      { id: 'claude', cls: ClaudeProvider, make: () => makeProvider('claude', key('claude'), 'm') },
      {
        id: 'azure',
        cls: AzureOpenAIProvider,
        make: () =>
          makeProvider('azure', key('azure'), 'm', {
            env: (name: string) =>
              name === 'AZURE_OPENAI_ENDPOINT' ? 'https://fixture.openai.azure.com' : undefined,
          }),
      },
      {
        id: 'zai',
        cls: OpenAICompatibleProvider,
        make: () => makeProvider('zai', key('zai'), 'm'),
      },
      {
        id: 'codex-subscription',
        cls: CodexSubscriptionProvider,
        make: () =>
          makeProvider('codex-subscription', {}, 'm', { codex: subscriptionDeps() as never }),
      },
      {
        id: 'grok-subscription',
        cls: GrokSubscriptionProvider,
        make: () =>
          makeProvider('grok-subscription', {}, 'm', { grok: subscriptionDeps() as never }),
      },
    ] as const
    const optional = ['completeSingleTurnAndCache', 'completeSingleTurnWithToolsAndCache'] as const

    for (const arm of arms) {
      const provider = arm.make()
      expect(provider, arm.id).toBeInstanceOf(arm.cls)
      expect(provider.getProviderType(), arm.id).toBe(arm.id)
      for (const method of optional) {
        const onClass =
          typeof (arm.cls.prototype as unknown as Record<string, unknown>)[method] === 'function'
        expect(method in provider, `${arm.id}.${method}`).toBe(onClass)
        expect(typeof provider[method] === 'function', `${arm.id}.${method}`).toBe(onClass)
      }
      // The wrap is an own property only for the request methods.
      expect(Object.prototype.hasOwnProperty.call(provider, 'completeSingleTurn'), arm.id).toBe(
        true
      )
      expect(Object.prototype.hasOwnProperty.call(provider, 'classifyError'), arm.id).toBe(false)
    }
  })

  it('T8: repairs Codex user content parts; the parts are the discriminating value', async () => {
    setEnv('MCP_HOST_CODEX_SUBSCRIPTION_ENABLED', 'true')
    const wired = subscriptionDeps()
    const parts = [`x${HIGH}`, `${'\uDE00'}y`]

    await makeProvider('codex-subscription', {}, 'gpt-5.3-codex', {
      codex: wired as never,
    }).completeSingleTurn([
      {
        role: 'user',
        content: parts.join('\n'),
        contentParts: parts.map(text => ({ type: 'text' as const, text })),
      },
    ])

    expect(wired.stream).toHaveBeenCalledTimes(1)
    const request = wired.stream.mock.calls[0][0].request
    const sent = request.messages[0].contentParts.map((part: { text: string }) => part.text)
    expect(sent).toEqual([`x${FFFD}`, `${FFFD}y`])
    expect(request.messages[0].content).toBe(sent.join('\n'))
    expect(parseCodexCompletionRequest(JSON.parse(JSON.stringify(request)))).toMatchObject({
      ok: true,
    })
  })
})

// ─── Callers that reach a provider without LlmPortAdapter ───
// Each one builds its provider through the real factory. An injected fake
// provider would survive the vacuity mutation, so none is used here.

describe('callers outside the adapter get repaired providers (#1433)', () => {
  it('T7a: WorkflowService with its default LLM factory', async () => {
    const server = await openaiFixture()
    const svc = new WorkflowService('wf-recipe-12345', {
      mcpClientFactory: () => ({
        connect: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue([]),
        callTool: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
      }),
    })
    svc.configure({ provider: 'openai', model: 'fixture-model', apiKey: 'local-http-fixture' })

    const result = await svc.executeStep({ stepId: 's1', instruction: `summarize ${HIGH}page` })

    expect(result).toMatchObject({ status: 'completed' })
    expect(server.bodies.length).toBeGreaterThanOrEqual(1)
    for (const body of server.bodies) {
      expect(body).not.toMatch(LONE_ESCAPE)
      expect(allWellFormed(JSON.parse(body))).toBe(true)
    }
    expect(server.bodies.join('')).toContain(`summarize ${FFFD}page`)
  })

  it('T7b: FailoverSingleTurnProvider over real providers repairs on primary and fallback', async () => {
    const primaryServer = await fixtureServer({ error: { message: 'overloaded' } }, 503)
    setEnv('OPENAI_BASE_URL', `${primaryServer.url}/v1`)
    const fallbackServer = await anthropicFixture()
    const keys = (provider: 'openai' | 'claude'): ApiKeys =>
      ({
        [provider]: { [primarySlot(descriptorFor(provider)).dataKey]: 'local-http-fixture' },
      }) as ApiKeys
    const primary = createLLMProvider(keys('openai'), { provider: 'openai', name: 'fixture-model' })
    expect(primary).not.toBeNull()
    const failover = new FailoverSingleTurnProvider({
      primary: primary!,
      primaryPair: { provider: 'openai', model: 'fixture-model' },
      policy: {
        cooldownSeconds: 60,
        triggerOn: [...ALL_FAILOVER_CLASSES],
        fallbacks: [{ provider: 'claude', model: 'fixture-model', apiKey: 'local-http-fixture' }],
      },
      buildFallback: entry =>
        createLLMProvider(keys(entry.provider as 'claude'), {
          provider: entry.provider as 'claude',
          name: entry.model,
        }),
    })

    await failover.completeSingleTurn([{ role: 'user', content: `hi ${HIGH}` }])

    expect(primaryServer.bodies.length).toBeGreaterThanOrEqual(1)
    expect(fallbackServer.bodies).toHaveLength(1)
    for (const body of [...primaryServer.bodies, ...fallbackServer.bodies]) {
      expect(body).not.toMatch(LONE_ESCAPE)
      expect(body).toContain(`hi ${FFFD}`)
    }
  })

  it('T7c: LlmBridge with the real createLLMProvider', async () => {
    const server = await openaiFixture()
    const target: PromptBridgeTarget = {
      targetRef: 'primary-openai',
      provider: 'openai',
      model: 'fixture-model',
      credentialSlot: 'openai-api-key',
    }
    const bridge = new LlmBridge(
      {
        resolve: vi.fn(async () => ({
          target,
          keys: {
            openai: { [primarySlot(descriptorFor('openai')).dataKey]: 'local-http-fixture' },
          } as ApiKeys,
          llmSecretName: 'openai-secret',
        })),
      },
      { createProvider: createLLMProvider }
    )

    const result = await bridge.complete({
      invocationId: 'inv-1',
      attemptGeneration: 1,
      targets: [{ target }],
      policyRevision: 1,
      policyHash: 'a'.repeat(64),
      credentialTicketIssuer: { issue: vi.fn(async () => ({ credentialTicket: 'fresh' })) },
      messages: [{ role: 'user', content: `bridge ${HIGH}` }],
      timeoutMs: 5_000,
    })

    expect(result.content).toBe('ok')
    expect(server.bodies).toHaveLength(1)
    expect(server.bodies[0]).not.toMatch(LONE_ESCAPE)
    expect(server.bodies[0]).toContain(`bridge ${FFFD}`)
  })
})

describe('a stored user message with a lone surrogate does not poison the session (#1433)', () => {
  it('T9: both turns complete and the replayed history is repaired; the store is not rewritten', async () => {
    const server = await openaiFixture()
    const manager = new ConversationManager()
    const adapter = new LlmPortAdapter(openaiProvider(), 'fixture-model', 'openai')
    const conversation = await manager.getOrCreate('t9-user:rpc:t9-agent:chat')

    await manager.startTurn(conversation, `hi ${HIGH}`, 'task-1')
    const first = await adapter.complete({ messages: manager.buildMessageHistory(conversation) })
    await manager.completeTurn(conversation, first.content ?? '')

    await manager.startTurn(conversation, 'and again', 'task-2')
    const second = await adapter.complete({ messages: manager.buildMessageHistory(conversation) })
    await manager.completeTurn(conversation, second.content ?? '')

    expect(server.bodies).toHaveLength(2)
    for (const body of server.bodies) {
      expect(body).not.toMatch(LONE_ESCAPE)
      expect(allWellFormed(JSON.parse(body))).toBe(true)
    }
    // Witness that turn 1 was replayed in turn 2, repaired on the wire.
    expect(server.bodies[1]).toContain(`hi ${FFFD}`)
    expect(server.bodies[1]).toContain('and again')
    expect(conversation.turns[0].user_input).toBe(`hi ${HIGH}`)
  })
})
