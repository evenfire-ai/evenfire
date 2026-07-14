import type { McpTool } from '../types'
import type { InternalToolDefinition, InternalToolResult } from '../workflow/types'

/**
 * Read-only meta-tools for dynamic tool discovery (Phase F2 of the
 * dynamic-tool-loading "stable bridge" design).
 *
 * Both tools are stateless and query the live MCP catalog on demand via a
 * `getCatalog` provider (in production this is bound to
 * `McpManager.getAllTools()`). They never mutate session state and never
 * advertise MCP tools into the `tools[]` array — the whole point of the
 * design is to keep schemas OUT of the prompt prefix.
 *
 *   - `clerum__tool_search`   → ranks tools by keyword over name+description,
 *                               returns name/server/description, NEVER schemas
 *                               (Critical Detail #4).
 *   - `clerum__tool_describe` → returns the full JSON schema for ONE tool,
 *                               on demand (Critical Detail #5).
 *
 * The env/catalog provider is supplied by the caller so this module stays
 * decoupled from McpManager wiring (same pattern as getCapabilitiesTool).
 */
export type CatalogProvider = () => McpTool[]

/** Default cap for tool_search results. The model asks for one schema at a
 * time via tool_describe, so the search result stays a small, schema-free
 * index even with a 290-tool catalog. */
const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 50

export interface ToolSearchResultEntry {
  name: string
  server: string
  description: string
}

export interface ToolSearchResponse {
  /** Total number of tools that matched the query, BEFORE the `limit` slice. */
  found: number
  /** Number of tools actually returned (`results.length`); `<= found`. */
  returned: number
  results: ToolSearchResultEntry[]
  /** Optional hint set when the query was empty/whitespace-only. */
  message?: string
}

export interface ToolDescribeResponse {
  found: boolean
  name?: string
  server?: string
  description?: string
  parameters?: Record<string, unknown>
}

/**
 * Derive the logical server name from a prefixed tool name. MCP tools are
 * prefixed `${server}__${tool}` (double underscore). Tools without a `__`
 * separator are native and reported as `"native"`.
 *
 * This is only a FALLBACK: `McpTool.serverName` is the authoritative source
 * and is preserved through `getAllTools()`. Prefer `serverNameOf` below,
 * which reads `serverName` and string-splits only when it is absent. Parsing
 * the name truncates servers whose own name contains `__`.
 */
export function serverPrefixOf(name: string): string {
  const idx = name.indexOf('__')
  if (idx <= 0) return 'native'
  return name.slice(0, idx)
}

/**
 * Authoritative server name for a catalog tool: the `serverName` field set by
 * the MCP client, falling back to parsing the prefixed name only when it is
 * missing (e.g. native tools, which report `"native"`).
 */
export function serverNameOf(tool: McpTool): string {
  return tool.serverName || serverPrefixOf(tool.name)
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0)
}

/**
 * Simple, dependency-free keyword overlap scorer. Counts how many distinct
 * query tokens appear (as substrings of tokens) in the tool's name+description.
 * Name matches are weighted slightly higher than description matches so a
 * query that hits the tool name ranks above one that only hits the prose.
 * No embeddings, no external index — keyword/overlap as mandated by the spec.
 */
function scoreTool(queryTokens: string[], name: string, description: string): number {
  if (queryTokens.length === 0) return 0
  const nameTokens = new Set(tokenize(name))
  const descTokens = new Set(tokenize(description))
  let score = 0
  for (const qt of queryTokens) {
    let matched = false
    for (const nt of nameTokens) {
      if (nt.includes(qt)) {
        score += 2
        matched = true
        break
      }
    }
    if (matched) continue
    for (const dt of descTokens) {
      if (dt.includes(qt)) {
        score += 1
        break
      }
    }
  }
  return score
}

export function buildToolSearchResponse(
  catalog: McpTool[],
  query: string,
  options: { server?: string; limit?: number }
): ToolSearchResponse {
  const queryTokens = tokenize(query)
  const serverFilter = options.server?.trim()
  // Fall back to the default for non-finite limits (e.g. NaN) — `slice(0, NaN)`
  // would otherwise silently return zero results.
  const requestedLimit = Number.isFinite(options.limit)
    ? (options.limit as number)
    : DEFAULT_SEARCH_LIMIT
  const limit = Math.min(Math.max(1, Math.floor(requestedLimit)), MAX_SEARCH_LIMIT)

  const scored: Array<{ entry: ToolSearchResultEntry; score: number }> = []
  for (const tool of catalog) {
    const server = serverNameOf(tool)
    if (serverFilter && server !== serverFilter) continue
    const description = tool.description ?? ''
    const score = scoreTool(queryTokens, tool.name, description)
    if (score <= 0) continue
    scored.push({ entry: { name: tool.name, server, description }, score })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.entry.name.localeCompare(b.entry.name)
  })

  const results = scored.slice(0, limit).map(s => s.entry)
  // `found` is the TOTAL number of matches (before the limit slice); `returned`
  // is how many we actually return. Exposing both lets the model tell when the
  // result set was truncated (`found > returned`) and refine the query or raise
  // `limit`, instead of reading the capped count as "all there is".
  return { found: scored.length, returned: results.length, results }
}

