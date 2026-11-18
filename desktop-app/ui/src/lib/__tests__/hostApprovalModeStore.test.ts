// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type HostApprovalModeTransport,
  type SessionApprovalSnapshot,
  approvalModeForFirstSend,
  hostApprovalModeEpoch,
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

  it('a session read from before a write does not paint the old mode', async () => {
    const { client, setApprovalMode } = transport()
    const epoch = hostApprovalModeEpoch(AGENT, CHAT)
    setApprovalMode.mockResolvedValue(snapshot('allow_all'))

    await selectHostApprovalMode(client, AGENT, CHAT, 'allow_all')
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('manual'), epoch)

    expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('allow_all')
  })

  it('a catalog read after a write still updates that chat', async () => {
    const { client, setApprovalMode } = transport()
    setApprovalMode.mockResolvedValue(snapshot('auto'))
    await selectHostApprovalMode(client, AGENT, CHAT, 'auto')

    const catalogSeq = hostApprovalModeEpoch(AGENT, null)
    noteHostApprovalModeFromSession(AGENT, CHAT, snapshot('allow_all'), catalogSeq)

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
