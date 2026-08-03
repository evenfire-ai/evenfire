import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { extractHttpStatus } from '../src/k8s.js'
import {
  ALLOWED_SECRET_TYPES,
  DangerousAnnotationError,
  InvalidSecretTypeError,
  dangerousAnnotationKeyReason,
  invalidSecretTypeReason,
  stripBlockedAnnotationKeys,
} from '../src/services/secretConstraints.js'
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

// ── Secret type & annotation constraints ─────────────────────────────────────
// Types that a caller must never be able to create via the control-api.
const FORBIDDEN_SECRET_TYPES: readonly string[] = [
  'kubernetes.io/service-account-token',
  'kubernetes.io/basic-auth',
  'kubernetes.io/ssh-auth',
  'bootstrap.kubernetes.io/token',
  'helm.sh/release.v1',
]

// Annotation keys that must be stripped/rejected on write (infra tier — always blocked).
const DANGEROUS_ANNOTATION_KEYS: readonly string[] = [
  'kubectl.kubernetes.io/last-applied-configuration',
  'kubectl.kubernetes.io/restartedAt',
  'kubernetes.io/service-account.name',
  'kubernetes.io/service-account.uid',
  'meta.helm.sh/release-name',
  'meta.helm.sh/release-namespace',
]

// Platform-prefix annotation keys — blocked by default, allowed with allowPlatformAnnotations.
const PLATFORM_ANNOTATION_KEYS: readonly string[] = [
  'clerum.io/owner',
  'clerum.io/catalog-id',
  'clerum.io/catalog-version',
]

// Annotation keys that are safe and must pass through without any opt-out.
const SAFE_ANNOTATION_KEYS: readonly string[] = [
  'app.kubernetes.io/managed-by',
  'my-custom-annotation',
  'custom.example.com/owner',
]

describe('SecretService — forbidden Secret types never reach the apiserver', () => {
  let coreApi: CoreApiMock
  let svc: SecretService

  beforeEach(() => {
    coreApi = createCoreApiMock()
    svc = new SecretService(coreApi as unknown as k8s.CoreV1Api, 'test-ns')
  })

  const writeOps: ReadonlyArray<{
    name: string
    call: (type: string) => Promise<unknown>
    apiSurface: (keyof CoreApiMock)[]
  }> = [
    {
      name: 'createSecret',
      call: type =>
        svc.createSecret({ name: 's', namespace: 'test-ns', type, stringData: { k: 'v' } }),
      apiSurface: ['createNamespacedSecret'],
    },
    {
      name: 'updateSecret',
      call: type =>
        svc.updateSecret({ name: 's', namespace: 'test-ns', type, stringData: { k: 'v' } }),
      apiSurface: ['readNamespacedSecret', 'replaceNamespacedSecret'],
    },
    {
      name: 'mergeSecret',
      call: type =>
        svc.mergeSecret({ name: 's', namespace: 'test-ns', type, stringData: { k: 'v' } }),
      apiSurface: ['patchNamespacedSecret'],
    },
  ]

  for (const op of writeOps) {
    describe(op.name, () => {
      for (const badType of FORBIDDEN_SECRET_TYPES) {
        it(`rejects type "${badType}" with a 400 and never calls the apiserver`, async () => {
          const err = await op.call(badType).then(
            () => {
              throw new Error('expected the write to reject')
            },
            (e: unknown) => e
          )
          expect(err).toBeInstanceOf(InvalidSecretTypeError)
          expect((err as InvalidSecretTypeError).status).toBe(400)
          for (const surface of op.apiSurface) {
            expect(coreApi[surface]).not.toHaveBeenCalled()
          }
        })
      }

      for (const goodType of ALLOWED_SECRET_TYPES) {
        it(`lets allowed type "${goodType}" through to the apiserver`, async () => {
          await op.call(goodType)
          const writeSurface = op.apiSurface[op.apiSurface.length - 1]
          expect(coreApi[writeSurface]).toHaveBeenCalledOnce()
        })
      }
    })
  }

  it('allows omitted type (defaults to Opaque)', async () => {
    await svc.createSecret({ name: 's', namespace: 'test-ns', stringData: { k: 'v' } })
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledOnce()
  })
})

