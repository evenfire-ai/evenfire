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
  it('labels the area with the org name when connected', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(
      cap({ orgName: 'acme', scope: '@acme', canManageOrg: true })
    )
    render(<MarketplaceOrgArea activeTab="entries" />)
    expect(screen.getByText('@acme')).toBeInTheDocument()
  })

  it('labels the area "Your org" before the deployment is claimed', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(cap({}))
    render(<MarketplaceOrgArea activeTab="entries" />)
    expect(screen.getByText('Your org')).toBeInTheDocument()
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
  })

  it('connection: always renders the connect panel', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(cap({}))
    render(<MarketplaceOrgArea activeTab="connection" />)
    expect(screen.getByText('connect-panel')).toBeInTheDocument()
  })
})
