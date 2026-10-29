import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpenOutlined } from '@ant-design/icons'
import { Alert, Breadcrumb, Button, Empty, Spin, Table, Typography } from 'antd'
import { useContextsDataController } from '../hooks/domain/useContextsDataController'
import type {
  SharedFileDirEntry,
  SharedFilesDirectoryState,
  SharedFilesListState,
} from '../hooks/domain/useContextsDataController.types'
import {
  formatSharedFileSize,
  getSharedFileParentPath,
  getSharedFilesDirectoryKey,
  joinSharedFilePath,
} from '../lib/sharedFiles'

type Props = {
  contextId: string
}

const EMPTY_SHARED_FILES_LIST_STATE: SharedFilesListState = {
  loading: false,
  loaded: false,
  error: null,
  items: null,
}

const EMPTY_SHARED_FILES_DIRECTORY_STATE: SharedFilesDirectoryState = {
  loading: false,
  loaded: false,
  error: null,
  entries: [],
  truncated: false,
}

export function SharedFilesTab({ contextId }: Props) {
  const {
    sharedFilesByContext,
    sharedFileDirectoriesByContext,
    refreshSharedFiles,
    loadSharedFilesDirectory,
  } = useContextsDataController()

  // null = browsing the virtual root (each attached SFS shown as a folder).
  const [selectedSfs, setSelectedSfs] = useState<string | null>(null)
  const [currentPath, setCurrentPath] = useState('/')

  const [downloadingPath, setDownloadingPath] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState('')

  const listState = sharedFilesByContext[contextId] ?? EMPTY_SHARED_FILES_LIST_STATE
  const directoryKey = selectedSfs ? getSharedFilesDirectoryKey(selectedSfs, currentPath) : ''
  const directoryState = selectedSfs
    ? (sharedFileDirectoriesByContext[contextId]?.[directoryKey] ??
      EMPTY_SHARED_FILES_DIRECTORY_STATE)
    : EMPTY_SHARED_FILES_DIRECTORY_STATE
  const filesystems = listState.items
  const entries = directoryState.entries
  const loadingList = listState.loading
  const loadingDir = directoryState.loading
  const listError = listState.error
  const dirError = directoryState.error
  const truncated = directoryState.truncated

  useEffect(() => {
    setSelectedSfs(null)
    setCurrentPath('/')
  }, [contextId])

  useEffect(() => {
    if (!contextId || listState.loaded || listState.loading) return
    void refreshSharedFiles(contextId)
  }, [contextId, listState.loaded, listState.loading, refreshSharedFiles])

  useEffect(() => {
    if (!contextId || !selectedSfs || directoryState.loaded || directoryState.loading) return
    setDownloadError('')
    void loadSharedFilesDirectory(contextId, selectedSfs, currentPath)
  }, [
    contextId,
    currentPath,
    directoryState.loaded,
    directoryState.loading,
    loadSharedFilesDirectory,
    selectedSfs,
  ])

  const handleDownload = useCallback(
    async (entry: SharedFileDirEntry) => {
      if (!selectedSfs || entry.kind !== 'file') return
      const targetPath = joinSharedFilePath(currentPath, entry.name)
      setDownloadingPath(targetPath)
      setDownloadError('')
      try {
        await window.clerum.sharedFiles.download(contextId, selectedSfs, targetPath)
      } catch (e) {
        setDownloadError(e instanceof Error ? e.message : 'Failed to download file.')
      } finally {
        setDownloadingPath(null)
      }
    },
    [contextId, currentPath, selectedSfs]
  )

  const goToVirtualRoot = useCallback(() => {
    setSelectedSfs(null)
    setCurrentPath('/')
  }, [])

  const goUp = useCallback(() => {
    if (!selectedSfs) return
    if (currentPath === '/' || currentPath === '') {
      goToVirtualRoot()
      return
    }
    setCurrentPath(getSharedFileParentPath(currentPath))
  }, [currentPath, goToVirtualRoot, selectedSfs])

  const breadcrumbs = useMemo(() => {
    const items: Array<{ label: string; onClick?: () => void }> = [
      { label: 'Agent Files', onClick: selectedSfs ? goToVirtualRoot : undefined },
    ]
    if (selectedSfs) {
      const segments = currentPath.split('/').filter(Boolean)
      items.push({
        label: selectedSfs,
        onClick:
          segments.length > 0
            ? () => {
                setCurrentPath('/')
              }
            : undefined,
      })
      for (let i = 0; i < segments.length; i++) {
        const targetPath = `/${segments.slice(0, i + 1).join('/')}`
        const isLast = i === segments.length - 1
        items.push({
          label: segments[i] ?? '',
          onClick: isLast ? undefined : () => setCurrentPath(targetPath),
        })
      }
    }
    return items
  }, [currentPath, goToVirtualRoot, selectedSfs])

  const handleRefreshCurrentView = useCallback(async () => {
    if (!contextId) return
    if (!selectedSfs) {
      await refreshSharedFiles(contextId)
      return
    }
    await Promise.all([
      refreshSharedFiles(contextId),
      loadSharedFilesDirectory(contextId, selectedSfs, currentPath, { force: true }),
    ])
  }, [contextId, currentPath, loadSharedFilesDirectory, refreshSharedFiles, selectedSfs])

  const renderHeader = () => (
    <div>
      <Breadcrumb
        aria-label="Agent Files breadcrumbs"
        items={breadcrumbs.map((crumb, index) => ({
          key: `${crumb.label}-${index}`,
          title: crumb.onClick ? (
            <Button type="link" size="small" onClick={crumb.onClick}>
              {crumb.label}
            </Button>
          ) : (
            crumb.label
          ),
        }))}
      />
      <Button
        onClick={() => void handleRefreshCurrentView()}
        disabled={loadingList || Boolean(selectedSfs && loadingDir)}
        loading={loadingList || Boolean(selectedSfs && loadingDir)}
      >
        Refresh
      </Button>
    </div>
  )

  // Virtual-root view: list each attached SFS as a directory entry.
  const renderVirtualRoot = () => {
    if (loadingList && !filesystems) {
      return <Spin description="Loading attached filesystems…" />
    }
    if (listError) {
      return <Alert type="error" showIcon title={listError} />
    }
    if (!filesystems || filesystems.length === 0) {
      return <Empty description="No agent filesystems are attached to this context." />
    }
    return (
      <Table
        size="small"
        pagination={false}
        rowKey="name"
        dataSource={filesystems}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            key: 'name',
            render: (name: string) => (
              <Button
                type="link"
                icon={<FolderOpenOutlined />}
                onClick={() => {
                  setSelectedSfs(name)
                  setCurrentPath('/')
                }}
              >
                {name}
              </Button>
            ),
          },
          {
            title: 'Mount path',
            dataIndex: 'mountPath',
            key: 'mountPath',
            render: (mountPath: string) => <Typography.Text code>{mountPath}</Typography.Text>,
          },
        ]}
      />
    )
  }

  // SFS-internal view: browse files inside the selected SFS.
  const renderInsideSfs = () => {
    return (
      <>
        {dirError ? <Alert type="error" showIcon title={dirError} /> : null}
        {downloadError ? <Alert type="error" showIcon title={downloadError} /> : null}

        <Button onClick={goUp}>← Up</Button>

        {loadingDir ? (
          <Spin description="Loading…" />
        ) : entries.length === 0 ? (
          <Empty description="No entries to display." />
        ) : (
          <Table
            size="small"
            pagination={false}
            rowKey="name"
            dataSource={entries}
            columns={[
              {
                title: 'Name',
                dataIndex: 'name',
                key: 'name',
                render: (name: string, entry: SharedFileDirEntry) => {
                  const fullPath = joinSharedFilePath(currentPath, name)
                  if (entry.kind === 'directory') {
                    return (
                      <Button
                        type="link"
                        icon={<FolderOpenOutlined />}
                        onClick={() => setCurrentPath(fullPath)}
                      >
                        {name}
                      </Button>
                    )
                  }
                  return (
                    <Typography.Text>
                      {entry.kind === 'file' ? '📄 ' : '🔗 '}
                      {name}
                    </Typography.Text>
                  )
                },
              },
              {
                title: 'Size',
                dataIndex: 'size',
                key: 'size',
                render: (size: number, entry: SharedFileDirEntry) =>
                  entry.kind === 'file' ? formatSharedFileSize(size) : '—',
              },
              {
                title: 'Modified',
                dataIndex: 'mtime',
                key: 'modified',
                render: (mtime: number) => new Date(mtime).toLocaleString(),
              },
              {
                title: 'Action',
                key: 'action',
                render: (_value: unknown, entry: SharedFileDirEntry) => {
                  if (entry.kind !== 'file') return null
                  const fullPath = joinSharedFilePath(currentPath, entry.name)
                  const downloading = downloadingPath === fullPath
                  return (
                    <Button
                      type="primary"
                      disabled={downloading}
                      loading={downloading}
                      onClick={() => void handleDownload(entry)}
                    >
                      {downloading ? 'Saving…' : 'Download'}
                    </Button>
                  )
                },
              },
            ]}
          />
        )}

        {truncated ? (
          <Alert
            type="info"
            showIcon
            title="Listing was truncated by the server. Narrow the path to see more entries."
          />
        ) : null}
      </>
    )
  }

  return (
    <div>
      {renderHeader()}
      <div>{selectedSfs ? renderInsideSfs() : renderVirtualRoot()}</div>
    </div>
  )
}