describe('SecretService — dangerous annotations never reach the apiserver', () => {
  let coreApi: CoreApiMock
  let svc: SecretService

  beforeEach(() => {
    coreApi = createCoreApiMock()
    svc = new SecretService(coreApi as unknown as k8s.CoreV1Api, 'test-ns')
  })

  const writeOps: ReadonlyArray<{
    name: string
    call: (annotations: Record<string, string>) => Promise<unknown>
    apiSurface: (keyof CoreApiMock)[]
  }> = [
    {
      name: 'createSecret',
      call: annotations =>
        svc.createSecret({ name: 's', namespace: 'test-ns', annotations, stringData: { k: 'v' } }),
      apiSurface: ['createNamespacedSecret'],
    },
    {
      name: 'updateSecret',
      call: annotations =>
        svc.updateSecret({ name: 's', namespace: 'test-ns', annotations, stringData: { k: 'v' } }),
      apiSurface: ['readNamespacedSecret', 'replaceNamespacedSecret'],
    },
  ]

  for (const op of writeOps) {
    describe(op.name, () => {
      for (const badKey of DANGEROUS_ANNOTATION_KEYS) {
        it(`rejects annotation "${badKey}" with a 400 and never calls the apiserver`, async () => {
          const err = await op.call({ [badKey]: 'value' }).then(
            () => {
              throw new Error('expected the write to reject')
            },
            (e: unknown) => e
          )
          expect(err).toBeInstanceOf(DangerousAnnotationError)
          expect((err as DangerousAnnotationError).status).toBe(400)
          for (const surface of op.apiSurface) {
            expect(coreApi[surface]).not.toHaveBeenCalled()
          }
        })
      }

      for (const safeKey of SAFE_ANNOTATION_KEYS) {
        it(`lets safe annotation "${safeKey}" through to the apiserver`, async () => {
          await op.call({ [safeKey]: 'value' })
          const writeSurface = op.apiSurface[op.apiSurface.length - 1]
          expect(coreApi[writeSurface]).toHaveBeenCalledOnce()
        })
      }
    })
  }

  it('allows omitted annotations', async () => {
    await svc.createSecret({ name: 's', namespace: 'test-ns', stringData: { k: 'v' } })
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledOnce()
  })
})

