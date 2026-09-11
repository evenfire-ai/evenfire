import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, IconButton } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { IconAttachFile, IconClose, IconContexts } from '@components/SidebarNav/icons'
import { formatSharedFileSize, getSharedFileParentPath, joinSharedFilePath } from '@lib/sharedFiles'
import type { ComposerAgentFileReference } from '../../uiTypes'

type SharedFilesystemSummary = {
  name: string
  mountPath: string
  phase: string | null
}

type SharedFileEntry = {
  name: string
  kind: 'file' | 'directory' | 'other'
  size: number
  mtime: string
}

type ComposerAgentFilesModalProps = {
  contextId: string
  onAdd: (attachments: ComposerAgentFileReference[]) => void
  onClose: () => void
}

function entryReferenceId(
  contextId: string,
  filesystemName: string,
  path: string,
  kind: 'file' | 'directory'
): string {
  return `agent-file:${contextId}:${filesystemName}:${path}:${kind}`
}

function entryLabel(filesystemName: string, path: string): string {
  const normalizedPath = path === '/' ? '/' : path.replace(/^\/+|\/+$/g, '')
  if (normalizedPath === '/') return filesystemName
  return normalizedPath.split('/').filter(Boolean).pop() || filesystemName
}

function entryKind(entry: SharedFileEntry): 'file' | 'directory' | null {
  return entry.kind === 'file' || entry.kind === 'directory' ? entry.kind : null
}

