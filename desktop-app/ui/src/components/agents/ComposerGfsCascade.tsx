import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { FocusEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Button, MenuItem } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import { IconChevronRight, IconContexts } from '@components/SidebarNav/icons'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import type { GfsDiscoveryFailure } from '@hooks/domain/useGfsBrowserController'
import type { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { useFlyoutPosition } from '@hooks/useFlyoutPosition'
import type { FlyoutPosition } from '@lib/flyoutPosition'
import { isRateLimited, parseRetryAfterSeconds } from '@lib/gfsGrantErrors'
import { sanitizeAppTabTitle } from '@lib/sanitizeAppTabTitle'
import {
  captureGfsQueryOperationBaseline,
  gfsInfiniteQueryPolicy,
  requestGfsForwardPage,
  retireGfsForwardOwner,
  useGfsForwardPending,
  useGfsQueryBinding,
} from '@/gfs/gfsQueryOperationCoordinator'

export type BoundGfsFolder = GfsBrowserChild & { bindingId: number }
type Controller = ReturnType<typeof useGfsBrowserController>
type ParentSnapshot = {
  revision: number | null
  data: unknown
  isCurrent: (revision: number | null, data: unknown) => boolean
}
type ValidatedChildSnapshot = { revision: number; data: unknown }

type Props = {
  items: GfsBrowserChild[]
  path: BoundGfsFolder[]
  parentPath: BoundGfsFolder[]
  parentSnapshot: ParentSnapshot
  authorityByResourceId: ReadonlyMap<string, string>
  controller: Controller
  rootAnchorRef: RefObject<HTMLElement | null>
  parentPosition?: FlyoutPosition | null
  registerRow: (resourceId: string, element: HTMLButtonElement | null) => void
  isCurrentPanel: (parentPath: BoundGfsFolder[]) => boolean
  onActivateFolder: (path: GfsBrowserChild[]) => void
  onInsert: (entry: GfsBrowserChild, isEntryCurrent: () => boolean) => void
  onKeyboardClose: (parentPath: GfsBrowserChild[]) => void
  onKeyboardCloseRoot: () => void
  suppressNextFolderFocusOpen: (resourceId: string) => void
  consumeSuppressedFolderFocusOpen: (resourceId: string) => boolean
  onChildEntries: (resourceId: string, bindingId: number, entries: GfsBrowserChild[]) => void
  onAuthorityFailure: (message: string) => void
  focusFirstChild?: boolean
  onFocusChild?: () => void
  isCurrentlyAllowed: (resourceId: string) => boolean
  isAdmissionCurrent?: () => boolean
  queryFailure?: GfsDiscoveryFailure | null
  queryLoading?: boolean
  queryHasMore?: boolean
  queryLoadingMore?: boolean
  queryLoadMoreDisabled?: boolean
  queryLoadMore?: () => void
  queryRetry?: () => void
  queryRetrying?: boolean
  isEntryCurrent?: (entry: GfsBrowserChild) => boolean
}

function listingQueryKey(controller: Controller, parentPath: BoundGfsFolder[]) {
  return parentPath.length === 0
    ? desktopQueryKeys.gfsAccessible(controller.sessionScope, 'main', controller.sessionGeneration)
    : desktopQueryKeys.gfsChildren(
        controller.sessionScope,
        parentPath[parentPath.length - 1]!.resourceId,
        'main',
        controller.sessionGeneration
      )
}

function hasCurrentItemMembership(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: ReturnType<typeof listingQueryKey>,
  entry: GfsBrowserChild
) {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true })
  const data = query?.state.data as { pages?: Array<{ items?: GfsBrowserChild[] }> } | undefined
  return Boolean(
    query &&
    query.state.status === 'success' &&
    !query.state.isInvalidated &&
    query.state.fetchStatus === 'idle' &&
    data?.pages?.some(page =>
      page.items?.some(item => item.kind === entry.kind && item.resourceId === entry.resourceId)
    )
  )
}

