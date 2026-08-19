import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  it('keeps Marketplace as the organization-area header', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(
      cap({ orgName: 'acme', scope: '@acme', canManageOrg: true })
    )
    render(<MarketplaceOrgArea activeTab="entries" />)
    expect(screen.getByText('Marketplace')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '@acme' })).toBeNull()
  })

  it('places Marketplace navigation below the organization header', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue(
      cap({ orgName: 'acme', scope: '@acme', canManageOrg: true })
    )
    render(<MarketplaceOrgArea activeTab="entries" />)

    const header = screen.getByText('Marketplace')
    const marketplaceTabs = screen.getByText('marketplace-tabs')
    expect(header.compareDocumentPosition(marketplaceTabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
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

  it('entries: shows Retry, not the claim prompt, on a transient capability-probe error', () => {
    // A failed getPublishScope() probe must not be read as an unclaimed org —
    // that falsely prompts a re-claim (the "unclaimed latch" bug).
    const reload = vi.fn()
    vi.mocked(capHook.useRegistryCapability).mockReturnValue({
      capability: null,
      loading: false,
      error: true,
      reload,
    })
    render(<MarketplaceOrgArea activeTab="entries" />)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText(/Name your organization/i)).toBeNull()
    expect(screen.queryByText('owned-entries')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('images: shows Retry, not the claim prompt, on a transient capability-probe error', () => {
    vi.mocked(capHook.useRegistryCapability).mockReturnValue({
      capability: null,
      loading: false,
      error: true,
      reload: vi.fn(),
    })
    render(<MarketplaceOrgArea activeTab="images" />)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText(/Name your organization/i)).toBeNull()
    expect(screen.queryByText('org-images')).toBeNull()
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
