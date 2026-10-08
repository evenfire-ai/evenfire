// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { AccessCatalog } from '../../../../../src/types'
import { desktopQueryDefaults } from '../../../lib/queryClient'
import { desktopQueryKeys } from '../queryKeys'
import { useMcpServersDataController } from '../useMcpServersDataController'

/**
 * The agent Connectors panel's rows come from the access catalog (the
 * agent→server mapping), so the panel's refresh scheduler consults the
 * catalog's age as well as the connectors' (#991 follow-up).
 */
describe('useMcpServersDataController — catalog staleness read', () => {
  afterEach(() => cleanup())

  function renderWithClient(client: QueryClient) {
    return renderHook(() => useMcpServersDataController(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
  }

  const seed = (client: QueryClient, ageMs: number) =>
    client.setQueryData(
      desktopQueryKeys.accessCatalog,
      { agentNames: [] } as unknown as AccessCatalog,
      {
        updatedAt: Date.now() - ageMs,
      }
    )

  it('reads the access catalog age at call time, and reset makes it stale', () => {
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    seed(client, 1_000)
    const { result } = renderWithClient(client)
    expect(result.current.isStale(15_000)).toBe(false)

    seed(client, 20_000)
    expect(result.current.isStale(15_000)).toBe(true)

    seed(client, 0)
    expect(result.current.isStale(15_000)).toBe(false)
    act(() => result.current.reset())
    expect(result.current.isStale(15_000)).toBe(true)
  })
})