describe('SecretService — platform annotations (clerum.io/) blocked by default, allowed with opt-out', () => {
  let coreApi: CoreApiMock
  let svc: SecretService

  beforeEach(() => {
    coreApi = createCoreApiMock()
    svc = new SecretService(coreApi as unknown as k8s.CoreV1Api, 'test-ns')
  })

  for (const platformKey of PLATFORM_ANNOTATION_KEYS) {
    it(`rejects "${platformKey}" by default (no opts)`, async () => {
      const err = await svc
        .createSecret({
          name: 's',
          namespace: 'test-ns',
          annotations: { [platformKey]: 'v' },
          stringData: { k: 'v' },
        })
        .then(
          () => {
            throw new Error('expected rejection')
          },
          (e: unknown) => e
        )
      expect(err).toBeInstanceOf(DangerousAnnotationError)
      expect((err as DangerousAnnotationError).status).toBe(400)
      expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
    })

    it(`allows "${platformKey}" with allowPlatformAnnotations: true`, async () => {
      await svc.createSecret(
        {
          name: 's',
          namespace: 'test-ns',
          annotations: { [platformKey]: 'v' },
          stringData: { k: 'v' },
        },
        { allowPlatformAnnotations: true }
      )
      expect(coreApi.createNamespacedSecret).toHaveBeenCalledOnce()
    })
  }

  it('still blocks infra annotations even with allowPlatformAnnotations: true', async () => {
    const err = await svc
      .createSecret(
        {
          name: 's',
          namespace: 'test-ns',
          annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
          stringData: { k: 'v' },
        },
        { allowPlatformAnnotations: true }
      )
      .then(
        () => {
          throw new Error('expected rejection')
        },
        (e: unknown) => e
      )
    expect(err).toBeInstanceOf(DangerousAnnotationError)
    expect((err as DangerousAnnotationError).status).toBe(400)
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
  })

  it('rejects a mixed payload containing both safe and platform keys (without opt-out)', async () => {
    const err = await svc
      .createSecret({
        name: 's',
        namespace: 'test-ns',
        annotations: { 'my-custom-annotation': 'ok', 'clerum.io/catalog-id': 'bad' },
        stringData: { k: 'v' },
      })
      .then(
        () => {
          throw new Error('expected rejection')
        },
        (e: unknown) => e
      )
    expect(err).toBeInstanceOf(DangerousAnnotationError)
    expect((err as DangerousAnnotationError).annotationKey).toBe('clerum.io/catalog-id')
  })

  it('allows a mixed payload of safe + platform keys with allowPlatformAnnotations: true', async () => {
    await svc.createSecret(
      {
        name: 's',
        namespace: 'test-ns',
        annotations: {
          'my-custom-annotation': 'ok',
          'clerum.io/catalog-id': 'c1',
          'clerum.io/catalog-version': 'v2',
        },
        stringData: { k: 'v' },
      },
      { allowPlatformAnnotations: true }
    )
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledOnce()
  })

  it('rejects combined vector: forbidden type + platform annotation in one request', async () => {
    const err = await svc
      .createSecret({
        name: 's',
        namespace: 'test-ns',
        type: 'kubernetes.io/service-account-token',
        annotations: { 'clerum.io/owner': 'attacker' },
        stringData: { k: 'v' },
      })
      .then(
        () => {
          throw new Error('expected rejection')
        },
        (e: unknown) => e
      )
    expect(err).toBeInstanceOf(InvalidSecretTypeError)
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
  })

  it('opt-out propagates through updateSecret', async () => {
    await svc.updateSecret(
      {
        name: 's',
        namespace: 'test-ns',
        annotations: { 'clerum.io/catalog-id': 'c1' },
        stringData: { k: 'v' },
      },
      { allowPlatformAnnotations: true }
    )
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledOnce()
  })
})

describe('invalidSecretTypeReason — the shared rule', () => {
  it('accepts every allowed type', () => {
    for (const type of ALLOWED_SECRET_TYPES) {
      expect(invalidSecretTypeReason(type)).toBeNull()
    }
  })

  it('rejects every forbidden type with an actionable message', () => {
    for (const type of FORBIDDEN_SECRET_TYPES) {
      const reason = invalidSecretTypeReason(type)
      expect(reason).not.toBeNull()
      expect(reason).toContain('is not allowed')
    }
  })
})

describe('dangerousAnnotationKeyReason — the shared rule', () => {
  it('accepts safe annotation keys', () => {
    for (const key of SAFE_ANNOTATION_KEYS) {
      expect(dangerousAnnotationKeyReason(key)).toBeNull()
    }
  })

  it('rejects dangerous annotation keys with an actionable message', () => {
    for (const key of DANGEROUS_ANNOTATION_KEYS) {
      const reason = dangerousAnnotationKeyReason(key)
      expect(reason).not.toBeNull()
      expect(reason).toContain('is not allowed')
    }
  })

  it('rejects platform annotation keys by default (no opts)', () => {
    for (const key of PLATFORM_ANNOTATION_KEYS) {
      const reason = dangerousAnnotationKeyReason(key)
      expect(reason).not.toBeNull()
      expect(reason).toContain('is not allowed')
    }
  })

  it('accepts platform annotation keys with allowPlatformAnnotations: true', () => {
    for (const key of PLATFORM_ANNOTATION_KEYS) {
      expect(dangerousAnnotationKeyReason(key, { allowPlatformAnnotations: true })).toBeNull()
    }
  })

  it('still rejects infra keys even with allowPlatformAnnotations: true', () => {
    for (const key of DANGEROUS_ANNOTATION_KEYS) {
      const reason = dangerousAnnotationKeyReason(key, { allowPlatformAnnotations: true })
      expect(reason).not.toBeNull()
      expect(reason).toContain('is not allowed')
    }
  })
})

