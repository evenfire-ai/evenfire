import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import net, { type AddressInfo } from 'node:net'
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
import { LlmErrorCode } from '../../core/errors'
import type { ChatMessage, ToolDefinition } from '../../core/types'
import { logger } from '../../logger'
import type { PromptBridgeTarget } from '../../pluginWorkloadSdk/domain/types'
import { LlmBridge } from '../../pluginWorkloadSdk/promptBridge/llmBridge'
import type { ApiKeys } from '../../types'
import { FailoverSingleTurnProvider } from '../../workflow/failoverProvider'
import { WorkflowService } from '../../workflow/workflowService'
import { ClaudeProvider } from '../claude'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { ALL_FAILOVER_CLASSES, classifyFailoverClass } from '../failover/classify'
import { GrokSubscriptionProvider } from '../grokSubscription'
import { createLLMProvider } from '../index'
import { OpenAIProvider } from '../openai'
import { descriptorFor, makeProvider, primarySlot } from '../registry'
import type { SingleTurnProvider } from '../types'
import { RequestTextKeyCollisionError } from '../wellFormedRequestText'
import { installLoopbackOnlyNetwork } from './loopbackOnlyNetwork'

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

/** A throwaway service account: the key is generated here, never stored. */
function vertexCredentials(): Record<string, string> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return {
    'vertex-service-account-json': JSON.stringify({
      client_email: 'fixture@fixture-project.iam.gserviceaccount.com',
      private_key: privateKey,
      project_id: 'fixture-project',
    }),
  }
}

function bedrockCredentials(): Record<string, string> {
  return { 'aws-access-key-id': 'AKIAFIXTURE', 'aws-secret-access-key': 'fixture-secret' }
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
  // Every test here drives real SDKs; nothing may leave the loopback interface.
  installLoopbackOnlyNetwork()
})

