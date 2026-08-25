import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { extractHttpStatus } from '../src/k8s.js'
import {
  ALLOWED_SECRET_TYPES,
  DangerousAnnotationError,
  InvalidSecretTypeError,
  REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS,
  dangerousAnnotationKeyReason,
  invalidSecretTypeReason,
  resolveSecretAnnotationsForReplace,
} from '../src/services/secretConstraints.js'
import {
  InvalidSecretKeyError,
  SECRET_DATA_KEY_MAX_LENGTH,
  invalidSecretDataKeyReason,
} from '../src/services/secretKeys.js'
import { SecretService } from '../src/services/secretService.js'

// SECURITY (names-only write boundary): the k8s API returns the FULL Secret from
// create/replace/patch — its `.data` carries the base64 VALUES of every key,
// including keys the caller never sent (merge-patch returns the merged whole).
// SecretService's write ops MUST NOT surface those values to callers; they return
// a `{name, namespace, keys}` summary so no admin route can leak values by echoing
// the return. `getSecret` deliberately stays full-fat (internal consumers need
// `.data`) and is not covered here. These tests go RED if any write op returns the
// raw k8s Secret again.

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

// A fully-populated V1Secret as the k8s apiserver would return it from a write:
// metadata + type + `.data` with base64 values for EVERY stored key.
function fullSecret(
  name: string,
  namespace: string,
  data: Record<string, string>
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace, resourceVersion: '42', uid: 'uid-1' },
    type: 'Opaque',
    data,
  }
}

// The secret values that must NEVER appear in any write-op return value.
const SENT_VALUE = b64('sk-caller-sent')
const OTHER_VALUE = b64('xoxb-not-sent-by-caller')
const RETURNED = fullSecret('cc-foo-credentials', 'channels', {
  'telegram-bot-token': SENT_VALUE,
  // A key the caller did NOT send — merge-patch echoes the merged whole.
  'slack-bot-token': OTHER_VALUE,
})

function makeCoreApi(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    createNamespacedSecret: vi.fn(async () => RETURNED),
    readNamespacedSecret: vi.fn(async () => RETURNED),
    replaceNamespacedSecret: vi.fn(async () => RETURNED),
    patchNamespacedSecret: vi.fn(async () => RETURNED),
    deleteNamespacedSecret: vi.fn(async () => ({ kind: 'Status', status: 'Success' })),
  }
}

function makeService(): { svc: SecretService; core: Record<string, ReturnType<typeof vi.fn>> } {
  const core = makeCoreApi()
  const svc = new SecretService(core as never, 'default-ns')
  return { svc, core }
}

// Asserts a write-op result is names-only: exact shape + no value at any depth.
function expectNamesOnly(result: unknown, name: string, namespace: string, keys: string[]): void {
  expect(result).toEqual({ name, namespace, keys })
  const serialized = JSON.stringify(result)
  for (const needle of [SENT_VALUE, OTHER_VALUE, 'sk-caller-sent', 'xoxb-not-sent-by-caller']) {
    expect(serialized).not.toContain(needle)
  }
  // Defensive: no `.data` field survived.
  expect((result as { data?: unknown }).data).toBeUndefined()
}

