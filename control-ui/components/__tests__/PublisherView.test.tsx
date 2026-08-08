import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import * as inboundHook from '../../lib/hooks/useInboundGrants'
import * as hook from '../../lib/hooks/usePublishScope'
import { PublisherView } from '../PublisherView'

const refreshPublishScope = vi.fn()

function publishScopeState(state: Omit<hook.PublishScopeState, 'refresh'>): hook.PublishScopeState {
  return { ...state, refresh: refreshPublishScope }
}

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
vi.mock('../../lib/hooks/useInboundGrants', () => ({ useInboundGrants: vi.fn() }))

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  // Default: grant listing available → the "Shared with me" tab shows. The
  // tab-visibility tests below override this per-case.
  vi.mocked(inboundHook.useInboundGrants).mockReturnValue({
    status: 'available',
    grants: [],
    reload: vi.fn(),
  })
})

describe('PublisherView', () => {
  it('renders a loading state while publish-scope resolves', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({ scope: null, loading: true, error: false })
    )
    const view = render(<PublisherView activeTab="entries" />)
    expect(screen.getByRole('status', { name: /loading publisher/i })).toBeInTheDocument()
    expect(screen.queryByText(/^Loading/i)).toBeNull()
    expect(view.container.querySelectorAll('.cu-skeleton').length).toBeGreaterThan(0)
  })

  it('renders unavailable on a curator deploy (fails closed)', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: null, curator: true, orgName: null },
        loading: false,
        error: false,
      })
    )
    render(<PublisherView activeTab="entries" />)
    expect(screen.getByText(/not available on this deployment/i)).toBeInTheDocument()
  })

  it('renders unavailable when publisherUiEnabled is false (self-hosted default), even for an org-bound non-curator deploy (fails closed)', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: 'acme', curator: false, orgName: 'Acme', publisherUiEnabled: false },
        loading: false,
        error: false,
      })
    )
    render(<PublisherView activeTab="entries" />)
    expect(screen.getByText(/not available on this deployment/i)).toBeInTheDocument()
  })

  it('renders the owned-entries panel for an org-bound deploy on the entries tab', async () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: 'acme', curator: false, orgName: 'Acme' },
        loading: false,
        error: false,
      })
    )
    render(<PublisherView activeTab="entries" />)
    expect(await screen.findByText('owned-entries-panel')).toBeInTheDocument()
  })

  it('header renders the already-@-prefixed org scope once (no double @@)', () => {
    // resolvePublishScope() in control-api returns `scope` already prefixed as
    // `@<org>` (registryClient.ts). The header must render it verbatim and must
    // NOT prepend a second '@', otherwise it reads "Publisher — @@acme".
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: '@acme', curator: false, orgName: 'Acme' },
        loading: false,
        error: false,
      })
    )
    render(<PublisherView activeTab="entries" />)
    expect(screen.getByText('Publisher — @acme')).toBeInTheDocument()
    expect(screen.queryByText(/@@/)).not.toBeInTheDocument()
  })

  it('renders the docker-credentials panel on the credentials tab', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: 'acme', curator: false, orgName: 'Acme' },
        loading: false,
        error: false,
      })
    )
    render(<PublisherView activeTab="credentials" />)
    expect(screen.getByText('docker-credentials-panel')).toBeInTheDocument()
  })

  it('renders the granted-to-me panel on the shared tab', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: 'acme', curator: false, orgName: 'Acme' },
        loading: false,
        error: false,
      })
    )
    render(<PublisherView activeTab="shared" />)
    expect(screen.getByText('granted-to-me-panel')).toBeInTheDocument()
  })

  it('tab nav uses Link hrefs to the route segments (not query params)', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: 'acme', curator: false, orgName: 'Acme' },
        loading: false,
        error: false,
      })
    )
    render(<PublisherView activeTab="entries" />)
    const shared = screen.getByRole('tab', { name: /shared with me/i })
    expect(shared).toHaveAttribute('href', '/publisher/shared-with-me')
  })

  it('hides the "Shared with me" tab when inbound grants are unavailable (403)', () => {
    vi.mocked(inboundHook.useInboundGrants).mockReturnValue({
      status: 'unavailable',
      grants: [],
      reload: vi.fn(),
    })
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: '@acme', curator: false, orgName: 'Acme' },
        loading: false,
        error: false,
      })
    )
    render(<PublisherView activeTab="entries" />)
    expect(screen.queryByRole('tab', { name: /shared with me/i })).toBeNull()
    expect(screen.getByRole('tab', { name: /published entries/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /docker credentials/i })).toBeInTheDocument()
  })

  it('shows the "Shared with me" tab when inbound grants are available', () => {
    vi.mocked(inboundHook.useInboundGrants).mockReturnValue({
      status: 'available',
      grants: [],
      reload: vi.fn(),
    })
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: '@acme', curator: false, orgName: 'Acme' },
        loading: false,
        error: false,
      })
    )
    render(<PublisherView activeTab="entries" />)
    expect(screen.getByRole('tab', { name: /shared with me/i })).toBeInTheDocument()
  })
})
