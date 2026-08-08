import type { NextFunction, Request, Response } from 'express'
import { ApiException } from '@kubernetes/client-node'
import { STATUS_CODES } from 'node:http'
import { rootLogger } from '../observability/logger.js'
import { memberRegistrationErrorResponse } from '../services/memberRegistrationErrors.js'

// Only errors we construct with these codes are ever forwarded verbatim by the
// global handler. Keeps the blast radius tight: every other status-less or
// non-allowlisted error still collapses to a 500.
export const FORWARDABLE_INTEGRATION_CODES = new Set([
  'registry_unavailable',
  'registry_integration_error',
])

/**
 * Extract an HTTP status from an error the same way `extractK8sStatus`
 * (resourceServiceHelpers) does, so a raw @kubernetes/client-node error — which
 * carries its status on `.code` / `.statusCode` / `.response.*`, NOT a top-level
 * `.status` — is forwarded with its real 4xx instead of collapsing to a 500.
 *
 * Precedence mirrors extractK8sStatus, with `.status` FIRST so the legacy
 * service-layer path (errors that set `.status` deliberately) is preserved.
 */
function extractErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const maybe = err as {
    status?: unknown
    statusCode?: unknown
    code?: unknown
    response?: { statusCode?: unknown; status?: unknown }
  }
  if (typeof maybe.status === 'number') return maybe.status
  if (typeof maybe.statusCode === 'number') return maybe.statusCode
  if (typeof maybe.code === 'number') return maybe.code
  if (maybe.response && typeof maybe.response.statusCode === 'number') {
    return maybe.response.statusCode
  }
  if (maybe.response && typeof maybe.response.status === 'number') return maybe.response.status
  return undefined
}

/**
 * True when `err` is a raw @kubernetes/client-node ApiException, or an object
 * carrying its leaking shape. ApiException stores the metav1.Status on `.body`
 * and EVERY apiserver response header (Audit-Id, x-kubernetes-pf-*) on
 * `.headers`, and its `.message` is built as
 * `"HTTP-Code: …\nMessage: …\nBody: <JSON status>\nHeaders: <JSON headers>"`.
 * Forwarding that message verbatim to the client leaks internals — hence the
 * shape fallback, so a copy created against a duplicated module instance (where
 * `instanceof` would miss) is still caught.
 */
function isK8sApiException(err: unknown): boolean {
  if (err instanceof ApiException) return true
  return (
    err instanceof Error &&
    'body' in err &&
    'headers' in err &&
    typeof (err as { headers?: unknown }).headers === 'object' &&
    (err as { headers?: unknown }).headers !== null
  )
}

/**
 * Client-safe message for a forwarded 4xx.
 *
 * A raw K8s ApiException `.message` embeds the full metav1.Status body AND every
 * apiserver response header — never forward it. Collapse K8s errors to the
 * standard status text, surfacing at most the metav1.Status `body.message`
 * (the apiserver's human explanation, e.g. `... already exists`), which is the
 * same class of info the service layer already returns and carries no headers.
 * Non-K8s Errors keep their own (author-controlled) message; non-Errors get
 * 'Bad Request'.
 */
function clientErrorMessage(err: unknown, status: number): string {
  const fallback = STATUS_CODES[status] ?? 'Bad Request'
  if (isK8sApiException(err)) {
    const body = (err as { body?: unknown }).body
    if (body && typeof body === 'object') {
      const bodyMessage = (body as { message?: unknown }).message
      if (typeof bodyMessage === 'string' && bodyMessage.length > 0) return bodyMessage
    } else if (typeof body === 'string' && body.length > 0) {
      try {
        const parsed = JSON.parse(body) as { message?: unknown }
        if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message
      } catch {
        // body is not JSON — never forward the raw string, fall through to the
        // generic status text.
      }
    }
    return fallback
  }
  return err instanceof Error ? err.message : 'Bad Request'
}

/**
 * Log-safe rendering of an error's message. A raw @kubernetes/client-node
 * ApiException `.message` embeds the metav1.Status body AND every apiserver
 * response header (Audit-Id, x-kubernetes-pf-*) — writing it to a log puts
 * infrastructure PID/PII into internal logs (S1). Collapse K8s exceptions to the
 * same sanitized text the client sees (metav1.Status `body.message` or the
 * status text, never headers); non-K8s errors keep their author-controlled
 * detail. Used for EVERY branch that logs an error message, not just the 4xx one.
 */
