import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  InvalidSecretKeyError,
  SECRET_DATA_KEY_MAX_LENGTH,
  invalidSecretDataKeyReason,
} from '../src/services/secretKeys.js'
import { SecretService } from '../src/services/secretService.js'

// A key the Kubernetes apiserver rejects (IsConfigMapKey). Feeding any of these
// to a Secret write must fail here with a 400 BEFORE the apiserver ever sees it,
// never as the opaque 500 the apiserver would return.
const INVALID_KEYS: readonly string[] = [
  '.', // reserved
  '..', // reserved
  'foo/bar', // slash outside charset
  'has space', // space outside charset
  'key@host', // @ outside charset
  'café', // non-ASCII outside charset
  '', // empty
  'x'.repeat(SECRET_DATA_KEY_MAX_LENGTH + 1), // 254 chars, over the limit
  '..foo', // "..*" prefix — apiserver rejects (reserved mounted-volume symlink)
  '..data', // "..*" prefix
  '...x', // "..*" prefix (three dots still starts with "..")
]

// Keys that are legitimate Secret data keys and MUST keep flowing through to the
// apiserver untouched (env var names, credential slots, TLS files, dotted keys).
const VALID_KEYS: readonly string[] = [
  'LINEAR_API_KEY',
  'openai-api-key',
  'tls.crt',
  'api-key',
  'foo.bar',
  '.foo', // a single leading dot is valid — only the "..*" PREFIX is reserved
  'foo..', // trailing dots are valid — only the prefix matters, not the suffix
  'a'.repeat(SECRET_DATA_KEY_MAX_LENGTH), // exactly 253 chars
]

type CoreApiMock = {
  readNamespacedSecret: ReturnType<typeof vi.fn>
  createNamespacedSecret: ReturnType<typeof vi.fn>
  replaceNamespacedSecret: ReturnType<typeof vi.fn>
  patchNamespacedSecret: ReturnType<typeof vi.fn>
  deleteNamespacedSecret: ReturnType<typeof vi.fn>
}

function createCoreApiMock(): CoreApiMock {
  return {
    readNamespacedSecret: vi.fn().mockResolvedValue({ metadata: {}, type: 'Opaque', data: {} }),
    createNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: 's' } }),
    replaceNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: 's' } }),
    patchNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: 's' } }),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
  }
}

describe('SecretService — invalid Secret keys never reach the apiserver', () => {
  let coreApi: CoreApiMock
  let svc: SecretService

  beforeEach(() => {
    coreApi = createCoreApiMock()
    svc = new SecretService(coreApi as unknown as k8s.CoreV1Api, 'test-ns')
  })

  // Every write op that carries a data payload rejects an invalid key up front.
  // The second assertion is the real invariant: the apiserver client is never
  // touched, so no invalid key can produce the opaque apiserver 500.
  const payloadOps: ReadonlyArray<{
    name: string
    call: (key: string) => Promise<unknown>
    apiSurface: (keyof CoreApiMock)[]
  }> = [
    {
      name: 'createSecret',
      call: key =>
        svc.createSecret({ name: 's', namespace: 'test-ns', stringData: { [key]: 'v' } }),
      apiSurface: ['createNamespacedSecret'],
    },
    {
      name: 'updateSecret',
      call: key =>
        svc.updateSecret({ name: 's', namespace: 'test-ns', stringData: { [key]: 'v' } }),
      // The guard runs before the read, so neither read nor replace is reached.
      apiSurface: ['readNamespacedSecret', 'replaceNamespacedSecret'],
    },
    {
      name: 'mergeSecret',
      call: key => svc.mergeSecret({ name: 's', namespace: 'test-ns', stringData: { [key]: 'v' } }),
      apiSurface: ['patchNamespacedSecret'],
    },
  ]

  for (const op of payloadOps) {
    describe(op.name, () => {
      for (const badKey of INVALID_KEYS) {
        it(`rejects key ${JSON.stringify(badKey)} with a 400 and never calls the apiserver`, async () => {
          const err = await op.call(badKey).then(
            () => {
              throw new Error('expected the write to reject')
            },
            (e: unknown) => e
          )
          expect(err).toBeInstanceOf(InvalidSecretKeyError)
          expect((err as InvalidSecretKeyError).status).toBe(400)
          for (const surface of op.apiSurface) {
            expect(coreApi[surface]).not.toHaveBeenCalled()
          }
        })
      }

      for (const goodKey of VALID_KEYS) {
        it(`lets valid key ${JSON.stringify(goodKey)} through to the apiserver`, async () => {
          await op.call(goodKey)
          // The op reached its apiserver call (the last surface is the write).
          const writeSurface = op.apiSurface[op.apiSurface.length - 1]
          expect(coreApi[writeSurface]).toHaveBeenCalledOnce()
        })
      }
    })
  }

  // removeSecretKey validates the single key it is asked to drop: an invalid key
  // can never exist on a Secret, so this is a 400, not a merge-patch attempt.
  describe('removeSecretKey', () => {
    for (const badKey of INVALID_KEYS) {
      it(`rejects key ${JSON.stringify(badKey)} with a 400 and never calls the apiserver`, async () => {
        const err = await svc
          .removeSecretKey({ name: 's', namespace: 'test-ns', key: badKey })
          .then(
            () => {
              throw new Error('expected the removal to reject')
            },
            (e: unknown) => e
          )
        expect(err).toBeInstanceOf(InvalidSecretKeyError)
        expect((err as InvalidSecretKeyError).status).toBe(400)
        expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled()
      })
    }

    it('lets a valid key through to a merge-patch', async () => {
      await svc.removeSecretKey({ name: 's', namespace: 'test-ns', key: 'LINEAR_API_KEY' })
      expect(coreApi.patchNamespacedSecret).toHaveBeenCalledOnce()
    })
  })

  // A payload can carry an invalid key in `data` (base64) as well as `stringData`.
  it('validates keys in the base64 `data` map too, not only stringData', async () => {
    const err = await svc
      .createSecret({ name: 's', namespace: 'test-ns', data: { 'bad/key': 'dg==' } })
      .then(
        () => {
          throw new Error('expected the write to reject')
        },
        (e: unknown) => e
      )
    expect(err).toBeInstanceOf(InvalidSecretKeyError)
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
  })
})

describe('invalidSecretDataKeyReason — the shared rule', () => {
  it('accepts every legitimate key', () => {
    for (const key of VALID_KEYS) {
      expect(invalidSecretDataKeyReason(key)).toBeNull()
    }
  })

  it('rejects every apiserver-invalid key with an actionable message', () => {
    for (const key of INVALID_KEYS) {
      const reason = invalidSecretDataKeyReason(key)
      expect(reason).not.toBeNull()
      expect(reason).toContain('not a valid Secret key')
    }
  })
})
