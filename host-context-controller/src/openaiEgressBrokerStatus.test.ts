import { describe, expect, it } from 'vitest'
import { OAI_EGRESS_BROKERS_CONDITION_TYPE } from '@clerum/egress-policy'
import {
  BrokerOutcomes,
  buildBrokersCondition,
  writeBrokersCondition,
} from './openaiEgressBrokerStatus'
import { HostCRD, HostCondition, HostCrdStatus } from './types'

function host(conditions?: HostCondition[]): HostCRD {
  return {
    name: 'h',
    namespace: 'mcp-host',
    spec: { host: 'h', contextRef: 'ctx' },
    ...(conditions ? { status: { conditions } } : {}),
  }
}

const NOW = () => new Date('2026-01-01T00:00:00.000Z')

describe('buildBrokersCondition (decision table)', () => {
  it('Host declares no openai-compatible slot → null (writer removes any existing)', () => {
    expect(
      buildBrokersCondition(host(), {
        declaresOpenAiCompatible: false,
        provisioned: 0,
        dropped: [],
      })
    ).toBeNull()
  })

  it('declares + zero drops → True / AllSlotsProvisioned with a broker count message', () => {
    const cond = buildBrokersCondition(
      host(),
      { declaresOpenAiCompatible: true, provisioned: 2, dropped: [] },
      NOW
    )
    expect(cond).toMatchObject({
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'True',
      reason: 'AllSlotsProvisioned',
      message: '2 broker(s) provisioned',
      lastTransitionTime: '2026-01-01T00:00:00.000Z',
    })
  })

  it('declares + ≥1 drop → False, reason = first drop in PascalCase, message lists all', () => {
    const cond = buildBrokersCondition(
      host(),
      {
        declaresOpenAiCompatible: true,
        provisioned: 0,
        dropped: [
          { slotId: 'primary', reason: 'cluster_internal' },
          { slotId: 'fallback-1', reason: 'path_unsafe' },
        ],
      },
      NOW
    )
    expect(cond).toMatchObject({
      status: 'False',
      reason: 'ClusterInternal',
      message: 'primary: cluster_internal; fallback-1: path_unsafe',
    })
  })

  it('maps the fail-closed guard reason to ClusterInternalGuardUnconfigured', () => {
    const cond = buildBrokersCondition(host(), {
      declaresOpenAiCompatible: true,
      provisioned: 0,
      dropped: [{ slotId: 'primary', reason: 'cluster_internal_guard_unconfigured' }],
    })
    expect(cond?.reason).toBe('ClusterInternalGuardUnconfigured')
  })

  it('preserves lastTransitionTime when status + reason are unchanged', () => {
    const prior: HostCondition = {
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'False',
      reason: 'ClusterInternal',
      message: 'primary: cluster_internal',
      lastTransitionTime: '2020-05-05T05:05:05.000Z',
    }
    const cond = buildBrokersCondition(
      host([prior]),
      {
        declaresOpenAiCompatible: true,
        provisioned: 0,
        dropped: [{ slotId: 'primary', reason: 'cluster_internal' }],
      },
      NOW
    )
    // reason unchanged → timestamp carried over even though NOW differs.
    expect(cond?.lastTransitionTime).toBe('2020-05-05T05:05:05.000Z')
  })

  it('stamps a new lastTransitionTime when status flips', () => {
    const prior: HostCondition = {
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'False',
      reason: 'ClusterInternal',
      lastTransitionTime: '2020-05-05T05:05:05.000Z',
    }
    const cond = buildBrokersCondition(
      host([prior]),
      { declaresOpenAiCompatible: true, provisioned: 1, dropped: [] },
      NOW
    )
    expect(cond?.status).toBe('True')
    expect(cond?.lastTransitionTime).toBe('2026-01-01T00:00:00.000Z')
  })
})

/**
 * A faithful stand-in for the apiserver status subresource, so these tests
 * exercise the real patch semantics writeBrokersCondition depends on instead of
 * a hand-written post-patch result: it enforces the `/metadata/resourceVersion`
 * precondition (mismatch ⇒ 409), applies the `add /status` and
 * `add /status/conditions` ops verbatim, and bumps resourceVersion on success.
 * A scheduled concurrent write (another status writer landing between our read
 * and our patch) is what drives the 409-retry path.
 */
class FakeStatusApi {
  private rv: number
  private pendingConcurrentWrites: Array<() => void> = []
  reads = 0
  patches = 0

  constructor(
    public store: {
      metadata: { name: string; namespace: string; uid?: string; resourceVersion: string }
      spec: HostCRD['spec']
      status?: HostCrdStatus
    }
  ) {
    this.rv = Number(store.metadata.resourceVersion)
  }

  private bumpRv(): void {
    this.rv += 1
    this.store.metadata.resourceVersion = String(this.rv)
  }

