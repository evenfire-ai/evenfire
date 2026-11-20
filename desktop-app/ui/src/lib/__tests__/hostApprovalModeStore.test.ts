// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type HostApprovalModeTransport,
  type SessionApprovalSnapshot,
  approvalModeForFirstSend,
  beginApprovalModeFirstSend,
  clearHostApprovalModeSaveFailure,
  confirmHeldApprovalModeFromSend,
  hostApprovalModeEpoch,
  migrateHeldApprovalMode,
  noteHostApprovalModeFromSession,
  readHostApprovalMode,
  refreshHostApprovalModeLimit,
  resetHostApprovalModeStore,
  selectHostApprovalMode,
  subscribeHostApprovalMode,
} from '../hostApprovalModeStore'

const AGENT = 'trader'
const CHAT = 'chat-1'

function snapshot(
  mode: SessionApprovalSnapshot['approvalMode'],
  extras: Partial<SessionApprovalSnapshot> = {}
): SessionApprovalSnapshot {
  return {
    approvalMode: mode,
    modeCeiling: 'allow_all',
    channelCap: 'allow_all',
    effectiveApprovalMode: mode,
    shellClassifierAvailable: true,
    ...extras,
  }
}

function transport(overrides: Partial<HostApprovalModeTransport> = {}) {
  const setApprovalMode = vi.fn(async () => snapshot('auto'))
  const readSessionApproval = vi.fn(async () => snapshot('manual'))
  const client: HostApprovalModeTransport = {
    setApprovalMode,
    readSessionApproval,
    ...overrides,
  }
  return { client, setApprovalMode, readSessionApproval }
}

afterEach(() => {
  resetHostApprovalModeStore()
  vi.restoreAllMocks()
})