describe('SecretService — write ops return names-only summaries (no secret values)', () => {
  it('createSecret returns {name, namespace, keys}, never the Secret .data', async () => {
    const { svc } = makeService()
    const result = await svc.createSecret({
      name: 'cc-foo-credentials',
      namespace: 'channels',
      type: 'Opaque',
      stringData: { 'telegram-bot-token': 'plaintext' },
    })
    // keys come from the returned Secret's data (sorted), never the values.
    expectNamesOnly(result, 'cc-foo-credentials', 'channels', [
      'slack-bot-token',
      'telegram-bot-token',
    ])
  })

  it('updateSecret (full-replace) returns names-only', async () => {
    const { svc } = makeService()
    const result = await svc.updateSecret({
      name: 'cc-foo-credentials',
      namespace: 'channels',
      type: 'Opaque',
      stringData: { 'telegram-bot-token': 'plaintext' },
    })
    expectNamesOnly(result, 'cc-foo-credentials', 'channels', [
      'slack-bot-token',
      'telegram-bot-token',
    ])
  })

  it('mergeSecret returns names-only INCLUDING keys the caller did not send', async () => {
    const { svc } = makeService()
    const result = await svc.mergeSecret({
      name: 'cc-foo-credentials',
      namespace: 'channels',
      type: 'Opaque',
      stringData: { 'telegram-bot-token': 'plaintext' },
    })
    // The merged Secret carries slack-bot-token too; only its NAME may surface.
    expectNamesOnly(result, 'cc-foo-credentials', 'channels', [
      'slack-bot-token',
      'telegram-bot-token',
    ])
  })

  it('removeSecretKey returns names-only (post-removal keyset, value never surfaced)', async () => {
    const { svc, core } = makeService()
    // Realistic post-removal merge-patch response: the removed key is gone; only
    // the surviving key remains (still base64 in the raw k8s response).
    core.patchNamespacedSecret.mockResolvedValueOnce(
      fullSecret('cc-foo-credentials', 'channels', { 'slack-bot-token': OTHER_VALUE })
    )
    const result = await svc.removeSecretKey({
      name: 'cc-foo-credentials',
      namespace: 'channels',
      key: 'telegram-bot-token',
    })
    expectNamesOnly(result, 'cc-foo-credentials', 'channels', ['slack-bot-token'])
  })

  it('deleteSecret returns {name, namespace, deleted:true}, never a Secret body', async () => {
    const { svc } = makeService()
    const result = await svc.deleteSecret('cc-foo-credentials', 'channels')
    expect(result).toEqual({ name: 'cc-foo-credentials', namespace: 'channels', deleted: true })
    expect((result as { data?: unknown }).data).toBeUndefined()
  })

  it('deleteSecret fails loud: a k8s delete error propagates (never a synthetic success)', async () => {
    const { svc, core } = makeService()
    core.deleteNamespacedSecret.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 })
    )
    // The synthetic {deleted:true} must be reachable ONLY after a successful k8s
    // delete — a failure must reject, not be swallowed into a fake success.
    await expect(svc.deleteSecret('cc-foo-credentials', 'channels')).rejects.toThrow('forbidden')
  })

  it('namespace falls back to the service default when omitted', async () => {
    const { svc } = makeService()
    const result = (await svc.createSecret({
      name: 'x',
      type: 'Opaque',
      stringData: { k: 'v' },
    })) as { namespace: string }
    expect(result.namespace).toBe('default-ns')
  })

  it('summarizeSecret handles k8s returning a Secret with .data undefined (empty Secret)', async () => {
    const { svc, core } = makeService()
    core.createNamespacedSecret.mockResolvedValueOnce({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'empty-sec', namespace: 'ns' },
      type: 'Opaque',
    })
    const result = await svc.createSecret({
      name: 'empty-sec',
      namespace: 'ns',
      type: 'Opaque',
      stringData: { k: 'v' },
    })
    expect(result).toEqual({ name: 'empty-sec', namespace: 'ns', keys: [] })
  })

  it('summarizeSecret handles k8s returning a Secret with .data as empty object', async () => {
    const { svc, core } = makeService()
    core.createNamespacedSecret.mockResolvedValueOnce({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'empty-data', namespace: 'ns' },
      type: 'Opaque',
      data: {},
    })
    const result = await svc.createSecret({
      name: 'empty-data',
      namespace: 'ns',
      type: 'Opaque',
      stringData: { k: 'v' },
    })
    expect(result).toEqual({ name: 'empty-data', namespace: 'ns', keys: [] })
  })

  it('summarizeSecret handles k8s returning a Secret with .data as null', async () => {
    const { svc, core } = makeService()
    core.createNamespacedSecret.mockResolvedValueOnce({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'null-data', namespace: 'ns' },
      type: 'Opaque',
      data: null,
    })
    const result = await svc.createSecret({
      name: 'null-data',
      namespace: 'ns',
      type: 'Opaque',
      stringData: { k: 'v' },
    })
    expect(result).toEqual({ name: 'null-data', namespace: 'ns', keys: [] })
  })

  it('summarizeSecret handles k8s returning null/undefined result', async () => {
    const { svc, core } = makeService()
    core.createNamespacedSecret.mockResolvedValueOnce(null)
    const result = await svc.createSecret({
      name: 'null-result',
      namespace: 'ns',
      type: 'Opaque',
      stringData: { k: 'v' },
    })
    expect(result).toEqual({ name: 'null-result', namespace: 'ns', keys: [] })
  })
})

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
  listNamespacedSecret: ReturnType<typeof vi.fn>
  readNamespacedSecret: ReturnType<typeof vi.fn>
  createNamespacedSecret: ReturnType<typeof vi.fn>
  replaceNamespacedSecret: ReturnType<typeof vi.fn>
  patchNamespacedSecret: ReturnType<typeof vi.fn>
  deleteNamespacedSecret: ReturnType<typeof vi.fn>
}

