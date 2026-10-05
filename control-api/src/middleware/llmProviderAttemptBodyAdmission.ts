import type { Request, RequestHandler, Response } from 'express'
import { type Logger, rootLogger } from '../observability/logger.js'
import type { McpHostAccessClaims } from '../utils/auth/mcpHostJwtToken.js'

export type AuthorizeBodyAdmissionPolicy = Readonly<{
  maxInFlight: number
  maxQueued: number
  maxPerPrincipal: number
  queueWaitMs: number
  readDeadlineMs: number
  workDeadlineMs: number
  closeGraceMs: number
}>

// The route supplies these claims only after requireMcpHostJwt succeeds.
// Neither body fields nor unverified headers supply admission identity.
export type AuthorizeBodyAdmissionPrincipal = Readonly<
  Pick<McpHostAccessClaims, 'sub' | 'hostRefs'>
>

type AdmissionWaiter = { grant: () => void }
type AdmissionRefusal = 'principal_share' | 'queue_full' | 'queue_wait'

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
 * The route decides which requests are charged (`run`) and which are not
 * (`runUncharged`). Every charged request costs the same full retained-body
 * unit whatever its Content-Length, so chunked bodies stay accepted and
 * framing stays with Node/body-parser. Both paths keep the read deadline, the
 * work deadline and disconnect cancellation.
 */
export class AuthorizeBodyAdmission {
  private inFlight = 0
  private readonly waiters: AdmissionWaiter[] = []
  private readonly principalUse = new Map<string, number>()
  private draining = false
  private readonly policy: AuthorizeBodyAdmissionPolicy

