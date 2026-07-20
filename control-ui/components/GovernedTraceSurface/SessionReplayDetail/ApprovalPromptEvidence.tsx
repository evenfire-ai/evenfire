'use client'

import { useState } from 'react'
import { IconEye } from '@components/icons'
import { Button } from '@components/ui'
import { getGovernedApprovalPromptHistory } from '@lib/governedTrace'
import type { GovernedApprovalPromptHistory, PromptHistoryAvailability } from '@lib/governedTrace'
import { formatTraceTimestamp } from '../formatters'

export function ApprovalPromptEvidence({
  approvalRequestId,
  availability,
}: {
  approvalRequestId: string | null
  availability: PromptHistoryAvailability | 'check_required'
}) {
  const [evidence, setEvidence] = useState<GovernedApprovalPromptHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const canRequest = availability === 'available' || availability === 'check_required'

  if (!approvalRequestId || !canRequest) {
    return <span className="cu-table__cell-muted">Prompt history: {availability}</span>
  }

  async function reveal() {
    setLoading(true)
    setError(null)
    try {
      setEvidence(await getGovernedApprovalPromptHistory(approvalRequestId as string))
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'Unable to reveal prompt history.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="cu-trace-prompt-evidence">
      {!evidence ? (
        <Button disabled={loading} onClick={() => void reveal()} size="sm">
          <IconEye height={15} width={15} />
          {loading
            ? 'Checking...'
            : availability === 'check_required'
              ? 'Check protected prompt history'
              : 'Reveal retained prompt'}
        </Button>
      ) : evidence.availability === 'available' && evidence.prompt ? (
        <div className="cu-trace-prompt-evidence__content">
          <div className="cu-table__cell-muted">
            Captured {formatTraceTimestamp(evidence.prompt.capturedAt)} · expires{' '}
            {formatTraceTimestamp(evidence.prompt.expiresAt)}
          </div>
          <div className="cu-table__cell-muted">
            Key version {evidence.prompt.keyVersion} · redaction{' '}
            {evidence.prompt.redactionSummary.redacted ? 'applied' : 'not required'} ·{' '}
            {evidence.prompt.redactionSummary.replacementCount} replacements
          </div>
          <pre>{evidence.prompt.text}</pre>
          <Button onClick={() => setEvidence(null)} size="sm" variant="ghost">
            Hide retained prompt
          </Button>
        </div>
      ) : (
        <span className="cu-table__cell-muted">Prompt history: {evidence.availability}</span>
      )}
      {error ? (
        <span className="cu-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}
