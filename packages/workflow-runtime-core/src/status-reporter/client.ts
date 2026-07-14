import type { StepPhase, WorkflowPhase } from '../config-loader/types'
import type { RuntimeTokenProvider } from '../runtime-token-provider/provider'
import { requireRuntimeToken } from '../runtime-token-provider/provider'
import { sendWithAuthRetryOn401 } from './authRetry'
import { emitLog } from './logger'

const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 200

export class StatusReporter {
  private readonly wrcUrl: string
  private readonly workflowName: string
  private readonly tokenProvider: RuntimeTokenProvider

  constructor(opts: { wrcUrl: string; workflowName: string; tokenProvider: RuntimeTokenProvider }) {
    this.wrcUrl = opts.wrcUrl
    this.workflowName = opts.workflowName
    this.tokenProvider = opts.tokenProvider
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await requireRuntimeToken(this.tokenProvider, 'getWrcToken', 'WRC_TOKEN_FILE')
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }
  }

  private async report(path: string, body: Record<string, unknown>, label: string): Promise<void> {
    let lastErr: Error | undefined

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await sendWithAuthRetryOn401(
          async () =>
            fetch(
              `${this.wrcUrl}/api/v1/workflow/${encodeURIComponent(this.workflowName)}${path}`,
              {
                method: 'POST',
                headers: await this.authHeaders(),
                body: JSON.stringify(body),
              }
            ),
          label
        )
        if (resp.ok) {
          return
        }

        // Duplicate terminal step reports can happen when the first response is lost
        // after WRC already committed the status patch. Treat that idempotent conflict
        // as accepted, but fail closed for every other write error.
        if (resp.status === 409 && (await responseHasAlreadyTerminalPhase(resp))) {
          return
        }

        // 4xx = permanent client error, don't retry. This must be fatal because
        // otherwise the coordinator can mark a workflow completed while step status
        // patches were rejected.
        if (resp.status < 500) {
          // Log structural fields only — never log the full body which may contain
          // step output, error text, or contextVar values (potential data exfiltration).
          emitLog('warn', `Non-retryable error reporting ${label}: HTTP ${resp.status}`, {
            label,
            httpStatus: resp.status,
          })
          throw new Error(`WRC rejected ${label} with HTTP ${resp.status}`)
        }
        lastErr = new Error(`HTTP ${resp.status}`)
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        if (lastErr.message.startsWith('WRC rejected')) throw lastErr
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * Math.pow(2, attempt)))
      }
    }

    // Log only structural fields because status payloads can include step output.
    const message = `Failed to report ${label} after ${MAX_RETRIES} attempts: ${lastErr?.message}`
    emitLog('warn', message, { label })
    throw new Error(message)
  }

  async reportStepStatus(
    stepId: string,
    phase: StepPhase,
    meta?: {
      output?: unknown
      error?: string
      durationMs?: number
      executor?: 'agentic' | 'snippet' | 'custom'
      toolsCalled?: unknown[]
      modelUsed?: string
      failureReason?: string
      startedAt?: string
      completedAt?: string
    }
  ): Promise<void> {
    await this.report('/status', { stepId, phase, ...meta }, 'step status')
  }

  async reportWorkflowStatus(
    phase: WorkflowPhase,
    meta?: { failureReason?: string; completedAt?: string }
  ): Promise<void> {
    await this.report('/status', { workflowPhase: phase, ...meta }, 'workflow status')
  }

  async getWorkflowStatus(): Promise<{
    workflowPhase: string
    steps: Array<{ id: string; phase: string; output?: unknown; modelUsed?: string }>
    startedAt?: string
    attempt?: number
  }> {
    const resp = await sendWithAuthRetryOn401(
      async () =>
        fetch(`${this.wrcUrl}/api/v1/workflow/${encodeURIComponent(this.workflowName)}/status`, {
          headers: await this.authHeaders(),
        }),
      'workflow status fetch'
    )
    if (!resp.ok) {
      throw new Error(`Workflow status fetch failed: HTTP ${resp.status}`)
    }
    return (await resp.json()) as {
      workflowPhase: string
      steps: Array<{ id: string; phase: string; output?: unknown; modelUsed?: string }>
      startedAt?: string
      attempt?: number
    }
  }
}

async function responseHasAlreadyTerminalPhase(resp: Response): Promise<boolean> {
  try {
    const text = await resp.text()
    return text.toLowerCase().includes('already in terminal phase')
  } catch {
    return false
  }
}
