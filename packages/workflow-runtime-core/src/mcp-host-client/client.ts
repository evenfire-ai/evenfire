import type { RuntimeTokenProvider } from '../runtime-token-provider/provider'
import { requireRuntimeToken } from '../runtime-token-provider/provider'
import {
  AUTH_RETRY_DELAY_MS,
  AUTH_RETRY_MAX_ATTEMPTS,
  sendWithAuthRetryOn401,
} from '../status-reporter/authRetry'
import { emitLog } from '../status-reporter/logger'
import type { AgentStepRequest, AgentStepResult } from './types'

const DEFAULT_MCP_HOST_STEP_TIMEOUT_SECONDS = 300
const MAX_MCP_HOST_STEP_TIMEOUT_SECONDS = 5400
const MCP_HOST_STEP_TIMEOUT_SECONDS_ENV = 'MCP_HOST_STEP_TIMEOUT_SECONDS'
const TIMEOUT_BUFFER_MS = 5000

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  if (parsed > MAX_MCP_HOST_STEP_TIMEOUT_SECONDS) {
    throw new Error(`${name} must be <= ${MAX_MCP_HOST_STEP_TIMEOUT_SECONDS}`)
  }
  return parsed
}

function resolveStepTimeoutSeconds(req: AgentStepRequest): number {
  if (req.timeoutSeconds !== undefined) {
    if (
      !Number.isSafeInteger(req.timeoutSeconds) ||
      req.timeoutSeconds < 1 ||
      req.timeoutSeconds > MAX_MCP_HOST_STEP_TIMEOUT_SECONDS
    ) {
      throw new Error(
        `step timeoutSeconds must be between 1 and ${MAX_MCP_HOST_STEP_TIMEOUT_SECONDS}`
      )
    }
    return req.timeoutSeconds
  }
  return readPositiveIntegerEnv(
    MCP_HOST_STEP_TIMEOUT_SECONDS_ENV,
    DEFAULT_MCP_HOST_STEP_TIMEOUT_SECONDS
  )
}

function failedResult(stepId: string, error: string): AgentStepResult {
  return { stepId, status: 'failed', durationMs: 0, error }
}

function parseSseResult(raw: string): { event: string; data: string } | null {
  let currentEvent = ''
  let lastResult: { event: string; data: string } | null = null

  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim()
      continue
    }
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6)
    if (currentEvent === 'result' || currentEvent === 'error') {
      lastResult = { event: currentEvent, data }
    }
    currentEvent = ''
  }

  return lastResult
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function timeoutError(): Error {
  return Object.assign(new Error('timeout'), { name: 'AbortError' })
}

function remainingDeadlineMs(deadlineMs: number): number {
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs < 1) throw timeoutError()
  return remainingMs
}

interface TimedResponse {
  response: Response
  clearTimeout: () => void
}

export class McpHostClient {
  private readonly url: string
  private readonly tokenProvider: RuntimeTokenProvider

  constructor(url: string, tokenProvider: RuntimeTokenProvider) {
    this.url = url
    this.tokenProvider = tokenProvider
  }

  private async authHeader(): Promise<string> {
    const token = await requireRuntimeToken(
      this.tokenProvider,
      'getMcpHostToken',
      'MCP_HOST_TOKEN_FILE'
    )
    return `Bearer ${token}`
  }

  private async postExecute(req: AgentStepRequest, timeoutMs: number): Promise<TimedResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.url}/api/v1/workflow/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await this.authHeader(),
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      })
      return {
        response,
        clearTimeout: () => clearTimeout(timer),
      }
    } catch (error) {
      clearTimeout(timer)
      throw error
    }
  }

  private async postExecuteWithAuthRetry(
    req: AgentStepRequest,
    timeoutMs: number
  ): Promise<TimedResponse> {
    const deadlineMs = Date.now() + timeoutMs
    for (let attempt = 1; ; attempt++) {
      const timed = await this.postExecute(req, remainingDeadlineMs(deadlineMs))
      if (timed.response.status !== 401 || attempt >= AUTH_RETRY_MAX_ATTEMPTS) {
        return timed
      }
      timed.clearTimeout()
      emitLog('warn', 'mcp-host execute returned 401; retrying with refreshed runtime token', {
        attempt,
        maxAttempts: AUTH_RETRY_MAX_ATTEMPTS,
      })
      await sleep(Math.min(AUTH_RETRY_DELAY_MS, remainingDeadlineMs(deadlineMs)))
    }
  }

  async executeAgentStep(req: AgentStepRequest): Promise<AgentStepResult> {
    try {
      const timeoutMs = resolveStepTimeoutSeconds(req) * 1000 + TIMEOUT_BUFFER_MS
      const timed = await this.postExecuteWithAuthRetry(req, timeoutMs)

      try {
        const resp = timed.response
        if (!resp.ok) {
          const errorText = await resp.text().catch(() => 'unknown')
          return failedResult(req.stepId, `mcp-host returned ${resp.status}: ${errorText}`)
        }

        const contentType = resp.headers?.get?.('content-type') ?? ''
        if (contentType.includes('text/event-stream')) {
          const raw = await resp.text()
          const event = parseSseResult(raw)
          if (event?.event === 'result') {
            return JSON.parse(event.data) as AgentStepResult
          }
          if (event?.event === 'error') {
            const parsed = JSON.parse(event.data) as { message?: string; error?: string }
            return failedResult(
              req.stepId,
              parsed.message ?? parsed.error ?? 'mcp-host stream error'
            )
          }
          return failedResult(req.stepId, 'mcp-host stream ended without a result event')
        }

        return (await resp.json()) as AgentStepResult
      } finally {
        timed.clearTimeout()
      }
    } catch (err) {
      const e = err as Error
      const isTimeout = e.name === 'AbortError' || e.message?.includes('timeout')
      emitLog('error', `Agent step execution failed: ${e.message}`, { stepId: req.stepId })
      return failedResult(req.stepId, isTimeout ? 'timeout' : e.message)
    }
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy' }> {
    try {
      const resp = await sendWithAuthRetryOn401(
        async () =>
          fetch(`${this.url}/v1/runtime/health`, {
            headers: { Authorization: await this.authHeader() },
          }),
        'mcp-host runtime health',
        { maxAttempts: 2, retryDelayMs: 0 }
      )
      return { status: resp.ok ? 'healthy' : 'unhealthy' }
    } catch {
      return { status: 'unhealthy' }
    }
  }
}