it('the loopback-only guard refuses a non-loopback connection (witness)', () => {
  expect(() => net.connect({ host: '203.0.113.1', port: 9 })).toThrow(/loopback-only test network/)
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

  it('T2: repairs system parts, messages and tools on the Anthropic cache path with tools', async () => {
    const server = await anthropicFixture()
    const warn = vi.spyOn(logger, 'warn')
    const provider = claudeProvider()
    expect(provider.completeSingleTurnWithToolsAndCache).toBeTypeOf('function')

    await provider.completeSingleTurnWithToolsAndCache!(
      {
        stable: `x${LOW}y`,
        context: `c${HIGH}d`,
        stableHash: 'a'.repeat(64),
        contextHash: 'b'.repeat(64),
      },
      toolTurn(`a${HIGH}b`),
      [{ ...TOOLS[0], description: `Read${HIGH}` }]
    )

    expect(server.bodies).toHaveLength(1)
    const body = server.bodies[0]
    expect(body).not.toMatch(LONE_ESCAPE)
    expect(allWellFormed(JSON.parse(body))).toBe(true)
    expect(body).toContain(`x${FFFD}y`)
    expect(body).toContain(`c${FFFD}d`)
    expect(body).toContain(`a${FFFD}b`)
    expect(body).toContain(`Read${FFFD}`)
    const roles = warn.mock.calls
      .filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))
      .map(([fields]) => (fields as { role: string }).role)
      .sort()
    expect(roles).toEqual(['system_prompt', 'tool', 'tool_definition'])
  })

  it('T20: repairs system parts and messages on the Anthropic cache path without tools', async () => {
    const server = await anthropicFixture()
    const warn = vi.spyOn(logger, 'warn')
    const provider = claudeProvider()
    expect(provider.completeSingleTurnAndCache).toBeTypeOf('function')

    await provider.completeSingleTurnAndCache!(
      {
        stable: `x${LOW}y`,
        context: `c${HIGH}d`,
        stableHash: 'a'.repeat(64),
        contextHash: 'b'.repeat(64),
      },
      [{ role: 'user', content: `a${HIGH}b` }]
    )

    expect(server.bodies).toHaveLength(1)
    const body = server.bodies[0]
    expect(body).not.toMatch(LONE_ESCAPE)
    expect(body).toContain(`x${FFFD}y`)
    expect(body).toContain(`c${FFFD}d`)
    expect(body).toContain(`a${FFFD}b`)
    const repairs = warn.mock.calls
      .filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))
      .map(([fields]) => fields as { role: string; repairedUnits: number })
      .sort((a, b) => a.role.localeCompare(b.role))
    expect(repairs.map(r => r.role)).toEqual(['system_prompt', 'user'])
    expect(repairs[0].repairedUnits).toBe(2)
  })

  it('T21: reports a repaired tool definition once, with its unit count and counter', async () => {
    const server = await openaiFixture()
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue('openai', 'tool_definition')

    await openaiProvider().completeSingleTurnWithTools(
      [{ role: 'user', content: 'list pages' }],
      [
        {
          name: 'page_read',
          description: `Read${HIGH}`,
          parameters: {
            type: 'object',
            properties: { id: { type: 'string', description: `id${LOW}` } },
          },
        },
      ]
    )

    expect(server.bodies).toHaveLength(1)
    expect(server.bodies[0]).toContain(`Read${FFFD}`)
    const repairs = warn.mock.calls.filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))
    expect(repairs).toHaveLength(1)
    expect(repairs[0][0]).toEqual({
      component: 'LLM',
      provider: 'openai',
      role: 'tool_definition',
      toolName: 'page_read',
      repairedUnits: 2,
    })
    expect(await counterValue('openai', 'tool_definition')).toBe(before + 2)
  })

  it('T22: counts every repaired unit in a message', async () => {
    const server = await openaiFixture()
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue('openai', 'tool')

    await openaiProvider().completeSingleTurnWithTools(toolTurn(`a${HIGH}b${LOW}c${HIGH}`), TOOLS)

    expect(server.bodies).toHaveLength(1)
    expect(server.bodies[0]).toContain(`a${FFFD}b${FFFD}c${FFFD}`)
    const repairs = warn.mock.calls.filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))
    expect(repairs).toHaveLength(1)
    expect(repairs[0][0]).toMatchObject({ role: 'tool', repairedUnits: 3 })
    expect(await counterValue('openai', 'tool')).toBe(before + 3)
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
      const provider = p.make(history)
      await provider.completeSingleTurnWithTools(
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

      // Liveness witness: the same instance does repair, so the unchanged
      // requests above went through the wrap rather than around it.
      await provider.completeSingleTurnWithTools(toolTurn(`a${HIGH}b`), TOOLS)
      expect(history.stream).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(history.stream.mock.calls[1][0].request)).toContain(`a${FFFD}b`)
      expect(warn.mock.calls.filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))).toHaveLength(
        1
      )
    }
  )

  it('T4b: leaves valid surrogate pairs untouched, passing the same references through', async () => {
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

    const wrapped = openaiProvider()
    await wrapped.completeSingleTurnWithTools(messages, tools)
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

    // Liveness witness: the same instance does repair a lone unit.
    await wrapped.completeSingleTurnWithTools(toolTurn(`a${HIGH}b`), tools)
    expect(server.bodies).toHaveLength(3)
    expect(server.bodies[2]).toContain(`a${FFFD}b`)
    expect(warn.mock.calls.filter(([, msg]) => /lone UTF-16 surrogates/.test(msg))).toHaveLength(1)
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

  it('T5b: an own "__proto__" key and a null prototype survive the repair of a sibling', async () => {
    const inner = vi
      .spyOn(OpenAIProvider.prototype, 'completeSingleTurnWithTools')
      .mockResolvedValue({ content: 'ok', tool_calls: null, finish_reason: 'stop' } as never)
    // JSON.parse makes "__proto__" an ordinary own key, as decoded tool arguments have it.
    const withProtoKey = JSON.parse(`{"__proto__":"keep","k":"v\\ud83d"}`) as Record<
      string,
      unknown
    >
    expect(Object.keys(withProtoKey)).toEqual(['__proto__', 'k'])
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, {
      k: `v${HIGH}`,
    })
    const tool_calls = [
      { id: 'c1', name: 'page_read', arguments: withProtoKey },
      { id: 'c2', name: 'page_read', arguments: nullProto },
    ]

    await openaiProvider().completeSingleTurnWithTools(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls },
      ],
      TOOLS
    )

    expect(inner).toHaveBeenCalledTimes(1)
    const sent = (inner.mock.calls[0][0] as ChatMessage[])[1].tool_calls!
    const sentProtoKey = sent[0].arguments
    // Witness that the object was rebuilt: the sibling is repaired in a copy.
    expect(sentProtoKey).not.toBe(withProtoKey)
    expect(sentProtoKey.k).toBe(`v${FFFD}`)
    expect(Object.keys(sentProtoKey)).toEqual(['__proto__', 'k'])
    expect(Object.getOwnPropertyDescriptor(sentProtoKey, '__proto__')).toEqual({
      value: 'keep',
      enumerable: true,
      writable: true,
      configurable: true,
    })
    expect(Object.getPrototypeOf(sentProtoKey)).toBe(Object.prototype)
    expect(JSON.stringify(sentProtoKey)).toBe(`{"__proto__":"keep","k":"v${FFFD}"}`)
    const sentNullProto = sent[1].arguments
    expect(sentNullProto).not.toBe(nullProto)
    expect(sentNullProto.k).toBe(`v${FFFD}`)
    expect(Object.getPrototypeOf(sentNullProto)).toBeNull()
  })

  it('T6/T14: every makeProvider arm keeps its type, its optional methods and its own keys', () => {
    setEnv('MCP_HOST_CODEX_SUBSCRIPTION_ENABLED', 'true')
    setEnv('MCP_HOST_GROK_SUBSCRIPTION_ENABLED', 'true')
    const key = (id: Parameters<typeof descriptorFor>[0]) => ({
      [primarySlot(descriptorFor(id)).dataKey]: 'local-http-fixture',
    })
    const codexDeps = subscriptionDeps()
    const grokDeps = subscriptionDeps()
    // `bare` is the same class built without makeProvider, only for classes that
    // exist on both sides of the OpenAI driver-family refactor.
    const arms: Array<{ id: string; make: () => SingleTurnProvider; bare?: () => object }> = [
      {
        id: 'openai',
        make: () => makeProvider('openai', key('openai'), 'm'),
        bare: () => new OpenAIProvider('local-http-fixture', 'm'),
      },
      {
        id: 'claude',
        make: () => makeProvider('claude', key('claude'), 'm'),
        bare: () => new ClaudeProvider('local-http-fixture', 'm'),
      },
      {
        id: 'azure',
        make: () =>
          makeProvider('azure', key('azure'), 'm', {
            env: (name: string) =>
              name === 'AZURE_OPENAI_ENDPOINT' ? 'https://fixture.openai.azure.com' : undefined,
          }),
      },
      { id: 'zai', make: () => makeProvider('zai', key('zai'), 'm') },
      {
        id: 'codex-subscription',
        make: () => makeProvider('codex-subscription', {}, 'm', { codex: codexDeps as never }),
        bare: () => new CodexSubscriptionProvider('m', codexDeps as never),
      },
      {
        id: 'grok-subscription',
        make: () => makeProvider('grok-subscription', {}, 'm', { grok: grokDeps as never }),
        bare: () => new GrokSubscriptionProvider('m', grokDeps as never),
      },
      {
        id: 'vertex',
        make: () => makeProvider('vertex', vertexCredentials(), 'gemini-fixture'),
      },
      {
        id: 'bedrock',
        make: () =>
          makeProvider('bedrock', bedrockCredentials(), 'bedrock-fixture', {
            env: (name: string) => (name === 'AWS_REGION' ? 'us-east-1' : undefined),
          }),
      },
    ]
    const requestMethods = [
      'completeSingleTurn',
      'completeSingleTurnWithTools',
      'completeSingleTurnAndCache',
      'completeSingleTurnWithToolsAndCache',
    ] as const

    for (const arm of arms) {
      const provider = arm.make()
      const proto = Object.getPrototypeOf(provider) as Record<string, unknown>
      expect(provider.getProviderType(), arm.id).toBe(arm.id)
      for (const method of requestMethods) {
        const onClass = typeof proto[method] === 'function'
        // Optional methods the class lacks stay absent.
        expect(method in provider, `${arm.id}.${method}`).toBe(onClass)
        const own = Object.getOwnPropertyDescriptor(provider, method)
        if (onClass) {
          // Wrapped (witness that the wrap ran), as a non-enumerable own method.
          expect(own, `${arm.id}.${method}`).toBeDefined()
          expect(own?.enumerable, `${arm.id}.${method}`).toBe(false)
          expect(typeof own?.value, `${arm.id}.${method}`).toBe('function')
        } else {
          expect(own, `${arm.id}.${method}`).toBeUndefined()
        }
      }
      const classify = Object.getOwnPropertyDescriptor(provider, 'classifyError')
      expect(classify?.enumerable, `${arm.id}.classifyError`).toBe(false)
      // The wrap adds no enumerable own key (#1419 compares Object.keys).
      for (const name of [...requestMethods, 'classifyError']) {
        expect(Object.keys(provider), arm.id).not.toContain(name)
      }
      if (arm.bare) {
        const bare = arm.bare()
        expect(Object.keys(provider).sort(), arm.id).toEqual(Object.keys(bare).sort())
        // The wrapped provider is still an instance of its class.
        expect(provider, arm.id).toBeInstanceOf(bare.constructor)
      }
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
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue('openai', 'user')
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
    // The adapter's plain path is completeSingleTurn: each call reports the
    // repair of the stored message, on the first turn and on its replay.
    const repair = { component: 'LLM', provider: 'openai', role: 'user', repairedUnits: 1 }
    expect(repairWarns(warn)).toEqual([repair, repair])
    expect(await counterValue('openai', 'user')).toBe(before + 2)
  })
})

