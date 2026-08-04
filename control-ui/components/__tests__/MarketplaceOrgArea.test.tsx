import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import * as grantsHook from '../../lib/hooks/useInboundGrants'
import * as capHook from '../../lib/hooks/useRegistryCapability'
import type {
  RegistryCapability,
  RegistryCapabilityState,
} from '../../lib/hooks/useRegistryCapability'
import { MarketplaceOrgArea } from '../MarketplaceOrgArea'

vi.mock('../../lib/hooks/useRegistryCapability', () => ({ useRegistryCapability: vi.fn() }))
vi.mock('../../lib/hooks/useInboundGrants', () => ({ useInboundGrants: vi.fn() }))
vi.mock('../MarketplaceTabs', () => ({ MarketplaceTabs: () => <div>marketplace-tabs</div> }))
vi.mock('../MarketplaceOrgImages', () => ({
  MarketplaceOrgImages: () => <div>org-images</div>,
}))
vi.mock('../PublisherView/OwnedEntries', () => ({
  OwnedEntries: () => <div>owned-entries</div>,
}))
vi.mock('../RegistryApiKeysPanel', () => ({ default: () => <div>api-keys-panel</div> }))
vi.mock('../PublisherView/DockerCredentials', () => ({
  DockerCredentialsPanel: () => <div>docker-credentials-panel</div>,
}))
vi.mock('../RegistryConnectPanel', () => ({ default: () => <div>connect-panel</div> }))

function cap(overrides: Partial<RegistryCapability>): RegistryCapabilityState {
  return {
    capability: {
      orgName: null,
      scope: null,
      isCurator: false,
      mode: 'unknown',
      authEnabled: false,
      connectionState: null,
      canManageOrg: false,
      ...overrides,
    },
    loading: false,
    error: false,
    reload: vi.fn(),
  }
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(grantsHook.useInboundGrants).mockReturnValue({
    status: 'available',
    grants: [],
    reload: vi.fn(),
  })
})

describe('MarketplaceOrgArea', () => {
  it('labels the area with the org name, linked to the Entries tab', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(
      cap({ orgName: 'acme', scope: '@acme', canManageOrg: true })
    )
    render(<MarketplaceOrgArea activeTab="entries" />)
    const orgLink = screen.getByRole('link', { name: '@acme' })
    expect(orgLink).toHaveAttribute('href', '/marketplace/org/entries')
  })

  it('labels the area "Your org" (plain text, not a link) before the deployment is claimed', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(cap({}))
    render(<MarketplaceOrgArea activeTab="entries" />)
    expect(screen.getByText('Your org')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Your org' })).toBeNull()
  })

  it('entries: shows OwnedEntries when the org can manage', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(
      cap({ orgName: 'acme', scope: '@acme', canManageOrg: true })
    )
    render(<MarketplaceOrgArea activeTab="entries" />)
    expect(screen.getByText('owned-entries')).toBeInTheDocument()
  })

  it('entries: shows a claim prompt when the org cannot manage', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(cap({ canManageOrg: false }))
    render(<MarketplaceOrgArea activeTab="entries" />)
    expect(screen.getByText(/Name your organization/i)).toBeInTheDocument()
    expect(screen.queryByText('owned-entries')).toBeNull()
  })

  it('images: shows the images area when the org can manage', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(
      cap({ orgName: 'acme', scope: '@acme', canManageOrg: true })
    )
    render(<MarketplaceOrgArea activeTab="images" />)
    expect(screen.getByText('org-images')).toBeInTheDocument()
  })

  it('credentials: renders the API keys panel even when publishing is off (§6 decision)', () => {
    // canManageOrg false (e.g. publishing UI disabled), but API keys must stay.
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(cap({ canManageOrg: false }))
    render(<MarketplaceOrgArea activeTab="credentials" />)
    expect(screen.getByText('api-keys-panel')).toBeInTheDocument()
    expect(screen.queryByText(/Name your organization/i)).toBeNull()
    // No org scope yet → the Docker push-credential panel can't build coordinates.
    expect(screen.queryByText('docker-credentials-panel')).toBeNull()
  })

  it('credentials: also renders the Docker push credential once the org scope is known', () => {
    // canManageOrg false (publishing UI off) but a claimed scope — push
    // credentials are gated on the scope, not the publishing toggle (§6).
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(
      cap({ orgName: 'acme', scope: '@acme', canManageOrg: false })
    )
    render(<MarketplaceOrgArea activeTab="credentials" />)
    expect(screen.getByText('api-keys-panel')).toBeInTheDocument()
    expect(screen.getByText('docker-credentials-panel')).toBeInTheDocument()
  })

  it('connection: always renders the connect panel', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(cap({}))
    render(<MarketplaceOrgArea activeTab="connection" />)
    expect(screen.getByText('connect-panel')).toBeInTheDocument()
  })
})
