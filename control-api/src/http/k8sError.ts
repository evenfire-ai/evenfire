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
 * bodies, warnings). Unlike `extractK8sError` it never falls back to `err.message`: a
 * client-node `ApiException` builds that message from the full apiserver response,
 * response headers included. Only the metav1.Status `message` is used, then a fixed
 * status text; an error without a K8s status gets the caller's fixed fallback.
 */
export function k8sSafeFailureMessage(err: unknown, fallback: string): string {
  const status = extractK8sError(err)?.status
  if (status === undefined) return fallback
  const body = (err as { body?: unknown }).body
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
  return typeof statusMessage === 'string' && statusMessage.length > 0
    ? statusMessage
    : `K8s error ${status}`
}
