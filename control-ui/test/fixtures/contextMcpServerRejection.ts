/**
 * The 422 bodies `POST`/`PUT /admin/contexts` answer when the write adds connector
 * names control-api refuses: `refuseUnverifiedAddedMcpServers` in
 * control-api/src/routes/admin/resources.ts.
 *
 * These are not loaded from a control-api wire golden because this branch does not
 * carry that control-api code yet; the shapes are copied verbatim from that function,
 * `message` strings included, and every test turns them into errors through the real
 * fetch client rather than building error objects by hand. Once this branch is
 * integrated into the main branch, which already has the 422 code, replace them with a
 * golden captured from the real router.
 */

/** A write added a name with no live McpServer behind it. */
export function unknownMcpServerBody(mcpServers: string[]) {
  return {
    error: 'unknown_mcp_server',
    mcpServers,
    message: 'one or more connectors no longer exist; reload and try again',
  }
}

/** Server-side cap on the names one write may add (MAX_ADDED_MCP_SERVERS_PER_WRITE). */
export const TOO_MANY_MCP_SERVERS_BODY = {
  error: 'too_many_mcp_servers',
  limit: 256,
  message: 'a single write may add at most 256 connectors to a context',
}

/** The response as control-ui's fetch client sees it through the proxy. */
export function contextRejectionResponse(body: unknown): Response {
  return {
    ok: false,
    status: 422,
    statusText: 'Unprocessable Entity',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response
}

export function okJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response
}

/**
 * The error the real client throws for a refused context write. Pass the actual
 * `lib/api` module (`vi.importActual`) when the test mocks it.
 */
export async function contextRejectionError(
  api: Pick<typeof import('../../lib/api'), 'updateContext'>,
  body: unknown
): Promise<Error> {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => contextRejectionResponse(body)) as typeof fetch
  try {
    await api.updateContext('producer-context', {
      metadata: { resourceVersion: '1' },
      spec: { contextId: 'producer-context', mcpServers: [] },
    })
  } catch (error) {
    return error as Error
  } finally {
    globalThis.fetch = realFetch
  }
  throw new Error('the context write was expected to be refused')
}
