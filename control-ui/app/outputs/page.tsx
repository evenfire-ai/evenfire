'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import { AuthGate } from '../../components/AuthGate'
import { DashboardLayout } from '../../components/DashboardLayout'
import { SectionSearchInput } from '../../components/SectionSearchInput'
import { IconOutputs } from '../../components/Sidebar/icons'
import { SkeletonTableRows } from '../../components/SkeletonTableRows'
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

function OutputsSkeletonTable({ headers }: { headers: string[] }) {
  return (
    <div className="cu-table-wrap" role="status" aria-label="Loading outputs" aria-live="polite">
      <table className="cu-table cu-table--header-band">
        <thead>
          <tr>
            {headers.map(header => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <SkeletonTableRows columns={headers.length} />
        </tbody>
      </table>
    </div>
  )
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

  return (
    <DashboardLayout>
      <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
        <TablePanelHeader
          title={
            <>
              <IconOutputs />
              {isRefreshing ? 'Outputs' : `Outputs (${visibleOutputsCount})`}
            </>
          }
          subtitle="Browse generated artifacts from workflows and chat sessions."
          actions={
            <>
              <SectionSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search outputs"
                ariaLabel="Search outputs"
                disabled={isRefreshing}
              />
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
            </>
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
            ariaLabel="Output sections"
            activeValue={activeTab}
            className="cu-tabs--flush-top"
            options={[
              {
                value: 'workflow',
                href: CONTROL_ROUTES.outputs.recipeArtifacts,
                label:
                  activeTab === 'workflow'
                    ? `Recipe Artifacts (${filteredWorkflowOutputs.length})`
                    : 'Recipe Artifacts',
              },
              {
                value: 'desktop',
                href: CONTROL_ROUTES.outputs.desktopAppArtifacts,
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
            showInitialLoading ? (
              <OutputsSkeletonTable
                headers={['File', 'Format', 'Recipe', 'Run', 'Completed', 'Action']}
              />
            ) : filteredWorkflowOutputs.length === 0 ? (
              <div className="cu-empty">
                {normalizedSearch
                  ? 'No workflow artifacts match this search.'
                  : 'No workflow artifacts found. Run a plugin with document generation tools to see outputs here.'}
              </div>
            ) : (
              <div className="cu-table-wrap">
                <table className="cu-table cu-table--header-band">
                  <thead>
                    <tr>
                      {['File', 'Format', 'Recipe', 'Run', 'Completed', 'Action'].map(h => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredWorkflowOutputs.map(output => (
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
                        <td>
                          <button
                            className="cu-btn cu-btn--sm cu-btn--toolbar"
                            onClick={async () => {
                              const url = getWorkflowRunArtifactDownloadUrl(
                                output.namespace,
                                output.recipeName,
                                output.runId,
                                output.fileName
                              )
                              const resp = await fetch(url, {
                                credentials: 'include',
                              })
                              if (!resp.ok) {
                                setError(`${resp.status}: ${await resp.text()}`)
                                return
                              }
                              const blob = await resp.blob()
                              const blobUrl = URL.createObjectURL(blob)
                              const link = document.createElement('a')
                              link.href = blobUrl
                              link.download = `${output.runId.slice(0, 8)}-${output.fileName}`
                              link.click()
                              URL.revokeObjectURL(blobUrl)
                            }}
                          >
                            Download
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <>
              {showInitialLoading ? (
                <OutputsSkeletonTable
                  headers={['File', 'Format', 'Size', 'Host', 'Created', 'Action']}
                />
              ) : filteredChatArtifacts.length === 0 ? (
                <div className="cu-empty">
                  {normalizedSearch
                    ? 'No desktop app artifacts match this search.'
                    : 'No desktop app artifacts found. Use internal tools (`clerum__generate_pdf`, etc.) during chat to generate files.'}
                </div>
              ) : (
                <div className="cu-table-wrap">
                  <table className="cu-table cu-table--header-band">
                    <thead>
                      <tr>
                        {['File', 'Format', 'Size', 'Host', 'Created', 'Action'].map(h => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredChatArtifacts.map(artifact => (
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
                            {artifact.createdAt
                              ? new Date(artifact.createdAt).toLocaleString()
                              : '—'}
                          </td>
                          <td>
                            <button
                              className="cu-btn cu-btn--sm cu-btn--toolbar"
                              onClick={async () => {
                                const url = getHostArtifactDownloadUrl(
                                  artifact.hostRef,
                                  artifact.fileName
                                )
                                const resp = await fetch(url, {
                                  credentials: 'include',
                                })
                                if (!resp.ok) {
                                  setError(`${resp.status}: ${await resp.text()}`)
                                  return
                                }
                                const blob = await resp.blob()
                                const blobUrl = URL.createObjectURL(blob)
                                const link = document.createElement('a')
                                link.href = blobUrl
                                link.download = artifact.fileName
                                link.click()
                                URL.revokeObjectURL(blobUrl)
                              }}
                            >
                              Download
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
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
