import { describe, expect, it } from 'vitest'
import type { McpTool } from '../types'
import {
  buildToolDescribeResponse,
  buildToolSearchResponse,
  createToolDescribeTool,
  createToolSearchTool,
  serverPrefixOf,
} from './toolCatalogTools'

function mcpTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown> = { type: 'object', properties: {} }
): McpTool {
  const serverName = name.includes('__') ? name.slice(0, name.indexOf('__')) : 'native'
  return { name, description, inputSchema, serverName }
}

const CATALOG: McpTool[] = [
  mcpTool('brain__search_notes', 'Search the brain for notes and memories', {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  }),
  mcpTool('brain__create_note', 'Create a new note in the brain'),
  mcpTool('board__list_tasks', 'List tasks on the agentic task board'),
  mcpTool('board__create_task', 'Create a task with a title and description'),
  mcpTool('weather__forecast', 'Get the weather forecast for a city'),
]

describe('serverPrefixOf', () => {
  it('parses the server prefix before the double underscore', () => {
    expect(serverPrefixOf('brain__search_notes')).toBe('brain')
    expect(serverPrefixOf('board__list_tasks')).toBe('board')
  })

  it('reports native for names without a prefix', () => {
    expect(serverPrefixOf('clerum__tool_search')).toBe('clerum')
    expect(serverPrefixOf('file_read')).toBe('native')
  })
})

describe('clerum__tool_search — buildToolSearchResponse', () => {
  it('matches tools by name', () => {
    const out = buildToolSearchResponse(CATALOG, 'forecast', {})
    expect(out.found).toBe(1)
    expect(out.results[0].name).toBe('weather__forecast')
    expect(out.results[0].server).toBe('weather')
  })

  it('matches tools by description', () => {
    const out = buildToolSearchResponse(CATALOG, 'memories', {})
    expect(out.found).toBe(1)
    expect(out.results[0].name).toBe('brain__search_notes')
  })

  it('applies the server filter', () => {
    const out = buildToolSearchResponse(CATALOG, 'create', { server: 'brain' })
    expect(out.found).toBe(1)
    expect(out.results.every(r => r.server === 'brain')).toBe(true)
    expect(out.results[0].name).toBe('brain__create_note')
  })

  it('respects the limit', () => {
    const out = buildToolSearchResponse(CATALOG, 'task note brain board', { limit: 2 })
    expect(out.results.length).toBe(2)
    expect(out.returned).toBe(2)
  })

  it('reports found = total matches and returned = capped count when truncated', () => {
    // 4 tools match "task note brain board"; capping at limit 2 must still
    // report all 4 in `found` while `returned` reflects the slice.
    const out = buildToolSearchResponse(CATALOG, 'task note brain board', { limit: 2 })
    expect(out.found).toBeGreaterThan(out.returned)
    expect(out.found).toBe(4)
    expect(out.returned).toBe(2)
    expect(out.results.length).toBe(2)
  })

  it('caps the limit at the sane maximum', () => {
    const big: McpTool[] = Array.from({ length: 100 }, (_, i) =>
      mcpTool(`srv__tool_${i}`, 'searchable tool')
    )
    const out = buildToolSearchResponse(big, 'searchable', { limit: 999 })
    expect(out.results.length).toBe(50)
    // All 100 matched even though only 50 are returned.
    expect(out.found).toBe(100)
    expect(out.returned).toBe(50)
  })

  it('falls back to the default limit for a non-finite (NaN) limit', () => {
    const big: McpTool[] = Array.from({ length: 30 }, (_, i) =>
      mcpTool(`srv__tool_${i}`, 'searchable tool')
    )
    const out = buildToolSearchResponse(big, 'searchable', { limit: Number.NaN })
    expect(out.results.length).toBe(20)
  })

  it('NEVER includes a parameters/schema field on results', () => {
    const out = buildToolSearchResponse(CATALOG, 'search create task', {})
    expect(out.found).toBeGreaterThan(0)
    for (const r of out.results) {
      expect(r).not.toHaveProperty('parameters')
      expect(r).not.toHaveProperty('inputSchema')
      expect(r).not.toHaveProperty('schema')
      expect(Object.keys(r).sort()).toEqual(['description', 'name', 'server'])
    }
  })

  it('returns empty for an empty catalog', () => {
    const out = buildToolSearchResponse([], 'anything', {})
    expect(out).toEqual({ found: 0, returned: 0, results: [] })
  })

  it('returns empty when nothing matches', () => {
    const out = buildToolSearchResponse(CATALOG, 'zzz_nonexistent_keyword', {})
    expect(out).toEqual({ found: 0, returned: 0, results: [] })
  })

  it('ranks a name match above a description-only match', () => {
    // "harvest" is in one tool's NAME and another tool's DESCRIPTION only.
    const catalog: McpTool[] = [
      mcpTool('farm__harvest_crop', 'Gather the produce'),
      mcpTool('farm__store_grain', 'Run after the harvest to store grain'),
    ]
    const out = buildToolSearchResponse(catalog, 'harvest', {})
    expect(out.found).toBe(2)
    // The name match (+2) must outrank the description-only match (+1).
    expect(out.results[0].name).toBe('farm__harvest_crop')
    expect(out.results[1].name).toBe('farm__store_grain')
  })

  it('uses the authoritative serverName, not name-splitting, for a server whose name contains __', () => {
    // A server literally named "foo__bar" would be mis-parsed by string
    // splitting; serverName is the source of truth.
    const tool: McpTool = {
      name: 'foo__bar__do_thing',
      description: 'searchable widget',
      inputSchema: { type: 'object', properties: {} },
      serverName: 'foo__bar',
    }
    const out = buildToolSearchResponse([tool], 'searchable', {})
    expect(out.results[0].server).toBe('foo__bar')
    // And the server filter matches the real server name.
    expect(buildToolSearchResponse([tool], 'searchable', { server: 'foo__bar' }).found).toBe(1)
    expect(buildToolSearchResponse([tool], 'searchable', { server: 'foo' }).found).toBe(0)
  })
})

