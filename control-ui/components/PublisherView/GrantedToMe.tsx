'use client'

import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import type { GrantedToMeItem } from '../../lib/api'
import type { InboundGrantsStatus } from '../../lib/hooks/useInboundGrants'
import { TableHeaderRow } from '../TableHeaderRow'
import type { TableHeaderColumn } from '../TableHeaderRow/types'
import { RetryBanner } from './RetryBanner'

const COLUMNS: TableHeaderColumn[] = [
  { key: 'plugin', label: 'Plugin' },
  { key: 'owner', label: 'Shared by' },
  { key: 'since', label: 'Since' },
]

function fmt(v?: string): string {
  return v ? new Date(v).toLocaleDateString() : '—'
}

/**
 * Presentational — the fetch lives in `useInboundGrants` (owned by PublisherView,
 * which also uses its status to hide this tab when `unavailable`). On a deep-link
 * to the hidden route we still render, so `unavailable` shows an accurate
 * signpost rather than an error: shared plugins are installable from the
 * Marketplace even though this convenience list isn't served for the deployment.
 */
export function GrantedToMe({
  status,
  grants,
  reload,
}: {
  status: InboundGrantsStatus
  grants: GrantedToMeItem[]
  reload: () => void
}) {
  if (status === 'loading') return <p>Loading…</p>
  if (status === 'unavailable') {
    return (
      <p className="cu-banner cu-banner--warn">
        Plugins shared with your org appear in your{' '}
        <Link href={CONTROL_ROUTES.marketplace.root}>Marketplace catalog</Link> and can be installed
        from there.
      </p>
    )
  }
  if (status === 'error') {
    return <RetryBanner message="Could not load inbound grants." onRetry={reload} />
  }
  if (grants.length === 0) {
    return <p>No plugins have been shared with your org yet.</p>
  }

  return (
    <div className="cu-table-wrap">
      <table className="cu-table">
        <thead>
          <TableHeaderRow columns={COLUMNS} />
        </thead>
        <tbody>
          {grants.map(g => (
            <tr key={`${g.ownerOrg}/${g.pluginName}`}>
              <td>
                <code>{g.pluginName}</code>
              </td>
              <td>{g.ownerOrg}</td>
              <td>{fmt(g.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
