'use client'

import { useEffect, useMemo, useState } from 'react'
import { IconFolder } from '@components/Sidebar/icons'
import { IconCheck, IconChevronRight, IconX } from '@components/icons'
import { Button } from '@components/ui'
import { apiGet } from '@lib/api'

const DRIVE = 'main'

type MoveFolder = {
  resourceId: string
  name: string
  kind: string
}

type MoveCrumb = {
  id: string | null
  name: string
}

type TreePage = {
  items: MoveFolder[]
  nextCursor: string | null
}

type SelectedDestination = Pick<MoveFolder, 'resourceId' | 'name'>

export type GfsMoveDialogProps = {
  target: MoveFolder
  initialCrumbs: MoveCrumb[]
  busy?: boolean
  onClose: () => void
  onMove: (destinationId: string, destinationName: string) => Promise<void>
}

function foldersOnly(items: MoveFolder[], excludedIds: ReadonlySet<string>): MoveFolder[] {
  return items
    .filter(item => item.kind === 'directory' && !excludedIds.has(item.resourceId))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type TreeFolderProps = {
  ancestors: ReadonlySet<string>
  expandedIds: ReadonlySet<string>
  folder: MoveFolder
  level: number
  selected: SelectedDestination | null
  targetId: string
  onSelect: (folder: MoveFolder) => void
  onToggle: (folderId: string) => void
}

function TreeFolder({
  ancestors,
  expandedIds,
  folder,
  level,
  selected,
  targetId,
  onSelect,
  onToggle,
}: TreeFolderProps) {
  const expanded = expandedIds.has(folder.resourceId)
  const [children, setChildren] = useState<MoveFolder[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const nextAncestors = useMemo(
    () => new Set([...ancestors, folder.resourceId]),
    [ancestors, folder.resourceId]
  )
  const visibleChildren = useMemo(
    () => foldersOnly(children, new Set([targetId, ...ancestors])),
    [ancestors, children, targetId]
  )

  async function loadChildren(cursor?: string): Promise<void> {
    setAttempted(true)
    setLoading(true)
    setError('')
    try {
      const query: Record<string, string> = { drive: DRIVE }
      if (cursor) query.cursor = cursor
      const page = (await apiGet(
        `/api/v1/gfs/resources/${encodeURIComponent(folder.resourceId)}/children`,
        query
      )) as TreePage
      setChildren(previous => (cursor ? [...previous, ...page.items] : page.items))
      setNextCursor(page.nextCursor)
      setLoaded(true)
    } catch (loadError) {
      setError(messageOf(loadError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (expanded && !loaded && !attempted) void loadChildren()
  }, [attempted, expanded, loaded])

  const canExpand = !loaded || loading || Boolean(nextCursor) || visibleChildren.length > 0

  return (
    <div
      aria-expanded={canExpand ? expanded : undefined}
      aria-level={level}
      aria-selected={selected?.resourceId === folder.resourceId}
      className="cu-gfs-move-dialog__tree-item"
      role="treeitem"
    >
      <div className="cu-gfs-move-dialog__tree-row">
        {canExpand ? (
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${folder.name}`}
            className={`cu-gfs-move-dialog__tree-toggle${expanded ? ' is-expanded' : ''}`}
            onClick={() => onToggle(folder.resourceId)}
            type="button"
          >
            <IconChevronRight />
          </button>
        ) : (
          <span className="cu-gfs-move-dialog__tree-toggle-placeholder" aria-hidden="true" />
        )}
        <button
          aria-selected={selected?.resourceId === folder.resourceId}
          className="cu-gfs-move-dialog__tree-select"
          onClick={() => onSelect(folder)}
          type="button"
        >
          <span className="cu-gfs-move-dialog__tree-folder-icon" aria-hidden="true">
            <IconFolder />
          </span>
          <span className="cu-gfs-move-dialog__tree-folder-name">{folder.name}</span>
          <span className="cu-gfs-move-dialog__tree-selected-icon" aria-hidden="true">
            {selected?.resourceId === folder.resourceId ? <IconCheck /> : null}
          </span>
        </button>
      </div>
      {expanded ? (
        <div className="cu-gfs-move-dialog__tree-group" role="group">
          {loading && !loaded ? (
            <p className="cu-gfs-move-dialog__notice" role="status">
              Loading subfolders…
            </p>
          ) : null}
          {error ? (
            <div className="cu-banner cu-banner--error" role="alert">
              {error}
            </div>
          ) : null}
          {visibleChildren.map(child => (
            <TreeFolder
              ancestors={nextAncestors}
              expandedIds={expandedIds}
              folder={child}
              key={child.resourceId}
              level={level + 1}
              onSelect={onSelect}
              onToggle={onToggle}
              selected={selected}
              targetId={targetId}
            />
          ))}
          {nextCursor ? (
            <Button
              className="cu-gfs-move-dialog__load-more"
              loading={loading}
              onClick={() => void loadChildren(nextCursor)}
              size="sm"
            >
              Load more
            </Button>
          ) : null}
          {loaded && !loading && !error && !visibleChildren.length && !nextCursor ? (
            <p className="cu-gfs-move-dialog__notice">No subfolders.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function GfsMoveDialog({
  target,
  initialCrumbs,
  busy = false,
  onClose,
  onMove,
}: GfsMoveDialogProps) {
  const initialDestination = [...initialCrumbs]
    .reverse()
    .find(crumb => crumb.id && crumb.id !== target.resourceId)
  const [selected, setSelected] = useState<SelectedDestination | null>(() =>
    initialDestination?.id
      ? {
          resourceId: initialDestination.id,
          name: initialDestination.name === '/' ? DRIVE : initialDestination.name,
        }
      : null
  )
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(initialCrumbs.flatMap(crumb => (crumb.id ? [crumb.id] : [])))
  )
  const [rootFolders, setRootFolders] = useState<MoveFolder[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  async function loadRoots(cursor?: string): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const query: Record<string, string> = { drive: DRIVE }
      if (cursor) query.cursor = cursor
      const page = (await apiGet('/api/v1/gfs/tree', query)) as TreePage
      setRootFolders(previous => (cursor ? [...previous, ...page.items] : page.items))
      setNextCursor(page.nextCursor)
      setLoaded(true)
    } catch (loadError) {
      setError(messageOf(loadError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadRoots()
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose])

  const visibleRoots = useMemo(
    () => foldersOnly(rootFolders, new Set([target.resourceId])),
    [rootFolders, target.resourceId]
  )

  function toggleFolder(folderId: string): void {
    setError('')
    setExpandedIds(previous => {
      const next = new Set(previous)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  function selectFolder(folder: MoveFolder): void {
    setError('')
    setSelected({ resourceId: folder.resourceId, name: folder.name })
    setExpandedIds(previous => new Set(previous).add(folder.resourceId))
  }

  async function commit(): Promise<void> {
    if (!selected || busy) return
    setError('')
    try {
      await onMove(selected.resourceId, selected.name)
    } catch (moveError) {
      setError(messageOf(moveError))
    }
  }

  return (
    <div
      className="cu-modal-backdrop cu-gfs-move-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        aria-label={`Move ${target.kind === 'directory' ? 'folder' : 'file'} ${target.name}`}
        aria-modal="true"
        className="cu-gfs-move-dialog"
        role="dialog"
      >
        <header className="cu-gfs-move-dialog__header">
          <span className="cu-gfs-move-dialog__header-icon" aria-hidden="true">
            <IconFolder />
          </span>
          <h3>Move “{target.name}”</h3>
          <Button
            aria-label="Close move dialog"
            className="cu-gfs-move-dialog__close"
            disabled={busy}
            icon
            onClick={onClose}
            variant="ghost"
          >
            <IconX />
          </Button>
        </header>

        <div className="cu-gfs-move-dialog__current-location">
          <span>Current location:</span>
          <span className="cu-gfs-move-dialog__location-pill">
            <IconFolder />
            <strong>{selected?.name ?? 'Choose a folder'}</strong>
          </span>
        </div>

        {error ? (
          <div className="cu-banner cu-banner--error cu-gfs-move-dialog__error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="cu-gfs-move-dialog__tree-heading">Global File System</div>
        <div className="cu-gfs-move-dialog__tree" role="tree" aria-label="GFS destination folders">
          {loading && !loaded ? (
            <p className="cu-gfs-move-dialog__notice" role="status">
              Loading folders…
            </p>
          ) : !visibleRoots.length && !nextCursor ? (
            <p className="cu-gfs-move-dialog__notice">No folders here.</p>
          ) : (
            visibleRoots.map(folder => (
              <TreeFolder
                ancestors={new Set()}
                expandedIds={expandedIds}
                folder={folder}
                key={folder.resourceId}
                level={1}
                onSelect={selectFolder}
                onToggle={toggleFolder}
                selected={selected}
                targetId={target.resourceId}
              />
            ))
          )}
          {nextCursor ? (
            <Button
              className="cu-gfs-move-dialog__load-more"
              loading={loading}
              onClick={() => void loadRoots(nextCursor)}
              size="sm"
            >
              Load more
            </Button>
          ) : null}
        </div>

        <footer className="cu-gfs-move-dialog__footer">
          <span className="cu-gfs-move-dialog__selection" aria-live="polite">
            {selected ? (
              <>
                Move to <strong>{selected.name}</strong>
              </>
            ) : (
              'Select a destination folder'
            )}
          </span>
          <span className="cu-gfs-move-dialog__actions">
            <Button disabled={busy} onClick={onClose} variant="ghost">
              Cancel
            </Button>
            <Button
              aria-label={selected ? `Move here (${selected.name})` : 'Move'}
              disabled={!selected}
              loading={busy}
              onClick={() => void commit()}
              variant="primary"
            >
              Move
            </Button>
          </span>
        </footer>
      </section>
    </div>
  )
}