export function ComposerAgentFilesModal({
  contextId,
  onAdd,
  onClose,
}: ComposerAgentFilesModalProps) {
  const [filesystems, setFilesystems] = useState<SharedFilesystemSummary[]>([])
  const [entries, setEntries] = useState<SharedFileEntry[]>([])
  const [selectedFilesystem, setSelectedFilesystem] = useState<string | null>(null)
  const [currentPath, setCurrentPath] = useState('/')
  const [selected, setSelected] = useState<Record<string, ComposerAgentFileReference>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.clerum.sharedFiles
      .listAttached(contextId)
      .then(result => {
        if (cancelled) return
        setFilesystems(result.items || [])
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [contextId])

  useEffect(() => {
    if (!selectedFilesystem) {
      setEntries([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    window.clerum.sharedFiles
      .listDirectory(contextId, selectedFilesystem, currentPath)
      .then(result => {
        if (cancelled) return
        setEntries(result.entries || [])
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [contextId, currentPath, selectedFilesystem])

  const selectedCount = Object.keys(selected).length
  const currentTitle = selectedFilesystem
    ? `${selectedFilesystem}${currentPath === '/' ? '' : currentPath}`
    : 'Agent Files'

  const toggleAgentFileReference = useCallback(
    (path: string, kind: 'file' | 'directory') => {
      if (!selectedFilesystem) return
      const id = entryReferenceId(contextId, selectedFilesystem, path, kind)
      setSelected(previous => {
        if (previous[id]) {
          const next = { ...previous }
          delete next[id]
          return next
        }
        return {
          ...previous,
          [id]: {
            id,
            type: 'agent_file',
            contextId,
            filesystemName: selectedFilesystem,
            path,
            kind,
            label: entryLabel(selectedFilesystem, path),
          },
        }
      })
    },
    [contextId, selectedFilesystem]
  )

  const selectedValues = useMemo(() => Object.values(selected), [selected])

  return (
    <div className="composer-agent-files-modal" role="dialog" aria-modal="true">
      <div className="composer-agent-files-panel">
        <div className="composer-agent-files-header">
          <div>
            <h3>Agent Files</h3>
            <p className="muted">{currentTitle}</p>
          </div>
          <IconButton label="Close Agent Files" onClick={onClose} size="sm" variant="ghost">
            <IconClose />
          </IconButton>
        </div>

        <div className="composer-agent-files-browser">
          {error ? (
            <div className="composer-attachment-error" role="alert">
              {error}
            </div>
          ) : null}

          {!selectedFilesystem ? (
            loading ? (
              <p className="muted">Loading agent files...</p>
            ) : filesystems.length ? (
              <div className="composer-agent-files-list">
                {filesystems.map(filesystem => (
                  <Button
                    key={filesystem.name}
                    align="start"
                    className="composer-agent-file-row"
                    color="neutral"
                    onClick={() => {
                      setSelectedFilesystem(filesystem.name)
                      setCurrentPath('/')
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    <span className="composer-reference-icon composer-reference-icon--agent-file">
                      <IconContexts />
                    </span>
                    <span>
                      <strong>{filesystem.name}</strong>
                      <small>{filesystem.mountPath}</small>
                    </span>
                  </Button>
                ))}
              </div>
            ) : (
              <EmptyState title="No agent files" body="No agent filesystems are attached." />
            )
          ) : (
            <>
              <div className="composer-agent-files-toolbar">
                <Button
                  color="neutral"
                  onClick={() => {
                    if (currentPath === '/') {
                      setSelectedFilesystem(null)
                    } else {
                      setCurrentPath(getSharedFileParentPath(currentPath))
                    }
                  }}
                  size="xs"
                  variant="ghost"
                >
                  Back
                </Button>
              </div>
              {loading ? (
                <p className="muted">Loading...</p>
              ) : entries.length ? (
                <div className="composer-agent-files-list">
                  {entries.map(entry => {
                    const fullPath = joinSharedFilePath(currentPath, entry.name)
                    const selectableKind = entryKind(entry)
                    const checked = selectableKind
                      ? Boolean(
                          selected[
                            entryReferenceId(
                              contextId,
                              selectedFilesystem,
                              fullPath,
                              selectableKind
                            )
                          ]
                        )
                      : false
                    if (entry.kind === 'directory') {
                      return (
                        <div
                          key={`${entry.kind}:${entry.name}`}
                          className="composer-agent-file-row"
                        >
                          <input
                            type="checkbox"
                            className="composer-agent-file-checkbox"
                            checked={checked}
                            aria-label={`Attach folder ${entry.name}`}
                            onChange={() => toggleAgentFileReference(fullPath, 'directory')}
                          />
                          <Button
                            align="start"
                            className="composer-agent-file-open-target"
                            color="neutral"
                            onClick={() => setCurrentPath(fullPath)}
                            size="sm"
                            variant="ghost"
                          >
                            <span className="composer-reference-icon composer-reference-icon--agent-file">
                              <IconContexts />
                            </span>
                            <span className="composer-agent-file-details">
                              <strong>{entry.name}</strong>
                              <small>directory</small>
                            </span>
                          </Button>
                        </div>
                      )
                    }
                    if (entry.kind !== 'file') {
                      return (
                        <div
                          key={`${entry.kind}:${entry.name}`}
                          className="composer-agent-file-row composer-agent-file-row--disabled"
                        >
                          <span className="composer-agent-file-checkbox-placeholder" />
                          <span className="composer-reference-icon composer-reference-icon--agent-file">
                            <IconAttachFile />
                          </span>
                          <span className="composer-agent-file-details">
                            <strong>{entry.name}</strong>
                            <small>{entry.kind}</small>
                          </span>
                        </div>
                      )
                    }
                    return (
                      <label
                        key={`${entry.kind}:${entry.name}`}
                        className="composer-agent-file-row composer-agent-file-select"
                      >
                        <input
                          type="checkbox"
                          className="composer-agent-file-checkbox"
                          checked={checked}
                          onChange={() => toggleAgentFileReference(fullPath, 'file')}
                        />
                        <span className="composer-reference-icon composer-reference-icon--agent-file">
                          <GfsFileIcon name={entry.name} />
                        </span>
                        <span className="composer-agent-file-details">
                          <strong>{entry.name}</strong>
                          <small>{formatSharedFileSize(entry.size)}</small>
                        </span>
                      </label>
                    )
                  })}
                </div>
              ) : (
                <EmptyState title="Empty folder" body="No entries to display." />
              )}
            </>
          )}
        </div>

        <div className="composer-agent-files-footer">
          <span className="muted">{selectedCount} selected</span>
          <div className="action-row">
            <Button color="neutral" onClick={onClose} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={!selectedValues.length}
              onClick={() => {
                onAdd(selectedValues)
                onClose()
              }}
              size="sm"
            >
              Add
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