describe('hostApprovalModeStore', () => {
  it('does not PATCH while chatId is null', async () => {
    const { client, setApprovalMode, readSessionApproval } = transport()
    await selectHostApprovalMode(client, AGENT, null, 'auto')
    expect(setApprovalMode).not.toHaveBeenCalled()
    expect(readSessionApproval).not.toHaveBeenCalled()
  })

  it('the first send carries the held mode', async () => {
    const { client } = transport()
    await selectHostApprovalMode(client, AGENT, null, 'auto')
    expect(approvalModeForFirstSend(AGENT, null)).toBe('auto')

    await selectHostApprovalMode(client, AGENT, null, 'manual')
    expect(approvalModeForFirstSend(AGENT, null)).toBeNull()
  })

  it('paints Allow all from the next session read when the transport fails after the server committed it', async () => {
    const { client, setApprovalMode, readSessionApproval } = transport()
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'))
    expect(readHostApprovalMode(AGENT, CHAT).label).toBeNull()

    setApprovalMode.mockRejectedValue(new Error('fetch failed'))
    readSessionApproval.mockResolvedValue(snapshot('allow_all'))

    await selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')

    expect(setApprovalMode).toHaveBeenCalledWith(AGENT, CHAT, 'allow_all')
    expect(readSessionApproval).toHaveBeenCalledTimes(1)
    expect(readSessionApproval).toHaveBeenCalledWith(AGENT, CHAT)
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Allow all')
    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('allow_all')
  })

  it('a 404 for a chat the store has not seen on the Host holds the mode for the first send', async () => {
    const { client, setApprovalMode, readSessionApproval } = transport()
    // No session read for CHAT: its row may not exist yet.
    setApprovalMode.mockRejectedValue(new Error('Set approval mode failed (404)'))

    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')).resolves.toBe(true)

    expect(readSessionApproval).not.toHaveBeenCalled()
    expect(approvalModeForFirstSend(AGENT, CHAT)).toBe('allow_all')
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Allow all')
  })

  it('a 404 for a chat the Host already reported keeps its label and counts as not saved', async () => {
    const { client, setApprovalMode, readSessionApproval } = transport()
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('allow_all'))
    setApprovalMode.mockRejectedValue(new Error('Set approval mode failed (404)'))

    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'manual')).resolves.toBe(false)

    expect(setApprovalMode).toHaveBeenCalledWith(AGENT, CHAT, 'manual')
    expect(readSessionApproval).not.toHaveBeenCalled()
    const view = readHostApprovalMode(AGENT, CHAT)
    expect(view.label).toBe('Allow all')
    expect(view.effectiveMode).toBe('allow_all')
    expect(view.saveFailed).toBe(true)
    expect(view.firstSendMode).toBeNull()
    // Not a hold: the next send neither carries a mode nor locks the picker.
    const send = beginApprovalModeFirstSend(AGENT, CHAT)
    expect(send.mode).toBeNull()
    expect(readHostApprovalMode(AGENT, CHAT).firstSendInFlight).toBe(false)
    send.release()
  })

  it('a 404 that is not the session answer is a failed save, not a hold', async () => {
    const { client, setApprovalMode, readSessionApproval } = transport()
    // The main process's message for a 404 without mcp-host's "session not
    // found" body (rpcProxyClient.setApprovalMode).
    setApprovalMode.mockRejectedValue(
      new Error('Set approval mode failed (404, not a session answer)')
    )
    readSessionApproval.mockRejectedValue(new Error('Load session messages failed (404)'))

    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'auto')).resolves.toBe(false)

    expect(setApprovalMode).toHaveBeenCalledWith(AGENT, CHAT, 'auto')
    expect(approvalModeForFirstSend(AGENT, CHAT)).toBeNull()
    expect(readHostApprovalMode(AGENT, CHAT).label).toBeNull()
    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(true)
  })

  it('refuses a change while the first send is in flight, and PATCHes once it is acknowledged', async () => {
    const { client, setApprovalMode } = transport()
    await selectHostApprovalMode(client, AGENT, null, 'allow_all')
    migrateHeldApprovalMode(AGENT, CHAT)

    const send = beginApprovalModeFirstSend(AGENT, CHAT)
    expect(send.mode).toBe('allow_all')
    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'manual')).resolves.toBe(false)

    expect(setApprovalMode).not.toHaveBeenCalled()
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Allow all')
    expect(readHostApprovalMode(AGENT, CHAT).firstSendMode).toBe('allow_all')
    expect(readHostApprovalMode(AGENT, CHAT).firstSendInFlight).toBe(true)

    confirmHeldApprovalModeFromSend(AGENT, CHAT)
    send.release()
    send.release()
    expect(readHostApprovalMode(AGENT, CHAT).firstSendInFlight).toBe(false)

    setApprovalMode.mockResolvedValue(snapshot('manual'))
    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'manual')).resolves.toBe(true)
    expect(setApprovalMode).toHaveBeenCalledWith(AGENT, CHAT, 'manual')
    expect(readHostApprovalMode(AGENT, CHAT).label).toBeNull()
  })

  it('unlocks the picker when the first send fails without an ack', async () => {
    const { client, setApprovalMode } = transport()
    const send = beginApprovalModeFirstSend(AGENT, CHAT)
    expect(send.mode).toBeNull()
    expect(readHostApprovalMode(AGENT, CHAT).firstSendInFlight).toBe(true)

    send.release()
    setApprovalMode.mockRejectedValue(new Error('Set approval mode failed (404)'))
    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'auto')).resolves.toBe(true)

    expect(setApprovalMode).toHaveBeenCalledWith(AGENT, CHAT, 'auto')
    expect(approvalModeForFirstSend(AGENT, CHAT)).toBe('auto')
  })

  it('does not lock a chat the server already has', async () => {
    const { client, setApprovalMode } = transport()
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'))

    const send = beginApprovalModeFirstSend(AGENT, CHAT)
    expect(readHostApprovalMode(AGENT, CHAT).firstSendInFlight).toBe(false)
    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'auto')).resolves.toBe(true)

    expect(setApprovalMode).toHaveBeenCalledWith(AGENT, CHAT, 'auto')
    send.release()
  })

  it('a 404 that answers after the first send began neither paints nor holds the mode', async () => {
    let rejectPatch!: (error: Error) => void
    const { client, readSessionApproval } = transport({
      setApprovalMode: vi.fn(
        () =>
          new Promise<SessionApprovalSnapshot>((_resolve, reject) => {
            rejectPatch = reject
          })
      ),
    })
    await selectHostApprovalMode(client, AGENT, null, 'allow_all')
    migrateHeldApprovalMode(AGENT, CHAT)

    const write = selectHostApprovalMode(client, AGENT, CHAT, 'manual')
    expect(client.setApprovalMode).toHaveBeenCalledWith(AGENT, CHAT, 'manual')
    const send = beginApprovalModeFirstSend(AGENT, CHAT)
    expect(send.mode).toBe('allow_all')
    rejectPatch(new Error('Set approval mode failed (404)'))

    await expect(write).resolves.toBe(false)
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Allow all')
    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('allow_all')
    expect(approvalModeForFirstSend(AGENT, CHAT)).toBe('allow_all')
    expect(readSessionApproval).not.toHaveBeenCalled()
    send.release()
  })

  it('a session read from before a write does not paint the old mode', async () => {
    const { client, setApprovalMode } = transport()
    const epoch = hostApprovalModeEpoch(AGENT, CHAT)
    setApprovalMode.mockResolvedValue(snapshot('allow_all'))

    await selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'), epoch)

    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('allow_all')
  })

  it('a read that starts during a write and answers after it does not paint the old mode', async () => {
    let resolvePatch!: (value: SessionApprovalSnapshot) => void
    const { client } = transport({
      setApprovalMode: vi.fn(
        () =>
          new Promise<SessionApprovalSnapshot>(resolve => {
            resolvePatch = resolve
          })
      ),
    })
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('auto'))

    const write = selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')
    // The server may answer this read before the PATCH lands.
    const readDuringWrite = hostApprovalModeEpoch(AGENT, CHAT)
    resolvePatch(snapshot('allow_all'))
    await expect(write).resolves.toBe(true)

    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('auto'), readDuringWrite)
    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('allow_all')

    // A read that starts after the write completed is applied.
    const readAfterWrite = hostApprovalModeEpoch(AGENT, CHAT)
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'), readAfterWrite)
    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('manual')
  })

  it('a catalog read after a write still updates that chat', async () => {
    const { client, setApprovalMode } = transport()
    setApprovalMode.mockResolvedValue(snapshot('auto'))
    await selectHostApprovalMode(client, AGENT, CHAT, 'auto')

    const catalogSeq = hostApprovalModeEpoch(AGENT, null)
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('allow_all'), catalogSeq)

    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('allow_all')
  })

  it('a read captured before a scope reset cannot paint over the next write', async () => {
    const { client, setApprovalMode } = transport()
    setApprovalMode.mockResolvedValue(snapshot('auto'))
    await selectHostApprovalMode(client, AGENT, CHAT, 'auto')
    const readSeq = hostApprovalModeEpoch(AGENT, CHAT)

    resetHostApprovalModeStore()
    setApprovalMode.mockResolvedValue(snapshot('allow_all'))
    await selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'), readSeq)

    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('allow_all')
  })

  it('a catalog read started before a write does not paint the old mode', async () => {
    const { client, setApprovalMode } = transport()
    const catalogSeq = hostApprovalModeEpoch(AGENT, null)
    setApprovalMode.mockResolvedValue(snapshot('allow_all'))
    await selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')

    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'), catalogSeq)

    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('allow_all')
  })

  it.each([400, 401])('a %s keeps the old label without a re-read', async status => {
    const { client, setApprovalMode, readSessionApproval } = transport()
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('auto'))
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Auto-approve')

    setApprovalMode.mockRejectedValue(new Error(`Set approval mode failed (${status})`))
    await selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')

    expect(readSessionApproval).not.toHaveBeenCalled()
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Auto-approve')
    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('auto')
  })
})

