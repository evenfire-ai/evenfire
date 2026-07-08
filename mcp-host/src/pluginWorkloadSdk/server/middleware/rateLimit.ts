import type { NextFunction, Request, Response } from 'express'
import { PluginWorkloadError } from '../../domain/errors'

/**
 * Per-workload rate limiting (plan §3.2): sliding one-minute request window
 * plus a concurrent-request ceiling, both keyed by the caller workload id.
 * In-memory is correct here — the SDK server is a single pod-local process.
 */

export interface RateLimitOptions {
  maxRequestsPerMinute: number
  maxConcurrent: number
  now?: () => number
}

interface CallerState {
  timestamps: number[]
  inFlight: number
}

export function createRateLimitMiddleware(opts: RateLimitOptions) {
  const callers = new Map<string, CallerState>()
  const now = opts.now ?? (() => Date.now())

  return (req: Request, res: Response, next: NextFunction): void => {
    const callerRef = req.pluginWorkloadCallerRef ?? 'unknown'
    let state = callers.get(callerRef)
    if (!state) {
      state = { timestamps: [], inFlight: 0 }
      callers.set(callerRef, state)
    }

    const t = now()
    state.timestamps = state.timestamps.filter(ts => t - ts < 60_000)

    if (state.timestamps.length >= opts.maxRequestsPerMinute) {
      const err = new PluginWorkloadError(
        'quota_exceeded',
        `rate limit of ${opts.maxRequestsPerMinute} requests/minute reached`,
        false
      )
      res.status(err.httpStatus).json(err.toBody())
      return
    }
    if (state.inFlight >= opts.maxConcurrent) {
      // 503 + retryable: the caller should back off and retry (plan §5.1).
      const err = new PluginWorkloadError(
        'provider_unavailable',
        `concurrent request limit of ${opts.maxConcurrent} reached`,
        true
      )
      res.status(err.httpStatus).json(err.toBody())
      return
    }

    state.timestamps.push(t)
    state.inFlight += 1
    res.once('close', () => {
      state.inFlight = Math.max(0, state.inFlight - 1)
    })
    next()
  }
}
