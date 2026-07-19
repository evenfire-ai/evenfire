'use client'

import { CONTROL_ROUTES } from '@constants/routes'
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

  return (
    <section>
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader title={`Publisher — @${orgScope}`} />
        <div className="cu-card__body">
          <TabBar<PublisherTab>
            ariaLabel="Publisher sections"
            activeValue={activeTab}
            className="cu-tabs--flush-top"
            options={TABS}
          />
          {activeTab === 'entries' ? <OwnedEntries orgScope={orgScope} /> : null}
          {activeTab === 'shared' ? <GrantedToMe /> : null}
          {activeTab === 'credentials' ? <DockerCredentialsPanel orgScope={orgScope} /> : null}
        </div>
      </div>
    </section>
  )
}
