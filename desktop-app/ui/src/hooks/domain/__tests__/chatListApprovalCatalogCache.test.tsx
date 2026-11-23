// @vitest-environment jsdom
/**
 * R6-MJ2 (c): a catalog page requested before an approval-mode write and served
 * from the 5 s catalog cache after it must not paint the pre-write mode.
 *
 * The selected-agent read and the cross-Host sidebar preview share one cache
 * key ({agent, limit: 50}). The mount issues that request while the server
 * stores auto. After a write to allow_all, the preview runs again inside the
 * cache window and is served the same pre-write page. Its approval epoch must
 * be the one taken when the request was sent, not when the preview ran.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  type HostApprovalModeTransport,
  type SessionApprovalSnapshot,
  readHostApprovalMode,
  resetHostApprovalModeStore,
  selectHostApprovalMode,
} from '../../../lib/hostApprovalModeStore'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AGENT = 'agent-x'
const CHAT = 'c1'
const NOW = '2026-11-19T00:00:00.000Z'
const CATALOG_TTL_MS = 5_000

let clerum: MockClerum
let serverMode: SessionApprovalSnapshot['approvalMode']
let clockOffset: number
let agentListVariant: number

function approvalFields(mode: SessionApprovalSnapshot['approvalMode']): SessionApprovalSnapshot {
  return {
    approvalMode: mode,
    modeCeiling: 'allow_all',
    channelCap: 'allow_all',
    effectiveApprovalMode: mode,
    shellClassifierAvailable: true,
  }
}

/** listSessions reads the server's stored mode when the request is sent. */
function serveCatalog() {
  clerum.rpc.listSessions.mockImplementation(async (hostRef: string) => {
    if (hostRef !== AGENT) return { items: [] }
    return {
      items: [
        {
          agent: AGENT,
          chatId: CHAT,
          turnCount: 1,
          lastActivityAt: NOW,
          ...approvalFields(serverMode),
        },
      ],
    }
  })
}

function agentCatalogRequests(): number {
  return clerum.rpc.listSessions.mock.calls.filter(call => call[0] === AGENT).length
}

/** Re-runs the cross-Host sidebar preview, which requests one page per Host. */
async function pollPreview(view: ReturnType<typeof renderController>) {
  agentListVariant += 1
  const agentNames = [AGENT, ...Array.from({ length: agentListVariant }, (_, i) => `agent-y${i}`)]
  await act(async () => {
    view.rerender({ agentNames })
  })
}

beforeEach(() => {
  clerum = installMockClerum()
  resetHostApprovalModeStore()
  serverMode = 'auto'
  clockOffset = 0
  agentListVariant = 0
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
  serveCatalog()
})

afterEach(async () => {
  cleanup()
  // A catalog read scheduled after first paint survives unmount. Let it reach
  // this test's bridge before the next test installs its own.
  await new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
  resetHostApprovalModeStore()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('a catalog page served from the cache after a mode write', () => {
  it('keeps the written mode, and a page requested after the write is applied', async () => {
    const view = renderController({ selectedAgent: AGENT, agentNames: [AGENT] })
    // Witness: the mount's catalog page reached the approval store.
    await waitFor(() => expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Auto-approve'))
    await waitFor(() => expect(clerum.chat.reconcileServerSessions).toHaveBeenCalled())
    const requestsBeforeWrite = agentCatalogRequests()
    expect(requestsBeforeWrite).toBeGreaterThan(0)

    const transport: HostApprovalModeTransport = {
      setApprovalMode: vi.fn(async (_agent, _chat, mode) => {
        serverMode = mode
        return approvalFields(mode)
      }),
      readSessionApproval: vi.fn(async () => approvalFields(serverMode)),
    }
    await act(async () => {
      await selectHostApprovalMode(transport, AGENT, CHAT, 'allow_all')
    })
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Allow all')

    // The preview runs inside the cache window and gets the pre-write page.
    const persistedBefore = clerum.chat.reconcileServerSessions.mock.calls.length
    await pollPreview(view)
    // Witness: the preview processed a page for this Host without a new request.
    await waitFor(() =>
      expect(clerum.chat.reconcileServerSessions.mock.calls.length).toBeGreaterThan(persistedBefore)
    )
    expect(agentCatalogRequests()).toBe(requestsBeforeWrite)
    expect(readHostApprovalMode(AGENT, CHAT).label).toBe('Allow all')

    // Positive control: another device lowers the mode; a page requested after
    // the write (cache expired) is applied.
    serverMode = 'manual'
    clockOffset += CATALOG_TTL_MS + 1_000
    await pollPreview(view)
    await waitFor(() => expect(agentCatalogRequests()).toBeGreaterThan(requestsBeforeWrite))
    await waitFor(() => expect(readHostApprovalMode(AGENT, CHAT).effectiveMode).toBe('manual'))
    expect(readHostApprovalMode(AGENT, CHAT).label).toBeNull()
  })
})
