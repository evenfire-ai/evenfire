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

const NOTION_CANONICALS = NOTION_TOOLS.map(t => `${NOTION_SERVER}__${t.name}`)
const QUERY = `${NOTION_SERVER}__notion-query-multiple-data-sources`
const DIGIT_FIRST = '1keychain__item_get'
const WITH_DOT = 'notion.v2__search'
const OVER_128 = `${NOTION_SERVER}__${'x'.repeat(129 - NOTION_SERVER.length - 2)}`

const CONTRACT_TOOLS: ToolDefinition[] = [
  ...NOTION_CANONICALS,
  DIGIT_FIRST,
  WITH_DOT,
  OVER_128,
].map(toolDef)

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
  it('the registry golden carries the real slots and the catalog is not produced yet', () => {
    expect(CATALOG_SERVER_NAMES).toHaveLength(0)
    expect(REGISTRY_SERVER_NAMES.length).toBeGreaterThanOrEqual(4)
    expect(NOTION_SERVER).toBe('mcp-evenfire-notion-remote-v1-0-0-b234d024')
    expect(ATLASSIAN_SERVER).toBe('mcp-evenfire-atlassian-remote-v1-0-0-c97292b3')
    expect(OVER_128).toHaveLength(129)
  })
})

describe.each(DIRECT_PROVIDERS)('provider contract · %s', id => {
  const E = ENVELOPES[envelopeOf(id)]

  it(`sends only names in its envelope and resolves the call back to the canonical name`, async () => {
    const queryIndex = CONTRACT_TOOLS.findIndex(t => t.name === QUERY)
    const { cap, sent, response } = await send(
      id,
      [{ role: 'user', content: 'q' }],
      CONTRACT_TOOLS,
      names => names[queryIndex]
    )

    expect(sent).toHaveLength(CONTRACT_TOOLS.length)
    for (const { name } of sent) expect(name).toMatch(E)
    expect(new Set(sent.map(t => t.name)).size).toBe(sent.length)

    const notionSent = sent.slice(0, NOTION_CANONICALS.length).map(t => t.name)
    if (id === 'claude' || id === 'vertex') {
      expect(notionSent).toEqual(NOTION_CANONICALS)
    } else {
      NOTION_CANONICALS.forEach((c, i) => {
        if (c.length > 64) expect(notionSent[i]).not.toBe(c)
        else expect(notionSent[i]).toBe(c)
      })
    }

    expect(response.tool_calls?.[0]?.name).toBe(QUERY)
    if (id === 'openai') expect(cap.methods).toEqual(['responses', 'responses'])
  })

  // The Notion call above fits Claude's and Vertex's 128; only a name past every
  // envelope proves each adapter maps the returned alias back.
  it('resolves a returned alias of a 129-character tool back to the canonical name', async () => {
    const overIndex = CONTRACT_TOOLS.findIndex(t => t.name === OVER_128)
    const { sent, response } = await send(
      id,
      [{ role: 'user', content: 'q' }],
      CONTRACT_TOOLS,
      names => names[overIndex]
    )
    expect(sent[overIndex].name).not.toBe(OVER_128)
    expect(response.tool_calls?.[0]?.name).toBe(OVER_128)
  })
})

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
  // a name that resolves to itself proves nothing if nothing was aliased.
  const sentNames = (id: LlmProvider, body: unknown) =>
    wireToolDecls(familyOf(id), body).map(t => t.name)

  it.each(W_IDS)('%s: an exact canonical of the request resolves to itself', async id => {
    const { response, body } = await send(
      id,
      [{ role: 'user', content: 'q' }],
      [toolDef(longA), toolDef(shortB)],
      () => shortB
    )
    expect(sentNames(id, body)[0]).not.toBe(longA)
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
      expect(sentNames(id, body)[0]).not.toBe(longA)
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
    expect(sentNames(id, body)[1]).not.toBe(OVER_128)
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
  const longest = REGISTRY_SERVER_NAMES.filter(n => n.length === maxRegistry)
  const captured = [...NOTION_TOOLS, ...ATLASSIAN_TOOLS].map(t => t.name)

  it('the registry producer reaches 63 characters', () => {
    expect(maxRegistry).toBe(63)
  })

  it.each(DIRECT_PROVIDERS)('%s: tools of a 63-character server', async id => {
    const canonicals = longest.flatMap(s => captured.map(t => `${s}__${t}`))
    const { sent } = await send(
      id,
      [{ role: 'user', content: 'q' }],
      canonicals.map(toolDef),
      () => null
    )
    canonicals.forEach((c, i) => {
      const { name, description } = sent[i]
      if (id === 'claude' || id === 'vertex') {
        expect(c.length).toBeLessThanOrEqual(128)
        expect(name).toBe(c)
      } else {
        expect(name).not.toContain('__')
        const server = c.slice(0, c.indexOf('__'))
        expect(description.startsWith(`(MCP server: ${JSON.stringify(server)}; tool: `)).toBe(true)
      }
    })
  })
})
