import { expect } from 'vitest'
import { ApiException } from '@kubernetes/client-node'

/**
 * The error @kubernetes/client-node raises when the apiserver refuses
 * control-api's own ServiceAccount a Secret read: a real ApiException whose
 * metav1.Status message names the ServiceAccount and whose headers carry the
 * audit id. Neither may reach the HTTP response.
 */
export function controlApiForbiddenRead(name: string, namespace: string): ApiException<string> {
  const body = JSON.stringify({
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    message: `secrets "${name}" is forbidden: User "system:serviceaccount:control-plane:control-api" cannot get resource "secrets" in API group "" in the namespace "${namespace}"`,
    reason: 'Forbidden',
    code: 403,
  })
  return new ApiException(403, 'Forbidden', body, {
    'audit-id': '5f0c7a4e-secret-read',
    'x-kubernetes-pf-flowschema-uid': 'flowschema-uid',
  })
}

/** The exact message SecretReadError carries for a 401/403 on a Secret read. */
export function rejectedAccessMessage(name: string, namespace: string, status: 401 | 403): string {
  return (
    `control-api could not read Secret "${name}" in namespace "${namespace}": ` +
    `the Kubernetes API server rejected control-api's own access (HTTP ${status}). ` +
    `Your session is not the cause; check the control-api RBAC for that namespace.`
  )
}

/**
 * Assert the response the global handler gives a SecretReadError for a
 * rejected read: 502 (never the forwarded 403 that the Control UI would read
 * as "this operator is not authorized"), the stable code, the exact message,
 * and nothing from the apiserver's Status body or headers.
 */
export function expectRejectedSecretRead(
  res: { status: number; body: Record<string, unknown> },
  name: string,
  namespace: string
): void {
  expect(res.status).toBe(502)
  expect(res.body.error).toBe('secret_read_failed')
  expect(res.body.message).toBe(rejectedAccessMessage(name, namespace, 403))
  const serialized = JSON.stringify(res.body)
  expect(serialized).not.toContain('system:serviceaccount')
  expect(serialized).not.toContain('audit-id')
  expect(serialized).not.toContain('5f0c7a4e-secret-read')
}
