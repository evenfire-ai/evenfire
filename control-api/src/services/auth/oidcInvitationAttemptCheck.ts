import { ipKeyGenerator } from 'express-rate-limit'
import { pool } from '../../db.js'
import { type RateLimitCheck, createRateLimitCheck } from '../../middleware/rateLimitMiddleware.js'
import { rootLogger } from '../../observability/logger.js'
import { type InvitationRow, getInvitationRecordByToken } from '../directory/invitationStore.js'
import { validateInvitationFlowToken } from '../invitationFlowRegistrationService.js'
import {
  MemberRegistrationMisconfiguredError,
  MemberRegistrationUnavailableError,
} from '../memberRegistrationErrors.js'
import type { OidcInvitationContext } from './oidcAccountResolution.js'

/** One overall deadline for the whole check: bucket count, hub validation and local read. */
export const OIDC_INVITATION_HUB_DEADLINE_MS = 3_000
/** Hub checks allowed per client IP per minute. */
export const OIDC_INVITATION_HUB_PER_CLIENT_PER_MINUTE = 30
/**
 * An invitation token as `/attempts` accepts it. Hub tokens are made in
 * another repository, so only printable ASCII and a length are pinned.
 */
export const OIDC_INVITATION_TOKEN_RE = /^[\x21-\x7e]{1,2048}$/

export type OidcInvitationFallback =
  | 'over_limit'
  | 'hub_refused'
  | 'hub_unavailable'
  | 'hub_deadline'
  | 'not_member_invitation'
  | 'not_pending'

export type OidcInvitationCheck =
  | Readonly<{ status: 'qualified'; context: OidcInvitationContext }>
  | Readonly<{ status: 'plain'; fallback: OidcInvitationFallback }>

export type OidcInvitationCheckInput = Readonly<{ invitationToken: string; clientIp: string }>

const logger = rootLogger.child({ component: 'oidc_profile_flow' })

/** A check's result, and the class of what the validate step threw for a refusal. */
type Settled = Readonly<{ result: OidcInvitationCheck; errorName?: string }>

function plain(fallback: OidcInvitationFallback): OidcInvitationCheck {
  return { status: 'plain', fallback }
}

/**
 * An error's class, never its message: the message can carry the invitation
 * token or the invited email. The constructor's name, because `name` can be
 * anything (pg's DatabaseError sets it to 'error').
 */
function errorClassName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : error === null ? 'null' : typeof error
}

/**
 * A hub failure: a typed availability failure, or a refusal of the token.
 * Anything else the validate step throws is a refusal too, named by its
 * class, so an unexpected throw stays visible next to a hub 4xx.
 */
function hubFailure(error: unknown): Settled {
  if (
    error instanceof MemberRegistrationUnavailableError ||
    error instanceof MemberRegistrationMisconfiguredError
  ) {
    return { result: plain('hub_unavailable') }
  }
  return { result: plain('hub_refused'), errorName: errorClassName(error) }
}

/**
 * A step that failed outside the hub. The message is never logged: it can
 * carry the invitation token or the invited email.
 */
function logStepFailure(step: 'bucket' | 'local_read', error: unknown): void {
  logger.error(
    {
      event: 'oidc_invitation_check_step_failed',
      step,
      errorName: errorClassName(error),
    },
    'OIDC invitation check step failed; the attempt starts without the invitation'
  )
}

/** The local invitation qualifies only as a pending, unexpired member invitation. */
function classifyInvitation(row: InvitationRow | null, nowMs: number): OidcInvitationCheck {
  if (!row) return plain('not_pending')
  if (row.purpose !== 'member_invitation') return plain('not_member_invitation')
  if (row.status !== 'pending' || new Date(row.expires_at).getTime() <= nowMs) {
    return plain('not_pending')
  }
  return {
    status: 'qualified',
    context: { invitationId: row.id, invitedEmail: row.email.toLowerCase() },
  }
}