// ─── F1: no nesting depth makes the repair fail ───

/** A plain-object chain `depth` levels deep whose innermost value is `{ leaf }`. */
function nested(depth: number, leaf: unknown): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf }
  for (let i = 0; i < depth; i++) value = { n: value }
  return value
}

/** The innermost `leaf` of a chain built by `nested`, read with a loop. */
function innermostLeaf(value: unknown): unknown {
  let node = value as Record<string, unknown>
  while ('n' in node) node = node.n as Record<string, unknown>
  return node.leaf
}

async function settle(attempt: Promise<unknown>): Promise<unknown> {
  return attempt.then(
    () => undefined,
    (caught: unknown) => caught
  )
}

function repairWarns(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return warn.mock.calls
    .filter(([, msg]) => /lone UTF-16 surrogates/.test(String(msg)))
    .map(([fields]) => fields as Record<string, unknown>)
}

describe('deeply nested and cyclic input (#1433 F1)', () => {
  it.each(SUBSCRIPTIONS)(
    "T10: $name keeps the provider's typed refusal for a 150000-deep schema and arguments",
    async p => {
      setEnv(p.flag, 'true')
      for (const shape of ['schema', 'arguments'] as const) {
        const wired = subscriptionDeps()
        const provider = p.make(wired)
        const deep = nested(150000, 'x')
        let attempt: Promise<unknown> | undefined
        // A synchronous throw would escape this call; the wrap must reject instead.
        expect(() => {
          attempt =
            shape === 'schema'
              ? provider.completeSingleTurnWithTools(
                  [{ role: 'user', content: 'hi' }],
                  [{ name: 'deep', description: 'deep', parameters: deep }]
                )
              : provider.completeSingleTurnWithTools(
                  [
                    { role: 'user', content: 'hi' },
                    {
                      role: 'assistant',
                      content: '',
                      tool_calls: [{ id: 'c1', name: 'eventasks__read', arguments: deep }],
                    },
                    { role: 'tool', name: 'eventasks__read', tool_call_id: 'c1', content: 'ok' },
                  ],
                  TOOLS
                )
        }).not.toThrow()
        const err = await settle(attempt!)
        // The refusal comes from the provider's own bounded parser, not a RangeError.
        expect(err, shape).toMatchObject({ code: 'invalid_request' })
        expect(String((err as Error).message), shape).toMatch(/nesting depth/)
        expect(wired.authorize, shape).not.toHaveBeenCalled()
        expect(wired.stream, shape).not.toHaveBeenCalled()
        expect(provider.classifyError(err), shape).toMatchObject({
          retryable: false,
          providerDispatched: false,
        })
      }
      // Witness: the same provider dispatches a shallow request.
      const wired = subscriptionDeps()
      await p.make(wired).completeSingleTurnWithTools([{ role: 'user', content: 'hi' }], TOOLS)
      expect(wired.authorize).toHaveBeenCalledTimes(1)
    }
  )

  it('T11: walks a 150000-deep schema, passing it unchanged or repairing its bottom', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const inner = vi
      .spyOn(OpenAIProvider.prototype, 'completeSingleTurnWithTools')
      .mockResolvedValue({ content: 'ok', tool_calls: null, finish_reason: 'stop' } as never)
    const provider = openaiProvider()

    const wellFormed = [{ name: 'deep', description: 'deep', parameters: nested(150000, 'x') }]
    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'hi' }], wellFormed)
    expect(inner).toHaveBeenCalledTimes(1)
    expect(inner.mock.calls[0][1]).toBe(wellFormed)

    const broken = nested(150000, `x${HIGH}`)
    const tools = [{ name: 'deep', description: 'deep', parameters: broken }]
    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'hi' }], tools)
    expect(inner).toHaveBeenCalledTimes(2)
    const sent = inner.mock.calls[1][1] as ToolDefinition[]
    // Reference comparison by hand: a failing `.not.toBe` on a 150000-deep
    // value makes Vitest's deep equality overflow while it formats the message.
    expect(sent === tools).toBe(false)
    expect(innermostLeaf(sent[0].parameters)).toBe(`x${FFFD}`)
    // The caller's input is not mutated.
    expect(innermostLeaf(broken)).toBe(`x${HIGH}`)
    const repairs = repairWarns(warn)
    expect(repairs).toHaveLength(1)
    expect(repairs[0]).toMatchObject({ role: 'tool_definition', repairedUnits: 1 })
  })

  it('T12: a cyclic schema keeps its back-edge as is; its other strings are repaired', async () => {
    const inner = vi
      .spyOn(OpenAIProvider.prototype, 'completeSingleTurnWithTools')
      .mockResolvedValue({ content: 'ok', tool_calls: null, finish_reason: 'stop' } as never)
    const cyclic: Record<string, unknown> = { type: 'object', description: `d${HIGH}` }
    cyclic.child = { back: cyclic }

    await openaiProvider().completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'cyclic', description: 'cyclic', parameters: cyclic }]
    )

    expect(inner).toHaveBeenCalledTimes(1)
    const sent = (inner.mock.calls[0][1] as ToolDefinition[])[0].parameters as Record<
      string,
      Record<string, unknown>
    >
    expect(sent).not.toBe(cyclic)
    expect(sent.description).toBe(`d${FFFD}`)
    // The back-edge still points at the original container: it was not entered.
    expect(sent.child.back).toBe(cyclic)
  })

  it('T12b: a sub-object referenced twice is repaired at both references', async () => {
    const inner = vi
      .spyOn(OpenAIProvider.prototype, 'completeSingleTurnWithTools')
      .mockResolvedValue({ content: 'ok', tool_calls: null, finish_reason: 'stop' } as never)
    const warn = vi.spyOn(logger, 'warn')
    const shared = { type: 'string', description: `d${HIGH}` }

    await openaiProvider().completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [
        {
          name: 'shared',
          description: 'shared',
          parameters: { type: 'object', properties: { a: shared, b: shared } },
        },
      ]
    )

    expect(inner).toHaveBeenCalledTimes(1)
    const sent = (inner.mock.calls[0][1] as ToolDefinition[])[0].parameters
    expect(sent).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', description: `d${FFFD}` },
        b: { type: 'string', description: `d${FFFD}` },
      },
    })
    expect(allWellFormed(sent)).toBe(true)
    // Each reference is walked, so the lone unit is counted once per reference.
    const repairs = repairWarns(warn)
    expect(repairs).toHaveLength(1)
    expect(repairs[0]).toMatchObject({ role: 'tool_definition', repairedUnits: 2 })
    // The shared input is untouched.
    expect(shared.description).toBe(`d${HIGH}`)
  })
})

