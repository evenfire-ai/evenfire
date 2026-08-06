/**
 * The platform pull credential must survive the Secret write-path constraints.
 *
 * These two features were built in parallel and collide by construction:
 *   - `registryPullSecretService` writes `clerum.io/pull-key-fingerprint`, the annotation
 *     the single-mint fan-out relies on to detect cross-namespace divergence.
 *   - `secretConstraints` blocks `clerum.io/`-prefixed annotation keys unless the caller
 *     explicitly opts in with `allowPlatformAnnotations`, so a user-facing route cannot
 *     forge platform ownership.
 *
 * WHY THIS FILE EXISTS RATHER THAN A TEST NEXT TO THE PROVISIONER: every existing
 * provisioner test drives `MockGateway`, whose `createSecret` writes straight to an
 * in-memory map and NEVER invokes `SecretService`. The constraint therefore cannot fire
 * there — the suite stays green while every real write 400s. This exercises the REAL
 * `SecretService` against the REAL payload builder, which is the only place the two
 * features actually meet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { readFile } from 'node:fs/promises'
import {
  DangerousAnnotationError,
  assertValidSecretConstraints,
} from '../src/services/secretConstraints.js'
import { SecretService } from '../src/services/secretService.js'

const NS = 'mcp-server'
const PULL_SECRET = 'evenfire-registry-pull'
const FINGERPRINT_ANNOTATION = 'clerum.io/pull-key-fingerprint'

/** The exact shape `registryPullSecretService.buildSecretReq` emits. */
function pullSecretRequest() {
  return {
    name: PULL_SECRET,
    namespace: NS,
    type: 'kubernetes.io/dockerconfigjson',
    labels: { 'clerum.io/managed-by': 'control-api' },
    annotations: { [FINGERPRINT_ANNOTATION]: 'abc123def456' },
    data: { '.dockerconfigjson': 'eyJhdXRocyI6e319' },
  }
}

function createCoreApiMock() {
  return {
    readNamespacedSecret: vi.fn().mockResolvedValue({
      metadata: { resourceVersion: '1' },
      type: 'kubernetes.io/dockerconfigjson',
      data: {},
    }),
    createNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: PULL_SECRET } }),
    replaceNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: PULL_SECRET } }),
    patchNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: PULL_SECRET } }),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
  }
}

let coreApi: ReturnType<typeof createCoreApiMock>
let service: SecretService

beforeEach(() => {
  coreApi = createCoreApiMock()
  service = new SecretService(coreApi as unknown as k8s.CoreV1Api, NS)
})

describe('platform pull secret vs. Secret write constraints', () => {
  it('the dockerconfigjson type is allowed', () => {
    // A rejection here would block the credential outright, not just its annotation.
    expect(() =>
      assertValidSecretConstraints({ ...pullSecretRequest(), annotations: {} })
    ).not.toThrow()
  })

  it('WITHOUT the platform opt-in the fingerprint annotation is rejected', () => {
    // This is the collision, stated as a fact: the provisioner's payload is exactly what
    // a user-facing route is forbidden from writing.
    expect(() => assertValidSecretConstraints(pullSecretRequest())).toThrow(
      DangerousAnnotationError
    )
  })

  it('WITH the platform opt-in it is accepted', () => {
    expect(() =>
      assertValidSecretConstraints(pullSecretRequest(), { allowPlatformAnnotations: true })
    ).not.toThrow()
  })

  it('createSecret accepts the real payload when the provisioner opts in', async () => {
    await expect(
      service.createSecret(pullSecretRequest(), { allowPlatformAnnotations: true })
    ).resolves.toBeDefined()
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledOnce()
    // The fingerprint must actually reach the apiserver — dropping it silently would
    // disable cross-namespace divergence detection without failing anything.
    const body = coreApi.createNamespacedSecret.mock.calls[0]?.[0]?.body as k8s.V1Secret
    expect(body.metadata?.annotations?.[FINGERPRINT_ANNOTATION]).toBe('abc123def456')
  })

  it('updateSecret accepts the real payload when the provisioner opts in', async () => {
    // The repair/fan-out path goes through updateSecret, whose third parameter is the
    // constraint options (the second is the resourceVersion precondition).
    await expect(
      service.updateSecret(pullSecretRequest(), undefined, { allowPlatformAnnotations: true })
    ).resolves.toBeDefined()
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledOnce()
    const body = coreApi.replaceNamespacedSecret.mock.calls[0]?.[0]?.body as k8s.V1Secret
    expect(body.metadata?.annotations?.[FINGERPRINT_ANNOTATION]).toBe('abc123def456')
  })

  it('createSecret still REJECTS the payload without the opt-in', async () => {
    // Guards the other direction: the opt-in must be a deliberate act, so a user-facing
    // route cannot forge `clerum.io/` ownership by copying this payload.
    await expect(service.createSecret(pullSecretRequest())).rejects.toBeInstanceOf(
      DangerousAnnotationError
    )
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
  })
})

describe('every provisioner write opts in', () => {
  it('no gateway.createSecret/updateSecret in the provisioner omits PLATFORM_WRITE', async () => {
    // A structural guard, because the runtime one cannot exist: the provisioner's own
    // suites drive MockGateway, which never reaches SecretService, so a new write site
    // added without the opt-in would 400 in production with a fully green CI.
    const src = await readFile(
      new URL('../src/services/registryPullSecretService.ts', import.meta.url),
      'utf8'
    )
    const writes = src.match(/gateway\.(createSecret|updateSecret)\([^\n]*/g) ?? []
    expect(writes.length).toBeGreaterThan(0)
    const missing = writes.filter(w => !w.includes('PLATFORM_WRITE'))
    expect(missing).toEqual([])
  })
})
