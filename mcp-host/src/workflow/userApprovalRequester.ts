/**
 * Step-level approval gating: posts an approval request and polls until a
 * terminal status. On 401 it refreshes; on persistent refresh 401 it falls
 * back to the caller-supplied `reIssueTokens` callback for a one-shot recovery.
 */
import { createHash } from 'node:crypto'
import client, { Counter } from 'prom-client'
import { refreshRuntimeAuthFromPersistedState } from './mcpHostJwtState'
import { getJwtRuntimeBinding } from './mcpHostRuntimeJwt'
import {
  recordRuntimeAuthRecoveryFailure,
  recordRuntimeAuthRecoverySuccess,
} from './runtimeAuthHealth'

export interface ApprovalTarget {
  userId?: string
  teamId?: string
}

export interface WorkflowTriggerRunIntentPayload {
  inputs?: Record<string, unknown> | null
  intermediateParameters?: Record<string, unknown> | null
  outputOverrides?: Record<string, unknown> | null
}

export interface ApprovalGateParams {
  stepId: string
  executionId?: string
  runBindingProof?: string
  idempotencyKeyOverride?: string
  runtimeMcpHostRef?: string
  approvalRecipe?: {
    recipeNamespace: string
    recipeName: string
  }
  target: ApprovalTarget
  message: string
  payloadMetadata?: unknown
  workflowTriggerRunIntent?: WorkflowTriggerRunIntentPayload
  /** Broker-only retry opt-in for already-consumed approvals. */
  allowConsumedTerminal?: boolean
  timeoutSeconds?: number
}

export interface ReIssuedTokenPair {
  accessToken: string
  refreshToken: string
  mcpHostControlToken?: string
}

/**
 * Auth credential the mcp-host pod uses for ALL outbound calls to
 * control-api (workflow approvals, LLM usage reporting, anything else
 * added later). Holds the live access/refresh JWT pair and rotates it in
 * place on 401, so a single instance is shared across consumers in the
 * pod and refresh-on-401 mutations propagate.
 */
export interface McpHostRuntimeAuth {
  accessToken: string
  refreshToken: string
  baseUrl: string
  /** Canonical bearer identity from the runtime access JWT hostRefs[0]. */
  hostRef: string
  /** Sent in request bodies and kept aligned with the runtime access JWT claims. */
  recipeNamespace: string
  recipeName: string
  /** Live workflow-control JWT used by workflow_list/status/health/trigger broker calls. */
  mcpHostControlToken?: string
  persistRotatedTokens?: (tokens: {
    accessToken: string
    refreshToken: string
    mcpHostControlToken?: string
  }) => Promise<void>
  /** Optional re-issue callback invoked after persistent refresh 401s. */
  reIssueTokens?: () => Promise<ReIssuedTokenPair>
}

export interface ApprovalGateResult {
  approvalRequestId?: string
  status: string
  decidedBy?: unknown
  note?: string
}

type PollStatusResult =
  | { ok: true; status: string; decisionMaker?: unknown; note?: string }
  | { ok: false; reason: 'unauthorized' }

type RefreshResult = { ok: true } | { ok: false; status: number }

const POLL_INTERVAL_MS = 5_000
const POLL_JITTER_MS = 2_000
const REQUEST_RETRY_BASE_MS = 750
const REQUEST_RETRY_JITTER_MS = 250
const REQUEST_MAX_ATTEMPTS = 3
const POLL_MAX_ATTEMPTS = 3
const TERMINAL_STATUSES = new Set(['approved', 'denied', 'expired', 'cancelled', 'consumed'])

const REFRESH_MAX_ATTEMPTS = 3
const REFRESH_BACKOFF_MS = [1_000, 2_000, 4_000]
/** Consecutive 401s on refresh that triggers re-issue. */
const REFRESH_CONSECUTIVE_401_THRESHOLD = 2

function getOrCreateCounter<Label extends string>(options: {
  name: string
  help: string
  labelNames: readonly Label[]
}): Counter<Label> {
  const existing = client.register.getSingleMetric(options.name)
  if (existing) return existing as Counter<Label>
  return new Counter<Label>({
    name: options.name,
    help: options.help,
    labelNames: options.labelNames as Label[],
  })
}

