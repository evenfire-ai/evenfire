// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type HostApprovalModeTransport,
  type SessionApprovalSnapshot,
  approvalModeForFirstSend,
  beginApprovalModeFirstSend,
  confirmHeldApprovalModeFromSend,
  hostApprovalModeEpoch,
  migrateHeldApprovalMode,
  noteHostApprovalModeFromSession,
  readHostApprovalMode,
  resetHostApprovalModeStore,
  selectHostApprovalMode,
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

  it('a 404 holds the mode for the first send', async () => {
    const { client, setApprovalMode, readSessionApproval } = transport()
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'))
    setApprovalMode.mockRejectedValue(new Error('Set approval mode failed (404)'))

    await expect(selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')).resolves.toBe(true)

    expect(readSessionApproval).not.toHaveBeenCalled()
    expect(approvalModeForFirstSend(AGENT, CHAT)).toBe('allow_all')
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Allow all')
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
