import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// G1-10 (#720): a 502 that a gateway generates itself means control-api
// produced no valid response (connect refused, closed before a response, or an
// invalid header; `proxy_intercept_errors` is off, so a 502 control-api returns
// passes through). In the last two cases control-api may already have processed
// the request. On the hops whose failure reaches the user, that 502 is answered
// as JSON `control_plane_unavailable`.
//
// G1-12 (#820): nginx answers 504 both for a connect timeout and for a read or
// send timeout. Only a connect timeout leaves `$upstream_connect_time` at "-"
// (nginx assigns it in `ngx_http_upstream_send_request`, which a connect
// timeout never reaches), so on the same hops only that 504 is mapped. A
// read-timeout 504 keeps nginx's own answer: control-api may be alive and slow.

const CONFIG = readFileSync(
  new URL('../../deploy/base/control-plane/configmaps.yaml', import.meta.url),
  'utf-8'
)

/** `CONTROL_API_REQUEST_TIMEOUT_MS` of one proxy: how long it waits for redeem. */
function proxyRedeemAbortMs(proxy: string): number {
  const source = readFileSync(
    new URL(`../../${proxy}/src/controlApiClient.ts`, import.meta.url),
    'utf-8'
  )
  const match = source.match(/export const CONTROL_API_REQUEST_TIMEOUT_MS = ([0-9_]+)\n/)
  expect(match, `${proxy} must export CONTROL_API_REQUEST_TIMEOUT_MS as a literal`).not.toBeNull()
  return Number(match![1].replace(/_/g, ''))
}

/** The one `proxy_connect_timeout` in a block, in milliseconds (`Ns` or `Nms`). */
function connectTimeoutMs(block: string): number {
  const matches = [...block.matchAll(/\bproxy_connect_timeout\s+([0-9]+)(ms|s)\s*;/g)]
  expect(matches, 'exactly one proxy_connect_timeout').toHaveLength(1)
  const [, value, unit] = matches[0]
  return unit === 's' ? Number(value) * 1000 : Number(value)
}

// Any spelling nginx accepts: `error_page 502 = @x;`, `error_page 502 =@x;`, …
const ERROR_PAGE = /error_page\s+502\s*=\s*@control_plane_unavailable\s*;/g
// Any error_page that covers a 502, whatever it points to.
const ANY_502_ERROR_PAGE = /error_page[^;]*\b502\b[^;]*;/g
const INTERCEPT_ON = /\bproxy_intercept_errors\s+on\s*;/
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

