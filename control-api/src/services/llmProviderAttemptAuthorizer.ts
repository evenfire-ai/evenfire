import {
  LIMITS,
  computeCodexPolicyHash,
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import { config } from '../config.js'
import { type DbClient, pool, withTransaction } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import type { McpHostAccessClaims } from '../utils/auth/mcpHostJwtToken.js'
import { isPlainObject } from '../utils/isPlainObject.js'
import { evaluateBudgetCheck } from './budgets/check.js'
import { getActiveReservation } from './budgets/reservations.js'
import { getCodexCatalogModelState } from './codexSubscriptionCatalog.js'
import {
  CODEX_SUBSCRIPTION_CONNECTION_KEY,
  getSafeCodexSubscriptionConnection,
  normalizeCodexConnectionKey,
} from './codexSubscriptionConnection.js'
import {
  getMaxLlmProviderAttemptGeneration,
  insertLlmProviderAttempt,
} from './llmProviderAttemptStore.js'
import { issueRegisteredCodexExecutionTicket } from './llmProviderAttemptTicket.js'

const log = rootLogger.child({ module: 'llm-provider-attempt-authorizer' })
const CODEX_EXECUTE_SCOPE = 'llm:codex:execute'
const PROVIDER = 'codex-subscription' as const

const AUTHORIZE_BODY_KEYS = new Set([
  'request',
  'invocationId',
  'attemptGeneration',
  'providerAttemptIndex',
  'policyRevision',
  'policyHash',
  'requestHash',
  'budgetReservationId',
  'hostRef',
  'recipeNamespace',
  'recipeName',
  'userId',
])

export type LlmProviderAttemptAuthorizeErrorCode =
  | 'disabled'
  | 'insufficient_scope'
  | 'no_grant'
  | 'model_not_allowed'
  | 'budget_denied'
  | 'connection_unavailable'
  | 'host_binding_mismatch'
  | 'unknown_field'
  | 'invalid_request'
  | 'stale_generation'
  | 'idempotency_conflict'
  | 'provider_unavailable'

export class LlmProviderAttemptAuthorizeError extends Error {
  constructor(
    readonly code: LlmProviderAttemptAuthorizeErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LlmProviderAttemptAuthorizeError'
  }
}

export type AuthorizeAttemptSuccess = {
  providerAttemptId: string
  requestHash: string
  executionTicket: string
  expiresAt: string
}

export type LlmProviderAttemptAuthorizerDeps = {
  enabled: boolean
  db: DbClient
  withTransaction: typeof withTransaction
  getConnection: typeof getSafeCodexSubscriptionConnection
  getModelState: typeof getCodexCatalogModelState
  resolveConnectionKey: (hostRef: string) => Promise<string>
  evaluateBudget: typeof evaluateBudgetCheck
  getActiveReservation: typeof getActiveReservation
  getMaxGeneration: typeof getMaxLlmProviderAttemptGeneration
  insertAttempt: typeof insertLlmProviderAttempt
  issueTicket: typeof issueRegisteredCodexExecutionTicket
}

const defaultDeps = (): LlmProviderAttemptAuthorizerDeps => ({
  enabled: config.codexSubscriptionEnabled,
  db: { query: (text, values) => pool.query(text, values) },
  withTransaction,
  getConnection: getSafeCodexSubscriptionConnection,
  getModelState: getCodexCatalogModelState,
  resolveConnectionKey: async () => CODEX_SUBSCRIPTION_CONNECTION_KEY,
  evaluateBudget: evaluateBudgetCheck,
  getActiveReservation,
  getMaxGeneration: getMaxLlmProviderAttemptGeneration,
  insertAttempt: insertLlmProviderAttempt,
  issueTicket: issueRegisteredCodexExecutionTicket,
})

export { computeCodexPolicyHash }

function firstUnknownKey(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (!AUTHORIZE_BODY_KEYS.has(key)) return key
  }
  return null
}

function resolveCaller(claims: McpHostAccessClaims): {
  callerKind: 'host' | 'recipe'
  hostRef: string
  recipeNamespace: string | null
  recipeName: string | null
} {
  const hostRef = claims.hostRefs[0]?.trim()
  if (!hostRef) {
    throw new LlmProviderAttemptAuthorizeError(
      'insufficient_scope',
      'mcp-host JWT missing canonical hostRefs[0] caller binding'
    )
  }
  const isRecipe = hostRef.includes('/')
  return {
    callerKind: isRecipe ? 'recipe' : 'host',
    hostRef,
    recipeNamespace: isRecipe ? claims.recipeNamespace : null,
    recipeName: isRecipe ? claims.recipeName : null,
  }
}