describe('hostApprovalModeStore — Host limit', () => {
  const OTHER = 'chat-2'

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(res => {
      resolve = res
    })
    return { promise, resolve }
  }

  it('leaves a blank chat’s limit unknown until any session of the Host is read, then follows its ceiling', () => {
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBeNull()
    const listener = vi.fn()
    const unsubscribe = subscribeHostApprovalMode(AGENT, null, listener)

    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual', { modeCeiling: 'auto' }))

    expect(listener).toHaveBeenCalled()
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBe('auto')
    // Another Host's ceiling is its own.
    expect(readHostApprovalMode('other-host', null).modeLimit).toBeNull()
    unsubscribe()
  })

  it('limits a chat the Host answered for by its own ceiling and channel cap', () => {
    noteHostApprovalModeFromSession(
      AGENT,
      CHAT,
      snapshot('allow_all', {
        modeCeiling: 'allow_all',
        channelCap: 'manual',
        effectiveApprovalMode: 'manual',
      })
    )

    const view = readHostApprovalMode(AGENT, CHAT)
    expect(view.modeLimit).toBe('manual')
    expect(view.storedMode).toBe('allow_all')
    expect(view.effectiveMode).toBe('manual')
    expect(view.label).toBeNull()
    // The blank chat is a Desktop chat: only the Host ceiling limits it.
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBe('allow_all')
  })

  it('caps a blank-chat hold by a known ceiling and keeps the pick for the first send', async () => {
    const { client } = transport()
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual', { modeCeiling: 'manual' }))

    await expect(selectHostApprovalMode(client, AGENT, null, 'allow_all')).resolves.toBe(true)

    const view = readHostApprovalMode(AGENT, null)
    expect(view.storedMode).toBe('allow_all')
    expect(view.effectiveMode).toBe('manual')
    expect(view.label).toBeNull()
    expect(view.firstSendMode).toBe('allow_all')
  })

  it('a refresh replaces a known ceiling; a read made elsewhere fills it only while unknown', async () => {
    const readHostModeCeiling = vi.fn(async () => 'auto' as const)
    const { client } = transport({ readHostModeCeiling })
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual', { modeCeiling: 'manual' }))
    // A catalog page served from the cache after the ceiling changed.
    noteHostApprovalModeFromSession(AGENT, OTHER, snapshot('manual', { modeCeiling: 'auto' }))
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBe('manual')

    await refreshHostApprovalModeLimit(client, AGENT, null)
    expect(readHostModeCeiling).toHaveBeenCalledWith(AGENT)
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBe('auto')

    // An older page served again from the cache does not undo the refresh.
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual', { modeCeiling: 'manual' }))
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBe('auto')
  })

  it('a PATCH answer replaces the Host ceiling', async () => {
    const { client, setApprovalMode } = transport()
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual', { modeCeiling: 'manual' }))
    setApprovalMode.mockResolvedValue(snapshot('auto', { modeCeiling: 'auto' }))

    await selectHostApprovalMode(client, AGENT, CHAT, 'auto')

    expect(readHostApprovalMode(AGENT, null).modeLimit).toBe('auto')
    expect(readHostApprovalMode(AGENT, CHAT).modeLimit).toBe('auto')
  })

  it('refreshes a chat the Host answered for from its own session', async () => {
    const readHostModeCeiling = vi.fn(async () => 'manual' as const)
    const { client, readSessionApproval } = transport({ readHostModeCeiling })
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual', { modeCeiling: 'manual' }))
    readSessionApproval.mockResolvedValue(snapshot('manual', { modeCeiling: 'allow_all' }))

    await refreshHostApprovalModeLimit(client, AGENT, CHAT)

    expect(readSessionApproval).toHaveBeenCalledWith(AGENT, CHAT)
    expect(readHostModeCeiling).not.toHaveBeenCalled()
    expect(readHostApprovalMode(AGENT, CHAT).modeLimit).toBe('allow_all')
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBe('allow_all')
  })

  it('a menu refresh answered before a pick lands does not undo the pick', async () => {
    const read = deferred<SessionApprovalSnapshot>()
    const { client, readSessionApproval, setApprovalMode } = transport()
    readSessionApproval.mockReturnValueOnce(read.promise)
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'))

    // The menu opens and its read leaves; the user picks before it returns.
    const refresh = refreshHostApprovalModeLimit(client, AGENT, CHAT)
    setApprovalMode.mockResolvedValueOnce(snapshot('auto'))
    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'auto')).resolves.toBe(true)
    // The Host answered the read before the PATCH landed.
    read.resolve(snapshot('manual'))
    await refresh

    expect(readSessionApproval).toHaveBeenCalledTimes(1)
    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('auto')
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Auto-approve')
  })

  it('shares one read between refreshes of the same chat that overlap', async () => {
    const answer = deferred<'auto'>()
    const readHostModeCeiling = vi.fn(() => answer.promise)
    const { client } = transport({ readHostModeCeiling })

    const first = refreshHostApprovalModeLimit(client, AGENT, null)
    const second = refreshHostApprovalModeLimit(client, AGENT, null)
    answer.resolve('auto')
    await Promise.all([first, second])

    expect(readHostModeCeiling).toHaveBeenCalledTimes(1)
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBe('auto')
  })

  it('a refresh that fails keeps the last known limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const readHostModeCeiling = vi.fn(async () => {
      throw new Error('List sessions failed (503)')
    })
    const { client } = transport({ readHostModeCeiling })
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual', { modeCeiling: 'auto' }))

    await refreshHostApprovalModeLimit(client, AGENT, null)

    expect(readHostModeCeiling).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBe('auto')
  })

  it('forgets the Host ceiling on a scope reset, and drops a refresh that crosses it', async () => {
    const answer = deferred<'auto'>()
    const readHostModeCeiling = vi.fn(() => answer.promise)
    const { client } = transport({ readHostModeCeiling })
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual', { modeCeiling: 'manual' }))
    const refresh = refreshHostApprovalModeLimit(client, AGENT, null)

    resetHostApprovalModeStore()
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBeNull()
    answer.resolve('auto')
    await refresh

    expect(readHostModeCeiling).toHaveBeenCalledTimes(1)
    expect(readHostApprovalMode(AGENT, null).modeLimit).toBeNull()
  })
})

