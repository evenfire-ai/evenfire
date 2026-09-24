'use client'

import Link from 'next/link'
import { DataTable, TableStateRow, TableViewport, useTableSort } from '@clerum/frontend-components'
import { CONTROL_ROUTES } from '@constants/routes'
import type { GrantedToMeItem } from '../../lib/api'
import type { InboundGrantsStatus } from '../../lib/hooks/useInboundGrants'
import { TableHeaderRow } from '../TableHeaderRow'
import type { TableHeaderColumn } from '../TableHeaderRow/types'

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
  const grantSort = useTableSort<GrantedToMeItem, 'plugin' | 'owner' | 'since'>({
    rows: grants,
    defaultKey: 'plugin',
    identity: grant => `${grant.ownerOrg}/${grant.pluginName}`,
    accessors: {
      plugin: grant => grant.pluginName,
      owner: grant => grant.ownerOrg,
      since: grant => grant.createdAt,
    },
  })
  const columns = COLUMNS.map(column => ({
    ...column,
    activeDirection: grantSort.key === column.key ? grantSort.direction : null,
    onSort: () => grantSort.sortBy(column.key as 'plugin' | 'owner' | 'since'),
  }))
  return (
    <TableViewport className="cu-table-wrap">
      <DataTable className="eft-table cu-table">
        <thead>
          <TableHeaderRow columns={columns} />
        </thead>
        <tbody>
          {status === 'loading' ? (
            <TableStateRow
              colSpan={columns.length}
              kind="loading"
              message="Loading shared plugins…"
            />
          ) : status === 'error' ? (
            <TableStateRow
              action={
                <button type="button" className="cu-btn cu-btn--ghost cu-btn--sm" onClick={reload}>
                  Retry
                </button>
              }
              colSpan={columns.length}
              kind="error"
              message="Could not load inbound grants."
            />
          ) : status === 'unavailable' ? (
            <TableStateRow
              colSpan={columns.length}
              message={
                <>
                  Plugins shared with your org appear in your{' '}
                  <Link href={CONTROL_ROUTES.marketplace.root}>Marketplace catalog</Link> and can be
                  installed from there.
                </>
              }
            />
          ) : grants.length === 0 ? (
            <TableStateRow
              colSpan={columns.length}
              message="No plugins have been shared with your org yet."
            />
          ) : (
            grantSort.sortedRows.map(g => (
              <tr key={`${g.ownerOrg}/${g.pluginName}`}>
                <td>
                  <code>{g.pluginName}</code>
                </td>
                <td>{g.ownerOrg}</td>
                <td>{fmt(g.createdAt)}</td>
              </tr>
            ))
          )}
        </tbody>
      </DataTable>
    </TableViewport>
  )
}
