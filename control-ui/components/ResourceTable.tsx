'use client'

import React, { useMemo } from 'react'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TablePanelHeader } from './TablePanelHeader'
import { IconRefresh } from './icons'

type Item = {
  metadata?: { name?: string; namespace?: string }
  spec?: Record<string, unknown>
}

function getDescription(item: Item): string {
  const spec = item.spec || {}
  if (typeof spec.description === 'string') return spec.description
  if (typeof spec.contextRef === 'string') return `contextRef: ${spec.contextRef}`
  if (typeof spec.hostRef === 'string') return `hostRef: ${spec.hostRef}`
  return '-'
}

export function ResourceTable({
  title,
  items,
  loading,
  onRefresh,
  refreshing,
}: {
  title: string
  items: Item[]
  loading?: boolean
  onRefresh?: () => void
  refreshing?: boolean
}) {
  const rows = useMemo(
    () =>
      items.map(i => ({
        key: `${i.metadata?.namespace || 'default'}/${i.metadata?.name || 'unknown'}`,
        item: i,
      })),
    [items]
  )

  const isInitialLoad = loading && items.length === 0

  return (
    <div className="cu-card">
      <div className="cu-card__body">
        <TablePanelHeader
          title={isInitialLoad ? title : `${title} (${rows.length})`}
          subtitle="Inspect linked resources and their summaries."
          actions={
            onRefresh ? (
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                onClick={() => void onRefresh()}
                disabled={refreshing}
                aria-label={refreshing ? 'Refreshing…' : `Reload ${title.toLowerCase()}`}
              >
                <IconRefresh
                  className={refreshing ? 'cu-spin' : undefined}
                  width={18}
                  height={18}
                />
              </button>
            ) : null
          }
        />
        {isInitialLoad ? (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--profile">
              <thead>
                <tr>
                  <th>Connector name</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                <SkeletonTableRows columns={2} rows={5} />
              </tbody>
            </table>
          </div>
        ) : rows.length === 0 ? (
          <div className="cu-empty">No resources found.</div>
        ) : (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--profile">
              <thead>
                <tr>
                  <th>Connector name</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ key, item }) => (
                  <tr key={key}>
                    <td>
                      <button
                        type="button"
                        className="cu-link"
                        onClick={() => {
                          if (item.metadata?.name) {
                            // For now, no navigation - just display the name
                          }
                        }}
                      >
                        {item.metadata?.name || '-'}
                      </button>
                    </td>
                    <td style={{ color: 'var(--cu-text-muted)', fontSize: '0.8125rem' }}>
                      {getDescription(item)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