export const refreshFailureCounter = getOrCreateCounter({
  name: 'workflow_auth_refresh_failures_total',
  help: 'Total refresh attempts that returned a non-2xx status',
  labelNames: ['status'] as const,
})

export const reIssueCounter = getOrCreateCounter({
  name: 'workflow_auth_reissue_attempts_total',
  help: 'Total re-issue attempts triggered by persistent refresh 401s',
  labelNames: ['result'] as const,
})

export const workflowTokenRefreshCounter = getOrCreateCounter({
  name: 'workflow_token_refresh_total',
  help: 'Total workflow runtime token refresh attempts',
  labelNames: ['recipe', 'outcome'] as const,
})

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 500 && status < 600)
}

function retryDelayMs(attempt: number): number {
  return REQUEST_RETRY_BASE_MS * attempt + Math.random() * REQUEST_RETRY_JITTER_MS
}

async function approvalErrorCodeFromResponse(res: Response): Promise<string | undefined> {
  const json = (res as { json?: () => Promise<unknown> }).json
  if (typeof json !== 'function') return undefined
  try {
    const data = await json.call(res)
    if (!data || typeof data !== 'object') return undefined
    const record = data as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.code === 'string') return record.code
  } catch {
    return undefined
  }
  return undefined
}

function recipeLabel(auth: McpHostRuntimeAuth): string {
  return auth.recipeName ?? '<unknown>'
}

function reloadPersistedAuthIfAvailable(auth: McpHostRuntimeAuth): boolean {
  if (!refreshRuntimeAuthFromPersistedState(auth)) {
    return false
  }
  workflowTokenRefreshCounter.inc({
    recipe: auth.recipeName ?? '<unknown>',
    outcome: 'loaded_from_state',
  })
  return true
}

/** Mutex (per auth identity) so concurrent callers share one re-issue. */
const inflightReIssues = new WeakMap<McpHostRuntimeAuth, Promise<void>>()
const inflightRefreshes = new WeakMap<McpHostRuntimeAuth, Promise<void>>()

function approvalPayloadMetadata(params: ApprovalGateParams): unknown {
  if (!params.runtimeMcpHostRef) return params.payloadMetadata
  const existing =
    params.payloadMetadata &&
    typeof params.payloadMetadata === 'object' &&
    !Array.isArray(params.payloadMetadata)
      ? (params.payloadMetadata as Record<string, unknown>)
      : {}
  return {
    ...existing,
    runtimeMcpHostRef: params.runtimeMcpHostRef,
  }
}