function createCoreApiMock(): CoreApiMock {
  return {
    listNamespacedSecret: vi.fn().mockResolvedValue({ items: [] }),
    readNamespacedSecret: vi.fn().mockResolvedValue({ metadata: {}, type: 'Opaque', data: {} }),
    createNamespacedSecret: vi.fn().mockResolvedValue({
      metadata: { name: 's', namespace: 'test-ns', uid: 'uid-s', resourceVersion: '2' },
    }),
    replaceNamespacedSecret: vi.fn().mockResolvedValue({
      metadata: { name: 's', namespace: 'test-ns', uid: 'uid-s', resourceVersion: '2' },
    }),
    patchNamespacedSecret: vi.fn().mockResolvedValue({
      metadata: { name: 's', namespace: 'test-ns', uid: 'uid-s', resourceVersion: '2' },
    }),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
  }
}

const SENT_SECRET_VALUE = Buffer.from('caller-sent-value', 'utf8').toString('base64')
const ADJACENT_SECRET_VALUE = Buffer.from('adjacent-owner-value', 'utf8').toString('base64')
const RAW_WRITE_RESULT: k8s.V1Secret = {
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: {
    name: 'credentials',
    namespace: 'channels',
    resourceVersion: '42',
    uid: 'uid-1',
  },
  type: 'Opaque',
  data: {
    'caller-key': SENT_SECRET_VALUE,
    'adjacent-owner-key': ADJACENT_SECRET_VALUE,
  },
}

function expectSecretSummaryNamesOnly(
  result: unknown,
  expected: { name: string; namespace: string; keys: string[] }
): void {
  expect(result).toEqual(expected)
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain(SENT_SECRET_VALUE)
  expect(serialized).not.toContain(ADJACENT_SECRET_VALUE)
  expect(result).not.toHaveProperty('data')
  expect(result).not.toHaveProperty('stringData')
}

