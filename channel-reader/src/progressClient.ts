import { config } from './config'
import type { ChannelReaderRuntimeSource } from './rpcClient'
import type { ProgressStep } from './types'

export interface SuspendedEventData {
  taskId: string
  requestId: string
  toolName: string
  displayName: string
  reason?: string
}

export interface TerminalEventData {
  taskId: string
  status: 'completed' | 'failed' | 'cancelled' | 'timeout'
  reason?: string
  error?: {
    code: string
    message: string
    retryable: boolean
    provider: string
  }
}

export interface ProgressStreamOptions {
  mcpHostUrl: string
  taskId: string
  onProgress: (steps: ProgressStep[]) => void
  onSuspended: (data: SuspendedEventData) => void
  onTerminal: (data: TerminalEventData) => void
  onError: (error: string) => void
  source?: ChannelReaderRuntimeSource
  debounceMs?: number
}

export function createProgressStream(options: ProgressStreamOptions): {
  close: () => void
  steps: ProgressStep[]
} {
  const {
    mcpHostUrl,
    taskId,
    onProgress,
    onSuspended,
    onTerminal,
    onError,
    source,
    debounceMs = 300,
  } = options
  const steps: ProgressStep[] = []
  let closed = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const abortController = new AbortController()

  const flushProgress = () => {
    if (!closed && steps.length > 0) {
      onProgress([...steps])
    }
  }

  const scheduleFlush = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flushProgress, debounceMs)
  }

  const close = () => {
    if (closed) return
    closed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    abortController.abort()
  }

  const parseSseBlock = (block: string): { event: string; data: unknown } | null => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.substring(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.substring(5).trim())
    }
    if (!dataLines.length) return null
    try {
      return { event, data: JSON.parse(dataLines.join('\n')) }
    } catch {
      return null
    }
  }

  void (async () => {
    try {
      const url = `${mcpHostUrl.replace(/\/+$/, '')}/v1/runtime/tasks/${encodeURIComponent(taskId)}/progress/stream`
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        'x-clerum-edge-caller': 'channel-reader',
        'x-clerum-edge-host-ref': config.hostRef,
      }
      if (source) {
        headers['x-clerum-edge-channel-type'] = source.channelType
        headers['x-clerum-edge-channel-id'] = source.channelId
        headers['x-clerum-edge-sender'] = source.sender
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: abortController.signal,
      })

      if (!response.ok || !response.body) {
        if (!closed) onError(`Progress stream failed: HTTP ${response.status}`)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        let splitAt = buffer.indexOf('\n\n')
        while (splitAt >= 0) {
          const block = buffer.slice(0, splitAt)
          buffer = buffer.slice(splitAt + 2)
          splitAt = buffer.indexOf('\n\n')

          const parsed = parseSseBlock(block)
          if (!parsed) continue

          if (parsed.event === 'tool_start') {
            const d = parsed.data as Record<string, unknown>
            steps.push({
              toolCallId: String(d.toolCallId ?? ''),
              toolName: String(d.toolName ?? ''),
              displayName: String(d.displayName ?? ''),
              intentSummary: String(d.intentSummary ?? ''),
              iteration: Number(d.iteration ?? 0),
              stepIndex: Number(d.stepIndex ?? 0),
              totalSteps: Number(d.totalSteps ?? 0),
              state: 'running',
            })
            scheduleFlush()
          } else if (parsed.event === 'tool_complete') {
            const d = parsed.data as Record<string, unknown>
            const target = steps.find(s => s.toolCallId === String(d.toolCallId))
            if (target) {
              target.state = d.isError ? 'error' : 'completed'
              target.durationMs = typeof d.durationMs === 'number' ? d.durationMs : undefined
              target.errorSummary = typeof d.errorSummary === 'string' ? d.errorSummary : undefined
            }
            scheduleFlush()
          } else if (parsed.event === 'suspended') {
            // Approval needed — flush any pending progress, surface the event to
            // the caller, then KEEP THE STREAM OPEN. The same stream will deliver
            // subsequent tool_start/tool_complete events during post-approval
            // execution, and eventually the terminal event.
            if (debounceTimer) clearTimeout(debounceTimer)
            flushProgress()
            if (!closed) onSuspended(parsed.data as SuspendedEventData)
          } else if (parsed.event === 'terminal') {
            // mcp-host emits `terminal` for task completion (sseProgressReporter.ts:70).
            // Wrapper-layer `waiting`/`open` events are informational and ignored.
            // The data carries { taskId, status: 'completed'|'failed'|'cancelled'|'timeout', reason, error? }.
            if (debounceTimer) clearTimeout(debounceTimer)
            flushProgress()
            if (!closed) onTerminal(parsed.data as TerminalEventData)
            close()
            return
          } else if (parsed.event === 'error') {
            const d = parsed.data as Record<string, unknown>
            const message =
              typeof d.message === 'string' && d.message.trim().length > 0
                ? d.message.trim()
                : 'Progress stream error'
            if (!closed) onError(message)
            close()
            return
          }
        }
      }

      if (!closed) {
        // Stream ended without a terminal event. The new API keeps the stream
        // open through `suspended`, so a natural close after a suspended event
        // is informational, not an error. Flush any pending progress and let
        // the consumer drive the next step via its own timeout/poll fallback.
        flushProgress()
      }
    } catch (err) {
      if (closed) return
      onError(err instanceof Error ? err.message : String(err))
    }
  })()

  return {
    close,
    get steps() {
      return [...steps]
    },
  }
}
