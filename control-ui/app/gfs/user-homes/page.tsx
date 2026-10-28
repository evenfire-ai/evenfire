'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { DataTable, TableRow, TableViewport } from '@clerum/frontend-components'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { TableHeaderRow } from '@components/TableHeaderRow'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { CONTROL_ROUTES } from '@constants/routes'
import { type GfsUserHomeInventory, type GfsUserHomeState, getGfsUserHomes } from '@lib/api'

const STATES: GfsUserHomeState[] = ['pending', 'ready', 'conflict', 'retired']

export default function GfsUserHomesPage() {
  const router = useRouter()
  const [state, setState] = useState<GfsUserHomeState | ''>('')
  const [cursor, setCursor] = useState<string | undefined>()
  const [previousCursors, setPreviousCursors] = useState<Array<string | undefined>>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [inventory, setInventory] = useState<GfsUserHomeInventory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void getGfsUserHomes({ state: state || undefined, cursor }, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setInventory(result)
      })
      .catch(caught => {
        if (!controller.signal.aborted) {
          setInventory(null)
          setError(caught instanceof Error ? caught.message : 'Could not load home folders.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [state, cursor, refreshKey])

  function selectState(value: GfsUserHomeState | '') {
    setState(value)
    setCursor(undefined)
    setPreviousCursors([])
  }

  return (
    <AuthGate>
      <DashboardLayout>
        <div className="cu-card cu-card--viewport-fill">
          <TablePanelHeader
            title="Home folders"
            subtitle="Review home folder status and resolve conflicts."
            refreshAction={
              <button
                className="cu-btn cu-btn--ghost cu-btn--sm"
                type="button"
                disabled={loading}
                onClick={() => setRefreshKey(value => value + 1)}
              >
                Refresh
              </button>
            }
          />
          <div className="cu-card__body">
            {inventory ? (
              <section aria-label="Home folder counts">
                <dl>
                  {STATES.map(item => (
                    <div key={item}>
                      <dt>{item}</dt>
                      <dd>{inventory.counts[item]}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}
            <div className="cu-field">
              <label htmlFor="home-inventory-state">Home state</label>
              <select
                id="home-inventory-state"
                value={state}
                onChange={event => selectState(event.currentTarget.value as GfsUserHomeState | '')}
              >
                <option value="">All states</option>
                {STATES.map(item => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            {error ? <p role="alert">{error}</p> : null}
            <TableViewport className="cu-table-wrap">
              <DataTable aria-label="Home folders" className="cu-table">
                <thead>
                  <TableHeaderRow
                    columns={[
                      { key: 'user', label: 'User ID' },
                      { key: 'email', label: 'Email' },
                      { key: 'state', label: 'State' },
                      { key: 'path', label: 'Path' },
                      { key: 'drive', label: 'Drive' },
                    ]}
                  />
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5}>Loading home folders…</td>
                    </tr>
                  ) : null}
                  {!loading && error ? (
                    <tr>
                      <td colSpan={5}>Home folders could not be loaded.</td>
                    </tr>
                  ) : null}
                  {!loading && !error && inventory?.items.length === 0 ? (
                    <tr>
                      <td colSpan={5}>No home folders match this state.</td>
                    </tr>
                  ) : null}
                  {!loading && !error
                    ? inventory?.items.map(home => (
                        <TableRow
                          key={home.userId}
                          onNavigate={() =>
                            router.push(CONTROL_ROUTES.usersAndTeams.user(home.userId))
                          }
                        >
                          <td>
                            <Link href={CONTROL_ROUTES.usersAndTeams.user(home.userId)}>
                              {home.userId}
                            </Link>
                          </td>
                          <td>
                            {home.email ??
                              (home.state === 'retired' && home.name === null
                                ? 'Deleted user'
                                : 'Not available')}
                          </td>
                          <td>{home.state}</td>
                          <td>{home.path ?? 'Not available'}</td>
                          <td>{home.drive ?? 'Not assigned'}</td>
                        </TableRow>
                      ))
                    : null}
                </tbody>
              </DataTable>
            </TableViewport>
            <nav aria-label="Home inventory pages">
              <button
                className="cu-btn cu-btn--ghost"
                type="button"
                disabled={loading || previousCursors.length === 0}
                onClick={() => {
                  const previous = previousCursors[previousCursors.length - 1]
                  setPreviousCursors(previousCursors.slice(0, -1))
                  setCursor(previous)
                }}
              >
                Previous
              </button>
              <button
                className="cu-btn cu-btn--ghost"
                type="button"
                disabled={loading || !inventory?.nextCursor}
                onClick={() => {
                  if (!inventory?.nextCursor) return
                  setPreviousCursors([...previousCursors, cursor])
                  setCursor(inventory.nextCursor)
                }}
              >
                Next
              </button>
            </nav>
          </div>
        </div>
      </DashboardLayout>
    </AuthGate>
  )
}
