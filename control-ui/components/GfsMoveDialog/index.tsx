'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { IconFolder } from '@components/Sidebar/icons'
import { IconCheck, IconChevronRight, IconX } from '@components/icons'
import { Button } from '@components/ui'
import { apiGet } from '@lib/api'
import type {
  GfsMoveDialogProps,
  MoveFolder,
  MoveTreeFolderProps,
  MoveTreePage,
  SelectedMoveDestination,
} from './types'

export type { GfsMoveDialogProps } from './types'

const DRIVE = 'main'

function foldersOnly(items: MoveFolder[], excludedIds: ReadonlySet<string>): MoveFolder[] {
  return items
    .filter(item => item.kind === 'directory' && !excludedIds.has(item.resourceId))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function TreeFolder({
  ancestors,
  expandedIds,
  folder,
  level,
  selected,
  targetId,
  onChildrenLoaded,
  onSelect,
  onToggle,
}: MoveTreeFolderProps) {
  const expanded = expandedIds.has(folder.resourceId)
  const [children, setChildren] = useState<MoveFolder[]>([])
  // The accumulated children across pages. A ref (not state) so the load
  // never merges a stale page set, and so the names reported upward are the
  // complete list this folder has shown.
  const loadedChildrenRef = useRef<MoveFolder[]>([])
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
      )) as MoveTreePage
      const merged = cursor ? [...loadedChildrenRef.current, ...page.items] : page.items
      loadedChildrenRef.current = merged
      setChildren(merged)
      setNextCursor(page.nextCursor)
      setLoaded(true)
      // These are the names the folder already holds. The move ladder needs
      // them: a destination discovered only through this dialog is unknown to
      // the browser's children cache, and a blind ladder burns its attempts
      // on names that are already taken (RP-003).
      onChildrenLoaded(
        folder.resourceId,
        merged.map(item => item.name)
      )
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
              onChildrenLoaded={onChildrenLoaded}
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
  // The nearest crumb that is not the target itself is the folder that
  // already contains it (both entry paths end there). Selecting it is a
  // no-op the server accepts while visibly changing nothing, so it must not
  // be preselected and must not be committable.
  const currentParent = [...initialCrumbs]
    .reverse()
    .find(crumb => crumb.id && crumb.id !== target.resourceId)
  const currentParentId =
    typeof target.parentResourceId === 'string'
      ? target.parentResourceId
      : (currentParent?.id ?? null)
  const currentParentName =
    currentParent && currentParent.id === currentParentId
      ? currentParent.name === '/'
        ? DRIVE
        : currentParent.name
      : null
  const [selected, setSelected] = useState<SelectedMoveDestination | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(initialCrumbs.flatMap(crumb => (crumb.id ? [crumb.id] : [])))
  )
  const [rootFolders, setRootFolders] = useState<MoveFolder[]>([])
  const [rootResourceId, setRootResourceId] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  // The names this dialog has observed inside each folder. The drive root's
  // own listing arrives with the tree; every other folder reports its
  // children as they load (RP-003).
  const knownChildNamesRef = useRef<Map<string, string[]>>(new Map())

  function reportChildrenLoaded(folderId: string, names: string[]): void {
    knownChildNamesRef.current.set(folderId, names)
  }

  async function loadRoots(cursor?: string): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const query: Record<string, string> = { drive: DRIVE }
      if (cursor) query.cursor = cursor
      const page = (await apiGet('/api/v1/gfs/tree', query)) as MoveTreePage
      setRootFolders(previous => (cursor ? [...previous, ...page.items] : page.items))
      if (page.rootResourceId) setRootResourceId(page.rootResourceId)
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

  /**
   * The names the destination already holds, as far as this dialog knows
   * them. The drive root's listing IS the root's children; every other
   * destination reports its children while the tree loads them. A destination
   * that was never expanded is read once here, so the ladder is never seeded
   * blind — the browser's own children cache is cold for a folder only this
   * dialog discovered (RP-003).
   */
  async function destinationOccupiedNames(destination: SelectedMoveDestination): Promise<string[]> {
    if (destination.resourceId === rootResourceId) {
      return rootFolders.map(folder => folder.name)
    }
    const known = knownChildNamesRef.current.get(destination.resourceId)
    if (known) return known
    try {
      const page = (await apiGet(
        `/api/v1/gfs/resources/${encodeURIComponent(destination.resourceId)}/children`,
        { drive: DRIVE }
      )) as MoveTreePage
      const names = (page?.items ?? []).map(item => item.name)
      knownChildNamesRef.current.set(destination.resourceId, names)
      return names
    } catch {
      // The seed is an optimization, never the authority: the server's 409 is
      // what decides a collision. A failed read leaves the ladder blind but
      // the move itself intact.
      return []
    }
  }

  async function commit(): Promise<void> {
    if (!selected || busy) return
    setError('')
    try {
      const occupiedNames = await destinationOccupiedNames(selected)
      await onMove({
        resourceId: selected.resourceId,
        name: selected.name,
        occupiedNames,
      })
    } catch (moveError) {
      setError(messageOf(moveError))
    }
  }

  const isNoOpDestination = Boolean(selected && selected.resourceId === currentParentId)
  const rootSelected = Boolean(rootResourceId && selected?.resourceId === rootResourceId)

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
            <strong>{currentParentName ?? (currentParentId ? 'another folder' : DRIVE)}</strong>
          </span>
        </div>

        {error ? (
          <div className="cu-banner cu-banner--error cu-gfs-move-dialog__error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="cu-gfs-move-dialog__tree-heading">EvenDrive</div>
        <div
          className="cu-gfs-move-dialog__tree"
          role="tree"
          aria-label="EvenDrive destination folders"
        >
          {rootResourceId && rootResourceId !== target.resourceId ? (
            <div
              aria-expanded="true"
              aria-level={1}
              aria-selected={rootSelected}
              className="cu-gfs-move-dialog__tree-item cu-gfs-move-dialog__tree-root"
              role="treeitem"
            >
              <div className="cu-gfs-move-dialog__tree-row">
                <span className="cu-gfs-move-dialog__tree-toggle-placeholder" aria-hidden="true" />
                <button
                  aria-label="main"
                  aria-selected={rootSelected}
                  className="cu-gfs-move-dialog__tree-select"
                  onClick={() =>
                    selectFolder({ resourceId: rootResourceId, name: DRIVE, kind: 'directory' })
                  }
                  type="button"
                >
                  <span className="cu-gfs-move-dialog__tree-folder-icon" aria-hidden="true">
                    <IconFolder />
                  </span>
                  <span className="cu-gfs-move-dialog__tree-folder-name">main</span>
                  <span className="cu-gfs-move-dialog__tree-selected-icon" aria-hidden="true">
                    {rootSelected ? <IconCheck /> : null}
                  </span>
                </button>
              </div>
            </div>
          ) : null}
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
                level={rootResourceId ? 2 : 1}
                onChildrenLoaded={reportChildrenLoaded}
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
              disabled={!selected || isNoOpDestination}
              loading={busy}
              onClick={() => void commit()}
              variant="primary"
            >
              Move
            </Button>
          </span>
        </footer>
        {isNoOpDestination ? (
          <p className="cu-gfs-move-dialog__notice">
            {target.name} is already in {currentParentName ?? 'the folder you selected'} — pick a
            different destination.
          </p>
        ) : null}
      </section>
    </div>
  )
}
