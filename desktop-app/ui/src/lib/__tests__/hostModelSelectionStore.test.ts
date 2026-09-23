// @vitest-environment jsdom
import { type Mock, afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { HostModelsResult, SetHostModelResult } from '../../../../src/types'
import {
  getPendingModelIntent,
  getPreChatModelIntent,
  setPendingModelIntent,
  setPreChatModelIntent,
} from '../hostModelIntentStore'
import {
  type HostModelSelectionTransport,
  confirmHostModelSelectionFromSend,
  getHostModelSelectionSnapshot,
  loadHostModels,
  noteHostModelSelectionConflict,
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
      { name: 'glm-5.3', imageInput: { state: 'unsupported', reason: 'model_unsupported' } },
      { name: 'glm-5.3-flash', imageInput: { state: 'supported', reason: 'supported' } },
    ],
    ...overrides,
  }
}

/**
 * The returned spies are read back OFF the resolved transport, never off the
 * defaults. Returning the defaults means a test that overrides a member asserts
 * against a function nobody calls, and every such assertion — especially a
 * negative one — passes vacuously.
 */
function makeTransport(overrides: Partial<HostModelSelectionTransport> = {}) {
  const transport: HostModelSelectionTransport = {
    getHostModels: vi.fn(async () => baseResult()),
    setHostModel: vi.fn(
      async (_agentRef: string, _chatId: string, model: string): Promise<SetHostModelResult> => ({
        effective: 'next-task',
        provider: 'zai',
        model,
      })
    ),
    ...overrides,
  }
  return {
    transport,
    getHostModels: transport.getHostModels as Mock<HostModelSelectionTransport['getHostModels']>,
    setHostModel: transport.setHostModel as Mock<HostModelSelectionTransport['setHostModel']>,
  }
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
    const { transport } = makeTransport({
      setHostModel: suspendedWrite,
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ok = await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')

    expect(ok).toBe(true)
    expect(suspendedWrite).toHaveBeenCalledTimes(1)
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

describe('hostModelSelectionStore — list fetch failure', () => {
  // #654 M7 — `data === null` is the HOST's answer ("I predate the model
  // endpoint"). A thrown fetch knows nothing, so it must not borrow that answer
  // and must not be reported as a capability verdict about the model.
  it('reports a fetch failure as a load error, not as unverified evidence', async () => {
    const getHostModels = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const { transport } = makeTransport({ getHostModels })

    await loadHostModels(transport, AGENT, CHAT)

    const view = readHostModelSelection(AGENT, CHAT)
    // Witness: the fetch really ran and really settled, so the assertions below
    // describe a decision rather than an untouched initial state.
    expect(getHostModels).toHaveBeenCalledTimes(1)
    expect(view.loading).toBe(false)
    expect(view.state).toBe('error')
    expect(view.error).toMatch(/could not be loaded/)
    expect(view.loadError).toMatch(/could not be loaded/)
    expect(view.imageBlockMessage).toMatch(/could not be loaded/)
    expect(view.imageBlockMessage).not.toMatch(/not verified/)
    expect(view.canAttachImages).toBe(false)
  })

  it('says the first load is checking, not that the model lacks evidence', async () => {
    const firstRead = deferred<HostModelsResult>()
    const getHostModels = vi
      .fn<HostModelSelectionTransport['getHostModels']>()
      .mockReturnValueOnce(firstRead.promise)
    const { transport } = makeTransport({ getHostModels })

    const pending = loadHostModels(transport, AGENT, CHAT)
    const during = readHostModelSelection(AGENT, CHAT)
    expect(getHostModels).toHaveBeenCalledTimes(1)
    expect(during.loading).toBe(true)
    expect(during.visualSendBlocked).toBe(true)
    expect(during.imageBlockMessage).toMatch(/^Checking the model’s image support/)
    expect(during.imageBlockMessage).not.toMatch(/operator/)

    firstRead.resolve(baseResult({ sessionModel: 'glm-5.3-flash' }))
    await pending
    const after = readHostModelSelection(AGENT, CHAT)
    expect(after.canAttachImages).toBe(true)
    expect(after.imageBlockMessage).toBeNull()
  })

  // Closing the OS file picker refocuses the window, and the focus listener
  // forces a refetch right before the picked files arrive. A refetch over a
  // settled read must not turn a supported model into "checking".
  it('keeps a settled capability while a forced background refetch is in flight', async () => {
    const refetch = deferred<HostModelsResult>()
    const getHostModels = vi
      .fn<HostModelSelectionTransport['getHostModels']>()
      .mockResolvedValueOnce(baseResult({ sessionModel: 'glm-5.3-flash' }))
      .mockReturnValueOnce(refetch.promise)
    const { transport } = makeTransport({ getHostModels })
    await loadHostModels(transport, AGENT, CHAT)
    expect(readHostModelSelection(AGENT, CHAT).canAttachImages).toBe(true)

    const pending = loadHostModels(transport, AGENT, CHAT, { force: true })
    const during = readHostModelSelection(AGENT, CHAT)
    // Witness: the refetch is really in flight while capability is read.
    expect(getHostModels).toHaveBeenCalledTimes(2)
    expect(during.loading).toBe(true)
    expect(during.imageInput.state).toBe('supported')
    expect(during.canAttachImages).toBe(true)
    expect(during.visualSendBlocked).toBe(false)
    expect(during.imageBlockMessage).toBeNull()

    refetch.resolve(baseResult({ sessionModel: 'glm-5.3-flash' }))
    await pending
    const after = readHostModelSelection(AGENT, CHAT)
    expect(after.loading).toBe(false)
    expect(after.canAttachImages).toBe(true)
  })

  it('applies the refetched selection when it lands during a background refetch', async () => {
    const refetch = deferred<HostModelsResult>()
    const getHostModels = vi
      .fn<HostModelSelectionTransport['getHostModels']>()
      .mockResolvedValueOnce(baseResult({ sessionModel: 'glm-5.3-flash' }))
      .mockReturnValueOnce(refetch.promise)
    const { transport } = makeTransport({ getHostModels })
    await loadHostModels(transport, AGENT, CHAT)

    const pending = loadHostModels(transport, AGENT, CHAT, { force: true })
    expect(readHostModelSelection(AGENT, CHAT).canAttachImages).toBe(true)

    // Another client moved this chat to a text-only model.
    refetch.resolve(baseResult({ sessionModel: 'glm-5.3', modelSelectionRevision: 8 }))
    await pending
    const after = readHostModelSelection(AGENT, CHAT)
    expect(getHostModels).toHaveBeenCalledTimes(2)
    expect(after.effectiveModel).toBe('glm-5.3')
    expect(after.imageInput.state).toBe('unsupported')
    expect(after.visualSendBlocked).toBe(true)
  })

  it('keeps a previous good read usable when a later fetch fails', async () => {
    const getHostModels = vi
      .fn()
      .mockResolvedValueOnce(
        baseResult({ sessionModel: 'glm-5.3-flash', modelSelectionRevision: 2 })
      )
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const { transport } = makeTransport({ getHostModels })

    await loadHostModels(transport, AGENT, CHAT)
    await loadHostModels(transport, AGENT, CHAT, { force: true })

    const view = readHostModelSelection(AGENT, CHAT)
    expect(getHostModels).toHaveBeenCalledTimes(2)
    // The failure does not erase what we already know: the list stays usable and
    // the state stays `ready`, only the inline error reports the failed refresh.
    expect(view.state).toBe('ready')
    expect(view.effectiveModel).toBe('glm-5.3-flash')
    expect(view.canAttachImages).toBe(true)
    expect(view.loadError).toBeNull()
    expect(view.error).toMatch(/could not be loaded/)
  })
})

describe('hostModelSelectionStore — serialized, coalesced writes', () => {
  // #654 L7 — an A→B→A sequence leaves a newer intent for A that the accepted A
  // write already satisfies. Comparing the intent against what we SENT (plus a
  // sequence guard) left it pending forever; comparing it against what the
  // SERVER confirmed clears it.
  it('clears an A→B→A intent once the A write is acknowledged', async () => {
    const write = deferred<SetHostModelResult>()
    const { transport, setHostModel } = makeTransport({
      setHostModel: vi.fn(() => write.promise),
    })

    const first = selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    await selectHostModel(transport, AGENT, CHAT, 'glm-5.3')
    await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    expect(readHostModelSelection(AGENT, CHAT).intentModel).toBe('glm-5.3-flash')

    write.resolve({
      effective: 'next-task',
      provider: 'zai',
      model: 'glm-5.3-flash',
      modelSelectionRevision: 3,
    })
    expect(await first).toBe(true)

    // Witness: the queued A was NOT re-written, because it equals the model the
    // server just confirmed — one write, and no lingering pending state.
    expect(setHostModel).toHaveBeenCalledTimes(1)
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      intentModel: null,
      pending: false,
      effectiveModel: 'glm-5.3-flash',
      confirmedRevision: 3,
    })
  })

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
  it('retries a newer queued choice on the revision the refetch adopted', async () => {
    const firstWrite = deferred<SetHostModelResult>()
    const secondWrite = deferred<SetHostModelResult>()
    const refetch = deferred<HostModelsResult>()
    const setHostModel = vi
      .fn<HostModelSelectionTransport['setHostModel']>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise)
    const { transport } = makeTransport({
      getHostModels: vi
        .fn()
        .mockResolvedValueOnce(baseResult({ sessionModel: 'glm-5.3', modelSelectionRevision: 4 }))
        .mockImplementation(() => refetch.promise),
      setHostModel,
    })
    await loadHostModels(transport, AGENT, CHAT)
    const older = selectHostModel(transport, AGENT, CHAT, 'glm-5.3')
    // Arrives while the older write is in flight, so it is queued, not written.
    await selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    firstWrite.reject(new Error('model_selection_conflict'))

    await vi.waitFor(() => {
      expect(readHostModelSelection(AGENT, CHAT).conflicted).toBe(true)
    })
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      intentModel: 'glm-5.3-flash',
      visualSendBlocked: true,
    })
    expect(setHostModel).toHaveBeenCalledTimes(1)

    refetch.resolve(baseResult({ sessionModel: 'glm-5.3', modelSelectionRevision: 9 }))

    // #654 M4 — the queued pick is retried instead of being dropped, and it is
    // armed with revision 9: the one the authoritative read just adopted, not
    // the stale 4 the conflicting write used.
    await vi.waitFor(() => {
      expect(setHostModel).toHaveBeenCalledTimes(2)
    })
    expect(setHostModel).toHaveBeenLastCalledWith(AGENT, CHAT, 'glm-5.3-flash', 9)

    secondWrite.resolve({
      effective: 'next-task',
      provider: 'zai',
      model: 'glm-5.3-flash',
      modelSelectionRevision: 10,
    })
    expect(await older).toBe(true)
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      intentModel: null,
      pending: false,
      conflicted: false,
      confirmedRevision: 10,
      effectiveModel: 'glm-5.3-flash',
      visualSendBlocked: false,
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

    // #654 M4 — the write no longer settles at the conflict: it awaits the
    // authoritative read, because that read carries the revision a retry must
    // be armed with. So hold the promise and inspect the interim state.
    const pendingSelect = selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    await vi.waitFor(() => {
      expect(readHostModelSelection(AGENT, CHAT).conflicted).toBe(true)
    })
    expect(conflictingWrite).toHaveBeenCalledWith(AGENT, CHAT, 'glm-5.3-flash', 4)

    // The rejected intent is never piggybacked and the effective model stays the
    // last confirmed one; capability is withheld until the refetch lands.
    const conflictedView = readHostModelSelection(AGENT, CHAT)
    expect(conflictedView.effectiveModel).toBe('glm-5.3')
    expect(conflictedView.intentModel).toBeNull()
    expect(conflictedView.visualSendBlocked).toBe(true)
    // Witness: the forced re-read is in flight, and it did not wipe the conflict
    // message the user needs to see while it runs.
    expect(getHostModels).toHaveBeenCalledTimes(2)
    expect(conflictedView.loading).toBe(true)
    expect(conflictedView.error).toBe(
      'This chat’s model was changed elsewhere — re-checking the current selection.'
    )
    // Never trust the rejected snapshot's capability while the conflict stands.
    expect(conflictedView.imageInput.state).toBe('unknown')

    resolveRefetch?.(baseResult({ sessionModel: 'glm-5.3', modelSelectionRevision: 9 }))
    expect(await pendingSelect).toBe(false)
    expect(readHostModelSelection(AGENT, CHAT).conflicted).toBe(false)
    expect(readHostModelSelection(AGENT, CHAT).confirmedRevision).toBe(9)
    // The re-check landed: the message now says the pick was not applied, and it
    // stays until the user picks again.
    expect(readHostModelSelection(AGENT, CHAT).error).toBe(
      'This chat’s model was changed elsewhere — your model choice was not applied.'
    )
    // No newer pick was queued, so the conflict is terminal: exactly one write.
    expect(conflictingWrite).toHaveBeenCalledTimes(1)
  })

  describe('a pick made during the re-read that follows a conflict', () => {
    // The desktop holds m-a at revision 4; another client already moved the
    // session to m-x at revision 5. The pick of m-b conflicts, and the next pick
    // lands while the forced re-read is in flight, superseding that read.
    function conflictDuringReread() {
      const refetch = deferred<HostModelsResult>()
      const setHostModel = vi
        .fn<HostModelSelectionTransport['setHostModel']>()
        .mockRejectedValueOnce(new Error('Set host model conflicted (model_selection_conflict)'))
        .mockImplementation(async (_agentRef, _chatId, model) => ({
          effective: 'next-task',
          provider: 'zai',
          model,
          modelSelectionRevision: 6,
        }))
      const getHostModels = vi
        .fn<HostModelSelectionTransport['getHostModels']>()
        .mockResolvedValueOnce(baseResult({ sessionModel: 'm-a', modelSelectionRevision: 4 }))
        .mockImplementation(() => refetch.promise)
      const { transport } = makeTransport({ getHostModels, setHostModel })
      return { transport, refetch, setHostModel, getHostModels }
    }

    async function pickDuringReread(model: string) {
      const scenario = conflictDuringReread()
      const { transport, refetch, setHostModel, getHostModels } = scenario
      await loadHostModels(transport, AGENT, CHAT)
      const first = selectHostModel(transport, AGENT, CHAT, 'm-b')
      await vi.waitFor(() => {
        expect(readHostModelSelection(AGENT, CHAT).conflicted).toBe(true)
      })
      // Witness: the conflicting write ran on revision 4 and the re-read is in
      // flight when the next pick lands.
      expect(setHostModel).toHaveBeenNthCalledWith(1, AGENT, CHAT, 'm-b', 4)
      expect(getHostModels).toHaveBeenCalledTimes(2)
      expect(readHostModelSelection(AGENT, CHAT).loading).toBe(true)

      expect(await selectHostModel(transport, AGENT, CHAT, model)).toBe(true)
      refetch.resolve(baseResult({ sessionModel: 'm-x', modelSelectionRevision: 5 }))
      return { first: await first, setHostModel }
    }

    it('sends a new model on the revision the superseded re-read reported', async () => {
      const { first, setHostModel } = await pickDuringReread('m-c')

      expect(setHostModel).toHaveBeenCalledTimes(2)
      expect(setHostModel).toHaveBeenLastCalledWith(AGENT, CHAT, 'm-c', 5)
      expect(first).toBe(true)
      expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
        effectiveModel: 'm-c',
        intentModel: null,
        pending: false,
        conflicted: false,
        confirmedRevision: 6,
        error: null,
      })
    })

    it('sends the pre-conflict model when the server holds another one', async () => {
      const { first, setHostModel } = await pickDuringReread('m-a')

      // m-a equals the model this client held before the conflict, but the
      // server holds m-x, so the pick must still be written.
      expect(setHostModel).toHaveBeenCalledTimes(2)
      expect(setHostModel).toHaveBeenLastCalledWith(AGENT, CHAT, 'm-a', 5)
      expect(first).toBe(true)
      expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
        effectiveModel: 'm-a',
        intentModel: null,
        conflicted: false,
        confirmedRevision: 6,
      })
    })

    it('settles without a write when the server already holds the pick', async () => {
      const { first, setHostModel } = await pickDuringReread('m-x')

      // Witness: the conflicting write happened; the pick of m-x needs no second one.
      expect(setHostModel).toHaveBeenCalledTimes(1)
      expect(first).toBe(true)
      expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
        effectiveModel: 'm-x',
        intentModel: null,
        pending: false,
        conflicted: false,
        confirmedRevision: 5,
        error: null,
      })
    })
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