describe('hostApprovalModeStore — one write in flight per chat', () => {
  /** Each PATCH commits on arrival; its answer is released later, in any order. */
  function slowHost(initial: SessionApprovalSnapshot['approvalMode']) {
    const host = { mode: initial }
    const answers: Array<{ settle: () => void }> = []
    const setApprovalMode = vi.fn(
      (_agent: string, _chat: string, mode: SessionApprovalSnapshot['approvalMode']) => {
        host.mode = mode
        return new Promise<SessionApprovalSnapshot>(resolve => {
          answers.push({ settle: () => resolve(snapshot(mode)) })
        })
      }
    )
    return { host, answers, setApprovalMode }
  }

  it('refuses a pick while the chat’s write is unanswered, so the label stays what the Host stored', async () => {
    const { host, answers, setApprovalMode } = slowHost('auto')
    const { client } = transport({ setApprovalMode })
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('auto'))

    const first = selectHostApprovalMode(client, AGENT, CHAT, 'manual')
    expect(readHostApprovalMode(AGENT, CHAT).writeInFlight).toBe(true)
    const second = selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')
    // Answers arrive newest first.
    for (const answer of [...answers].reverse()) answer.settle()
    const results = await Promise.all([first, second])

    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe(host.mode)
    expect(results).toEqual([true, false])
    expect(setApprovalMode).toHaveBeenCalledTimes(1)
    expect(readHostApprovalMode(AGENT, CHAT).writeInFlight).toBe(false)
    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(false)
  })

  it('a refused pick changes nothing, and the write in flight still flags its own failure', async () => {
    const rejecters: Array<(error: Error) => void> = []
    const setApprovalMode = vi.fn(
      () =>
        new Promise<SessionApprovalSnapshot>((_resolve, reject) => {
          rejecters.push(reject)
        })
    )
    const { client } = transport({ setApprovalMode })
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'))
    const first = selectHostApprovalMode(client, AGENT, CHAT, 'auto')
    const listener = vi.fn()
    const unsubscribe = subscribeHostApprovalMode(AGENT, CHAT, listener)

    const refused = selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')
    expect(setApprovalMode).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalled()
    for (const reject of rejecters) reject(new Error('Set approval mode failed (401)'))

    await expect(refused).resolves.toBe(false)
    await expect(first).resolves.toBe(false)
    expect(readHostApprovalMode(AGENT, CHAT).storedMode).toBe('manual')
    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(true)
    unsubscribe()
  })
})

