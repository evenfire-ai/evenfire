/**
 * The edges that T-W2 does not walk: Claude's cache-aware method and token
 * counter, the Responses continuation across an aliased tool turn, and the two
 * proxied providers, which must keep sending canonical names.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ToolDefinition } from '../../core/types'
import type { ClaudeProvider } from '../claude'
import { makeProvider } from '../registry'
import { NOTION_TOOLS } from './fixtures/remoteMcpToolLists'
import {
  NOTION_SERVER,
  buildCapturingProvider,
  toolDef,
  wireToolDecls,
} from './wireToolNamesHarness'

const W = /^[A-Za-z0-9_-]{1,64}$/
const W_C = /^[A-Za-z0-9_-]{1,128}$/

const NOTION_CANONICALS = NOTION_TOOLS.map(t => `${NOTION_SERVER}__${t.name}`)
const WITH_DOT = 'notion.v2__search'
const OVER_128 = `${NOTION_SERVER}__${'x'.repeat(129 - NOTION_SERVER.length - 2)}`
const QUERY = `${NOTION_SERVER}__notion-query-multiple-data-sources`

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
})

describe('T-W8 · Claude token counter (offline=false)', () => {
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

describe('T-W6 · proxied providers keep canonical names in the attempt contract', () => {
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
