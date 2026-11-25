/**
 * The audit line for Host approval changes (spec 2026-11-24-control-ui-approval-settings
 * §6.8), through the real routes over the real `ResourceService`.
 */
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { rootLogger } from '../src/observability/logger.js'
import {
  type HarnessAllowedModel,
  type HarnessObject,
  type HostRouteHarness,
  buildHostRouteHarness,
} from './helpers/hostRouteHarness.js'

const ALLOWED_MODELS: HarnessAllowedModel[] = [
  { provider: 'claude', model: 'claude-sonnet-4-6', enabled: true, stale: false },
]
const HOSTS_PATH = '/api/v1/admin/hosts'
const HOST_PATH = `${HOSTS_PATH}/foo`
const SEED: HarnessObject = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'Host',
  metadata: { name: 'foo' },
  spec: {
    host: 'foo',
    contextRef: 'ctx-a',
    secretRef: 'foo-llm',
    channels: [],
    model: { provider: 'claude', name: 'claude-sonnet-4-6' },
    approval: {
      defaultPolicy: 'designated_approvers',
      channels: { telegram: { enabled: true, approvers: ['approver-one'] } },
      modeCeiling: 'manual',
    },
  },
  status: { lifecycle: { state: 'active', effectiveMode: 'stateful', observedGeneration: 1 } },
}

describe('Host approval audit line', () => {
  let harness: HostRouteHarness | undefined
  let info: ReturnType<typeof vi.fn>
  let childSpy: MockInstance
  let warnSpy: MockInstance

  beforeEach(() => {
    info = vi.fn()
    childSpy = vi.spyOn(rootLogger, 'child').mockReturnValue({ info } as never)
    warnSpy = vi.spyOn(rootLogger, 'warn').mockImplementation(() => {})
    harness = buildHostRouteHarness({ allowedModels: ALLOWED_MODELS })
    harness.store.seed('hosts', SEED)
  })
  afterEach(() => {
    harness?.dispose()
    harness = undefined
    vi.restoreAllMocks()
  })

  const auditCalls = () =>
    info.mock.calls.filter(
      call => (call[0] as { event?: string }).event === 'host_approval_changed'
    )

  async function readHost(): Promise<{ spec: Record<string, unknown>; resourceVersion: string }> {
    const read = await request(harness!.app).get(HOST_PATH)
    expect(read.status).toBe(200)
    return { spec: read.body.spec, resourceVersion: read.body.metadata.resourceVersion }
  }

  it('logs host_approval_changed on a PUT that changes approval', async () => {
    const { spec, resourceVersion } = await readHost()
    const approval = spec.approval as Record<string, unknown>

    const res = await request(harness!.app)
      .put(HOST_PATH)
      .send({
        metadata: { resourceVersion },
        spec: {
          ...spec,
          approval: {
            ...approval,
            modeCeiling: 'allow_all',
            channels: { telegram: { enabled: true, approvers: ['approver-one', 'approver-two'] } },
          },
        },
      })

    expect(res.status).toBe(200)
    expect(childSpy).toHaveBeenCalledWith({ module: 'host-approval-audit' })
    const calls = auditCalls()
    expect(calls).toHaveLength(1)
    const [payload, message] = calls[0] as [Record<string, unknown>, string]
    expect(message).toBe('Host approval settings changed')
    expect(payload).toMatchObject({
      event: 'host_approval_changed',
      host: 'foo',
      via: 'host_put',
      operatorSub: 'host-route-harness-operator',
      operationId: harness!.adminOperations.find(c => c.method === 'persistHostIntent')?.intent
        .operationId,
      fields: { modeCeiling: { old: 'manual', new: 'allow_all' } },
      approvers: { 'channels.telegram': { added: 1, removed: 0 } },
    })
    expect(JSON.stringify(payload)).not.toMatch(/approver-(one|two)/)
  })

  it('logs nothing when approval is unchanged', async () => {
    // The seed is stored as given, while the apiserver prunes and defaults the
    // approval block on every write. One write first settles the stored block,
    // as an object written through the apiserver always is.
    const seeded = await readHost()
    const settle = await request(harness!.app).put(HOST_PATH).send({ spec: seeded.spec })
    expect(settle.status).toBe(200)
    info.mockClear()
    const { spec } = await readHost()

    const res = await request(harness!.app)
      .put(HOST_PATH)
      .send({ spec: { ...spec, contextRef: 'ctx-b' } })

    expect(res.status).toBe(200)
    // The partner test above proves the spy sees an approval change.
    expect(auditCalls()).toHaveLength(0)
  })

  it('logs on create with an approval block', async () => {
    const res = await request(harness!.app)
      .post(HOSTS_PATH)
      .send({
        metadata: { name: 'bar' },
        spec: {
          ...(SEED.spec as Record<string, unknown>),
          host: 'bar',
          approval: { defaultPolicy: 'cli_only', channels: {}, modeCeiling: 'auto' },
        },
      })

    expect(res.status).toBe(201)
    const calls = auditCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toMatchObject({
      host: 'bar',
      via: 'host_create',
      inheritedBefore: true,
      fields: { modeCeiling: { old: null, new: 'auto' } },
    })
  })

  it('a logging failure after a stored replace does not fail the request', async () => {
    info.mockImplementation(() => {
      throw new Error('log sink down')
    })
    const { spec, resourceVersion } = await readHost()
    const approval = spec.approval as Record<string, unknown>

    const res = await request(harness!.app)
      .put(HOST_PATH)
      .send({
        metadata: { resourceVersion },
        spec: { ...spec, approval: { ...approval, modeCeiling: 'auto' } },
      })

    expect(res.status).toBe(200)
    expect(info).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    const stored = harness!.store.get('hosts', 'foo')?.spec as { approval: { modeCeiling: string } }
    expect(stored.approval.modeCeiling).toBe('auto')
  })
})
