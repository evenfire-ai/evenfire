import { describe, expect, it, vi } from 'vitest'
import { SecretService } from '../src/services/secretService.js'

describe('SecretService replacement metadata preservation', () => {
  it('preserves protected metadata during an identity-bound replace', async () => {
    const existing = {
      metadata: {
        name: 'registry-credentials',
        namespace: 'sandbox',
        uid: 'secret-uid-1',
        resourceVersion: '41',
        labels: { 'clerum.io/managed-by': 'control-api' },
        annotations: { 'example.com/owner': 'registry' },
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            name: 'connector',
            uid: 'deployment-uid-1',
          },
        ],
        finalizers: ['example.com/cleanup'],
      },
      type: 'Opaque',
      immutable: true,
      data: { token: 'old' },
    }
    const replaced = {
      ...existing,
      metadata: { ...existing.metadata, resourceVersion: '42' },
      data: { token: 'new' },
    }
    const readNamespacedSecret = vi.fn().mockResolvedValue(existing)
    const replaceNamespacedSecret = vi.fn().mockResolvedValue(replaced)
    const service = new SecretService(
      { readNamespacedSecret, replaceNamespacedSecret } as never,
      'sandbox'
    )

    await service.updateSecret(
      {
        name: 'registry-credentials',
        namespace: 'sandbox',
        data: { token: 'new' },
      },
      { uid: 'secret-uid-1', resourceVersion: '41' }
    )

    const request = replaceNamespacedSecret.mock.calls[0][0]
    expect(request.body.metadata.ownerReferences).toEqual(existing.metadata.ownerReferences)
    expect(request.body.metadata.finalizers).toEqual(existing.metadata.finalizers)
    expect(request.body.immutable).toBe(true)
  })
})
