'use client'

import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import { useInboundGrants } from '../../lib/hooks/useInboundGrants'
import { useRegistryCapability } from '../../lib/hooks/useRegistryCapability'
import { MarketplaceOrgImages } from '../MarketplaceOrgImages'
import { MarketplaceTabs } from '../MarketplaceTabs'
import { DockerCredentialsPanel } from '../PublisherView/DockerCredentials'
import { OwnedEntries } from '../PublisherView/OwnedEntries'
import { RetryBanner } from '../PublisherView/RetryBanner'
import RegistryApiKeysPanel from '../RegistryApiKeysPanel'
import RegistryConnectPanel from '../RegistryConnectPanel'
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

  const orgName = capability?.orgName ?? null
  const orgLabel = orgName ? `@${orgName}` : loading ? 'Organization' : 'Your org'
  // Once we know the org, its name is a shortcut into the org's own published
  // plugins (the Entries tab). While the name is still resolving, keep it plain
  // text so we don't link a placeholder label.
  const orgTitle = orgName ? (
    <Link className="cu-link" href={CONTROL_ROUTES.marketplace.orgEntries}>
      {orgLabel}
    </Link>
  ) : (
    orgLabel
  )
  const orgScope = capability?.scope ?? null
  const canManageOrg = capability?.canManageOrg === true
  // Cross-org sharing availability, mirrored from the inbound-grants probe.
  const canShare = inbound.status === 'available' || inbound.status === 'error'
  const sharingUnavailable = inbound.status === 'unavailable'

  return (
    <section>
      <div className="cu-card cu-card--viewport-fill">
        <MarketplaceTabs active="org" />
        <TablePanelHeader title={orgTitle} subtitle="Everything your org owns on the registry" />
        <div className="cu-card__body">
          <TabBar<OrgAreaTab>
            ariaLabel="Organization sections"
            activeValue={activeTab}
            className="cu-tabs--flush-top"
            options={SUB_TABS}
          />

          {/* Entries is a publishing surface, so it follows the publishing-UI
              toggle (canManageOrg). Credentials and Connection do NOT — turning
              publishing off must not remove push credentials or the connection
              status (design spec §6). The Credentials tab renders the registry
              API keys (self-gating) and, once the org scope is known, the Docker
              push credential — the target of the Images tab's "get a push
              credential from the API Keys tab" pointer. Design spec §5.1 folds
              both into a unified RegistryCredentials view in Phase 5. */}
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

          {activeTab === 'credentials' ? (
            <>
              <RegistryApiKeysPanel />
              {/* Gated on the org scope (needed to build the push coordinates),
                  not on the publishing toggle — push credentials survive
                  publishing being turned off (§6). */}
              {orgScope ? <DockerCredentialsPanel orgScope={orgScope} /> : null}
            </>
          ) : null}

          {activeTab === 'connection' ? <RegistryConnectPanel /> : null}
        </div>
      </div>
    </section>
  )
}
