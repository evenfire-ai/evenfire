'use client'

import { CONTROL_ROUTES } from '@constants/routes'
import { useInboundGrants } from '../../lib/hooks/useInboundGrants'
import { isPublisherEnabled, usePublishScope } from '../../lib/hooks/usePublishScope'
import { TabBar } from '../TabBar'
import { TablePanelHeader } from '../TablePanelHeader'
import { DockerCredentialsPanel } from './DockerCredentials'
import { GrantedToMe } from './GrantedToMe'
import { OwnedEntries } from './OwnedEntries'
import type { PublisherTab } from './types'

const TABS: { value: PublisherTab; href: string; label: string }[] = [
  { value: 'entries', href: CONTROL_ROUTES.publisher.entries, label: 'Published entries' },
  { value: 'shared', href: CONTROL_ROUTES.publisher.sharedWithMe, label: 'Shared with me' },
  { value: 'credentials', href: CONTROL_ROUTES.publisher.credentials, label: 'Docker credentials' },
]

export function PublisherView({ activeTab }: { activeTab: PublisherTab }) {
  const { scope, loading } = usePublishScope()
  const inbound = useInboundGrants()

  if (loading) {
    return (
      <div className="cu-card">
        <div className="cu-card__body">Loading…</div>
      </div>
    )
  }

  if (!isPublisherEnabled(scope)) {
    return (
      <div className="cu-card">
        <div className="cu-card__body">
          <p className="cu-banner cu-banner--warn">
            Publishing is not available on this deployment. The Publisher view is for org-bound
            tenants; this console is not bound to a registry org.
          </p>
        </div>
      </div>
    )
  }

  const orgScope = scope.scope

  // Grant *listing* is a hosted/curator surface. A self-hosted deploy's registry
  // client lacks `registry:grant`, so `granted-to-me` 403s (`unavailable`) — hide
  // the "Shared with me" tab (plugins shared with the org still install from the
  // Marketplace). Transient errors keep the tab (the feature exists); it stays
  // hidden only while probing or on a 403.
  const tabs =
    inbound.status === 'available' || inbound.status === 'error'
      ? TABS
      : TABS.filter(t => t.value !== 'shared')

  // Cross-org sharing needs the registry `registry:grant` scope. The inbound
  // probe is the proxy: `available`/`error` means the scope is present (offer
  // sharing), while `unavailable` (403) is a self-hosted org that can never
  // share — state the limit rather than offering a control that gets refused.
  const canShare = inbound.status === 'available' || inbound.status === 'error'
  const sharingUnavailable = inbound.status === 'unavailable'

  return (
    <section>
      <div className="cu-card cu-card--viewport-fill">
        {/* orgScope (scope.scope) is already `@<org>`-prefixed by resolvePublishScope(); do not add another '@'. */}
        <TablePanelHeader title={`Publisher — ${orgScope}`} />
        <div className="cu-card__body">
          <TabBar<PublisherTab>
            ariaLabel="Publisher sections"
            activeValue={activeTab}
            className="cu-tabs--flush-top"
            options={tabs}
          />
          {activeTab === 'entries' ? (
            <OwnedEntries
              orgScope={orgScope}
              canShare={canShare}
              sharingUnavailable={sharingUnavailable}
            />
          ) : null}
          {activeTab === 'shared' ? (
            <GrantedToMe status={inbound.status} grants={inbound.grants} reload={inbound.reload} />
          ) : null}
          {activeTab === 'credentials' ? <DockerCredentialsPanel orgScope={orgScope} /> : null}
        </div>
      </div>
    </section>
  )
}
