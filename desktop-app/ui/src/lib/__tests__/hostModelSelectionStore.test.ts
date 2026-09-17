// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostModelsResult, SetHostModelResult } from '../../../../src/types'
import { setPendingModelIntent } from '../hostModelIntentStore'
import {
  type HostModelSelectionTransport,
  getHostModelSelectionSnapshot,
  loadHostModels,
  readHostModelSelection,
  resetHostModelSelectionStore,
  selectHostModel,
} from '../hostModelSelectionStore'

const AGENT = 'trader'
const CHAT = 'chat-1'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function baseResult(overrides: Partial<HostModelsResult> = {}): HostModelsResult {
  return {
    provider: 'zai',
    hostDefault: 'glm-5.3',
    sessionModel: null,
    degraded: false,
    models: [
      { name: 'glm-5.3', imageInput: { state: 'unsupported', reason: 'text_only' } },
      { name: 'glm-5.3-flash', imageInput: { state: 'supported', reason: 'curated' } },
    ],
    ...overrides,
  }
}

function makeTransport(overrides: Partial<HostModelSelectionTransport> = {}) {
  const getHostModels = vi.fn(async () => baseResult())
  const setHostModel = vi.fn(
    async (_agentRef: string, _chatId: string, model: string): Promise<SetHostModelResult> => ({
      effective: 'next-task',
      provider: 'zai',
      model,
    })
  )
  const transport: HostModelSelectionTransport = {
    getHostModels,
    setHostModel,
    ...overrides,
  }
  return { transport, getHostModels, setHostModel }
}

afterEach(() => {
  resetHostModelSelectionStore()
  vi.restoreAllMocks()
})

describe('hostModelSelectionStore — effective selection + capability', () => {
  it('resolves capability for the effective model, not for the provider', async () => {
    const { transport } = makeTransport()
    await loadHostModels(transport, AGENT, CHAT)

    const view = readHostModelSelection(AGENT, CHAT)
    expect(view.effectiveModel).toBe('glm-5.3')
    expect(view.imageInput.state).toBe('unsupported')
    expect(view.canAttachImages).toBe(false)
    expect(view.imageBlockMessage).toMatch(/not supported/)
  })

  it('allows images once the effective model carries valid evidence', async () => {
    const { transport } = makeTransport({
      getHostModels: async () => baseResult({ sessionModel: 'glm-5.3-flash' }),
    })
    await loadHostModels(transport, AGENT, CHAT)

    const view = readHostModelSelection(AGENT, CHAT)
    expect(view.effectiveModel).toBe('glm-5.3-flash')
    expect(view.canAttachImages).toBe(true)
    expect(view.imageBlockMessage).toBeNull()
  })

  it('blocks images while an attachment decision is missing (legacy host)', async () => {
    const { transport } = makeTransport({
      getHostModels: async () =>
        baseResult({
          sessionModel: 'glm-5.3-flash',
          models: [{ name: 'glm-5.3-flash' }],
        }),
    })
    await loadHostModels(transport, AGENT, CHAT)

    const view = readHostModelSelection(AGENT, CHAT)
    expect(view.imageInput).toEqual({ state: 'unknown', reason: 'model_unknown' })
    expect(view.visualSendBlocked).toBe(true)
    expect(view.imageBlockMessage).toMatch(/not verified/)
  })

  it('downgrades expired evidence to unknown on read', async () => {
    const { transport } = makeTransport({
      getHostModels: async () =>
        baseResult({
          sessionModel: 'glm-5.3-flash',
          models: [
            {
              name: 'glm-5.3-flash',
              imageInput: {
                state: 'supported',
                reason: 'curated',
                validUntil: '2026-09-15T00:00:00.000Z',
              },
            },
          ],
        }),
    })
    await loadHostModels(transport, AGENT, CHAT)

    const view = readHostModelSelection(AGENT, CHAT, Date.parse('2026-09-16T10:00:00.000Z'))
    expect(view.imageInput).toEqual({
      state: 'unknown',
      reason: 'evidence_expired',
      validUntil: '2026-09-15T00:00:00.000Z',
    })
    expect(view.visualSendBlocked).toBe(true)
  })
})