describe('hostModelSelectionStore — revision monotonicity', () => {
  it('keeps the newer ack revision when an older write reply lands late', async () => {
    const write = deferred<SetHostModelResult>()
    const { transport, setHostModel } = makeTransport({
      getHostModels: async () => baseResult({ sessionModel: 'glm-5.3', modelSelectionRevision: 4 }),
      setHostModel: vi.fn(() => write.promise),
    })
    await loadHostModels(transport, AGENT, CHAT)
    expect(readHostModelSelection(AGENT, CHAT).confirmedRevision).toBe(4)

    const selecting = selectHostModel(transport, AGENT, CHAT, 'glm-5.3-flash')
    await vi.waitFor(() => expect(setHostModel).toHaveBeenCalledTimes(1))
    expect(setHostModel).toHaveBeenLastCalledWith(AGENT, CHAT, 'glm-5.3-flash', 4)

    // A send ack lands while the write is in flight and raises the CAS base.
    confirmHostModelSelectionFromSend(AGENT, CHAT, 'glm-5.3', 7)
    expect(readHostModelSelection(AGENT, CHAT).confirmedRevision).toBe(7)

    write.resolve({
      effective: 'next-task',
      provider: 'zai',
      model: 'glm-5.3-flash',
      modelSelectionRevision: 5,
    })
    // Witness: the write path ran to completion and processed the reply.
    expect(await selecting).toBe(true)
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      confirmedRevision: 7,
      selectionUnsettled: false,
    })
  })

  type RevisionEvent =
    | { kind: 'ack'; model: string; revision: number }
    | { kind: 'read'; model: string; revision: number }
    | { kind: 'conflict'; model: string; revision: number }
    | { kind: 'write-start'; model: string }
    | { kind: 'write-reply'; revision: number }

  const modelArb = fc.constantFrom('glm-5.3', 'glm-5.3-flash')
  const revisionArb = fc.integer({ min: 0, max: 12 })
  const eventArb: fc.Arbitrary<RevisionEvent> = fc.oneof(
    fc.record({ kind: fc.constant('ack' as const), model: modelArb, revision: revisionArb }),
    fc.record({ kind: fc.constant('read' as const), model: modelArb, revision: revisionArb }),
    fc.record({ kind: fc.constant('conflict' as const), model: modelArb, revision: revisionArb }),
    fc.record({ kind: fc.constant('write-start' as const), model: modelArb }),
    fc.record({ kind: fc.constant('write-reply' as const), revision: revisionArb })
  )

  /** Lets the store's awaited transport replies and follow-up reads settle. */
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

  it('never lowers confirmedRevision and is idempotent under replayed ack/read/conflict events', async () => {
    const witness = { staleWriteReplies: 0, replays: 0, adoptions: 0 }

    await fc.assert(
      fc.asyncProperty(fc.array(eventArb, { minLength: 1, maxLength: 16 }), async events => {
        resetHostModelSelectionStore()
        let readRevision = 0
        let readModel: string | null = null
        const pendingWrites: Array<{
          model: string
          resolve: (value: SetHostModelResult) => void
        }> = []
        const { transport } = makeTransport({
          getHostModels: async () =>
            baseResult({ sessionModel: readModel, modelSelectionRevision: readRevision }),
          setHostModel: (_agentRef, _chatId, model) => {
            const write = deferred<SetHostModelResult>()
            pendingWrites.push({ model, resolve: write.resolve })
            return write.promise
          },
        })

        const apply = async (event: RevisionEvent): Promise<void> => {
          switch (event.kind) {
            case 'ack':
              confirmHostModelSelectionFromSend(AGENT, CHAT, event.model, event.revision)
              return
            case 'read':
              readRevision = event.revision
              readModel = event.model
              await loadHostModels(transport, AGENT, CHAT, { force: true })
              return
            case 'conflict':
              // The Host reports the winning revision and the re-read observes it.
              readRevision = event.revision
              readModel = event.model
              noteHostModelSelectionConflict(transport, AGENT, CHAT, event.model, event.revision)
              await settle()
              return
            case 'write-start':
              void selectHostModel(transport, AGENT, CHAT, event.model)
              await settle()
              return
            case 'write-reply': {
              const head = pendingWrites.shift()
              if (!head) return
              const held = readHostModelSelection(AGENT, CHAT).confirmedRevision
              if (held !== null && event.revision < held) witness.staleWriteReplies += 1
              head.resolve({
                effective: 'next-task',
                provider: 'zai',
                model: head.model,
                modelSelectionRevision: event.revision,
              })
              await settle()
              return
            }
          }
        }

        let previous: number | null = null
        const expectNotLowered = () => {
          const current = readHostModelSelection(AGENT, CHAT).confirmedRevision
          if (previous !== null) {
            expect(current).not.toBeNull()
            expect(current as number).toBeGreaterThanOrEqual(previous)
          }
          if (current !== previous) witness.adoptions += 1
          previous = current
        }

        for (const event of events) {
          await apply(event)
          expectNotLowered()
          if (event.kind === 'ack' || event.kind === 'read' || event.kind === 'conflict') {
            const once = readHostModelSelection(AGENT, CHAT)
            await apply(event)
            witness.replays += 1
            expect(readHostModelSelection(AGENT, CHAT)).toEqual(once)
            expectNotLowered()
          }
        }
        // Drain writes still in flight (including queued picks they pick up).
        while (pendingWrites.length > 0) {
          await apply({ kind: 'write-reply', revision: 0 })
          expectNotLowered()
        }
      }),
      { numRuns: 300 }
    )

    // Witnesses: the adversarial interleaving (a write reply older than the held
    // revision) was generated, replays ran, and revisions were actually adopted.
    expect(witness.staleWriteReplies).toBeGreaterThan(0)
    expect(witness.replays).toBeGreaterThan(0)
    expect(witness.adoptions).toBeGreaterThan(0)
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

describe('hostModelSelectionStore — reset', () => {
  it('one reset clears the selection entries and the pending intents', async () => {
    const { transport } = makeTransport()
    await loadHostModels(transport, AGENT, CHAT)
    setPendingModelIntent(AGENT, CHAT, 'glm-5.3-flash')
    setPreChatModelIntent(AGENT, 'glm-5.3-flash')
    // Witnesses: all three pieces of state exist before the reset.
    expect(readHostModelSelection(AGENT, CHAT).effectiveModel).toBe('glm-5.3-flash')
    expect(getPendingModelIntent(AGENT, CHAT)).toBe('glm-5.3-flash')
    expect(getPreChatModelIntent(AGENT)).toBe('glm-5.3-flash')

    resetHostModelSelectionStore()

    expect(getPendingModelIntent(AGENT, CHAT)).toBeUndefined()
    expect(getPreChatModelIntent(AGENT)).toBeUndefined()
    expect(readHostModelSelection(AGENT, CHAT)).toMatchObject({
      intentModel: null,
      effectiveModel: '',
    })
  })
})
