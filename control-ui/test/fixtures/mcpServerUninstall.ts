/**
 * Producer fixtures — the 503 body `DELETE /admin/mcp-servers/:name` returns when the
 * uninstall stops at a failing cleanup step with the CR still present.
 *
 * control-api is not importable from this package, so the bodies are the golden wire
 * files control-api's own route test asserts its real responses against
 * (control-api/test/routes.mcpServerUninstall.repairRequired.test.ts →
 * control-api/test/fixtures/wire/mcpServerUninstallIncomplete.*.json). Loading the
 * same bytes means a producer change breaks the golden there before it can drift here.
 *
 * `pending` lists every stage the failing step left undone: one element for the
 * Context, Secret and CR steps, and both OAuth stages when the teardown fails on
 * both.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type ProducerMcpServerUninstallIncompleteBody = {
  error: string
  outcome: string
  pending: string[]
  deleted: string[]
}

const WIRE_DIR = resolve(__dirname, '../../../control-api/test/fixtures/wire')

function loadGolden(stage: string): ProducerMcpServerUninstallIncompleteBody {
  return JSON.parse(
    readFileSync(resolve(WIRE_DIR, `mcpServerUninstallIncomplete.${stage}.json`), 'utf8')
  )
}

/** Secret delete failed after the Context strip: CR and Secret still present. */
export const SECRETS_PENDING_BODY = loadGolden('secrets')

/** Every dependency cleaned, the CR delete itself failed. */
export const MCP_SERVER_PENDING_BODY = loadGolden('mcp_server')

/** DB outage during the OAuth teardown: both OAuth stages pending. */
export const OAUTH_PENDING_BODY = loadGolden('oauth')

export const ALL_PENDING_BODIES = [
  SECRETS_PENDING_BODY,
  MCP_SERVER_PENDING_BODY,
  OAUTH_PENDING_BODY,
]

/** Response as control-ui's fetch client sees it through the proxy. */
export function uninstallIncompleteResponse(body: unknown): Response {
  return {
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    text: async () => JSON.stringify(body),
  } as unknown as Response
}