function hasPresentedItemMembership(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: ReturnType<typeof listingQueryKey>,
  entry: GfsBrowserChild
) {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true })
  const data = query?.state.data as { pages?: Array<{ items?: GfsBrowserChild[] }> } | undefined
  const fetchMeta = query?.state.fetchMeta as
    | { fetchMore?: { direction?: string } }
    | null
    | undefined
  // A failed forward page does not invalidate already accepted pages. Keep
  // those safe names visible beside Retry, while the action predicate above
  // still requires a successful idle Query before any operation is allowed.
  const resumableForwardFailure =
    query?.state.status === 'error' && fetchMeta?.fetchMore?.direction === 'forward'
  return Boolean(
    query &&
    (query.state.status === 'success' || resumableForwardFailure) &&
    (!query.state.isInvalidated || resumableForwardFailure) &&
    data?.pages?.some(page =>
      page.items?.some(item => item.kind === entry.kind && item.resourceId === entry.resourceId)
    )
  )
}

/** Re-read the current root-to-parent Query chain at every action boundary. */
function hasCurrentListingPath(
  queryClient: ReturnType<typeof useQueryClient>,
  controller: Controller,
  parentPath: BoundGfsFolder[],
  entry?: GfsBrowserChild
) {
  if (
    !controller.sessionScope ||
    controller.sessionGeneration === null ||
    controller.accessState !== 'active'
  )
    return false

  for (let index = 0; index < parentPath.length; index += 1) {
    const folder = parentPath[index]
    if (
      !folder ||
      folder.kind !== 'directory' ||
      !hasCurrentItemMembership(
        queryClient,
        listingQueryKey(controller, parentPath.slice(0, index)),
        folder
      )
    )
      return false
  }

  return entry
    ? hasCurrentItemMembership(queryClient, listingQueryKey(controller, parentPath), entry)
    : true
}

function hasPresentedListingPath(
  queryClient: ReturnType<typeof useQueryClient>,
  controller: Controller,
  parentPath: BoundGfsFolder[],
  entry?: GfsBrowserChild
) {
  if (
    !controller.sessionScope ||
    controller.sessionGeneration === null ||
    controller.accessState !== 'active'
  )
    return false

  for (let index = 0; index < parentPath.length; index += 1) {
    const folder = parentPath[index]
    if (
      !folder ||
      folder.kind !== 'directory' ||
      !hasPresentedItemMembership(
        queryClient,
        listingQueryKey(controller, parentPath.slice(0, index)),
        folder
      )
    )
      return false
  }

  return entry
    ? hasPresentedItemMembership(queryClient, listingQueryKey(controller, parentPath), entry)
    : true
}

