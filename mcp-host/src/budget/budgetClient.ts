import type { Task } from '../queue/types'
import type {
  BudgetCheckRequest,
  BudgetReleaseRequest,
  BudgetReleaseResult,
  BudgetSourceKind,
  BudgetVerdict,
} from './types'

/** Default per-check timeout. Short on purpose — the check is fail-open, so a
 *  slow control-api must not stall the task that triggered it. */
const DEFAULT_TIMEOUT_MS = 2000

export interface BudgetClientOptions {
  /**
   * control-api base URL reached through the workflow-approval gateway — the
   * SAME `McpHostRuntimeAuth.baseUrl` the UsageReporter posts
   * `/internal/usage/llm/events` to. The budget check guard (`requireMcpHostJwt`)
   * is the same middleware, so the bearer + base URL are identical.
   */
  baseUrl: string
  /** Reads the current shared runtime access JWT fresh on every call so a
   *  refresh-on-401 mutation on the shared auth propagates. */
  getAccessToken: () => string
  /**
   * Optional: triggered once when a check returns 401, so the NEXT task's check
   * uses a refreshed token. The current task still fails open (§0.2).
   */
  refreshOnUnauthorized?: () => Promise<void>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Thin client for `POST /api/v1/internal/budgets/check` (Phase P1, §5.1).
 *
 * **Fail-open invariant (§0.2):** every failure path — fetch throw, timeout,
 * non-200, malformed body — resolves to `{ allowed: true }` plus a structured
 * `budget_check_failed` warn. A budget is cost control, not a security boundary;
 * it must NEVER block a task because the check itself broke.
 *
 * **401 retry (bypass fix):** a 401 usually means the runtime token just rotated.
 * The client refreshes and RETRIES the request ONCE with the fresh token before
 * failing open — a plain fail-open on 401 would let a task escape an exceeded
 * budget every time the token rotates (the 401'd check would have been a deny).
 */
export class BudgetClient {
  private readonly url: string
  private readonly releaseUrl: string
  private readonly getAccessToken: () => string
  private readonly refreshOnUnauthorized: (() => Promise<void>) | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: BudgetClientOptions) {
    const base = opts.baseUrl.replace(/\/+$/, '')
    this.url = `${base}/api/v1/internal/budgets/check`
    this.releaseUrl = `${base}/api/v1/internal/budgets/release`
    this.getAccessToken = opts.getAccessToken
    this.refreshOnUnauthorized = opts.refreshOnUnauthorized
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async check(request: BudgetCheckRequest): Promise<BudgetVerdict> {
    try {
      let res = await this.post(this.url, request)

      // On 401 the runtime token likely just rotated/expired. Refresh and RETRY
      // ONCE with the fresh token before failing open — otherwise a token
      // rotation lets a task escape the budget (the 401'd check would otherwise
      // have been a real deny; fail-open on it is a budget bypass, not just a
      // delayed enforcement). `getAccessToken()` is read fresh inside `post`, so
      // the retry carries the refreshed token.
      if (res.status === 401 && this.refreshOnUnauthorized) {
        await this.refreshOnUnauthorized().catch(() => undefined)
        res = await this.post(this.url, request)
      }

      if (!res.ok) {
        this.warn(request, res.status === 401 ? 'unauthorized' : 'non_200', { status: res.status })
        return { allowed: true }
      }

      const data = (await res.json()) as BudgetVerdict
      if (typeof data?.allowed !== 'boolean') {
        this.warn(request, 'malformed_response')
        return { allowed: true }
      }
      return data
    } catch (err) {
      // Covers network errors, DNS failures, and AbortSignal.timeout aborts.
      this.warn(request, 'fetch_error', {
        error: err instanceof Error ? err.message : String(err),
      })
      return { allowed: true }
    }
  }

  /** POST helper — reads the access token FRESH so a post-refresh retry uses it. */
  private post(url: string, body: unknown): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.getAccessToken()}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
  }

  /**
   * Early release of a danger-zone reservation (Phase P2b, §5.4).
   *
   * `POST /api/v1/internal/budgets/release` with the same bearer + base URL +
   * timeout as `check`. Same **fail-open invariant**: every failure path resolves
   * to `{ released: 0 }` plus a `budget_release_failed` warn and NEVER throws — a
   * lost release just means the reservation self-expires by its control-api TTL.
   * The caller fires this without awaiting on the task's critical path, so it can
   * never delay task termination.
   */
  async release(request: BudgetReleaseRequest): Promise<BudgetReleaseResult> {
    try {
      let res = await this.post(this.releaseUrl, request)

      // Same 401 → refresh + retry-once as `check` (token rotation), so a rotation
      // doesn't leave a reservation held until its TTL.
      if (res.status === 401 && this.refreshOnUnauthorized) {
        await this.refreshOnUnauthorized().catch(() => undefined)
        res = await this.post(this.releaseUrl, request)
      }

      if (!res.ok) {
        this.warnRelease(request, res.status === 401 ? 'unauthorized' : 'non_200', {
          status: res.status,
        })
        return { released: 0 }
      }

      const data = (await res.json()) as BudgetReleaseResult
      if (typeof data?.released !== 'number') {
        this.warnRelease(request, 'malformed_response')
        return { released: 0 }
      }
      return data
    } catch (err) {
      // Covers network errors, DNS failures, and AbortSignal.timeout aborts.
      this.warnRelease(request, 'fetch_error', {
        error: err instanceof Error ? err.message : String(err),
      })
      return { released: 0 }
    }
  }

  private warn(request: BudgetCheckRequest, reason: string, extra?: Record<string, unknown>): void {
    console.warn('[BudgetClient] budget_check_failed', {
      reason,
      host_ref: request.host_ref,
      source_kind: request.source_kind,
      ...extra,
    })
  }

  private warnRelease(
    request: BudgetReleaseRequest,
    reason: string,
    extra?: Record<string, unknown>
  ): void {
    console.warn('[BudgetClient] budget_release_failed', {
      reason,
      task_ref: request.task_ref ?? null,
      reservationId: request.reservationId ?? null,
      ...extra,
    })
  }
}

/**
 * Derive the budget attribution dimensions from a Task. Mirrors
 * `TaskExecutor.buildDefaultUsageContext` (taskExecutor.ts) so budget scope
 * matching lines up with what `usage_events` records:
 * - channel + rpc → `desktop`, user_id = sender, team_id from metadata
 * - channel (third-party) → `channel`; control-api resolves team/user via context
 * - cron → `cron` + cron_job_id
 * - internal → `desktop`
 * Workflow LLM calls go through workflowService and are tagged there (P3).
 */
export function deriveBudgetAttribution(task: Task): {
  source_kind: BudgetSourceKind
  user_id: string | null
  team_id: string | null
  recipe_name: string | null
  cron_job_id: string | null
} {
  const base = { user_id: null, team_id: null, recipe_name: null, cron_job_id: null }

  if (task.source === 'channel') {
    if (task.sourceMessage?.channelType === 'rpc') {
      const rawTeamId = task.sourceMessage.metadata?.teamId
      const teamId = typeof rawTeamId === 'string' ? rawTeamId.trim() : ''
      return {
        ...base,
        source_kind: 'desktop',
        user_id: task.sourceMessage.sender ?? null,
        team_id: teamId || null,
      }
    }
    return { ...base, source_kind: 'channel' }
  }
  if (task.source === 'cron') {
    return { ...base, source_kind: 'cron', cron_job_id: task.cronJobId ?? null }
  }
  if (task.source === 'internal') {
    return { ...base, source_kind: 'desktop' }
  }
  return { ...base, source_kind: 'unknown' }
}
