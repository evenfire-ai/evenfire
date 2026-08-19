'use client'

import { CONTROL_ROUTES } from '@constants/routes'
import { useInboundGrants } from '../../lib/hooks/useInboundGrants'
import { useRegistryCapability } from '../../lib/hooks/useRegistryCapability'
import { MarketplaceOrgImages } from '../MarketplaceOrgImages'
import { MarketplaceTabs } from '../MarketplaceTabs'
import { OwnedEntries } from '../PublisherView/OwnedEntries'
import { RetryBanner } from '../PublisherView/RetryBanner'
import RegistryApiKeysPanel from '../RegistryApiKeysPanel'
import RegistryConnectPanel from '../RegistryConnectPanel'
import { IconStore } from '../Sidebar/icons'
import { TabBar } from '../TabBar'
import { TablePanelHeader } from '../TablePanelHeader'

export type OrgAreaTab = 'entries' | 'images' | 'credentials' | 'connection'

const SUB_TABS: { value: OrgAreaTab; href: string; label: string }[] = [
  { value: 'credentials', href: CONTROL_ROUTES.marketplace.orgCredentials, label: 'API Keys' },
  { value: 'entries', href: CONTROL_ROUTES.marketplace.orgEntries, label: 'Entries' },
  { value: 'images', href: CONTROL_ROUTES.marketplace.orgImages, label: 'Images' },
  // Connection sub-tab hidden for now: once connected it only shows a static,
  // non-actionable status. Claiming still lives at the standalone connect page,
  // and Phase 3 replaces it with an inline claim. Restore to bring it back.
  // { value: 'connection', href: CONTROL_ROUTES.marketplace.orgConnection, label: 'Connection' },
]

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
 * The org-named Marketplace tab (design spec §4): a single home for everything
 * this deployment owns — its published entries, push credentials, and its
 * registry connection. This folds the standalone Publisher console into the
 * Marketplace. Publishing being disabled must not hide credentials or the
 * connection status, so those sub-tabs are always reachable.
 */
export function MarketplaceOrgArea({ activeTab }: { activeTab: OrgAreaTab }) {
  const { capability, loading, error, reload } = useRegistryCapability()
  const inbound = useInboundGrants()

  const orgScope = capability?.scope ?? null
  const canManageOrg = capability?.canManageOrg === true
  // Cross-org sharing availability, mirrored from the inbound-grants probe.
  const canShare = inbound.status === 'available' || inbound.status === 'error'
  const sharingUnavailable = inbound.status === 'unavailable'

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
          subtitle="Everything your org owns on the registry"
        />
        <MarketplaceTabs active="org" />
        <div className="cu-card__body">
          <TabBar<OrgAreaTab>
            ariaLabel="Organization sections"
            activeValue={activeTab}
            className="cu-tabs--flush-top"
            options={SUB_TABS}
          />

          {/* Entries is a publishing surface, so it follows the publishing-UI
              toggle (canManageOrg). Credentials and Connection do NOT — turning
              publishing off must not remove API keys or the connection status
              (design spec §6). The Credentials tab is the single registry-key
              surface (self-gating); a registry:publish key doubles as the Docker
              push credential, surfaced in the key's reveal dialog. */}
          {activeTab === 'entries' ? (
            loading ? (
              <p>Loading…</p>
            ) : error ? (
              // A transient capability-probe failure must NOT be read as an
              // unclaimed org — that would falsely prompt a re-claim. Offer Retry.
              <RetryBanner message="Couldn’t load your organization." onRetry={reload} />
            ) : canManageOrg && orgScope ? (
              <OwnedEntries
                orgScope={orgScope}
                canShare={canShare}
                sharingUnavailable={sharingUnavailable}
              />
            ) : (
              <NotClaimed action="publish and manage entries" />
            )
          ) : null}

          {activeTab === 'images' ? (
            loading ? (
              <p>Loading…</p>
            ) : error ? (
              <RetryBanner message="Couldn’t load your organization." onRetry={reload} />
            ) : canManageOrg && orgScope ? (
              <MarketplaceOrgImages orgScope={orgScope} />
            ) : (
              <NotClaimed action="push and manage images" />
            )
          ) : null}

          {activeTab === 'credentials' ? <RegistryApiKeysPanel /> : null}

          {activeTab === 'connection' ? <RegistryConnectPanel /> : null}
        </div>
      </div>
    </section>
  )
}
