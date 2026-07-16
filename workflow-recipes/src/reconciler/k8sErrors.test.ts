import { describe, expect, it } from 'vitest'
import { getErrorCode, isRetryableInfraError } from './k8sErrors'

describe('getErrorCode', () => {
  it('reads top-level numeric code', () => {
    expect(getErrorCode({ code: 404 })).toBe(404)
  })

  it('falls back to response.statusCode', () => {
    expect(getErrorCode({ response: { statusCode: 409 } })).toBe(409)
  })

  it('reads alternate Kubernetes client HTTP status shapes', () => {
    expect(getErrorCode({ statusCode: 503 })).toBe(503)
    expect(getErrorCode({ status: 429 })).toBe(429)
    expect(getErrorCode({ body: { code: 500 } })).toBe(500)
    expect(getErrorCode({ body: { statusCode: 501 } })).toBe(501)
    expect(getErrorCode({ body: { status: 429 } })).toBe(429)
    expect(getErrorCode({ response: { status: 502 } })).toBe(502)
    expect(getErrorCode({ response: { body: { code: 504 } } })).toBe(504)
    expect(getErrorCode({ response: { body: { statusCode: 503 } } })).toBe(503)
    expect(getErrorCode({ response: { body: { status: 429 } } })).toBe(429)
  })
})