function assertClaimBinding(body: Record<string, unknown>, claims: McpHostAccessClaims): void {
  const caller = resolveCaller(claims)
  if (typeof body.hostRef === 'string' && body.hostRef.trim() !== caller.hostRef) {
    throw new LlmProviderAttemptAuthorizeError(
      'host_binding_mismatch',
      'body hostRef does not match the token caller'
    )
  }
  if (
    typeof body.recipeNamespace === 'string' &&
    body.recipeNamespace.trim() !== claims.recipeNamespace
  ) {
    throw new LlmProviderAttemptAuthorizeError(
      'host_binding_mismatch',
      'body recipeNamespace does not match the token caller'
    )
  }
  if (typeof body.recipeName === 'string' && body.recipeName.trim() !== claims.recipeName) {
    throw new LlmProviderAttemptAuthorizeError(
      'host_binding_mismatch',
      'body recipeName does not match the token caller'
    )
  }
  if (typeof body.userId === 'string' && body.userId.trim() !== claims.sub) {
    throw new LlmProviderAttemptAuthorizeError(
      'host_binding_mismatch',
      'body userId does not match the token caller'
    )
  }
}

export async function authorizeLlmProviderAttempt(
  claims: McpHostAccessClaims,
  body: unknown,
  deps: LlmProviderAttemptAuthorizerDeps | Partial<LlmProviderAttemptAuthorizerDeps> = defaultDeps()
): Promise<AuthorizeAttemptSuccess> {
  const resolvedDeps: LlmProviderAttemptAuthorizerDeps = { ...defaultDeps(), ...deps }
  if (!resolvedDeps.enabled) {
    throw new LlmProviderAttemptAuthorizeError('disabled', 'Codex subscription is disabled')
  }
  if (!claims.workflowControlScopes.includes(CODEX_EXECUTE_SCOPE)) {
    throw new LlmProviderAttemptAuthorizeError(
      'insufficient_scope',
      'mcp-host JWT lacks the llm:codex:execute scope'
    )
  }
  if (!isPlainObject(body)) {
    throw new LlmProviderAttemptAuthorizeError('invalid_request', 'body must be an object')
  }
  const serialized = JSON.stringify(body)
  if (Buffer.byteLength(serialized, 'utf8') > LIMITS.maxRequestBodyBytes) {
    throw new LlmProviderAttemptAuthorizeError('invalid_request', 'request body exceeds the limit')
  }
  const unknown = firstUnknownKey(body)
  if (unknown) {
    throw new LlmProviderAttemptAuthorizeError('unknown_field', `unknown field '${unknown}'`)
  }

  const caller = resolveCaller(claims)
  assertClaimBinding(body, claims)

  const parsed = parseCodexCompletionRequestV1(body.request)
  if (!parsed.ok) {
    throw new LlmProviderAttemptAuthorizeError('invalid_request', parsed.message)
  }
  const request = parsed.value
  if (request.provider !== PROVIDER) {
    throw new LlmProviderAttemptAuthorizeError(
      'model_not_allowed',
      'provider must be codex-subscription'
    )
  }

  const invocationId = typeof body.invocationId === 'string' ? body.invocationId.trim() : ''
  const attemptGeneration =
    typeof body.attemptGeneration === 'number' ? body.attemptGeneration : NaN
  const providerAttemptIndex =
    typeof body.providerAttemptIndex === 'number' ? body.providerAttemptIndex : 1
  const policyRevision = typeof body.policyRevision === 'number' ? body.policyRevision : NaN
  const policyHash = typeof body.policyHash === 'string' ? body.policyHash : ''
  if (!invocationId || !Number.isInteger(attemptGeneration) || attemptGeneration < 1) {
    throw new LlmProviderAttemptAuthorizeError(
      'invalid_request',
      'invocationId and attemptGeneration are required'
    )
  }
  if (!Number.isInteger(providerAttemptIndex) || providerAttemptIndex < 1) {
    throw new LlmProviderAttemptAuthorizeError(
      'invalid_request',
      'providerAttemptIndex must be a positive integer'
    )
  }
  if (
    !Number.isInteger(policyRevision) ||
    policyRevision < 1 ||
    !/^[a-f0-9]{64}$/.test(policyHash)
  ) {
    throw new LlmProviderAttemptAuthorizeError(
      'invalid_request',
      'policyRevision and policyHash are required'
    )
  }

  const requestHash = hashCodexCompletionRequestV1(request)
  if (typeof body.requestHash === 'string' && body.requestHash !== requestHash) {
    throw new LlmProviderAttemptAuthorizeError(
      'invalid_request',
      'requestHash does not match the canonical request'
    )
  }

  return resolvedDeps.withTransaction(async tx => {
    const db: DbClient = tx
    const connectionKey = normalizeCodexConnectionKey(
      await resolvedDeps.resolveConnectionKey(caller.hostRef)
    )
    const connection = await resolvedDeps.getConnection(db, connectionKey)
    if (
      !connection ||
      connection.status !== 'connected' ||
      connection.revokedAt ||
      connection.catalogStatus === 'auth-rejected'
    ) {
      throw new LlmProviderAttemptAuthorizeError(
        'connection_unavailable',
        'Codex subscription connection is not usable'
      )
    }
    if (connection.catalogStatus === 'unavailable' || connection.catalogStatus === 'never_synced') {
      throw new LlmProviderAttemptAuthorizeError(
        'connection_unavailable',
        'Codex subscription catalog is not ready'
      )
    }

    const modelState = await resolvedDeps.getModelState(db, connection.id, request.model)
    if (!modelState || !modelState.enabled || modelState.stale) {
      throw new LlmProviderAttemptAuthorizeError(
        'model_not_allowed',
        'model is disabled, stale, or absent from the Codex catalog'
      )
    }

    const expectedPolicyHash = computeCodexPolicyHash({
      model: request.model,
      catalogRevision: connection.catalogRevision,
      credentialRevision: connection.credentialRevision,
      connectionKey: connection.connectionKey,
    })
    if (policyRevision !== connection.catalogRevision || policyHash !== expectedPolicyHash) {
      throw new LlmProviderAttemptAuthorizeError(
        'no_grant',
        'policy revision or hash does not match the current Codex catalog'
      )
    }

    const maxGeneration = await resolvedDeps.getMaxGeneration(db, invocationId)
    if (attemptGeneration < maxGeneration) {
      throw new LlmProviderAttemptAuthorizeError(
        'stale_generation',
        'attemptGeneration is older than the recorded invocation'
      )
    }

    const presentedReservationId =
      typeof body.budgetReservationId === 'string' ? body.budgetReservationId.trim() : ''
    if (presentedReservationId) {
      const active = await resolvedDeps.getActiveReservation(db, {
        reservationId: presentedReservationId,
        hostRef: caller.hostRef,
      })
      if (!active) {
        throw new LlmProviderAttemptAuthorizeError(
          'budget_denied',
          'budget reservation is missing or expired'
        )
      }
    }

    const budget = await resolvedDeps.evaluateBudget(
      {
        host_ref: caller.hostRef,
        context_ref: null,
        team_id: null,
        user_id: null,
        provider: PROVIDER,
        model: request.model,
        llm_secret_name: null,
        source_kind: caller.callerKind === 'recipe' ? 'workflow' : 'channel',
        recipe_name: caller.recipeName,
        cron_job_id: null,
        task_ref: invocationId,
      },
      db,
      { connect: async () => tx as never },
      { requiredUnit: 'tokens', transactionClient: tx }
    )
    if (!budget.allowed) {
      throw new LlmProviderAttemptAuthorizeError(
        'budget_denied',
        budget.reason === 'cost_unit_rejected'
          ? 'Codex attempts reject cost-unit budgets'
          : 'token budget denied this attempt'
      )
    }

    const budgetReservationId =
      budget.reservationIds?.[0] ?? (presentedReservationId || 'unbudgeted')

    try {
      const attempt = await resolvedDeps.insertAttempt(db, {
        callerKind: caller.callerKind,
        hostRef: caller.hostRef,
        recipeNamespace: caller.recipeNamespace,
        recipeName: caller.recipeName,
        invocationId,
        attemptGeneration,
        providerAttemptIndex,
        model: request.model,
        requestHash,
        policyRevision,
        policyHash,
        budgetReservationId,
        connectionRevision: connection.credentialRevision,
        connectionId: connection.id,
      })
      const issued = await resolvedDeps.issueTicket(db, {
        sub: claims.sub,
        hostRef: caller.hostRef,
        recipeNamespace: caller.recipeNamespace ?? undefined,
        recipeName: caller.recipeName ?? undefined,
        invocationId,
        attemptGeneration,
        providerAttemptId: attempt.id,
        providerAttemptIndex,
        model: request.model,
        requestHash,
        policyRevision,
        policyHash,
        budgetReservationId,
        connectionRevision: connection.credentialRevision,
        connectionId: connection.id,
      })
      log.info(
        {
          event: 'codex_attempt_authorized',
          providerAttemptId: attempt.id,
          hostRef: caller.hostRef,
          model: request.model,
        },
        'authorized Codex provider attempt'
      )
      return {
        providerAttemptId: attempt.id,
        requestHash,
        executionTicket: issued.executionTicket,
        expiresAt: issued.expiresAt.toISOString(),
      }
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === '23505') {
        throw new LlmProviderAttemptAuthorizeError(
          'idempotency_conflict',
          'an attempt with this invocation binding already exists'
        )
      }
      throw err
    }
  })
}