/** Mutates `auth` on success; returns `{ ok: false, status }` without throwing. */
async function attemptRefresh(auth: McpHostRuntimeAuth): Promise<RefreshResult> {
  const url = `${auth.baseUrl}/api/v1/workflow-auth/refresh`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.refreshToken}`,
      },
    })
  } catch (err) {
    // Synthetic 0 status so callers treat network errors as transient.
    workflowTokenRefreshCounter.inc({ recipe: auth.recipeName ?? '<unknown>', outcome: 'failed' })
    return { ok: false, status: 0 }
  }

  if (!res.ok) {
    refreshFailureCounter.inc({ status: String(res.status) })
    workflowTokenRefreshCounter.inc({ recipe: auth.recipeName ?? '<unknown>', outcome: 'failed' })
    return { ok: false, status: res.status }
  }

  const data = (await res.json()) as {
    accessToken?: string
    refreshToken?: string
    mcpHostControlToken?: string
    expiresInSeconds?: number
  }
  if (!data.accessToken) {
    throw new Error('Token refresh response missing accessToken')
  }
  if (!data.refreshToken) {
    throw new Error('Token refresh response missing refreshToken')
  }

  auth.accessToken = data.accessToken
  auth.refreshToken = data.refreshToken
  if (typeof data.mcpHostControlToken === 'string' && data.mcpHostControlToken.trim()) {
    auth.mcpHostControlToken = data.mcpHostControlToken
  }
  const binding = getJwtRuntimeBinding(data.accessToken)
  if (!binding) {
    throw new Error('Refreshed runtime access token missing canonical mcp-host binding claims')
  }
  Object.assign(auth, binding)
  if (auth.persistRotatedTokens) {
    try {
      await auth.persistRotatedTokens({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        ...(auth.mcpHostControlToken ? { mcpHostControlToken: auth.mcpHostControlToken } : {}),
      })
    } catch (err) {
      console.warn(
        '[UserApprovalRequester] Failed to persist rotated approval tokens:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  workflowTokenRefreshCounter.inc({ recipe: auth.recipeName ?? '<unknown>', outcome: 'succeeded' })
  return { ok: true }
}

/** Recovery path. Mutex'd so concurrent refresh failures share one /issue call. */
async function recoverTokenPair(auth: McpHostRuntimeAuth): Promise<void> {
  const inflight = inflightReIssues.get(auth)
  if (inflight) {
    await inflight
    return
  }

  if (!auth.reIssueTokens) {
    throw new Error(
      'Approval refresh persistently returned 401 and no reIssueTokens recovery callback is configured'
    )
  }

  const reIssuer = auth.reIssueTokens

  const job = (async () => {
    try {
      console.info(
        `[UserApprovalRequester] Token pair re-issue requested (recipe=${recipeLabel(auth)})`
      )
      const newPair = await reIssuer()
      if (!newPair?.accessToken || !newPair?.refreshToken) {
        throw new Error('reIssueTokens returned an empty or invalid token pair')
      }
      auth.accessToken = newPair.accessToken
      auth.refreshToken = newPair.refreshToken
      if (typeof newPair.mcpHostControlToken === 'string' && newPair.mcpHostControlToken.trim()) {
        auth.mcpHostControlToken = newPair.mcpHostControlToken
      }
      const binding = getJwtRuntimeBinding(newPair.accessToken)
      if (!binding) {
        throw new Error('Re-issued runtime access token missing canonical mcp-host binding claims')
      }
      Object.assign(auth, binding)
      if (auth.persistRotatedTokens) {
        try {
          await auth.persistRotatedTokens({
            accessToken: newPair.accessToken,
            refreshToken: newPair.refreshToken,
            ...(auth.mcpHostControlToken ? { mcpHostControlToken: auth.mcpHostControlToken } : {}),
          })
        } catch (err) {
          console.warn(
            '[UserApprovalRequester] Failed to persist re-issued approval tokens:',
            err instanceof Error ? err.message : String(err)
          )
        }
      }
      reIssueCounter.inc({ result: 'success' })
      console.info(
        `[UserApprovalRequester] Token pair re-issued successfully (recipe=${recipeLabel(auth)})`
      )
    } catch (err) {
      reIssueCounter.inc({ result: 'failed' })
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[UserApprovalRequester] Workflow auth re-issue failed (recipe=${recipeLabel(auth)}): ${message}`
      )
      throw err
    }
  })()

  inflightReIssues.set(auth, job)
  try {
    await job
  } finally {
    if (inflightReIssues.get(auth) === job) {
      inflightReIssues.delete(auth)
    }
  }
}

async function refreshWithRecoveryInner(auth: McpHostRuntimeAuth): Promise<void> {
  if (reloadPersistedAuthIfAvailable(auth)) {
    return
  }

  let consecutive401 = 0
  let lastStatus: number | undefined

  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
    const result = await attemptRefresh(auth)
    if (result.ok) {
      return
    }

    lastStatus = result.status

    if (result.status === 401) {
      if (reloadPersistedAuthIfAvailable(auth)) {
        return
      }
      consecutive401 += 1
      console.warn(
        `[UserApprovalRequester] Refresh failed with 401; attempting workflow auth re-issue (recipe=${recipeLabel(auth)}, attempt=${attempt}, consecutive401=${consecutive401})`
      )
      if (consecutive401 >= REFRESH_CONSECUTIVE_401_THRESHOLD) {
        if (reloadPersistedAuthIfAvailable(auth)) {
          return
        }
        await recoverTokenPair(auth)
        return
      }
    } else {
      // Reset on non-401 so transient 5xx doesn't trigger recovery.
      consecutive401 = 0
    }

    if (attempt < REFRESH_MAX_ATTEMPTS) {
      const delay =
        REFRESH_BACKOFF_MS[attempt - 1] ?? REFRESH_BACKOFF_MS[REFRESH_BACKOFF_MS.length - 1]!
      await sleep(delay)
    }
  }

  throw new Error(
    `Token refresh failed after ${REFRESH_MAX_ATTEMPTS} attempts (last status=${lastStatus ?? 'unknown'})`
  )
}

