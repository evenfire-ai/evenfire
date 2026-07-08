import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, EmptyState } from '@components/Common'
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
    <div className="shared-files-browser-header">
      <nav className="shared-files-crumbs" aria-label="Agent Files breadcrumbs">
        {breadcrumbs.map((c, idx) => (
          <span key={`${c.label}-${idx}`} className="shared-files-crumb">
            {idx > 0 ? <span className="shared-files-crumb-sep">/</span> : null}
            {c.onClick ? (
              <Button
                className="shared-files-link"
                color="transparent"
                onClick={c.onClick}
                size="xs"
                variant="text"
              >
                {c.label}
              </Button>
            ) : (
              <span>{c.label}</span>
            )}
          </span>
        ))}
      </nav>
      <Button
        className="shared-files-refresh"
        color="neutral"
        onClick={() => void handleRefreshCurrentView()}
        disabled={loadingList || Boolean(selectedSfs && loadingDir)}
        size="xs"
        variant="ghost"
      >
        {loadingList || (selectedSfs && loadingDir) ? '…' : 'Refresh'}
      </Button>
    </div>
  )

  // Virtual-root view: list each attached SFS as a directory entry.
  const renderVirtualRoot = () => {
    if (loadingList && !filesystems) {
      return <p className="muted">Loading attached filesystems…</p>
    }
    if (listError) {
      return <div className="message message--error">{listError}</div>
    }
    if (!filesystems || filesystems.length === 0) {
      return (
        <EmptyState
          title="No agent files"
          body="No agent filesystems are attached to this context."
        />
      )
    }
    return (
      <table className="shared-files-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Mount path</th>
          </tr>
        </thead>
        <tbody>
          {filesystems.map(fs => (
            <tr key={fs.name}>
              <td>
                <Button
                  className="shared-files-link"
                  color="transparent"
                  onClick={() => {
                    setSelectedSfs(fs.name)
                    setCurrentPath('/')
                  }}
                  size="xs"
                  variant="text"
                >
                  📁 {fs.name}
                </Button>
              </td>
              <td className="muted">
                <code>{fs.mountPath}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // SFS-internal view: browse files inside the selected SFS.
  const renderInsideSfs = () => {
    return (
      <>
        {dirError ? <div className="message message--error">{dirError}</div> : null}
        {downloadError ? <div className="message message--error">{downloadError}</div> : null}

        <Button
          className="shared-files-up"
          color="neutral"
          onClick={goUp}
          size="xs"
          variant="ghost"
        >
          ← Up
        </Button>

        {loadingDir ? (
          <p className="muted">Loading…</p>
        ) : entries.length === 0 ? (
          <EmptyState title="Empty directory" body="No entries to display." />
        ) : (
          <table className="shared-files-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
                <th aria-label="Action" />
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => {
                const fullPath = joinSharedFilePath(currentPath, entry.name)
                const downloading = downloadingPath === fullPath
                return (
                  <tr key={entry.name}>
                    <td>
                      {entry.kind === 'directory' ? (
                        <Button
                          className="shared-files-link"
                          color="transparent"
                          onClick={() => setCurrentPath(fullPath)}
                          size="xs"
                          variant="text"
                        >
                          📁 {entry.name}
                        </Button>
                      ) : (
                        <span>
                          {entry.kind === 'file' ? '📄 ' : '🔗 '}
                          {entry.name}
                        </span>
                      )}
                    </td>
                    <td>{entry.kind === 'file' ? formatSharedFileSize(entry.size) : '—'}</td>
                    <td className="muted">{new Date(entry.mtime).toLocaleString()}</td>
                    <td>
                      {entry.kind === 'file' ? (
                        <Button
                          className="shared-files-download"
                          color="primary"
                          disabled={downloading}
                          onClick={() => handleDownload(entry)}
                          size="xs"
                          variant="soft"
                        >
                          {downloading ? 'Saving…' : 'Download'}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {truncated ? (
          <p className="muted">
            Listing was truncated by the server. Narrow the path to see more entries.
          </p>
        ) : null}
      </>
    )
  }

  return (
    <div className="shared-files-tab">
      <div className="shared-files-tab-main">
        {renderHeader()}
        <div className="shared-files-browser">
          {selectedSfs ? renderInsideSfs() : renderVirtualRoot()}
        </div>
      </div>
    </div>
  )
}
