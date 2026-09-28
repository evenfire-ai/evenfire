import { isTransportError, upstreamReason, upstreamStatusOrRethrow } from './secretRead.js'

/**
 * Response for a Kubernetes call that a registry install or upgrade step could
 * not complete.
 *
 * Why not forward the apiserver's answer: its status becomes the client's
 * status (a 401 on control-api's own ServiceAccount logs the operator out of
 * the Control UI, a 403 reads as the operator's own permission failing), and
 * its text names `system:serviceaccount:<ns>:control-api`. A raw ApiException
 * message also embeds every response header. The message here is built from
 * the step (verb, kind, name, namespace, registry entry@version), the numeric
 * upstream status and the filtered field paths of a 422 only. The name and
 * entry can be request input; the response goes back to the same caller as
 * JSON. The apiserver's own text goes to the server log, never the response.
 */

export type RegistryUpstreamKind =
  | 'Secret'
  | 'McpServer'
  | 'LlmHook'
  | 'WorkflowRecipe'
  | 'Context'
  | 'Host'

/**
 * Where the object's content came from. `operator`: values the request
 * supplied (credentials), so a 422/413 is the caller's to fix. `registry`: a
 * spec control-api built from a catalog entry, so a 422 is a catalog/cluster
 * mismatch the caller cannot fix.
 */
export type RegistryUpstreamContent =
  | { source: 'operator' }
  | { source: 'registry'; entry: string; version: string }

export type RegistryUpstreamStep = {
  verb: 'create' | 'update' | 'read'
  kind: RegistryUpstreamKind
  name: string
  namespace: string
  content?: RegistryUpstreamContent
}

export type RegistryUpstreamFailure = {
  status: 404 | 409 | 413 | 422 | 502 | 503
  body: {
    error: 'registry_upstream_failed' | 'registry_upstream_rejected'
    message: string
    resourceType: string
    resourceName: string
    namespace: string
  }
  /** Log-only. */
  upstreamStatus: number | null
  /** Log-only: the metav1.Status message or errno code, never response headers. */
  upstreamReason: string | null
  /** Filtered `details.causes[].field` of a 422; also part of the message. */
  invalidFields: string[]
  severity: 'warn' | 'error'
}

// Same values the registry's `*_outcome_ambiguous` bodies already use.
const RESOURCE_TYPES: Record<RegistryUpstreamKind, string> = {
  Secret: 'secret',
  McpServer: 'mcp-server',
  LlmHook: 'llm-hook',
  WorkflowRecipe: 'recipe',
  Context: 'context',
  Host: 'host',
}

const FIELD_PATH = /^[A-Za-z0-9_.[\]-]{1,128}$/
const MAX_INVALID_FIELDS = 5

// The field paths a 422 Status lists in `details.causes[].field`. Only paths
// matching FIELD_PATH are kept: a path such as `data[KEY]` can carry a
// request-supplied key, and `causes[].message` is apiserver prose, which is
// never read.
function invalidFieldsOf(err: unknown): string[] {
  const raw = (err as { body?: unknown }).body
  let body: unknown = raw
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw)
    } catch {
      return []
    }
  }
  const causes = (body as { details?: { causes?: unknown } } | null)?.details?.causes
  if (!Array.isArray(causes)) return []
  const fields: string[] = []
  for (const cause of causes) {
    const field = (cause as { field?: unknown } | null)?.field
    if (typeof field !== 'string' || !FIELD_PATH.test(field) || fields.includes(field)) continue
    fields.push(field)
    if (fields.length === MAX_INVALID_FIELDS) break
  }
  return fields
}

// control-api's own errors carry a stable string code (for example
// `context_identity_unavailable` with a statusCode). They are not apiserver
// answers and must reach their own handling unchanged. A FetchError's errno
// code is also a string, so transport failures are excluded from this test.
function isSyntheticError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && !/^\d+$/.test(code) && !isTransportError(err)
}

