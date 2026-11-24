/**
 * Body rule for Host writes (spec 2026-11-24-control-ui-approval-settings §6.8):
 * a Host create or PUT whose body carries no `spec` object answers 422 with
 * control-api's recorded `{ errors: [{ field, message }] }` envelope
 * (test/fixtures/wire/host-put-422.wire.json). Nothing is written.
 *
 * Runs the real routes over the real `ResourceService` through
 * ./helpers/hostRouteHarness.ts.
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
const HOSTS_PATH = '/api/v1/admin/hosts'
const HOST_PATH = `${HOSTS_PATH}/foo`
const SPEC_REQUIRED = { errors: [{ field: 'spec', message: 'spec is required' }] }

const SPEC = {
  host: 'foo',
  contextRef: 'ctx-a',
  secretRef: 'foo-llm',
  channels: [],
  model: { provider: PROVIDER, name: MODEL },
  approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'manual' },
}

const SEED: HarnessObject = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'Host',
  metadata: { name: 'foo' },
  spec: SPEC,
  status: { lifecycle: { state: 'active', effectiveMode: 'stateful', observedGeneration: 1 } },
}

describe('Host body rule', () => {
  let harness: HostRouteHarness | undefined
  afterEach(() => {
    harness?.dispose()
    harness = undefined
  })

  function seeded(): HostRouteHarness {
    harness = buildHostRouteHarness({ allowedModels: ALLOWED_MODELS })
    harness.store.seed('hosts', SEED)
    return harness
  }

  it('a Host PUT with no spec object answers 422', async () => {
    const h = seeded()
    const before = structuredClone(h.store.get('hosts', 'foo'))

    for (const body of [{}, { metadata: { labels: { a: 'b' } } }, { spec: null }, { spec: [] }]) {
      const res = await request(h.app).put(HOST_PATH).send(body)
      expect(res.status).toBe(422)
      expect(res.body).toEqual(SPEC_REQUIRED)
    }
    expect(h.store.get('hosts', 'foo')).toEqual(before)
    expect(h.replaceBodies).toHaveLength(0)
  })

  it('a Host create with no spec answers 422', async () => {
    const h = seeded()

    const res = await request(h.app)
      .post(HOSTS_PATH)
      .send({ metadata: { name: 'bar' } })

    expect(res.status).toBe(422)
    expect(res.body).toEqual(SPEC_REQUIRED)
    expect(h.store.get('hosts', 'bar')).toBeUndefined()
  })

  it('a Host PUT with spec is accepted', async () => {
    const h = seeded()

    const res = await request(h.app)
      .put(HOST_PATH)
      .send({ spec: { ...SPEC, contextRef: 'ctx-b' } })

    expect(res.status).toBe(200)
    const stored = h.store.get('hosts', 'foo')
    expect((stored?.spec as Record<string, unknown>).contextRef).toBe('ctx-b')
  })
})
