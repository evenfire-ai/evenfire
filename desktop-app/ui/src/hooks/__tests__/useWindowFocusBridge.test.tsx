// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import { useWindowFocusBridge } from '../useWindowFocusBridge'

/**
 * Electron renderers keep `visibilityState: 'visible'` while their window
 * loses/gains OS focus, so query-core's visibilitychange listener never runs
 * there. The bridge forwards DOM focus/blur to focusManager, which is what
 * makes `refetchOnWindowFocus` policies (GFS listing freshness) work in the
 * desktop app. This test drives the REAL DOM events, not focusManager
 * directly, to pin the bridging itself.
 */
describe('useWindowFocusBridge', () => {
  it('revalidates focus-aware queries on window focus events under production defaults', async () => {
    const fetcher = vi.fn(async () => ({ value: Date.now() }))

    function Probe() {
      useWindowFocusBridge()
      const query = useQuery({
        queryKey: ['focus-bridge-probe'],
        queryFn: fetcher,
        refetchOnWindowFocus: 'always',
      })
      return <div data-testid="fetches">{query.dataFetchStatus}</div>
    }

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))

    // Leaving and returning to the window (as Electron fires it).
    fireEvent(window, new Event('blur'))
    fireEvent(window, new Event('focus'))

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  })
})
