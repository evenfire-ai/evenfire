import type { Request, RequestHandler, Response } from 'express'
import { type Logger, rootLogger } from '../observability/logger.js'

export type AuthorizeBodyAdmissionPolicy = Readonly<{
  maxInFlight: number
  readDeadlineMs: number
  workDeadlineMs: number
  closeGraceMs: number
}>

export class AuthorizeWorkInterrupted extends Error {
  constructor(readonly code: 'authorize_timeout' | 'authorize_aborted') {
    super(code)
    this.name = 'AuthorizeWorkInterrupted'
  }
}

type ParserError = {
  type?: unknown
  status?: unknown
  body?: unknown
}

const MAX_TIMER_DELAY_MS = 2_147_483_647
const LOG_MODULE = 'llm-provider-attempt-body-admission'
const log = rootLogger.child({ module: LOG_MODULE })

/**
 * Owns one full permitted authorize body from before parsing until both the
 * parser callback and the signal-aware authorize work have unwound.
 *
 * The count is deliberately not based on Content-Length: chunked bodies remain
 * accepted, framing is enforced by Node/body-parser, and every admitted
 * request is charged the same full retained-body unit.
 */
export class AuthorizeBodyAdmission {
  private inFlight = 0
  private readonly policy: AuthorizeBodyAdmissionPolicy

  constructor(policy: AuthorizeBodyAdmissionPolicy) {
    if (!Number.isSafeInteger(policy.maxInFlight) || policy.maxInFlight <= 0) {
      throw new TypeError('maxInFlight must be a positive safe integer')
    }
    for (const value of [policy.readDeadlineMs, policy.workDeadlineMs, policy.closeGraceMs]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new TypeError('authorize timers must be positive signed-32-bit integers')
      }
    }
    this.policy = Object.freeze({
      maxInFlight: policy.maxInFlight,
      readDeadlineMs: policy.readDeadlineMs,
      workDeadlineMs: policy.workDeadlineMs,
      closeGraceMs: policy.closeGraceMs,
    })
  }

  tryAcquire(): (() => void) | null {
    if (this.inFlight >= this.policy.maxInFlight) return null
    this.inFlight += 1
    let held = true
    return () => {
      if (!held) return
      held = false
      this.inFlight -= 1
    }
  }

  snapshot(): Readonly<{ inFlight: number }> {
    return { inFlight: this.inFlight }
  }

  async run(
    req: Request,
    res: Response,
    parser: RequestHandler,
    work: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    const release = this.tryAcquire()
    if (!release) {
      this.refuseBeforeRead(req, res)
      return
    }

    try {
      await parseToCompletion(req, res, parser, this.policy)
      if (req.aborted || res.destroyed || res.writableEnded) return

      const cancellation = new AbortController()
      const abortDisconnected = (): void => {
        if (!res.writableFinished) {
          cancellation.abort(new AuthorizeWorkInterrupted('authorize_aborted'))
        }
      }
      res.once('close', abortDisconnected)
      const workTimer = setTimeout(() => {
        cancellation.abort(new AuthorizeWorkInterrupted('authorize_timeout'))
      }, this.policy.workDeadlineMs)

      try {
        // Work must wire this signal to real dependency termination. Its
        // promise includes transaction unwind and producer disposal.
        await work(cancellation.signal)
        cancellation.signal.throwIfAborted()
      } catch (err) {
        if (cancellation.signal.aborted) throw cancellation.signal.reason
        throw err
      } finally {
        clearTimeout(workTimer)
        res.off('close', abortDisconnected)
      }
    } finally {
      req.body = undefined
      release()
    }
  }

  private refuseBeforeRead(req: Request, res: Response): void {
    const inFlight = this.inFlight
    req.pause()
    let stopped = false
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    const stopRejectedBody = (): void => {
      if (stopped) return
      stopped = true
      if (closeTimer !== undefined) clearTimeout(closeTimer)
      res.off('finish', stopRejectedBody)
      res.off('close', stopRejectedBody)
      if (!req.destroyed) req.destroy()
    }
    // A blocked or pipelined peer can leave the 503 response unable to reach
    // finish/close. The unread request body still needs a bounded stop.
    closeTimer = setTimeout(stopRejectedBody, this.policy.closeGraceMs)
    res.once('finish', stopRejectedBody)
    res.once('close', stopRejectedBody)
    res.setHeader('Connection', 'close')
    requestLog(req).warn(
      {
        event: 'llm_provider_attempt_admission_refused',
        reason: 'authorize_capacity_exceeded',
        inFlight,
        maxInFlight: this.policy.maxInFlight,
      },
      'authorize admission refused before body read'
    )
    try {
      res.status(503).json({ error: 'authorize_capacity_exceeded' })
    } catch (err) {
      stopRejectedBody()
      throw err
    }
  }
}

function removeParserBody(err: unknown): void {
  if (err && typeof err === 'object' && 'body' in err) {
    delete (err as ParserError).body
  }
}

function parserErrorRequiresConnectionClose(err: unknown): boolean {
  const typed = err as ParserError
  return typed?.type === 'entity.too.large' || typed?.status === 413
}

function requestLog(req: Request): Logger {
  return req.log?.child({ module: LOG_MODULE }) ?? log
}

function parseToCompletion(
  req: Request,
  res: Response,
  parser: RequestHandler,
  policy: AuthorizeBodyAdmissionPolicy
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timedOut = false
    let settled = false
    let readStopped = false
    let closeBackstop: ReturnType<typeof setTimeout> | undefined

    const stopRead = (): void => {
      if (readStopped) return
      readStopped = true
      req.destroy()
    }
    const stopDisconnected = (): void => {
      if (!res.writableFinished) stopRead()
    }
    res.once('close', stopDisconnected)

    const timer = setTimeout(() => {
      timedOut = true
      requestLog(req).warn(
        {
          event: 'llm_provider_attempt_body_refused',
          reason: 'read_deadline',
          closeGraceMs: policy.closeGraceMs,
        },
        'authorize body read deadline exceeded'
      )
      // This backstop is independent of response finish. A peer that never
      // reads the 408 must not leave the body reader charged indefinitely.
      closeBackstop = setTimeout(stopRead, policy.closeGraceMs)
      res.once('finish', stopRead)
      if (res.destroyed || res.writableEnded || res.headersSent) {
        stopRead()
        return
      }
      try {
        res.setHeader('Connection', 'close')
        res.status(408).json({ error: 'request_timeout' })
      } catch {
        stopRead()
      }
    }, policy.readDeadlineMs)

    const finish = (err?: unknown): void => {
      removeParserBody(err)
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (closeBackstop !== undefined) clearTimeout(closeBackstop)
      res.off('finish', stopRead)
      res.off('close', stopDisconnected)
      if (!timedOut && err && parserErrorRequiresConnectionClose(err) && !res.headersSent) {
        res.setHeader('Connection', 'close')
      }
      // Capacity remains charged until this callback proves parser unwind.
      if (timedOut) resolve()
      else if (err) reject(err)
      else resolve()
    }

    try {
      parser(req, res, finish)
    } catch (err) {
      finish(err)
    }
  })
}
