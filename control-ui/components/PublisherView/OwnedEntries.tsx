'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { type OwnedRegistryEntry, getOwnedRegistryEntries } from '../../lib/api'
import { TableHeaderRow } from '../TableHeaderRow'
import type { TableHeaderColumn } from '../TableHeaderRow/types'
import { Button } from '../ui'
import { GrantAccessModal } from './GrantAccessModal'
import { RetryBanner } from './RetryBanner'

const COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'version', label: 'Version' },
  { key: 'visibility', label: 'Visibility' },
  { key: 'status', label: 'Status' },
  { key: 'actions', ariaLabel: 'Actions', align: 'right' },
]

function entryKey(e: OwnedRegistryEntry): string {
  return `${e.name}@${e.version}`
}

// The registry's owned-entries payload carries `serverMode` but not `entry_type`
// (mcp-servers always have a serverMode; recipes don't). Prefer an explicit
// entry_type if the registry ever starts sending it, else infer from serverMode.
// "Connector" / "Plugin" mirror the labels in PublishToRegistryForm.
function entryTypeLabel(e: OwnedRegistryEntry): string {
  const kind = e.entry_type ?? (e.serverMode != null ? 'mcp-server' : 'recipe')
  return kind === 'mcp-server' ? 'Connector' : 'Plugin'
}

export function OwnedEntries({ orgScope }: { orgScope: string }) {
  const [entries, setEntries] = useState<OwnedRegistryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [grantTarget, setGrantTarget] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const { data } = await getOwnedRegistryEntries()
      setEntries(data)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <p>Loading your published entries…</p>
  if (error) {
    return (
      <RetryBanner message="Could not load your published entries." onRetry={() => void load()} />
    )
  }
  if (entries.length === 0) {
    return <p>You haven’t published any registry entries yet.</p>
  }

  return (
    <>
      <div className="cu-table-wrap">
        <table className="cu-table">
          <thead>
            <TableHeaderRow columns={COLUMNS} />
          </thead>
          <tbody>
            {entries.map(e => {
              const k = entryKey(e)
              const isPrivate = e.visibility === 'private'
              const isGranting = grantTarget === e.name
              return (
                <tr key={k}>
                  <td>
                    <code>{e.name}</code>
                  </td>
                  <td>{entryTypeLabel(e)}</td>
                  <td>{e.version}</td>
                  <td>
                    <span
                      className={`cu-registry-chip cu-registry-chip--visibility-${e.visibility}`}
                    >
                      {e.visibility}
                    </span>
                  </td>
                  <td>{e.status}</td>
                  <td style={{ textAlign: 'right' }}>
                    {isPrivate ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-haspopup="dialog"
                        aria-expanded={isGranting}
                        onClick={() => setGrantTarget(e.name)}
                      >
                        Share access
                      </Button>
                    ) : (
                      <span className="cu-muted-note--compact">Public — no grant needed</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {grantTarget ? (
        <GrantAccessModal
          entryName={grantTarget}
          orgScope={orgScope}
          onClose={() => setGrantTarget(null)}
        />
      ) : null}
    </>
  )
}
