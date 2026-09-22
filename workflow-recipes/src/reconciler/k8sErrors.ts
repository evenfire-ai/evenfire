/** Shared K8s client error helpers. */

/** Extract HTTP status code from a K8s client error. */
export function getErrorCode(error: unknown): number | undefined {
  const e = error as {
    code?: unknown
    statusCode?: unknown
    status?: unknown
    body?: { code?: unknown; statusCode?: unknown; status?: unknown }
    response?: {
      statusCode?: unknown
      status?: unknown
      body?: { code?: unknown; statusCode?: unknown; status?: unknown }
    }
  }
  const candidates = [
    e.code,
    e.statusCode,
    e.status,
    e.response?.statusCode,
    e.response?.status,
    e.body?.code,
    e.body?.statusCode,
    e.body?.status,
    e.response?.body?.code,
    e.response?.body?.statusCode,
    e.response?.body?.status,
  ]
  return candidates.find((code): code is number => typeof code === 'number')
}

/**
 * Node/undici socket-level error codes that signal a transient, retryable
 * connectivity problem between the controller and the API server (or any
 * upstream we fetch during reconcile) — NOT a problem with the recipe itself.
 */
const RETRYABLE_SOCKET_CODES = new Set([
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/**
 * Fully-qualified transport-failure phrases that appear in real Node/undici/
 * node-fetch transport errors. They are NOT matched as bare substrings — see
 * TRANSPORT_PREFIXED_PHRASE_RE — because operator-controlled recipe text (a
 * workload image name, an env value, a step id) can embed these words by
 * accident. They only count as transient when anchored to a transport-error
 * lead: message start, `reason:`, or an error-class prefix.
 */
const RETRYABLE_TRANSPORT_PHRASES = [
  'socket hang up',
  'network timeout',
  'Client network socket disconnected',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]
// NOTE: UND_ERR_CONNECT_TIMEOUT / UND_ERR_SOCKET intentionally ALSO appear in
// RETRYABLE_SOCKET_CODES above — undici surfaces them BOTH as a `.code` property
// (caught by collectSocketCodes) and as bare message text (caught here, anchored
// by TRANSPORT_PREFIXED_PHRASE_RE). Keep both entries: removing either would drop
// a real transport-error shape and silently narrow the self-heal classifier.

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Anchored counterpart to TRANSPORT_PREFIXED_CODE_RE for the multi-word
 * transport phrases above. A phrase only matches when a transport-error lead
 * immediately precedes it:
 *   - `^`                  — the phrase is the whole/leading message
 *                           (undici throws `new Error('socket hang up')`)
 *   - `reason:\s*`         — node-fetch `… failed, reason: socket hang up`
 *   - `<ErrorClass>:\s*`   — `Error: …`, `FetchError: …`, `SocketError: …`
 * This rejects operator-controlled embeddings like `step "socket hang up" not
 * found` or `FOO=network timeout rejected by policy` while still recognizing
 * every genuine transport error. The `\b` before the error-class alternation
 * prevents a mid-word match (e.g. `specError:`).
 */
const TRANSPORT_PREFIXED_PHRASE_RE = new RegExp(
  String.raw`(?:^|reason:\s*|\b(?:FetchError|SocketError|SystemError|Error):\s*)(` +
    RETRYABLE_TRANSPORT_PHRASES.map(escapeRegExp).join('|') +
    ')'
)

/**
 * Node renders socket errors as `<syscall> <CODE> <addr>` (e.g.
 * `connect ETIMEDOUT 203.0.113.10:443`, `read ECONNRESET`,
 * `getaddrinfo EAI_AGAIN host`) and node-fetch wraps them as
 * `request to <url> failed, reason: connect ETIMEDOUT …`.
 *
 * We anchor the short socket codes to that transport context (a syscall verb or
 * a `reason:` prefix) instead of matching them as bare substrings. This is the
 * hardening for persisted-message classification: a recipe `status.message`
 * (or `workflowExecution.message`) can embed operator-controlled fields, and a
 * raw `.includes('ETIMEDOUT')` would let attacker/operator free text trigger a
 * false transient self-heal. Requiring `connect ETIMEDOUT` / `reason: …` shape
 * makes an accidental match effectively impossible while still recognizing every
 * real Node/undici/node-fetch transport error.
 */
const TRANSPORT_PREFIXED_CODE_RE =
  /(?:\b(?:connect|read|write|send|recv|getaddrinfo|getnameinfo|listen|bind|accept)\b\s+|reason:\s*(?:[a-z]+\s+)?)([A-Z][A-Z0-9_]+)/g

function messageIndicatesTransientTransport(message: string): boolean {
  if (!message) return false
  if (TRANSPORT_PREFIXED_PHRASE_RE.test(message)) return true
  TRANSPORT_PREFIXED_CODE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TRANSPORT_PREFIXED_CODE_RE.exec(message)) !== null) {
    if (RETRYABLE_SOCKET_CODES.has(match[1])) return true
  }
  return false
}

