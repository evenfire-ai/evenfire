'use client'

import { useState } from 'react'
import { CONTROL_ROUTES } from '@constants/routes'
import { useInboundGrants } from '../../lib/hooks/useInboundGrants'
import { useRegistryCapability } from '../../lib/hooks/useRegistryCapability'
import { MarketplaceOrgImages } from '../MarketplaceOrgImages'
import { MarketplaceTabs } from '../MarketplaceTabs'
import { OwnedEntries } from '../PublisherView/OwnedEntries'
import { RetryBanner } from '../PublisherView/RetryBanner'
import RegistryApiKeysPanel from '../RegistryApiKeysPanel'
import RegistryConnectPanel from '../RegistryConnectPanel'
import { SectionSearchInput } from '../SectionSearchInput'
import { IconStore } from '../Sidebar/icons'
import { TablePanelHeader } from '../TablePanelHeader'
import { IconRefresh } from '../icons'
import { Button } from '../ui'

export type OrgAreaTab = 'entries' | 'images' | 'credentials' | 'connection'

type SearchableOrgAreaTab = Exclude<OrgAreaTab, 'connection'>

function isSearchableTab(tab: OrgAreaTab): tab is SearchableOrgAreaTab {
  return tab === 'credentials' || tab === 'entries' || tab === 'images'
}

function NotClaimed({ action }: { action: string }) {
  return (
    <p className="cu-banner cu-banner--info">
      Name your organization to {action}.{' '}
      <a className="cu-link" href={CONTROL_ROUTES.marketplace.connect}>
        Connect to the registry
      </a>{' '}
      to get started.
    </p>
  )
}

/**
 * The Marketplace-owned org surfaces: peer tabs for API keys, published entries,
 * and pushed images. Publishing being disabled must not hide credentials, so API
 * keys remain self-gated by the registry-key API instead of the publishing flag.
 */
export function MarketplaceOrgArea({ activeTab }: { activeTab: OrgAreaTab }) {
  const { capability, loading, error, reload } = useRegistryCapability()
  const inbound = useInboundGrants()
  const [searchByTab, setSearchByTab] = useState<Record<SearchableOrgAreaTab, string>>({
    credentials: '',
    entries: '',
    images: '',
  })
  const [refreshSignalByTab, setRefreshSignalByTab] = useState<
    Record<SearchableOrgAreaTab, number>
  >({
    credentials: 0,
    entries: 0,
    images: 0,
  })
  const [apiKeyCreateSignal, setApiKeyCreateSignal] = useState(0)
  const [apiKeysCanCreate, setApiKeysCanCreate] = useState(false)

  const orgScope = capability?.scope ?? null
  const orgLabel = orgScope ?? (capability?.orgName ? `@${capability.orgName}` : 'This deployment')
  const canManageOrg = capability?.canManageOrg === true
  // Cross-org sharing availability, mirrored from the inbound-grants probe.
  const canShare = inbound.status === 'available' || inbound.status === 'error'
  const sharingUnavailable = inbound.status === 'unavailable'
  const activeSearch = isSearchableTab(activeTab) ? searchByTab[activeTab] : ''
  const activeLabel =
    activeTab === 'credentials'
      ? 'API keys'
      : activeTab === 'entries'
        ? 'entries'
        : activeTab === 'images'
          ? 'images'
          : 'connection'
  const activeDescription =
    activeTab === 'credentials'
      ? `${orgLabel} API keys. Create and revoke registry keys for CI, scripts, and image publishing.`
      : activeTab === 'entries'
        ? `${orgLabel} entries. Review and manage registry entries published by this deployment.`
        : activeTab === 'images'
          ? `${orgLabel} images. Review container images pushed by this deployment.`
          : `${orgLabel} registry connection. Review the deployment registry connection.`

  function setActiveSearch(value: string) {
    if (!isSearchableTab(activeTab)) return
    setSearchByTab(current => ({ ...current, [activeTab]: value }))
  }

  function refreshActiveTab() {
    if (!isSearchableTab(activeTab)) return
    setRefreshSignalByTab(current => ({ ...current, [activeTab]: current[activeTab] + 1 }))
  }

  return (
    <section>
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title={
            <>
              <IconStore />
              Marketplace
            </>
          }
          subtitle={activeDescription}
          actionsClassName="cu-registry-toolbar"
          search={
            isSearchableTab(activeTab) ? (
              <SectionSearchInput
                value={activeSearch}
                onChange={setActiveSearch}
                placeholder={`Search ${activeLabel}`}
                ariaLabel={`Search ${activeLabel}`}
                disabled={loading && !orgScope}
              />
            ) : undefined
          }
          refreshAction={
            isSearchableTab(activeTab) ? (
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                onClick={refreshActiveTab}
                aria-label={`Reload ${activeLabel}`}
              >
                <IconRefresh width={18} height={18} />
              </button>
            ) : undefined
          }
          primaryAction={
            activeTab === 'credentials' ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setApiKeyCreateSignal(signal => signal + 1)}
                disabled={!apiKeysCanCreate}
              >
                + Create key
              </Button>
            ) : undefined
          }
        />
        <MarketplaceTabs active={isSearchableTab(activeTab) ? activeTab : 'credentials'} />

        {/* Entries is a publishing surface, so it follows the publishing-UI
            toggle (canManageOrg). Credentials do NOT — turning publishing off
            must not remove API keys (design spec §6). The Credentials tab is
            the single registry-key surface (self-gating); a registry:publish
            key doubles as the Docker push credential, surfaced in the key's
            reveal dialog. */}
        {activeTab === 'entries' ? (
          loading ? (
            <div className="cu-card__body">
              <p>Loading…</p>
            </div>
          ) : error ? (
            // A transient capability-probe failure must NOT be read as an
            // unclaimed org — that would falsely prompt a re-claim. Offer Retry.
            <div className="cu-card__body">
              <RetryBanner message="Couldn’t load your organization." onRetry={reload} />
            </div>
          ) : canManageOrg && orgScope ? (
            <OwnedEntries
              orgScope={orgScope}
              canShare={canShare}
              sharingUnavailable={sharingUnavailable}
              embedded
              hideHeader
              search={searchByTab.entries}
              refreshSignal={refreshSignalByTab.entries}
            />
          ) : (
            <div className="cu-card__body">
              <NotClaimed action="publish and manage entries" />
            </div>
          )
        ) : null}

        {activeTab === 'images' ? (
          loading ? (
            <div className="cu-card__body">
              <p>Loading…</p>
            </div>
          ) : error ? (
            <div className="cu-card__body">
              <RetryBanner message="Couldn’t load your organization." onRetry={reload} />
            </div>
          ) : canManageOrg && orgScope ? (
            <MarketplaceOrgImages
              orgScope={orgScope}
              embedded
              hideHeader
              search={searchByTab.images}
              refreshSignal={refreshSignalByTab.images}
            />
          ) : (
            <div className="cu-card__body">
              <NotClaimed action="push and manage images" />
            </div>
          )
        ) : null}

        {activeTab === 'credentials' ? (
          <RegistryApiKeysPanel
            embedded
            hideHeader
            search={searchByTab.credentials}
            refreshSignal={refreshSignalByTab.credentials}
            createSignal={apiKeyCreateSignal}
            onCreateAvailabilityChange={setApiKeysCanCreate}
          />
        ) : null}

        {activeTab === 'connection' ? <RegistryConnectPanel /> : null}
      </div>
    </section>
  )
}
