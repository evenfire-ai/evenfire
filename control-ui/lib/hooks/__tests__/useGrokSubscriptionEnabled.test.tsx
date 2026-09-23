import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { loadGrokSubscriptionCapability } from '@lib/grokSubscriptionFeature'
import { useGrokSubscriptionEnabled } from '../useGrokSubscriptionEnabled'

vi.mock('@lib/grokSubscriptionFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/grokSubscriptionFeature')>()
  return { ...actual, loadGrokSubscriptionCapability: vi.fn() }
})

function Probe() {
  return <span data-testid="grok">{String(useGrokSubscriptionEnabled())}</span>
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useGrokSubscriptionEnabled', () => {
  it('starts hidden and turns on only after the capability probe reports enabled', async () => {
    let resolve!: (value: { enabled: boolean }) => void
    vi.mocked(loadGrokSubscriptionCapability).mockReturnValue(
      new Promise(res => {
        resolve = res
      })
    )
    render(<Probe />)
    expect(screen.getByTestId('grok')).toHaveTextContent('false')
    resolve({ enabled: true })
    await waitFor(() => expect(screen.getByTestId('grok')).toHaveTextContent('true'))
    expect(loadGrokSubscriptionCapability).toHaveBeenCalledTimes(1)
  })

  it('stays hidden when the probe reports the flag off', async () => {
    vi.mocked(loadGrokSubscriptionCapability).mockResolvedValue({ enabled: false })
    render(<Probe />)
    await waitFor(() => expect(loadGrokSubscriptionCapability).toHaveBeenCalled())
    await Promise.resolve()
    expect(screen.getByTestId('grok')).toHaveTextContent('false')
  })

  it('fails closed when the probe throws a non-disabled error', async () => {
    vi.mocked(loadGrokSubscriptionCapability).mockRejectedValue(new Error('probe boom'))
    render(<Probe />)
    await waitFor(() => expect(loadGrokSubscriptionCapability).toHaveBeenCalled())
    await Promise.resolve()
    expect(screen.getByTestId('grok')).toHaveTextContent('false')
  })
})