describe('stripBlockedAnnotationKeys — snapshot sanitization for rollback', () => {
  it('returns undefined for undefined input', () => {
    expect(stripBlockedAnnotationKeys(undefined)).toBeUndefined()
  })

  it('returns {} for empty object (truthy but no entries)', () => {
    expect(stripBlockedAnnotationKeys({})).toEqual({})
  })

  it('returns {} when all keys are blocked', () => {
    const annotations = {
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
      'kubernetes.io/service-account.name': 'default',
    }
    expect(stripBlockedAnnotationKeys(annotations)).toEqual({})
  })

  it('strips infra-prefixed keys and keeps safe keys', () => {
    const annotations = {
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
      'app.example.com/version': '1.0',
      'my-annotation': 'value',
    }
    expect(stripBlockedAnnotationKeys(annotations)).toEqual({
      'app.example.com/version': '1.0',
      'my-annotation': 'value',
    })
  })

  it('strips both infra and platform keys by default', () => {
    const annotations = {
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
      'clerum.io/catalog-id': '@clerum/slack',
      'safe-key': 'val',
    }
    expect(stripBlockedAnnotationKeys(annotations)).toEqual({
      'safe-key': 'val',
    })
  })

  it('keeps platform keys when allowPlatformAnnotations is true', () => {
    const annotations = {
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
      'clerum.io/catalog-id': '@clerum/slack',
      'safe-key': 'val',
    }
    expect(stripBlockedAnnotationKeys(annotations, { allowPlatformAnnotations: true })).toEqual({
      'clerum.io/catalog-id': '@clerum/slack',
      'safe-key': 'val',
    })
  })

  it('still strips infra keys even with allowPlatformAnnotations', () => {
    const annotations = {
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
      'kubernetes.io/service-account.name': 'default',
      'clerum.io/catalog-version': '2.0',
    }
    const result = stripBlockedAnnotationKeys(annotations, {
      allowPlatformAnnotations: true,
    })
    expect(result).toEqual({ 'clerum.io/catalog-version': '2.0' })
  })

  it('returns all keys unchanged when none are blocked', () => {
    const annotations = {
      'app.example.com/version': '1.0',
      'my-annotation': 'value',
    }
    expect(stripBlockedAnnotationKeys(annotations)).toEqual(annotations)
  })
})

// The {} vs undefined distinction is a load-bearing contract: {} means "caller
// wants zero annotations" while undefined means "caller didn't provide
// annotations". Collapsing {} to undefined would silently turn an explicit
// clear into a no-op.
describe('stripBlockedAnnotationKeys — edge cases', () => {
  it('returns {} for an empty annotations object (never collapses to undefined)', () => {
    expect(stripBlockedAnnotationKeys({})).toEqual({})
  })

  it('returns undefined for undefined input', () => {
    expect(stripBlockedAnnotationKeys(undefined)).toBeUndefined()
  })

  it('returns {} when all keys are blocked', () => {
    expect(
      stripBlockedAnnotationKeys({
        'kubectl.kubernetes.io/last-applied-configuration': '{}',
        'kubernetes.io/service-account.name': 'default',
      })
    ).toEqual({})
  })

  it('strips only blocked keys, preserves safe keys', () => {
    expect(
      stripBlockedAnnotationKeys({
        'kubectl.kubernetes.io/last-applied-configuration': '{}',
        'my-custom-annotation': 'keep-me',
      })
    ).toEqual({ 'my-custom-annotation': 'keep-me' })
  })
})

describe('extractHttpStatus — .status property', () => {
  it('reads a top-level .status number', () => {
    expect(extractHttpStatus({ status: 409 })).toBe(409)
  })

  it('prefers .statusCode over .status', () => {
    expect(extractHttpStatus({ statusCode: 404, status: 500 })).toBe(404)
  })

  it('returns null for non-numeric .status', () => {
    expect(extractHttpStatus({ status: 'Failure' })).toBeNull()
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
