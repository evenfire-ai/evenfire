import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { SubscriptionCapabilities } from '../../subscriptionCapabilities'
import { useGrokSubscriptionEnabled } from '../useGrokSubscriptionEnabled'

const grokCapabilityState = vi.hoisted(() => ({
  capabilities: null as SubscriptionCapabilities | null,
}))

vi.mock('@lib/hooks/useSubscriptionCapabilities', () => ({
  useSubscriptionCapabilities: () => ({
    capabilities: grokCapabilityState.capabilities,
    loading: grokCapabilityState.capabilities === null,
    error: null,
    retry: vi.fn(),
  }),
}))

function Probe() {
  return <span data-testid="grok">{String(useGrokSubscriptionEnabled())}</span>
}

afterEach(() => {
  cleanup()
  grokCapabilityState.capabilities = null
  vi.clearAllMocks()
})

describe('useGrokSubscriptionEnabled', () => {
  it('starts hidden and turns on after shared capability discovery confirms the integration', async () => {
    grokCapabilityState.capabilities = null
    render(<Probe />)
    expect(screen.getByTestId('grok')).toHaveTextContent('false')
    cleanup()

    grokCapabilityState.capabilities = {
      providers: {
        'codex-subscription': { enabled: false },
        'grok-subscription': { enabled: true },
      },
    }
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('grok')).toHaveTextContent('true'))
  })

  it('stays hidden when the shared integration flag is off', () => {
    grokCapabilityState.capabilities = {
      providers: {
        'codex-subscription': { enabled: false },
        'grok-subscription': { enabled: false },
      },
    }
    render(<Probe />)
    expect(screen.getByTestId('grok')).toHaveTextContent('false')
  })

  it('fails closed before confirmation', () => {
    grokCapabilityState.capabilities = null
    render(<Probe />)
    expect(screen.getByTestId('grok')).toHaveTextContent('false')
  })

  it('keeps a previously confirmed Grok integration visible during a transient read failure', () => {
    grokCapabilityState.capabilities = {
      providers: {
        'codex-subscription': { enabled: false },
        'grok-subscription': { enabled: true },
      },
    }
    render(<Probe />)
    expect(screen.getByTestId('grok')).toHaveTextContent('true')
  })
})
