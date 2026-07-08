'use client'

import { useCallback, useEffect, useState } from 'react'
import { type GrantedToMeItem, listGrantedToMe } from '../../lib/api'
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

export function GrantedToMe() {
  const [grants, setGrants] = useState<GrantedToMeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const { grants: rows } = await listGrantedToMe()
      setGrants(rows)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <p>Loading…</p>
  if (error) {
    return <RetryBanner message="Could not load inbound grants." onRetry={() => void load()} />
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