describe('hostModelSelectionStore — optimistic intent', () => {
  it('keeps an unpersisted intent when the host is unreachable (piggyback)', async () => {
    const suspendedWrite = vi.fn(async () => {
      throw new Error('host suspended')
    })
    const { transport, setHostModel } = makeTransport({
      setHostModel: suspendedWrite,
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ok = await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')

    expect(ok).toBe(true)
    expect(suspendedWrite).toHaveBeenCalledTimes(1)
    expect(setHostModel).not.toHaveBeenCalled()
    const view = readHostModelSelection(AGENT, CHAT)
    expect(view.effectiveModel).toBe('glm-5.3-flash')
    expect(view.pending).toBe(true)
    expect(view.intentModel).toBe('glm-5.3-flash')
  })

  it('clears the intent only after the matching write is acknowledged', async () => {
    const { transport } = makeTransport()
    const ok = await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    expect(ok).toBe(true)

    const view = readHostModelSelection(AGENT, CHAT)
    expect(view.intentModel).toBeNull()
    expect(view.pending).toBe(false)
  })

  it('holds a pre-chat pick without any POST (no stray chat)', async () => {
    const { transport, setHostModel, getHostModels } = makeTransport()
    const ok = await selectHostModel(transport, AGENT, null, 'glm-5.3-flash')

    expect(ok).toBe(true)
    expect(setHostModel).not.toHaveBeenCalled()
    expect(getHostModels).not.toHaveBeenCalled()
    expect(readHostModelSelection(AGENT, null).intentModel).toBe('glm-5.3-flash')
  })
})

describe('hostModelSelectionStore — serialized, coalesced writes', () => {
  it('serializes A→B so the final server state is the last intent', async () => {
    let resolveFirst: (() => void) | undefined
    const firstGate = new Promise<void>(resolve => {
      resolveFirst = resolve
    })
    const calls: string[] = []
    const serializedWrite = vi.fn(
      async (_agent: string, _chat: string, model: string): Promise<SetHostModelResult> => {
        calls.push(model)
        if (calls.length === 1) await firstGate
        return { effective: 'next-task', provider: 'zai', model }
      }
    )
    const { transport } = makeTransport({ setHostModel: serializedWrite })

    const first = selectHostModel(transport, AGENT, CHAT, 'glm-5.3')
    const second = selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')

    // The second pick coalesces onto the in-flight writer instead of racing it.
    expect(calls).toEqual(['glm-5.3'])
    resolveFirst?.()
    await Promise.all([first, second])

    expect(calls).toEqual(['glm-5.3', 'glm-5.3-flash'])
    expect(serializedWrite).toHaveBeenCalledTimes(2)
    const view = readHostModelSelection(AGENT, CHAT)
    expect(view.effectiveModel).toBe('glm-5.3-flash')
    expect(view.intentModel).toBeNull()
  })

  it('does not let an older read overwrite a newer intent', async () => {
    let resolveRead: ((value: HostModelsResult) => void) | undefined
    const readGate = new Promise<HostModelsResult>(resolve => {
      resolveRead = resolve
    })
    const { transport, setHostModel } = makeTransport({
      getHostModels: () => readGate,
    })

    const load = loadHostModels(transport, AGENT, CHAT)
    // The user picks while the read is still in flight.
    await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    resolveRead?.(baseResult({ sessionModel: 'glm-5.3' }))
    await load

    const view = readHostModelSelection(AGENT, CHAT)
    expect(view.effectiveModel).toBe('glm-5.3-flash')
    // A read that raced a newer intent must not lend its revision to a CAS write.
    expect(setHostModel).toHaveBeenCalledWith(AGENT, CHAT, 'glm-5.3-flash', undefined)
  })
})

describe('hostModelSelectionStore — CAS conflict', () => {
  it('preserves a newer queued choice when the older write conflicts', async () => {
    const write = deferred<SetHostModelResult>()
    const refetch = deferred<HostModelsResult>()
    const { transport } = makeTransport({
      getHostModels: vi
        .fn()
        .mockResolvedValueOnce(baseResult({ sessionModel: 'glm-5.3', modelSelectionRevision: 4 }))
        .mockImplementation(() => refetch.promise),
      setHostModel: () => write.promise,
    })
    await loadHostModels(transport, AGENT, CHAT)
    const older = selectHostModel(transport, AGENT, CHAT, 'glm-5.3')
    await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    write.reject(new Error('model_selection_conflict'))
    await older
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      intentModel: 'glm-5.3-flash',
      conflicted: true,
      visualSendBlocked: true,
    })
    refetch.resolve(baseResult({ sessionModel: 'glm-5.3', modelSelectionRevision: 9 }))
    await vi.waitFor(() => expect(readHostModelSelection(AGENT, CHAT).loading).toBe(false))
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      intentModel: 'glm-5.3-flash',
      confirmedRevision: 9,
      pending: true,
    })
  })

  it('does not revive a selection after its owner scope resets', async () => {
    const write = deferred<SetHostModelResult>()
    const { transport } = makeTransport({ setHostModel: () => write.promise })
    const selecting = selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    resetHostModelSelectionStore()
    write.resolve({
      effective: 'next-task',
      provider: 'zai',
      model: 'glm-5.3-flash',
      modelSelectionRevision: 8,
    })
    expect(await selecting).toBe(false)
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      intentModel: null,
      confirmedRevision: null,
      effectiveModel: '',
    })
  })

  it('retains the newer revision when a superseded read completes', async () => {
    const read = deferred<HostModelsResult>()
    const { transport } = makeTransport({
      getHostModels: vi
        .fn()
        .mockResolvedValueOnce(baseResult({ modelSelectionRevision: 4 }))
        .mockImplementation(() => read.promise),
      setHostModel: async () => ({
        effective: 'next-task',
        provider: 'zai',
        model: 'glm-5.3-flash',
        modelSelectionRevision: 5,
      }),
    })
    await loadHostModels(transport, AGENT, CHAT)
    const loading = loadHostModels(transport, AGENT, CHAT, { force: true })
    await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    read.resolve(baseResult({ modelSelectionRevision: 4 }))
    await loading
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      confirmedRevision: 5,
      effectiveModel: 'glm-5.3-flash',
    })
  })
  it('keeps the last confirmed state, drops the intent and refetches', async () => {
    let resolveRefetch: ((value: HostModelsResult) => void) | undefined
    const refetchGate = new Promise<HostModelsResult>(resolve => {
      resolveRefetch = resolve
    })
    const getHostModels = vi
      .fn()
      .mockResolvedValueOnce(baseResult({ sessionModel: 'glm-5.3', modelSelectionRevision: 4 }))
      .mockImplementation(() => refetchGate)
    const conflictingWrite = vi.fn(async () => {
      throw new Error('Set host model conflicted (model_selection_conflict)')
    })
    const { transport } = makeTransport({
      getHostModels,
      setHostModel: conflictingWrite,
    })
    await loadHostModels(transport, AGENT, CHAT)
    expect(readHostModelSelection(AGENT, CHAT).confirmedRevision).toBe(4)

    const ok = await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    expect(ok).toBe(false)
    expect(conflictingWrite).toHaveBeenCalledWith(AGENT, CHAT, 'glm-5.3-flash', 4)

    // The rejected intent is never piggybacked and the effective model stays the
    // last confirmed one; capability is withheld until the refetch lands.
    const conflictedView = readHostModelSelection(AGENT, CHAT)
    expect(conflictedView.effectiveModel).toBe('glm-5.3')
    expect(conflictedView.intentModel).toBeNull()
    expect(conflictedView.conflicted).toBe(true)
    expect(conflictedView.visualSendBlocked).toBe(true)
    expect(getHostModels).toHaveBeenCalledTimes(2)
    // Never trust the rejected snapshot's capability while the conflict stands.
    expect(conflictedView.imageInput.state).toBe('unknown')

    resolveRefetch?.(baseResult({ sessionModel: 'glm-5.3', modelSelectionRevision: 9 }))
    await vi.waitFor(() => {
      expect(readHostModelSelection(AGENT, CHAT).conflicted).toBe(false)
    })
    expect(readHostModelSelection(AGENT, CHAT).confirmedRevision).toBe(9)
  })
})

