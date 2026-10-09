import React, { useEffect, useId, useRef, useState } from 'react'
import { Button, IconButton } from '@components/Common'
import { extractArtifactNames } from '@lib/artifacts'
import { formatTokenBreakdown, formatTokenCount } from '@lib/format'
import { formatToolApprovalLabel } from '@lib/toolLabels'
import type { ApprovalDecisionSettlement } from '../hooks/domain/approvalDecision'
import type { ProgressStep, TaskProgress } from '../uiTypes'
import { ArtifactsBadge } from './ArtifactsBadge'

interface ProgressStepperProps {
  progress: TaskProgress | undefined
  hostRef?: string
  // A decision handler may resolve to its outcome; `'failed'` (or a rejection)
  // re-enables the same request for a retry (see `ApprovalDecisionSettlement`).
  onApprove?: () => void | Promise<ApprovalDecisionSettlement>
  onAlwaysApprove?: () => void | Promise<ApprovalDecisionSettlement>
  onDeny?: () => void | Promise<ApprovalDecisionSettlement>
  onCancel?: () => void
  // U5 (mcp-oauth reactive consent): fired for a `connect_required` suspension —
  // opens the provider "Connect <server>" OAuth flow instead of Approve/Deny.
  onConnect?: () => void
}

type ApprovalAction = 'approve' | 'always' | 'deny'

function ThinkingIndicator({ label }: { label: string }) {
  return (
    <span className="stepper-thinking" aria-live="polite">
      <span className="stepper-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{label}</span>
    </span>
  )
}

function extractProgressArtifactNames(steps: ProgressStep[]): string[] {
  const text = steps
    .flatMap(step => [
      step.inputPreview,
      ...(step.outputPreview?.headLines || []),
      ...(step.outputPreview?.tailLines || []),
      ...(step.liveOutputPreview?.headLines || []),
      ...(step.liveOutputPreview?.tailLines || []),
    ])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
  return extractArtifactNames(text)
}

function stepIcon(state: 'running' | 'completed' | 'error'): string {
  if (state === 'completed') return '\u2713'
  if (state === 'running') return '\u25CF'
  return '\u2717'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${minutes}m${seconds}s`
}

function toolFunctionName(step: { displayName: string; toolName: string }): string | null {
  const sep = step.toolName.indexOf('__')
  if (sep > 0) {
    // MCP tool: extract function after "__"
    return step.toolName.substring(sep + 2)
  }
  // Native tool: show toolName if it differs from displayName (e.g. memory_read → "Memory")
  if (step.displayName !== step.toolName) {
    return step.toolName
  }
  return null
}

function compactText(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function truncateStatusLabel(value: string): string {
  const maxLength = 96
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3).trimEnd()}...`
}

function stepSubjectLabel(step: ProgressStep): string {
  const fnName = toolFunctionName(step)
  return truncateStatusLabel(step.displayName || fnName || step.toolName)
}

function activeProgressLabel(progress: TaskProgress): string {
  const runningStep = [...progress.steps].reverse().find(step => step.state === 'running')
  if (runningStep) {
    return `Using ${stepSubjectLabel(runningStep)}`
  }

  const latestStep = progress.steps[progress.steps.length - 1]
  if (progress.llmElapsedMs != null) {
    if (latestStep) {
      return `Thinking after ${stepSubjectLabel(latestStep)} (${formatElapsed(progress.llmElapsedMs)})`
    }
    return `Thinking ${formatElapsed(progress.llmElapsedMs)}`
  }

  if (latestStep?.state === 'completed') {
    return `Finished ${stepSubjectLabel(latestStep)}`
  }
  if (latestStep?.state === 'error') {
    const errorSummary = compactText(latestStep.errorSummary)
    const label = errorSummary
      ? `${latestStep.displayName}: ${errorSummary}`
      : stepSubjectLabel(latestStep)
    return `Issue in ${truncateStatusLabel(label)}`
  }

  return 'Agent is thinking'
}