/** Subscribe a nested panel to each listing that proves its ancestor path. */
function usePresentedAncestorSnapshot(
  queryClient: ReturnType<typeof useQueryClient>,
  controller: Controller,
  path: BoundGfsFolder[]
) {
  const pathIdentity = path.map(folder => folder.resourceId).join('\u001f')
  const listingPath = useMemo(
    () =>
      path.map((folder, index) => ({
        key: listingQueryKey(controller, path.slice(0, index)),
        folder,
      })),
    [controller.sessionGeneration, controller.sessionScope, pathIdentity]
  )
  const getSnapshot = useCallback(
    () =>
      `${controller.accessState}|${listingPath
        .map(({ key, folder }) => {
          const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
          return [
            query?.state.status ?? 'missing',
            query?.state.fetchStatus ?? 'idle',
            query?.state.isInvalidated ?? false,
            hasPresentedItemMembership(queryClient, key, folder),
          ].join(':')
        })
        .join('|')}`,
    [controller.accessState, listingPath, queryClient]
  )
  const subscribe = useCallback(
    (notify: () => void) =>
      queryClient.getQueryCache().subscribe(event => {
        const [app, family, sessionScope] = event.query.queryKey
        if (app === 'desktop-app' && family === 'gfs' && sessionScope === controller.sessionScope)
          notify()
      }),
    [controller.sessionScope, queryClient]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function startNameMotion(
  event: ReactMouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>
) {
  const label = event.currentTarget.querySelector<HTMLElement>('.ui-menu-item__label')
  const name = label?.querySelector<HTMLElement>('.composer-gfs-picker-name')
  if (!label || !name) return
  const distance = name.scrollWidth - label.clientWidth
  if (distance <= 1) return
  label.style.setProperty('--composer-gfs-name-distance', `${-distance}px`)
  label.classList.add('is-overflowing')
}

function stopNameMotion(event: ReactMouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>) {
  if (event.currentTarget.matches(':hover') || document.activeElement === event.currentTarget)
    return
  const label = event.currentTarget.querySelector<HTMLElement>('.ui-menu-item__label')
  label?.classList.remove('is-overflowing')
  label?.style.removeProperty('--composer-gfs-name-distance')
}

function GfsChildPanel(
  props: Props & {
    folder: BoundGfsFolder
    depth: number
    reusableSnapshot?: ValidatedChildSnapshot
    onValidatedSnapshot?: (snapshot: ValidatedChildSnapshot) => void
  }
) {
  const { folder, depth, controller, onChildEntries, onAuthorityFailure } = props
  const queryClient = useQueryClient()
  const ancestorSnapshot = usePresentedAncestorSnapshot(queryClient, controller, [
    ...props.parentPath,
    folder,
  ])
  const forwardOwnerId = useId()
  const queryKey = useMemo(
    () =>
      desktopQueryKeys.gfsChildren(
        controller.sessionScope,
        folder.resourceId,
        'main',
        controller.sessionGeneration
      ),
    [controller.sessionGeneration, controller.sessionScope, folder.resourceId]
  )
  const parentQueryKey = useMemo(
    () => listingQueryKey(controller, props.parentPath),
    [controller.sessionGeneration, controller.sessionScope, props.parentPath]
  )
  const queryBaseline = useMemo(
    () => captureGfsQueryOperationBaseline(queryClient),
    [queryClient, queryKey]
  )
  const parentSnapshotCurrent = props.parentSnapshot.isCurrent(
    props.parentSnapshot.revision,
    props.parentSnapshot.data
  )
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      // The IPC dispatch can occur after hover/disclosure admitted the panel.
      // Re-read the picker-private permission fence and binding immediately
      // before crossing the producer boundary.
      if (
        props.isAdmissionCurrent?.() === false ||
        !props.isCurrentPanel([...props.parentPath, folder]) ||
        !hasCurrentListingPath(queryClient, controller, props.parentPath, folder) ||
        !props.parentSnapshot.isCurrent(props.parentSnapshot.revision, props.parentSnapshot.data) ||
        !props.isCurrentlyAllowed(folder.resourceId)
      ) {
        throw new Error('EvenDrive folder access changed before loading its contents.')
      }
      return window.clerum.gfs.listChildren(folder.resourceId, 'main', pageParam)
    },
    enabled:
      controller.accessState === 'active' &&
      controller.sessionGeneration !== null &&
      parentSnapshotCurrent,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    ...gfsInfiniteQueryPolicy(queryClient),
  })
  const binding = useGfsQueryBinding(
    queryClient,
    queryKey,
    'composer-child',
    controller.accessState === 'active' && controller.sessionGeneration !== null,
    folder.bindingId,
    queryBaseline
  )
  const exactQuery = queryClient.getQueryCache().find({ queryKey, exact: true })
  const reusableSnapshotCurrent = Boolean(
    binding.phase === 'pending' &&
    props.reusableSnapshot &&
    query.data &&
    query.dataUpdatedAt === props.reusableSnapshot.revision &&
    query.data === props.reusableSnapshot.data &&
    exactQuery?.state.status === 'success' &&
    !exactQuery.state.isInvalidated
  )
  const forwardPending = useGfsForwardPending(queryClient, queryKey, forwardOwnerId)
  const queryFetchMeta = queryClient.getQueryCache().find({ queryKey, exact: true })?.state
    .fetchMeta as { fetchMore?: { direction?: string } } | null | undefined
  useEffect(
    () => () => retireGfsForwardOwner(queryClient, queryKey, forwardOwnerId),
    [folder.bindingId, forwardOwnerId, queryClient, queryKey]
  )
  const items = useMemo(
    () =>
      (binding.phase === 'validated' || reusableSnapshotCurrent) &&
      hasPresentedListingPath(queryClient, controller, [...props.parentPath, folder])
        ? (query.data?.pages ?? []).flatMap(page => page.items)
        : [],
    [
      binding.phase,
      controller.accessState,
      controller.sessionGeneration,
      controller.sessionScope,
      folder,
      props.parentPath,
      query.data,
      queryClient,
      ancestorSnapshot,
      reusableSnapshotCurrent,
    ]
  )
  useEffect(() => {
    if (
      binding.phase === 'validated' &&
      query.data &&
      props.isAdmissionCurrent?.() !== false &&
      props.isCurrentPanel([...props.parentPath, folder]) &&
      hasCurrentListingPath(queryClient, controller, props.parentPath, folder) &&
      props.isEntryCurrent?.(folder) &&
      props.isCurrentlyAllowed(folder.resourceId)
    ) {
      props.onValidatedSnapshot?.({ revision: query.dataUpdatedAt, data: query.data })
    }
  }, [
    binding.phase,
    controller.accessState,
    controller.sessionGeneration,
    controller.sessionScope,
    folder,
    props.isAdmissionCurrent,
    props.isCurrentlyAllowed,
    props.isCurrentPanel,
    props.isEntryCurrent,
    props.onValidatedSnapshot,
    props.parentPath,
    queryClient,
    query.data,
    query.dataUpdatedAt,
  ])
  const queryFailure = useMemo<GfsDiscoveryFailure | null>(() => {
    const error = query.error ?? binding.error
    if (!error) return null
    const message = error instanceof Error ? error.message : String(error)
    if (!isRateLimited(message)) return { kind: 'failed', message, retryAvailableAt: null }
    const retryAfterSeconds = parseRetryAfterSeconds(message)
    return {
      kind: 'rate-limited',
      message,
      retryAvailableAt:
        retryAfterSeconds === null
          ? query.errorUpdatedAt + 60_000
          : query.errorUpdatedAt + retryAfterSeconds * 1_000,
    }
  }, [binding.error, query.error, query.errorUpdatedAt])
  useEffect(() => {
    onChildEntries(folder.resourceId, folder.bindingId, items)
  }, [folder.bindingId, folder.resourceId, items, onChildEntries])
  useEffect(
    () => () => onChildEntries(folder.resourceId, folder.bindingId, []),
    [folder.bindingId, folder.resourceId, onChildEntries]
  )
  useEffect(() => {
    if (query.error)
      onAuthorityFailure(query.error instanceof Error ? query.error.message : String(query.error))
  }, [onAuthorityFailure, query.error])

  return (
    <div>
      <ComposerGfsCascadeLevel
        {...props}
        depth={depth}
        items={items}
        parentPath={[...props.parentPath, folder]}
        parentSnapshot={{
          revision: query.dataUpdatedAt,
          data: query.data,
          isCurrent: binding.isCurrentSnapshot,
        }}
        queryFailure={
          queryFailure ??
          (binding.error
            ? {
                kind: 'failed',
                message:
                  binding.error instanceof Error ? binding.error.message : String(binding.error),
                retryAvailableAt: null,
              }
            : null)
        }
        queryLoading={items.length === 0 && (binding.phase === 'pending' || query.isFetching)}
        queryHasMore={binding.phase === 'validated' && Boolean(query.hasNextPage)}
        queryLoadingMore={query.isFetchingNextPage || forwardPending}
        queryLoadMoreDisabled={
          binding.error !== null ||
          (query.isError && queryFetchMeta?.fetchMore?.direction !== 'forward')
        }
        queryLoadMore={() =>
          (() => {
            const exactQuery = queryClient.getQueryCache().find({ queryKey, exact: true })
            const parentContainsFolder = hasCurrentItemMembership(
              queryClient,
              parentQueryKey,
              folder
            )
            const queryIsCurrent =
              Boolean(exactQuery) &&
              exactQuery?.state.data === query.data &&
              exactQuery?.state.fetchStatus === 'idle' &&
              exactQuery?.state.isInvalidated === false &&
              query.isSuccess &&
              binding.phase === 'validated' &&
              Boolean(query.hasNextPage)
            const parentSnapshotCurrent = props.parentSnapshot.isCurrent(
              props.parentSnapshot.revision,
              props.parentSnapshot.data
            )
            if (
              props.isAdmissionCurrent?.() === false ||
              !props.isCurrentPanel([...props.parentPath, folder]) ||
              !parentSnapshotCurrent ||
              !hasCurrentListingPath(queryClient, controller, props.parentPath, folder) ||
              !parentContainsFolder ||
              !hasCurrentItemMembership(queryClient, parentQueryKey, folder) ||
              !queryIsCurrent ||
              !props.isCurrentlyAllowed(folder.resourceId)
            )
              return
            return requestGfsForwardPage(queryClient, queryKey, forwardOwnerId, () =>
              query.fetchNextPage({ cancelRefetch: false })
            )
          })()
        }
        queryRetry={() => {
          if (
            props.isAdmissionCurrent?.() !== false &&
            props.isCurrentPanel([...props.parentPath, folder]) &&
            hasCurrentListingPath(queryClient, controller, props.parentPath, folder) &&
            props.parentSnapshot.isCurrent(
              props.parentSnapshot.revision,
              props.parentSnapshot.data
            ) &&
            hasCurrentItemMembership(queryClient, parentQueryKey, folder) &&
            props.isCurrentlyAllowed(folder.resourceId)
          )
            binding.retry()
        }}
        queryRetrying={binding.retrying}
      />
      {!query.isFetching && !query.error && !binding.error && items.length === 0 ? (
        <p className="composer-reference-menu-empty">This folder has no readable items.</p>
      ) : null}
    </div>
  )
}