/**
 * Builds the check `/attempts` runs for an invitation token: the
 * per-client-IP bucket, then the hub's validation, then the local invitation,
 * all under one deadline. Every outcome other than a pending member invitation
 * is a plain attempt with no context, never an error.
 *
 * The deadline bounds the wait on hosted enrollment but never aborts it: only
 * the validate request receives the deadline's signal (the enrollment mint is
 * shared by every caller for the domain, and a failed mint writes a backoff).
 *
 * Create it once per route set: the default bucket owns its process-memory
 * counter.
 */
export function createOidcInvitationAttemptCheck(
  deps: Readonly<{
    validate?: (
      token: string,
      signal: AbortSignal
    ) => Promise<{ email: string; invitationUuid: string }>
    readInvitation?: (invitationUuid: string) => Promise<InvitationRow | null>
    limiter?: RateLimitCheck
    deadlineMs?: number
  }> = {}
): (input: OidcInvitationCheckInput) => Promise<OidcInvitationCheck> {
  const validate =
    deps.validate ??
    ((token: string, signal: AbortSignal) =>
      validateInvitationFlowToken(token, undefined, { signal }))
  const readInvitation =
    deps.readInvitation ??
    ((invitationUuid: string) => getInvitationRecordByToken(pool, invitationUuid))
  const limiter =
    deps.limiter ??
    createRateLimitCheck({
      bucketType: 'oidc_invitation_hub_check',
      maxPerMinute: OIDC_INVITATION_HUB_PER_CLIENT_PER_MINUTE,
      onBackendUnavailable: 'process-memory',
    })
  const deadlineMs = deps.deadlineMs ?? OIDC_INVITATION_HUB_DEADLINE_MS

  /**
   * The three steps. A hub failure rejects (classified by the caller); every
   * other outcome resolves. Once the deadline has answered, no further step
   * starts: the result is dropped anyway.
   */
  async function runSteps(
    input: OidcInvitationCheckInput,
    signal: AbortSignal
  ): Promise<OidcInvitationCheck> {
    let decision: Awaited<ReturnType<RateLimitCheck>>
    try {
      decision = await limiter(
        `oidc-invitation-hub:${ipKeyGenerator(input.clientIp)}`,
        logger,
        signal
      )
    } catch (error) {
      // The limiter reports an unreachable backend as a decision, so a throw
      // is unexpected. It fails closed, with no hub call, and stays visible.
      logStepFailure('bucket', error)
      return plain('over_limit')
    }
    if (decision.outcome !== 'allowed') return plain('over_limit')
    if (signal.aborted) return plain('hub_deadline')

    const validation = await validate(input.invitationToken, signal)
    if (signal.aborted) return plain('hub_deadline')

    let row: InvitationRow | null
    try {
      row = await readInvitation(validation.invitationUuid)
    } catch (error) {
      // An invitation that can't be read can't be confirmed pending.
      logStepFailure('local_read', error)
      return plain('not_pending')
    }
    return classifyInvitation(row, Date.now())
  }

  return async function checkOidcInvitationAttempt(input) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const { result, errorName } = await new Promise<Settled>(resolve => {
        timer = setTimeout(() => {
          resolve({ result: plain('hub_deadline') })
          controller.abort()
        }, deadlineMs)
        // Both handlers are attached as the steps start. A hub failure after
        // the deadline answered is classified here and dropped (resolve has
        // no effect by then), so it is never an unhandled rejection.
        runSteps(input, controller.signal).then(
          checked => resolve({ result: checked }),
          error => resolve(hubFailure(error))
        )
      })
      if (result.status === 'plain') {
        const operational =
          result.fallback === 'hub_deadline' || result.fallback === 'hub_unavailable'
        logger[operational ? 'warn' : 'info'](
          {
            event: 'oidc_invitation_check_fell_back',
            fallback: result.fallback,
            ...(errorName === undefined ? {} : { errorName }),
          },
          'OIDC attempt starts without the invitation'
        )
      }
      return result
    } finally {
      clearTimeout(timer)
    }
  }
}
