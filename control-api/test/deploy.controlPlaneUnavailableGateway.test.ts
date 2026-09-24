import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// G1-10 (#720): a 502 that a gateway generates itself means control-api
// produced no valid response (connect refused, closed before a response, or an
// invalid header; `proxy_intercept_errors` is off, so a 502 control-api returns
// passes through). On the hops whose failure reaches the user, that 502 is
// answered as JSON `control_plane_unavailable`. A 504 is not mapped: control-api
// may be alive and slow.

const CONFIG = readFileSync(
  new URL('../../deploy/base/control-plane/configmaps.yaml', import.meta.url),
  'utf-8'
)

const ERROR_PAGE = 'error_page 502 = @control_plane_unavailable;'
const NAMED_LOCATION = 'location @control_plane_unavailable {'

const AUTHORIZE = 'location = /api/v1/mcp-host/llm/provider-attempts/authorize {'
const CODEX_REDEEM = 'location = /api/v1/internal/llm/provider-attempts/redeem {'
const GROK_REDEEM = 'location = /api/v1/internal/llm/grok/provider-attempts/redeem {'
const CODEX_FINALIZE = 'location = /api/v1/internal/llm/provider-attempts/finalize {'
const GROK_FINALIZE = 'location = /api/v1/internal/llm/grok/provider-attempts/finalize {'

/** One ConfigMap document of configmaps.yaml, selected by its metadata name. */
function configMap(name: string): string {
  const docs = CONFIG.split('\n---\n').filter(doc => doc.includes(`\n  name: ${name}\n`))
  expect(docs, `configmaps.yaml must declare exactly one ConfigMap ${name}`).toHaveLength(1)
  return docs[0]
}

/** The body of one nginx `location` block, from its opening line to its closing brace. */
function locationBlock(config: string, opening: string): string {
  const start = config.indexOf(opening)
  expect(start, `the ConfigMap must declare ${opening}`).toBeGreaterThanOrEqual(0)
  expect(config.indexOf(opening, start + 1), `${opening} must appear once`).toBe(-1)
  const end = config.indexOf('\n        }', start)
  expect(end).toBeGreaterThan(start)
  return config.slice(start, end)
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

const WORKFLOW_APPROVAL_GATEWAY = 'nginx-workflow-approval-gateway'
const RPC_GATEWAY = 'control-api-rpc-gateway'

describe('gateway-generated 502 on user-facing control-plane hops (G1-10, #720)', () => {
  it.each([
    ['H2 authorize', WORKFLOW_APPROVAL_GATEWAY, AUTHORIZE],
    ['H3 Codex redeem', RPC_GATEWAY, CODEX_REDEEM],
    ['H3 Grok redeem', RPC_GATEWAY, GROK_REDEEM],
  ])('G1-10a: %s answers its own 502 as control_plane_unavailable', (_hop, gateway, opening) => {
    const block = locationBlock(configMap(gateway), opening)
    // Witness: this is the block that proxies to control-api.
    expect(block).toContain('proxy_pass http://control_api_upstream;')
    expect(count(block, ERROR_PAGE)).toBe(1)
  })

  it.each([WORKFLOW_APPROVAL_GATEWAY, RPC_GATEWAY])(
    'G1-10b: %s answers 503 JSON control_plane_unavailable with no-store headers',
    gateway => {
      const block = locationBlock(configMap(gateway), NAMED_LOCATION)
      expect(block).toContain('default_type application/json;')
      expect(block).toContain(`return 503 '{"error":"control_plane_unavailable"}';`)
      expect(block).toContain('add_header Cache-Control "no-store, private" always;')
      expect(block).toContain('add_header Pragma "no-cache" always;')
      expect(block).toContain('add_header X-Content-Type-Options "nosniff" always;')
    }
  )

  it.each([
    ['Codex finalize', CODEX_FINALIZE],
    ['Grok finalize', GROK_FINALIZE],
  ])('G1-10c: %s keeps nginx default error handling', (_route, opening) => {
    const block = locationBlock(configMap(RPC_GATEWAY), opening)
    // Witness: the finalize block exists and proxies to control-api.
    expect(block).toContain('proxy_pass http://control_api_upstream;')
    expect(block).not.toContain('error_page')
  })

  it('G1-10d: the mapping stays on the three user-facing hops and never covers a 504', () => {
    const approval = configMap(WORKFLOW_APPROVAL_GATEWAY)
    const rpc = configMap(RPC_GATEWAY)
    // Witnesses: each gateway carries the directive, on exactly its hops.
    expect(count(approval, ERROR_PAGE)).toBe(1)
    expect(count(rpc, ERROR_PAGE)).toBe(2)
    for (const gateway of [approval, rpc]) {
      expect(gateway).toContain(NAMED_LOCATION)
      expect(gateway).not.toMatch(/error_page[^;]*\b504\b/)
    }
  })
})
