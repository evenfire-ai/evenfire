/**
 * main.ts `onHostChange`, driven directly. The ConfigStore is replaced by a
 * fake whose `start()` the test releases, so two Host events can overlap the
 * way they do when a Host edit and an HCC status write arrive together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import type { ConfigStoreOptions } from '../config/configStore'
import type { HostCRD } from '../types'

interface FakeStore {
  opts: ConfigStoreOptions
  started: boolean
  stopped: boolean
}

const fake = vi.hoisted(() => {
  const state = {
    stores: [] as FakeStore[],
    // One entry per store the next constructions create; undefined starts at once.
    startGates: [] as Array<Promise<void> | undefined>,
    // When set, stop() on this store throws.
    throwOnStop: null as FakeStore | null,
  }
  return state
})

vi.mock('../config/configStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../config/configStore')>()
  class FakeConfigStore implements FakeStore {
    opts: ConfigStoreOptions
    started = false
    stopped = false
    private readonly gate: Promise<void> | undefined
    constructor(opts: ConfigStoreOptions) {
      this.opts = opts
      this.gate = fake.startGates.shift()
      fake.stores.push(this)
    }
    async start(): Promise<void> {
      await this.gate
      this.started = true
    }
    stop(): void {
      if (fake.throwOnStop === this) throw new Error('fixture stop failure')
      this.stopped = true
    }
    onChange(): () => void {
      return () => undefined
    }
    get(): string | undefined {
      return undefined
    }
    llmCredentials(): null {
      return null
    }
    fallbackSlotValue(dataKey: string): string | undefined {
      return this.opts.fallbackCredentialSlots?.includes(dataKey) ? 'fixture-key' : undefined
    }
    allowlistAvailable(): boolean {
      return false
    }
    allowedModels(): Map<string, never[]> {
      return new Map()
    }
    listSecretEntries(): [] {
      return []
    }
    codexPolicyBinding(): null {
      return null
    }
    grokPolicyBinding(): null {
      return null
    }
  }
  return { ...actual, ConfigStore: FakeConfigStore }
})

const FALLBACK_SLOT = 'openai-api-key-fixture-fallback'

function baseHost(): HostCRD {
  return {
    name: 'host-a',
    namespace: 'fixture-ns',
    spec: {
      host: 'host-a',
      contextRef: 'ctx-a',
      secretRef: 'llm-secret-a',
      model: { provider: 'claude', name: 'claude-sonnet-4-5' },
    },
  }
}

function withFallback(host: HostCRD): HostCRD {
  return {
    ...host,
    spec: {
      ...host.spec,
      llmPolicy: {
        fallbacks: [{ provider: 'openai', model: 'gpt-4.1', credentialSlot: FALLBACK_SLOT }],
      },
    },
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function liveStores(): FakeStore[] {
  return fake.stores.filter(store => !store.stopped)
}

describe('main onHostChange ConfigStore staging', () => {
  let onHostChange: (host: HostCRD) => Promise<void>

  beforeEach(async () => {
    fake.stores.length = 0
    fake.startGates.length = 0
    fake.throwOnStop = null
    // Each test loads a fresh main.ts so its module state starts empty. The
    // metrics it registers live in prom-client's process-wide registry.
    register.clear()
    vi.resetModules()
    ;({ onHostChange } = await import('../main'))
  })

  afterEach(() => {
    fake.throwOnStop = null
  })

  it('installs the new failover slots when a later event commits while the slot rebuild is still opening', async () => {
    await onHostChange(baseHost())
    expect(fake.stores).toHaveLength(1)
    const initial = fake.stores[0]!
    expect(initial.opts.fallbackCredentialSlots).toEqual([])

    // Event A adds a fallback: only the failover slots change. Its store
    // opens slowly.
    const slowStart = deferred()
    fake.startGates.push(slowStart.promise)
    const eventA = onHostChange(withFallback(baseHost()))

    // Event B carries the same spec (an HCC status write or a watch re-ADD)
    // and arrives while A is still opening. B is the latest event, so its
    // commit decides what the Host serves.
    const eventB = withFallback(baseHost())
    await onHostChange(eventB)

    slowStart.resolve()
    await eventA

    const live = liveStores()
    expect(live).toHaveLength(1)
    expect(live[0]!.started).toBe(true)
    expect(live[0]!.opts.fallbackCredentialSlots).toContain(FALLBACK_SLOT)
    // A lost the race: its store was opened with the slots, then stopped.
    const storeA = fake.stores[1]!
    expect(storeA.opts.fallbackCredentialSlots).toContain(FALLBACK_SLOT)
    expect(storeA.stopped).toBe(true)
    expect(initial.stopped).toBe(true)
  })

  it('keeps the installed store when a later event needs the same slots', async () => {
    await onHostChange(withFallback(baseHost()))
    expect(fake.stores).toHaveLength(1)
    await onHostChange(withFallback(baseHost()))
    expect(fake.stores).toHaveLength(1)
    expect(liveStores()).toEqual([fake.stores[0]])
    expect(fake.stores[0]!.opts.fallbackCredentialSlots).toContain(FALLBACK_SLOT)
  })
})
