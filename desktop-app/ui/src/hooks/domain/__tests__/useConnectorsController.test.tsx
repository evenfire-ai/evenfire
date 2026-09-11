// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { RpcConnector, RpcConnectorsResult } from '../../../../../src/types'
import { useConnectorsController } from '../useConnectorsController'

/**
 * Renderer-side invariants of the connectors panel actions (T5#click→IPC). The
 * native confirm-dialog lives in main and is untestable in jsdom — this drives
 * the hook logic with `window.clerum.rpc.{connectMcpServer,disconnectMcpServer}`
 * stubbed and asserts the OBSERVABLE effects (T4): the exact IPC arguments, and
 * the panel list the user sees after a disconnect.
 *
 * The disconnect result fixture is `{ confirmed: boolean }` — the exact contract
 * `disconnectMcpServer` resolves (renderer.d.ts / appService.disconnectMcpServer),
 * not a hand-invented shape.
 */

const SHARED: RpcConnector = {
  name: 'shared-drive',
  provider: 'google',
  authKind: 'oauth-context',
  grantScope: 'context',
  status: 'requires_setup',
}
const USER: RpcConnector = {
  name: 'monday',
  provider: 'monday',
  authKind: 'oauth-user',
  grantScope: 'user',
  status: 'authorized',
}

const AGENT = 'agent-alpha'
const CTX = 'ctx-team'

function payload(connectors: RpcConnector[]): RpcConnectorsResult {
  return { userId: 'user-1', agents: [{ name: AGENT, contextRef: CTX, connectors }] }
}

function installClerum() {
  const rpc = {
    listConnectors: vi.fn(async () => payload([SHARED, USER])),
    connectMcpServer: vi.fn(async () => undefined),
    disconnectMcpServer: vi.fn(async () => ({ confirmed: true })),
  }
  Object.defineProperty(window, 'clerum', { configurable: true, value: { rpc } })
  return rpc
}

function renderController() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => useConnectorsController(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

const connectorNames = (result: { current: ReturnType<typeof useConnectorsController> }) =>
  result.current.agents[0]?.connectors.map(connector => connector.name) ?? []

describe('useConnectorsController — click→IPC invariants (T5, T4)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('authorize passes confirmShared+contextId ONLY for shared connectors', async () => {
    const rpc = installClerum()
    const { result } = renderController()

    await act(async () => {
      await result.current.authorize({ agentName: AGENT, contextRef: CTX, connector: SHARED })
    })
    // oauth-context → shared: carries confirmShared:true + the agent's contextRef.
    expect(rpc.connectMcpServer).toHaveBeenLastCalledWith('shared-drive', AGENT, CTX, {
      confirmShared: true,
    })

    await act(async () => {
      await result.current.authorize({ agentName: AGENT, contextRef: CTX, connector: USER })
    })
    // oauth-user → NOT shared: confirmShared:false and NO contextId, even though a
    // contextRef is available for the agent.
    expect(rpc.connectMcpServer).toHaveBeenLastCalledWith('monday', AGENT, undefined, {
      confirmShared: false,
    })
  })

  it('disconnect passes shared+contextId ONLY for shared connectors', async () => {
    const rpc = installClerum()
    const { result } = renderController()

    await act(async () => {
      await result.current.disconnect({ agentName: AGENT, contextRef: CTX, connector: SHARED })
    })
    expect(rpc.disconnectMcpServer).toHaveBeenLastCalledWith('shared-drive', AGENT, CTX, {
      shared: true,
    })

    await act(async () => {
      await result.current.disconnect({ agentName: AGENT, contextRef: CTX, connector: USER })
    })
    expect(rpc.disconnectMcpServer).toHaveBeenLastCalledWith('monday', AGENT, undefined, {
      shared: false,
    })
  })

  it('disconnect refreshes the panel list when the revoke is confirmed', async () => {
    const rpc = installClerum()
    const { result } = renderController()

    // App-owned initial load (the query is enabled:false); drive it here.
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(connectorNames(result)).toEqual(['shared-drive', 'monday']))

    // A confirmed revoke changed the grant store; the refetch returns the new list.
    rpc.disconnectMcpServer.mockResolvedValueOnce({ confirmed: true })
    rpc.listConnectors.mockResolvedValueOnce(payload([USER]))
    await act(async () => {
      await result.current.disconnect({ agentName: AGENT, contextRef: CTX, connector: SHARED })
    })

    // Observable: the list the user sees dropped the revoked connector (T4).
    await waitFor(() => expect(connectorNames(result)).toEqual(['monday']))
  })

  it('surfaces an action error when a disconnect WRITE fails, without changing the list (B-1)', async () => {
    const rpc = installClerum()
    const { result } = renderController()

    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(connectorNames(result)).toEqual(['shared-drive', 'monday']))

    // The revoke rejects (403 context_membership_denied / 502 / network). Pre-B-1
    // the rejection was swallowed and the screen matched a cancelled dialog.
    rpc.disconnectMcpServer.mockRejectedValueOnce(new Error('context_membership_denied'))
    await act(async () => {
      // The hook no longer rejects; guard anyway so a regression (re-throw)
      // surfaces as a failed assertion below, not an unhandled rejection.
      await result.current
        .disconnect({ agentName: AGENT, contextRef: CTX, connector: SHARED })
        .catch(() => undefined)
    })

    // Observable: an error is surfaced, the grant is still listed (nothing was
    // revoked), and the row is no longer busy.
    await waitFor(() =>
      expect(result.current.actionError).toEqual(
        expect.stringContaining('context_membership_denied')
      )
    )
    expect(connectorNames(result)).toEqual(['shared-drive', 'monday'])
    expect(result.current.pendingKey).toBeNull()
  })

  it('clears a prior action error when the next action starts (B-1)', async () => {
    const rpc = installClerum()
    const { result } = renderController()

    rpc.disconnectMcpServer.mockRejectedValueOnce(new Error('boom'))
    await act(async () => {
      await result.current
        .disconnect({ agentName: AGENT, contextRef: CTX, connector: SHARED })
        .catch(() => undefined)
    })
    await waitFor(() => expect(result.current.actionError).toContain('boom'))

    // A fresh action resets the banner before it runs.
    await act(async () => {
      await result.current.authorize({ agentName: AGENT, contextRef: CTX, connector: USER })
    })
    expect(result.current.actionError).toBeNull()
  })

  it('disconnect does NOT refresh the panel when the confirm dialog is cancelled', async () => {
    const rpc = installClerum()
    const { result } = renderController()

    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(connectorNames(result)).toEqual(['shared-drive', 'monday']))
    const listCallsBefore = rpc.listConnectors.mock.calls.length

    // Cancelled dialog: nothing was revoked. A queued (would-be) refetch payload is
    // primed to prove it is NEVER consumed.
    rpc.disconnectMcpServer.mockResolvedValueOnce({ confirmed: false })
    rpc.listConnectors.mockResolvedValueOnce(payload([USER]))
    await act(async () => {
      await result.current.disconnect({ agentName: AGENT, contextRef: CTX, connector: SHARED })
    })

    // Observable: the list is unchanged, and no refetch was issued.
    expect(connectorNames(result)).toEqual(['shared-drive', 'monday'])
    expect(rpc.listConnectors.mock.calls.length).toBe(listCallsBefore)
  })
})
