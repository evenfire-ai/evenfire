/**
 * Provider contract for tool wire names: every direct adapter, built by the
 * real factory, sends only names its envelope accepts and hands canonical
 * names back. Only the SDK client is faked (see the harness).
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolDefinition } from '../../core/types'
import type { LlmProvider } from '../registryCore'
import { ATLASSIAN_TOOLS, NOTION_TOOLS } from './fixtures/remoteMcpToolLists'
import {
  ATLASSIAN_SERVER,
  CATALOG_NOTION_SERVER,
  CATALOG_SERVER_NAMES,
  DIRECT_PROVIDERS,
  NOTION_SERVER,
  REGISTRY_SERVER_NAMES,
  buildCapturingProvider,
  familyOf,
  toolDef,
  toolTurn,
  vertexCallResponsePairs,
  wireHistoryNames,
  wireToolDecls,
} from './wireToolNamesHarness'

// Written out here as the oracle, independent of the module's own regexes.
const ENVELOPES = {
  W: /^[A-Za-z0-9_-]{1,64}$/,
  W_c: /^[A-Za-z0-9_-]{1,128}$/,
  W_v: /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/,
  W_g: /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,
} as const
type EnvelopeKey = keyof typeof ENVELOPES

const EXPECTED_ENVELOPE: Partial<Record<LlmProvider, EnvelopeKey>> = {
  claude: 'W_c',
  vertex: 'W_v',
  gemini: 'W_g',
  openrouter: 'W_g',
}
const envelopeOf = (id: LlmProvider): EnvelopeKey => EXPECTED_ENVELOPE[id] ?? 'W'
const W_IDS = DIRECT_PROVIDERS.filter(id => envelopeOf(id) === 'W')

const DIGIT_FIRST = '1keychain__item_get'
const WITH_DOT = 'notion.v2__search'

/** The Notion tool set as one server slot exposes it, plus the edge names. */
function contractFor(server: string) {
  const canonicals = NOTION_TOOLS.map(t => `${server}__${t.name}`)
  const over128 = `${server}__${'x'.repeat(129 - server.length - 2)}`
  return {
    canonicals,
    query: `${server}__notion-query-multiple-data-sources`,
    over128,
    tools: [...canonicals, DIGIT_FIRST, WITH_DOT, over128].map(toolDef),
  }
}

const { query: QUERY, over128: OVER_128 } = contractFor(NOTION_SERVER)

async function send(
  id: LlmProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  respond: (sentTools: string[]) => string | null
) {
  const cap = buildCapturingProvider(id)
  // First call learns the wire names; the second answers with one of them.
  cap.respondWith(null)
  await cap.provider.completeSingleTurnWithTools(messages, tools)
  const sent = wireToolDecls(familyOf(id), cap.bodies[0])
  cap.respondWith(respond(sent.map(t => t.name)))
  const response = await cap.provider.completeSingleTurnWithTools(messages, tools)
  return { cap, sent, response, body: cap.bodies[1] }
}

describe('fixtures', () => {
  it('the golden carries the real registry and catalog slots', () => {
    // Three catalog entries times two grant scopes: an empty catalog would let
    // every catalog loop below pass without running.
    expect(CATALOG_SERVER_NAMES.length).toBeGreaterThanOrEqual(6)
    expect(REGISTRY_SERVER_NAMES.length).toBeGreaterThanOrEqual(4)
    expect(NOTION_SERVER).toBe('mcp-evenfire-notion-remote-v1-0-0-b234d024')
    expect(ATLASSIAN_SERVER).toBe('mcp-evenfire-atlassian-remote-v1-0-0-c97292b3')
    expect(CATALOG_NOTION_SERVER).toBe('mcp-evenfire-notion-remote-u-51704373')
    expect(OVER_128).toHaveLength(129)
  })

  // Both branches of the per-provider check (aliased past 64, unchanged within
  // it) must run for every slot, or the contract silently tests only one.
  it.each([NOTION_SERVER, CATALOG_NOTION_SERVER])(
    'the Notion tools of %s both exceed and fit 64 characters',
    server => {
      const { canonicals, query } = contractFor(server)
      expect(canonicals.filter(c => c.length > 64).length).toBeGreaterThan(0)
      expect(canonicals.filter(c => c.length <= 64).length).toBeGreaterThan(0)
      expect(query.length).toBeGreaterThan(64)
    }
  )
})