/** Refresh with retry; escalates to recoverTokenPair on persistent 401s. */
export async function refreshWithRecovery(auth: McpHostRuntimeAuth): Promise<void> {
  const inflight = inflightRefreshes.get(auth)
  if (inflight) {
    await inflight
    return
  }

  const job = (async () => {
    try {
      await refreshWithRecoveryInner(auth)
      recordRuntimeAuthRecoverySuccess()
    } catch (err) {
      recordRuntimeAuthRecoveryFailure('refresh_recovery_failed')
      throw err
    }
  })()

  inflightRefreshes.set(auth, job)
  try {
    await job
  } finally {
    if (inflightRefreshes.get(auth) === job) {
      inflightRefreshes.delete(auth)
    }
  }
}

async function requestApproval(
  params: ApprovalGateParams,
  auth: McpHostRuntimeAuth
): Promise<{ id: string }> {
  const url = `${auth.baseUrl}/api/v1/workflow-approvals/request`
  // Idempotency key collapses retried POSTs within one execution.
  const idempotencyKey =
    params.idempotencyKeyOverride?.trim() ||
    createHash('sha256')
      .update(
        `${params.executionId ?? ''}:${params.stepId}:${params.target.userId ?? ''}:${params.target.teamId ?? ''}:${params.message}`
      )
      .digest('hex')

  // At most one post-recovery retry; otherwise propagate to avoid 401 loops.
  let refreshedAfterUnauthorized = false

  for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        // Default to the token recipe binding. Trigger-bound workflow approvals
        // may override this with the target recipe; control-api still validates
        // the typed workflowTrigger intent and caller binding before accepting it.
        recipeNamespace: params.approvalRecipe?.recipeNamespace ?? auth.recipeNamespace,
        recipeName: params.approvalRecipe?.recipeName ?? auth.recipeName,
        target: params.target,
        payload: {
          message: params.message,
          ...(params.payloadMetadata !== undefined || params.runtimeMcpHostRef
            ? { metadata: approvalPayloadMetadata(params) }
            : {}),
        },
        ...(params.timeoutSeconds ? { ttlSeconds: params.timeoutSeconds } : {}),
        ...(params.workflowTriggerRunIntent
          ? { workflowTriggerRunIntent: params.workflowTriggerRunIntent }
          : {}),
        ...(params.executionId
          ? { correlation: { taskId: params.executionId, stepId: params.stepId } }
          : { correlation: { stepId: params.stepId } }),
        ...(params.runBindingProof ? { workflowRunBindingProof: params.runBindingProof } : {}),
      }),
    })

    if (res.status === 401 && !refreshedAfterUnauthorized) {
      await refreshWithRecovery(auth)
      refreshedAfterUnauthorized = true
      continue
    }

    if (res.status === 409) {
      const data = (await res.json().catch(() => ({}))) as {
        approvalRequestId?: string
        status?: string
        error?: string
      }
      if (
        params.runBindingProof &&
        data.error === 'workflow_approval_run_binding_invalid' &&
        attempt < REQUEST_MAX_ATTEMPTS
      ) {
        await sleep(retryDelayMs(attempt))
        continue
      }
      if (!data.approvalRequestId) {
        throw new Error(
          data.error === 'workflow_approval_run_binding_invalid'
            ? 'Approval request failed (409)'
            : 'Approval request conflict response missing approvalRequestId'
        )
      }
      return { id: data.approvalRequestId }
    }

    if (!res.ok) {
      if (isRetryableStatus(res.status) && attempt < REQUEST_MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt))
        continue
      }
      const errorCode = await approvalErrorCodeFromResponse(res)
      if (res.status === 422 && errorCode === 'idempotency_key_payload_mismatch') {
        throw new Error(
          'Workflow approval request conflicted with an earlier trigger attempt. Send the workflow request again as a new channel message, or change the workflow inputs.'
        )
      }
      throw new Error(`Approval request failed (${res.status})`)
    }

    const data = (await res.json()) as {
      approvalRequestId?: string
      status?: string
      expiresAt?: string
    }
    if (!data.approvalRequestId) {
      throw new Error('Approval request response missing approvalRequestId')
    }
    return { id: data.approvalRequestId }
  }

  throw new Error('Approval request failed after retry budget was exhausted')
}