function GfsCascadeRow(props: Props & { entry: GfsBrowserChild; depth: number }) {
  const { entry, depth, path, parentPath, rootAnchorRef, parentPosition, registerRow } = props
  const name = sanitizeAppTabTitle(entry.name) || 'Unnamed'
  const rowRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const focusChildOnOpenRef = useRef(false)
  const validatedChildSnapshotRef = useRef<(ValidatedChildSnapshot & { key: string }) | undefined>(
    undefined
  )
  const activeFolder = path[depth]
  const isOpen = entry.kind === 'directory' && activeFolder?.resourceId === entry.resourceId
  const folder = activeFolder && isOpen ? activeFolder : null
  const childQueryKey = desktopQueryKeys.gfsChildren(
    props.controller.sessionScope,
    entry.resourceId,
    'main',
    props.controller.sessionGeneration
  )
  const childQueryIdentity = JSON.stringify(childQueryKey)
  const reusableSnapshot =
    validatedChildSnapshotRef.current?.key === childQueryIdentity
      ? validatedChildSnapshotRef.current
      : undefined
  const nestedFlyoutPosition = useFlyoutPosition({
    anchorRef: rowRef,
    flyoutRef: panelRef,
    boundsAnchorRef: rootAnchorRef,
    open: isOpen,
    placement: 'right-of',
    recomputeKey: parentPosition,
  })

  const finishFocusChild = useCallback(() => {
    focusChildOnOpenRef.current = false
  }, [])
  const rememberValidatedSnapshot = useCallback(
    (snapshot: ValidatedChildSnapshot) => {
      validatedChildSnapshotRef.current = { ...snapshot, key: childQueryIdentity }
    },
    [childQueryIdentity]
  )

  const openFolder = () => {
    if (
      entry.kind !== 'directory' ||
      props.isAdmissionCurrent?.() === false ||
      !props.isCurrentPanel(parentPath) ||
      !props.isEntryCurrent?.(entry) ||
      !props.isCurrentlyAllowed(entry.resourceId)
    )
      return
    props.onActivateFolder([...parentPath, entry])
  }

  const activate = () => {
    if (
      !props.isCurrentPanel(parentPath) ||
      (entry.kind === 'directory' && !props.isEntryCurrent?.(entry))
    )
      return
    if (entry.kind === 'directory') openFolder()
    else props.onActivateFolder(parentPath)
  }

  return (
    <>
      <div className="composer-gfs-picker-row">
        <MenuItem
          ref={element => {
            rowRef.current = element
            registerRow(entry.resourceId, element)
          }}
          aria-expanded={entry.kind === 'directory' ? isOpen : undefined}
          aria-haspopup={entry.kind === 'directory' ? 'menu' : undefined}
          aria-label={
            entry.kind === 'directory' ? `Insert folder ${name}` : `Insert link to ${name}`
          }
          className="composer-gfs-picker-insert"
          leadingIcon={entry.kind === 'file' ? <GfsFileIcon name={name} /> : <IconContexts />}
          onClick={() => {
            const isEntryCurrent = () =>
              props.isCurrentPanel(parentPath) && props.isEntryCurrent?.(entry) === true
            if (isEntryCurrent()) props.onInsert(entry, isEntryCurrent)
          }}
          onFocus={event => {
            startNameMotion(event)
            if (
              entry.kind === 'directory' &&
              !props.consumeSuppressedFolderFocusOpen(entry.resourceId)
            )
              activate()
          }}
          onBlur={stopNameMotion}
          onMouseEnter={event => {
            startNameMotion(event)
            activate()
          }}
          onMouseLeave={stopNameMotion}
          onKeyDown={event => {
            if (entry.kind === 'directory' && event.key === 'ArrowRight') {
              event.preventDefault()
              if (isOpen) {
                panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
              } else {
                focusChildOnOpenRef.current = true
                openFolder()
              }
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault()
              if (parentPath.length > 0) props.onKeyboardClose(parentPath.slice(0, -1))
              else props.onKeyboardCloseRoot()
            }
          }}
          role="menuitem"
          trailingIcon={
            entry.kind === 'directory' ? <IconChevronRight aria-hidden="true" /> : undefined
          }
        >
          <span className="composer-gfs-picker-name" title={name}>
            {name}
          </span>
        </MenuItem>
        {entry.kind === 'directory' ? (
          <Button
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} folder ${name}`}
            aria-haspopup="menu"
            className="composer-gfs-picker-disclose"
            onClick={event => {
              event.stopPropagation()
              if (isOpen) {
                if (
                  props.isAdmissionCurrent?.() !== false &&
                  activeFolder !== undefined &&
                  props.isCurrentPanel([...parentPath, activeFolder]) &&
                  props.isEntryCurrent?.(entry)
                )
                  props.onActivateFolder(parentPath)
              } else openFolder()
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowRight') {
                event.preventDefault()
                if (isOpen) {
                  panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
                } else {
                  focusChildOnOpenRef.current = true
                  openFolder()
                }
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault()
                if (parentPath.length > 0) props.onKeyboardClose(parentPath.slice(0, -1))
                else props.onKeyboardCloseRoot()
              }
            }}
            role="menuitem"
            size="xs"
            type="button"
            variant="ghost"
          >
            <IconChevronRight aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {folder ? (
        <div
          ref={panelRef}
          aria-label={`${name} contents`}
          className="composer-reference-submenu composer-reference-submenu--evendrive composer-reference-submenu--nested"
          role="menu"
          style={{
            left: nestedFlyoutPosition?.left ?? 0,
            top: nestedFlyoutPosition?.top ?? 0,
            visibility: nestedFlyoutPosition ? undefined : 'hidden',
          }}
        >
          <GfsChildPanel
            {...props}
            folder={folder}
            depth={depth + 1}
            reusableSnapshot={reusableSnapshot}
            onValidatedSnapshot={rememberValidatedSnapshot}
            parentPosition={nestedFlyoutPosition}
            focusFirstChild={focusChildOnOpenRef.current}
            onFocusChild={finishFocusChild}
          />
        </div>
      ) : null}
    </>
  )
}

export function ComposerGfsCascadeLevel(props: Props & { depth?: number }) {
  const queryClient = useQueryClient()
  const depth = props.depth ?? props.parentPath.length
  const parentQueryKey = listingQueryKey(props.controller, props.parentPath)
  const isCurrentEntry = (entry: GfsBrowserChild) =>
    props.parentSnapshot.isCurrent(props.parentSnapshot.revision, props.parentSnapshot.data) &&
    hasCurrentListingPath(queryClient, props.controller, props.parentPath, entry) &&
    hasCurrentItemMembership(queryClient, parentQueryKey, entry)
  const rows = props.items.filter(
    item =>
      props.authorityByResourceId.get(item.resourceId) === 'allowed' &&
      hasPresentedListingPath(queryClient, props.controller, props.parentPath, item)
  )
  const listRef = useRef<HTMLDivElement>(null)
  const retryWasFocusedRef = useRef(false)

  useLayoutEffect(() => {
    const hasFailure = Boolean(props.queryFailure)
    if (!hasFailure && retryWasFocusedRef.current) {
      const firstAction = listRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitem"]:not([aria-disabled="true"]), button:not([disabled])'
      )
      const focusTarget = firstAction ?? props.rootAnchorRef.current
      if (focusTarget) {
        retryWasFocusedRef.current = false
        focusTarget.focus()
      }
    }
  }, [rows, props.queryFailure, props.rootAnchorRef])

  useLayoutEffect(() => {
    if (!props.focusFirstChild) return
    const firstAction = listRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not([aria-disabled="true"]), button:not([disabled])'
    )
    if (!firstAction) return
    firstAction.focus()
    props.onFocusChild?.()
  }, [props.focusFirstChild, props.onFocusChild, props.queryFailure, props.queryLoading, rows])

  return (
    <div className="composer-gfs-picker-list" ref={listRef}>
      {rows.map(entry => (
        <GfsCascadeRow
          {...props}
          depth={depth}
          entry={entry}
          isEntryCurrent={isCurrentEntry}
          key={`${entry.drive}:${entry.resourceId}:${depth}`}
        />
      ))}
      {props.queryLoading ? (
        <div className="composer-reference-menu-empty" role="status">
          Loading folder…
        </div>
      ) : null}
      {props.queryFailure ? (
        <GfsReadFailureCard
          failure={props.queryFailure}
          onRetry={props.queryRetry ?? (() => undefined)}
          retrying={props.queryRetrying}
          onRetryFocus={() => {
            retryWasFocusedRef.current = true
          }}
        />
      ) : null}
      {props.queryHasMore ? (
        <Button
          block
          className="composer-gfs-picker-more"
          color="neutral"
          disabled={props.queryLoadingMore || props.queryLoadMoreDisabled}
          onClick={props.queryLoadMore}
          size="xs"
          variant="text"
        >
          {props.queryLoadingMore ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  )
}
