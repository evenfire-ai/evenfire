/**
 * The edges the provider contract (`wireToolNames.providers.test.ts`) does
 * not walk: Claude's cache-aware method and token counter, the Responses
 * continuation across an aliased tool turn, and the two proxied providers,
 * which must keep sending canonical names.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAITokenCounter, createTokenCounter } from '../../core/tokenizer'
import type { ChatMessage, ToolDefinition } from '../../core/types'
import { ClaudeProvider } from '../claude'
import { makeProvider } from '../registry'
import { NOTION_TOOLS } from './fixtures/remoteMcpToolLists'
import {
  NOTION_SERVER,
  buildCapturingProvider,
  toolDef,
  toolTurn,
  wireHistoryNames,
  wireToolDecls,
} from './wireToolNamesHarness'

const W = /^[A-Za-z0-9_-]{1,64}$/
const W_C = /^[A-Za-z0-9_-]{1,128}$/
const W_G = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

const NOTION_CANONICALS = NOTION_TOOLS.map(t => `${NOTION_SERVER}__${t.name}`)
const WITH_DOT = 'notion.v2__search'
const OVER_128 = `${NOTION_SERVER}__${'x'.repeat(129 - NOTION_SERVER.length - 2)}`
const QUERY = `${NOTION_SERVER}__notion-query-multiple-data-sources`
// Fits `W`, the envelope of the openai and azure profiles, but not `W_g`,
// which needs a letter or `_` first. The twin fits every envelope.
const FITS_W_NOT_W_G = '1srv__ok'
const FITS_EVERY_ENVELOPE = 'asrv__ok'
// Varied words on purpose: `'x'.repeat` tokenizes to about as many tokens as its alias.
const OVER_128_WORDS = `${NOTION_SERVER}__${['retrieve', 'quarterly', 'revenue', 'breakdown', 'grouped', 'by', 'region', 'product', 'line', 'and', 'currency', 'adjusted', 'for', 'seasonal', 'trends'].join('-')}`

describe('Claude cache-aware method', () => {
  it('sends only W_c names, keeps 65–128 canonicals and resolves the call back', async () => {
    const cap = buildCapturingProvider('claude')
    const tools = [...NOTION_CANONICALS, WITH_DOT, OVER_128].map(toolDef)
    const call = (name: string | null) => {
      cap.respondWith(name)
      return cap.provider.completeSingleTurnWithToolsAndCache!(
        { stable: 'stable', context: 'context' } as never,
        [{ role: 'user', content: 'q' }],
        tools
      )
    }
    await call(null)
    const sent = wireToolDecls('claude', cap.bodies[0])
    for (const { name } of sent) expect(name).toMatch(W_C)
    for (const c of NOTION_CANONICALS) expect(sent.map(t => t.name)).toContain(c)
    expect(sent.map(t => t.name)).not.toContain(WITH_DOT)
    expect(sent.map(t => t.name)).not.toContain(OVER_128)

    const aliasOfDot = sent.find(t => t.description.includes(JSON.stringify('notion.v2')))!.name
    const response = await call(aliasOfDot)
    expect(response.tool_calls?.[0]?.name).toBe(WITH_DOT)
  })

  it('projects tool_use names in the history onto the same W_c names as the tools', async () => {
    const cap = buildCapturingProvider('claude')
    const history = toolTurn(
      [
        { id: 'toolu_0', name: OVER_128 },
        { id: 'toolu_1', name: WITH_DOT },
      ],
      [OVER_128, WITH_DOT]
    )
    cap.respondWith(null)
    await cap.provider.completeSingleTurnWithToolsAndCache!(
      { stable: 'stable', context: 'context' } as never,
      history,
      [toolDef(OVER_128), toolDef(WITH_DOT)]
    )
    const sentTools = wireToolDecls('claude', cap.bodies[0]).map(t => t.name)
    const historyNames = wireHistoryNames('claude', cap.bodies[0])
    expect(historyNames).toHaveLength(2)
    for (const n of historyNames) {
      expect(n).toMatch(W_C)
      expect(sentTools).toContain(n)
    }
  })
})

describe('Claude token counter (offline=false)', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: OVER_128, arguments: {} }] },
    { role: 'tool', tool_call_id: 't1', name: OVER_128, content: 'r' },
  ]

  async function sentAndCounted(tools: ToolDefinition[]) {
    const cap = buildCapturingProvider('claude')
    const counter = (cap.provider as ClaudeProvider).createTokenCounter('claude-unit')
    cap.respondWith(null)
    await cap.provider.completeSingleTurnWithTools(history, tools)
    const counted = await counter.count(history, tools)
    const sent = cap.bodies[cap.methods.indexOf('messages')] as {
      tools: unknown[]
      messages: unknown[]
    }
    const params = cap.bodies[cap.methods.indexOf('countTokens')] as {
      tools: Array<{ name: string }>
      messages: unknown[]
    }
    return { counted, sent, params }
  }

  it('(a) the Notion capture on its real slot is counted with identical names', async () => {
    const { counted, sent, params } = await sentAndCounted(NOTION_CANONICALS.map(toolDef))
    expect(counted).toBe(4242)
    expect(params.tools.map(t => t.name)).toEqual(NOTION_CANONICALS)
    expect(params.tools).toEqual(sent.tools)
  })

  it('(b) a dotted and a 129-character name are counted with the names that are sent', async () => {
    const { counted, sent, params } = await sentAndCounted([toolDef(WITH_DOT), toolDef(OVER_128)])
    expect(counted).toBe(4242)
    for (const t of params.tools) expect(t.name).toMatch(W_C)
    expect(params.tools).toEqual(sent.tools)
    expect(params.messages).toEqual(sent.messages)
  })

  it('(c) the counter takes the envelope of the provider that creates it', async () => {
    // No production subclass narrows the envelope today, so the provider's own
    // envelope and the counter's default coincide; a subclass is the only way
    // to see whether createTokenCounter hands its envelope over.
    class NarrowEnvelopeClaude extends ClaudeProvider {
      protected override toolNameEnvelope() {
        return 'W' as const
      }
    }
    const cap = buildCapturingProvider('claude')
    const provider = new NarrowEnvelopeClaude(cap.client as never, 'claude-unit')
    const name = `${NOTION_SERVER}__${'y'.repeat(100 - NOTION_SERVER.length - 2)}`
    expect(name).toMatch(W_C)
    expect(name).not.toMatch(W)

    cap.respondWith(null)
    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'q' }], [toolDef(name)])
    await provider
      .createTokenCounter('claude-unit')
      .count([{ role: 'user', content: 'q' }], [toolDef(name)])
    const sent = cap.bodies[cap.methods.indexOf('messages')] as { tools: Array<{ name: string }> }
    const params = cap.bodies[cap.methods.indexOf('countTokens')] as {
      tools: Array<{ name: string }>
    }
    expect(sent.tools[0]!.name).toMatch(W)
    expect(params.tools.map(t => t.name)).toEqual(sent.tools.map(t => t.name))
  })
})

describe('tiktoken counter of the providers that use it', () => {
  // The counter of `openai` and `azure` comes from the factory, not from the provider.
  async function sendThrough(
    id: 'openai' | 'azure',
    history: ChatMessage[],
    tools: ToolDefinition[]
  ) {
    const cap = buildCapturingProvider(id)
    const counter = createTokenCounter(cap.provider, 'gpt-4o-mini')
    expect(counter).toBeInstanceOf(OpenAITokenCounter)
    await counter.warmup()
    cap.respondWith(null)
    await cap.provider.completeSingleTurnWithTools(history, tools)
    const family = id === 'openai' ? 'responses' : 'chat'
    const body = cap.bodies[0] as Record<string, any>
    const sent: ToolDefinition[] = body.tools.map((t: Record<string, any>) => {
      const decl = family === 'chat' ? t.function : t
      return { name: decl.name, description: decl.description, parameters: decl.parameters }
    })
    return { counter, family, body, sent }
  }

  it.each(['openai', 'azure'] as const)(
    '%s: an aliased tool turn is counted as the history that is sent',
    async id => {
      const canonicalCalls = [OVER_128_WORDS, QUERY]
      expect(OVER_128_WORDS.length).toBeGreaterThan(128)
      const tools = [...canonicalCalls, 'srv__ok'].map(toolDef)
      // Tool messages carry the canonical `name`, as the tool-use loop and the
      // task executor build them.
      const history = toolTurn(
        canonicalCalls.map((name, i) => ({ id: `call_${i}`, name })),
        canonicalCalls
      )
      const { counter, family, body, sent } = await sendThrough(id, history, tools)
      const sentNames = sent.map(t => t.name)
      expect(sentNames).not.toContain(QUERY)

      // The two families lay the history out differently (chat `messages` vs
      // Responses `input` items), and aliasing changes nothing but the names, so
      // `sentHistory` is the canonical history with the aliases read off the
      // body substituted. The `name` of its tool messages is that substitution
      // (the alias of the call each one answers): no family sends it, but the
      // counter counts it.
      const sentCallNames: string[] =
        family === 'chat'
          ? body.messages.flatMap((m: Record<string, any>) =>
              (m.tool_calls ?? []).map((tc: Record<string, any>) => tc.function.name)
            )
          : body.input
              .filter((i: Record<string, any>) => i.type === 'function_call')
              .map((i: Record<string, any>) => i.name)
      expect(sentCallNames).toHaveLength(canonicalCalls.length)
      sentCallNames.forEach((n, i) => {
        expect(n).not.toBe(canonicalCalls[i])
        expect(n).toMatch(W)
        expect(sentNames).toContain(n)
      })
      if (family === 'chat') {
        const sentToolMessages = (body.messages as Array<Record<string, any>>).filter(
          m => m.role === 'tool'
        )
        expect(sentToolMessages).toHaveLength(canonicalCalls.length)
        for (const m of sentToolMessages) expect(typeof m.name).not.toBe('string')
      } else {
        expect((body.input as Array<Record<string, any>>).some(i => i.role === 'tool')).toBe(false)
      }
      const wireOf = new Map(canonicalCalls.map((c, i) => [c, sentCallNames[i]]))
      const sentHistory = history.map(m => {
        if (m.tool_calls)
          return {
            ...m,
            tool_calls: m.tool_calls.map(tc => ({ ...tc, name: wireOf.get(tc.name)! })),
          }
        if (m.role === 'tool' && m.name) return { ...m, name: wireOf.get(m.name)! }
        return m
      })

      // Message content is never projected, so it measures the names as plain
      // text. If the sent names cost the same as the canonical ones, the
      // comparison below cannot tell a counter that skips the history projection
      // from one that applies it.
      const tokens = (text: string) =>
        counter.countSync([{ role: 'user', content: text }]) -
        counter.countSync([{ role: 'user', content: '' }])
      const cost = (names: string[]) => names.reduce((sum, n) => sum + tokens(n), 0)
      expect(cost(sentCallNames)).not.toBe(cost(canonicalCalls))
      expect(counter.countSync(history, tools)).toBe(counter.countSync(sentHistory, sent))
    }
  )

  it.each(['openai', 'azure'] as const)(
    '%s: a name that fits W but not W_g is counted as sent, without an alias',
    async id => {
      const tools = [FITS_W_NOT_W_G, FITS_EVERY_ENVELOPE].map(toolDef)
      const { counter, sent } = await sendThrough(id, [{ role: 'user', content: 'q' }], tools)
      expect(sent).toEqual(tools)
      expect(FITS_EVERY_ENVELOPE).toMatch(W_G)
      expect(FITS_W_NOT_W_G).not.toMatch(W_G)

      // An alias would add its annotation to the description, about 20 tokens
      // more than the twin, whose name differs by one character.
      const toolCost = (name: string) =>
        counter.countSync([], [toolDef(name)]) - counter.countSync([])
      expect(Math.abs(toolCost(FITS_W_NOT_W_G) - toolCost(FITS_EVERY_ENVELOPE))).toBeLessThan(5)
    }
  )
})

describe('Responses continuation across an aliased tool turn', () => {
  it('replays the recorded layout: the digest is over the same wire names both ways', async () => {
    const cap = buildCapturingProvider('openai')
    const tools = [toolDef(QUERY)]
    const user: ChatMessage = { role: 'user', content: 'q' }
    cap.respondWith(null)
    await cap.provider.completeSingleTurnWithTools([user], tools)
    const alias = wireToolDecls('responses', cap.bodies[0])[0].name
    expect(alias).not.toBe(QUERY)

    cap.respondWith(alias)
    const turn = await cap.provider.completeSingleTurnWithTools([user], tools)
    expect(turn.tool_calls?.[0]?.name).toBe(QUERY)
    expect(turn.provider_continuation).toBeDefined()

    const assistant: ChatMessage = {
      role: 'assistant',
      content: turn.content ?? '',
      tool_calls: turn.tool_calls!,
      provider_continuation: turn.provider_continuation,
    }
    const result: ChatMessage = { role: 'tool', tool_call_id: turn.tool_calls![0].id, content: 'r' }
    cap.respondWith(null)
    await cap.provider.completeSingleTurnWithTools([user, assistant, result], tools)
    const input = (cap.bodies[2] as { input: Array<Record<string, unknown>> }).input
    const call = input.find(i => i.type === 'function_call')!
    expect(call.name).toBe(alias)
    // `id` is only present when the recorded layout was replayed.
    expect(typeof call.id).toBe('string')
  })
})

describe('proxied providers keep canonical names in the attempt contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function deps() {
    const authorize = vi.fn().mockResolvedValue({
      providerAttemptId: 'attempt-1',
      requestHash: 'a'.repeat(64),
      executionTicket: 'ticket-123456',
      expiresAt: '2026-08-20T10:00:00.000Z',
    })
    const stream = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [], outcome: 'success' })
    return {
      authorizer: { authorize },
      proxy: { stream },
      attemptContext: vi.fn(() => ({
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
        hostRef: 'chatllm',
      })),
      authorize,
    }
  }

  it.each([
    ['codex-subscription', 'MCP_HOST_CODEX_SUBSCRIPTION_ENABLED', 'gpt-5.6-luna', 'codex'],
    ['grok-subscription', 'MCP_HOST_GROK_SUBSCRIPTION_ENABLED', 'grok-4.6', 'grok'],
  ] as const)('%s', async (id, flag, model, key) => {
    vi.stubEnv(flag, 'true')
    const wired = deps()
    const provider = makeProvider(id, {}, model, { [key]: wired } as never)
    const tools = [toolDef(QUERY)]
    expect(QUERY.length).toBeGreaterThan(64)
    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'q' }], tools)
    const request = wired.authorize.mock.calls[0][0].request
    expect(request.tools.map((t: { name: string }) => t.name)).toEqual([QUERY])
    expect(QUERY).not.toMatch(W)
  })
})

// `makeProvider` repairs lone surrogates to U+FFFD before the wire-name
// projection runs, so on this path the projection works on the repaired name.
// Accepted cost: a tool whose canonical name carries a lone surrogate resolves
// back to the repaired name, which no registered tool has, and two names that
// differ only in the surrogate share one wire name. These pin that behaviour so
// a change to either layer has to revisit it.
describe('canonical names with lone surrogates on the makeProvider path', () => {
  const HIGH = 'srv__weird\uD800tool'
  const LOW = 'srv__weird\uDBFFtool'
  const REPAIRED = 'srv__weird�tool'

  it('resolves the call back to the repaired name, not the registered one', async () => {
    const cap = buildCapturingProvider('claude')
    const call = (name: string | null) => {
      cap.respondWith(name)
      return cap.provider.completeSingleTurnWithTools(
        [{ role: 'user', content: 'q' }],
        [toolDef(HIGH)]
      )
    }
    await call(null)
    const [sent] = wireToolDecls('claude', cap.bodies[0])
    expect(sent.name).toMatch(W_C)

    const response = await call(sent.name)
    expect(response.tool_calls?.[0]?.name).toBe(REPAIRED)
    expect(response.tool_calls?.[0]?.name).not.toBe(HIGH)
  })

  it('sends one wire name for two canonicals that differ only in the surrogate', async () => {
    const cap = buildCapturingProvider('claude')
    cap.respondWith(null)
    await cap.provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'q' }],
      [toolDef(HIGH), toolDef(LOW)]
    )
    const names = wireToolDecls('claude', cap.bodies[0]).map(t => t.name)
    expect(names).toHaveLength(2)
    expect(names[0]).toBe(names[1])
  })
})
