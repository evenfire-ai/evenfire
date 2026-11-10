import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Button, MenuItem } from '@components/Common'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { sanitizeAppTabTitle } from '@lib/sanitizeAppTabTitle'
import { ComposerGfsCascadeLevel } from './ComposerGfsCascade'
import type { BoundGfsFolder } from './ComposerGfsCascade'
import type {
  ComposerGfsAuthorityFailureHandler,
  ComposerGfsLinkSelection,
} from './ComposerGfsLinkPicker.types'
import { useComposerGfsAuthority } from './useComposerGfsAuthority'

export function ComposerGfsLinkPicker({
  controller,
  rootAnchorRef,
  sessionId,
  onInsert,
  onSessionScope,
  onEscapeRoot,
  isAdmissionCurrent,
  allocatePanelBindingId,
}: {
  controller: ReturnType<typeof useGfsBrowserController>
  rootAnchorRef: RefObject<HTMLElement | null>
  sessionId: number
  onInsert: (
    selection: ComposerGfsLinkSelection,
    sessionScope: string,
    sessionId: number,
    sessionGeneration: number | null,
    handleAuthorityFailure: ComposerGfsAuthorityFailureHandler,
    isEntryCurrent: () => boolean
  ) => void | Promise<void>
  onSessionScope: (
    sessionId: number,
    sessionScope: string,
    sessionGeneration: number | null
  ) => void
  onEscapeRoot: () => void
  isAdmissionCurrent?: (sessionId: number) => boolean
  allocatePanelBindingId?: () => number
}) {
  const ctrl = controller
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [folderPath, setFolderPathState] = useState<BoundGfsFolder[]>([])
  const folderPathRef = useRef<BoundGfsFolder[]>([])
  const localBindingCounterRef = useRef(0)
  const allocateBinding = useCallback(
    () => allocatePanelBindingId?.() ?? ++localBindingCounterRef.current,
    [allocatePanelBindingId]
  )
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const suppressedFolderFocusOpenRef = useRef(new Set<string>())
  const [childEntriesByBinding, setChildEntriesByBinding] = useState(
    () => new Map<number, GfsBrowserChild[]>()
  )
  const pointerInsideRef = useRef(false)
  const focusInsideRef = useRef(false)
  const closeTokenRef = useRef<object | null>(null)
  const closeTimersRef = useRef(new Set<number>())
  const suppressNextFolderFocusOpen = useCallback((resourceId: string) => {
    suppressedFolderFocusOpenRef.current.add(resourceId)
  }, [])
  const setFolderPath = useCallback(
    (next: GfsBrowserChild[]) => {
      const previous = folderPathRef.current
      let common = 0
      while (
        common < previous.length &&
        common < next.length &&
        previous[common]?.resourceId === next[common]?.resourceId
      ) {
        common += 1
      }
      if (common === previous.length && common === next.length) {
        const unchanged = next.every((folder, index) => folder === previous[index])
        if (unchanged) return
      }
      const bound = next.map((folder, index) => ({
        ...folder,
        bindingId:
          index < common ? (previous[index]?.bindingId ?? allocateBinding()) : allocateBinding(),
      }))
      folderPathRef.current = bound
      setFolderPathState(bound)
    },
    [allocateBinding]
  )
  const childEntries = useMemo(
    () => [...childEntriesByBinding.values()].flat(),
    [childEntriesByBinding]
  )
  const entries = useMemo(
    () => [...ctrl.accessibleResources, ...childEntries],
    [childEntries, ctrl.accessibleResources]
  )
  const handlePassiveAuthorityFailure = useCallback(
    (message: string) =>
      ctrl.handleAuthorityFailure(message, 'operation', ctrl.sessionScope, ctrl.sessionGeneration),
    [ctrl.handleAuthorityFailure, ctrl.sessionGeneration, ctrl.sessionScope]
  )
  const authority = useComposerGfsAuthority(
    entries,
    sessionId,
    ctrl.sessionScope,
    ctrl.sessionGeneration,
    ctrl.accessState === 'active',
    ctrl.isSessionAuthorityActive,
    handlePassiveAuthorityFailure
  )
  const handleDirectAuthorityFailure = useCallback(
    (message: string) => {
      const handled = ctrl.handleAuthorityFailure(
        message,
        'operation',
        ctrl.sessionScope,
        ctrl.sessionGeneration
      )
      if (handled) authority.invalidate()
      return handled
    },
    [authority.invalidate, ctrl.handleAuthorityFailure, ctrl.sessionGeneration, ctrl.sessionScope]
  )
  const visibleEntries = useMemo(
    () =>
      entries.filter(entry => authority.authorityByResourceId.get(entry.resourceId) === 'allowed'),
    [authority.authorityByResourceId, entries]
  )
  const permissionRetryIds = useMemo(
    () =>
      entries
        .filter(entry => {
          const status = authority.authorityByResourceId.get(entry.resourceId)
          return status === 'denied' || status === 'error' || status === 'paused'
        })
        .map(entry => entry.resourceId),
    [authority.authorityByResourceId, entries]
  )
  const loading = ctrl.loadingAccessible
  const error = ctrl.accessibleError
  const failure = ctrl.discoveryFailure
  const hasMore = ctrl.hasMoreAccessible
  const loadingMore = ctrl.isFetchingMoreAccessible

  useEffect(() => {
    onSessionScope(sessionId, ctrl.sessionScope, ctrl.sessionGeneration)
  }, [ctrl.sessionGeneration, ctrl.sessionScope, onSessionScope, sessionId])

  useEffect(
    () => () => {
      closeTimersRef.current.forEach(timer => window.clearTimeout(timer))
      closeTimersRef.current.clear()
    },
    []
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      const path = folderPathRef.current
      if (path.length > 0) {
        const focusId = path[path.length - 1]?.resourceId
        if (focusId) suppressNextFolderFocusOpen(focusId)
        setFolderPath(path.slice(0, -1))
        if (focusId) window.requestAnimationFrame(() => rowRefs.current.get(focusId)?.focus())
      } else onEscapeRoot()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onEscapeRoot, rootAnchorRef, setFolderPath, suppressNextFolderFocusOpen])

  const isCurrentPanel = useCallback(
    (parentPath: BoundGfsFolder[]) =>
      parentPath.every(
        (folder, index) =>
          folderPathRef.current[index]?.resourceId === folder.resourceId &&
          folderPathRef.current[index]?.bindingId === folder.bindingId
      ),
    []
  )
  const handleChildEntries = useCallback(
    (resourceId: string, bindingId: number, nextEntries: GfsBrowserChild[]) => {
      if (
        nextEntries.length > 0 &&
        !folderPathRef.current.some(
          folder => folder.resourceId === resourceId && folder.bindingId === bindingId
        )
      ) {
        return
      }
      setChildEntriesByBinding(previous => {
        const currentEntries = previous.get(bindingId)
        if (nextEntries.length === 0 && currentEntries === undefined) return previous
        if (
          currentEntries &&
          currentEntries.length === nextEntries.length &&
          currentEntries.every(
            (entry, index) =>
              entry.kind === nextEntries[index]?.kind &&
              entry.resourceId === nextEntries[index]?.resourceId &&
              entry.name === nextEntries[index]?.name &&
              entry.gfsUri === nextEntries[index]?.gfsUri
          )
        )
          return previous
        const next = new Map(previous)
        if (nextEntries.length > 0) next.set(bindingId, nextEntries)
        else next.delete(bindingId)
        return next
      })
    },
    []
  )
  const consumeSuppressedFolderFocusOpen = useCallback((resourceId: string) => {
    if (!suppressedFolderFocusOpenRef.current.has(resourceId)) return false
    suppressedFolderFocusOpenRef.current.delete(resourceId)
    return true
  }, [])
  const handlePassivePanelFailure = useCallback(
    (message: string) => {
      const handled = handlePassiveAuthorityFailure(message)
      if (handled) authority.invalidate()
    },
    [authority.invalidate, handlePassiveAuthorityFailure]
  )
  const scheduleClose = useCallback(() => {
    const token = {}
    closeTokenRef.current = token
    const timer = window.setTimeout(() => {
      closeTimersRef.current.delete(timer)
      const rootAnchor = rootAnchorRef.current
      const rootOwnsHoverOrFocus =
        rootAnchor?.matches(':hover') || rootAnchor === document.activeElement
      if (
        closeTokenRef.current !== token ||
        pointerInsideRef.current ||
        focusInsideRef.current ||
        rootOwnsHoverOrFocus
      )
        return
      setFolderPath([])
      onEscapeRoot()
    }, 240)
    closeTimersRef.current.add(timer)
  }, [onEscapeRoot, setFolderPath])

  const insert = (entry: GfsBrowserChild, isEntryCurrent: () => boolean) => {
    // This ref-backed check is synchronous, so an event-fenced stale committed
    // row cannot activate before React publishes the next disabled/hidden view.
    if (!isEntryCurrent() || !authority.isCurrentlyAllowed(entry.resourceId)) return
    onInsert(
      {
        label: sanitizeAppTabTitle(entry.name) || 'Unnamed',
        uri: entry.gfsUri,
        resourceId: entry.resourceId,
      },
      ctrl.sessionScope,
      sessionId,
      ctrl.sessionGeneration,
      handleDirectAuthorityFailure,
      isEntryCurrent
    )
  }

  const retry = () => {
    if (ctrl.current) {
      if (!authority.isCurrentlyAllowed(ctrl.current.resourceId)) return
      void ctrl.retryChildren()
    } else {
      void ctrl.retryDiscovery()
    }
  }

  return (
    <div
      ref={menuRef}
      className="composer-gfs-picker"
      role="menu"
      aria-label="EvenDrive links"
      onMouseEnter={() => {
        pointerInsideRef.current = true
      }}
      onMouseLeave={() => {
        pointerInsideRef.current = false
        scheduleClose()
      }}
      onFocusCapture={() => {
        focusInsideRef.current = true
      }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          focusInsideRef.current = false
          scheduleClose()
        }
      }}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const menu = event.target instanceof Element ? event.target.closest('[role="menu"]') : null
        const menuItems = Array.from(
          menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], button:not([disabled])') ??
            []
        ).filter(item => item.closest('[role="menu"]') === menu && !item.disabled)
        if (menuItems.length === 0) return
        event.preventDefault()
        const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement)
        const nextIndex =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? menuItems.length - 1
              : event.key === 'ArrowDown'
                ? (currentIndex + 1 + menuItems.length) % menuItems.length
                : (currentIndex - 1 + menuItems.length) % menuItems.length
        menuItems[nextIndex]?.focus()
      }}
    >
      <div className="composer-gfs-picker-path">
        <span className="composer-gfs-picker-current">Shared files</span>
      </div>

      {ctrl.accessibleNotice ? (
        <p className="composer-reference-menu-empty">{ctrl.accessibleNotice}</p>
      ) : null}
      {error &&
      ctrl.accessibleResources.some(
        item => authority.authorityByResourceId.get(item.resourceId) === 'allowed'
      ) ? (
        <p className="composer-reference-menu-empty composer-gfs-picker-error">
          {describeGfsReadError(error).message}
        </p>
      ) : null}

      {loading ? (
        <div className="composer-reference-menu-empty" role="status">
          Loading EvenDrive…
        </div>
      ) : ctrl.accessibleResources.length > 0 &&
        visibleEntries.length === 0 &&
        permissionRetryIds.length === 0 ? (
        <div className="composer-reference-menu-empty" role="status">
          Checking exact read permission…
        </div>
      ) : visibleEntries.length > 0 ? (
        <ComposerGfsCascadeLevel
          items={ctrl.accessibleResources}
          path={folderPath}
          parentPath={[]}
          parentSnapshot={{
            revision: ctrl.accessibleSnapshotRevision,
            data: ctrl.accessibleSnapshotData,
            isCurrent: ctrl.isAccessibleSnapshotCurrent,
          }}
          authorityByResourceId={authority.authorityByResourceId}
          controller={ctrl}
          queryFailure={null}
          queryLoading={false}
          queryHasMore={hasMore}
          queryLoadingMore={loadingMore}
          queryLoadMoreDisabled={
            !ctrl.isAccessibleSnapshotCurrent(
              ctrl.accessibleSnapshotRevision,
              ctrl.accessibleSnapshotData
            )
          }
          queryLoadMore={() => {
            if (isAdmissionCurrent?.(sessionId) === false) return
            ctrl.loadMoreAccessibleNow()
          }}
          rootAnchorRef={rootAnchorRef}
          registerRow={(resourceId, element) => {
            if (element) rowRefs.current.set(resourceId, element)
            else rowRefs.current.delete(resourceId)
          }}
          isCurrentPanel={isCurrentPanel}
          onActivateFolder={setFolderPath}
          onInsert={insert}
          onChildEntries={handleChildEntries}
          onAuthorityFailure={handlePassivePanelFailure}
          isCurrentlyAllowed={authority.isCurrentlyAllowed}
          isAdmissionCurrent={() => isAdmissionCurrent?.(sessionId) ?? true}
          onKeyboardClose={next => {
            const focusId = folderPathRef.current[next.length]?.resourceId
            setFolderPath(next)
            if (focusId)
              window.requestAnimationFrame(() => {
                const row = rowRefs.current.get(focusId)
                if (!row) return
                suppressNextFolderFocusOpen(focusId)
                row.focus()
              })
          }}
          onKeyboardCloseRoot={onEscapeRoot}
          suppressNextFolderFocusOpen={suppressNextFolderFocusOpen}
          consumeSuppressedFolderFocusOpen={consumeSuppressedFolderFocusOpen}
        />
      ) : failure && failure.kind !== 'unsupported' ? (
        <GfsReadFailureCard failure={failure} onRetry={retry} />
      ) : error ? (
        <GfsReadFailureCard
          failure={{ kind: 'failed', message: error, retryAvailableAt: null }}
          onRetry={retry}
        />
      ) : (
        <p className="composer-reference-menu-empty">
          {ctrl.current ? 'This folder has no readable items.' : 'No shared EvenDrive files.'}
        </p>
      )}
      {permissionRetryIds.length > 0 ? (
        <Button
          block
          className="composer-gfs-picker-permission-retry"
          color="neutral"
          onClick={() => permissionRetryIds.forEach(resourceId => authority.retry(resourceId))}
          size="xs"
          variant="text"
        >
          Retry resource permission checks
        </Button>
      ) : null}
    </div>
  )
}