function providerContract(server: string) {
  const { canonicals, query, over128, tools } = contractFor(server)
  return (id: LlmProvider) => {
    const E = ENVELOPES[envelopeOf(id)]

    it(`sends only names in its envelope and resolves the call back to the canonical name`, async () => {
      const queryIndex = tools.findIndex(t => t.name === query)
      const { cap, sent, response } = await send(
        id,
        [{ role: 'user', content: 'q' }],
        tools,
        names => names[queryIndex]
      )

      expect(sent).toHaveLength(tools.length)
      for (const { name } of sent) expect(name).toMatch(E)
      expect(new Set(sent.map(t => t.name)).size).toBe(sent.length)

      const notionSent = sent.slice(0, canonicals.length).map(t => t.name)
      if (id === 'claude' || id === 'vertex') {
        expect(notionSent).toEqual(canonicals)
      } else {
        canonicals.forEach((c, i) => {
          if (c.length > 64) expect(notionSent[i]).not.toBe(c)
          else expect(notionSent[i]).toBe(c)
        })
      }

      expect(response.tool_calls?.[0]?.name).toBe(query)
      if (id === 'openai') expect(cap.methods).toEqual(['responses', 'responses'])
    })

    // The Notion call above fits Claude's and Vertex's 128; only a name past every
    // envelope proves each adapter maps the returned alias back.
    it('resolves a returned alias of a 129-character tool back to the canonical name', async () => {
      const overIndex = tools.findIndex(t => t.name === over128)
      const { sent, response } = await send(
        id,
        [{ role: 'user', content: 'q' }],
        tools,
        names => names[overIndex]
      )
      expect(sent[overIndex].name).not.toBe(over128)
      expect(response.tool_calls?.[0]?.name).toBe(over128)
    })
  }
}

describe.each(DIRECT_PROVIDERS)('provider contract · %s', providerContract(NOTION_SERVER))
describe.each(DIRECT_PROVIDERS)(
  'provider contract · catalog slot · %s',
  providerContract(CATALOG_NOTION_SERVER)
)

describe.each(DIRECT_PROVIDERS)('history projection · %s', id => {
  const E = ENVELOPES[envelopeOf(id)]
  const historyOnly = `${NOTION_SERVER}__notion-link-meeting-note-to-calendar-event`

  it('projects history names outside tools[], with and without a tool-message name', async () => {
    const messages = toolTurn(
      [
        { id: 'call_0', name: historyOnly },
        { id: 'call_1', name: OVER_128 },
      ],
      [historyOnly, undefined]
    )
    const { body } = await send(id, messages, [toolDef(QUERY)], () => null)
    const names = wireHistoryNames(familyOf(id), body)
    expect(names.length).toBeGreaterThanOrEqual(2)
    for (const n of names) expect(n).toMatch(E)
    if (id === 'vertex') {
      const pairs = vertexCallResponsePairs(body)
      expect(pairs).toHaveLength(2)
      for (const p of pairs) expect(p.response).toBe(p.call)
    }
  })
})

