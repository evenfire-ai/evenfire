import React, { useEffect, useRef, useState } from 'react'
import { Button, IconButton } from '@components/Common'
import { extractArtifactNames } from '@lib/artifacts'
import { formatTokenBreakdown, formatTokenCount } from '@lib/format'
import { formatToolApprovalLabel } from '@lib/toolLabels'
import type { ProgressStep, TaskProgress } from '../uiTypes'
import { ArtifactsBadge } from './ArtifactsBadge'

interface ProgressStepperProps {
  progress: TaskProgress | undefined
  hostRef?: string
  onApprove?: () => void
  onDeny?: () => void
  onCancel?: () => void
}

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
}: {
  preview: NonNullable<ProgressStep['outputPreview']>
  isError?: boolean
}) {
  const latestLines = preview.tailLines.length > 0 ? preview.tailLines : preview.headLines
  return (
    <div
      data-testid="step-output-panel"
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
              <OutputPanel preview={step.outputPreview} isError={step.state === 'error'} />
            )}
            {isExpanded && step.state === 'running' && step.liveOutputPreview && (
              <OutputPanel preview={step.liveOutputPreview} />
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
  onDeny,
  onCancel,
}: ProgressStepperProps) {
  const [expanded, setExpanded] = useState(false)
  const [approvalPending, setApprovalPending] = useState(false)
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
    return (
      <div data-testid="progress-stepper" className="progress-stepper status-suspended">
        <div className="stepper-suspended-row">
          <span className="stepper-suspended-icon">&#9888;</span>
          <span className="stepper-suspended-label">
            {info
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
        {info && (onApprove || onDeny) && (
          <div className="stepper-approval-actions">
            {onApprove && (
              <Button
                data-testid="approval-approve-btn"
                className="stepper-btn stepper-btn-approve"
                color="success"
                disabled={approvalPending}
                onClick={() => {
                  setApprovalPending(true)
                  onApprove()
                }}
                size="sm"
                variant="soft"
              >
                {approvalPending ? 'Approving...' : 'Approve'}
              </Button>
            )}
            {onDeny && (
              <Button
                data-testid="approval-deny-btn"
                className="stepper-btn stepper-btn-deny"
                color="danger"
                disabled={approvalPending}
                onClick={() => {
                  setApprovalPending(true)
                  onDeny()
                }}
                size="sm"
                variant="soft"
              >
                Deny
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
