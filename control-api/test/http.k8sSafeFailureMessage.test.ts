import { describe, expect, it } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import { k8sSafeFailureMessage } from '../src/http/k8sError.js'
import { controlApiForbiddenRead } from './helpers/secretReadFailure.js'

const statusBody = (code: number, message: string): string =>
  JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message, code })

describe('k8sSafeFailureMessage', () => {
  it('never forwards the Status message of a 403, which names the ServiceAccount', () => {
    const err = controlApiForbiddenRead('demo-credentials', 'mcp-server')
    // Witness: the fixture really carries the identity the helper must drop.
    expect(String(err.body)).toContain('system:serviceaccount')

    const message = k8sSafeFailureMessage(err, 'unable to verify deletion')

    expect(message).toBe('K8s error 403')
  })

  it('never forwards the Status message of a 401', () => {
    const err = new ApiException(
      401,
      'Unauthorized',
      statusBody(401, 'token for user "alice" expired'),
      {}
    )

    expect(k8sSafeFailureMessage(err, 'fallback')).toBe('K8s error 401')
  })

  it('keeps the Status message for other statuses', () => {
    const err = new ApiException(
      409,
      'Conflict',
      statusBody(409, 'the object has been modified'),
      {}
    )

    expect(k8sSafeFailureMessage(err, 'fallback')).toBe('the object has been modified')
  })

  it('falls back to the status text when the body is not a Status', () => {
    const err = new ApiException(500, 'Internal Server Error', 'upstream connect error', {})

    expect(k8sSafeFailureMessage(err, 'fallback')).toBe('K8s error 500')
  })

  it('returns the caller fallback for an error without a K8s status', () => {
    expect(k8sSafeFailureMessage(new Error('socket hang up'), 'unable to verify deletion')).toBe(
      'unable to verify deletion'
    )
  })
})