/** The ConfigMap without `#` comments, so only nginx directives are matched. */
function directives(config: string): string {
  return config
    .split('\n')
    .map(line => line.replace(/#.*$/, ''))
    .join('\n')
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

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

const WORKFLOW_APPROVAL_GATEWAY = 'nginx-workflow-approval-gateway'
const RPC_GATEWAY = 'control-api-rpc-gateway'

describe('gateway-generated 502 on user-facing control-plane hops (G1-10, #720)', () => {
  it.each([
    ['H2 authorize', WORKFLOW_APPROVAL_GATEWAY, AUTHORIZE],
    ['H3 Codex redeem', RPC_GATEWAY, CODEX_REDEEM],
    ['H3 Grok redeem', RPC_GATEWAY, GROK_REDEEM],
  ])('G1-10a: %s answers its own 502 as control_plane_unavailable', (_hop, gateway, opening) => {
    const block = locationBlock(directives(configMap(gateway)), opening)
    // Witness: this is the block that proxies to control-api.
    expect(block).toContain('proxy_pass http://control_api_upstream;')
    expect(count(block, ERROR_PAGE)).toBe(1)
  })

  it.each([WORKFLOW_APPROVAL_GATEWAY, RPC_GATEWAY])(
    'G1-10b: %s answers 503 JSON control_plane_unavailable with no-store headers',
    gateway => {
      const block = locationBlock(directives(configMap(gateway)), NAMED_LOCATION)
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
    const block = locationBlock(directives(configMap(RPC_GATEWAY)), opening)
    // Witness: the finalize block exists and proxies to control-api.
    expect(block).toContain('proxy_pass http://control_api_upstream;')
    expect(block).not.toContain('error_page')
  })

  it('G1-10d: the 502 mapping stays on the three user-facing hops', () => {
    const approval = directives(configMap(WORKFLOW_APPROVAL_GATEWAY))
    const rpc = directives(configMap(RPC_GATEWAY))
    // Every error_page that covers a 502, at location or server level and in
    // any spelling, is one of the mapped hops.
    expect(count(approval, ERROR_PAGE)).toBe(1)
    expect(count(approval, ANY_502_ERROR_PAGE)).toBe(1)
    expect(count(rpc, ERROR_PAGE)).toBe(2)
    expect(count(rpc, ANY_502_ERROR_PAGE)).toBe(2)
    for (const gateway of [approval, rpc]) {
      expect(gateway).toContain(NAMED_LOCATION)
    }
  })

  it.each([WORKFLOW_APPROVAL_GATEWAY, RPC_GATEWAY])(
    'G1-10e: %s never intercepts control-api errors, so only nginx-generated 502s are mapped',
    gateway => {
      const config = directives(configMap(gateway))
      // Witnesses: the directives were read (comments stripped, proxying and
      // the mapping still present).
      expect(config).toContain('proxy_pass http://control_api_upstream;')
      expect(count(config, ERROR_PAGE)).toBeGreaterThan(0)
      expect(config).not.toMatch(INTERCEPT_ON)
    }
  )
})

// Any spelling nginx accepts, as for the 502.
const CONNECT_TIMEOUT_ERROR_PAGE = /error_page\s+504\s*=\s*@control_plane_connect_timeout\s*;/g
// Any error_page that covers a 504, whatever it points to.
const ANY_504_ERROR_PAGE = /error_page[^;]*\b504\b[^;]*;/g
const CONNECT_TIMEOUT_LOCATION = 'location @control_plane_connect_timeout {'
const CONNECT_FAILED = 'if ($upstream_connect_time = "-") {'

describe('gateway-generated connect-timeout 504 on user-facing control-plane hops (G1-12, #820)', () => {
  it.each([
    ['H2 authorize', WORKFLOW_APPROVAL_GATEWAY, AUTHORIZE],
    ['H3 Codex redeem', RPC_GATEWAY, CODEX_REDEEM],
    ['H3 Grok redeem', RPC_GATEWAY, GROK_REDEEM],
  ])('G1-12a: %s sends its own 504 to the connect-timeout check', (_hop, gateway, opening) => {
    const block = locationBlock(directives(configMap(gateway)), opening)
    // Witness: this is the block that proxies to control-api.
    expect(block).toContain('proxy_pass http://control_api_upstream;')
    expect(count(block, CONNECT_TIMEOUT_ERROR_PAGE)).toBe(1)
  })

  it.each([WORKFLOW_APPROVAL_GATEWAY, RPC_GATEWAY])(
    'G1-12b: %s answers control_plane_unavailable only when no connection was made, else its own 504',
    gateway => {
      const block = locationBlock(directives(configMap(gateway)), CONNECT_TIMEOUT_LOCATION)
      expect(block).toContain('default_type application/json;')
      const branchStart = block.indexOf(CONNECT_FAILED)
      expect(branchStart, 'the named location must test $upstream_connect_time').toBeGreaterThan(0)
      const branchEnd = block.indexOf('\n          }', branchStart)
      expect(branchEnd).toBeGreaterThan(branchStart)
      const connectFailed = block.slice(branchStart, branchEnd)
      expect(connectFailed).toContain(`return 503 '{"error":"control_plane_unavailable"}';`)
      expect(connectFailed).toContain('add_header Cache-Control "no-store, private" always;')
      expect(connectFailed).toContain('add_header Pragma "no-cache" always;')
      expect(connectFailed).toContain('add_header X-Content-Type-Options "nosniff" always;')
      // A read or send timeout (connection made) keeps nginx's own 504.
      expect(block.slice(branchEnd)).toMatch(/\n\s*return 504;/)
      expect(count(block, /\breturn\b/g)).toBe(2)
    }
  )

  it.each([
    ['Codex redeem', CODEX_REDEEM, 'codex-llm-proxy'],
    ['Grok redeem', GROK_REDEEM, 'grok-llm-proxy'],
  ])(
    'G1-12c: %s times out its connect before the proxy aborts the request',
    (_route, opening, proxy) => {
      const block = locationBlock(directives(configMap(RPC_GATEWAY)), opening)
      const abortMs = proxyRedeemAbortMs(proxy)
      // Witness: the proxy's own abort was read.
      expect(abortMs).toBeGreaterThan(0)
      // nginx's default (60 s) is longer, so the proxy gave up first and never
      // saw the gateway's answer.
      expect(connectTimeoutMs(block)).toBeLessThan(abortMs)
    }
  )

  it('G1-12c: authorize inherits the approval gateway connect timeout', () => {
    const approval = directives(configMap(WORKFLOW_APPROVAL_GATEWAY))
    expect(connectTimeoutMs(approval)).toBe(5000)
    const block = locationBlock(approval, AUTHORIZE)
    // Witness: the authorize block was read.
    expect(block).toContain('proxy_pass http://control_api_upstream;')
    expect(block).not.toMatch(/\bproxy_connect_timeout\b/)
  })

  it.each([
    ['Codex finalize', CODEX_FINALIZE],
    ['Grok finalize', GROK_FINALIZE],
  ])('G1-12d: %s keeps nginx default timeouts', (_route, opening) => {
    const block = locationBlock(directives(configMap(RPC_GATEWAY)), opening)
    // Witness: the finalize block exists and proxies to control-api.
    expect(block).toContain('proxy_pass http://control_api_upstream;')
    expect(block).not.toMatch(/\bproxy_connect_timeout\b/)
  })

  it('G1-12e: the 504 mapping stays on the three user-facing hops', () => {
    const approval = directives(configMap(WORKFLOW_APPROVAL_GATEWAY))
    const rpc = directives(configMap(RPC_GATEWAY))
    // Every error_page that covers a 504, at location or server level and in
    // any spelling, is one of the mapped hops.
    expect(count(approval, CONNECT_TIMEOUT_ERROR_PAGE)).toBe(1)
    expect(count(approval, ANY_504_ERROR_PAGE)).toBe(1)
    expect(count(rpc, CONNECT_TIMEOUT_ERROR_PAGE)).toBe(2)
    expect(count(rpc, ANY_504_ERROR_PAGE)).toBe(2)
    for (const gateway of [approval, rpc]) {
      expect(gateway).toContain(CONNECT_TIMEOUT_LOCATION)
    }
  })
})
