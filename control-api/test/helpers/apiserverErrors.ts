import { expect } from 'vitest'
import { ApiException } from '@kubernetes/client-node'

/**
 * Markers planted in every free-text field an apiserver error carries. None of
 * them may reach an HTTP response body.
 */
export const APISERVER_LEAK_MARKERS = {
  serviceAccount: 'system:serviceaccount:control-plane:control-api',
  statusMessage: 'status-message-marker-8c41',
  causeMessage: 'cause-message-marker-2f7d',
  auditHeader: 'audit-id',
  auditId: '9a3e61d0-registry-upstream',
  flowSchemaUid: 'flowschema-uid-registry-upstream',
} as const

export type ApiserverCause = { field?: unknown; reason?: string }

/**
 * The error @kubernetes/client-node raises for an apiserver HTTP failure: a
 * real ApiException whose metav1.Status message names control-api's
 * ServiceAccount and a marker, whose `causes[].message` carries another
 * marker, and whose headers carry the audit id.
 */
export function apiserverError(
  status: number,
  options: { causes?: ApiserverCause[] } = {}
): ApiException<string> {
  const body = JSON.stringify({
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    message:
      `request by User "${APISERVER_LEAK_MARKERS.serviceAccount}" failed: ` +
      APISERVER_LEAK_MARKERS.statusMessage,
    reason: 'Failure',
    details: {
      name: 'target',
      causes: (options.causes ?? []).map(cause => ({
        ...cause,
        message: `${APISERVER_LEAK_MARKERS.causeMessage} ${String(cause.field)}`,
      })),
    },
    code: status,
  })
  return new ApiException(status, 'Failure', body, {
    [APISERVER_LEAK_MARKERS.auditHeader]: APISERVER_LEAK_MARKERS.auditId,
    'x-kubernetes-pf-flowschema-uid': APISERVER_LEAK_MARKERS.flowSchemaUid,
  })
}

/** A UUID, the only shape the correlation-id middleware lets through. */
export const TEST_CORRELATION_ID = '3f2b8c1e-7a4d-4e9b-8c21-5d6f0a1b2c3d'

/** A real ApiException shaped as the client raises a 403: a string metav1.Status body. */
export function statusForbidden(message: string): ApiException<string> {
  const body = JSON.stringify({
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    message,
    reason: 'Forbidden',
    code: 403,
  })
  return new ApiException(403, 'Unknown API Status Code!', body, {
    [APISERVER_LEAK_MARKERS.auditHeader]: APISERVER_LEAK_MARKERS.auditId,
  })
}

/** The global handler's message for a 403 not written by a policy author. */
export function handlerRefused403(correlationId: string): string {
  return (
    'The Kubernetes API server refused a request from control-api (HTTP 403): RBAC or ' +
    'admission control denied it. Your session is not the cause; see correlation id ' +
    `${correlationId} in the control-api log.`
  )
}

/** node-fetch's shape for a refused connection (no HTTP response at all). */
export function connectionRefused(): Error {
  return Object.assign(new Error('request to https://10.96.0.1/api failed, reason: connect'), {
    name: 'FetchError',
    type: 'system',
    code: 'ECONNREFUSED',
    errno: 'ECONNREFUSED',
  })
}

/** Assert that no apiserver text, header name or header value is in `body`. */
export function expectNoApiserverText(body: unknown): void {
  const serialized = JSON.stringify(body)
  for (const marker of Object.values(APISERVER_LEAK_MARKERS)) {
    expect(serialized).not.toContain(marker)
  }
  expect(serialized).not.toContain('5f0c7a4e-secret-read')
  // The prefix of an ApiException's own `.message`, which embeds the headers.
  expect(serialized).not.toContain('HTTP-Code:')
}