describe('SecretService — write responses are names-only', () => {
  let coreApi: CoreApiMock
  let svc: SecretService

  beforeEach(() => {
    coreApi = createCoreApiMock()
    coreApi.createNamespacedSecret.mockResolvedValue(RAW_WRITE_RESULT)
    coreApi.readNamespacedSecret.mockResolvedValue(RAW_WRITE_RESULT)
    coreApi.replaceNamespacedSecret.mockResolvedValue(RAW_WRITE_RESULT)
    coreApi.patchNamespacedSecret.mockResolvedValue(RAW_WRITE_RESULT)
    svc = new SecretService(coreApi as unknown as k8s.CoreV1Api, 'default-ns')
  })

  it.each([
    [
      'createSecret',
      () =>
        svc.createSecret({
          name: 'credentials',
          namespace: 'channels',
          stringData: { 'caller-key': 'caller-sent-value' },
        }),
    ],
    [
      'updateSecret',
      () =>
        svc.updateSecret({
          name: 'credentials',
          namespace: 'channels',
          stringData: { 'caller-key': 'caller-sent-value' },
        }),
    ],
    [
      'mergeSecret',
      () =>
        svc.mergeSecret({
          name: 'credentials',
          namespace: 'channels',
          stringData: { 'caller-key': 'caller-sent-value' },
        }),
    ],
    [
      'removeSecretKey',
      () =>
        svc.removeSecretKey({
          name: 'credentials',
          namespace: 'channels',
          key: 'caller-key',
        }),
    ],
  ])('%s returns only identity and sorted key names', async (_operation, invoke) => {
    const result = await invoke()
    expectSecretSummaryNamesOnly(result, {
      name: 'credentials',
      namespace: 'channels',
      keys: ['adjacent-owner-key', 'caller-key'],
    })
  })

  it('uses the default namespace in the write summary', async () => {
    coreApi.createNamespacedSecret.mockResolvedValue({
      ...RAW_WRITE_RESULT,
      metadata: { ...RAW_WRITE_RESULT.metadata, namespace: 'default-ns' },
    })
    const result = await svc.createSecret({
      name: 'credentials',
      stringData: { 'caller-key': 'caller-sent-value' },
    })
    expect((result as { namespace: string }).namespace).toBe('default-ns')
  })

  it('returns a names-only delete acknowledgement after the apiserver succeeds', async () => {
    const result = await svc.deleteSecret('credentials', 'channels', {
      uid: 'uid-1',
      resourceVersion: '42',
    })
    expect(result).toEqual({ name: 'credentials', namespace: 'channels', deleted: true })
    expect(coreApi.deleteNamespacedSecret.mock.calls[0][0].body.preconditions).toEqual({
      uid: 'uid-1',
      resourceVersion: '42',
    })
  })

  it('propagates delete failures instead of synthesizing success', async () => {
    coreApi.deleteNamespacedSecret.mockRejectedValueOnce(new Error('delete rejected'))
    await expect(svc.deleteSecret('credentials', 'channels')).rejects.toThrow('delete rejected')
  })

  it('preserves metadata annotations while omitting Secret values from the list projection', async () => {
    coreApi.listNamespacedSecret.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'credentials',
            namespace: 'channels',
            labels: { owner: 'platform' },
            annotations: { 'example.invalid/private': 'do-not-return' },
          },
          type: 'Opaque',
          data: { 'caller-key': SENT_SECRET_VALUE },
        },
      ],
    })

    const result = await svc.listSecrets('channels')
    expect(result).toEqual([
      {
        metadata: {
          name: 'credentials',
          namespace: 'channels',
          labels: { owner: 'platform' },
          annotations: { 'example.invalid/private': 'do-not-return' },
        },
        type: 'Opaque',
        keys: ['caller-key'],
      },
    ])
  })
})

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

// Platform-prefix annotation keys — blocked by default, allowed only by an exact capability.
const PLATFORM_ANNOTATION_KEYS: readonly string[] = [
  'clerum.io/catalog-id',
  'clerum.io/catalog-version',
  'clerum.io/trust-level',
]
const UNAUTHORIZED_PLATFORM_ANNOTATION_KEYS: readonly string[] = ['clerum.io/owner']

// Annotation keys that are safe and must pass through without any opt-out.
const SAFE_ANNOTATION_KEYS: readonly string[] = [
  'app.kubernetes.io/managed-by',
  'my-custom-annotation',
  'custom.example.com/owner',
]

/**
 * The preconditions are only worth anything if they reach the apiserver in the shape it
 * enforces. Every other test of this feature asserts that the CALLER passes a precondition;
 * these assert that passing one changes the actual request. Get the translation wrong —
 * resourceVersion on the wrong field, delete preconditions omitted — and the whole
 * ownership-bound write silently degrades to last-writer-wins with every test still green.
 */
