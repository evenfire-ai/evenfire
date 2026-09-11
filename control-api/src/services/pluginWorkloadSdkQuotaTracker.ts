import { config } from '../config.js'
import {
  type PluginWorkloadSdkFamily,
  type PluginWorkloadSdkGrant,
  countRecentInvocations,
} from './pluginWorkloadSdkDb.js'

// ─── Plugin Workload SDK — quota tracker (plan §2.3, issue #348) ─────────
// Single enforcement layer per invocation: a per-minute platform rate limit
// (recipe + method, narrowed to eventType for clientNotifications), derived
// from the invocation audit trail. Defaults come from ENV-backed config
// (platform protection against control-plane DoS); a grant-level per-minute
// override still wins (decision §3.1) — it is a per-recipe fairness knob, NOT
// the platform DoS ceiling, so it is intentionally NOT clamped to the default.
// A raised override stays bounded by the grant-independent request bucket
// (CONTROL_API_PLUGIN_SDK_REQUEST_BUCKET_PER_MIN, default 600/min) + pre-auth
// limits (pluginWorkloadSdkRateLimits.ts / plugin-workload-sdk.routes.ts),
// which are the actual anti-DoS backstop.
//
// The former per-period leg (`consumeQuota`, backed by
// plugin_workload_sdk_quota_counters) was DELETED (issue #348): the deprecated
// per-run caps (maxRequestsPerRun / maxNotificationsPerRun) trapped stepless
// recipes in an immortal epoch-sentinel bucket and are now ignored. Deleting
// the function (not stubbing it) makes any future caller a compile error.

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
 * Read-only per-minute rate check against the invocation audit trail. The
 * invocation row is recorded before this runs (record-first), so the trailing
 * 60s window count includes the current call and the deny threshold is
 * `recent > limit` (issue #348 removed the per-run/period-quota leg).
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
      ? (grant.quotaLimits.maxInvocationsPerMinute ?? config.pluginSdkPromptBridgeRlPerMin)
      : (grant.quotaLimits.maxNotificationsPerMinute ?? config.pluginSdkNotificationsRlPerMin)
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
