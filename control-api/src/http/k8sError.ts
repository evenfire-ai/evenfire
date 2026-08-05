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