describe('SecretService — ownership-bound mutations', () => {
  let coreApi: CoreApiMock
  let svc: SecretService

  beforeEach(() => {
    coreApi = createCoreApiMock()
    svc = new SecretService(coreApi as unknown as k8s.CoreV1Api, 'test-ns')
  })

  it('sends the CALLER’s resourceVersion on a replace after reading protected metadata', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { resourceVersion: '999' },
      type: 'Opaque',
      data: {},
    })

    await svc.updateSecret(
      { name: 's', namespace: 'ns', type: 'Opaque', data: { k: 'dg==' } },
      { resourceVersion: '42', uid: 'uid-1' }
    )

    // The caller's version remains the CAS boundary even though the service reads the
    // current metadata first to avoid dropping protected annotations.
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledOnce()
    const body = coreApi.replaceNamespacedSecret.mock.calls[0][0].body
    expect(body.metadata.resourceVersion).toBe('42')
    expect(body.metadata.uid).toBe('uid-1')
  })

  it('returns the server-confirmed identity from replace', async () => {
    coreApi.replaceNamespacedSecret.mockResolvedValueOnce({
      metadata: {
        name: 's',
        namespace: 'ns',
        uid: 'uid-server',
        resourceVersion: '43',
      },
      type: 'Opaque',
      data: {},
    })

    const result = await svc.updateSecretSnapshot(
      { name: 's', namespace: 'ns', type: 'Opaque', data: { k: 'dg==' } },
      { resourceVersion: '42', uid: 'uid-server' }
    )

    expect(result).toMatchObject({
      name: 's',
      namespace: 'ns',
      uid: 'uid-server',
      resourceVersion: '43',
    })
  })

  it('always carries an explicit identity precondition in a merge patch', async () => {
    await svc.mergeSecret({ name: 's', namespace: 'ns', stringData: { k: 'rotated' } }, undefined, {
      uid: 'uid-1',
      resourceVersion: '42',
    })

    const body = coreApi.patchNamespacedSecret.mock.calls[0][0].body
    expect(body.metadata).toEqual({ uid: 'uid-1', resourceVersion: '42' })
  })

  it('can fence a data-only merge by UID without reintroducing a resourceVersion CAS', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { uid: 'uid-1', resourceVersion: '42' },
      type: 'Opaque',
      data: {},
    })

    await svc.mergeSecret({ name: 's', namespace: 'ns', stringData: { k: 'rotated' } }, undefined, {
      uid: 'uid-1',
    })

    const body = coreApi.patchNamespacedSecret.mock.calls[0][0].body
    expect(body.metadata).toEqual({ uid: 'uid-1' })
    expect(body).not.toHaveProperty('metadata.resourceVersion')
  })

  it('does not turn an unconditioned multi-owner merge into an implicit CAS', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { resourceVersion: '999' },
      type: 'Opaque',
      data: {},
    })

    await svc.mergeSecret({ name: 's', namespace: 'ns', stringData: { k: 'rotated' } })

    expect(coreApi.patchNamespacedSecret.mock.calls[0][0].body).not.toHaveProperty(
      'metadata.resourceVersion'
    )
  })

  it('does not turn an unconditioned key removal into an implicit CAS', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { resourceVersion: '999' },
      type: 'Opaque',
      data: {},
    })

    await svc.removeSecretKey({ name: 's', namespace: 'ns', key: 'API_KEY' })

    expect(coreApi.patchNamespacedSecret.mock.calls[0][0].body).not.toHaveProperty(
      'metadata.resourceVersion'
    )
  })

  it('keeps last-writer-wins when no precondition is given', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { resourceVersion: '999' },
      type: 'Opaque',
      data: {},
    })

    await svc.updateSecret({ name: 's', namespace: 'ns', data: { k: 'dg==' } })

    // Unchanged for the admin /secrets routes and token rotation, which are single-owner
    // writers and want the current version.
    expect(coreApi.readNamespacedSecret).toHaveBeenCalled()
    const body = coreApi.replaceNamespacedSecret.mock.calls[0][0].body
    expect(body.metadata.resourceVersion).toBe('999')
    expect(body.metadata.uid).toBeUndefined()
  })

  it('sends delete preconditions so the apiserver refuses to delete a replacement', async () => {
    await svc.deleteSecret('s', 'ns', { uid: 'uid-1', resourceVersion: '42' })

    const req = coreApi.deleteNamespacedSecret.mock.calls[0][0]
    expect(req.body.preconditions).toEqual({ uid: 'uid-1', resourceVersion: '42' })
  })

  it('sends no delete body at all when no precondition is given', async () => {
    await svc.deleteSecret('s', 'ns')

    // An empty `preconditions: {}` is not the same as none — keep the historical request
    // shape for callers that never opted in.
    expect(coreApi.deleteNamespacedSecret.mock.calls[0][0].body).toBeUndefined()
  })
})

