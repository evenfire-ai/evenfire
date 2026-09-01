import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import HostsPage from '../../app/hosts/page'
import * as api from '../../lib/api'
import { materializeHostResource } from '../../test/fixtures/contextResource'

const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => '/agents',
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('../../lib/api', () => ({
  apiSend: vi.fn(),
  getContexts: vi.fn(),
  getHosts: vi.fn(),
  isSilentApiError: vi.fn().mockReturnValue(false),
}))

afterEach(() => {
  cleanup()
})

describe('HostsPage optional Context enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the Hosts table and primary actions available when Context enrichment fails', async () => {
    const host = materializeHostResource({
      metadata: { name: 'agent-a' },
      spec: {
        host: 'Agent A',
        contextRef: 'agent-a-context',
        secretRef: 'openai-secret',
        channels: [],
        model: { provider: 'openai', name: 'gpt-5.4-mini' },
      },
    })
    vi.mocked(api.getHosts).mockResolvedValue({
      items: [host],
    })
    vi.mocked(api.getContexts).mockRejectedValue(new Error('Context service unavailable'))

    render(<HostsPage />)

    expect(await screen.findByText('Agent A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reload agents' })).toBeEnabled()

    // The row remains usable with only the non-critical connector enrichment
    // degraded: a raw Context reference renders as a zero count with no hover
    // card, while the rest of the Host row remains present.
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(screen.queryByText('Context service unavailable')).not.toBeInTheDocument()
    expect(api.getHosts).toHaveBeenCalledTimes(1)
    expect(api.getContexts).toHaveBeenCalledTimes(1)
  })
})
