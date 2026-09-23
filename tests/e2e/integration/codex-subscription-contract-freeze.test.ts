/**
 * Phase 0 freeze gate for the Codex subscription transport contract.
 *
 * This suite must fail because a required finite field is missing, never
 * because the network, a login, or an upstream credential is unavailable.
 * The fixture and architecture document are the source of truth; Task 25
 * confirms them against an approved account.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIMITS } from '@clerum/llm-provider-attempt-contract'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../..')
const fixturePath = join(
  repoRoot,
  'tests/e2e/fixtures/codex-subscription/sanitized-upstream-contract.json'
)
const architectureDocPath = join(
  repoRoot,
  'docs/architecture/codex-subscription-transport-contract.md'
)
const validationDocPath = join(repoRoot, 'docs/testing/codex-subscription-validation.md')

it('admits visual authorization envelopes only on the exact gateway route', () => {
  const yaml = readFileSync(join(repoRoot, 'deploy/base/control-plane/configmaps.yaml'), 'utf8')
  const gateway = yaml
    .split('\n---')
    .find(document => document.includes('name: nginx-workflow-approval-gateway'))!
  expect(gateway).toBeTruthy()
  const route = gateway.match(
    /location = \/api\/v1\/mcp-host\/llm\/provider-attempts\/authorize \{([\s\S]*?)\n        \}/
  )?.[1]
  expect(route).toContain('client_max_body_size 25165824;')
  expect(route).toMatch(/limit_except POST\s*\{\s*deny all;/)
  expect(route).toContain('proxy_set_header Authorization $http_authorization;')
  expect(route).toContain('proxy_pass http://control_api_upstream;')
  expect(gateway.match(/client_max_body_size/g)).toHaveLength(1)
})

const REQUIRED_OPERATIONS = [
  'oauth_browser',
  'oauth_device',
  'oauth_refresh',
  'oauth_revoke',
  'oauth_reconnect',
  'catalog_list',
  'completion_stream',
  'completion_cancel',
  'connection_test',
] as const

const REQUIRED_LIMIT_KEYS = [
  'maxRequestBodyBytes',
  'maxVisualRequestBodyBytes',
  'maxMessages',
  'maxToolCalls',
  'maxOutputTokens',
  'maxStreamDurationMs',
  'maxDeadlineMs',
  'maxConcurrentStreams',
  'maxQueuedRequests',
  'maxQueueWaitMs',
  'upstreamIdleTimeoutMs',
  'maxRetriesPerAttempt',
  'executionTicketTtlMs',
] as const

// Runtime `LIMITS` keys that the fixture also publishes. Each must carry the
// same value on both sides.
const PUBLISHED_RUNTIME_LIMIT_KEYS = [
  'executionTicketTtlMs',
  'maxDeadlineMs',
  'maxMessages',
  'maxOutputTokens',
  'maxRequestBodyBytes',
  'maxToolCalls',
  'maxVisualRequestBodyBytes',
] as const

// Runtime bounds the published contract deliberately does not describe. Every
// key of the runtime `LIMITS` must be in exactly one of these two lists, so
// adding a key to `LIMITS` fails this suite until someone decides which.
// Publishing it takes four edits: the fixture's `limits`, REQUIRED_LIMIT_KEYS,
// PUBLISHED_RUNTIME_LIMIT_KEYS and the architecture doc table. Keeping it
// runtime-only takes one: add it here.
const RUNTIME_ONLY_LIMIT_KEYS = ['maxIdLength', 'maxNestingDepth'] as const

const SENSITIVE_VALUE_PATTERN =
  /^(?:sk-[A-Za-z0-9]+|Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?!https?:\/\/)[^;\s]+=[^;\s]+(?:;|$))/

type FiniteLimit = number

function isHttpsOrigin(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?$/.test(value)
  )
}

function assertFinitePositiveLimit(value: unknown, key: string): asserts value is FiniteLimit {
  expect(value, `${key} must be a finite positive integer`).toEqual(expect.any(Number))
  const n = value as number
  expect(Number.isInteger(n), `${key} must be an integer`).toBe(true)
  expect(Number.isFinite(n), `${key} must be finite`).toBe(true)
  expect(n, `${key} must be > 0 (missing/0/negative/unlimited are invalid)`).toBeGreaterThan(0)
}

/**
 * Rows of the architecture doc's `| Limit | Value |` table, in document order.
 * The table ends at the first line that is not a table row.
 */
