import {
  PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD,
  type PluginWorkloadSdkFamily,
  type PluginWorkloadSdkGrant,
  consumePeriodQuota,
  countRecentInvocations,
  resolveQuotaPeriodStart,
} from './pluginWorkloadSdkDb.js'

// ─── Plugin Workload SDK — quota tracker (plan §2.3) ─────────────────────
// Two enforcement layers per invocation:
//   1. Per-minute rate limit (recipe + method, narrowed to eventType for
//      clientNotifications) — derived from the invocation audit trail.
//   2. Per-period quota (maxRequestsPerRun / maxNotificationsPerRun) —
//      atomic conditional increment on plugin_workload_sdk_quota_counters,
//      bucketed by active workflow run (or eager sentinel when no run).

const DEFAULT_MAX_INVOCATIONS_PER_MINUTE = 60
const DEFAULT_MAX_NOTIFICATIONS_PER_MINUTE = 120

export type QuotaDecision =
  | { ok: true }
  | { ok: false; error: 'quota_exceeded'; retryable: false; message: string }

const exceeded = (message: string): QuotaDecision => ({
  ok: false,
  error: 'quota_exceeded',
  retryable: false,
  message,
})

/**
 * Read-only rate check — call BEFORE recording the invocation so a denied
 * call never consumes the idempotency key or a period quota unit.
 */
export async function checkRateLimit(
  recipeNamespace: string,
  recipeName: string,
  family: PluginWorkloadSdkFamily,
  grant: PluginWorkloadSdkGrant,
  opts: { eventType?: string } = {}
): Promise<QuotaDecision> {
  const limit =
    family === 'promptBridge'
      ? (grant.quotaLimits.maxInvocationsPerMinute ?? DEFAULT_MAX_INVOCATIONS_PER_MINUTE)
      : (grant.quotaLimits.maxNotificationsPerMinute ?? DEFAULT_MAX_NOTIFICATIONS_PER_MINUTE)
  // The audit record for THIS invocation is inserted before the rate check, so
  // `recent` already counts the current in-progress call. Deny only once the
  // window EXCEEDS the limit (`> limit`, not `>= limit`) so exactly `limit`
  // invocations succeed per minute; otherwise the effective ceiling would be
  // limit-1 (the limit-th call would count itself and be rejected).
  const recent = await countRecentInvocations(recipeNamespace, recipeName, family, {
    detail: family === 'clientNotifications' ? opts.eventType : undefined,
  })
  if (recent > limit) {
    return exceeded(`rate limit of ${limit}/minute reached for ${family}`)
  }
  return { ok: true }
}

/**
 * Atomically consume one unit of period quota. No-op success when the grant
 * declares no per-run cap for the family.
 */
export async function consumeQuota(
  recipeNamespace: string,
  recipeName: string,
  family: PluginWorkloadSdkFamily,
  grant: PluginWorkloadSdkGrant
): Promise<QuotaDecision> {
  const limit =
    family === 'promptBridge'
      ? grant.quotaLimits.maxRequestsPerRun
      : grant.quotaLimits.maxNotificationsPerRun
  if (limit === undefined) return { ok: true }
  const periodStart = await resolveQuotaPeriodStart(recipeNamespace, recipeName)
  // For an active run period, eager-phase usage counts against the run cap
  // (prevents 2× per-run budget). The subtraction is now folded INTO the
  // atomic consumePeriodQuota statement (foldEagerUsage), so there is no
  // read-then-consume TOCTOU: concurrent run-period consumers cannot both
  // pass a budget the eager usage already exhausted.
  const foldEagerUsage = periodStart.getTime() !== PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD.getTime()
  const consumed = await consumePeriodQuota(
    recipeNamespace,
    recipeName,
    family,
    limit,
    periodStart,
    foldEagerUsage
  )
  if (!consumed) {
    return exceeded(`period quota of ${limit} reached for ${family}`)
  }
  return { ok: true }
}
