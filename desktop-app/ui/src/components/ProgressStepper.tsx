import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Divider, Flex, Spin, Steps, Tag, Tooltip, Typography } from 'antd'
import type { StepsProps } from 'antd'
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
  // U5 (mcp-oauth reactive consent): fired for a `connect_required` suspension —
  // opens the provider "Connect <server>" OAuth flow instead of Approve/Deny.
  onConnect?: () => void
}

function ThinkingIndicator({ label }: { label: string }) {
  return (
    <Flex align="center" gap="small" role="status" aria-live="polite">
      <Spin size="small" />
      <Typography.Text>{label}</Typography.Text>
    </Flex>
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

function stepIcon(state: 'running' | 'completed' | 'error'): string {
  if (state === 'completed') return '\u2713'
  if (state === 'running') return '\u25CF'
  return '\u2717'
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
  const content = <pre>{latestLines.join('\n')}</pre>
  return isError ? (
    <Alert
      type="error"
      showIcon
      title={content}
      data-testid="step-output-panel"
      data-tool-call-id={toolCallId}
    />
  ) : (
    <Card size="small" data-testid="step-output-panel" data-tool-call-id={toolCallId}>
      {content}
    </Card>
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
  const items: NonNullable<StepsProps['items']> = steps.map(step => {
    const showDivider = previousIteration !== undefined && step.iteration !== previousIteration
    previousIteration = step.iteration
    const fnName = toolFunctionName(step)
    const isExpanded = expandedIds.has(step.toolCallId)
    const preview = step.state === 'running' ? step.liveOutputPreview : step.outputPreview
    const canExpand = Boolean(preview)
    const tokenDescription = step.tokens ? formatTokenBreakdown(step.tokens) : undefined
    const title = canExpand ? (
      <Button
        type="text"
        size="small"
        data-testid={`step-row-${step.toolCallId}`}
        aria-expanded={isExpanded}
        onClick={() => toggleExpand(step.toolCallId)}
      >
        {step.displayName}
        {fnName ? <Typography.Text type="secondary"> {fnName}</Typography.Text> : null}
        {canExpand ? (
          <span
            className={`stepper-step-chevron${isExpanded ? ' stepper-step-chevron--open' : ''}`}
            aria-hidden="true"
          >
            {'\u25B8'}
          </span>
        ) : null}
      </Button>
    ) : (
      <Flex align="center" gap="small" data-testid={`step-row-${step.toolCallId}`}>
        <Typography.Text>{step.displayName}</Typography.Text>
        {fnName ? <Typography.Text type="secondary">{fnName}</Typography.Text> : null}
      </Flex>
    )
    const duration =
      step.state === 'completed' && step.durationMs != null ? (
        <Tooltip title={tokenDescription}>
          <Typography.Text
            aria-label={tokenDescription}
            tabIndex={0}
            title={tokenDescription}
            type="secondary"
          >
            {formatDuration(step.durationMs)}
            {step.tokens && ` · ${formatTokenCount(step.tokens.input + step.tokens.output)}`}
          </Typography.Text>
        </Tooltip>
      ) : step.state === 'running' ? (
        <Typography.Text type="secondary">
          {step.elapsedMs != null ? `running · ${formatElapsed(step.elapsedMs)}` : 'running...'}
        </Typography.Text>
      ) : step.state === 'error' ? (
        <Typography.Text type="danger" title={step.errorSummary || 'error'}>
          {step.errorSummary
            ? step.errorSummary.length > 60
              ? `${step.errorSummary.slice(0, 57)}...`
              : step.errorSummary
            : 'error'}
        </Typography.Text>
      ) : null
    const description = (
      <Flex vertical gap="small">
        {showDivider ? <Divider>Thinking further...</Divider> : null}
        {duration}
        {step.inputPreview ? (
          <Typography.Paragraph data-testid="step-input-preview">
            {step.inputPreview}
          </Typography.Paragraph>
        ) : null}
        {step.state === 'error' && step.errorSummary && step.errorSummary.length > 60 ? (
          <Alert type="error" title={step.errorSummary} />
        ) : null}
        {isExpanded && preview ? (
          <OutputPanel
            preview={preview}
            isError={step.state === 'error'}
            toolCallId={step.toolCallId}
          />
        ) : null}
      </Flex>
    )
    return {
      key: step.toolCallId,
      status: step.state === 'completed' ? 'finish' : step.state === 'error' ? 'error' : 'process',
      icon: <span className={`stepper-step-icon state-${step.state}`}>{stepIcon(step.state)}</span>,
      title,
      description,
    }
  })

  return <Steps direction="vertical" size="small" items={items} />
}

export function ProgressStepper({
  progress,
  hostRef,
  onApprove,
  onDeny,
  onCancel,
  onConnect,
}: ProgressStepperProps) {
  const [expanded, setExpanded] = useState(false)
  // The request id of the suspension the user already decided. A later suspension in
  // the same task (another tool asking after an approval) has a new id, so its card
  // starts with enabled buttons instead of inheriting the previous decision.
  const [decidedRequestId, setDecidedRequestId] = useState<string | null>(null)
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

  if (status === 'completed' && steps.length > 0) {
    const totalDuration = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
    const errorCount = steps.filter(s => s.state === 'error').length
    const toolNames = [...new Set(steps.map(s => s.displayName))].join(', ')
    const artifactNames = extractProgressArtifactNames(steps)
    return (
      <Flex vertical gap="small" data-testid="progress-stepper">
        <Flex align="center" justify="space-between" wrap gap="small">
          <Flex align="center" gap="small" wrap>
            <Tag
              icon={
                <span className="stepper-completed-icon stepper-details-toggle-icon">
                  {errorCount > 0 ? '\u26A0' : '\u2713'}
                </span>
              }
              color={errorCount > 0 ? 'error' : 'success'}
            >
              {errorCount > 0 ? 'Completed with errors' : 'Completed'}
            </Tag>
            <Typography.Text type="secondary">
              {steps.length} {steps.length === 1 ? 'tool' : 'tools'} ·{' '}
              {formatDuration(totalDuration)}
              {toolNames ? ` · ${toolNames}` : ''}
            </Typography.Text>
          </Flex>
          <Button
            type="text"
            data-testid="progress-expand-btn"
            onClick={() => setExpanded(previous => !previous)}
            aria-expanded={expanded}
            icon={
              <span
                className={`stepper-details-chevron${expanded ? ' stepper-details-chevron--open' : ''}`}
                aria-hidden="true"
              >
                ›
              </span>
            }
          >
            {expanded ? 'Hide details' : 'More details'}
          </Button>
        </Flex>
        {expanded && <StepList steps={steps} />}
        {expanded && hostRef && artifactNames.length > 0 && (
          <ArtifactsBadge hostRef={hostRef} artifactNames={artifactNames} />
        )}
      </Flex>
    )
  }

  if (status === 'cancelled') {
    return (
      <Flex vertical gap="small" data-testid="progress-stepper">
        <Alert
          type="warning"
          showIcon
          title="Cancelled"
          description={progress.cancelReason || undefined}
        />
        {steps.length > 0 && (
          <>
            <Button
              type="text"
              onClick={() => setExpanded(prev => !prev)}
              aria-expanded={expanded}
              icon={
                <span
                  className={`stepper-details-chevron${expanded ? ' stepper-details-chevron--open' : ''}`}
                  aria-hidden="true"
                >
                  ›
                </span>
              }
            >
              <span>{expanded ? 'Hide details' : 'More details'}</span>
            </Button>
            {expanded && <StepList steps={steps} />}
          </>
        )}
      </Flex>
    )
  }

  if (status === 'connecting') {
    return (
      <Flex align="center" justify="space-between" gap="small" data-testid="progress-stepper">
        <ThinkingIndicator label="Connecting" />
        {onCancel ? (
          <Button
            data-testid="progress-cancel-btn"
            onClick={handleCancelClick}
            disabled={isCancelling}
            aria-label={stopAgentAriaLabel}
            size="small"
            title={stopAgentAriaLabel}
            type="text"
            icon={
              <span className="stepper-stop-symbol" aria-hidden="true">
                ■
              </span>
            }
          />
        ) : null}
      </Flex>
    )
  }

  if (status === 'error') {
    return (
      <Alert data-testid="progress-stepper" type="error" showIcon title="Progress stream error" />
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
    const approvalPending = !!info && decidedRequestId === info.requestId
    const statusLabel = (
      <Typography.Text role="status" aria-live="polite" aria-atomic="true">
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
      </Typography.Text>
    )
    return (
      <Flex vertical gap="small" data-testid="progress-stepper">
        <Alert
          type="warning"
          showIcon
          icon={
            <span className="stepper-suspended-icon" aria-hidden="true">
              &#9888;
            </span>
          }
          title={statusLabel}
        />
        {onCancel ? (
          <Button
            data-testid="progress-cancel-btn"
            onClick={handleCancelClick}
            disabled={isCancelling}
            aria-label={stopAgentAriaLabel}
            size="small"
            title={stopAgentAriaLabel}
            type="text"
            icon={
              <span className="stepper-stop-symbol" aria-hidden="true">
                ■
              </span>
            }
          />
        ) : null}
        {info?.inputPreview && !isConnect && (
          <Card size="small" data-testid="approval-input-preview">
            <pre>{info.inputPreview.text}</pre>
            {info.inputPreview.truncated && (
              <p role="note">This preview is incomplete or changed by redaction.</p>
            )}
          </Card>
        )}
        {info && canConnect && (
          <Flex gap="small">
            <Button
              data-testid="connect-mcp-btn"
              type="primary"
              disabled={connectPending}
              onClick={() => {
                setConnectPending(true)
                onConnect()
              }}
              size="small"
            >
              {connectPending ? 'Connecting...' : `Connect ${connectServer}`}
            </Button>
          </Flex>
        )}
        {info && !canConnect && !isConnect && (onApprove || onDeny) && (
          <Flex gap="small">
            {onApprove && (
              <Button
                data-testid="approval-approve-btn"
                type="primary"
                disabled={approvalPending}
                onClick={() => {
                  setDecidedRequestId(info.requestId)
                  onApprove()
                }}
                size="small"
              >
                {approvalPending ? 'Approving...' : 'Approve'}
              </Button>
            )}
            {onDeny && (
              <Button
                data-testid="approval-deny-btn"
                type="primary"
                danger
                disabled={approvalPending}
                onClick={() => {
                  setDecidedRequestId(info.requestId)
                  onDeny()
                }}
                size="small"
              >
                Deny
              </Button>
            )}
          </Flex>
        )}
        {steps.length > 0 && (
          <>
            <Button
              type="text"
              onClick={() => setExpanded(prev => !prev)}
              aria-expanded={expanded}
              icon={
                <span
                  className={`stepper-details-chevron${expanded ? ' stepper-details-chevron--open' : ''}`}
                  aria-hidden="true"
                >
                  ›
                </span>
              }
            >
              <span>{expanded ? 'Hide details' : 'More details'}</span>
            </Button>
            {expanded && <StepList steps={steps} />}
          </>
        )}
      </Flex>
    )
  }

  const hasActiveSteps = steps.length > 0

  return (
    <Flex vertical gap="small" data-testid="progress-stepper">
      <Flex align="center" justify="space-between" gap="small">
        <ThinkingIndicator label={activeProgressLabel(progress)} />
        {onCancel ? (
          <Button
            data-testid="progress-cancel-btn"
            onClick={handleCancelClick}
            disabled={isCancelling}
            aria-label={stopAgentAriaLabel}
            size="small"
            title={stopAgentAriaLabel}
            type="text"
            icon={
              <span className="stepper-stop-symbol" aria-hidden="true">
                ■
              </span>
            }
          />
        ) : null}
      </Flex>
      {hasActiveSteps && (
        <>
          <Button
            type="text"
            onClick={() => setExpanded(prev => !prev)}
            aria-expanded={expanded}
            icon={
              <span
                className={`stepper-details-chevron${expanded ? ' stepper-details-chevron--open' : ''}`}
                aria-hidden="true"
              >
                ›
              </span>
            }
          >
            <span>{expanded ? 'Hide details' : 'More details'}</span>
          </Button>
          {expanded && <StepList steps={steps} />}
        </>
      )}
    </Flex>
  )
}
