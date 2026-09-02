import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import LegacyContextRedirectPage from '../../app/contexts/[[...slug]]/page'
import * as api from '../../lib/api'

const replace = vi.fn()
let routeSlug: string[] | string | undefined

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: routeSlug }),
  useRouter: () => ({ replace }),
}))

vi.mock('../../lib/api', () => ({
  getContexts: vi.fn(),
  getHosts: vi.fn(),
}))

describe('LegacyContextRedirectPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeSlug = ['ctx-resource']
    vi.mocked(api.getContexts).mockResolvedValue({
      items: [
        {
          metadata: { name: 'ctx-resource' },
          spec: { contextId: 'ctx-wire', mcpServers: [] },
        },
      ],
    })
    vi.mocked(api.getHosts).mockResolvedValue({
      items: [{ metadata: { name: 'agent-alpha' }, spec: { contextRef: 'ctx-wire' } }],
    })
  })

  it('redirects a resource-name alias to the owning Agent', async () => {
    render(<LegacyContextRedirectPage />)

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/agents/agent-alpha/connectors'))
  })
})
