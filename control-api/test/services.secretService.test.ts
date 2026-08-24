import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
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
    createNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: 's' } }),
    replaceNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: 's' } }),
    patchNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: 's' } }),
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

  it('omits annotations from the list projection', async () => {
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

  it('sends the CALLER’s resourceVersion on a replace, without re-reading', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { resourceVersion: '999' },
      type: 'Opaque',
      data: {},
    })

    await svc.updateSecret(
      { name: 's', namespace: 'ns', type: 'Opaque', data: { k: 'dg==' } },
      { resourceVersion: '42', uid: 'uid-1' }
    )

    // The re-read is the bug, not an optimization: it would replace the stale version we
    // are trying to detect with the current one, and the write would win regardless.
    expect(coreApi.readNamespacedSecret).not.toHaveBeenCalled()
    const body = coreApi.replaceNamespacedSecret.mock.calls[0][0].body
    expect(body.metadata.resourceVersion).toBe('42')
    expect(body.metadata.uid).toBe('uid-1')
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
