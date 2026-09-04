'use client'

import React, { useEffect, useRef, useState } from 'react'
import { RecordList, RecordListRow, RowActionMenu } from '@clerum/frontend-components'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useToast } from '@components/Toast'
import { WorkflowAccessPanel } from '@components/WorkflowAccessPanel'
import {
  deleteWorkflowRunArtifact,
  deleteWorkflowRunArtifacts,
  getRecipe,
  getRecipeStatus,
  getWorkflowRunArtifactDownloadUrl,
  listWorkflowApprovalAllowedTeams,
  listWorkflowGrants,
  listWorkflowTeamGrants,
} from '@lib/api'
import type {
  ArtifactInfo,
  WorkflowApprovalAllowedTeam,
  WorkflowGrantTeam,
  WorkflowGrantUser,
  WorkflowRecipeResource,
} from '@lib/api'
import type {
  FailureAnalysis,
  GrantsReadonlyPanelProps,
  RecipeStatusContentProps,
  StepStatus,
  WorkflowExecution,
  WorkloadStatus,
} from './types'

const RUN_ID_SHORT_LEN = 8

function buildChildName(parentName: string, runId: string): string {
  return `${parentName}-${runId.toLowerCase().slice(0, RUN_ID_SHORT_LEN)}`
}

function saveAsMarkdown(recipeName: string, stepId: string, content: string) {
  const header = `# ${recipeName} — Step: ${stepId}\n\n_Generated: ${new Date().toISOString()}_\n\n---\n\n`
  const blob = new Blob([header + content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${recipeName}-${stepId}.md`
  a.click()
  URL.revokeObjectURL(url)
}

function StepOutputBlock({
  stepId,
  output,
  recipeName,
  outputTruncated,
  outputLength,
  outputPreviewMaxChars,
}: {
  stepId: string
  output: string
  recipeName: string
  outputTruncated?: boolean
  outputLength?: number
  outputPreviewMaxChars?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = output.length > 300
  const isTruncated = outputTruncated === true

  return (
    <div>
      {isTruncated && (
        <div
          role="note"
          style={{
            marginBottom: 6,
            padding: '6px 8px',
            border: '1px solid rgba(var(--cu-warning-rgb), 0.45)',
            borderRadius: 4,
            background: 'rgba(var(--cu-warning-rgb), 0.12)',
            color: 'var(--cu-warning)',
            fontSize: '0.75rem',
            lineHeight: 1.35,
          }}
        >
          Step output is a truncated status preview
          {typeof outputLength === 'number' && typeof outputPreviewMaxChars === 'number'
            ? ` (${outputPreviewMaxChars.toLocaleString('en-US')} of ${outputLength.toLocaleString('en-US')} characters).`
            : '.'}{' '}
          Download run artifacts for the complete file.
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          background: 'var(--cu-bg-elevated)',
          borderRadius: 4,
          color: 'var(--cu-text)',
          fontSize: '0.78rem',
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: expanded ? 600 : 150,
          overflow: 'auto',
          transition: 'max-height 0.3s ease',
        }}
      >
        {output}
      </pre>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--cu-border)',
              background: 'var(--cu-bg-elevated)',
              color: 'var(--cu-text-soft)',
              cursor: 'pointer',
              fontSize: '0.75rem',
              fontWeight: 600,
            }}
          >
            {expanded ? '▲ Collapse' : '▼ Expand'}
          </button>
        )}
        <CopyButton text={output} label="Copy output" />
        <button
          onClick={() => saveAsMarkdown(recipeName, stepId, output)}
          style={{
            padding: '2px 8px',
            borderRadius: 4,
            border: '1px solid var(--cu-border)',
            background: 'var(--cu-bg-elevated)',
            color: 'var(--cu-text-soft)',
            cursor: 'pointer',
            fontSize: '0.75rem',
            fontWeight: 600,
          }}
        >
          {isTruncated ? 'Save preview .md' : 'Save .md'}
        </button>
      </div>
    </div>
  )
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const { showToast } = useToast()
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    }
  }, [])

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
      copyResetRef.current = setTimeout(() => setCopied(false), 1500)
      showToast('Copied to clipboard.', { tone: 'success' })
    })
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      style={{
        padding: '2px 8px',
        borderRadius: 4,
        border: '1px solid var(--cu-border)',
        background: 'var(--cu-bg-elevated)',
        color: 'var(--cu-text-soft)',
        cursor: 'pointer',
        fontSize: '0.75rem',
        fontWeight: 600,
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

const FORMAT_ICONS: Record<string, string> = {
  pdf: 'PDF',
  md: 'MD',
  docx: 'DOCX',
  xlsx: 'XLSX',
  html: 'HTML',
  txt: 'TXT',
}

const FORMAT_COLORS: Record<string, string> = {
  pdf: '#ef4444',
  md: 'var(--cu-text-muted)',
  docx: 'var(--cu-accent-hover)',
  xlsx: '#22c55e',
  html: '#f59e0b',
  txt: 'var(--cu-text-soft)',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const ARTIFACT_EXTENSIONS: Record<string, string> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  md: 'md',
  html: 'html',
  txt: 'txt',
}

function extractArtifactsFromSteps(steps?: StepStatus[]): ArtifactInfo[] {
  if (!steps) return []
  const artifacts: ArtifactInfo[] = []
  const seen = new Set<string>()

  for (const step of steps) {
    const toolsCalled = (step as Record<string, unknown>).toolsCalled as
      | Array<{ serverName: string; result?: string | unknown }>
      | undefined
    if (toolsCalled) {
      for (const tc of toolsCalled) {
        try {
          const parsed = typeof tc.result === 'string' ? JSON.parse(tc.result) : tc.result
          if (parsed?.success && parsed?.artifact && !seen.has(parsed.artifact.name)) {
            seen.add(parsed.artifact.name)
            artifacts.push(parsed.artifact as ArtifactInfo)
          }
        } catch {
          /* truncated or not JSON */
        }
      }
    }

    if (step.output && step.phase === 'completed') {
      const filePattern =
        /(?:[`"'*\/]|:\s*|^|\s)([\w][\w.-]*\.(pdf|docx|xlsx|md|html|txt))(?:[`"'*\s,)}\].]|$)/gm
      let match: RegExpExecArray | null
      while ((match = filePattern.exec(step.output)) !== null) {
        const fname = match[1]
        const ext = match[2]
        if (!seen.has(fname) && ARTIFACT_EXTENSIONS[ext]) {
          seen.add(fname)
          artifacts.push({
            name: fname,
            format: ext,
            sizeBytes: 0,
            path: `/output/${fname}`,
            createdAt: step.completedAt ?? new Date().toISOString(),
          })
        }
      }
    }
  }
  return artifacts
}

