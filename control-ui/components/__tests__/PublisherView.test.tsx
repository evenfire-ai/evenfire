import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import * as hook from '../../lib/hooks/usePublishScope'
import { PublisherView } from '../PublisherView'

// Stub the three panels so this test targets only the shell + gate.
vi.mock('../PublisherView/OwnedEntries', () => ({
  OwnedEntries: () => <div>owned-entries-panel</div>,
}))
vi.mock('../PublisherView/GrantedToMe', () => ({
  GrantedToMe: () => <div>granted-to-me-panel</div>,
}))
vi.mock('../PublisherView/DockerCredentials', () => ({
  DockerCredentialsPanel: () => <div>docker-credentials-panel</div>,
}))
vi.mock('../../lib/hooks/usePublishScope', async orig => {
  const actual = await orig<typeof import('../../lib/hooks/usePublishScope')>()
  return { ...actual, usePublishScope: vi.fn() }
})

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('PublisherView', () => {
  it('renders a loading state while publish-scope resolves', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({ scope: null, loading: true, error: false })
    render(<PublisherView activeTab="entries" />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('renders unavailable on a curator deploy (fails closed)', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({
      scope: { scope: null, curator: true, orgName: null },
      loading: false,
      error: false,
    })
    render(<PublisherView activeTab="entries" />)
    expect(screen.getByText(/not available on this deployment/i)).toBeInTheDocument()
  })

  it('renders unavailable when publisherUiEnabled is false (self-hosted default), even for an org-bound non-curator deploy (fails closed)', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({
      scope: { scope: 'acme', curator: false, orgName: 'Acme', publisherUiEnabled: false },
      loading: false,
      error: false,
    })
    render(<PublisherView activeTab="entries" />)
    expect(screen.getByText(/not available on this deployment/i)).toBeInTheDocument()
  })

  it('renders the owned-entries panel for an org-bound deploy on the entries tab', async () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({
      scope: { scope: 'acme', curator: false, orgName: 'Acme' },
      loading: false,
      error: false,
    })
    render(<PublisherView activeTab="entries" />)
    expect(await screen.findByText('owned-entries-panel')).toBeInTheDocument()
  })

  it('renders the docker-credentials panel on the credentials tab', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({
      scope: { scope: 'acme', curator: false, orgName: 'Acme' },
      loading: false,
      error: false,
    })
    render(<PublisherView activeTab="credentials" />)
    expect(screen.getByText('docker-credentials-panel')).toBeInTheDocument()
  })

  it('renders the granted-to-me panel on the shared tab', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({
      scope: { scope: 'acme', curator: false, orgName: 'Acme' },
      loading: false,
      error: false,
    })
    render(<PublisherView activeTab="shared" />)
    expect(screen.getByText('granted-to-me-panel')).toBeInTheDocument()
  })

  it('tab nav uses Link hrefs to the route segments (not query params)', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue({
      scope: { scope: 'acme', curator: false, orgName: 'Acme' },
      loading: false,
      error: false,
    })
    render(<PublisherView activeTab="entries" />)
    const shared = screen.getByRole('tab', { name: /shared with me/i })
    expect(shared).toHaveAttribute('href', '/publisher/shared-with-me')
  })
})
