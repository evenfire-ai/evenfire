/**
 * Web Search MCP Server
 *
 * A StreamableHTTP MCP server that wraps the Brave Search API for real web search.
 * Exposes three tools:
 *   - web_search: search the web via Brave Search API
 *   - fetch_page: fetch and extract text content from a URL
 *   - search_news: search recent news via Brave Search API
 *
 * Environment variables:
 *   - SEARCH_API_KEY: Brave Search API subscription token
 *   - PORT: HTTP port (default 3000)
 */
import express, { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { fetchPage } from './fetchPage.js'
import { FetchPageError } from './fetchPageError.js'

const PORT = parseInt(process.env.PORT || '3000', 10)
const SEARCH_API_KEY = process.env.SEARCH_API_KEY || ''

const BRAVE_SEARCH_BASE = 'https://api.search.brave.com/res/v1'

// ---------------------------------------------------------------------------
// Brave Search API helpers
// ---------------------------------------------------------------------------

interface WebResult {
  title: string
  url: string
  snippet: string
}

interface NewsResult {
  title: string
  url: string
  date: string
  snippet: string
}

async function braveWebSearch(query: string, maxResults: number): Promise<WebResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(maxResults),
  })

  const res = await fetch(`${BRAVE_SEARCH_BASE}/web/search?${params}`, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': SEARCH_API_KEY,
    },
  })

  if (!res.ok) {
    throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> }
  }

  return (data.web?.results ?? []).slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }))
}

async function braveNewsSearch(
  query: string,
  freshness: 'day' | 'week' | 'month',
  maxResults: number
): Promise<NewsResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(maxResults),
    freshness,
  })

  const res = await fetch(`${BRAVE_SEARCH_BASE}/news/search?${params}`, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': SEARCH_API_KEY,
    },
  })

  if (!res.ok) {
    throw new Error(`Brave News API error: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as {
    results?: Array<{
      title: string
      url: string
      age: string
      description: string
    }>
  }

  return (data.results ?? []).slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.url,
    date: r.age,
    snippet: r.description,
  }))
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'web-search',
    version: '1.0.0',
  })

  // -- Tool 1: web_search --------------------------------------------------

  server.tool(
    'web_search',
    'Search the web using the Brave Search API. Returns titles, URLs, and snippets.',
    {
      query: z.string().describe('The search query'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe('Maximum number of results to return (default 5)'),
    },
    async ({ query, maxResults }: { query: string; maxResults: number }) => {
      if (!SEARCH_API_KEY) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                [
                  {
                    title: 'SEARCH_API_KEY not configured',
                    url: 'https://brave.com/search/api/',
                    snippet:
                      'Set the SEARCH_API_KEY environment variable with a valid Brave Search API subscription token to enable real web search.',
                  },
                ],
                null,
                2
              ),
            },
          ],
        }
      }

      try {
        const results = await braveWebSearch(query, maxResults)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error performing web search: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // -- Tool 2: fetch_page --------------------------------------------------

  server.tool(
    'fetch_page',
    'Fetch a web page and return its text content with HTML tags stripped.',
    {
      url: z.string().url().describe('The URL to fetch'),
      maxChars: z
        .number()
        .int()
        .min(100)
        .max(100000)
        .optional()
        .default(10000)
        .describe('Maximum characters to return (default 10000)'),
    },
    async ({ url, maxChars }: { url: string; maxChars: number }, extra) => {
      try {
        const result = await fetchPage(url, maxChars, extra.signal)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (error) {
        const code = error instanceof FetchPageError ? error.code : 'upstream_failure'
        return { content: [{ type: 'text' as const, text: code }], isError: true }
      }
    }
  )

  // -- Tool 3: search_news -------------------------------------------------

  server.tool(
    'search_news',
    'Search recent news using the Brave Search API. Returns titles, URLs, dates, and snippets.',
    {
      query: z.string().describe('The news search query'),
      freshness: z
        .enum(['day', 'week', 'month'])
        .optional()
        .default('week')
        .describe('How recent the news should be: "day", "week", or "month" (default "week")'),
    },
    async ({ query, freshness }: { query: string; freshness: 'day' | 'week' | 'month' }) => {
      if (!SEARCH_API_KEY) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                [
                  {
                    title: 'SEARCH_API_KEY not configured',
                    url: 'https://brave.com/search/api/',
                    date: 'N/A',
                    snippet:
                      'Set the SEARCH_API_KEY environment variable with a valid Brave Search API subscription token to enable real news search.',
                  },
                ],
                null,
                2
              ),
            },
          ],
        }
      }

      try {
        const results = await braveNewsSearch(query, freshness, 10)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error performing news search: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  return server
}

// ---------------------------------------------------------------------------
// Express + StreamableHTTP Transport
// ---------------------------------------------------------------------------

const app = express()

const transports = new Map<string, StreamableHTTPServerTransport>()

// Health endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    tools: ['web_search', 'fetch_page', 'search_news'],
    searchApiConfigured: !!SEARCH_API_KEY,
  })
})

// MCP StreamableHTTP endpoint
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    // Existing session
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!
      await transport.handleRequest(req, res)
      return
    }

    // New session (initialize)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    })

    const server = createMcpServer()
    await server.connect(transport)

    await transport.handleRequest(req, res)

    const assignedSessionId = (transport as any).sessionId as string | undefined
    if (assignedSessionId) {
      transports.set(assignedSessionId, transport)
    }

    const onTransportClose = transport.onclose
    transport.onclose = () => {
      // Preserve SDK cancellation of in-flight handlers when the session closes.
      onTransportClose?.()
      if (assignedSessionId) {
        transports.delete(assignedSessionId)
      }
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP request failed' })
    }
  }
})

// GET /mcp for SSE session resumption
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!
    await transport.handleRequest(req, res)
    return
  }
  res.status(400).json({ error: 'Bad request — send POST to initialize' })
})

// DELETE /mcp to close a session
app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!
    await transport.handleRequest(req, res)
    return
  }
  res.status(400).json({ error: 'No active session to close' })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WebSearch] StreamableHTTP MCP server listening on port ${PORT}`)
  console.log(
    `[WebSearch] Brave Search API: ${SEARCH_API_KEY ? 'configured' : 'NOT configured (mock responses enabled)'}`
  )
})