function OutputPanel({
  preview,
  isError,
  toolCallId,
}: {
  preview: NonNullable<ProgressStep['outputPreview']>
  isError?: boolean
  toolCallId: string
}) {
  const latestLines = preview.tailLines.length > 0 ? preview.tailLines : preview.headLines
  return (
    <div
      data-testid="step-output-panel"
      data-tool-call-id={toolCallId}
      className={`stepper-step-output${isError ? ' stepper-step-output--error' : ''}`}
    >
      <pre className="stepper-step-output-code">{latestLines.join('\n')}</pre>
    </div>
  )
}

function StepList({ steps }: { steps: TaskProgress['steps'] }) {
  const [expandedIds, setExpandedIds] = useState(
    () => new Set(steps.filter(s => s.state === 'error' && s.outputPreview).map(s => s.toolCallId))
  )
  const seenErrorIdsRef = useRef(
    new Set(steps.filter(s => s.state === 'error' && s.outputPreview).map(s => s.toolCallId))
  )

  // Auto-expand errors that arrive after mount (during live execution)
  useEffect(() => {
    const nextErrorIds = new Set(
      steps.filter(s => s.state === 'error' && s.outputPreview).map(s => s.toolCallId)
    )
    const newErrors = [...nextErrorIds].filter(
      toolCallId => !seenErrorIdsRef.current.has(toolCallId)
    )
    if (newErrors.length > 0) {
      setExpandedIds(prev => new Set([...prev, ...newErrors]))
    }
    seenErrorIdsRef.current = nextErrorIds
  }, [steps])

  const toggleExpand = (toolCallId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(toolCallId)) {
        next.delete(toolCallId)
      } else {
        next.add(toolCallId)
      }
      return next
    })
  }

  let previousIteration: number | undefined
  return (
    <div className="stepper-step-list">
      {steps.map(step => {
        const showDivider = previousIteration !== undefined && step.iteration !== previousIteration
        previousIteration = step.iteration
        const fnName = toolFunctionName(step)
        const isExpanded = expandedIds.has(step.toolCallId)
        const canExpand =
          (step.state !== 'running' && !!step.outputPreview) ||
          (step.state === 'running' && !!step.liveOutputPreview)
        return (
          <React.Fragment key={step.toolCallId}>
            {showDivider && <div className="stepper-iteration-divider">Thinking further...</div>}
            <div
              data-testid={`step-row-${step.toolCallId}`}
              className={`stepper-step${canExpand ? ' stepper-step-expandable' : ''}`}
              onClick={canExpand ? () => toggleExpand(step.toolCallId) : undefined}
            >
              <span className={`stepper-step-icon state-${step.state}`}>
                {stepIcon(step.state)}
              </span>
              <span className="stepper-step-name">
                {step.displayName}
                {fnName && <span className="stepper-step-fn">{fnName}</span>}
              </span>
              {step.state === 'completed' && step.durationMs != null && (
                <span
                  className="stepper-step-duration state-completed"
                  title={step.tokens ? formatTokenBreakdown(step.tokens) : undefined}
                >
                  {formatDuration(step.durationMs)}
                  {step.tokens && ` · ${formatTokenCount(step.tokens.input + step.tokens.output)}`}
                </span>
              )}
              {step.state === 'running' && (
                <span className="stepper-step-duration state-running">
                  {step.elapsedMs != null
                    ? `running · ${formatElapsed(step.elapsedMs)}`
                    : 'running...'}
                </span>
              )}
              {step.state === 'error' && (
                <span
                  className="stepper-step-duration state-error"
                  title={step.errorSummary || 'error'}
                >
                  {step.errorSummary
                    ? step.errorSummary.length > 60
                      ? step.errorSummary.slice(0, 57) + '...'
                      : step.errorSummary
                    : 'error'}
                </span>
              )}
              {canExpand && (
                <span
                  className={`stepper-step-chevron${isExpanded ? ' stepper-step-chevron--open' : ''}`}
                  aria-hidden="true"
                >
                  {'\u25B8'}
                </span>
              )}
            </div>
            {step.inputPreview && (
              <div data-testid="step-input-preview" className="stepper-step-input-preview">
                {step.inputPreview}
              </div>
            )}
            {step.state === 'error' && step.errorSummary && step.errorSummary.length > 60 && (
              <div className="stepper-step-error-detail">{step.errorSummary}</div>
            )}
            {isExpanded && step.state !== 'running' && step.outputPreview && (
              <OutputPanel
                preview={step.outputPreview}
                isError={step.state === 'error'}
                toolCallId={step.toolCallId}
              />
            )}
            {isExpanded && step.state === 'running' && step.liveOutputPreview && (
              <OutputPanel preview={step.liveOutputPreview} toolCallId={step.toolCallId} />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

export function ProgressStepper({
  progress,
  hostRef,
  onApprove,
  onAlwaysApprove,
  onDeny,
  onCancel,
  onConnect,
}: ProgressStepperProps) {
  const [expanded, setExpanded] = useState(false)
  // The decision latch belongs to one approval request, not to the mounted card:
  // the same card stays mounted while a resumed task suspends on a new request,
  // which must start with active controls. Only a failed (or rejected) decision
  // releases it. `action` scopes the pending label to the clicked button.
  const [deciding, setDeciding] = useState<{
    requestId: string
    action: ApprovalAction
  } | null>(null)
  const alwaysApproveScopeId = useId()
  const [connectPending, setConnectPending] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)

  const handleCancelClick = () => {
    setIsCancelling(true)
    onCancel?.()
  }

  useEffect(() => {
    if (!isCancelling) return
    const timeout = setTimeout(() => setIsCancelling(false), 5000)
    return () => clearTimeout(timeout)
  }, [isCancelling])

  // U5: re-enable the Connect button after a short window so a user who dismissed
  // the browser consent (task still suspended) can retry. Once the connect
  // completes the task resumes and the suspended block unmounts entirely.
  useEffect(() => {
    if (!connectPending) return
    const timeout = setTimeout(() => setConnectPending(false), 5000)
    return () => clearTimeout(timeout)
  }, [connectPending])

  const status = progress?.status
  const stopAgentAriaLabel = isCancelling ? 'Stopping agent' : 'Stop agent'
  useEffect(() => {
    if (status === 'cancelled' || status === 'completed' || status === 'error') {
      setIsCancelling(false)
    }
  }, [status])

  if (!progress) return null

  const { steps } = progress

  if (status === 'completed' && steps.length === 0) return null

  // Completed — subtle "More details" toggle (same pattern as running state)
  if (status === 'completed' && steps.length > 0) {
    const totalDuration = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
    const errorCount = steps.filter(s => s.state === 'error').length
    const toolNames = [...new Set(steps.map(s => s.displayName))].join(', ')
    const artifactNames = extractProgressArtifactNames(steps)
    return (
      <div data-testid="progress-stepper" className="progress-stepper status-completed">
        <Button
          type="button"
          data-testid="progress-expand-btn"
          className="stepper-details-toggle"
          onClick={() => setExpanded(prev => !prev)}
          aria-expanded={expanded}
          variant="text"
        >
          <span className="stepper-completed-icon stepper-details-toggle-icon">
            {errorCount > 0 ? '\u26A0' : '\u2713'}
          </span>
          <span>
            {expanded
              ? 'Hide details'
              : `More details · ${steps.length} tool${steps.length > 1 ? 's' : ''}`}
          </span>
          <span
            className={`stepper-details-chevron${expanded ? ' stepper-details-chevron--open' : ''}`}
            aria-hidden="true"
          >
            ›
          </span>
        </Button>
        {expanded && <StepList steps={steps} />}
        {expanded && hostRef && artifactNames.length > 0 && (
          <ArtifactsBadge hostRef={hostRef} artifactNames={artifactNames} />
        )}
      </div>
    )
  }

  if (status === 'cancelled') {
    return (
      <div data-testid="progress-stepper" className="progress-stepper status-cancelled">
        <div className="stepper-cancelled-row">
          <span className="stepper-cancelled-badge">Cancelled</span>
          {progress.cancelReason && (
            <span className="stepper-cancelled-reason">{progress.cancelReason}</span>
          )}
        </div>
        {steps.length > 0 && (
          <>
            <Button
              type="button"
              className="stepper-details-toggle"
              onClick={() => setExpanded(prev => !prev)}
              aria-expanded={expanded}
              variant="text"
            >
              <span>{expanded ? 'Hide details' : 'More details'}</span>
              <span
                className={`stepper-details-chevron${expanded ? ' stepper-details-chevron--open' : ''}`}
                aria-hidden="true"
              >
                ›
              </span>
            </Button>
            {expanded && <StepList steps={steps} />}
          </>
        )}
      </div>
    )
  }

  if (status === 'connecting') {
    return (
      <div data-testid="progress-stepper" className="progress-stepper">
        <div className="stepper-connecting-row">
          <ThinkingIndicator label="Connecting" />
          {onCancel && (
            <IconButton
              data-testid="progress-cancel-btn"
              className="stepper-btn progress-cancel-btn"
              onClick={handleCancelClick}
              disabled={isCancelling}
              label={stopAgentAriaLabel}
              size="sm"
              title={stopAgentAriaLabel}
              variant="soft"
            >
              <span className="stepper-stop-symbol" aria-hidden="true">
                ■
              </span>
            </IconButton>
          )}
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div data-testid="progress-stepper" className="progress-stepper">
        <span className="stepper-error-status">Progress stream error</span>
      </div>
    )
  }

  if (status === 'suspended') {
    const info = progress.suspendedInfo
    // U5: a `connect_required` suspension renders a "Connect <server>" prompt and
    // a Connect button (opens the provider OAuth flow) — NEVER Approve/Deny.
    // `canConnect` requires BOTH the marker and a usable `onConnect` (which the
    // caller only wires when `mcpServerName` is present). If a connect_required
    // ever arrives without an actionable connect (defensive — mcp-host always
    // emits mcpServerName), it renders an explanatory suspended state with Cancel,
    // NOT Approve/Deny: approving would resume with no grant → another 401 → a
    // re-suspension loop (the loop sessionFsm.ts guards against).
    const isConnect = info?.reason === 'connect_required'
    const connectServer = info?.mcpServerName || 'the connector'
    const canConnect = isConnect && !!onConnect
    const pendingAction = info && deciding?.requestId === info.requestId ? deciding.action : null
    const approvalPending = pendingAction !== null
    // The host refuses to allowlist some suspensions (`alwaysApproveAllowed: false`).
    const canAlwaysApprove = !!onAlwaysApprove && info?.alwaysApproveAllowed !== false
    const alwaysApproveScope = info
      ? `Allow every future ${formatToolApprovalLabel({
          displayName: info.displayName,
          toolName: info.toolName,
        })} call in this conversation`
      : undefined
    const decide = (action: ApprovalAction, handler: () => void | Promise<unknown>) => {
      if (!info) return
      const requestId = info.requestId
      setDeciding({ requestId, action })
      // Release only this request's latch: a late settlement for an earlier
      // request must not unlock the request the card shows now.
      const release = () =>
        setDeciding(current => (current?.requestId === requestId ? null : current))
      // The executor runs `handler` synchronously; a sync throw becomes a rejection.
      void new Promise(resolve => resolve(handler())).then(outcome => {
        if (outcome === 'failed') release()
      }, release)
    }
    return (
      <div data-testid="progress-stepper" className="progress-stepper status-suspended">
        <div className="stepper-suspended-row">
          <span className="stepper-suspended-icon">&#9888;</span>
          <span
            className="stepper-suspended-label"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {canConnect
              ? `Connect ${connectServer} to continue`
              : isConnect
                ? 'A connector must be reconnected to continue. Cancel and retry if this persists.'
                : info
                  ? `${formatToolApprovalLabel({
                      displayName: info.displayName,
                      toolName: info.toolName,
                    })} requires approval`
                  : 'Waiting for approval...'}
          </span>
          {onCancel && (
            <IconButton
              data-testid="progress-cancel-btn"
              className="stepper-btn progress-cancel-btn"
              onClick={handleCancelClick}
              disabled={isCancelling}
              label={stopAgentAriaLabel}
              size="sm"
              title={stopAgentAriaLabel}
              variant="soft"
            >
              <span className="stepper-stop-symbol" aria-hidden="true">
                ■
              </span>
            </IconButton>
          )}
        </div>
        {info?.inputPreview && !isConnect && (
          <div data-testid="approval-input-preview" className="stepper-step-output">
            <pre className="stepper-step-output-code">{info.inputPreview.text}</pre>
            {info.inputPreview.truncated && (
              <p role="note">This preview is incomplete or changed by redaction.</p>
            )}
          </div>
        )}
        {info && canConnect && (
          <div className="stepper-approval-actions">
            <Button
              data-testid="connect-mcp-btn"
              className="stepper-btn stepper-btn-approve"
              color="success"
              disabled={connectPending}
              onClick={() => {
                setConnectPending(true)
                onConnect()
              }}
              size="sm"
              variant="soft"
            >
              {connectPending ? 'Connecting...' : `Connect ${connectServer}`}
            </Button>
          </div>
        )}
        {info && !canConnect && !isConnect && (onApprove || canAlwaysApprove || onDeny) && (
          <div className="stepper-approval-actions">
            {onApprove && (
              <Button
                data-testid="approval-approve-btn"
                className="stepper-btn stepper-btn-approve"
                color="success"
                disabled={approvalPending}
                onClick={() => decide('approve', onApprove)}
                size="sm"
                variant="soft"
              >
                {pendingAction === 'approve' ? 'Approving...' : 'Approve'}
              </Button>
            )}
            {canAlwaysApprove && (
              <>
                <Button
                  data-testid="approval-always-approve-btn"
                  className="stepper-btn stepper-btn-always-approve"
                  color="success"
                  disabled={approvalPending}
                  onClick={() => decide('always', onAlwaysApprove!)}
                  size="sm"
                  title={alwaysApproveScope}
                  aria-describedby={alwaysApproveScopeId}
                  variant="soft"
                >
                  {pendingAction === 'always' ? 'Approving...' : 'Always approve'}
                </Button>
                <span id={alwaysApproveScopeId} hidden>
                  {alwaysApproveScope}
                </span>
              </>
            )}
            {onDeny && (
              <Button
                data-testid="approval-deny-btn"
                className="stepper-btn stepper-btn-deny"
                color="danger"
                disabled={approvalPending}
                onClick={() => decide('deny', onDeny)}
                size="sm"
                variant="soft"
              >
                {pendingAction === 'deny' ? 'Denying...' : 'Deny'}
              </Button>
            )}
          </div>
        )}
        {steps.length > 0 && (
          <>
            <Button
              type="button"
              className="stepper-details-toggle"
              onClick={() => setExpanded(prev => !prev)}
              aria-expanded={expanded}
              variant="text"
            >
              <span>{expanded ? 'Hide details' : 'More details'}</span>
              <span
                className={`stepper-details-chevron${expanded ? ' stepper-details-chevron--open' : ''}`}
                aria-hidden="true"
              >
                ›
              </span>
            </Button>
            {expanded && <StepList steps={steps} />}
          </>
        )}
      </div>
    )
  }

  const hasActiveSteps = steps.length > 0

  return (
    <div data-testid="progress-stepper" className="progress-stepper">
      <div className="stepper-running-row">
        <ThinkingIndicator label={activeProgressLabel(progress)} />
        {onCancel && (
          <IconButton
            data-testid="progress-cancel-btn"
            className="stepper-btn progress-cancel-btn"
            onClick={handleCancelClick}
            disabled={isCancelling}
            label={stopAgentAriaLabel}
            size="sm"
            title={stopAgentAriaLabel}
            variant="soft"
          >
            <span className="stepper-stop-symbol" aria-hidden="true">
              ■
            </span>
          </IconButton>
        )}
      </div>
      {hasActiveSteps && (
        <>
          <Button
            type="button"
            className="stepper-details-toggle"
            onClick={() => setExpanded(prev => !prev)}
            aria-expanded={expanded}
            variant="text"
          >
            <span>{expanded ? 'Hide details' : 'More details'}</span>
            <span
              className={`stepper-details-chevron${expanded ? ' stepper-details-chevron--open' : ''}`}
              aria-hidden="true"
            >
              ›
            </span>
          </Button>
          {expanded && <StepList steps={steps} />}
        </>
      )}
    </div>
  )
}