describe('hostModelSelectionStore — allowlist rejection', () => {
  it('preserves a newer intent migrated by the send path during an older rejection', async () => {
    const write = deferred<SetHostModelResult>()
    const { transport } = makeTransport({ setHostModel: () => write.promise })
    const first = selectHostModel(transport, AGENT, CHAT, 'removed-model')
    // Pre-chat migration uses this entry point, independently of the POST queue.
    setPendingModelIntent(AGENT, CHAT, 'glm-5.3-flash')
    write.reject(new Error('model_not_allowed'))
    expect(await first).toBe(false)
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      effectiveModel: 'glm-5.3-flash',
      intentModel: 'glm-5.3-flash',
      pending: true,
    })
  })
  it('applies the newer queued choice after the old choice is rejected', async () => {
    const older = deferred<SetHostModelResult>()
    const setHostModel = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({
        effective: 'next-task',
        provider: 'zai',
        model: 'glm-5.3-flash',
        modelSelectionRevision: 5,
      })
    const { transport } = makeTransport({
      getHostModels: async () => baseResult({ modelSelectionRevision: 4 }),
      setHostModel,
    })
    await loadHostModels(transport, AGENT, CHAT)
    const first = selectHostModel(transport, AGENT, CHAT, 'removed-model')
    await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    older.reject(new Error('model_not_allowed'))
    expect(await first).toBe(true)
    expect(setHostModel).toHaveBeenLastCalledWith(AGENT, CHAT, 'glm-5.3-flash', 4)
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      effectiveModel: 'glm-5.3-flash',
      confirmedRevision: 5,
      pending: false,
    })
  })
  it('drops the optimistic intent and surfaces the targeted error', async () => {
    const { transport } = makeTransport({
      setHostModel: vi.fn(async () => {
        throw new Error('Set host model rejected (model_not_allowed)')
      }),
    })
    const ok = await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')

    expect(ok).toBe(false)
    const view = readHostModelSelection(AGENT, CHAT)
    expect(view.intentModel).toBeNull()
    expect(view.error).toMatch(/no longer allowed/)
  })
})

describe('hostModelSelectionStore — subscriptions', () => {
  it('publishes a stable snapshot that changes only when the entry changes', async () => {
    const { transport } = makeTransport()
    const before = getHostModelSelectionSnapshot(AGENT, CHAT)
    expect(before).toBe(getHostModelSelectionSnapshot(AGENT, CHAT))

    await loadHostModels(transport, AGENT, CHAT)
    expect(getHostModelSelectionSnapshot(AGENT, CHAT)).not.toBe(before)
    expect(getHostModelSelectionSnapshot(AGENT, CHAT).effectiveModel).toBe('glm-5.3')
  })
})