function parseLimitsTable(doc: string): Array<[string, string]> {
  const lines = doc.split('\n')
  const header = lines.findIndex(line => /^\|\s*Limit\s*\|\s*Value\s*\|$/.test(line))
  expect(
    header,
    'architecture doc must contain a "| Limit | Value |" table'
  ).toBeGreaterThanOrEqual(0)
  expect(lines[header + 1], 'limits table header must be followed by a separator row').toMatch(
    /^\|\s*-+\s*\|\s*-+\s*\|$/
  )
  const rows: Array<[string, string]> = []
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break
    const cells = /^\|\s*([A-Za-z0-9]+)\s*\|\s*(\S+)\s*\|$/.exec(line)
    expect(cells, `malformed limits table row: ${line}`).not.toBeNull()
    rows.push([cells![1], cells![2]])
  }
  return rows
}

function collectSensitiveLeaves(value: unknown, path: string, hits: string[]): void {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE_PATTERN.test(value)) hits.push(path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => collectSensitiveLeaves(entry, `${path}[${i}]`, hits))
    return
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectSensitiveLeaves(child, path ? `${path}.${key}` : key, hits)
    }
  }
}

describe('codex-subscription contract freeze', () => {
  it('freezes V2 local budgets without asserting upstream image support', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
    const localContract = createRequire(import.meta.url)(
      join(repoRoot, 'packages/llm-provider-attempt-contract/index.cjs')
    )
    expect(fixture.protocolVersion).toBe('codex-subscription-transport.v1')
    expect(fixture.requestSchemas).toEqual([
      localContract.SCHEMA_VERSION,
      localContract.SCHEMA_VERSION_V2,
    ])
    expect(fixture.visualInput.limits).toEqual(localContract.VISUAL_LIMITS)
    expect(fixture.visualInput.enabledByDefault).toBe(true)
    expect(fixture.visualInput.upstreamVerified).toBe(false)
    expect(fixture.visualInput.activation).toBe('default')
    const architecture = readFileSync(architectureDocPath, 'utf8')
    expect(architecture).toContain('codex-completion-request.v2')
    expect(architecture).not.toContain('CODEX_IMAGE_INPUT_MODELS')
    const proxyDeploy = readFileSync(
      join(repoRoot, 'deploy/base/control-plane/codex-llm-proxy.yaml'),
      'utf8'
    )
    // #731: the ordinary body limit is left unset in the manifest so the proxy
    // derives it from the contract cap plus its envelope allowance.
    expect(proxyDeploy).not.toMatch(/^\s*CODEX_LLM_PROXY_MAX_BODY_BYTES:/m)
    const proxyLimits = readFileSync(join(repoRoot, 'codex-llm-proxy/src/requestLimits.ts'), 'utf8')
    expect(proxyLimits).toMatch(
      /DEFAULT_MAX_BODY_BYTES = CONTRACT_LIMITS\.maxRequestBodyBytes \+ ENVELOPE_ALLOWANCE_BYTES/
    )
    expect(proxyDeploy).toContain(
      `CODEX_LLM_PROXY_MAX_VISUAL_BODY_BYTES: "${localContract.LIMITS.maxVisualRequestBodyBytes}"`
    )
    expect(proxyDeploy).not.toMatch(/CODEX_IMAGE_INPUT_MODELS/)
    const hostConfig = readFileSync(join(repoRoot, 'mcp-host/src/config.ts'), 'utf8')
    const proxyConfig = readFileSync(join(repoRoot, 'codex-llm-proxy/src/config.ts'), 'utf8')
    expect(hostConfig).not.toMatch(/CODEX_IMAGE_INPUT_MODELS/)
    expect(proxyConfig).not.toMatch(/CODEX_IMAGE_INPUT_MODELS/)
    expect(architecture).toContain('on by default for every `codex-subscription` model')
  })

  it('requires the sanitized fixture and both freeze documents', () => {
    expect(existsSync(fixturePath), `missing fixture: ${fixturePath}`).toBe(true)
    expect(
      existsSync(architectureDocPath),
      `missing architecture doc: ${architectureDocPath}`
    ).toBe(true)
    expect(existsSync(validationDocPath), `missing validation doc: ${validationDocPath}`).toBe(true)
  })

  it('declares a finite protocol, operations, origins, redirects, scopes, limits, errors, and terms', () => {
    const raw = readFileSync(fixturePath, 'utf8')
    const contract = JSON.parse(raw) as Record<string, unknown>
    const architectureDoc = readFileSync(architectureDocPath, 'utf8')
    const validationDoc = readFileSync(validationDocPath, 'utf8')

    expect(contract.protocolVersion, 'protocolVersion must be a frozen string').toEqual(
      expect.any(String)
    )
    expect(String(contract.protocolVersion).length).toBeGreaterThan(0)

    const operations = contract.supportedOperations
    expect(Array.isArray(operations), 'supportedOperations must be an array').toBe(true)
    for (const op of REQUIRED_OPERATIONS) {
      expect(operations as unknown[], `missing operation ${op}`).toContain(op)
    }

    const origins = contract.origins as Record<string, unknown> | undefined
    expect(origins && typeof origins === 'object', 'origins object is required').toBe(true)
    for (const key of [
      'oauthAuthorize',
      'oauthToken',
      'oauthDevice',
      'oauthRevoke',
      'catalog',
      'completions',
    ] as const) {
      expect(isHttpsOrigin(origins?.[key]), `origins.${key} must be an exact https origin`).toBe(
        true
      )
      expect(String(origins?.[key])).not.toMatch(/^https:\/\/api\.openai\.com\/v1\/(?!responses\b)/)
    }
    expect(Array.isArray(contract.forbiddenOrigins), 'forbiddenOrigins must be listed').toBe(true)
    expect(contract.forbiddenOrigins as unknown[]).toEqual(
      expect.arrayContaining(['https://api.openai.com/v1/chat/completions'])
    )

    const redirects = contract.redirectPolicy as Record<string, unknown> | undefined
    expect(redirects && typeof redirects === 'object').toBe(true)
    expect(redirects?.allowHttp).toBe(false)
    expect(redirects?.allowCrossOrigin).toBe(false)
    expect(redirects?.allowPrivateAddresses).toBe(false)
    expect(Array.isArray(redirects?.sameOriginOnly)).toBe(true)

    const scopes = contract.oauthScopes
    expect(Array.isArray(scopes) && (scopes as unknown[]).length > 0, 'oauthScopes required').toBe(
      true
    )
    for (const scope of scopes as unknown[]) {
      expect(typeof scope).toBe('string')
      expect(String(scope).length).toBeGreaterThan(0)
    }

    const limits = contract.limits as Record<string, unknown> | undefined
    expect(limits && typeof limits === 'object', 'limits object is required').toBe(true)
    for (const key of REQUIRED_LIMIT_KEYS) {
      assertFinitePositiveLimit(limits?.[key], `limits.${key}`)
    }

    expect(limits).not.toHaveProperty('maxTools')
    // An unknown key is a typo or an unreviewed addition, not an extension.
    expect(Object.keys(limits ?? {}).sort()).toEqual([...REQUIRED_LIMIT_KEYS].sort())

    // The runtime package enforces these bounds, so the frozen description
    // must agree with it, not only with itself. Without this, a bound changed
    // in LIMITS and left behind here passes every gate (#738).
    const runtimeLimits: Record<string, number> = { ...LIMITS }
    const published = Object.keys(runtimeLimits).filter(key => key in (limits ?? {}))
    expect(
      [...published].sort(),
      'the LIMITS keys the fixture publishes changed; update PUBLISHED_RUNTIME_LIMIT_KEYS, REQUIRED_LIMIT_KEYS and the architecture doc table together'
    ).toEqual([...PUBLISHED_RUNTIME_LIMIT_KEYS])
    for (const key of RUNTIME_ONLY_LIMIT_KEYS) {
      expect(
        runtimeLimits,
        `${key} is listed as runtime-only but LIMITS no longer has it; remove it from RUNTIME_ONLY_LIMIT_KEYS`
      ).toHaveProperty(key)
      expect(
        limits,
        `${key} is published in the fixture; remove it from RUNTIME_ONLY_LIMIT_KEYS`
      ).not.toHaveProperty(key)
    }
    expect(
      Object.keys(runtimeLimits).sort(),
      'every LIMITS key must be published in the fixture or listed in RUNTIME_ONLY_LIMIT_KEYS'
    ).toEqual([...published, ...RUNTIME_ONLY_LIMIT_KEYS].sort())
    for (const key of published) {
      expect({ [key]: limits?.[key] }).toEqual({ [key]: runtimeLimits[key] })
    }

    expect(limits?.maxToolCalls).toBe(256)
    expect(limits?.maxMessages).toBe(1024)
    expect(limits?.maxRequestBodyBytes).toBe(8388608)
    expect(limits?.maxVisualRequestBodyBytes).toBe(25165824)
    // control-api derives the execution ticket TTL from LIMITS (#739).
    expect(limits?.executionTicketTtlMs).toBe(60000)

    // The architecture doc publishes the same limits as a table; a row that
    // drifts from the fixture misdescribes what the runtime enforces. The table
    // is parsed as a whole so a duplicated, extra or missing row also fails.
    const docLimits = parseLimitsTable(architectureDoc)
    const docKeys = docLimits.map(([key]) => key)
    expect(
      [...docKeys].sort(),
      'architecture doc limits table must list each fixture limit exactly once'
    ).toEqual([...REQUIRED_LIMIT_KEYS].sort())
    for (const [key, value] of docLimits) {
      expect(
        { [key]: value },
        `architecture doc limits table must list ${key} = ${String(limits?.[key])}`
      ).toEqual({ [key]: String(limits?.[key]) })
    }

    const errors = contract.errorTaxonomy
    expect(Array.isArray(errors) && (errors as unknown[]).length > 0).toBe(true)
    for (const code of errors as unknown[]) {
      expect(typeof code).toBe('string')
      expect(String(code)).toMatch(/^[a-z][a-z0-9_]+$/)
    }
    expect(errors).toContain('tool_call_limit_exceeded')
    expect(errors).toContain('context_length_exceeded')
    expect(errors).toContain('invalid_tool_arguments')
    expect(errors).toContain('stream_duration_exceeded')
    expect(errors).toContain('sse_buffer_exceeded')
    expect(new Set(errors as unknown[]).size, 'errorTaxonomy must not repeat a code').toBe(
      (errors as unknown[]).length
    )

    const terms = contract.termsAndTestAccount as Record<string, unknown> | undefined
    expect(terms && typeof terms === 'object').toBe(true)
    expect(terms?.automationAuthorized).toBe(true)
    expect(typeof terms?.approvedTestAccountFingerprint).toBe('string')
    expect(String(terms?.approvedTestAccountFingerprint)).toMatch(/^redacted:/)
    expect(typeof terms?.evidenceHash).toBe('string')
    expect(String(terms?.evidenceHash)).toMatch(/^sha256:/)

    const sensitive: string[] = []
    collectSensitiveLeaves(contract, '', sensitive)
    expect(sensitive, `fixture must not store secrets; found ${sensitive.join(', ')}`).toEqual([])

    expect(architectureDoc).toContain(String(contract.protocolVersion))
    expect(architectureDoc).toMatch(/codex-subscription/)
    expect(architectureDoc).not.toMatch(/sk-[A-Za-z0-9]|Bearer [A-Za-z0-9._-]+/)
    expect(validationDoc).toMatch(/T0|T1|T2/)
    expect(validationDoc).toMatch(/CODEX_REAL_UPSTREAM_CONFIRM/)
  })
})
