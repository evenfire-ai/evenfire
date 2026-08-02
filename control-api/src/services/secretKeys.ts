// Kubernetes Secret data-key validation, centralized so every write path shares
// ONE definition of "valid key". A Secret data key must satisfy the apiserver's
// IsConfigMapKey check: it matches [-._a-zA-Z0-9]+, is neither "." nor "..", and
// is at most 253 characters. A key that fails any of these is rejected by the
// apiserver with an opaque 500; validating here turns that into an actionable
// 400 at the single chokepoint (SecretService) every Secret write passes
// through, so no route — present or future — can leak an invalid key to k8s.

export const SECRET_DATA_KEY_RE = /^[-._a-zA-Z0-9]+$/
export const SECRET_DATA_KEY_MAX_LENGTH = 253

// The one message used by both the route-level reason string and the thrown
// error, so an operator sees identical wording no matter which layer rejects.
function secretKeyErrorMessage(key: string): string {
  return `data key "${key}" is not a valid Secret key (only [-._a-zA-Z0-9], not "." or "..", max ${SECRET_DATA_KEY_MAX_LENGTH} chars)`
}

// Thrown when a Secret data key cannot be a valid Kubernetes key. Carries
// `status = 400` so control-api's global error handler (app.ts) forwards it to
// the client as a 400 instead of collapsing it into a 500 — the same mechanism
// HostEnvServiceError relies on.
export class InvalidSecretKeyError extends Error {
  readonly status = 400
  readonly key: string
  constructor(key: string) {
    super(secretKeyErrorMessage(key))
    this.name = 'InvalidSecretKeyError'
    this.key = key
  }
}

// Returns a human-readable reason when `key` is not a valid Secret data key, or
// null when it is valid. Route boundaries that already validate call this to
// emit an early 400 with a plain `{ error }` body before touching the service
// layer; the service layer enforces the same rule as a hard invariant.
export function invalidSecretDataKeyReason(key: string): string | null {
  if (
    !SECRET_DATA_KEY_RE.test(key) ||
    key === '.' ||
    key === '..' ||
    key.length > SECRET_DATA_KEY_MAX_LENGTH
  ) {
    return secretKeyErrorMessage(key)
  }
  return null
}

// Throws InvalidSecretKeyError on an invalid key. Called inside SecretService so
// no single-key write (removeSecretKey) can carry a key the apiserver rejects.
export function assertValidSecretDataKey(key: string): void {
  if (invalidSecretDataKeyReason(key) !== null) {
    throw new InvalidSecretKeyError(key)
  }
}

// Validates every key in a Secret write payload (both `data` and `stringData`),
// throwing InvalidSecretKeyError on the first invalid key. This is the invariant
// enforced inside SecretService's create/update/merge ops: any Secret write,
// from any route present or future, is guaranteed to carry only valid keys.
export function assertValidSecretWriteKeys(req: {
  data?: Record<string, unknown>
  stringData?: Record<string, unknown>
}): void {
  if (req.data) {
    for (const key of Object.keys(req.data)) assertValidSecretDataKey(key)
  }
  if (req.stringData) {
    for (const key of Object.keys(req.stringData)) assertValidSecretDataKey(key)
  }
}
