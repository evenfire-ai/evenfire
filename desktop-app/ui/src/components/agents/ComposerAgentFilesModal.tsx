import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Empty, Flex, Listy, Modal, Spin, Tag, Typography } from 'antd'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { IconClose, IconContexts } from '@components/SidebarNav/icons'
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

  const goBack = () => {
    if (currentPath === '/') setSelectedFilesystem(null)
    else setCurrentPath(getSharedFileParentPath(currentPath))
  }

  return (
    <Modal
      footer={
        <Flex align="center" justify="space-between" gap="middle" wrap>
          <Typography.Text type="secondary">{selectedCount} selected</Typography.Text>
          <Flex gap="small">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              disabled={!selectedValues.length}
              onClick={() => {
                onAdd(selectedValues)
                onClose()
              }}
              type="primary"
            >
              Add
            </Button>
          </Flex>
        </Flex>
      }
      onCancel={onClose}
      closeIcon={<IconClose aria-hidden="true" width={18} height={18} />}
      open
      title={
        <Flex vertical>
          <Typography.Title level={4}>Agent Files</Typography.Title>
          <Typography.Text type="secondary">{currentTitle}</Typography.Text>
        </Flex>
      }
    >
      <Flex vertical gap="middle">
        {error ? <Alert showIcon type="error" title={error} /> : null}
        {!selectedFilesystem ? (
          loading ? (
            <Flex align="center" gap="small" role="status" aria-live="polite">
              <Spin size="small" />
              <Typography.Text>Loading agent files…</Typography.Text>
            </Flex>
          ) : filesystems.length ? (
            <Listy
              items={filesystems}
              rowKey="name"
              virtual={false}
              itemRender={filesystem => (
                <Button
                  aria-label={`Open ${filesystem.name}`}
                  block
                  icon={<IconContexts aria-hidden="true" width={14} height={14} />}
                  onClick={() => {
                    setSelectedFilesystem(filesystem.name)
                    setCurrentPath('/')
                  }}
                  type="text"
                >
                  <Flex vertical align="start">
                    <Typography.Text strong>{filesystem.name}</Typography.Text>
                    <Typography.Text type="secondary">{filesystem.mountPath}</Typography.Text>
                  </Flex>
                </Button>
              )}
            />
          ) : (
            <Empty description="No agent filesystems are attached." />
          )
        ) : (
          <>
            <Flex align="center" gap="small">
              <Button icon={<ArrowLeftOutlined aria-hidden="true" />} onClick={goBack}>
                Back
              </Button>
              <Typography.Text type="secondary">{currentTitle}</Typography.Text>
            </Flex>
            {loading ? (
              <Flex align="center" gap="small" role="status" aria-live="polite">
                <Spin size="small" />
                <Typography.Text>Loading files…</Typography.Text>
              </Flex>
            ) : entries.length ? (
              <Listy
                items={entries}
                rowKey={entry => `${entry.kind}:${entry.name}`}
                virtual={false}
                itemRender={entry => {
                  const fullPath = joinSharedFilePath(currentPath, entry.name)
                  const selectableKind = entryKind(entry)
                  const checked = selectableKind
                    ? Boolean(
                        selected[
                          entryReferenceId(contextId, selectedFilesystem, fullPath, selectableKind)
                        ]
                      )
                    : false
                  if (entry.kind === 'directory') {
                    return (
                      <Flex align="center" gap="middle">
                        <Flex align="center" gap="middle" flex={1}>
                          <Checkbox
                            aria-label={`Attach folder ${entry.name}`}
                            checked={checked}
                            onChange={() => toggleAgentFileReference(fullPath, 'directory')}
                          />
                          <Button
                            aria-label={`Open folder ${entry.name}`}
                            block
                            icon={<IconContexts aria-hidden="true" width={14} height={14} />}
                            onClick={() => setCurrentPath(fullPath)}
                            type="text"
                          >
                            {entry.name}
                          </Button>
                        </Flex>
                      </Flex>
                    )
                  }
                  if (entry.kind !== 'file') {
                    return (
                      <Flex align="center" gap="middle">
                        <Flex align="center" gap="middle">
                          <Tag>{entry.kind}</Tag>
                          <Typography.Text type="secondary">{entry.name}</Typography.Text>
                        </Flex>
                      </Flex>
                    )
                  }
                  return (
                    <Flex align="center" gap="middle">
                      <Flex align="center" gap="middle" flex={1}>
                        <Checkbox
                          aria-label={`Attach file ${entry.name}`}
                          checked={checked}
                          onChange={() => toggleAgentFileReference(fullPath, 'file')}
                        />
                        <GfsFileIcon name={entry.name} width={14} height={14} />
                        <Flex vertical>
                          <Typography.Text>{entry.name}</Typography.Text>
                          <Typography.Text type="secondary">
                            {formatSharedFileSize(entry.size)}
                          </Typography.Text>
                        </Flex>
                      </Flex>
                    </Flex>
                  )
                }}
              />
            ) : (
              <Empty description="No entries to display." />
            )}
          </>
        )}
      </Flex>
    </Modal>
  )
}
