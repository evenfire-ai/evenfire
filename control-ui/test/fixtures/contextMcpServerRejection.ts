/**
 * Producer fixtures: the 422 bodies `POST`/`PUT /admin/contexts` answer when a write
 * adds connector names control-api refuses (`refuseUnverifiedAddedMcpServers` in
 * control-api/src/routes/admin/resources.ts).
 *
 * control-api is not importable from this package, so these are the golden wire files
 * control-api's own route test captures from the real resources router over an
 * in-memory apiserver: control-api/test/routes.contextRejection.wireGoldens.test.ts →
 * control-api/test/fixtures/wire/contextRejection.*.json. A producer change breaks the
 * golden there before it can drift here. Tests turn these bodies into errors through
 * the real fetch client, never by building error objects by hand.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type WireCapture = { status: number; body: Record<string, unknown> }

const WIRE_DIR = resolve(__dirname, '../../../control-api/test/fixtures/wire')

function loadGolden(name: string): WireCapture {
  return JSON.parse(readFileSync(resolve(WIRE_DIR, `contextRejection.${name}.json`), 'utf8'))
}

const UNKNOWN_MCP_SERVER = loadGolden('unknownMcpServer')
const REJECTION_STATUS = UNKNOWN_MCP_SERVER.status

/** A PUT that added `mcp-vanished`, which has no live McpServer. */
export const UNKNOWN_MCP_SERVER_BODY = UNKNOWN_MCP_SERVER.body
/** A create naming two connectors that do not exist, as the router lists them. */
export const UNKNOWN_MCP_SERVERS_BODY = loadGolden('unknownMcpServers').body
/** A write adding more names than the server's per-write cap. */
export const TOO_MANY_MCP_SERVERS_BODY = loadGolden('tooManyMcpServers').body

/**
 * The `unknown_mcp_server` golden for other refused names. The router lists exactly
 * the added names it could not find, sorted, so only that list is substituted; if the
 * golden stops carrying it under `mcpServers`, this throws instead of re-adding the key
 * and hiding a contract change from the UI tests.
 */
export function unknownMcpServerBody(mcpServers: string[]): Record<string, unknown> {
  if (!Array.isArray(UNKNOWN_MCP_SERVER_BODY.mcpServers)) {
    throw new Error('the unknown_mcp_server golden no longer carries an mcpServers list')
  }
  return { ...UNKNOWN_MCP_SERVER_BODY, mcpServers: [...mcpServers].sort() }
}

/** The response as control-ui's fetch client sees it through the proxy. */
export function contextRejectionResponse(body: unknown): Response {
  return {
    ok: false,
    status: REJECTION_STATUS,
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