describe('clerum__tool_describe — buildToolDescribeResponse', () => {
  it('returns the full schema for a known tool', () => {
    const out = buildToolDescribeResponse(CATALOG, 'brain__search_notes')
    expect(out.found).toBe(true)
    expect(out.name).toBe('brain__search_notes')
    expect(out.server).toBe('brain')
    expect(out.description).toBe('Search the brain for notes and memories')
    expect(out.parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    })
  })

  it('returns { found: false } for an unknown name without throwing', () => {
    const out = buildToolDescribeResponse(CATALOG, 'does__not_exist')
    expect(out).toEqual({ found: false })
  })

  it('returns { found: false } for an empty name', () => {
    expect(buildToolDescribeResponse(CATALOG, '')).toEqual({ found: false })
  })

  it('parses the server prefix correctly', () => {
    const out = buildToolDescribeResponse(CATALOG, 'weather__forecast')
    expect(out.server).toBe('weather')
  })

  it('reports the authoritative serverName even when it contains __', () => {
    const tool: McpTool = {
      name: 'foo__bar__do_thing',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      serverName: 'foo__bar',
    }
    const out = buildToolDescribeResponse([tool], 'foo__bar__do_thing')
    expect(out.found).toBe(true)
    expect(out.server).toBe('foo__bar')
  })
})

describe('tool factories — definition + execute', () => {
  it('tool_search uses the clerum__ prefix and required query param', () => {
    const tool = createToolSearchTool(() => CATALOG)
    expect(tool.name).toBe('clerum__tool_search')
    expect(tool.parameters).toMatchObject({ required: ['query'] })
  })

  it('tool_describe uses the clerum__ prefix and required name param', () => {
    const tool = createToolDescribeTool(() => CATALOG)
    expect(tool.name).toBe('clerum__tool_describe')
    expect(tool.parameters).toMatchObject({ required: ['name'] })
  })

  it('tool_search execute returns JSON content with no schema field', async () => {
    const tool = createToolSearchTool(() => CATALOG)
    const result = await tool.execute({ query: 'forecast' }, '/tmp')
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.content!)
    expect(parsed.found).toBe(1)
    expect(JSON.stringify(parsed)).not.toContain('inputSchema')
    expect(parsed.results[0]).not.toHaveProperty('parameters')
  })

  it('tool_search reads the catalog lazily on each call (stateless)', async () => {
    let catalog: McpTool[] = []
    const tool = createToolSearchTool(() => catalog)
    const empty = JSON.parse((await tool.execute({ query: 'forecast' }, '/tmp')).content!)
    expect(empty.found).toBe(0)
    catalog = CATALOG
    const full = JSON.parse((await tool.execute({ query: 'forecast' }, '/tmp')).content!)
    expect(full.found).toBe(1)
  })

  it('tool_search execute returns an informative message for an empty query', async () => {
    const tool = createToolSearchTool(() => CATALOG)
    const result = await tool.execute({ query: '   ' }, '/tmp')
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.content!)
    expect(parsed).toEqual({
      found: 0,
      returned: 0,
      results: [],
      message: 'Empty query — provide keywords to search the tool catalog.',
    })
  })

  it('tool_search execute returns the empty-query message when query is missing', async () => {
    const tool = createToolSearchTool(() => CATALOG)
    const result = await tool.execute({}, '/tmp')
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.content!)
    expect(parsed.message).toBe('Empty query — provide keywords to search the tool catalog.')
  })

  it('tool_describe execute returns the schema for a known tool', async () => {
    const tool = createToolDescribeTool(() => CATALOG)
    const result = await tool.execute({ name: 'brain__create_note' }, '/tmp')
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.content!)
    expect(parsed.found).toBe(true)
    expect(parsed.parameters).toBeDefined()
  })

  it('tool_describe execute returns { found: false } for an unknown name', async () => {
    const tool = createToolDescribeTool(() => CATALOG)
    const result = await tool.execute({ name: 'nope__nope' }, '/tmp')
    expect(result.success).toBe(true)
    expect(JSON.parse(result.content!)).toEqual({ found: false })
  })
})
