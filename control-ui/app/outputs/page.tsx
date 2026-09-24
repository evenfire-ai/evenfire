'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  DataTable,
  TableHeaderCell,
  TableStateRow,
  TableViewport,
  useTableSort,
} from '@clerum/frontend-components'
import { CONTROL_ROUTES } from '@constants/routes'
import { AuthGate } from '../../components/AuthGate'
import { DashboardLayout } from '../../components/DashboardLayout'
import { RowActionsMenu } from '../../components/RowActionsMenu'
import { SectionSearchInput } from '../../components/SectionSearchInput'
import { IconOutputs } from '../../components/Sidebar/icons'
import { TabBar } from '../../components/TabBar'
import { TablePanelHeader } from '../../components/TablePanelHeader'
import { IconRefresh } from '../../components/icons'
import {
  getAdminOutputsOverview,
  getHostArtifactDownloadUrl,
  getWorkflowRunArtifactDownloadUrl,
  isSilentApiError,
} from '../../lib/api'
import type { ChatArtifactOutputRow, WorkflowOutputRow } from '../../lib/api'

type OutputsTab = 'workflow' | 'desktop'

function parseOutputsTab(value: string | undefined): OutputsTab {
  return value === 'desktop-app-artifacts' ? 'desktop' : 'workflow'
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function OutputsPageContent() {
  const params = useParams<{ tab?: string }>()
  const [loading, setLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [workflowOutputs, setWorkflowOutputs] = useState<WorkflowOutputRow[]>([])
  const [chatArtifacts, setChatArtifacts] = useState<ChatArtifactOutputRow[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const activeTab = parseOutputsTab(params.tab)

  async function loadAll() {
    setLoading(true)
    setError('')
    setWarnings([])
    try {
      const overview = await getAdminOutputsOverview()
      setWorkflowOutputs(Array.isArray(overview.workflowOutputs) ? overview.workflowOutputs : [])
      setChatArtifacts(Array.isArray(overview.chatArtifacts) ? overview.chatArtifacts : [])
      setWarnings(Array.isArray(overview.warnings) ? overview.warnings : [])
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load outputs')
    } finally {
      setHasLoaded(true)
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  const allOutputs = workflowOutputs
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredWorkflowOutputs = useMemo(() => {
    if (!normalizedSearch) return allOutputs
    return allOutputs.filter(output =>
      [
        output.fileName,
        output.format,
        output.recipeName,
        output.namespace,
        output.runId,
        output.completedAt,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    )
  }, [allOutputs, normalizedSearch])
  const filteredChatArtifacts = useMemo(() => {
    if (!normalizedSearch) return chatArtifacts
    return chatArtifacts.filter(artifact =>
      [artifact.fileName, artifact.format, artifact.hostRef, artifact.createdAt]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    )
  }, [chatArtifacts, normalizedSearch])
  const workflowSort = useTableSort<
    WorkflowOutputRow,
    'file' | 'format' | 'recipe' | 'run' | 'completed'
  >({
    rows: filteredWorkflowOutputs,
    defaultKey: 'completed',
    defaultDirection: 'desc',
    identity: output =>
      `${output.namespace}/${output.recipeName}/${output.runId}/${output.fileName}`,
    accessors: {
      file: output => output.fileName,
      format: output => output.format,
      recipe: output => `${output.namespace}/${output.recipeName}`,
      run: output => output.runId,
      completed: output => output.completedAt,
    },
  })
  const artifactSort = useTableSort<
    ChatArtifactOutputRow,
    'file' | 'format' | 'size' | 'host' | 'created'
  >({
    rows: filteredChatArtifacts,
    defaultKey: 'created',
    defaultDirection: 'desc',
    identity: artifact => `${artifact.hostRef}/${artifact.fileName}/${artifact.createdAt}`,
    accessors: {
      file: artifact => artifact.fileName,
      format: artifact => artifact.format,
      size: artifact => artifact.sizeBytes,
      host: artifact => artifact.hostRef,
      created: artifact => artifact.createdAt,
    },
  })

  const FORMAT_COLORS: Record<string, string> = {
    pdf: '#ef4444',
    md: 'var(--cu-text-muted)',
    docx: 'var(--cu-accent-hover)',
    xlsx: '#22c55e',
    html: '#f59e0b',
    txt: 'var(--cu-text-soft)',
  }
  const getFormatColor = (format: string) => FORMAT_COLORS[format] ?? 'var(--cu-text-muted)'
  const isRefreshing = loading
  const showInitialLoading = loading && !hasLoaded
  const visibleOutputsCount = filteredWorkflowOutputs.length + filteredChatArtifacts.length

  async function downloadWorkflowOutput(output: WorkflowOutputRow) {
    const url = getWorkflowRunArtifactDownloadUrl(
      output.namespace,
      output.recipeName,
      output.runId,
      output.fileName
    )
    const resp = await fetch(url, { credentials: 'include' })
    if (!resp.ok) {
      setError(`${resp.status}: ${await resp.text()}`)
      return
    }
    const blobUrl = URL.createObjectURL(await resp.blob())
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = `${output.runId.slice(0, 8)}-${output.fileName}`
    link.click()
    URL.revokeObjectURL(blobUrl)
  }

  async function downloadChatArtifact(artifact: ChatArtifactOutputRow) {
    const url = getHostArtifactDownloadUrl(artifact.hostRef, artifact.fileName)
    const resp = await fetch(url, { credentials: 'include' })
    if (!resp.ok) {
      setError(`${resp.status}: ${await resp.text()}`)
      return
    }
    const blobUrl = URL.createObjectURL(await resp.blob())
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = artifact.fileName
    link.click()
    URL.revokeObjectURL(blobUrl)
  }

  return (
    <DashboardLayout>
      <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
        <TablePanelHeader
          title={
            <>
              <IconOutputs />
              {isRefreshing ? 'Agent Outputs' : `Agent Outputs (${visibleOutputsCount})`}
            </>
          }
          subtitle="Browse generated artifacts from workflows and chat sessions."
          refreshAction={
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={() => void loadAll()}
              disabled={isRefreshing}
              aria-label={isRefreshing ? 'Refreshing outputs…' : 'Reload outputs'}
            >
              <IconRefresh
                className={isRefreshing ? 'cu-spin' : undefined}
                width={18}
                height={18}
              />
            </button>
          }
          search={
            <SectionSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search agent outputs"
              ariaLabel="Search agent outputs"
              disabled={isRefreshing}
            />
          }
        />
        <div className="cu-card__body cu-card__body--auto cu-outputs-strip">
          {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
          {warnings.length > 0 ? (
            <div className="cu-banner cu-banner--warning" role="status">
              {warnings.join(' ')}
            </div>
          ) : null}

          <TabBar<OutputsTab>
            ariaLabel="Agent output sections"
            activeValue={activeTab}
            className="cu-tabs--flush-top"
            options={[
              {
                value: 'workflow',
                href: CONTROL_ROUTES.agentOutputs.recipeArtifacts,
                label:
                  activeTab === 'workflow'
                    ? `Recipe Artifacts (${filteredWorkflowOutputs.length})`
                    : 'Recipe Artifacts',
              },
              {
                value: 'desktop',
                href: CONTROL_ROUTES.agentOutputs.desktopAppArtifacts,
                label:
                  activeTab === 'desktop'
                    ? `Desktop App Artifacts (${filteredChatArtifacts.length})`
                    : 'Desktop App Artifacts',
              },
            ]}
          />
        </div>

        <div className="cu-card__body cu-outputs-content">
          {activeTab === 'workflow' ? (
            <TableViewport className="cu-table-wrap">
              <DataTable className="eft-table cu-table cu-table--header-band">
                <thead>
                  <tr>
                    {(
                      [
                        ['file', 'File'],
                        ['format', 'Format'],
                        ['recipe', 'Recipe'],
                        ['run', 'Run'],
                        ['completed', 'Completed'],
                      ] as const
                    ).map(([key, label]) => (
                      <TableHeaderCell
                        activeDirection={workflowSort.key === key ? workflowSort.direction : null}
                        key={key}
                        label={label}
                        onSort={() => workflowSort.sortBy(key)}
                      />
                    ))}
                    <TableHeaderCell label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {showInitialLoading ? (
                    <TableStateRow colSpan={6} kind="loading" message="Loading recipe artifacts…" />
                  ) : error && filteredWorkflowOutputs.length === 0 ? (
                    <TableStateRow colSpan={6} kind="error" message={error} />
                  ) : filteredWorkflowOutputs.length === 0 ? (
                    <TableStateRow
                      colSpan={6}
                      message={
                        normalizedSearch
                          ? 'No workflow artifacts match this search.'
                          : 'No workflow artifacts found. Run a plugin with document generation tools to see outputs here.'
                      }
                    />
                  ) : (
                    workflowSort.sortedRows.map(output => (
                      <tr
                        key={`${output.namespace}-${output.recipeName}-${output.runId}-${output.fileName}`}
                      >
                        <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{output.fileName}</td>
                        <td>
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 600,
                              background: 'var(--cu-bg-elevated)',
                              color: getFormatColor(output.format),
                              border: '1px solid var(--cu-border-subtle)',
                            }}
                          >
                            {output.format.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ fontSize: 13 }}>{output.recipeName}</td>
                        <td style={{ fontSize: 13, color: 'var(--cu-text-muted)' }}>
                          {output.runId.slice(0, 8)}
                        </td>
                        <td style={{ fontSize: 13, color: 'var(--cu-text-muted)' }}>
                          {output.completedAt ? new Date(output.completedAt).toLocaleString() : '—'}
                        </td>
                        <td className="cu-table__cell-actions">
                          <RowActionsMenu
                            ariaLabel={`Actions for workflow artifact ${output.fileName}`}
                            horizontalTrigger
                            actions={[
                              {
                                key: 'download',
                                label: 'Download',
                                onClick: () => void downloadWorkflowOutput(output),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </DataTable>
            </TableViewport>
          ) : (
            <TableViewport className="cu-table-wrap">
              <DataTable className="eft-table cu-table cu-table--header-band">
                <thead>
                  <tr>
                    {(
                      [
                        ['file', 'File'],
                        ['format', 'Format'],
                        ['size', 'Size'],
                        ['host', 'Host'],
                        ['created', 'Created'],
                      ] as const
                    ).map(([key, label]) => (
                      <TableHeaderCell
                        activeDirection={artifactSort.key === key ? artifactSort.direction : null}
                        key={key}
                        label={label}
                        onSort={() => artifactSort.sortBy(key)}
                      />
                    ))}
                    <TableHeaderCell label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {showInitialLoading ? (
                    <TableStateRow
                      colSpan={6}
                      kind="loading"
                      message="Loading desktop app artifacts…"
                    />
                  ) : error && filteredChatArtifacts.length === 0 ? (
                    <TableStateRow colSpan={6} kind="error" message={error} />
                  ) : filteredChatArtifacts.length === 0 ? (
                    <TableStateRow
                      colSpan={6}
                      message={
                        normalizedSearch
                          ? 'No desktop app artifacts match this search.'
                          : 'No desktop app artifacts found. Use internal tools (`clerum__generate_pdf`, etc.) during chat to generate files.'
                      }
                    />
                  ) : (
                    artifactSort.sortedRows.map(artifact => (
                      <tr key={`${artifact.hostRef}-${artifact.fileName}-${artifact.createdAt}`}>
                        <td style={{ fontFamily: 'monospace', fontSize: 13 }}>
                          {artifact.fileName}
                        </td>
                        <td>
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 600,
                              background: 'var(--cu-bg-elevated)',
                              color: getFormatColor(artifact.format),
                              border: '1px solid var(--cu-border-subtle)',
                            }}
                          >
                            {artifact.format.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ fontSize: 13, color: 'var(--cu-text-muted)' }}>
                          {artifact.sizeBytes > 0 ? formatBytes(artifact.sizeBytes) : '—'}
                        </td>
                        <td style={{ fontSize: 13 }}>{artifact.hostRef}</td>
                        <td style={{ fontSize: 13, color: 'var(--cu-text-muted)' }}>
                          {artifact.createdAt ? new Date(artifact.createdAt).toLocaleString() : '—'}
                        </td>
                        <td className="cu-table__cell-actions">
                          <RowActionsMenu
                            ariaLabel={`Actions for desktop artifact ${artifact.fileName}`}
                            horizontalTrigger
                            actions={[
                              {
                                key: 'download',
                                label: 'Download',
                                onClick: () => void downloadChatArtifact(artifact),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </DataTable>
            </TableViewport>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function OutputsPage() {
  return (
    <AuthGate>
      <OutputsPageContent />
    </AuthGate>
  )
}
