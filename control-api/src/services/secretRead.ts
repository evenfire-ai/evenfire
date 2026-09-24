import { extractK8sError } from '../http/k8sError.js'
import { extractHttpStatus } from '../k8s.js'

/**
 * Status and client message for an apiserver read that control-api could not
 * complete.
 *
 * Why not let the raw K8s error through: the global handler forwards every K8s
 * 4xx with its metav1.Status message. A 403 on control-api's OWN ServiceAccount
 * would then reach the Control UI as a 403 whose message names
 * `system:serviceaccount:<ns>:control-api` as forbidden, which an operator
 * reads as their own permission failing; a 401 would log the operator out.
 * Both blame the caller for a server-side fault. 502/503 say what happened: an
 * upstream dependency of control-api failed.
 *
 * The message is built from `subject`, `namespace` and the numeric status
 * only. `subject` can contain request input (a Secret name); the response goes
 * back to the same caller as JSON. The apiserver's own text is never part of it.
 */
function describeReadFailure(
  subject: string,
  namespace: string,
  upstreamStatus: number | null
): { status: 502 | 503; message: string } {
  const prefix = `control-api could not ${subject} in namespace "${namespace}"`
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return {
      status: 502,
      message:
        `${prefix}: the Kubernetes API server rejected control-api's own access ` +
        `(HTTP ${upstreamStatus}). Your session is not the cause; check the control-api ` +
        `RBAC for that namespace.`,
    }
  }
  if (upstreamStatus !== null) {
    return {
      status: 503,
      message: `${prefix}: the Kubernetes API server returned HTTP ${upstreamStatus}.`,
    }
  }
  return { status: 503, message: `${prefix}: the Kubernetes API server could not be reached.` }
}

/**
 * A Secret read that failed for a reason other than "the Secret does not
 * exist". Forwarded by `clerumErrorHandler` (allowlisted integration code) as
 * `{ error: 'secret_read_failed', message }` with a 502 (401/403) or 503 (any
 * other HTTP status, or no HTTP response). The handler logs `upstreamStatus`
 * and `upstreamReason` with the request's correlation id.
 */
export class SecretReadError extends Error {
  readonly code = 'secret_read_failed'
  readonly status: 502 | 503
  readonly upstreamStatus: number | null
  /** Log-only: the metav1.Status message or errno code, never response headers. */
  readonly upstreamReason: string | null

  constructor(
    secretName: string,
    namespace: string,
    upstreamStatus: number | null,
    upstreamReason: string | null
  ) {
    const { status, message } = describeReadFailure(
      `read Secret "${secretName}"`,
      namespace,
      upstreamStatus
    )
    super(message)
    this.name = 'SecretReadError'
    this.status = status
    this.upstreamStatus = upstreamStatus
    this.upstreamReason = upstreamReason
  }
}

/**
 * A WorkflowRecipe list that failed. Same status mapping and forwarding as
 * SecretReadError, with code `workflow_recipe_list_failed`. A namespaced list
 * has no "absent" answer, so a 404 (CRD not installed) is a 503 here.
 */
export class WorkflowRecipeListError extends Error {
  readonly code = 'workflow_recipe_list_failed'
  readonly status: 502 | 503
  readonly upstreamStatus: number | null
  /** Log-only: the metav1.Status message or errno code, never response headers. */
  readonly upstreamReason: string | null

  constructor(namespace: string, upstreamStatus: number | null, upstreamReason: string | null) {
    const { status, message } = describeReadFailure(
      'list WorkflowRecipes',
      namespace,
      upstreamStatus
    )
    super(message)
    this.name = 'WorkflowRecipeListError'
    this.status = status
    this.upstreamStatus = upstreamStatus
    this.upstreamReason = upstreamReason
  }
}

type SecretReader = { getSecret(name: string, namespace?: string): Promise<unknown> }
type ResourceLister = { listResource(plural: string, namespace?: string): Promise<unknown[]> }

// node-fetch (the transport under @kubernetes/client-node 1.x) reports a
// socket error as a FetchError of type 'system' carrying the errno code, and
// an aborted request as an AbortError. These are the only errors treated as
// transport failures (503 "could not be reached"). The K8s client sets no
// request timeout, so node-fetch's 'request-timeout' FetchError does not occur
// on these reads; like any other status-less error it would be rethrown.
function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return true
  const e = err as { type?: unknown; code?: unknown }
  return err.name === 'FetchError' && e.type === 'system' && typeof e.code === 'string'
}

// The upstream HTTP status of a failed apiserver call, or null for a transport
// failure. Any other error is not an apiserver failure and is rethrown
// unchanged; the global handler then decides its status (500 for a plain Error).
function upstreamStatusOrRethrow(err: unknown): number | null {
  const upstreamStatus = extractHttpStatus(err)
  if (upstreamStatus === null && !isTransportError(err)) throw err
  return upstreamStatus
}

// Log-safe reason: the metav1.Status message for an HTTP failure, the errno
// code for a failed connection, or the error name for an AbortError.
// extractK8sError falls back to `err.message` when the Status body is empty,
// and a raw ApiException's `.message` embeds every apiserver response header,
// so that fallback is discarded here.
function upstreamReason(err: unknown, upstreamStatus: number | null): string | null {
  if (upstreamStatus === null) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : (err as Error).name
  }
  const k8s = extractK8sError(err)
  if (!k8s || (err instanceof Error && k8s.message === err.message)) return null
  return k8s.message
}

/**
 * Read a Secret, returning `null` only when the apiserver answers 404.
 *
 * - 401/403 → SecretReadError 502: the apiserver rejected control-api's own
 *   credentials or RBAC.
 * - any other HTTP status → SecretReadError 503.
 * - transport failure (no HTTP response) → SecretReadError 503.
 * - anything else → rethrown unchanged.
 */
export async function readSecretOrNull(
  gateway: SecretReader,
  name: string,
  namespace: string
): Promise<unknown> {
  try {
    return await gateway.getSecret(name, namespace)
  } catch (err) {
    const upstreamStatus = upstreamStatusOrRethrow(err)
    if (upstreamStatus === 404) return null
    throw new SecretReadError(name, namespace, upstreamStatus, upstreamReason(err, upstreamStatus))
  }
}

/**
 * List the WorkflowRecipes in `namespace`. Every apiserver or transport
 * failure throws a WorkflowRecipeListError (502/503); anything else is
 * rethrown unchanged.
 */
export async function listWorkflowRecipes(
  gateway: ResourceLister,
  namespace: string
): Promise<unknown[]> {
  try {
    return await gateway.listResource('workflowrecipes', namespace)
  } catch (err) {
    const upstreamStatus = upstreamStatusOrRethrow(err)
    throw new WorkflowRecipeListError(
      namespace,
      upstreamStatus,
      upstreamReason(err, upstreamStatus)
    )
  }
}