async function pollStatus(
  approvalId: string,
  accessToken: string,
  baseUrl: string
): Promise<PollStatusResult> {
  const url = `${baseUrl}/api/v1/workflow-approvals/${approvalId}/status`
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    if (res.status === 401) {
      return { ok: false, reason: 'unauthorized' }
    }

    if (!res.ok) {
      if (isRetryableStatus(res.status) && attempt < POLL_MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt))
        continue
      }
      throw new Error(`Approval status poll failed (${res.status})`)
    }

    const data = (await res.json()) as {
      status: string
      expiresAt?: string
      decisionMaker?: unknown
      note?: string
    }
    return {
      ok: true,
      status: data.status,
      decisionMaker: data.decisionMaker,
      note: data.note,
    }
  }

  throw new Error(
    `Approval status poll failed after retry budget was exhausted for request ${approvalId}`
  )
}

/** Best-effort approval cancel on local timeout. Never throws. */
async function cancelApprovalSafely(approvalId: string, auth: McpHostRuntimeAuth): Promise<void> {
  try {
    const url = `${auth.baseUrl}/api/v1/workflow-approvals/${approvalId}/cancel`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      console.warn(
        `[UserApprovalRequester] Timeout cancel returned non-OK status ${res.status} for ${approvalId}`
      )
    }
  } catch (err) {
    console.warn(
      `[UserApprovalRequester] Timeout cancel failed for ${approvalId}:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

/** Polls until terminal. Throws if denied, expired, or cancelled. */
export async function gateStep(
  params: ApprovalGateParams,
  auth: McpHostRuntimeAuth
): Promise<ApprovalGateResult> {
  const deadline =
    params.timeoutSeconds != null ? Date.now() + params.timeoutSeconds * 1000 : Infinity

  const { id: approvalId } = await requestApproval(params, auth)

  // At most one recovery per gate to prevent loops on revoked auth.
  let recoveredDuringPoll = false
  while (Date.now() < deadline) {
    const result = await pollStatus(approvalId, auth.accessToken, auth.baseUrl)

    if (!result.ok) {
      if (recoveredDuringPoll) {
        throw new Error(
          `Approval poll returned 401 after token recovery (request ${approvalId}); upstream auth appears broken`
        )
      }
      await refreshWithRecovery(auth)
      recoveredDuringPoll = true
      continue
    }

    if (TERMINAL_STATUSES.has(result.status)) {
      if (
        result.status === 'approved' ||
        (result.status === 'consumed' && params.allowConsumedTerminal)
      ) {
        return {
          approvalRequestId: approvalId,
          status: result.status,
          decidedBy: result.decisionMaker,
          note: result.note,
        }
      }
      throw new Error(
        `Approval ${result.status} for step (request ${approvalId})` +
          (result.note ? `: ${result.note}` : '')
      )
    }

    await sleep(POLL_INTERVAL_MS + Math.random() * POLL_JITTER_MS)
  }

  await cancelApprovalSafely(approvalId, auth)
  throw new Error(
    `Approval polling timed out after ${params.timeoutSeconds}s for request ${approvalId}`
  )
}
