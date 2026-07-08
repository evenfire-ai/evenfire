import { type RuntimeTokenProvider, requireRuntimeToken } from '@clerum/workflow-runtime-core'
import type { SnippetExecuteResponse, SnippetRunInvocationRequest } from './snippetTypes'

const DEFAULT_SNIPPET_RUNNER_TIMEOUT_MS = 305_000
const SNIPPET_RUNNER_RESPONSE_BUFFER_MS = 5_000

function resolveRequestTimeoutMs(
  request: SnippetRunInvocationRequest,
  fallbackTimeoutMs: number
): number {
  if (request.timeoutSeconds === undefined) return fallbackTimeoutMs
  if (!Number.isSafeInteger(request.timeoutSeconds) || request.timeoutSeconds < 1) {
    throw new Error('snippet timeoutSeconds must be a positive safe integer')
  }
  return request.timeoutSeconds * 1000 + SNIPPET_RUNNER_RESPONSE_BUFFER_MS
}

export class SnippetRunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenProvider: RuntimeTokenProvider,
    private readonly fallbackTimeoutMs = DEFAULT_SNIPPET_RUNNER_TIMEOUT_MS
  ) {}

  private async authHeader(): Promise<string> {
    const token = await requireRuntimeToken(
      this.tokenProvider,
      'getSnippetRunnerToken',
      'SNIPPET_RUNNER_TOKEN_FILE'
    )
    return `Bearer ${token}`
  }

  private async postExecute(
    request: SnippetRunInvocationRequest,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(`${this.baseUrl}/api/v1/snippet/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await this.authHeader(),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async execute(request: SnippetRunInvocationRequest): Promise<SnippetExecuteResponse> {
    try {
      const timeoutMs = resolveRequestTimeoutMs(request, this.fallbackTimeoutMs)
      let response = await this.postExecute(request, timeoutMs)
      if (response.status === 401) {
        // Snippet runner calls are step-scoped and already bounded by the step timeout.
        // One token reread handles rotation between pod startup and request dispatch
        // without masking persistent auth misconfiguration behind a long retry window.
        response = await this.postExecute(request, timeoutMs)
      }
      const bodyText = await response.text()
      let body: unknown
      try {
        body = bodyText ? JSON.parse(bodyText) : {}
      } catch {
        body = { error: bodyText || 'invalid-json-response' }
      }
      if (!response.ok) {
        const error =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error?: unknown }).error)
            : `snippet runner returned ${response.status}`
        return { stepId: request.stepId, status: 'failed', error }
      }
      return body as SnippetExecuteResponse
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'snippet runner request timed out'
          : error instanceof Error
            ? error.message
            : String(error)
      return { stepId: request.stepId, status: 'failed', error: message }
    }
  }
}