describe('SecretService — preserved Secret state is constrained before mutation', () => {
  let coreApi: CoreApiMock
  let svc: SecretService

  beforeEach(() => {
    coreApi = createCoreApiMock()
    svc = new SecretService(coreApi as unknown as k8s.CoreV1Api, 'test-ns')
  })

  it('preserves legacy infrastructure metadata during a data-only update', async () => {
    const legacyApplyKey = DANGEROUS_ANNOTATION_KEYS[0]
    const annotations = { [legacyApplyKey]: 'legacy-configuration' }
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { annotations, uid: 'uid-existing', resourceVersion: '7' },
      type: 'Opaque',
    })

    await svc.updateSecret({
      name: 's',
      namespace: 'test-ns',
      stringData: { [VALID_KEYS[0]]: 'rotated' },
    })

    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledOnce()
    expect(coreApi.replaceNamespacedSecret.mock.calls[0][0].body.metadata.annotations).toEqual(
      annotations
    )
  })

  it('does not let an explicit annotation replacement drop existing infrastructure metadata', async () => {
    const legacyApplyKey = DANGEROUS_ANNOTATION_KEYS[0]
    const annotations = { [legacyApplyKey]: 'legacy-configuration' }
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { annotations, uid: 'uid-existing', resourceVersion: '7' },
      type: 'Opaque',
    })

    await svc.updateSecret({
      name: 's',
      namespace: 'test-ns',
      annotations: { 'my-custom-annotation': 'replacement' },
      stringData: { [VALID_KEYS[0]]: 'rotated' },
    })

    expect(coreApi.replaceNamespacedSecret.mock.calls[0][0].body.metadata.annotations).toEqual({
      ...annotations,
      'my-custom-annotation': 'replacement',
    })
  })

  it('does not let a preconditioned replacement drop existing infrastructure metadata', async () => {
    const legacyApplyKey = DANGEROUS_ANNOTATION_KEYS[0]
    const annotations = { [legacyApplyKey]: 'legacy-configuration' }
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { annotations, uid: 'uid-existing', resourceVersion: '7' },
      type: 'Opaque',
    })

    await svc.updateSecret(
      {
        name: 's',
        namespace: 'test-ns',
        annotations: {},
        type: 'Opaque',
        stringData: { [VALID_KEYS[0]]: 'rotated' },
      },
      { uid: 'uid-existing', resourceVersion: '7' }
    )

    expect(coreApi.replaceNamespacedSecret.mock.calls[0][0].body.metadata.annotations).toEqual(
      annotations
    )
  })

  it('preserves legacy infrastructure metadata during a data-only merge', async () => {
    const legacyApplyKey = DANGEROUS_ANNOTATION_KEYS[0]
    const annotations = { [legacyApplyKey]: 'legacy-configuration' }
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { annotations, resourceVersion: '11' },
      type: 'Opaque',
    })

    await svc.mergeSecret({
      name: 's',
      namespace: 'test-ns',
      stringData: { [VALID_KEYS[0]]: 'rotated' },
    })

    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledOnce()
    expect(coreApi.patchNamespacedSecret.mock.calls[0][0].body).not.toHaveProperty(
      'metadata.annotations'
    )
  })

  it('preserves legacy infrastructure metadata during key removal', async () => {
    const legacyReleaseKey = DANGEROUS_ANNOTATION_KEYS[4]
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { annotations: { [legacyReleaseKey]: 'evenfire' }, resourceVersion: '13' },
      type: 'Opaque',
    })

    await svc.removeSecretKey({ name: 's', namespace: 'test-ns', key: VALID_KEYS[0] })

    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledOnce()
    expect(coreApi.patchNamespacedSecret.mock.calls[0][0].body.data).toEqual({
      [VALID_KEYS[0]]: null,
    })
  })

  it('rejects update when an omitted type preserves a forbidden existing type', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: {},
      type: 'kubernetes.io/service-account-token',
    })

    await expect(
      svc.updateSecret({ name: 's', namespace: 'test-ns', stringData: { k: 'v' } })
    ).rejects.toBeInstanceOf(InvalidSecretTypeError)
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  it('allows update when omitted annotations preserve infrastructure metadata', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { annotations: { 'meta.helm.sh/release-name': 'release' } },
      type: 'Opaque',
    })

    await expect(
      svc.updateSecret({ name: 's', namespace: 'test-ns', stringData: { k: 'v' } })
    ).resolves.toMatchObject({ name: 's', namespace: 'test-ns' })
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledOnce()
  })

  it('rejects merge when the preserved existing type is forbidden', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: {},
      type: 'kubernetes.io/ssh-auth',
    })

    await expect(
      svc.mergeSecret({ name: 's', namespace: 'test-ns', stringData: { k: 'v' } })
    ).rejects.toBeInstanceOf(InvalidSecretTypeError)
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled()
  })

  it('preserves unknown platform metadata without locking data-only rotation', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { annotations: { 'clerum.io/catalog-id': 'legacy-only' } },
      type: 'Opaque',
    })

    await expect(
      svc.mergeSecret({ name: 's', namespace: 'test-ns', stringData: { k: 'v' } })
    ).resolves.toMatchObject({ name: 's', namespace: 'test-ns' })
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledOnce()
  })

  it('allows key removal when the preserved existing annotations are infrastructure metadata', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': 'now' } },
      type: 'Opaque',
    })

    await expect(
      svc.removeSecretKey({ name: 's', namespace: 'test-ns', key: 'API_KEY' })
    ).resolves.toMatchObject({ name: 's', namespace: 'test-ns' })
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledOnce()
  })
})

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

    it(`allows "${platformKey}" with the registryCredential capability`, async () => {
      await svc.createSecret(
        {
          name: 's',
          namespace: 'test-ns',
          annotations: { [platformKey]: 'v' },
          stringData: { k: 'v' },
        },
        { capability: 'registryCredential' }
      )
      expect(coreApi.createNamespacedSecret).toHaveBeenCalledOnce()
    })
  }

  it('still blocks infra annotations even with the registryCredential capability', async () => {
    const err = await svc
      .createSecret(
        {
          name: 's',
          namespace: 'test-ns',
          annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
          stringData: { k: 'v' },
        },
        { capability: 'registryCredential' }
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

  it('rejects platform keys outside the registryCredential capability', async () => {
    for (const key of UNAUTHORIZED_PLATFORM_ANNOTATION_KEYS) {
      await expect(
        svc.createSecret(
          {
            name: 's',
            namespace: 'test-ns',
            annotations: { [key]: 'v' },
            stringData: { k: 'v' },
          },
          { capability: 'registryCredential' }
        )
      ).rejects.toBeInstanceOf(DangerousAnnotationError)
    }
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

  it('allows a mixed payload of safe + registry-owned keys with the registryCredential capability', async () => {
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
      { capability: 'registryCredential' }
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
      undefined,
      { capability: 'registryCredential' }
    )
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledOnce()
  })

  it('does not let an internal capability introduce new infrastructure metadata', async () => {
    const legacyApplyKey = DANGEROUS_ANNOTATION_KEYS[0]
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { annotations: {}, resourceVersion: '7' },
      type: 'Opaque',
    })

    await expect(
      svc.updateSecret(
        {
          name: 's',
          namespace: 'test-ns',
          annotations: { [legacyApplyKey]: 'new-value' },
          stringData: { [VALID_KEYS[0]]: 'v' },
        },
        undefined,
        { capability: 'registryCredential' }
      )
    ).rejects.toBeInstanceOf(DangerousAnnotationError)
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  it('allows MCP rotation to preserve only the Registry catalog annotation pair', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: {
        annotations: {
          'clerum.io/catalog-id': 'linear',
          'clerum.io/catalog-version': '1.0.0',
        },
      },
      type: 'Opaque',
    })

    await svc.mergeSecret(
      {
        name: 'linear-credentials',
        namespace: 'test-ns',
        stringData: { [VALID_KEYS[0]]: 'rotated' },
      },
      { allowExistingPlatformAnnotationKeys: REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS }
    )

    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledOnce()
  })

  it('allows the internal Registry capability to update trust metadata', async () => {
    await svc.updateSecret(
      {
        name: 'registry-credentials',
        namespace: 'test-ns',
        annotations: { 'clerum.io/trust-level': 'low' },
        stringData: { [VALID_KEYS[0]]: 'rotated' },
      },
      undefined,
      { capability: 'registryCredential' }
    )
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledOnce()
  })

  it('preserves unrelated Registry metadata during a data-only public rotation', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: {
        annotations: {
          'clerum.io/catalog-id': 'linear',
          'clerum.io/catalog-version': '1.0.0',
          'clerum.io/trust-level': 'low',
        },
      },
      type: 'Opaque',
    })

    await expect(
      svc.mergeSecret(
        {
          name: 'linear-credentials',
          namespace: 'test-ns',
          stringData: { [VALID_KEYS[0]]: 'rotated' },
        },
        { allowExistingPlatformAnnotationKeys: REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS }
      )
    ).resolves.toMatchObject({ name: 'linear-credentials', namespace: 'test-ns' })
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledOnce()
  })

  it('preserves extra platform metadata and still rejects request-side annotation injection', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: {
        annotations: {
          'clerum.io/catalog-id': 'linear',
          'clerum.io/catalog-version': '1.0.0',
          'clerum.io/untrusted': 'must-reject',
        },
      },
      type: 'Opaque',
    })

    await expect(
      svc.mergeSecret(
        {
          name: 'linear-credentials',
          namespace: 'test-ns',
          stringData: { [VALID_KEYS[0]]: 'rotated' },
        },
        { allowExistingPlatformAnnotationKeys: REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS }
      )
    ).resolves.toMatchObject({ name: 'linear-credentials', namespace: 'test-ns' })
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledOnce()

    await expect(
      svc.createSecret(
        {
          name: 'forged',
          namespace: 'test-ns',
          annotations: { 'clerum.io/catalog-id': 'caller-controlled' },
          stringData: { [VALID_KEYS[0]]: 'value' },
        },
        { allowExistingPlatformAnnotationKeys: REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS }
      )
    ).rejects.toBeInstanceOf(DangerousAnnotationError)
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