describe('hostApprovalModeStore — save failure flag (picker spec C2)', () => {
  it('R24: a 404 that answers after the first send began flags the save as failed', async () => {
    let rejectPatch!: (error: Error) => void
    const { client } = transport({
      setApprovalMode: vi.fn(
        () =>
          new Promise<SessionApprovalSnapshot>((_resolve, reject) => {
            rejectPatch = reject
          })
      ),
    })
    await selectHostApprovalMode(client, AGENT, null, 'allow_all')
    migrateHeldApprovalMode(AGENT, CHAT)

    const write = selectHostApprovalMode(client, AGENT, CHAT, 'manual')
    const send = beginApprovalModeFirstSend(AGENT, CHAT)
    rejectPatch(new Error('Set approval mode failed (404)'))

    await expect(write).resolves.toBe(false)
    expect(readHostApprovalMode(AGENT, CHAT).storedMode).toBe('allow_all')
    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(true)
    send.release()
  })

  it('a 404 hold before any first send is not a failure', async () => {
    const { client, setApprovalMode } = transport()
    // No session read for CHAT: its row may not exist yet.
    setApprovalMode.mockRejectedValue(new Error('Set approval mode failed (404)'))

    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')).resolves.toBe(true)

    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(false)
  })

  it('a refusal during the first send flags the save and notifies the picker', async () => {
    const { client, setApprovalMode } = transport()
    await selectHostApprovalMode(client, AGENT, null, 'allow_all')
    migrateHeldApprovalMode(AGENT, CHAT)
    const send = beginApprovalModeFirstSend(AGENT, CHAT)
    const listener = vi.fn()
    const unsubscribe = subscribeHostApprovalMode(AGENT, CHAT, listener)

    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'manual')).resolves.toBe(false)

    expect(setApprovalMode).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalled()
    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(true)
    unsubscribe()
    send.release()
  })

  it('a pick refused while a write and the first send are in flight leaves the outcome to that write', async () => {
    let resolvePatch!: (value: SessionApprovalSnapshot) => void
    const { client } = transport({
      setApprovalMode: vi.fn(
        () =>
          new Promise<SessionApprovalSnapshot>(resolve => {
            resolvePatch = resolve
          })
      ),
    })
    await selectHostApprovalMode(client, AGENT, null, 'allow_all')
    migrateHeldApprovalMode(AGENT, CHAT)

    const older = selectHostApprovalMode(client, AGENT, CHAT, 'auto')
    const send = beginApprovalModeFirstSend(AGENT, CHAT)
    // One write in flight per chat: the pick is refused before it becomes
    // the chat's latest write, so it raises no flag of its own.
    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'manual')).resolves.toBe(false)
    expect(client.setApprovalMode).toHaveBeenCalledTimes(1)
    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(false)

    resolvePatch(snapshot('auto'))
    await expect(older).resolves.toBe(true)

    expect(readHostApprovalMode(AGENT, CHAT).storedMode).toBe('auto')
    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(false)
    send.release()
  })

  it('the explicit clear drops the flag and notifies', async () => {
    const { client, setApprovalMode } = transport()
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'))
    setApprovalMode.mockRejectedValue(new Error('Set approval mode failed (401)'))
    await selectHostApprovalMode(client, AGENT, CHAT, 'auto')
    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(true)
    const listener = vi.fn()
    const unsubscribe = subscribeHostApprovalMode(AGENT, CHAT, listener)

    clearHostApprovalModeSaveFailure(AGENT, CHAT)

    expect(listener).toHaveBeenCalled()
    expect(readHostApprovalMode(AGENT, CHAT).saveFailed).toBe(false)
    unsubscribe()
  })
})
