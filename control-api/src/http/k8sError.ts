/**
 * Extract HTTP status + message from K8s client errors.
 *
 * The @kubernetes/client-node errors carry the apiserver's explanation in `body` (a JSON
 * string on most paths, an object on some), not in `message` — so a bare `err.message`
 * turns "Secret is immutable" into "HTTP request failed". Lives here rather than inside a
 * route file because more than one route module now maps these onto responses.
 */
export function extractK8sError(err: unknown): { status: number; message: string } | null {
  if (err && typeof err === 'object') {
    const e = err as {
      code?: number
      body?: string | { message?: string }
      httpStatus?: number
      statusCode?: number
      message?: string
    }
    const status = e.code ?? e.statusCode ?? e.httpStatus
    if (typeof status === 'number' && status >= 400 && status < 600) {
      let msg = ''
      if (typeof e.body === 'string') {
        try {
          msg = (JSON.parse(e.body) as { message?: string }).message ?? e.body
        } catch {
          msg = e.body
        }
      } else if (e.body && typeof e.body === 'object') {
        msg = e.body.message ?? ''
      }
      return { status, message: msg || e.message || `K8s error ${status}` }
    }
  }
  return null
}

/**
 * Client-safe reason for a failed K8s call, for text that leaves the process (response
 * bodies, warnings): the fixed `K8s error <status>`, or the caller's fixed fallback for
 * an error without a K8s status. Neither `err.message` (a client-node `ApiException`
 * builds it from the full apiserver response, headers included) nor the metav1.Status
 * message (a 401/403 names control-api's own ServiceAccount, and other statuses can
 * carry apiserver internals) is ever returned; the server log keeps the Status message.
 */
export function k8sSafeFailureMessage(err: unknown, fallback: string): string {
  const status = extractK8sError(err)?.status
  return status === undefined ? fallback : `K8s error ${status}`
}

/** The metav1.Status `message` of a K8s client error, or null. Never the raw body. */
export function statusMessageOf(err: unknown): string | null {
  const body = (err as { body?: unknown } | null)?.body
  let statusMessage: unknown
  if (body && typeof body === 'object') {
    statusMessage = (body as { message?: unknown }).message
  } else if (typeof body === 'string') {
    try {
      statusMessage = (JSON.parse(body) as { message?: unknown }).message
    } catch {
      // Not a metav1.Status: never forward the raw body.
    }
  }
  return typeof statusMessage === 'string' && statusMessage.length > 0 ? statusMessage : null
}

// The apiserver's wording for a request denied by admission control, as opposed
// to the RBAC authorizer ("<resource> is forbidden: User \"…\" cannot <verb> …"),
// anchored at the start of the Status message: a ValidatingAdmissionPolicy
// (`<resource> "<name>" is forbidden: ValidatingAdmissionPolicy '<p>' with
// binding '<b>' denied request: <message>`) or a validating webhook
// (`admission webhook "<w>" denied the request: <message>`, optionally after the
// same `is forbidden:` prefix). Both answer 403 when the policy sets reason
// Forbidden (deploy/base/cluster-wide/workflowrecipe-admission.yaml).
const ADMISSION_DENIAL =
  /^(?:[^"]+ "[^"]*" is forbidden: )?(?:ValidatingAdmissionPolicy '[^']*' with binding '[^']*' denied request|admission webhook "[^"]*" denied the request): /
const SERVICE_ACCOUNT_SUBJECT = 'system:serviceaccount:'

/**
 * The Status message of a 403 that admission control (not RBAC) returned, or
 * null for any other error. That message is the policy's own explanation of
 * why the object was rejected, so it is the caller's to read; an RBAC 403 names
 * control-api's ServiceAccount and is never returned here. A policy message that
 * names any ServiceAccount (e.g. through a messageExpression on
 * request.userInfo) is not returned either, and the 403 is treated as RBAC.
 */
export function admissionDenialMessage(err: unknown): string | null {
  if (extractK8sError(err)?.status !== 403) return null
  const message = statusMessageOf(err)
  if (message === null || message.includes(SERVICE_ACCOUNT_SUBJECT)) return null
  return ADMISSION_DENIAL.test(message) ? message : null
}