function safeErrorLogMessage(err: unknown): string {
  if (isK8sApiException(err)) return clientErrorMessage(err, extractErrorStatus(err) ?? 500)
  return err instanceof Error ? err.message : String(err)
}

/**
 * Log-safe stack: a K8s ApiException's `.stack` begins with its `.message`, so it
 * leaks the same headers — drop it for K8s exceptions and keep it otherwise.
 */
function safeErrorLogStack(err: unknown): string | undefined {
  if (isK8sApiException(err)) return undefined
  return err instanceof Error ? err.stack : undefined
}

/**
 * Global Express error handler for control-api.
 *
 * Exported (rather than an inline closure in createApp) so it can be unit-tested
 * in isolation. Behavior:
 *   - typed member-registration failures → their mapped status (spec §8.6);
 *   - any error carrying a 4xx status (via `.status` / `.statusCode` / `.code` /
 *     `.response.*`) is FORWARDED with a sanitized message — this is FIX-B: raw
 *     K8s 400/403/404/409/422 no longer collapse to 500;
 *   - allowlisted registry-integration 502/503 codes are forwarded verbatim;
 *   - everything else (5xx, status-less, non-Error throws) → 500, unchanged.
 */
export function clerumErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Use the request-scoped correlation id if middleware ran, otherwise
  // synthesize a short tag for legacy paths.
  const correlationId = req.correlationId ?? Math.random().toString(36).slice(2, 10)
  const log = req.log ?? rootLogger

  // Typed member-registration failures map to 503 (spec §8.6) — scoped
  // instanceof check; the generic 5xx-collapse below stays intact.
  const memberRegistration = memberRegistrationErrorResponse(err)
  if (memberRegistration) {
    log.warn(
      {
        event: memberRegistration.error,
        correlationId,
        err: safeErrorLogMessage(err),
      },
      'member registration unavailable'
    )
    res.status(memberRegistration.status).json({ error: memberRegistration.error, correlationId })
    return
  }

  // Errors thrown by service-layer code (and raw K8s client errors) carry a
  // status that signals the upstream response should be forwarded to the API
  // client rather than collapsed into a 500. Honor 4xx values; 5xx still surface
  // as Internal Server Error so backend failures don't leak through as
  // caller-visible errors.
  const errStatus = extractErrorStatus(err)
  const isClientError = errStatus !== undefined && errStatus >= 400 && errStatus < 500

  if (isClientError) {
    log.warn(
      {
        event: 'forwarded_client_error',
        correlationId,
        status: errStatus,
        err: safeErrorLogMessage(err),
      },
      'forwarded client error from upstream'
    )
    res.status(errStatus as number).json({
      error: clientErrorMessage(err, errStatus as number),
      correlationId,
    })
    return
  }

  // Allowlisted registry-integration errors carry a safe code + message we set
  // ourselves (RegistryUnavailableError → 503; the 401 remap → 502). Forward
  // them so the marketplace shows a clear message instead of a raw 500. The
  // message is safe because only our own constructors set these codes.
  const integrationCode = (err as { code?: unknown }).code
  const integrationStatus = (err as { status?: unknown }).status
  if (
    typeof integrationStatus === 'number' &&
    (integrationStatus === 502 || integrationStatus === 503) &&
    typeof integrationCode === 'string' &&
    FORWARDABLE_INTEGRATION_CODES.has(integrationCode)
  ) {
    log.warn(
      {
        event: 'forwarded_registry_integration_error',
        correlationId,
        status: integrationStatus,
        code: integrationCode,
        err: safeErrorLogMessage(err),
      },
      'forwarded registry integration error'
    )
    res.status(integrationStatus).json({
      error: integrationCode,
      message: err instanceof Error ? err.message : 'Registry integration error',
      correlationId,
    })
    return
  }

  log.error(
    {
      event: 'unhandled_error',
      correlationId,
      err: safeErrorLogMessage(err),
      stack: safeErrorLogStack(err),
    },
    'unhandled error'
  )
  if (process.env.NODE_ENV !== 'production') {
    res.status(500).json({
      error: 'Internal Server Error',
      // Sanitize the client-facing debug message the same way the 4xx branch
      // does: a raw K8s ApiException `.message` embeds the metav1.Status body AND
      // every apiserver header (Audit-Id, x-kubernetes-pf-*). A 5xx K8s error
      // (etcd/apiserver down) is still an Error, so forwarding `err.message`
      // verbatim here leaks those headers in dev/test.
      message: clientErrorMessage(err, 500),
      correlationId,
    })
  } else {
    res.status(500).json({
      error: 'Internal Server Error',
      correlationId,
    })
  }
}