export function GrantsReadonlyPanel(props: GrantsReadonlyPanelProps) {
  if (props.editable) {
    return (
      <WorkflowAccessEditor
        namespace={props.namespace}
        recipeName={props.recipeName}
        activeSection={props.activeSection}
      />
    )
  }
  return <WorkflowAccessReadonly namespace={props.namespace} recipeName={props.recipeName} />
}

function WorkflowAccessEditor({ namespace, recipeName, activeSection }: GrantsReadonlyPanelProps) {
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([])
  const [selectedApprovalTeamIds, setSelectedApprovalTeamIds] = useState<string[]>([])

  return (
    <WorkflowAccessPanel
      mode="edit"
      namespace={namespace}
      recipeName={recipeName}
      activeSection={activeSection}
      selectedUserIds={selectedUserIds}
      selectedTeamIds={selectedTeamIds}
      selectedApprovalTeamIds={selectedApprovalTeamIds}
      onSelectedUserIdsChange={setSelectedUserIds}
      onSelectedTeamIdsChange={setSelectedTeamIds}
      onSelectedApprovalTeamIdsChange={setSelectedApprovalTeamIds}
    />
  )
}

function WorkflowAccessReadonly({ namespace, recipeName }: GrantsReadonlyPanelProps) {
  const [grants, setGrants] = useState<WorkflowGrantUser[] | null>(null)
  const [teamGrants, setTeamGrants] = useState<WorkflowGrantTeam[] | null>(null)
  const [approvalTeams, setApprovalTeams] = useState<WorkflowApprovalAllowedTeam[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [users, teams, allowedTeams] = await Promise.all([
          listWorkflowGrants(namespace, recipeName),
          listWorkflowTeamGrants(namespace, recipeName),
          listWorkflowApprovalAllowedTeams(namespace, recipeName),
        ])
        if (cancelled) return
        setGrants(users.items ?? [])
        setTeamGrants(teams.items ?? [])
        setApprovalTeams(allowedTeams.items ?? [])
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load workflow access')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [namespace, recipeName])

  return (
    <div className="cu-workflow-access" data-testid="grants-readonly-panel">
      <div className="cu-workflow-access__readonly-header">
        <div className="cu-workflow-access__readonly-eyebrow">Workflow access</div>
        <div className="cu-workflow-access__readonly-note">Open the Users tab to modify</div>
      </div>
      {error && (
        <div className="cu-workflow-access__error" role="alert">
          {error}
        </div>
      )}
      <ReadonlyAccessGroup
        title={`Trigger users (${grants?.length ?? '...'})`}
        emptyText="No users authorized to trigger this recipe yet."
        loaded={grants !== null}
      >
        {grants && grants.length > 0 && (
          <div className="cu-workflow-access__rows">
            {grants.map(g => (
              <div className="cu-workflow-access__row" key={g.id}>
                <span className="cu-workflow-access__row-title">
                  {g.displayName || g.name || g.email}
                </span>
                {(g.displayName || g.name) && (
                  <span className="cu-workflow-access__row-meta">({g.email})</span>
                )}
              </div>
            ))}
          </div>
        )}
      </ReadonlyAccessGroup>

      <ReadonlyAccessGroup
        title={`Trigger teams (${teamGrants?.length ?? '...'})`}
        emptyText="No teams authorized to trigger this recipe yet."
        loaded={teamGrants !== null}
      >
        {teamGrants && teamGrants.length > 0 && (
          <div className="cu-workflow-access__rows">
            {teamGrants.map(team => (
              <div className="cu-workflow-access__row" key={team.id}>
                <div className="cu-workflow-access__row-main">
                  <span className="cu-workflow-access__row-title">{team.name}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </ReadonlyAccessGroup>

      <ReadonlyAccessGroup
        title={`Approval target teams (${approvalTeams?.length ?? '...'})`}
        emptyText="No teams allowed as approval targets yet."
        loaded={approvalTeams !== null}
      >
        {approvalTeams && approvalTeams.length > 0 && (
          <div className="cu-workflow-access__rows">
            {approvalTeams.map(team => (
              <div className="cu-workflow-access__row" key={team.id}>
                <div className="cu-workflow-access__row-main">
                  <span className="cu-workflow-access__row-title">{team.name}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </ReadonlyAccessGroup>
    </div>
  )
}

function ReadonlyAccessGroup({
  title,
  emptyText,
  loaded,
  children,
}: {
  title: string
  emptyText: string
  loaded: boolean
  children: React.ReactNode
}) {
  return (
    <div className="cu-workflow-access__readonly-group">
      <div className="cu-workflow-access__readonly-title">{title}</div>
      {loaded && !children && <div className="cu-workflow-access__empty">{emptyText}</div>}
      {children}
    </div>
  )
}

function ArtifactsPanel({
  artifacts,
  namespace,
  parentName,
  runId,
}: {
  artifacts: ArtifactInfo[]
  namespace: string
  parentName: string
  runId?: string
}) {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deletedFiles, setDeletedFiles] = useState<Set<string>>(new Set())

  function downloadName(artifactName: string) {
    if (!runId) return artifactName
    return `${runId.slice(0, 8)}-${artifactName}`
  }

  async function handleDownload(artifact: ArtifactInfo) {
    if (!runId) {
      setDownloadError('Artifact downloads require an explicit workflow run.')
      return
    }
    setDownloading(artifact.name)
    setDownloadError(null)
    try {
      const url = getWorkflowRunArtifactDownloadUrl(namespace, parentName, runId, artifact.name)
      const resp = await fetch(url, {
        credentials: 'include',
      })
      if (!resp.ok) {
        const errBody = await resp.text()
        throw new Error(`${resp.status}: ${errBody}`)
      }
      const blob = await resp.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = downloadName(artifact.name)
      a.click()
      URL.revokeObjectURL(blobUrl)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloading(null)
    }
  }

  async function handleDeleteFile(artifact: ArtifactInfo) {
    if (!runId) {
      setDownloadError('Artifact deletion requires an explicit workflow run.')
      return
    }
    const shouldDelete = await confirm({
      title: 'Delete Artifact',
      message: `Delete artifact ${artifact.name}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return

    setDeleting(artifact.name)
    setDownloadError(null)
    try {
      await deleteWorkflowRunArtifact(namespace, parentName, runId, artifact.name)
      setDeletedFiles(prev => new Set(prev).add(artifact.name))
      showToast(`Deleted ${artifact.name}.`, { tone: 'success' })
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  async function handleDeleteAll() {
    if (!runId) {
      setDownloadError('Artifact cleanup requires an explicit workflow run.')
      return
    }
    const shouldDelete = await confirm({
      title: 'Delete All Artifacts',
      message: `Delete all ${visibleArtifacts.length} visible output artifacts for this workflow run?`,
      confirmLabel: 'Delete all',
      tone: 'danger',
    })
    if (!shouldDelete) return

    setDeleting('__all__')
    setDownloadError(null)
    try {
      await deleteWorkflowRunArtifacts(namespace, parentName, runId)
      setDeletedFiles(new Set(artifacts.map(a => a.name)))
      showToast('All artifacts deleted.', { tone: 'success' })
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Delete all failed')
    } finally {
      setDeleting(null)
    }
  }

  const visibleArtifacts = artifacts.filter(a => !deletedFiles.has(a.name))
  if (visibleArtifacts.length === 0 && artifacts.length === 0) return null

  return (
    <div data-testid="artifacts-panel">
      <div
        style={{
          color: 'var(--cu-text-soft)',
          fontWeight: 700,
          fontSize: '0.85rem',
          marginBottom: 8,
        }}
      >
        Output Artifacts ({visibleArtifacts.length})
      </div>
      {runId && visibleArtifacts.length > 0 && (
        <div style={{ marginBottom: 8, textAlign: 'right' }}>
          <button
            onClick={() => void handleDeleteAll()}
            disabled={deleting !== null}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid #5a2020',
              background: '#1a0a0a',
              color: '#ff8ea7',
              cursor: 'pointer',
              fontSize: '0.72rem',
              fontWeight: 600,
            }}
          >
            {deleting === '__all__' ? '...' : 'Clear All'}
          </button>
        </div>
      )}
      <RecordList className="cu-diagnostic-record-list" aria-label="Output artifacts">
        {visibleArtifacts.map(a => (
          <RecordListRow
            key={a.name}
            className="cu-diagnostic-record-list__row"
            data-testid="artifact-row"
            data-artifact-name={a.name}
          >
            <span
              data-testid="artifact-format"
              style={{
                padding: '2px 6px',
                borderRadius: 3,
                background: `${FORMAT_COLORS[a.format] ?? 'var(--cu-text-muted)'}20`,
                color: FORMAT_COLORS[a.format] ?? 'var(--cu-text-muted)',
                fontSize: '0.72rem',
                fontWeight: 700,
                fontFamily: 'monospace',
                minWidth: 36,
                textAlign: 'center',
              }}
            >
              {FORMAT_ICONS[a.format] ?? a.format.toUpperCase()}
            </span>
            <span
              data-testid="artifact-name"
              style={{
                color: 'var(--cu-text)',
                fontSize: '0.82rem',
                fontWeight: 600,
                flexGrow: 1,
                fontFamily: 'monospace',
              }}
            >
              {a.name}
            </span>
            <span style={{ color: 'var(--cu-text-muted)', fontSize: '0.75rem' }}>
              {formatBytes(a.sizeBytes)}
            </span>
            <RowActionMenu
              actions={[
                {
                  key: 'download',
                  label: downloading === a.name ? 'Downloading…' : 'Download',
                  disabled: downloading === a.name || !runId,
                  onSelect: () => void handleDownload(a),
                },
                ...(runId
                  ? [
                      {
                        key: 'delete',
                        label: deleting === a.name ? 'Deleting…' : 'Delete',
                        danger: true,
                        disabled: deleting === a.name,
                        onSelect: () => void handleDeleteFile(a),
                      },
                    ]
                  : []),
              ]}
              ariaLabel={`Actions for artifact ${a.name}`}
            />
          </RecordListRow>
        ))}
      </RecordList>
      {downloadError && (
        <p style={{ margin: '6px 0 0', color: '#ff8ea7', fontSize: '0.78rem' }}>{downloadError}</p>
      )}
      {confirmDialog}
    </div>
  )
}

function wfPhaseBadgeStyle(phase?: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: '0.78rem',
    fontWeight: 600,
    display: 'inline-block',
  }
  switch (phase) {
    case 'running':
      return {
        ...base,
        background: 'rgba(var(--cu-accent-rgb), 0.14)',
        color: 'var(--cu-accent-hover)',
      }
    case 'completed':
      return {
        ...base,
        background: 'rgba(var(--cu-success-rgb), 0.18)',
        color: 'var(--cu-success)',
      }
    case 'inconsistent':
      return {
        ...base,
        background: 'rgba(var(--cu-warning-rgb), 0.16)',
        color: 'var(--cu-warning)',
      }
    case 'failed':
      return { ...base, background: '#3a1a1a', color: '#f87171' }
    case 'skipped':
      return { ...base, background: '#2a2a2a', color: '#9ca3af' }
    case 'pending':
      return { ...base, background: '#2a2a1a', color: '#fbbf24' }
    default:
      return { ...base, background: 'var(--cu-bg-elevated)', color: 'var(--cu-text-soft)' }
  }
}

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return ''
  const s = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function analyzeFailure(
  recipeName: string,
  message?: string,
  steps?: StepStatus[],
  childRecipeName?: string | null
): FailureAnalysis | null {
  const failedStep = steps?.find(s => s.phase === 'failed')
  const errorText = [message, failedStep?.error, failedStep?.output]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (!errorText) return null
  const targetRecipeName = childRecipeName || recipeName

  if (
    (errorText.includes('spec.workloads') && errorText.includes('unresolved template reference')) ||
    errorText.includes('template injection') ||
    errorText.includes('blocked template key')
  ) {
    return {
      type: 'validation',
      title: 'WorkflowRecipe Template Resolution Failed',
      suggestion:
        'WRC rejected the WorkflowRecipe before runtime workloads executed. Review the field path in the status message and the child recipe spec.',
      debugHint: `kubectl get workflowrecipe -n sandbox-recipes ${targetRecipeName} -o yaml\nkubectl get events -n sandbox-recipes --sort-by=.lastTimestamp\nkubectl get pods -n sandbox-recipes -l clerum.io/parent-recipe=${recipeName}`,
    }
  }

  if (
    errorText.includes('fetch failed') ||
    errorText.includes('econnrefused') ||
    errorText.includes('connection refused')
  ) {
    return {
      type: 'infra',
      title: 'Network / Infrastructure Error',
      suggestion:
        'The coordinator could not reach the mcp-host pod. Usually a pod startup race condition or DNS issue inside the cluster. The readiness gate should handle this automatically — check coordinator logs.',
      debugHint: `kubectl --context=<context> logs -n sandbox-recipes -l recipe=${recipeName} -c coordinator --tail=60\nkubectl --context=<context> get pods -n sandbox-recipes`,
    }
  }

  if (
    errorText.includes('model-config-failed') ||
    errorText.includes('configure-model') ||
    (errorText.includes('model') && errorText.includes('failed'))
  ) {
    return {
      type: 'config',
      title: 'Model Configuration Error',
      suggestion:
        'The agent model/provider configuration failed. Verify spec.agent.provider and spec.agent.model are correct, and that the API key secret exists in the cluster.',
      debugHint: `kubectl --context=<context> get secret chatllm-api-keys -n mcp-host\nkubectl --context=<context> get configmap clerum-model-secret-mapping -n mcp-host\nkubectl --context=<context> logs -n sandbox-recipes -l recipe=${recipeName} --tail=40`,
    }
  }

  if (errorText.includes('timeout') || errorText.includes('step-timeout')) {
    return {
      type: 'timeout',
      title: 'Step Timeout',
      suggestion:
        'A step exceeded its timeout (default 300s). Increase spec.steps[].timeoutSeconds or check if the mcp-host is stuck waiting for an LLM response.',
      debugHint: `kubectl --context=<context> logs -n mcp-host deploy/mcp-host --tail=60`,
    }
  }

  if (errorText.includes('cyclic') || errorText.includes('circular')) {
    return {
      type: 'dependency',
      title: 'Circular Step Dependency',
      suggestion:
        'Steps have a circular dependsOn chain. Review spec.steps[].dependsOn — the dependency graph must be a DAG (no cycles).',
    }
  }

  if (
    errorText.includes('401') ||
    errorText.includes('403') ||
    errorText.includes('unauthorized') ||
    (errorText.includes('token') && errorText.includes('invalid'))
  ) {
    return {
      type: 'auth',
      title: 'Authentication Error',
      suggestion:
        'The coordinator JWT was rejected. This may be a key rotation issue. Re-deploy the recipe or run make minikube-gen-keys to rotate keys.',
      debugHint: `kubectl --context=<context> get configmap clerum-wrc-public-key -n sandbox-recipes`,
    }
  }

  if (errorText.includes('404') || errorText.includes('not found')) {
    return {
      type: 'infra',
      title: 'Resource Not Found (404)',
      suggestion:
        'WRC returned 404 when the coordinator tried to report status. WorkflowRecipe CRDs must be in the "sandbox-recipes" namespace; mcp-server is only for rendered MCP transport children.',
      debugHint: `kubectl --context=<context> get workflowrecipes -n sandbox-recipes`,
    }
  }

  return {
    type: 'unknown',
    title: 'Workflow Execution Failed',
    suggestion: 'Check the coordinator and mcp-host logs for the full error trace.',
    debugHint: `kubectl --context=<context> logs -n sandbox-recipes -l recipe=${recipeName} --tail=100\nkubectl --context=<context> describe pod -n sandbox-recipes -l recipe=${recipeName}`,
  }
}

function formatDuration(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt) return null
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const secs = Math.round((end - start) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m ${remSecs}s`
}

function StepElapsedTime({
  startedAt,
  completedAt,
  phase,
}: {
  startedAt?: string
  completedAt?: string
  phase: string
}) {
  const [, setTick] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (phase === 'running' && startedAt && !completedAt) {
      intervalRef.current = setInterval(() => setTick(t => t + 1), 1000)
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current)
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [phase, startedAt, completedAt])

  const duration = formatDuration(startedAt, completedAt)
  if (!duration) return null

  return (
    <span style={{ color: 'var(--cu-text-muted)', fontSize: '0.72rem', fontFamily: 'monospace' }}>
      {duration}
    </span>
  )
}

function stepDotColor(phase: string): string {
  switch (phase) {
    case 'completed':
      return 'var(--cu-success)'
    case 'running':
      return 'var(--cu-accent-hover)'
    case 'failed':
      return '#ef4444'
    case 'skipped':
      return '#9ca3af'
    case 'pending':
    default:
      return 'var(--cu-border)'
  }
}

function WorkflowProgressBar({ steps }: { steps: StepStatus[] }) {
  const total = steps.length
  const completed = steps.filter(s => s.phase === 'completed').length
  const failed = steps.filter(s => s.phase === 'failed').length
  const pct = total > 0 ? Math.round(((completed + failed) / total) * 100) : 0

  return (
    <div style={{ marginBottom: 12 }}>
      <style>{`@keyframes wfPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '0.78rem',
          color: 'var(--cu-text-soft)',
          marginBottom: 4,
        }}
      >
        <span>
          Progress: {completed}/{total} steps
        </span>
        <span>{pct}%</span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 2,
          height: 6,
          borderRadius: 3,
          overflow: 'hidden',
          background: 'var(--cu-border-subtle)',
        }}
      >
        {steps.map((step, i) => (
          <div
            key={step.id}
            style={{
              flex: 1,
              background:
                step.phase === 'completed'
                  ? 'var(--cu-success)'
                  : step.phase === 'running'
                    ? 'var(--cu-accent-hover)'
                    : step.phase === 'failed'
                      ? '#ef4444'
                      : 'var(--cu-border)',
              borderRadius:
                i === 0 && i === steps.length - 1
                  ? '3px'
                  : i === 0
                    ? '3px 0 0 3px'
                    : i === steps.length - 1
                      ? '0 3px 3px 0'
                      : '0',
              animation: step.phase === 'running' ? 'wfPulse 1.5s ease-in-out infinite' : 'none',
            }}
          />
        ))}
      </div>
    </div>
  )
}

function phaseBadgeStyle(phase?: string): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '2px 10px',
    borderRadius: 4,
    fontSize: '0.82rem',
    fontWeight: 600,
    display: 'inline-block',
  }
  switch (phase?.trim().toLowerCase()) {
    case 'active':
    case 'running':
      return {
        ...base,
        background: 'rgba(var(--cu-success-rgb), 0.18)',
        color: 'var(--cu-success)',
      }
    case 'succeeded':
      return { ...base, background: '#1a3a2a', color: '#34d399' }
    case 'failed':
      return { ...base, background: '#3a1a1a', color: '#f87171' }
    case 'cancelled':
    case 'canceled':
      return { ...base, background: 'var(--cu-bg-elevated)', color: 'var(--cu-text-soft)' }
    case 'pending':
    case 'deploying':
    case 'testing':
      return { ...base, background: '#2a2a1a', color: '#fbbf24' }
    default:
      return { ...base, background: 'var(--cu-bg-elevated)', color: 'var(--cu-text-soft)' }
  }
}

export function RecipeStatusContent({ name, namespace, runId }: RecipeStatusContentProps) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null)
  // Declared step ids from spec.steps[] (the canonical step list). Loaded
  // once on mount — spec doesn't change between polls. Used to fix the
  // "auto-incrementing step count" bug: status.steps[] is populated as
  // steps execute, so without this we'd report e.g. "Steps (1)" then
  // "Steps (2)" as runtime caught up. Spec is identical on parent and
  // child recipes, so we fetch from whichever resource the page targets.
  const [specStepIds, setSpecStepIds] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pollingError, setPollingError] = useState('')
  // True when the targeted child WorkflowRecipe could not be fetched
  // because the resource is missing (404). Surfaced as a friendly
  // explanation instead of a raw "404 Not Found" error banner — runs that
  // are still queued (no child created yet) or that have been
  // garbage-collected legitimately land here.
  const [runMissing, setRunMissing] = useState(false)

  // When a runId is specified, target that exact child recipe (named
  // `<parent>-<runId.slice(0,8)>` per workflow-recipes/childRecipeFactory).
  // Without a runId, fall back to the parent's /status endpoint, which the
  // server already resolves to the latest child via resolveLatestRun.
  const childName = runId ? buildChildName(name, runId) : null
  const wfExecution = status?.workflowExecution as WorkflowExecution | undefined
  const isLive = wfExecution?.phase === 'running'
  const phase = status?.phase as string | undefined
  const workloads = status?.workloads as WorkloadStatus[] | undefined
  const statusMessage = status?.message as string | undefined
  const executionMessage =
    wfExecution && typeof wfExecution.message === 'string' ? wfExecution.message : undefined
  const message = executionMessage || statusMessage
  const runtimeSteps = (status?.steps as StepStatus[] | undefined) ?? []
  // Merge declared spec.steps (canonical order, total count) with runtime
  // status.steps (phase, output, ...). Steps declared but not yet started
  // render as "pending" so the progress bar denominator stays stable.
  const steps: StepStatus[] | undefined = specStepIds
    ? (() => {
        const byId = new Map(runtimeSteps.map(s => [s.id, s]))
        return specStepIds.map(id => byId.get(id) ?? { id, phase: 'pending' as const })
      })()
    : runtimeSteps.length > 0
      ? runtimeSteps
      : undefined
  const hasFailed = wfExecution?.phase === 'failed' || phase?.trim().toLowerCase() === 'failed'
  const failureAnalysis = hasFailed ? analyzeFailure(name, message, steps, childName) : null
  const crdArtifacts = status?.artifacts as ArtifactInfo[] | undefined
  const artifacts = crdArtifacts ?? extractArtifactsFromSteps(steps)

  const wfPhase = wfExecution?.phase as string | undefined
  const workflowCompletionHasOpenSteps =
    wfPhase === 'completed' &&
    steps?.some(s => s.phase !== 'completed' && s.phase !== 'skipped') === true
  const displayedWorkflowPhase = workflowCompletionHasOpenSteps ? 'inconsistent' : wfPhase
  const isTerminal =
    !workflowCompletionHasOpenSteps &&
    (wfPhase === 'completed' || wfPhase === 'failed' || wfPhase === 'cancelled')

  // One-shot: load the declared step list from spec.steps[]. Best-effort.
  // Spec is identical on parent and child WorkflowRecipes, so when the
  // child resource is missing (queued run / garbage-collected) we fall
  // back to the parent — this keeps the progress-bar denominator stable
  // even on the missing-run path.
  useEffect(() => {
    let cancelled = false
    const tryLoad = async (target: string) => {
      const recipe = await getRecipe(target)
      const ss = (recipe?.spec as { steps?: Array<{ id?: string }> } | undefined)?.steps
      if (Array.isArray(ss)) {
        const ids = ss
          .map(s => s?.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
        if (ids.length > 0 && !cancelled) setSpecStepIds(ids)
      }
    }
    ;(async () => {
      try {
        await tryLoad(childName ?? name)
      } catch {
        if (childName) {
          try {
            await tryLoad(name)
          } catch {}
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [name, childName])

  // Initial fetch
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setPollingError('')
    setRunMissing(false)
    const fetcher = childName
      ? async () => {
          const recipe = (await getRecipe(childName)) as WorkflowRecipeResource
          return (recipe?.status as Record<string, unknown> | undefined) ?? {}
        }
      : () => getRecipeStatus(name)
    fetcher()
      .then(s => {
        if (!cancelled) setStatus(s)
      })
      .catch(e => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : 'Failed to load status'
        // 404 on the runId path means the child WorkflowRecipe doesn't
        // exist (yet, or anymore). Surface a friendly state instead of
        // the raw "404 Not Found" error banner.
        if (childName && msg.startsWith('404 ')) {
          setRunMissing(true)
        } else {
          setError(msg)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [name, namespace, childName])

  // Auto-refresh polling every 3s until terminal. Cap at 15min to protect
  // against a stuck backend; the user can navigate away and back to resume.
  useEffect(() => {
    if (isTerminal) return
    let cancelled = false
    const startedAt = Date.now()
    const POLL_CAP_MS = 15 * 60 * 1000
    const fetcher = childName
      ? async () => {
          const recipe = (await getRecipe(childName)) as WorkflowRecipeResource
          return (recipe?.status as Record<string, unknown> | undefined) ?? {}
        }
      : () => getRecipeStatus(name)
    const id = setInterval(() => {
      if (Date.now() - startedAt > POLL_CAP_MS) {
        clearInterval(id)
        return
      }
      fetcher()
        .then(s => {
          if (cancelled) return
          setStatus(s)
          setPollingError('')
          // Recover from a transient 404 once the child shows up (queued
          // run case): the next successful poll clears the missing state.
          setRunMissing(false)
        })
        .catch(e => {
          if (cancelled) return
          const msg = e instanceof Error ? e.message : 'Failed to refresh status'
          setPollingError(msg)
        })
    }, 3_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [isTerminal, name, namespace, childName])

  return (
    <div className="cu-card">
      <div
        className="cu-card__body"
        style={{
          display: 'grid',
          gap: 14,
        }}
      >
        {(isLive || workflowCompletionHasOpenSteps) && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(var(--cu-accent-rgb), 0.14)',
              color: 'var(--cu-accent-hover)',
              fontSize: '0.72rem',
              fontWeight: 700,
              alignSelf: 'flex-start',
            }}
          >
            ● Live
          </span>
        )}

        {loading && (
          <p style={{ margin: 0, color: 'var(--cu-text-soft)', fontSize: '0.9rem' }}>
            Loading status…
          </p>
        )}
        {runMissing && !loading && (
          <p
            style={{
              margin: 0,
              color: 'var(--cu-text-soft)',
              fontSize: '0.9rem',
              background: 'var(--cu-bg-elevated)',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid var(--cu-border)',
            }}
            role="status"
          >
            This run isn&apos;t in the cluster. The Kubernetes WorkflowRecipe for this run is either
            still being created (queued runs) or has been cleaned up. If the run is in flight it
            will appear here once the controller picks it up.
          </p>
        )}
        {error && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }} role="alert">
            <p style={{ margin: 0, color: 'var(--cu-danger)', fontSize: '0.9rem', flexGrow: 1 }}>
              {error}
            </p>
            <CopyButton text={error} label="Copy" />
          </div>
        )}
        {pollingError && !error && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }} role="alert">
            <p style={{ margin: 0, color: 'var(--cu-warning)', fontSize: '0.9rem', flexGrow: 1 }}>
              Status polling stalled: {pollingError}
            </p>
            <CopyButton text={pollingError} label="Copy" />
          </div>
        )}

        {status && Object.keys(status).length === 0 && (
          <p
            style={{
              margin: 0,
              color: 'var(--cu-text-soft)',
              fontSize: '0.9rem',
              background: 'var(--cu-bg-elevated)',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid var(--cu-border)',
            }}
          >
            No status reported yet — the Workload Recipes Controller has not yet reconciled this
            recipe. Redeploy or wait for the next reconciliation cycle.
          </p>
        )}

        <GrantsReadonlyPanel namespace={namespace} recipeName={name} />

        {status && Object.keys(status).length > 0 && (
          <>
            {phase && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: 'var(--cu-text-soft)', fontSize: '0.85rem', minWidth: 130 }}>
                  Workload Phase:
                </span>
                <span style={phaseBadgeStyle(phase)}>{phase}</span>
              </div>
            )}

            {wfExecution && (
              <div
                style={{
                  background: 'var(--cu-bg-elevated)',
                  border: '1px solid var(--cu-border-subtle)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div
                  style={{
                    color: 'var(--cu-text-soft)',
                    fontWeight: 700,
                    fontSize: '0.85rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  Workflow Execution
                  {wfExecution.attempt !== undefined && wfExecution.attempt > 1 && (
                    <span
                      style={{
                        color: 'var(--cu-text-muted)',
                        fontSize: '0.75rem',
                        fontWeight: 400,
                      }}
                    >
                      attempt #{wfExecution.attempt}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ color: 'var(--cu-text-muted)', fontSize: '0.82rem' }}>
                      Phase:
                    </span>
                    <span
                      data-testid="wf-execution-phase"
                      style={wfPhaseBadgeStyle(displayedWorkflowPhase)}
                    >
                      {displayedWorkflowPhase ?? '—'}
                    </span>
                  </div>
                  {wfExecution.startedAt && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ color: 'var(--cu-text-muted)', fontSize: '0.82rem' }}>
                        Started:
                      </span>
                      <span style={{ color: 'var(--cu-text-soft)', fontSize: '0.82rem' }}>
                        {new Date(wfExecution.startedAt).toLocaleTimeString()}
                      </span>
                      <span style={{ color: 'var(--cu-text-muted)', fontSize: '0.78rem' }}>
                        ({formatElapsed(wfExecution.startedAt)})
                      </span>
                    </div>
                  )}
                </div>
                {workflowCompletionHasOpenSteps && (
                  <p
                    role="alert"
                    style={{
                      margin: 0,
                      color: 'var(--cu-warning)',
                      fontSize: '0.82rem',
                    }}
                  >
                    Workflow completion is inconsistent: declared steps are still open.
                  </p>
                )}
              </div>
            )}

            {steps && steps.length > 0 && (
              <div>
                <div
                  style={{
                    color: 'var(--cu-text-soft)',
                    fontWeight: 700,
                    fontSize: '0.85rem',
                    marginBottom: 8,
                  }}
                >
                  Steps ({steps.length})
                </div>
                <WorkflowProgressBar steps={steps} />
                <div style={{ display: 'grid', gap: 0 }}>
                  {steps.map((step, i) => (
                    <div key={step.id} style={{ display: 'flex', gap: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          width: 24,
                          flexShrink: 0,
                          paddingTop: 14,
                        }}
                      >
                        <div
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: stepDotColor(step.phase),
                            flexShrink: 0,
                            boxShadow:
                              step.phase === 'running'
                                ? '0 0 6px 2px rgba(96,165,250,0.45)'
                                : step.phase === 'completed'
                                  ? '0 0 4px 1px rgba(74,222,128,0.3)'
                                  : 'none',
                            animation:
                              step.phase === 'running'
                                ? 'wfPulse 1.5s ease-in-out infinite'
                                : 'none',
                          }}
                        />
                        {i < steps.length - 1 && (
                          <div
                            style={{
                              width: 2,
                              flexGrow: 1,
                              minHeight: 8,
                              background:
                                step.phase === 'completed'
                                  ? 'var(--cu-success)'
                                  : step.phase === 'running'
                                    ? 'var(--cu-accent-hover)'
                                    : 'var(--cu-border-subtle)',
                              opacity: step.phase === 'completed' ? 0.5 : 0.3,
                            }}
                          />
                        )}
                      </div>
                      <div
                        style={{
                          flex: 1,
                          background: 'var(--cu-bg-elevated)',
                          border: `1px solid ${
                            step.phase === 'failed'
                              ? '#5a1a1a'
                              : step.phase === 'running'
                                ? 'var(--cu-border-subtle)'
                                : step.phase === 'completed'
                                  ? '#1a3a20'
                                  : 'var(--cu-border-subtle)'
                          }`,
                          borderRadius: 6,
                          padding: '8px 10px',
                          display: 'grid',
                          gap: 6,
                          marginBottom: i < steps.length - 1 ? 6 : 0,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span
                            style={{
                              color: 'var(--cu-text-muted)',
                              fontSize: '0.75rem',
                              minWidth: 18,
                            }}
                          >
                            {i + 1}.
                          </span>
                          <span
                            style={{
                              color: 'var(--cu-text)',
                              fontWeight: 600,
                              fontSize: '0.85rem',
                              flexGrow: 1,
                              fontFamily: 'monospace',
                            }}
                          >
                            {step.id}
                          </span>
                          <span style={wfPhaseBadgeStyle(step.phase)}>{step.phase}</span>
                          <StepElapsedTime
                            startedAt={step.startedAt}
                            completedAt={step.completedAt}
                            phase={step.phase}
                          />
                          {step.modelUsed && (
                            <span
                              style={{
                                color: 'var(--cu-text-muted)',
                                fontSize: '0.72rem',
                                fontFamily: 'monospace',
                              }}
                            >
                              {step.modelUsed}
                            </span>
                          )}
                          {step.phase === 'running' && (
                            <span style={{ color: 'var(--cu-accent-hover)', fontSize: '0.72rem' }}>
                              ●
                            </span>
                          )}
                        </div>
                        {step.output && (
                          <StepOutputBlock
                            stepId={step.id}
                            output={step.output}
                            recipeName={name}
                            outputTruncated={step.outputTruncated}
                            outputLength={step.outputLength}
                            outputPreviewMaxChars={step.outputPreviewMaxChars}
                          />
                        )}
                        {step.error && (
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                            <p
                              style={{
                                margin: 0,
                                color: '#ff8ea7',
                                fontSize: '0.78rem',
                                flexGrow: 1,
                                fontFamily: 'monospace',
                              }}
                            >
                              {step.error}
                            </p>
                            <CopyButton text={step.error} label="Copy" />
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {artifacts.length > 0 && (
              <ArtifactsPanel
                artifacts={artifacts}
                namespace={namespace}
                parentName={name}
                runId={runId}
              />
            )}

            {workloads && workloads.length > 0 && (
              <div>
                <div
                  style={{
                    color: 'var(--cu-text-soft)',
                    fontWeight: 700,
                    fontSize: '0.85rem',
                    marginBottom: 8,
                  }}
                >
                  Workloads ({workloads.length})
                </div>
                <RecordList className="cu-diagnostic-record-list" aria-label="Execution workloads">
                  {workloads.map(w => (
                    <RecordListRow
                      key={w.id}
                      className="cu-diagnostic-record-list__row cu-diagnostic-record-list__row--workload"
                    >
                      <span style={{ color: 'var(--cu-text)', fontWeight: 600, flexGrow: 1 }}>
                        {w.id}
                      </span>
                      <span
                        style={{
                          color: w.ready ? 'var(--cu-success)' : '#fbbf24',
                          fontWeight: 600,
                        }}
                      >
                        {w.ready ? 'Ready' : 'Not Ready'}
                      </span>
                      {w.replicas !== undefined && (
                        <span style={{ color: 'var(--cu-text-muted)' }}>×{w.replicas}</span>
                      )}
                    </RecordListRow>
                  ))}
                </RecordList>
              </div>
            )}

            {message && (
              <div>
                <div
                  style={{
                    color: 'var(--cu-text-soft)',
                    fontWeight: 700,
                    fontSize: '0.85rem',
                    marginBottom: 4,
                  }}
                >
                  Message
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <p
                    style={{
                      margin: 0,
                      color: 'var(--cu-text-soft)',
                      fontSize: '0.85rem',
                      background: 'var(--cu-bg-elevated)',
                      padding: '8px 10px',
                      borderRadius: 6,
                      flexGrow: 1,
                    }}
                  >
                    {message}
                  </p>
                  <CopyButton text={message} label="Copy" />
                </div>
              </div>
            )}

            {failureAnalysis && (
              <div
                style={{
                  border: '1px solid #5a1a1a',
                  borderRadius: 8,
                  padding: '12px 14px',
                  background: '#120808',
                  display: 'grid',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    color: '#f87171',
                    fontWeight: 700,
                    fontSize: '0.9rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      padding: '1px 6px',
                      borderRadius: 3,
                      background: '#3a1a1a',
                      fontSize: '0.72rem',
                      fontFamily: 'monospace',
                    }}
                  >
                    {failureAnalysis.type.toUpperCase()}
                  </span>
                  {failureAnalysis.title}
                </div>
                <p style={{ margin: 0, color: 'var(--cu-text-soft)', fontSize: '0.85rem' }}>
                  {failureAnalysis.suggestion}
                </p>
                {failureAnalysis.debugHint && (
                  <div>
                    <div
                      style={{
                        color: 'var(--cu-text-muted)',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        marginBottom: 4,
                      }}
                    >
                      Debug commands:
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <pre
                        style={{
                          margin: 0,
                          padding: '8px 10px',
                          background: 'var(--cu-bg-elevated)',
                          borderRadius: 6,
                          color: 'var(--cu-text-soft)',
                          fontSize: '0.75rem',
                          fontFamily: 'monospace',
                          flexGrow: 1,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {failureAnalysis.debugHint}
                      </pre>
                      <CopyButton text={failureAnalysis.debugHint} label="Copy" />
                    </div>
                  </div>
                )}
              </div>
            )}

            <details>
              <summary
                style={{
                  color: 'var(--cu-text-muted)',
                  cursor: 'pointer',
                  fontSize: '0.82rem',
                  userSelect: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span>Raw JSON</span>
                <span onClick={e => e.preventDefault()}>
                  <CopyButton text={JSON.stringify(status, null, 2)} label="Copy JSON" />
                </span>
              </summary>
              <pre
                style={{
                  marginTop: 6,
                  padding: 10,
                  background: 'var(--cu-bg-elevated)',
                  borderRadius: 6,
                  color: 'var(--cu-text)',
                  fontSize: '0.76rem',
                  overflow: 'auto',
                  maxHeight: 200,
                  fontFamily: 'monospace',
                }}
              >
                {JSON.stringify(status, null, 2)}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  )
}