describe('isRetryableInfraError', () => {
  it('returns false for null/undefined', () => {
    expect(isRetryableInfraError(null)).toBe(false)
    expect(isRetryableInfraError(undefined)).toBe(false)
  })

  it('matches a node-fetch connect ETIMEDOUT (the incident shape)', () => {
    // FetchError carries the socket code on `.code` as a string.
    const err = Object.assign(
      new Error(
        'request to https://203.0.113.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 203.0.113.1:443'
      ),
      { code: 'ETIMEDOUT', name: 'FetchError' }
    )
    expect(isRetryableInfraError(err)).toBe(true)
  })

  it('matches ECONNREFUSED / ECONNRESET / EAI_AGAIN socket codes', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH']) {
      expect(isRetryableInfraError({ code })).toBe(true)
    }
  })

  it('matches a socket code nested under error.cause', () => {
    const err = new Error('fetch failed')
    ;(err as { cause?: unknown }).cause = { code: 'ECONNRESET' }
    expect(isRetryableInfraError(err)).toBe(true)
  })

  it('matches API-server 5xx and 429', () => {
    expect(isRetryableInfraError({ code: 503 })).toBe(true)
    expect(isRetryableInfraError({ response: { statusCode: 500 } })).toBe(true)
    expect(isRetryableInfraError({ statusCode: 503 })).toBe(true)
    expect(isRetryableInfraError({ body: { code: 500 } })).toBe(true)
    expect(isRetryableInfraError({ body: { statusCode: 502 } })).toBe(true)
    expect(isRetryableInfraError({ response: { body: { status: 503 } } })).toBe(true)
    expect(isRetryableInfraError({ code: 429 })).toBe(true)
  })

  it('matches a wrapped error message that lost its .code', () => {
    // WRC re-wraps pre-deploy failures: `new Error("Pre-deploy ... : connect ETIMEDOUT ...")`.
    const wrapped = new Error(
      'Pre-deploy Context allowlist failed for "recipe-helpdesk": request to https://203.0.113.1/... failed, reason: connect ETIMEDOUT 203.0.113.1:443'
    )
    expect(isRetryableInfraError(wrapped)).toBe(true)
  })

  it('matches a persisted status.message string (already-latched recipe)', () => {
    const persisted =
      'FetchError: request to https://203.0.113.1/apis/apps/v1/namespaces/sandbox-recipes/deployments/x failed, reason: connect ETIMEDOUT 203.0.113.1:443'
    expect(isRetryableInfraError(persisted)).toBe(true)
  })

  it('matches "socket hang up"', () => {
    expect(isRetryableInfraError(new Error('socket hang up'))).toBe(true)
  })

  it('does NOT match terminal, recipe-specific failures', () => {
    expect(
      isRetryableInfraError(new Error('All workloads excluded by includeWhen conditions'))
    ).toBe(false)
    expect(isRetryableInfraError('Policy violation: [p] r: m')).toBe(false)
    expect(isRetryableInfraError({ code: 404 })).toBe(false)
    expect(isRetryableInfraError({ code: 422 })).toBe(false)
    expect(isRetryableInfraError(new Error('ImagePullBackOff'))).toBe(false)
    expect(isRetryableInfraError({ code: 'ENOENT' })).toBe(false)
  })

  // ── Hardening: a bare socket-code token inside operator-controlled free text
  //    must NOT be classified retryable. Only the anchored transport shapes
  //    (`<syscall> CODE`, `reason: …`, or an explicit `.code`) count.
  it('does NOT match a bare token embedded in operator-controlled text', () => {
    expect(
      isRetryableInfraError('Failed to pull image "docker.io/acme/ETIMEDOUT-tool:latest"')
    ).toBe(false)
    expect(isRetryableInfraError('workload env FOO=ECONNRESET rejected by policy')).toBe(false)
    expect(isRetryableInfraError('Invalid spec: step "ETIMEDOUT" not found')).toBe(false)
    expect(isRetryableInfraError('Workflow failed')).toBe(false)
    // A policy message that smuggled a token into an image name no longer even
    // reaches the transient classifier as retryable (defense in depth).
    expect(
      isRetryableInfraError(
        'Policy violation: [p] imageDenylist: Workload "app" image "docker.io/evil:ETIMEDOUT" matches denylist pattern "**evil**"'
      )
    ).toBe(false)
  })

  it('DOES match the anchored transport shapes (syscall-prefixed / reason:)', () => {
    expect(isRetryableInfraError('connect ETIMEDOUT 203.0.113.1:443')).toBe(true)
    expect(isRetryableInfraError('read ECONNRESET')).toBe(true)
    expect(isRetryableInfraError('getaddrinfo EAI_AGAIN registry.example.com')).toBe(true)
    expect(
      isRetryableInfraError('request to https://10.96.0.1/api failed, reason: connect ECONNREFUSED')
    ).toBe(true)
  })

  // ── P2 hardening: multi-word transport phrases must be anchored to a
  //    transport-error lead, NOT matched as bare substrings. Operator-controlled
  //    free text (a step id, an env value, notes) that merely contains the words
  //    must NOT trigger a false transient self-heal.
  it('does NOT match transport phrases embedded in operator-controlled text', () => {
    // The exact shapes the reviewer proved were false positives before anchoring.
    expect(isRetryableInfraError('Invalid spec: step "socket hang up" not found')).toBe(false)
    expect(isRetryableInfraError('workload env FOO=network timeout rejected by policy')).toBe(false)
    // Quoted/notes embeddings of the phrase (no transport lead adjacent).
    expect(
      isRetryableInfraError('Policy violation: workload "x" notes "socket hang up" again')
    ).toBe(false)
    expect(isRetryableInfraError('workflow env NOTES="network timeout observed" set')).toBe(false)
    // A hyphenated image name is not the space-separated phrase; stays terminal.
    expect(isRetryableInfraError('ImagePullBackOff for acme/network-timeout:latest')).toBe(false)
  })

  it('DOES match transport phrases when anchored to a transport lead', () => {
    // node-fetch wraps the underlying socket error as `… failed, reason: <phrase>`.
    expect(
      isRetryableInfraError('request to https://10.96.0.1/api/v1 failed, reason: socket hang up')
    ).toBe(true)
    // A bare undici error whose message IS the phrase (whole-message lead `^`).
    expect(isRetryableInfraError(new Error('network timeout'))).toBe(true)
    expect(isRetryableInfraError(new Error('socket hang up'))).toBe(true)
    // Error-class prefix form (e.g. `console.error(err)` → `Error: …`).
    expect(isRetryableInfraError('Error: socket hang up')).toBe(true)
    expect(isRetryableInfraError('FetchError: request failed, reason: network timeout')).toBe(true)
  })
})