/** Walk `error.cause` (and `.code`/`.errno`) chains, collecting string codes. */
function collectSocketCodes(error: unknown): string[] {
  const codes: string[] = []
  let cursor: unknown = error
  for (let depth = 0; cursor && typeof cursor === 'object' && depth < 6; depth++) {
    const e = cursor as { code?: unknown; errno?: unknown; cause?: unknown }
    if (typeof e.code === 'string') codes.push(e.code)
    if (typeof e.errno === 'string') codes.push(e.errno)
    cursor = e.cause
  }
  return codes
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return cause ? `${error.message} ${messageOf(cause)}` : error.message
  }
  return String(error ?? '')
}

/**
 * True when `error` is a transient, retryable infrastructure failure — an
 * API-server connectivity blip or upstream 5xx/429 — rather than a terminal,
 * recipe-specific error (invalid spec, image pull, policy violation).
 *
 * The WRC reconciler uses this to avoid latching an otherwise-healthy recipe
 * into the terminal `failed` phase when a momentary connect ETIMEDOUT throws
 * mid-reconcile. Accepts either an Error/FetchError object or a previously
 * persisted `status.message` string (so already-latched recipes can be
 * recognized as transiently-failed and re-reconciled).
 */
export function isRetryableInfraError(error: unknown): boolean {
  if (error == null) return false

  // API-server HTTP status: 429 (throttling) and 5xx (server-side) are retryable.
  const status = getErrorCode(error)
  if (typeof status === 'number' && (status === 429 || (status >= 500 && status <= 599))) {
    return true
  }

  // Socket-level system codes, including ones nested under `.cause`.
  if (collectSocketCodes(error).some(code => RETRYABLE_SOCKET_CODES.has(code))) {
    return true
  }

  // Fallback for wrapped errors and persisted message strings — anchored to
  // known transport-error shapes (see TRANSPORT_PREFIXED_CODE_RE) rather than
  // raw substring inclusion, so operator-controlled text can't self-heal.
  return messageIndicatesTransientTransport(messageOf(error))
}

/**
 * Thrown by a reconcile step that failed for a transient reason (e.g. a DNS
 * SERVFAIL/timeout while resolving egress FQDNs) rather than a permanent
 * misconfiguration. The top-level reconcile catch maps this to the non-terminal
 * `degraded` phase so the periodic reconcile retries and the recipe self-heals
 * once the underlying dependency recovers — instead of bricking it at the
 * terminal `failed` phase, which is never retried.
 */
export class RetryableReconcileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'RetryableReconcileError'
    // Preserve the underlying error so logs (and any `.cause`-walking
    // classifier such as isRetryableInfraError's collectSocketCodes) can still
    // see the original transport/HTTP signal even though we re-message it for
    // the recipe status. Re-wrapping with `: ${String(error)}` alone would
    // flatten the chain and discard `.code`/`.cause`.
    if (options && 'cause' in options) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

/**
 * A read-first apply read 404, its POST got a 409, and the re-read of the
 * object that won the race is a 404 again. There is nothing to replace and no
 * live object to judge, so the pass stops and asks for a fresh reconciliation
 * instead of guessing with a second POST or a PUT that can only 404.
 */
export class ResourceVanishedAfterConflictError extends RetryableReconcileError {
  constructor(label: string, options?: { cause?: unknown }) {
    super(`${label} disappeared after create conflict; a fresh reconciliation is required`, options)
  }
}
