/**
 * Status Reporter — coordinator-to-WRC status protocol.
 *
 * Reports step and workflow-level status updates to WRC REST API.
 * Retries up to 3 times on 5xx responses with 2-second backoff.
 * */
import { StepPhase, WorkflowPhase } from './types'

// ─── Types ──────────────────────────────────────────────────────────────

export interface StepStatusUpdate {
  stepId: string
  phase: StepPhase
  output?: string
  executor?: 'agentic' | 'snippet' | 'custom'
  toolsCalled?: Array<{
    serverName: string
    toolName: string
    args: Record<string, unknown>
    result: unknown
    durationMs: number
  }>
  modelUsed?: string
  failureReason?: string
  startedAt?: string
  completedAt?: string
  approvalBindingSha256?: string
}

export interface WorkflowStatusUpdate {
  workflowPhase: WorkflowPhase
  failureReason?: string
  completedAt?: string
}

// ─── HTTP Client Interface (for DI) ────────────────────────────────────

export interface HttpClient {
  post(
    url: string,
    body: unknown,
    headers: Record<string, string>
  ): Promise<{ status: number; body?: unknown }>
  get(url: string, headers: Record<string, string>): Promise<{ status: number; body?: unknown }>
}

// ─── Status Reporter ────────────────────────────────────────────────────

const MAX_RETRIES = 5
const BACKOFF_MS = 3000

export class StatusReporter {
  constructor(
    private readonly wrcEndpoint: string,
    private readonly recipeName: string,
    private readonly wrcToken: string,
    private readonly httpClient: HttpClient
  ) {}

  private get authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.wrcToken}`,
    }
  }

  async reportStepStatus(update: StepStatusUpdate): Promise<void> {
    const url = `${this.wrcEndpoint}/api/v1/workflow/${encodeURIComponent(this.recipeName)}/status`
    await this.postWithRetry(url, update)
  }

  async reportWorkflowStatus(update: WorkflowStatusUpdate): Promise<void> {
    const url = `${this.wrcEndpoint}/api/v1/workflow/${encodeURIComponent(this.recipeName)}/status`
    await this.postWithRetry(url, update)
  }

  async getWorkflowStatus(): Promise<{
    workflowPhase: string
    steps: Array<{ id: string; phase: string; output?: string; modelUsed?: string }>
    startedAt?: string
    attempt?: number
  }> {
    const url = `${this.wrcEndpoint}/api/v1/workflow/${encodeURIComponent(this.recipeName)}/status`
    // Transient 5xx or network errors should not abort crash resume on the first attempt.
    let lastError: Error | undefined

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.httpClient.get(url, this.authHeaders)
        if (response.status < 400) {
          return response.body as {
            workflowPhase: string
            steps: Array<{ id: string; phase: string; output?: string; modelUsed?: string }>
            startedAt?: string
            attempt?: number
          }
        }
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`WRC returned ${response.status} on GET status`)
        }
        lastError = new Error(`WRC returned ${response.status} on GET status`)
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('WRC returned 4')) throw err
        lastError = err instanceof Error ? err : new Error(String(err))
      }

      if (attempt < MAX_RETRIES - 1) {
        await sleep(BACKOFF_MS)
      }
    }

    throw lastError ?? new Error('getWorkflowStatus failed after retries')
  }

  private async postWithRetry(url: string, body: unknown): Promise<void> {
    let lastError: Error | undefined
    const updatePhase = (body as { phase?: string })?.phase ?? 'unknown'
    const stepId = (body as { stepId?: string })?.stepId ?? 'workflow'

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(
            `[StatusReporter] Retry ${attempt + 1}/${MAX_RETRIES} for ${stepId}/${updatePhase} → ${url}`
          )
        }
        const response = await this.httpClient.post(url, body, this.authHeaders)
        if (response.status < 400) {
          if (attempt > 0)
            console.log(
              `[StatusReporter] ${stepId}/${updatePhase} succeeded on attempt ${attempt + 1}`
            )
          return
        }
        if (response.status === 409) {
          const bodyStr = typeof response.body === 'object' ? JSON.stringify(response.body) : ''
          if (bodyStr.includes('already in terminal phase')) {
            return
          }
          lastError = new Error(`WRC status update conflict (409) — retrying`)
        } else if (response.status >= 400 && response.status < 500) {
          throw new Error(`WRC rejected status update with ${response.status}`)
        }
        lastError = new Error(`WRC returned ${response.status}`)
        console.error(
          `[StatusReporter] ${stepId}/${updatePhase} attempt ${attempt + 1} HTTP ${response.status}`
        )
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('WRC rejected')) throw err
        lastError = err instanceof Error ? err : new Error(String(err))
        console.error(
          `[StatusReporter] ${stepId}/${updatePhase} attempt ${attempt + 1} error: ${lastError.message}`
        )
      }

      if (attempt < MAX_RETRIES - 1) {
        await sleep(BACKOFF_MS)
      }
    }

    throw lastError ?? new Error('Status report failed after retries')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
