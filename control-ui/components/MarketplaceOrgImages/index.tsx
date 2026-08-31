'use client'

import { useCallback, useEffect, useState } from 'react'
import { DataTable, TableStateRow, useTableSort } from '@clerum/frontend-table-system'
import { CONTROL_ROUTES } from '@constants/routes'
import { type OrgImage, listOrgImages } from '../../lib/api'
import {
  DEFAULT_REGISTRY_HOST,
  buildImageCoordinate,
  dockerNamespace,
} from '../PublisherView/dockerCredential'
import { TableHeaderRow } from '../TableHeaderRow'
import type { TableHeaderColumn } from '../TableHeaderRow/types'
import { TablePanelHeader } from '../TablePanelHeader'

const COLUMNS: TableHeaderColumn[] = [
  { key: 'image', label: 'Image' },
  { key: 'tag', label: 'Tag' },
  { key: 'coordinate', label: 'Coordinate' },
]

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; images: OrgImage[] }
  | { kind: 'unavailable' } // registry hasn't exposed the image-listing endpoint yet
  | { kind: 'error' }

/**
 * Images area (design spec §4/§5.5). Lists the org's actual container image
 * repositories from the registry with their fully-qualified coordinate. Until
 * the registry exposes the listing endpoint, this shows an "unavailable" notice
 * rather than failing.
 */
export function MarketplaceOrgImages({ orgScope }: { orgScope: string }) {
  const [view, setView] = useState<View>({ kind: 'loading' })

  const load = useCallback(async () => {
    setView({ kind: 'loading' })
    try {
      const { images } = await listOrgImages()
      setView({ kind: 'ready', images })
    } catch (e) {
      const status = (e as { status?: number }).status
      // The registry image-listing endpoint may not be deployed yet.
      if (status === 404 || status === 501) setView({ kind: 'unavailable' })
      else setView({ kind: 'error' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const namespace = dockerNamespace(orgScope)

  // One row per (image, tag). The registry lists repos without tags today, so a
  // tag-less repo renders with a `<tag>` placeholder in its coordinate.
  const rows =
    view.kind === 'ready'
      ? (view.images ?? []).flatMap(img =>
          (img.tags ?? []).length > 0
            ? img.tags.map(tag => ({ name: img.name, tag }))
            : [{ name: img.name, tag: '<tag>' }]
        )
      : []
  const imageSort = useTableSort<(typeof rows)[number], 'image' | 'tag' | 'coordinate'>({
    rows,
    defaultKey: 'image',
    identity: row => `${row.name}:${row.tag}`,
    accessors: {
      image: row => row.name,
      tag: row => row.tag,
      coordinate: row => buildImageCoordinate(DEFAULT_REGISTRY_HOST, orgScope, row.name, row.tag),
    },
  })
  const columns = COLUMNS.map(column => ({
    ...column,
    activeDirection: imageSort.key === column.key ? imageSort.direction : null,
    onSort: () => imageSort.sortBy(column.key as 'image' | 'tag' | 'coordinate'),
  }))

  return (
    <section>
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title="Images"
          subtitle={
            <>
              Your connectors and plugins push container images to{' '}
              <code>
                {DEFAULT_REGISTRY_HOST}/{namespace}/
              </code>
              . Authenticate with a push credential from the{' '}
              <a className="cu-link" href={CONTROL_ROUTES.marketplace.orgCredentials}>
                API Keys
              </a>{' '}
              tab; each image&apos;s full coordinate is below.
            </>
          }
        />
        <div className="cu-card__body">
          <div className="eft-table-viewport cu-table-wrap">
            <DataTable className="eft-table cu-table">
              <thead>
                <TableHeaderRow columns={columns} />
              </thead>
              <tbody>
                {view.kind === 'loading' ? (
                  <TableStateRow
                    colSpan={columns.length}
                    kind="loading"
                    message="Loading images…"
                  />
                ) : view.kind === 'error' ? (
                  <TableStateRow
                    action={
                      <button
                        type="button"
                        className="cu-btn cu-btn--ghost cu-btn--sm"
                        onClick={() => void load()}
                      >
                        Retry
                      </button>
                    }
                    colSpan={columns.length}
                    kind="error"
                    message="Could not load your images."
                  />
                ) : view.kind === 'unavailable' ? (
                  <TableStateRow
                    colSpan={columns.length}
                    message="Image listing isn’t available on this registry yet. Your pushed images still work."
                  />
                ) : rows.length === 0 ? (
                  <TableStateRow
                    colSpan={columns.length}
                    message={
                      <>
                        No images yet. Push a connector or plugin image under{' '}
                        <code>
                          {DEFAULT_REGISTRY_HOST}/{namespace}/
                        </code>{' '}
                        and it appears here.
                      </>
                    }
                  />
                ) : (
                  imageSort.sortedRows.map(r => (
                    <tr key={`${r.name}:${r.tag}`}>
                      <td>
                        <code>{r.name}</code>
                      </td>
                      <td>{r.tag}</td>
                      <td>
                        <code>
                          {buildImageCoordinate(DEFAULT_REGISTRY_HOST, orgScope, r.name, r.tag)}
                        </code>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </DataTable>
          </div>
          {view.kind === 'ready' && rows.length > 0 ? (
            <p className="cu-muted-note cu-muted-note--spaced">
              A push can still be rejected if the credential lacks publish permission or the org has
              reached its image quota — those surface at push time.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