export function buildToolDescribeResponse(catalog: McpTool[], name: string): ToolDescribeResponse {
  const target = name?.trim()
  if (!target) return { found: false }
  const tool = catalog.find(t => t.name === target)
  if (!tool) return { found: false }
  return {
    found: true,
    name: tool.name,
    server: serverNameOf(tool),
    description: tool.description ?? '',
    parameters: tool.inputSchema,
  }
}

/**
 * `clerum__tool_search` — read-only, stateless keyword search over the MCP
 * catalog. Returns name/server/description only; NEVER schemas (Critical
 * Detail #4 — schemas are exactly the prefix cost the bridge avoids).
 */
export function createToolSearchTool(getCatalog: CatalogProvider): InternalToolDefinition {
  return {
    name: 'clerum__tool_search',
    description:
      'Search the full catalog of available tools by keyword. Returns a ' +
      'lightweight index of matching tools (name, server, description) — NOT ' +
      'their input schemas. Use this to discover tools that are not listed ' +
      'directly, then call `clerum__tool_describe` to fetch the schema of one. ' +
      '`found` is the total number of matches; `returned` may be smaller when ' +
      'capped at `limit` — refine the query or raise `limit` if `found > returned`.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for.' },
        server: {
          type: 'string',
          description: 'Optional: restrict results to a single MCP server name.',
        },
        limit: {
          type: 'number',
          description: `Optional: max results to return (default ${DEFAULT_SEARCH_LIMIT}, capped at ${MAX_SEARCH_LIMIT}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>): Promise<InternalToolResult> {
      try {
        // Lenient at runtime by design: a missing/non-string query coerces to
        // '' and yields an empty result rather than failing the call, mirroring
        // tool_describe's empty-name handling.
        const query = typeof args.query === 'string' ? args.query : ''
        const server = typeof args.server === 'string' ? args.server : undefined
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        // Empty/whitespace-only query: return an informative result rather than a
        // bare `{ found: 0 }`, which reads like "no tools exist" to the model.
        if (query.trim().length === 0) {
          const payload: ToolSearchResponse = {
            found: 0,
            returned: 0,
            results: [],
            message: 'Empty query — provide keywords to search the tool catalog.',
          }
          return { success: true, content: JSON.stringify(payload) }
        }
        const payload = buildToolSearchResponse(getCatalog(), query, { server, limit })
        return { success: true, content: JSON.stringify(payload) }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

/**
 * `clerum__tool_describe` — read-only, stateless. Returns the full JSON
 * schema for ONE tool on demand. An unknown name yields `{ found: false }`
 * rather than failing the call (Phase F2.2).
 */
export function createToolDescribeTool(getCatalog: CatalogProvider): InternalToolDefinition {
  return {
    name: 'clerum__tool_describe',
    description:
      'Fetch the full input schema for a single tool by its exact name (as ' +
      'returned by `clerum__tool_search`). Returns `{ found: false }` for an ' +
      'unknown name. Use the schema to build a correct call.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name to describe.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>): Promise<InternalToolResult> {
      try {
        const name = typeof args.name === 'string' ? args.name : ''
        const payload = buildToolDescribeResponse(getCatalog(), name)
        return { success: true, content: JSON.stringify(payload) }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

/**
 * `clerum__tool_call` — the execution bridge for deferred MCP tools (Phase F3.2).
 *
 * IMPORTANT: this `execute` is a SAFETY NET only. The real handling happens in
 * `executeToolCalls` (`core/orchestration/toolUseLoopToolBatch.ts`), which
 * intercepts `clerum__tool_call` at the TOP of the per-call loop, BEFORE the
 * approval/validation gate, unwraps `{ name, arguments }`, and rewrites the
 * call to a synthetic call against the REAL MCP tool so approval/validation run
 * against the real name (LOCKED #8). The tool is still registered as a native so
 * it appears in `tools[]` and in `nativeNames`. If `execute` is ever reached
 * (the intercept did not fire), we return an error rather than silently doing
 * nothing — that would be a bug, not a normal path.
 */
export function createToolCallTool(): InternalToolDefinition {
  return {
    name: 'clerum__tool_call',
    description:
      'Invoke a tool discovered via `clerum__tool_search` / `clerum__tool_describe` ' +
      'by its exact name. Pass the target tool name and its arguments. Use this ' +
      'for tools that are not listed directly; native tools are called directly.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact name of the tool to invoke (as returned by tool_search).',
        },
        arguments: {
          type: 'object',
          description: 'Arguments object for the target tool, matching its schema.',
          additionalProperties: true,
        },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    },
    async execute(): Promise<InternalToolResult> {
      // Reaching here means the batch-loop intercept did not run. Fail loudly
      // rather than silently no-op'ing.
      return {
        success: false,
        error:
          'clerum__tool_call must be invoked through the dynamic-tools bridge; ' +
          'direct execution is not supported.',
      }
    },
  }
}
