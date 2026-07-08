'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { IconFolder, IconServer, IconSharedFiles } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { Button } from '@components/ui'
import { apiGet, apiSend, isSilentApiError } from '@lib/api'
import { normalizeGfsResourceName } from '@lib/gfsResourceName'
import { GfsGrantPanel } from './GfsGrantPanel'

/** A child node as returned by /api/v1/gfs/tree and /resources/:id/children. */
interface GfsChild {
  resourceId: string
  rid: string
  gfsUri: string
  name: string
  kind: string
  path: string | null
  bytes: number
  version: number
}

interface TreePage {
  items: GfsChild[]
  nextCursor: string | null
  rootResourceId?: string
}

interface Crumb {
  /** null = the synthetic drive root (listed via /gfs/tree). */
  id: string | null
  rid: string | null
  name: string
}

const DRIVE = 'main'

function GfsCopyLinkIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 0; value >= 1024 && index < units.length - 1; index += 1) {
    value /= 1024
    unit = units[index + 1]
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

function resourceMeta(child: GfsChild): string {
  const kind = child.kind === 'directory' ? 'Folder' : 'File'
  if (child.kind === 'directory') return kind
  return `${kind} / ${formatBytes(child.bytes)} / v${child.version}`
}

async function fileToEncodedData(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/**
 * Operator browser for the Global File System. It lists the drive tree through
 * control-api and uses the operator-scoped GFS proxy for create, upload,
 * replace, rename, and delete operations while access grants stay on the
 * control-api permission surface.
 */
function ridOfResourceId(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

export function GfsBrowser(): React.JSX.Element {
  const { showToast } = useToast()
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, rid: null, name: '/' }])
  const [forwardCrumbs, setForwardCrumbs] = useState<Crumb[]>([])
  const [items, setItems] = useState<GfsChild[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Operator selects a resource to delegate access on (grant/share panel).
  const [selected, setSelected] = useState<GfsChild | null>(null)

  const current = crumbs[crumbs.length - 1]
  const currentLabel = current?.name === '/' ? 'Drive root' : current?.name || 'Drive root'

  const load = useCallback(async (crumb: Crumb, cursor?: string): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const path =
        crumb.id === null
          ? '/api/v1/gfs/tree'
          : `/api/v1/gfs/resources/${encodeURIComponent(crumb.id)}/children`
      const query: Record<string, string> = { drive: DRIVE }
      if (cursor) query.cursor = cursor
      const page = (await apiGet(path, query)) as TreePage
      if (crumb.id === null && page.rootResourceId) {
        setCrumbs(prev =>
          prev[0]?.id === null
            ? [
                { ...prev[0], id: page.rootResourceId, rid: ridOfResourceId(page.rootResourceId) },
                ...prev.slice(1),
              ]
            : prev
        )
      }
      setItems(prev => (cursor ? [...prev, ...page.items] : page.items))
      setNextCursor(page.nextCursor)
    } catch (err) {
      if (!isSilentApiError(err)) {
        setError(err instanceof Error ? err.message : 'Failed to load the Global File System')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(current)
    // Reload whenever the current folder changes (navigation).
  }, [current, load])

  function openDirectory(child: GfsChild): void {
    if (child.kind !== 'directory') return
    setForwardCrumbs([])
    setCrumbs(prev => [...prev, { id: child.resourceId, rid: child.rid, name: child.name }])
  }

  function goToCrumb(index: number): void {
    setForwardCrumbs(crumbs.slice(index + 1))
    setCrumbs(crumbs.slice(0, index + 1))
  }

  function goBack(): void {
    if (crumbs.length <= 1) return
    const nextForward = crumbs[crumbs.length - 1]
    if (nextForward) setForwardCrumbs(stack => [nextForward, ...stack])
    setCrumbs(crumbs.slice(0, -1))
  }

  function goForward(): void {
    const [nextCrumb, ...rest] = forwardCrumbs
    if (!nextCrumb) return
    setCrumbs(stack => [...stack, nextCrumb])
    setForwardCrumbs(rest)
  }

  async function copyGfsUri(uri: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(uri)
      showToast('GFS link copied.', { tone: 'success' })
    } catch {
      showToast('Could not copy the GFS link.', { tone: 'error' })
    }
  }

  async function refreshCurrent(): Promise<void> {
    if (!current) return
    await load(current)
  }

  async function createFolder(): Promise<void> {
    const rid = current?.rid ?? (current?.id ? ridOfResourceId(current.id) : null)
    if (!rid) return
    const requestedName = window.prompt('Folder name')
    if (!requestedName?.trim()) return
    try {
      const name = await normalizeGfsResourceName(requestedName.trim())
      await apiSend('POST', `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(rid)}/children`, {
        name,
        kind: 'directory',
      })
      showToast('Folder created.', { tone: 'success' })
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not create folder.', { tone: 'error' })
    }
  }

  async function uploadFile(file: File | null | undefined): Promise<void> {
    const rid = current?.rid ?? (current?.id ? ridOfResourceId(current.id) : null)
    if (!rid || !file) return
    try {
      const name = await normalizeGfsResourceName(file.name)
      await apiSend('POST', `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(rid)}/children`, {
        name,
        kind: 'file',
        contentBase64: await fileToEncodedData(file),
      })
      showToast('File uploaded.', { tone: 'success' })
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not upload file.', { tone: 'error' })
    }
  }

  async function renameResource(child: GfsChild): Promise<void> {
    const requestedName = window.prompt('New name', child.name)
    if (!requestedName?.trim()) return
    try {
      const name = await normalizeGfsResourceName(requestedName.trim())
      if (name === child.name) return
      await apiSend(
        'PATCH',
        `/api/v1/gfs/resources/${encodeURIComponent(child.resourceId)}`,
        { drive: DRIVE, newName: name, ifMatch: child.version },
        { drive: DRIVE }
      )
      showToast('Resource renamed.', { tone: 'success' })
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not rename resource.', {
        tone: 'error',
      })
    }
  }

  async function replaceFile(child: GfsChild, file: File | null | undefined): Promise<void> {
    if (!file) return
    try {
      await apiSend(
        'PUT',
        `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(child.rid)}/content`,
        {
          contentBase64: await fileToEncodedData(file),
          ifMatch: child.version,
        }
      )
      showToast('File replaced.', { tone: 'success' })
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not replace file.', { tone: 'error' })
    }
  }

  async function deleteResource(child: GfsChild): Promise<void> {
    if (!window.confirm(`Delete ${child.name}?`)) return
    try {
      await apiSend('DELETE', `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(child.rid)}`, {
        ifMatch: child.version,
      })
      showToast('Resource deleted.', { tone: 'success' })
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not delete resource.', {
        tone: 'error',
      })
    }
  }

  return (
    <section className="cu-gfs" aria-label="Global File System browser">
      <header className="cu-gfs__header">
        <div className="cu-gfs__title-group">
          <span className="cu-gfs__hero-icon" aria-hidden="true">
            <IconSharedFiles />
          </span>
          <div>
            <p className="cu-gfs__eyebrow">Operator browser</p>
            <h1>Global File System</h1>
            <p className="cu-gfs__description">
              Browse delegated folders as a tree and manage access grants from the admin plane.
            </p>
          </div>
        </div>
        <div className="cu-gfs-toolbar" aria-label="Global File System navigation">
          <div className="cu-gfs-toolbar__nav" aria-label="Folder history">
            <Button size="sm" variant="ghost" disabled={crumbs.length <= 1} onClick={goBack}>
              Back
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={forwardCrumbs.length === 0}
              onClick={goForward}
            >
              Forward
            </Button>
          </div>
          <div className="cu-gfs__drive" aria-label={`Drive ${DRIVE}`}>
            <span className="cu-gfs__drive-label">Drive</span>
            <strong>{DRIVE}</strong>
          </div>
        </div>
      </header>

      {error ? (
        <p className="cu-gfs__alert" role="alert">
          {error}
        </p>
      ) : null}

      <div className="cu-gfs-explorer">
        <aside className="cu-gfs-tree" aria-label="Global File System folder tree">
          <div className="cu-gfs-tree__header">
            <span className="cu-gfs-tree__icon" aria-hidden="true">
              <IconSharedFiles />
            </span>
            <div>
              <span className="cu-gfs-tree__label">Drive map</span>
              <strong>{DRIVE}</strong>
            </div>
          </div>
          <ol className="cu-gfs-tree__list">
            {crumbs.map((crumb, index) => (
              <li
                className={`cu-gfs-tree__item${
                  index === crumbs.length - 1 ? ' cu-gfs-tree__item--active' : ''
                }`}
                key={`${crumb.id ?? 'root'}-${index}`}
                style={{ '--cu-gfs-depth': index } as React.CSSProperties}
              >
                <button
                  className="cu-gfs-tree__button"
                  type="button"
                  onClick={() => goToCrumb(index)}
                  aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                >
                  <span className="cu-gfs-tree__branch" aria-hidden="true" />
                  <span className="cu-gfs-tree__glyph" aria-hidden="true">
                    <IconFolder />
                  </span>
                  <span>{crumb.name === '/' ? DRIVE : crumb.name}</span>
                </button>
              </li>
            ))}
            {items.map(child => (
              <li
                className="cu-gfs-tree__item cu-gfs-tree__item--child"
                key={`tree-${child.resourceId}`}
                style={{ '--cu-gfs-depth': crumbs.length } as React.CSSProperties}
              >
                {child.kind === 'directory' ? (
                  <button
                    className="cu-gfs-tree__button"
                    type="button"
                    onClick={() => openDirectory(child)}
                  >
                    <span className="cu-gfs-tree__branch" aria-hidden="true" />
                    <span className="cu-gfs-tree__glyph" aria-hidden="true">
                      <IconFolder />
                    </span>
                    <span>{child.name}</span>
                  </button>
                ) : (
                  <span className="cu-gfs-tree__button cu-gfs-tree__button--file">
                    <span className="cu-gfs-tree__branch" aria-hidden="true" />
                    <span className="cu-gfs-tree__glyph" aria-hidden="true">
                      <IconServer />
                    </span>
                    <span>{child.name}</span>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </aside>

        <div className="cu-gfs-panel">
          <div className="cu-gfs-panel__toolbar">
            <div className="cu-gfs-panel__title">
              <span className="cu-gfs-panel__icon" aria-hidden="true">
                <IconFolder />
              </span>
              <div>
                <span className="cu-gfs__eyebrow">Current folder</span>
                <strong>{currentLabel}</strong>
              </div>
            </div>
            <div className="cu-gfs-panel__chips" aria-label="Current folder metadata">
              <span className="cu-chip">{items.length} visible</span>
              <span className="cu-chip">Read + write + delegate</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!current?.id}
                onClick={() => void createFolder()}
              >
                New folder
              </Button>
              <label
                className="cu-btn cu-btn--ghost cu-btn--sm cu-gfs-file-action"
                aria-disabled={!current?.id}
              >
                Upload file
                <input
                  className="sr-only"
                  disabled={!current?.id}
                  type="file"
                  onChange={event => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    void uploadFile(file)
                  }}
                />
              </label>
            </div>
          </div>

          {current?.id ? (
            <p className="cu-gfs__upload-warning" role="note">
              <strong>Upload size warning:</strong> GFS uploads currently use JSON/base64. The
              service accepts 150 MB request bodies, so use raw files around 110 MB or smaller until
              streaming uploads are available.
            </p>
          ) : null}

          <nav aria-label="Breadcrumb" className="cu-gfs-breadcrumb">
            {crumbs.map((crumb, index) => (
              <span className="cu-gfs-breadcrumb__item" key={`${crumb.id ?? 'root'}-${index}`}>
                <button
                  className="cu-gfs-breadcrumb__button"
                  type="button"
                  onClick={() => goToCrumb(index)}
                >
                  {crumb.name === '/' ? DRIVE : crumb.name}
                </button>
                {index < crumbs.length - 1 ? (
                  <span className="cu-gfs-breadcrumb__separator" aria-hidden="true">
                    /
                  </span>
                ) : null}
              </span>
            ))}
          </nav>

          {loading && items.length === 0 ? (
            <p className="cu-gfs__state">Loading resources...</p>
          ) : (
            <ul className="cu-gfs-list" aria-label="Current folder resources">
              {items.map(child => (
                <li className="cu-gfs-list__row" key={child.resourceId}>
                  <span className="cu-gfs-list__icon" aria-hidden="true">
                    {child.kind === 'directory' ? <IconFolder /> : <IconServer />}
                  </span>
                  <span className="cu-gfs-list__identity">
                    <span className="cu-gfs-list__name">
                      {child.kind === 'directory' ? (
                        <button
                          className="cu-gfs-list__name-button"
                          type="button"
                          onClick={() => openDirectory(child)}
                        >
                          {child.name}
                        </button>
                      ) : (
                        <span>{child.name}</span>
                      )}
                    </span>
                    <span className="cu-gfs-list__meta">{resourceMeta(child)}</span>
                  </span>
                  <span className="cu-gfs-list__actions">
                    <Button
                      className="cu-gfs-list__copy"
                      size="sm"
                      variant="ghost"
                      title={child.gfsUri}
                      aria-label={`Copy GFS link for ${child.name}`}
                      onClick={() => void copyGfsUri(child.gfsUri)}
                    >
                      <GfsCopyLinkIcon />
                    </Button>
                    {child.kind !== 'directory' ? (
                      <label className="cu-btn cu-btn--ghost cu-btn--sm cu-gfs-file-action">
                        Replace
                        <input
                          className="sr-only"
                          type="file"
                          onChange={event => {
                            const file = event.currentTarget.files?.[0]
                            event.currentTarget.value = ''
                            void replaceFile(child, file)
                          }}
                        />
                      </label>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => void renameResource(child)}>
                      Rename
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void deleteResource(child)}>
                      Delete
                    </Button>
                    <Button size="sm" onClick={() => setSelected(child)}>
                      Manage access
                    </Button>
                  </span>
                </li>
              ))}
              {items.length === 0 && !loading ? (
                <li className="cu-gfs-list__empty">No resources are visible in this folder.</li>
              ) : null}
            </ul>
          )}

          {nextCursor ? (
            <Button
              className="cu-gfs__load-more"
              size="sm"
              onClick={() => void load(current, nextCursor)}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </div>

      {selected ? (
        <div className="cu-gfs__grant-panel">
          <GfsGrantPanel
            resource={{
              resourceId: selected.resourceId,
              name: selected.name,
              gfsUri: selected.gfsUri,
              kind: selected.kind,
            }}
            onClose={() => setSelected(null)}
          />
        </div>
      ) : null}
    </section>
  )
}
