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
import { type MockInstance, afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { pool } from '../src/db.js'
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

  it('the refusal records a failed outcome on the intent', async () => {
    harness = seededHarness()
    const read = await request(harness.app).get(HOST_PATH)
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
    const intents = harness.adminOperations.filter(call => call.method === 'persistHostIntent')
    const outcomes = harness.adminOperations.filter(call => call.method === 'persistHostOutcome')
    expect(intents).toHaveLength(1)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ outcome: 'failed' })
    expect(harness.replaceBodies).toHaveLength(0)
    const approval = storedSpec(harness).approval as Record<string, unknown>
    expect(approval.modeCeiling).toBe('manual')
  })

  it('an accepted version-less PUT records none', async () => {
    harness = seededHarness()
    const read = await request(harness.app).get(HOST_PATH)
    const spec = read.body.spec as Record<string, unknown>

    const res = await request(harness.app)
      .put(HOST_PATH)
      .send({ spec: { ...spec, contextRef: 'ctx-b' } })

    expect(res.status).toBe(200)
    expect(
      harness.adminOperations.filter(call => call.method === 'persistHostIntent')
    ).toHaveLength(1)
    expect(harness.adminOperations.filter(call => call.method === 'persistHostOutcome')).toEqual([])
    expect(harness.replaceBodies).toHaveLength(1)
  })

  it('a version-less PUT dropping the approval block is refused', async () => {
    harness = seededHarness()
    const read = await request(harness.app).get(HOST_PATH)
    const { approval: _approval, ...rest } = read.body.spec as Record<string, unknown>

    const res = await request(harness.app).put(HOST_PATH).send({ spec: rest })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'conflict', reason: 'approval_requires_version' })
    expect(storedSpec(harness).approval).toBeDefined()
  })

  it('a versioned PUT that changes spec.approval is not refused by the version rule', async () => {
    harness = seededHarness()
    const read = await request(harness.app).get(HOST_PATH)
    const spec = read.body.spec as Record<string, unknown>

    const res = await request(harness.app)
      .put(HOST_PATH)
      .send({
        metadata: { resourceVersion: read.body.metadata.resourceVersion },
        spec: {
          ...spec,
          approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'allow_all' },
        },
      })

    expect(res.status).toBe(200)
    expect((storedSpec(harness).approval as Record<string, unknown>).modeCeiling).toBe('allow_all')
  })

  it('a version-less PUT with the stored approval and its keys reordered is accepted', async () => {
    harness = seededHarness()
    const read = await request(harness.app).get(HOST_PATH)
    const spec = read.body.spec as Record<string, unknown>
    const approval = spec.approval as Record<string, unknown>
    const reordered = Object.fromEntries(Object.entries(approval).reverse())

    const res = await request(harness.app)
      .put(HOST_PATH)
      .send({ spec: { ...spec, approval: reordered, contextRef: 'ctx-b' } })

    expect(res.status).toBe(200)
    expect(storedSpec(harness).contextRef).toBe('ctx-b')
  })

  describe('the summary comes from the write that changes approval (security m-3)', () => {
    const intentSummary = (h: HostRouteHarness): string | undefined =>
      (
        h.adminOperations.find(call => call.method === 'persistHostIntent')?.input as
          | { summary?: string }
          | undefined
      )?.summary

    it('a version-less PUT whose pre-lock read differs from the locked read records no summary', async () => {
      // The route's pre-write read sees approval `allow_all`; another writer
      // restores `manual` before the locked read (the first Postgres connection
      // of the write). The PUT carries `manual`, so it passes the version rule
      // and changes nothing; a summary built from the earlier read would record
      // allow_all to manual on the durable record as this request's change.
      harness = buildHostRouteHarness({ allowedModels: ALLOWED_MODELS })
      const raced = harness
      raced.store.seed('hosts', {
        ...SEED,
        spec: {
          ...SEED.spec,
          approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'allow_all' },
        },
      })
      const connect = pool.connect as unknown as MockInstance
      const real = connect.getMockImplementation() as (...args: unknown[]) => Promise<unknown>
      let flipped = false
      connect.mockImplementation(async (...args: unknown[]) => {
        if (!flipped) {
          flipped = true
          const stored = raced.store.get('hosts', 'foo')!
          raced.store.seed('hosts', {
            ...stored,
            spec: {
              ...stored.spec,
              approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'manual' },
            },
          })
        }
        return real(...args)
      })

      const res = await request(raced.app)
        .put(HOST_PATH)
        .send({
          spec: {
            ...SEED.spec,
            contextRef: 'ctx-b',
            approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'manual' },
          },
        })

      expect(flipped).toBe(true)
      expect(res.status).toBe(200)
      expect(raced.adminOperations.filter(c => c.method === 'persistHostIntent')).toHaveLength(1)
      expect(intentSummary(raced)).toBeUndefined()
    })

    it('a versioned PUT that changes approval still records a summary', async () => {
      harness = seededHarness()
      const read = await request(harness.app).get(HOST_PATH)

      const res = await request(harness.app)
        .put(HOST_PATH)
        .send({
          metadata: { resourceVersion: read.body.metadata.resourceVersion },
          spec: {
            ...(read.body.spec as Record<string, unknown>),
            approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'allow_all' },
          },
        })

      expect(res.status).toBe(200)
      const summary = intentSummary(harness)
      expect(summary).toBeDefined()
      expect(JSON.parse(summary as string).fields).toEqual({
        modeCeiling: { old: 'manual', new: 'allow_all' },
      })
    })
  })
})
