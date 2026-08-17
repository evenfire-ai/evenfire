'use client'

import { useCallback, useEffect, useState } from 'react'
import { CONTROL_ROUTES } from '@constants/routes'
import { type OrgImage, listOrgImages } from '../../lib/api'
import { RetryBanner } from '../PublisherView/RetryBanner'
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
          {view.kind === 'loading' ? <p>Loading your images…</p> : null}
          {view.kind === 'error' ? (
            <RetryBanner message="Could not load your images." onRetry={() => void load()} />
          ) : null}
          {view.kind === 'unavailable' ? (
            <p className="cu-banner cu-banner--info">
              Image listing isn’t available on this registry yet. Your pushed images still work —
              the list will appear here once the registry exposes it.
            </p>
          ) : null}

          {view.kind === 'ready' && rows.length === 0 ? (
            <p>
              No images yet. Push a connector or plugin image under{' '}
              <code>
                {DEFAULT_REGISTRY_HOST}/{namespace}/
              </code>{' '}
              and it appears here.
            </p>
          ) : null}

          {view.kind === 'ready' && rows.length > 0 ? (
            <>
              <div className="cu-table-wrap">
                <table className="cu-table">
                  <thead>
                    <TableHeaderRow columns={COLUMNS} />
                  </thead>
                  <tbody>
                    {rows.map(r => (
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
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="cu-muted-note cu-muted-note--spaced">
                A push can still be rejected if the credential lacks publish permission or the org
                has reached its image quota — those surface at push time.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </section>
  )
}