/**
 * Classify a failed Kubernetes call of a registry step.
 *
 * - 401/403 → 502 `registry_upstream_failed`.
 * - 409 → 409 on a create or update; 422 → 422 on a create or update, naming
 *   the registry entry when control-api built the spec; 413 → 413 for
 *   operator content only.
 * - 404 → 404 on a read, or on an update of an object the request named.
 *   Operator content is control-api's own credential Secret, so a 404 there
 *   is an upstream failure.
 * - any other status, or a 409/422/413 outside the cases above → 503.
 * - transport failure → 503.
 * - no HTTP status, or a non-numeric string `code` → rethrown unchanged.
 */
export function classifyRegistryUpstreamFailure(
  err: unknown,
  step: RegistryUpstreamStep
): RegistryUpstreamFailure {
  if (isSyntheticError(err)) throw err
  const upstreamStatus = upstreamStatusOrRethrow(err)
  const reason = upstreamReason(err, upstreamStatus)
  const target = `${step.kind} "${step.name}" in namespace "${step.namespace}"`
  const prefix = `control-api could not ${step.verb} ${target}`
  const isWrite = step.verb !== 'read'
  const isOperatorContent = step.content?.source === 'operator'
  let invalidFields: string[] = []

  const result = (
    status: RegistryUpstreamFailure['status'],
    message: string,
    severity: RegistryUpstreamFailure['severity']
  ): RegistryUpstreamFailure => ({
    status,
    body: {
      error: status >= 500 ? 'registry_upstream_failed' : 'registry_upstream_rejected',
      message,
      resourceType: RESOURCE_TYPES[step.kind],
      resourceName: step.name,
      namespace: step.namespace,
    },
    upstreamStatus,
    upstreamReason: reason,
    invalidFields,
    severity,
  })

  if (upstreamStatus === null) {
    return result(503, `${prefix}: the Kubernetes API server could not be reached.`, 'error')
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return result(
      502,
      `${prefix}: the Kubernetes API server rejected the request from control-api's own ` +
        `ServiceAccount (HTTP ${upstreamStatus}): an RBAC rule or an admission policy denied ` +
        `it. Your session is not the cause.`,
      'error'
    )
  }
  if (upstreamStatus === 409 && isWrite) {
    return step.verb === 'create'
      ? result(
          409,
          `${step.kind} "${step.name}" already exists in namespace "${step.namespace}". ` +
            `Uninstall it or choose another name.`,
          'warn'
        )
      : result(409, `${target} changed while this request was running. Retry.`, 'warn')
  }
  if (upstreamStatus === 422 && isWrite && step.content) {
    invalidFields = invalidFieldsOf(err)
    const detail =
      invalidFields.length > 0 ? `HTTP 422; fields: ${invalidFields.join(', ')}` : 'HTTP 422'
    if (step.content.source === 'operator') {
      return result(
        422,
        `the Kubernetes API server rejected ${target} as invalid (${detail}).`,
        'warn'
      )
    }
    return result(
      422,
      `the Kubernetes API server rejected the ${step.kind} "${step.name}" spec that ` +
        `control-api built from registry entry ${step.content.entry}@${step.content.version} ` +
        `(${detail}). Your request is not the cause: the catalog entry and this cluster's ` +
        `${step.kind} definition or admission policy disagree.`,
      'error'
    )
  }
  if (upstreamStatus === 413 && isWrite && isOperatorContent) {
    return result(
      413,
      `the credentials for "${step.name}" exceed the size the Kubernetes API server ` +
        `accepts (HTTP 413).`,
      'warn'
    )
  }
  if (
    upstreamStatus === 404 &&
    (step.verb === 'read' || (step.verb === 'update' && !isOperatorContent))
  ) {
    return result(
      404,
      `${step.kind} "${step.name}" not found in namespace "${step.namespace}".`,
      'warn'
    )
  }
  return result(
    503,
    `${prefix}: the Kubernetes API server returned HTTP ${upstreamStatus}.`,
    'error'
  )
}