  /** Queue a concurrent mutation that lands on the store just before our next patch. */
  scheduleConcurrentWrite(mutate: (status: HostCrdStatus) => void): void {
    this.pendingConcurrentWrites.push(() => {
      this.store.status = this.store.status ?? {}
      mutate(this.store.status)
      this.bumpRv()
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getNamespacedCustomObject(_args: unknown): Promise<unknown> {
    this.reads += 1
    return {
      metadata: { ...this.store.metadata },
      spec: this.store.spec,
      status: this.store.status ? structuredClone(this.store.status) : undefined,
    }
  }

  async patchNamespacedCustomObjectStatus(args: {
    body: Array<{ op: string; path: string; value: unknown }>
  }): Promise<void> {
    this.patches += 1
    // Another writer lands between our read and our write → stale precondition.
    const concurrent = this.pendingConcurrentWrites.shift()
    if (concurrent) concurrent()

    const rvOp = args.body.find(o => o.path === '/metadata/resourceVersion')
    if (rvOp && rvOp.value !== this.store.metadata.resourceVersion) {
      throw { code: 409 }
    }
    for (const op of args.body) {
      if (op.path === '/status') {
        this.store.status = op.value as HostCrdStatus
      } else if (op.path === '/status/conditions') {
        // The apiserver rejects `add /status/conditions` when the `/status`
        // parent does not exist yet — that is exactly why the writer seeds the
        // whole `/status` subresource on a statusless Host.
        if (this.store.status === undefined) {
          throw { code: 422 }
        }
        this.store.status = {
          ...this.store.status,
          conditions: op.value as HostCondition[],
        }
      }
    }
    this.bumpRv()
  }
}

function storedHost(status?: HostCrdStatus, rv = '10') {
  return {
    metadata: { name: 'h', namespace: 'mcp-host', uid: 'u', resourceVersion: rv },
    spec: { host: 'h', contextRef: 'ctx' } as HostCRD['spec'],
    ...(status ? { status } : {}),
  }
}

// A condition owned by ANOTHER writer (the stateless-lifecycle writer). It is
// opaque to writeBrokersCondition — filtered by `type` and passed through
// verbatim — so its exact shape is not under test; only that it survives.
const FOREIGN: HostCondition = {
  type: 'StatelessLifecycleReady',
  status: 'True',
  reason: 'Active',
  message: 'lifecycle active',
  lastTransitionTime: '2020-01-01T00:00:00.000Z',
}

const DROP_OUTCOME: BrokerOutcomes = {
  declaresOpenAiCompatible: true,
  provisioned: 0,
  dropped: [{ slotId: 'primary', reason: 'cluster_internal' }],
}

// Bind the real producer as the `build` fn, so the written condition is derived
// from buildBrokersCondition, not hand-authored.
const buildFrom = (outcomes: BrokerOutcomes) => (fresh: HostCRD) =>
  buildBrokersCondition(fresh, outcomes, NOW)

function apiOf(fake: FakeStatusApi) {
  return fake as unknown as import('@kubernetes/client-node').CustomObjectsApi
}
function hostRef(fake: FakeStatusApi): HostCRD {
  return {
    name: fake.store.metadata.name,
    namespace: fake.store.metadata.namespace,
    spec: fake.store.spec,
  }
}

describe('writeBrokersCondition (io invariants)', () => {
  it('preserves every OTHER condition when writing ours', async () => {
    const fake = new FakeStatusApi(storedHost({ conditions: [FOREIGN] }))
    await writeBrokersCondition(apiOf(fake), hostRef(fake), buildFrom(DROP_OUTCOME))

    const conditions = fake.store.status?.conditions ?? []
    // Observable state (T4): the foreign condition survives verbatim and ours is added.
    expect(conditions).toContainEqual(FOREIGN)
    expect(conditions.find(c => c.type === OAI_EGRESS_BROKERS_CONDITION_TYPE)).toMatchObject({
      status: 'False',
      reason: 'ClusterInternal',
    })
  })

  it('a 409 re-reads fresh and re-derives against the winning resourceVersion', async () => {
    const fake = new FakeStatusApi(storedHost({ conditions: [] }))
    // Another writer adds a condition AND bumps rv between our read and our patch.
    fake.scheduleConcurrentWrite(status => {
      status.conditions = [...(status.conditions ?? []), FOREIGN]
    })

    await writeBrokersCondition(apiOf(fake), hostRef(fake), buildFrom(DROP_OUTCOME))

    // Retried (2 reads, 2 patches) and won on the fresh read.
    expect(fake.reads).toBe(2)
    expect(fake.patches).toBe(2)
    const conditions = fake.store.status?.conditions ?? []
    // The concurrent writer's condition survives (we merged onto the WINNER, not
    // our stale snapshot) and ours landed.
    expect(conditions).toContainEqual(FOREIGN)
    expect(conditions.some(c => c.type === OAI_EGRESS_BROKERS_CONDITION_TYPE)).toBe(true)
  })

  it('seeds /status when the Host has none, preserving other status members', async () => {
    // lifecycle present but no conditions → the seed path must keep lifecycle.
    const fake = new FakeStatusApi(
      storedHost({ lifecycle: { state: 'active', wakeHandledGeneration: 3 } })
    )
    await writeBrokersCondition(apiOf(fake), hostRef(fake), buildFrom(DROP_OUTCOME))

    expect(fake.store.status?.lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 3 })
    expect(
      fake.store.status?.conditions?.some(c => c.type === OAI_EGRESS_BROKERS_CONDITION_TYPE)
    ).toBe(true)
  })

  it('seeds /status/conditions when the Host has no status at all', async () => {
    const fake = new FakeStatusApi(storedHost(undefined))
    await writeBrokersCondition(apiOf(fake), hostRef(fake), buildFrom(DROP_OUTCOME))

    expect(fake.store.status?.conditions).toHaveLength(1)
    expect(fake.store.status?.conditions?.[0]).toMatchObject({ status: 'False' })
  })

  it('is best-effort: a read failure never throws and writes nothing', async () => {
    const fake = new FakeStatusApi(storedHost({ conditions: [FOREIGN] }))
    fake.getNamespacedCustomObject = async () => {
      throw new Error('apiserver unreachable')
    }
    await expect(
      writeBrokersCondition(apiOf(fake), hostRef(fake), buildFrom(DROP_OUTCOME))
    ).resolves.toBeUndefined()
    // Store untouched: the foreign condition is intact and ours never landed.
    expect(fake.store.status?.conditions).toEqual([FOREIGN])
  })
})
