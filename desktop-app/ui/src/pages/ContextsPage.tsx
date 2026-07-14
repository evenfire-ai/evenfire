import { useMemo } from 'react'
import { DataTable, EmptyState } from '@components/Common'
import { useNavigationContext } from '../contexts/NavigationContext'
import { useContextsDataController } from '../hooks/domain/useContextsDataController'
import { clickableRowProps } from '../lib/clickableRowProps'

export function ContextsPage() {
  const { contextIds, loading, error } = useContextsDataController()
  const { selectedContext, handleOpenContextDetails } = useNavigationContext()

  const contextRows = useMemo(
    () => [...contextIds].sort((a, b) => a.localeCompare(b)).map(id => ({ id })),
    [contextIds]
  )

  return (
    <section className="page">
      <div className="page-header">
        <h2>Contexts</h2>
        <p className="muted">
          Real access catalog for your available user and team access. Click a context to open
          details.
        </p>
      </div>
      <div className="page-layout">
        <section className="page-card contexts-board-card">
          {loading && !contextRows.length && (
            <EmptyState title="Loading" body="Fetching authorized contexts..." />
          )}
          {error && !contextRows.length && !loading && (
            <div className="composer-error" role="alert">
              <p className="error-text">{error}</p>
            </div>
          )}
          {!loading && !error && !contextRows.length && (
            <EmptyState
              title="No contexts"
              body="No contexts are currently mapped to this user/team."
            />
          )}
          {Boolean(contextRows.length) && (
            <DataTable frameless fullBleed className="contexts-data-table">
              <thead>
                <tr>
                  <th className="da-table__col-header" scope="col">
                    Context
                  </th>
                </tr>
              </thead>
              <tbody>
                {contextRows.map(row => (
                  <tr
                    key={row.id}
                    className={`da-table__row--clickable${
                      selectedContext === row.id ? ' da-table__row--selected' : ''
                    }`}
                    {...clickableRowProps(() => handleOpenContextDetails(row.id), {
                      ariaLabel: `Open context ${row.id}`,
                      selected: selectedContext === row.id,
                    })}
                  >
                    <td className="da-table__cell">
                      <span className="context-id-cell">
                        <strong>{row.id}</strong>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </section>
      </div>
    </section>
  )
}
