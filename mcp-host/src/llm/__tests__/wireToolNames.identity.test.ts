/**
 * Byte identity. When every name of a request already fits the
 * provider's envelope, the body must stay exactly what the adapters sent
 * before the wire-name edge existed. The golden was produced by this same
 * harness on the commit before that edge (`UPDATE_WIRE_GOLDENS=1` rewrites it).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ToolDefinition } from '../../core/types'
import type { LlmProvider } from '../registryCore'
import { NOTION_TOOLS } from './fixtures/remoteMcpToolLists'
import {
  ATLASSIAN_SERVER,
  DIRECT_PROVIDERS,
  NOTION_SERVER,
  buildCapturingProvider,
  familyOf,
  toolDef,
  toolTurn,
  wireToolDecls,
} from './wireToolNamesHarness'

const GOLDEN = join(__dirname, 'fixtures', 'wireIdentity.golden.json')
const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'

const DIGIT_FIRST = '1keychain__item_get'
const SIXTY_FOUR = `${ATLASSIAN_SERVER}__${'getJiraIssueRemoteIssueLinks'.slice(0, 62 - ATLASSIAN_SERVER.length)}`
const NOTION_CANONICALS = NOTION_TOOLS.map(t => `${NOTION_SERVER}__${t.name}`)
const LONG_LETTER = `${NOTION_SERVER}__notion-link-meeting-note-to-calendar-event`
const WITH_DOT = 'notion.v2__search'

/** Names that fit each provider's envelope, per its source. */
function fittingNames(id: LlmProvider): string[] {
  if (id === 'claude') return NOTION_CANONICALS
  if (id === 'vertex') return [LONG_LETTER, WITH_DOT]
  if (id === 'gemini' || id === 'openrouter') return [SIXTY_FOUR]
  return [DIGIT_FIRST, SIXTY_FOUR]
}

function request(names: string[]): { messages: ChatMessage[]; tools: ToolDefinition[] } {
  return {
    messages: toolTurn([{ id: 'call_0', name: names[0] }], [names[0]]),
    tools: names.map(toolDef),
  }
}

const golden: Record<string, string> = existsSync(GOLDEN)
  ? JSON.parse(readFileSync(GOLDEN, 'utf8'))
  : {}
const produced: Record<string, string> = {}

afterAll(() => {
  if (UPDATE) writeFileSync(GOLDEN, `${JSON.stringify(produced, null, 2)}\n`)
})

function check(key: string, body: unknown) {
  const serialized = JSON.stringify(body)
  produced[key] = serialized
  if (!UPDATE) expect(serialized).toBe(golden[key])
}

describe('byte identity', () => {
  it('the golden covers every direct provider', () => {
    if (UPDATE) return
    for (const id of DIRECT_PROVIDERS)
      expect(golden[`${id}:completeSingleTurnWithTools`]).toBeTypeOf('string')
    expect(golden['claude:completeSingleTurnWithToolsAndCache']).toBeTypeOf('string')
  })

  it.each(DIRECT_PROVIDERS)('%s', async id => {
    const names = fittingNames(id)
    if (id === 'claude') expect(names.some(n => n.length > 64)).toBe(true)
    if (id === 'vertex') expect(LONG_LETTER.length).toBeGreaterThan(64)
    const cap = buildCapturingProvider(id)
    cap.respondWith(null)
    const { messages, tools } = request(names)
    await cap.provider.completeSingleTurnWithTools(messages, tools)
    check(`${id}:completeSingleTurnWithTools`, cap.bodies[0])
  })

  it('claude cache-aware method', async () => {
    const cap = buildCapturingProvider('claude')
    cap.respondWith(null)
    const { messages, tools } = request(fittingNames('claude'))
    await cap.provider.completeSingleTurnWithToolsAndCache!(
      { stable: 'stable', context: 'context' } as never,
      messages.filter(m => m.role !== 'system'),
      tools
    )
    check('claude:completeSingleTurnWithToolsAndCache', cap.bodies[0])
  })
})

describe('fixed envelope where there is no source', () => {
  const W_G = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
  const c = `${NOTION_SERVER}__notion-query-multiple-data-sources`

  it.each(['gemini', 'openrouter'] as LlmProvider[])(
    '%s aliases a 65–128 canonical that a relaxed envelope would keep',
    async id => {
      expect(c.length).toBeGreaterThan(64)
      expect(c.length).toBeLessThanOrEqual(128)
      const cap = buildCapturingProvider(id)
      cap.respondWith(null)
      await cap.provider.completeSingleTurnWithTools([{ role: 'user', content: 'q' }], [toolDef(c)])
      const name = wireToolDecls(familyOf(id), cap.bodies[0])[0].name
      expect(name !== c && W_G.test(name)).toBe(true)

      cap.respondWith(name)
      const response = await cap.provider.completeSingleTurnWithTools(
        [{ role: 'user', content: 'q' }],
        [toolDef(c)]
      )
      expect(response.tool_calls?.[0]?.name).toBe(c)
    }
  )
})