describe('tool calls coming back', () => {
  const longA = `${NOTION_SERVER}__notion-query-multiple-data-sources`
  const shortB = `${NOTION_SERVER}__notion-search`
  // Witness that the projection ran on the request whose response is checked:
  // a name that resolves to itself proves nothing if nothing was aliased. The
  // length check keeps an empty tool list from passing as "not the canonical".
  const expectAliased = (
    id: LlmProvider,
    body: unknown,
    sentCount: number,
    index: number,
    canonical: string
  ) => {
    const names = wireToolDecls(familyOf(id), body).map(t => t.name)
    expect(names).toHaveLength(sentCount)
    expect(names[index]).toMatch(ENVELOPES[envelopeOf(id)])
    expect(names[index]).not.toBe(canonical)
  }

  it.each(W_IDS)('%s: an exact canonical of the request resolves to itself', async id => {
    const { response, body } = await send(
      id,
      [{ role: 'user', content: 'q' }],
      [toolDef(longA), toolDef(shortB)],
      () => shortB
    )
    expectAliased(id, body, 2, 0, longA)
    expect(response.tool_calls?.[0]?.name).toBe(shortB)
  })

  it.each(W_IDS)(
    '%s: the canonical of an aliased tool, copied from the annotation, resolves to itself',
    async id => {
      const { response, body } = await send(
        id,
        [{ role: 'user', content: 'q' }],
        [toolDef(longA)],
        () => longA
      )
      expectAliased(id, body, 1, 0, longA)
      expect(response.tool_calls?.[0]?.name).toBe(longA)
    }
  )

  it.each(DIRECT_PROVIDERS)('%s: an unknown name passes through unchanged', async id => {
    // `longA` fits the 128-character envelopes of Claude and Vertex, so the
    // witness is a name past every envelope.
    const { response, body } = await send(
      id,
      [{ role: 'user', content: 'q' }],
      [toolDef(longA), toolDef(OVER_128)],
      () => 'inventado_xyz'
    )
    expectAliased(id, body, 2, 1, OVER_128)
    expect(response.tool_calls?.[0]?.name).toBe('inventado_xyz')
  })

  it('an orphan alias in history keeps its name, and the returning tool takes a suffix', async () => {
    const id: LlmProvider = 'deepseek'
    const family = familyOf(id)
    // Turn N: the tool is present and aliased.
    const first = await send(
      id,
      [{ role: 'user', content: 'q' }],
      [toolDef(longA)],
      names => names[0]
    )
    const alias = first.sent[0].name
    expect(alias).not.toBe(longA)
    expect(first.response.tool_calls?.[0]?.name).toBe(longA)

    // Turn N+1: the tool is gone and the model calls the old alias; it is unknown and persisted as is.
    const orphan = await send(id, [{ role: 'user', content: 'q' }], [toolDef(shortB)], () => alias)
    expect(orphan.response.tool_calls?.[0]?.name).toBe(alias)

    // Turn N+2: the orphan sits in history and the tool is back.
    const history = toolTurn([{ id: 'call_0', name: alias }], [alias])
    const back = await send(id, history, [toolDef(longA)], names => names[0])
    const toolName = back.sent[0].name
    const historyNames = wireHistoryNames(family, back.body)
    expect(historyNames).toContain(alias)
    expect(toolName).not.toBe(alias)
    expect(toolName).toMatch(ENVELOPES.W)
    expect(toolName.endsWith('_0')).toBe(true)
    expect(new Set([...historyNames, toolName]).size).toBe(2)
    expect(back.response.tool_calls?.[0]?.name).toBe(longA)

    const orphanCall = await send(id, history, [toolDef(longA)], () => alias)
    expect(orphanCall.response.tool_calls?.[0]?.name).toBe(alias)
  })
})

describe('longest real server names', () => {
  const maxRegistry = Math.max(...REGISTRY_SERVER_NAMES.map(n => n.length))
  const maxCatalog = Math.max(...CATALOG_SERVER_NAMES.map(n => n.length))
  const longestRegistry = REGISTRY_SERVER_NAMES.filter(n => n.length === maxRegistry)
  const longestCatalog = CATALOG_SERVER_NAMES.filter(n => n.length === maxCatalog)
  const captured = [...NOTION_TOOLS, ...ATLASSIAN_TOOLS].map(t => t.name)
  const canonicalsOf = (servers: readonly string[]) =>
    servers.flatMap(s => captured.map(t => `${s}__${t}`))

  it('the registry producer reaches 63 characters', () => {
    expect(maxRegistry).toBe(63)
  })

  it('the catalog producer reaches 55 characters', () => {
    expect(maxCatalog).toBe(55)
  })

  // A 55-character server leaves 7 characters for the tool within 64, so the
  // captured Atlassian `search` is the one tool sent unaliased. Pinned so the
  // unaliased branch below is known to run, and only for that tool.
  it('only the shortest captured tool fits 64 under a longest server', () => {
    const fitting = (servers: readonly string[]) =>
      canonicalsOf(servers).filter(c => c.length <= 64)
    expect(fitting(longestRegistry)).toEqual([])
    expect(fitting(longestCatalog)).toEqual(longestCatalog.map(s => `${s}__search`))
  })

  it.each(DIRECT_PROVIDERS)('%s: tools of the longest registry and catalog servers', async id => {
    const canonicals = canonicalsOf([...longestRegistry, ...longestCatalog])
    const { sent } = await send(
      id,
      [{ role: 'user', content: 'q' }],
      canonicals.map(toolDef),
      () => null
    )
    expect(sent).toHaveLength(canonicals.length)
    canonicals.forEach((c, i) => {
      const { name, description } = sent[i]
      if (id === 'claude' || id === 'vertex') {
        expect(c.length).toBeLessThanOrEqual(128)
        expect(name).toBe(c)
      } else if (c.length <= 64) {
        expect(name).toBe(c)
        expect(description).toBe(toolDef(c).description)
      } else {
        expect(name).not.toContain('__')
        const server = c.slice(0, c.indexOf('__'))
        expect(description.startsWith(`(MCP server: ${JSON.stringify(server)}; tool: `)).toBe(true)
      }
    })
  })
})
