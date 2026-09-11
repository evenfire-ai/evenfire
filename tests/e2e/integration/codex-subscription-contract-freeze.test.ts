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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  'maxMessages',
  'maxTools',
  'maxOutputTokens',
  'maxStreamDurationMs',
  'maxDeadlineMs',
  'maxConcurrentStreams',
  'maxQueuedRequests',
  'maxRetriesPerAttempt',
] as const

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

    const errors = contract.errorTaxonomy
    expect(Array.isArray(errors) && (errors as unknown[]).length > 0).toBe(true)
    for (const code of errors as unknown[]) {
      expect(typeof code).toBe('string')
      expect(String(code)).toMatch(/^[a-z][a-z0-9_]+$/)
    }

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
