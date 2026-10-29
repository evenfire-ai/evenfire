import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Breadcrumb,
  Button,
  Checkbox,
  Empty,
  Flex,
  Listy,
  Modal,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import {
  IconClose as CloseOutlined,
  IconContexts as FolderOutlined,
  IconChevronRight as RightOutlined,
} from '@components/SidebarNav/icons'
import {
  type GfsDiscoveryFailure,
  useGfsBrowserController,
} from '@hooks/domain/useGfsBrowserController'
import { describeGfsReadError, isRateLimited, parseRetryAfterSeconds } from '@lib/gfsGrantErrors'
import { formatSharedFileSize } from '@lib/sharedFiles'
import type { ComposerGlobalFileReference } from '@/uiTypes'
import type { ComposerGlobalFileSelection, ComposerGlobalFilesModalProps } from './types'

function referenceId(drive: string, resourceId: string): string {
  return `global-file:${drive}:${resourceId}`
}

export function ComposerGlobalFilesModal({
  attachedIds,
  onAdd,
  onClose,
}: ComposerGlobalFilesModalProps) {
  const ctrl = useGfsBrowserController()
  // The limit is per message, so files attached in an earlier open of this
  // picker use up part of it. Without this each open allowed a fresh
  // FILE_REFERENCE_MAX_COUNT and the send was refused after the fact.
  const attached = useMemo(() => new Set(attachedIds), [attachedIds])
  const alreadyAttached = attached.size
  const capacity = Math.max(0, FILE_REFERENCE_MAX_COUNT - alreadyAttached)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [selected, setSelected] = useState<ComposerGlobalFileSelection>({})

  const toggleFile = useCallback(
    (file: ComposerGlobalFileReference) => {
      setSelected(previous => {
        if (attached.has(file.id)) return previous
        if (previous[file.id]) {
          const next = { ...previous }
          delete next[file.id]
          return next
        }
        if (Object.keys(previous).length >= capacity) return previous
        return { ...previous, [file.id]: file }
      })
    },
    [attached, capacity]
  )

  const selectedFiles = useMemo(() => Object.values(selected), [selected])
  const entries = ctrl.current ? ctrl.items : ctrl.accessibleResources
  const loading = ctrl.current ? ctrl.loading : ctrl.loadingAccessible
  // Present the verdict, never the transport. Until discovery failures were
  // classified by signal, every rejection of the `gfs:listAccessible` channel
  // became a friendly notice here; now only a 404 does, so a 429 would have
  // put the raw "Error invoking remote method …" string in front of the user.
  const rawError = ctrl.current ? ctrl.error : ctrl.accessibleError
  const error = rawError ? describeGfsReadError(rawError).message : null
  const hasMore = ctrl.current ? ctrl.hasMore : ctrl.hasMoreAccessible
  const loadingMore = ctrl.current ? ctrl.isFetchingMore : ctrl.isFetchingMoreAccessible
  const loadMore = ctrl.current ? ctrl.loadMore : ctrl.loadMoreAccessible
  // A refused read is not an empty picker. Without this the modal answered a
  // 429 with "No shared files yet" — a claim about the user's library that the
  // rejected request never established — and offered nothing to retry, so the
  // only exit was to close the modal and reopen it, spending another request
  // against the budget that had just refused one.
  //
  // `unsupported` stays out: that server cannot list at all, and a Retry button
  // would promise an endpoint that will not appear. The existing info banner
  // already explains it, and the empty state below is what the user gets.
  // Scoped to the root for the same reason the failure card is: the discovery
  // verdict describes the root listing and stays set while the user browses
  // into a folder, where an empty result really does mean an empty folder.
  const rootListingUnsupported = !ctrl.current && ctrl.discoveryFailure?.kind === 'unsupported'
  const blockingFailure = useMemo<{
    failure: GfsDiscoveryFailure
    retry: () => void
  } | null>(() => {
    if (entries.length > 0) return null
    if (!ctrl.current) {
      return ctrl.discoveryFailure && ctrl.discoveryFailure.kind !== 'unsupported'
        ? { failure: ctrl.discoveryFailure, retry: ctrl.retryDiscovery }
        : null
    }
    if (!ctrl.error) return null
    const kind = isRateLimited(ctrl.error) ? 'rate-limited' : 'failed'
    const retryAfterSeconds = parseRetryAfterSeconds(ctrl.error)
    return {
      failure: {
        kind,
        message: ctrl.error,
        retryAvailableAt:
          kind === 'rate-limited' && retryAfterSeconds !== null
            ? ctrl.errorUpdatedAt + retryAfterSeconds * 1000
            : null,
      },
      retry: ctrl.retryChildren,
    }
  }, [
    ctrl.current,
    ctrl.discoveryFailure,
    ctrl.error,
    ctrl.errorUpdatedAt,
    ctrl.retryChildren,
    ctrl.retryDiscovery,
    entries.length,
  ])

  const title = (
    <Flex align="start" justify="space-between" gap="middle">
      <Flex vertical gap="small">
        <Typography.Text type="secondary">EvenDrive</Typography.Text>
        <Typography.Title id="composer-global-files-title" level={4}>
          Choose files for this message
        </Typography.Title>
        <Typography.Text type="secondary">
          Browse shared folders and select multiple files.
        </Typography.Text>
      </Flex>
      <Button
        ref={closeButtonRef}
        aria-label="Close global file picker"
        icon={<CloseOutlined width={16} height={16} />}
        onClick={onClose}
        type="text"
      />
    </Flex>
  )

  const breadcrumbItems = [
    {
      title: (
        <Button onClick={ctrl.reset} type="link">
          Shared files
        </Button>
      ),
    },
    ...ctrl.crumbs.map((crumb, index) => ({
      title: (
        <Button
          disabled={index === ctrl.crumbs.length - 1}
          onClick={() => ctrl.goToCrumb(index)}
          type="link"
        >
          {crumb.name}
        </Button>
      ),
    })),
  ]

  const emptyDescription = rootListingUnsupported
    ? 'This server cannot list shared resources, so Evenfire has no way to tell what you have access to. That does not mean you have none.'
    : ctrl.current
      ? 'Choose another folder to continue browsing.'
      : 'Files shared with you through the Global File System will appear here.'
  const emptyTitle = rootListingUnsupported
    ? 'Files cannot be listed here'
    : ctrl.current
      ? 'This folder is empty'
      : 'No shared files yet'

  return (
    <Modal
      aria-labelledby="composer-global-files-title"
      afterOpenChange={open => {
        if (open) closeButtonRef.current?.focus()
      }}
      footer={
        <Flex align="center" justify="space-between" gap="middle" wrap>
          <Flex align="center" gap="small" wrap>
            <Typography.Text strong>{selectedFiles.length}</Typography.Text>
            <Typography.Text>
              {selectedFiles.length === 1 ? 'file selected' : 'files selected'}
            </Typography.Text>
            {selectedFiles.length >= capacity ? (
              <Typography.Text role="status" type="secondary">
                Up to {FILE_REFERENCE_MAX_COUNT} files per message
                {alreadyAttached > 0 ? ` (${alreadyAttached} already attached)` : ''}.
              </Typography.Text>
            ) : null}
          </Flex>
          <Flex gap="small">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              disabled={!selectedFiles.length}
              onClick={() => {
                onAdd(selectedFiles)
                onClose()
              }}
              type="primary"
            >
              {selectedFiles.length ? `Attach ${selectedFiles.length}` : 'Attach files'}
            </Button>
          </Flex>
        </Flex>
      }
      onCancel={onClose}
      open
      title={title}
    >
      <Flex vertical gap="middle">
        <Breadcrumb aria-label="Global file path" items={breadcrumbItems} />
        {ctrl.accessibleNotice ? (
          <Alert showIcon type="info" title={ctrl.accessibleNotice} />
        ) : null}
        {/* The banner stands down while the blocking card owns the same failure. */}
        {error && !blockingFailure ? <Alert showIcon type="error" title={error} /> : null}
        {blockingFailure ? (
          <GfsReadFailureCard
            failure={blockingFailure.failure}
            onRetry={() => {
              void blockingFailure.retry()
            }}
          />
        ) : loading ? (
          <Flex align="center" gap="small" role="status" aria-live="polite">
            <Spin size="small" />
            <Typography.Text>Loading files…</Typography.Text>
          </Flex>
        ) : entries.length ? (
          <Flex vertical>
            <Listy
              items={entries}
              rowKey={entry => `${entry.drive}:${entry.resourceId}`}
              virtual={false}
              itemRender={entry => {
                const id = referenceId(entry.drive, entry.resourceId)
                if (entry.kind === 'directory') {
                  return (
                    <div>
                      <Button
                        aria-label={`Open folder ${entry.name}`}
                        block
                        icon={<FolderOutlined width={17} height={17} />}
                        onClick={() =>
                          ctrl.current ? ctrl.openChild(entry) : ctrl.openResource(entry)
                        }
                        type="text"
                      >
                        <Flex align="center" justify="space-between" flex={1}>
                          <span>{entry.name}</span>
                          <RightOutlined aria-hidden="true" width={14} height={14} />
                        </Flex>
                      </Button>
                    </div>
                  )
                }

                const file: ComposerGlobalFileReference = {
                  id,
                  type: 'global_file',
                  resourceId: entry.resourceId,
                  drive: entry.drive,
                  gfsUri: entry.gfsUri,
                  label: entry.name,
                  version: entry.version,
                  bytes: entry.bytes,
                }
                const isAttached = attached.has(id)
                const checked = isAttached || Boolean(selected[id])
                return (
                  <Flex align="center" justify="space-between">
                    <Flex align="center" gap="middle">
                      <Checkbox
                        aria-label={`Select ${entry.name}`}
                        checked={checked}
                        disabled={isAttached || (!checked && selectedFiles.length >= capacity)}
                        onChange={() => toggleFile(file)}
                      />
                      <GfsFileIcon name={entry.name} width={17} height={17} />
                      <Flex vertical>
                        <Typography.Text>{entry.name}</Typography.Text>
                        <Typography.Text type="secondary">
                          {formatSharedFileSize(entry.bytes)}
                        </Typography.Text>
                      </Flex>
                    </Flex>
                    <Tag color={isAttached ? 'default' : checked ? 'success' : undefined}>
                      {isAttached ? 'Attached' : checked ? 'Selected' : 'Select'}
                    </Tag>
                  </Flex>
                )
              }}
            />
            {hasMore ? (
              <Flex justify="center">
                <Button loading={loadingMore} onClick={loadMore}>
                  Load more
                </Button>
              </Flex>
            ) : null}
          </Flex>
        ) : (
          <Empty
            description={
              <Flex vertical>
                <Typography.Text>{emptyTitle}</Typography.Text>
                <Typography.Text type="secondary">{emptyDescription}</Typography.Text>
              </Flex>
            }
          />
        )}
      </Flex>
    </Modal>
  )
}
