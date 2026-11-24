/**
 * Version rule for Host PUT (spec 2026-11-24-control-ui-approval-settings §6.8):
 * a PUT that changes `spec.approval` must carry the stored `resourceVersion`.
 * A version-less PUT that leaves `spec.approval` unchanged stays accepted.
 *
 * Runs the real routes over the real `ResourceService` through
 * ./helpers/hostRouteHarness.ts. The refusal answers control-api's recorded
 * version-conflict envelope (test/fixtures/wire/host-put-409.wire.json) with
 * the reason `approval_requires_version`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import {
  type HarnessAllowedModel,
  type HarnessObject,
  type HostRouteHarness,
  buildHostRouteHarness,
} from './helpers/hostRouteHarness.js'

const PROVIDER = 'claude'
const MODEL = 'claude-sonnet-4-6'
const ALLOWED_MODELS: HarnessAllowedModel[] = [
  { provider: PROVIDER, model: MODEL, enabled: true, stale: false },
]
const HOST_PATH = '/api/v1/admin/hosts/foo'

const SEED: HarnessObject = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'Host',
  metadata: { name: 'foo' },
  spec: {
    host: 'foo',
    contextRef: 'ctx-a',
    secretRef: 'foo-llm',
    channels: [],
    model: { provider: PROVIDER, name: MODEL },
    approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'manual' },
  },
  status: { lifecycle: { state: 'active', effectiveMode: 'stateful', observedGeneration: 1 } },
}

function seededHarness(): HostRouteHarness {
  const harness = buildHostRouteHarness({ allowedModels: ALLOWED_MODELS })
  harness.store.seed('hosts', SEED)
  return harness
}

function storedSpec(harness: HostRouteHarness): Record<string, unknown> {
  const stored = harness.store.get('hosts', 'foo')
  if (!stored) throw new Error('the in-memory apiserver lost Host foo')
  return stored.spec as Record<string, unknown>
}

describe('Host PUT version rule', () => {
  let harness: HostRouteHarness | undefined
  afterEach(() => {
    harness?.dispose()
    harness = undefined
  })

  it('T29 a version-less Host PUT that changes spec.approval is refused', async () => {
    harness = seededHarness()
    const read = await request(harness.app).get(HOST_PATH)
    expect(read.status).toBe(200)
    const spec = read.body.spec as Record<string, unknown>

    const res = await request(harness.app)
      .put(HOST_PATH)
      .send({
        spec: {
          ...spec,
          approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'allow_all' },
        },
      })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'conflict', reason: 'approval_requires_version' })
    const approval = storedSpec(harness).approval as Record<string, unknown>
    expect(approval.modeCeiling).toBe('manual')
  })

  it('a version-less Host PUT that leaves spec.approval unchanged is accepted', async () => {
    harness = seededHarness()
    const read = await request(harness.app).get(HOST_PATH)
    expect(read.status).toBe(200)
    const spec = read.body.spec as Record<string, unknown>

    const res = await request(harness.app)
      .put(HOST_PATH)
      .send({ spec: { ...spec, contextRef: 'ctx-b' } })

    expect(res.status).toBe(200)
    expect(storedSpec(harness).contextRef).toBe('ctx-b')
  })
})