  constructor(policy: AuthorizeBodyAdmissionPolicy) {
    if (!Number.isSafeInteger(policy.maxInFlight) || policy.maxInFlight <= 0) {
      throw new TypeError('maxInFlight must be a positive safe integer')
    }
    if (!Number.isSafeInteger(policy.maxQueued) || policy.maxQueued < 0) {
      throw new TypeError('maxQueued must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(policy.maxPerPrincipal) || policy.maxPerPrincipal <= 0) {
      throw new TypeError('maxPerPrincipal must be a positive safe integer')
    }
    for (const value of [
      policy.queueWaitMs,
      policy.readDeadlineMs,
      policy.workDeadlineMs,
      policy.closeGraceMs,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new TypeError('authorize timers must be positive signed-32-bit integers')
      }
    }
    this.policy = Object.freeze({
      maxInFlight: policy.maxInFlight,
      maxQueued: policy.maxQueued,
      maxPerPrincipal: policy.maxPerPrincipal,
      queueWaitMs: policy.queueWaitMs,
      readDeadlineMs: policy.readDeadlineMs,
      workDeadlineMs: policy.workDeadlineMs,
      closeGraceMs: policy.closeGraceMs,
    })
  }

  tryAcquire(principal: AuthorizeBodyAdmissionPrincipal): (() => void) | null {
    const key = principalKey(principal)
    // Reserve released units for existing waiters synchronously. An arrival
    // cannot jump the FIFO while a granted waiter is awaiting its continuation.
    if (
      this.waiters.length > 0 ||
      this.inFlight >= this.policy.maxInFlight ||
      (this.principalUse.get(key) ?? 0) >= this.policy.maxPerPrincipal
    )
      return null
    this.retainPrincipal(key)
    this.inFlight += 1
    return this.releaseOwner(key)
  }

  private releaseOwner(key: string): () => void {
    let held = true
    return () => {
      if (!held) return
      held = false
      this.inFlight -= 1
      this.releasePrincipal(key)
      this.drainWaiters()
    }
  }

  snapshot(): Readonly<{ inFlight: number; queued: number; principals: number }> {
    return {
      inFlight: this.inFlight,
      queued: this.waiters.length,
      principals: this.principalUse.size,
    }
  }

  async run(
    req: Request,
    res: Response,
    parser: RequestHandler,
    work: (signal: AbortSignal) => Promise<void>,
    principal: AuthorizeBodyAdmissionPrincipal
  ): Promise<void> {
    const release = await this.waitForBodyOwner(req, res, principal)
    if (!release) return
    await this.runOwned(req, res, parser, work, release)
  }

  // For bodies the route has bounded below the retained-body unit. They take
  // no unit and never queue; the parser's own limit bounds what they retain.
  async runUncharged(
    req: Request,
    res: Response,
    parser: RequestHandler,
    work: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    if (cannotStartBodyRead(req, res)) return
    await this.runOwned(req, res, parser, work, () => {})
  }

  private async runOwned(
    req: Request,
    res: Response,
    parser: RequestHandler,
    work: (signal: AbortSignal) => Promise<void>,
    release: () => void
  ): Promise<void> {
    try {
      // A waiter may disconnect after a grant but before this continuation.
      // It must unwind the granted unit without ever installing a body reader.
      if (cannotStartBodyRead(req, res)) {
        if (!req.destroyed) req.destroy()
        return
      }
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

  private async waitForBodyOwner(
    req: Request,
    res: Response,
    principal: AuthorizeBodyAdmissionPrincipal
  ): Promise<(() => void) | null> {
    if (cannotStartBodyRead(req, res)) return null
    const release = this.tryAcquire(principal)
    if (release) return release

    const key = principalKey(principal)
    if ((this.principalUse.get(key) ?? 0) >= this.policy.maxPerPrincipal) {
      this.refuseBeforeRead(req, res, 'principal_share')
      return null
    }
    if (this.waiters.length >= this.policy.maxQueued) {
      this.refuseBeforeRead(req, res, 'queue_full')
      return null
    }

    req.pause()
    this.retainPrincipal(key)
    const deadline = performance.now() + this.policy.queueWaitMs
    return new Promise((resolve, reject) => {
      let pending = true
      let waitTimer: ReturnType<typeof setTimeout> | undefined
      const finishWaiting = (): boolean => {
        if (!pending) return false
        pending = false
        if (waitTimer !== undefined) clearTimeout(waitTimer)
        req.off('aborted', abortWaiting)
        res.off('close', closeWaiting)
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) this.waiters.splice(index, 1)
        return true
      }
      const cancelWaiting = (reason: 'aborted' | 'queue_wait'): void => {
        if (!finishWaiting()) return
        this.releasePrincipal(key)
        try {
          if (reason === 'queue_wait') this.refuseBeforeRead(req, res, reason)
          else if (!req.destroyed) req.destroy()
          resolve(null)
        } catch (err) {
          reject(err)
        } finally {
          this.drainWaiters()
        }
      }
      const abortWaiting = (): void => cancelWaiting('aborted')
      const closeWaiting = (): void => {
        if (!res.writableFinished) abortWaiting()
      }
      const waiter: AdmissionWaiter = {
        grant: () => {
          if (!pending) return
          if (cannotStartBodyRead(req, res)) {
            abortWaiting()
            return
          }
          // Timers can run late under load. A release cannot revive an
          // already expired waiter before its timer callback is delivered.
          if (performance.now() >= deadline) {
            cancelWaiting('queue_wait')
            return
          }
          if (!finishWaiting()) return
          this.inFlight += 1
          // The principal already owns this queued share: transfer it to
          // running rather than charging twice or briefly returning it.
          resolve(this.releaseOwner(key))
        },
      }
      this.waiters.push(waiter)
      req.once('aborted', abortWaiting)
      res.once('close', closeWaiting)
      waitTimer = setTimeout(() => cancelWaiting('queue_wait'), this.policy.queueWaitMs)
      if (cannotStartBodyRead(req, res)) abortWaiting()
    })
  }

  private retainPrincipal(key: string): void {
    this.principalUse.set(key, (this.principalUse.get(key) ?? 0) + 1)
  }

  private releasePrincipal(key: string): void {
    const remaining = (this.principalUse.get(key) ?? 0) - 1
    if (remaining === 0) this.principalUse.delete(key)
    else this.principalUse.set(key, remaining)
  }

  private drainWaiters(): void {
    if (this.draining) return
    this.draining = true
    try {
      while (this.inFlight < this.policy.maxInFlight && this.waiters.length > 0) {
        this.waiters[0].grant()
      }
    } finally {
      this.draining = false
    }
  }

  private refuseBeforeRead(req: Request, res: Response, refusal: AdmissionRefusal): void {
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
        refusal,
        inFlight,
        maxInFlight: this.policy.maxInFlight,
        queued: this.waiters.length,
        maxQueued: this.policy.maxQueued,
        maxPerPrincipal: this.policy.maxPerPrincipal,
        queueWaitMs: this.policy.queueWaitMs,
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

function principalKey(principal: AuthorizeBodyAdmissionPrincipal): string {
  return JSON.stringify([principal.sub, [...new Set(principal.hostRefs)].sort()])
}

// A request stream auto-destroys once its body has been read to the end, so
// `destroyed` means a disconnect only while the body is still unread. An
// already-read body goes to the parser, which skips it.
function cannotStartBodyRead(req: Request, res: Response): boolean {
  return req.aborted || (req.destroyed && !req.readableEnded) || res.destroyed || res.writableEnded
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
      // A queued IncomingMessage was explicitly paused. Resume only after
      // the admitted parser has installed its body reader, never on grant.
      if (!settled && !readStopped) req.resume()
    } catch (err) {
      finish(err)
    }
  })
}
