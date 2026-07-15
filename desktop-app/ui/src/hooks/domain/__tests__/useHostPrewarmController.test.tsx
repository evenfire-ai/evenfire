// @vitest-environment jsdom
/**
 * Pre-warm trigger tests — AUTHENTICATED CATALOG ONLY.
 *
 * The anti-flap test here is load-bearing: the host status stream drops and
 * reconnects every ~300s (RPC token TTL → auth-expired → reconnect). If
 * someone later wires prewarm to the stream path (e.g. inside
 * useMcpServerController's subscribe effect), the "stream reconnect does NOT
 * trigger prewarm" test MUST fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import type { NavItem } from '../../../uiTypes'
// React 18/19 needs this flag for act() to flush effects in the test env.
import { useHostPrewarmController } from '../useHostPrewarmController'
import { useMcpServerController } from '../useMcpServerController'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type StatusHandler = (event: { type: string; message?: string }) => void

let prewarmHost: ReturnType<typeof vi.fn>
let subscribeHostStatus: ReturnType<typeof vi.fn>
let statusHandlers: StatusHandler[]
let bumpReconnect: (() => void) | null = null
let debugSpy: ReturnType<typeof vi.spyOn>

function installMockClerum() {
  statusHandlers = []
  prewarmHost = vi.fn(async () => ({ requested: true, status: 'wake-requested' }))
  subscribeHostStatus = vi.fn(
    async (_hostRef: string, _hostRefs: string[] | undefined, onEvent: StatusHandler) => {
      statusHandlers.push(onEvent)
      return async () => {}
    }
  )
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      rpc: {
        prewarmHost,
        subscribeHostStatus,
      },
    },
  })
}

function Harness({
  selectedAgent,
  agentNames,
  isAuthenticated,
  navItem,
}: {
  selectedAgent: string | null
  agentNames: string[]
  isAuthenticated: boolean
  navItem: NavItem
}) {
  useHostPrewarmController({ agentNames, isAuthenticated })
  const mcp = useMcpServerController({
    selectedAgent,
    navItem,
    isAuthenticated,
    agentProviderByName: {},
  })
  bumpReconnect = mcp.bumpReconnectNonce
  return null
}

beforeEach(() => {
  installMockClerum()
  debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  bumpReconnect = null
  debugSpy.mockRestore()
  delete (window as { clerum?: unknown }).clerum
})

describe('useHostPrewarmController — authenticated catalog trigger', () => {
  it('loading the authenticated catalog prewarms every accessible agent host exactly once', async () => {
    const view = render(
      <Harness
        selectedAgent={null}
        agentNames={[' chatllm ', 'chatllm-stateless', 'chatllm']}
        isAuthenticated
        navItem="agents"
      />
    )

    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(2))
    expect(prewarmHost).toHaveBeenNthCalledWith(1, 'chatllm', ['chatllm', 'chatllm-stateless'])
    expect(prewarmHost).toHaveBeenNthCalledWith(2, 'chatllm-stateless', [
      'chatllm',
      'chatllm-stateless',
    ])

    // A plain parent re-render with the same catalog must NOT re-fire.
    view.rerender(
      <Harness
        selectedAgent={null}
        agentNames={['chatllm', 'chatllm-stateless']}
        isAuthenticated
        navItem="agents"
      />
    )
    await act(async () => {})
    expect(prewarmHost).toHaveBeenCalledTimes(2)
  })

  it('ANTI-FLAP: a simulated stream reconnect (auth-expired → re-subscribe) does NOT trigger prewarm', async () => {
    render(
      <Harness selectedAgent="chatllm" agentNames={['chatllm']} isAuthenticated navItem="agents" />
    )

    await waitFor(() => expect(subscribeHostStatus).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(1))

    // 1. The main process surfaces the ~300s token expiry as a stream error
    //    event (the reconnect itself happens in the main process).
    await act(async () => {
      statusHandlers[0]?.({ type: 'error', message: 'RPC token expired; reconnecting' })
    })

    // 2. The renderer-side stream restart path (reconnect nonce) tears the
    //    subscription down and re-subscribes — the only renderer analogue of
    //    a stream reconnect.
    await act(async () => {
      bumpReconnect?.()
    })
    await waitFor(() => expect(subscribeHostStatus).toHaveBeenCalledTimes(2))

    // THE INVARIANT: the stream lifecycle never wakes the host.
    expect(prewarmHost).toHaveBeenCalledTimes(1)
  })

  it('adding a newly authorized catalog agent fires a prewarm for only the new hostRef', async () => {
    const view = render(
      <Harness selectedAgent="agent-a" agentNames={['agent-a']} isAuthenticated navItem="agents" />
    )
    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(1))

    view.rerender(
      <Harness
        selectedAgent="agent-b"
        agentNames={['agent-a', 'agent-b']}
        isAuthenticated
        navItem="agents"
      />
    )
    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(2))
    expect(prewarmHost).toHaveBeenLastCalledWith('agent-b', ['agent-a', 'agent-b'])
  })

  it('does not fire before authentication or with an empty catalog', async () => {
    const view = render(
      <Harness
        selectedAgent={null}
        agentNames={['chatllm']}
        isAuthenticated={false}
        navItem="agents"
      />
    )
    await act(async () => {})
    view.rerender(
      <Harness selectedAgent="chatllm" agentNames={[]} isAuthenticated navItem="agents" />
    )
    await act(async () => {})
    expect(prewarmHost).not.toHaveBeenCalled()
  })

  it('409 not-stateless is debug-logged and never surfaces a UI error', async () => {
    prewarmHost.mockResolvedValue({ requested: true, status: 'not-stateless' })
    render(
      <Harness
        selectedAgent="always-on"
        agentNames={['always-on']}
        isAuthenticated
        navItem="agents"
      />
    )

    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(debugSpy).toHaveBeenCalledWith(
        '[Prewarm] host=always-on is always-on (not-stateless); nothing to wake'
      )
    )
  })

  it('a failed prewarm is debug-logged and leaves the view flow unaffected', async () => {
    prewarmHost.mockRejectedValue(new Error('Prewarm failed (404): host not found'))
    const view = render(
      <Harness selectedAgent="ghost" agentNames={['ghost']} isAuthenticated navItem="agents" />
    )

    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(debugSpy).toHaveBeenCalledWith(
        '[Prewarm] request did not complete host=ghost:',
        expect.any(Error)
      )
    )
    // View keeps rendering and re-rendering — the rejection never escapes.
    view.rerender(
      <Harness selectedAgent="ghost" agentNames={['ghost']} isAuthenticated navItem="agents" />
    )
    await act(async () => {})
    expect(prewarmHost).toHaveBeenCalledTimes(1)
  })
})
