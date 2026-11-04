import { describe, expect, it } from 'vitest'
import { pullSecretErrorResponse } from '../src/routes/admin/registryPullSecretProvisioning.js'
import { apiserverError, expectNoApiserverText } from './helpers/apiserverErrors.js'

describe('pullSecretErrorResponse — unexpected errors', () => {
  it('reports a Kubernetes failure by its HTTP status only', () => {
    const err = apiserverError(403)
    // Witness: the fixture really carries the text the response must drop.
    expect(err.message).toContain('system:serviceaccount')

    const { status, body } = pullSecretErrorResponse(err)

    expect(status).toBe(500)
    expect(body).toEqual({
      error: 'registry_pull_secret_provision_failed',
      reason: 'unexpected_error',
      detail:
        'the Kubernetes API server returned HTTP 403 while provisioning the image-pull Secret',
    })
    expectNoApiserverText(body)
  })

  it('reports an error without a Kubernetes status by its name only', () => {
    const { status, body } = pullSecretErrorResponse(new TypeError('internal detail /etc/hosts'))

    expect(status).toBe(500)
    expect(body.detail).toBe(
      'unexpected error while provisioning the image-pull Secret (TypeError)'
    )
    expect(JSON.stringify(body)).not.toContain('internal detail')
  })
})