describe('resolveSecretAnnotationsForReplace — transition policy', () => {
  const infra = {
    'meta.helm.sh/release-name': 'release-a',
    'kubectl.kubernetes.io/last-applied-configuration': 'legacy',
  }
  const catalog = {
    'clerum.io/catalog-id': 'entry-a',
    'clerum.io/catalog-version': '1.0.0',
  }

  it('preserves protected metadata while replacing caller-owned keys', () => {
    expect(
      resolveSecretAnnotationsForReplace(
        { ...infra, ...catalog, 'safe.example/old': 'old' },
        { 'safe.example/new': 'new' },
        { allowExistingPlatformAnnotationKeys: REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS }
      )
    ).toEqual({ ...infra, ...catalog, 'safe.example/new': 'new' })
  })

  it('distinguishes omitted annotations from an explicit empty map', () => {
    const existing = { ...infra, 'safe.example/old': 'old' }
    expect(resolveSecretAnnotationsForReplace(existing, undefined)).toEqual(existing)
    expect(resolveSecretAnnotationsForReplace(existing, {})).toEqual(infra)
  })

  it('preserves an unrecognized existing platform annotation without claiming ownership', () => {
    expect(
      resolveSecretAnnotationsForReplace(
        { ...catalog, 'clerum.io/trust-level': 'low' },
        {},
        { allowExistingPlatformAnnotationKeys: REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS }
      )
    ).toEqual({ ...catalog, 'clerum.io/trust-level': 'low' })
  })

  it('does not let an allowlist assign a new platform annotation', () => {
    expect(() =>
      resolveSecretAnnotationsForReplace(
        {},
        { 'clerum.io/catalog-id': 'forged' },
        { allowExistingPlatformAnnotationKeys: REGISTRY_SECRET_PRESERVED_ANNOTATION_KEYS }
      )
    ).toThrow(DangerousAnnotationError)
  })

  it('allows a capability to remove only its own platform key by explicit replace', () => {
    expect(
      resolveSecretAnnotationsForReplace(
        { ...infra, 'clerum.io/trust-level': 'low' },
        {},
        { capability: 'registryCredential' }
      )
    ).toEqual(infra)
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

  it('accepts registry-owned annotation keys with the registryCredential capability', () => {
    for (const key of PLATFORM_ANNOTATION_KEYS) {
      expect(dangerousAnnotationKeyReason(key, { capability: 'registryCredential' })).toBeNull()
    }
  })

  it('still rejects infra keys even with the registryCredential capability', () => {
    for (const key of DANGEROUS_ANNOTATION_KEYS) {
      const reason = dangerousAnnotationKeyReason(key, { capability: 'registryCredential' })
      expect(reason).not.toBeNull()
      expect(reason).toContain('is not allowed')
    }
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
