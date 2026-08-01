import { describe, expect, it, vi } from 'vitest'
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
})
