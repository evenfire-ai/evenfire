/**
 * Shared body shape for the unified "Deferred Credentials" contract.
 *
 * When an OAuth client's clientIdRef / clientSecretRef points at a Secret
 * (or key) that doesn't exist at use-site, the route returns 503 with this
 * body. This matches the shape Phase 2 introduced for dormant webhooks so
 * embed-side error parsing can be one switch on `error` regardless of
 * surface.
 *
 *   { error: "integration_not_configured", integration, hint }
 *
 *   integration  — the recipe-author-chosen id of the integration (the
 *                  oauthClientId, or the webhookId for §webhooks).
 *   hint         — actionable operator instruction. For OAuth this is
 *                  always shaped "create Secret <name>…" — the operator
 *                  may need to add either the Secret or just a missing key
 *                  on an existing Secret.
 *
 * 503 (not 500) signals "configure me, then retry" — the recipe is healthy,
 * this integration is dormant pending operator action. Browsers, fetch
 * libraries, and most reverse proxies surface 5xx differently from 503 —
 * a Retry-After header would be honored if we ever wanted polling clients
 * to back off, but for an embed that fires on user click, the 503 status
 * itself is enough information for the recipe author's UI code.
 */

export interface IntegrationNotConfiguredBody {
  error: 'integration_not_configured'
  integration: string
  hint: string
}

/**
 * Build the body. `secret` follows the OAuth helper convention:
 *   - "<name>"       → the Secret object itself is absent in the namespace.
 *   - "<name>/<key>" → the Secret exists but the named key is empty/missing.
 */
export function integrationNotConfigured(
  integration: string,
  secret: string
): IntegrationNotConfiguredBody {
  const slash = secret.indexOf('/')
  const hint =
    slash > 0
      ? `create key ${secret.slice(slash + 1)} on Secret ${secret.slice(0, slash)} to activate this integration`
      : `create Secret ${secret} to activate this integration`
  return { error: 'integration_not_configured', integration, hint }
}

/**
 * Recognize "Secret 404" across the three shapes that reach OAuth helpers:
 *   - K8sNotFoundError (the resourceService wrapper, only for CRD reads).
 *   - Raw @kubernetes/client-node errors (statusCode === 404).
 *   - Test mocks that mirror the raw shape (code === 404).
 *
 * The OAuth secretReader wrappers exist to translate any of these into
 * SecretNotFoundError so the helpers can return `kind: 'secret_missing'`.
 * Without this, a missing Secret in the namespace falls through as an
 * unhandled error → 500, even though we have the 503 deferred-credentials
 * contract in place.
 */
export function isSecretNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  if ((err as { name?: string }).name === 'K8sNotFoundError') return true
  const statusCode = (err as { statusCode?: unknown }).statusCode
  const code = (err as { code?: unknown }).code
  return statusCode === 404 || code === 404
}