// ─── F3: a repair that would merge two keys refuses the request ───

function argumentsTurn(args: Record<string, unknown>): ChatMessage[] {
  return [
    { role: 'user', content: 'read the page' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', name: 'page_read', arguments: args }],
    },
    { role: 'tool', name: 'page_read', tool_call_id: 'c1', content: 'ok' },
  ]
}

const COLLIDING_ARGS = (): Record<string, unknown> => ({
  [`k${HIGH}`]: 'first',
  [`k${LOW}`]: 'second',
})

describe('keys that become equal after repair (#1433 F3)', () => {
  it('T13/T15: two keys that repair to the same text are refused as a rejected promise', async () => {
    const server = await openaiFixture()
    const provider = openaiProvider()

    let attempt: Promise<unknown> | undefined
    expect(() => {
      attempt = provider.completeSingleTurnWithTools(argumentsTurn(COLLIDING_ARGS()), TOOLS)
    }).not.toThrow()
    const err = await settle(attempt!)

    expect(err).toBeInstanceOf(RequestTextKeyCollisionError)
    expect(err).toMatchObject({ provider: 'openai', role: 'assistant' })
    const message = (err as Error).message
    expect(message).toMatch(/the assistant message has object keys that become identical/)
    expect(message).not.toMatch(/first|second/)
    expect(server.bodies).toHaveLength(0)
    expect(provider.classifyError(err)).toEqual({
      code: LlmErrorCode.RequestTextRejected,
      retryable: false,
      message,
      providerCode: 'request_text_key_collision',
      providerDispatched: false,
    })
    expect(classifyFailoverClass(LlmErrorCode.RequestTextRejected, false)).toBeNull()

    // Witness: the same instance sends a request whose keys stay distinct.
    await provider.completeSingleTurnWithTools(argumentsTurn({ k: 'only' }), TOOLS)
    expect(server.bodies).toHaveLength(1)
  })

  it('T15b: a refused request reports no repair, even when an earlier message was repaired', async () => {
    const server = await openaiFixture()
    const warn = vi.spyOn(logger, 'warn')
    const before = await counterValue('openai', 'user')
    const provider = openaiProvider()
    const repairable: ChatMessage = { role: 'user', content: `a${HIGH}b` }

    await expect(
      provider.completeSingleTurnWithTools(
        [repairable, ...argumentsTurn(COLLIDING_ARGS()).slice(1)],
        TOOLS
      )
    ).rejects.toBeInstanceOf(RequestTextKeyCollisionError)
    await expect(
      provider.completeSingleTurnWithTools(
        [repairable],
        [
          {
            name: 'page_read',
            description: 'Read',
            parameters: { type: 'object', properties: { [`p${HIGH}`]: {}, [`p${LOW}`]: {} } },
          },
        ]
      )
    ).rejects.toMatchObject({ role: 'tool_definition', toolName: 'page_read' })

    expect(server.bodies).toHaveLength(0)
    expect(repairWarns(warn)).toHaveLength(0)
    expect(await counterValue('openai', 'user')).toBe(before)

    // Witness: the repairable message alone is repaired, reported and sent.
    await provider.completeSingleTurnWithTools([repairable], TOOLS)
    expect(server.bodies).toHaveLength(1)
    expect(repairWarns(warn)).toHaveLength(1)
    expect(await counterValue('openai', 'user')).toBe(before + 1)
  })

  const STABLE_PARTS = () => ({
    stable: `x${LOW}y`,
    context: 'context',
    stableHash: 'a'.repeat(64),
    contextHash: 'b'.repeat(64),
  })
  const REPAIRABLE: ChatMessage = { role: 'user', content: `a${HIGH}b` }
  const COLLIDING_TOOLS = (): ToolDefinition[] => [
    {
      name: 'page_read',
      description: 'Read',
      parameters: { type: 'object', properties: { [`p${HIGH}`]: {}, [`p${LOW}`]: {} } },
    },
  ]
  // The colliding keys sit in the last thing each method repairs, after text
  // that is repairable, so a report made before the whole request is repaired
  // would show up as a warn.
  const REQUEST_METHODS: Array<{
    method: string
    refused: (provider: SingleTurnProvider) => Promise<unknown>
    sent: (provider: SingleTurnProvider) => Promise<unknown>
    roles: string[]
  }> = [
    {
      method: 'completeSingleTurn',
      refused: p => p.completeSingleTurn([REPAIRABLE, ...argumentsTurn(COLLIDING_ARGS()).slice(1)]),
      sent: p => p.completeSingleTurn([REPAIRABLE]),
      roles: ['user'],
    },
    {
      method: 'completeSingleTurnWithTools',
      refused: p => p.completeSingleTurnWithTools([REPAIRABLE], COLLIDING_TOOLS()),
      sent: p => p.completeSingleTurnWithTools([REPAIRABLE], TOOLS),
      roles: ['user'],
    },
    {
      method: 'completeSingleTurnAndCache',
      refused: p =>
        p.completeSingleTurnAndCache!(STABLE_PARTS(), [
          REPAIRABLE,
          ...argumentsTurn(COLLIDING_ARGS()).slice(1),
        ]),
      sent: p => p.completeSingleTurnAndCache!(STABLE_PARTS(), [REPAIRABLE]),
      roles: ['system_prompt', 'user'],
    },
    {
      method: 'completeSingleTurnWithToolsAndCache',
      refused: p =>
        p.completeSingleTurnWithToolsAndCache!(STABLE_PARTS(), [REPAIRABLE], COLLIDING_TOOLS()),
      sent: p => p.completeSingleTurnWithToolsAndCache!(STABLE_PARTS(), [REPAIRABLE], TOOLS),
      roles: ['system_prompt', 'user'],
    },
  ]

  it.each(REQUEST_METHODS)(
    'T15c: $method refuses colliding keys as a rejected promise and reports no repair',
    async ({ refused, sent, roles }) => {
      const server = await anthropicFixture()
      const warn = vi.spyOn(logger, 'warn')
      const provider = claudeProvider()

      let attempt: Promise<unknown> | undefined
      expect(() => {
        attempt = refused(provider)
      }).not.toThrow()
      expect(await settle(attempt!)).toBeInstanceOf(RequestTextKeyCollisionError)
      expect(server.bodies).toHaveLength(0)
      expect(repairWarns(warn)).toHaveLength(0)

      // Witness: the same method on the same instance, without the colliding
      // keys, is sent and reports the repairs the refused request held back.
      await sent(provider)
      expect(server.bodies).toHaveLength(1)
      expect(
        repairWarns(warn)
          .map(fields => fields.role)
          .sort()
      ).toEqual(roles)
    }
  )

  it('T16: colliding schema properties refuse the request, naming the tool definition', async () => {
    const server = await openaiFixture()
    const provider = openaiProvider()
    const err = await settle(
      provider.completeSingleTurnWithTools(
        [{ role: 'user', content: 'hi' }],
        [
          {
            name: 'page_read',
            description: 'Read',
            parameters: {
              type: 'object',
              properties: { [`p${HIGH}`]: { type: 'string' }, [`p${LOW}`]: { type: 'number' } },
            },
          },
        ]
      )
    )
    expect(err).toBeInstanceOf(RequestTextKeyCollisionError)
    expect((err as Error).message).toMatch(/the definition of tool 'page_read'/)
    expect(server.bodies).toHaveLength(0)
    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'hi' }], TOOLS)
    expect(server.bodies).toHaveLength(1)
  })

  it('T17: a repaired key equal to an untouched key is refused too', async () => {
    const server = await openaiFixture()
    const provider = openaiProvider()
    await expect(
      provider.completeSingleTurnWithTools(
        argumentsTurn({ [`k${FFFD}`]: 1, [`k${HIGH}`]: 2 }),
        TOOLS
      )
    ).rejects.toBeInstanceOf(RequestTextKeyCollisionError)
    expect(server.bodies).toHaveLength(0)
    await provider.completeSingleTurnWithTools(argumentsTurn({ k: 1 }), TOOLS)
    expect(server.bodies).toHaveLength(1)
  })

  it('T18: repaired keys that stay distinct are sent, both of them', async () => {
    const server = await openaiFixture()
    const warn = vi.spyOn(logger, 'warn')
    await openaiProvider().completeSingleTurnWithTools(
      argumentsTurn({ [`a${HIGH}`]: 1, [`b${HIGH}`]: 2 }),
      TOOLS
    )
    expect(server.bodies).toHaveLength(1)
    const wire = JSON.parse(server.bodies[0]) as {
      messages: { tool_calls?: { function: { arguments: string } }[] }[]
    }
    const call = wire.messages.find(m => m.tool_calls)!.tool_calls![0]
    expect(JSON.parse(call.function.arguments)).toEqual({ [`a${FFFD}`]: 1, [`b${FFFD}`]: 2 })
    const repairs = repairWarns(warn)
    expect(repairs).toHaveLength(1)
    expect(repairs[0]).toMatchObject({ role: 'assistant', repairedUnits: 2 })
  })

  it('T19a: through LlmPortAdapter the refusal is a non-retryable LLM_REQUEST_TEXT_REJECTED', async () => {
    const server = await openaiFixture()
    const adapter = new LlmPortAdapter(openaiProvider(), 'fixture-model', 'openai')
    await expect(
      adapter.completeWithTools({ messages: argumentsTurn(COLLIDING_ARGS()), tools: TOOLS })
    ).rejects.toMatchObject({
      code: LlmErrorCode.RequestTextRejected,
      retryable: false,
      providerCode: 'request_text_key_collision',
    })
    expect(server.bodies).toHaveLength(0)
    // Witness: the adapter dispatches a request without colliding keys.
    await adapter.completeWithTools({ messages: argumentsTurn({ k: 1 }), tools: TOOLS })
    expect(server.bodies).toHaveLength(1)
  })

  it('T19b: FailoverSingleTurnProvider does not fail over from the refusal', async () => {
    const primaryServer = await openaiFixture()
    const primary = createLLMProvider(
      {
        openai: { [primarySlot(descriptorFor('openai')).dataKey]: 'local-http-fixture' },
      } as ApiKeys,
      { provider: 'openai', name: 'fixture-model' }
    )
    expect(primary).not.toBeNull()
    const buildFallback = vi.fn(() => primary)
    const failover = new FailoverSingleTurnProvider({
      primary: primary!,
      primaryPair: { provider: 'openai', model: 'fixture-model' },
      policy: {
        cooldownSeconds: 60,
        triggerOn: [...ALL_FAILOVER_CLASSES],
        fallbacks: [{ provider: 'claude', model: 'fixture-model', apiKey: 'local-http-fixture' }],
      },
      buildFallback,
    })

    await expect(
      failover.completeSingleTurnWithTools(argumentsTurn(COLLIDING_ARGS()), TOOLS)
    ).rejects.toBeInstanceOf(RequestTextKeyCollisionError)
    expect(buildFallback).not.toHaveBeenCalled()
    expect(primaryServer.bodies).toHaveLength(0)
    // Witness: the same failover provider dispatches a well-formed request.
    await failover.completeSingleTurnWithTools(argumentsTurn({ k: 1 }), TOOLS)
    expect(primaryServer.bodies).toHaveLength(1)
  })

  it('T19c: LlmBridge reports the refusal as not retryable and not executed', async () => {
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
    const request = (messages: unknown[]) => ({
      invocationId: 'inv-1',
      attemptGeneration: 1,
      targets: [{ target }],
      policyRevision: 1,
      policyHash: 'a'.repeat(64),
      credentialTicketIssuer: { issue: vi.fn(async () => ({ credentialTicket: 'fresh' })) },
      messages: messages as never,
      timeoutMs: 5_000,
    })

    const err = await settle(bridge.complete(request(argumentsTurn(COLLIDING_ARGS()))))

    expect(err).toMatchObject({ retryable: false, providerMayHaveExecuted: false })
    expect(String((err as Error).message)).toContain(LlmErrorCode.RequestTextRejected)
    expect(server.bodies).toHaveLength(0)
    // Witness: the bridge dispatches a request without colliding keys.
    await bridge.complete(request(argumentsTurn({ k: 1 })))
    expect(server.bodies).toHaveLength(1)
  })
})
