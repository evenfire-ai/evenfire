import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { type DbClient, pool, withTransaction } from '../db.js'
import { deriveOAuthEncryptionKey } from '../oauth/encryption.js'
import { rootLogger } from '../observability/logger.js'
import { chatgptAccountIdFromJwt } from './chatgptAccountId.js'
import {
  getSafeCodexSubscriptionConnectionById,
  loadCodexSubscriptionSecrets,
} from './codexSubscriptionConnection.js'
import {
  CodexSubscriptionOAuthError,
  ensureFreshCodexAccessToken,
} from './codexSubscriptionOAuth.js'
import {
  loadLlmProviderAttempt,
  lockLlmProviderAttemptTicket,
  markLlmProviderAttemptTicketRedeemed,
} from './llmProviderAttemptStore.js'
import { verifyCodexExecutionTicket } from './llmProviderAttemptTicket.js'

const log = rootLogger.child({ module: 'llm-provider-attempt-redemption' })

export const CODEX_COMPLETIONS_ORIGIN = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_CATALOG_ORIGIN =
  'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0'
export const CODEX_TRANSPORT_PROTOCOL = 'codex-subscription-transport.v1'
export const CODEX_MAX_STREAM_DURATION_MS = 300_000

export type LlmProviderAttemptRedeemErrorCode =
  | 'disabled'
  | 'ticket_invalid'
  | 'ticket_replayed'
  | 'ticket_expired'
  | 'request_hash_mismatch'
  | 'connection_unavailable'
  | 'no_grant'
  | 'provider_unavailable'

export class LlmProviderAttemptRedeemError extends Error {
  constructor(
    readonly code: LlmProviderAttemptRedeemErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LlmProviderAttemptRedeemError'
  }
}

export type RedeemAttemptSuccess = {
  accessToken: string
  chatgptAccountId?: string
  transport: {
    protocolVersion: typeof CODEX_TRANSPORT_PROTOCOL
    completionsOrigin: typeof CODEX_COMPLETIONS_ORIGIN
    catalogOrigin: typeof CODEX_CATALOG_ORIGIN
    operation: 'completion_stream' | 'completion_cancel' | 'connection_test'
    servedModel: string
    maxStreamDurationMs: number
  }
  expiryClass: 'short_lived' | 'upstream_managed'
  attemptReceipt: string
}

export type RedeemAttemptInput = {
  executionTicket: string
  requestHash: string
  model?: string
  hostRef?: string
  operation?: 'completion_stream' | 'completion_cancel' | 'connection_test'
}

export function opaqueAttemptReceipt(input: {
  jti: string
  providerAttemptId: string
  requestHash: string
}): string {
  return createHash('sha256')
    .update(`${input.jti}:${input.providerAttemptId}:${input.requestHash}`)
    .digest('hex')
}

export type RedeemAttemptDeps = {
  enabled: boolean
  db: DbClient
  withTransaction: typeof withTransaction
  loadSecrets: typeof loadCodexSubscriptionSecrets
  getConnectionById: typeof getSafeCodexSubscriptionConnectionById
  encryptionKey: Buffer
  ensureFreshAccessToken?: (connectionKey?: string) => Promise<void>
}

const defaultRedeemDeps = (): RedeemAttemptDeps => ({
  enabled: config.codexSubscriptionEnabled,
  db: pool,
  withTransaction,
  loadSecrets: loadCodexSubscriptionSecrets,
  getConnectionById: getSafeCodexSubscriptionConnectionById,
  encryptionKey: deriveOAuthEncryptionKey(config.oauthEncryptionKey),
  ensureFreshAccessToken: connectionKey =>
    ensureFreshCodexAccessToken({
      db: { query: (text, values) => pool.query(text, values) },
      encryptionKey: deriveOAuthEncryptionKey(config.oauthEncryptionKey),
      fetchFn: fetch,
      clientId: config.codexOAuthClientId,
      redirectUri: 'http://127.0.0.1/codex/oauth/callback',
      enabled: config.codexSubscriptionEnabled,
      connectionKey,
    }),
})

export async function redeemLlmProviderAttempt(
  input: RedeemAttemptInput,
  deps: RedeemAttemptDeps = defaultRedeemDeps()
): Promise<RedeemAttemptSuccess> {
  if (!deps.enabled) {
    throw new LlmProviderAttemptRedeemError('disabled', 'Codex subscription is disabled')
  }
  const claims = verifyCodexExecutionTicket(input.executionTicket)
  if (!claims) {
    throw new LlmProviderAttemptRedeemError('ticket_invalid', 'execution ticket is invalid')
  }
  if (claims.requestHash !== input.requestHash) {
    throw new LlmProviderAttemptRedeemError(
      'request_hash_mismatch',
      'requestHash does not match the ticket'
    )
  }
  if (input.model && input.model !== claims.model) {
    throw new LlmProviderAttemptRedeemError('ticket_invalid', 'model does not match the ticket')
  }
  if (input.hostRef && input.hostRef !== claims.hostRef) {
    throw new LlmProviderAttemptRedeemError('ticket_invalid', 'hostRef does not match the ticket')
  }

  if (deps.ensureFreshAccessToken) {
    try {
      let refreshKey: string | undefined
      if (claims.connectionId) {
        const assigned = await deps.getConnectionById(deps.db, claims.connectionId)
        refreshKey = assigned?.connectionKey
      }
      await deps.ensureFreshAccessToken(refreshKey)
    } catch (err) {
      if (err instanceof CodexSubscriptionOAuthError) {
        throw new LlmProviderAttemptRedeemError(
          err.code === 'no_grant' || err.code === 'not_connected'
            ? 'no_grant'
            : 'connection_unavailable',
          'Codex access token could not be refreshed'
        )
      }
      throw err
    }
  }

  return deps.withTransaction(async tx => {
    const ticket = await lockLlmProviderAttemptTicket(tx, claims.jti)
    if (!ticket) {
      throw new LlmProviderAttemptRedeemError(
        'ticket_invalid',
        'execution ticket is not registered'
      )
    }
    if (ticket.status !== 'issued') {
      throw new LlmProviderAttemptRedeemError('ticket_replayed', 'execution ticket already used')
    }
    if (ticket.expiresAt.getTime() <= Date.now()) {
      throw new LlmProviderAttemptRedeemError('ticket_expired', 'execution ticket expired')
    }

    const attempt = await loadLlmProviderAttempt(tx, ticket.providerAttemptId)
    if (!attempt || attempt.status !== 'authorized') {
      throw new LlmProviderAttemptRedeemError(
        'ticket_invalid',
        'provider attempt is not redeemable'
      )
    }
    if (
      attempt.requestHash !== claims.requestHash ||
      attempt.model !== claims.model ||
      attempt.hostRef !== claims.hostRef ||
      attempt.invocationId !== claims.invocationId ||
      attempt.attemptGeneration !== claims.attemptGeneration ||
      attempt.policyHash !== claims.policyHash ||
      attempt.policyRevision !== claims.policyRevision ||
      attempt.budgetReservationId !== claims.budgetReservationId ||
      attempt.connectionRevision !== claims.connectionRevision
    ) {
      throw new LlmProviderAttemptRedeemError(
        'no_grant',
        'ticket bindings no longer match the attempt'
      )
    }

    if (!attempt.connectionId) {
      throw new LlmProviderAttemptRedeemError(
        'connection_unavailable',
        'Codex attempt is missing a connection binding'
      )
    }
    const connection = await getSafeCodexSubscriptionConnectionById(tx, attempt.connectionId)
    if (
      !connection ||
      connection.status !== 'connected' ||
      connection.revokedAt ||
      connection.credentialRevision !== attempt.connectionRevision ||
      (attempt.connectionId && connection.id !== attempt.connectionId)
    ) {
      throw new LlmProviderAttemptRedeemError(
        'connection_unavailable',
        'Codex subscription connection is not usable'
      )
    }

    const redeemed = await markLlmProviderAttemptTicketRedeemed(tx, claims.jti)
    if (!redeemed) {
      throw new LlmProviderAttemptRedeemError('ticket_replayed', 'execution ticket already used')
    }

    const secrets = await deps.loadSecrets(tx, deps.encryptionKey, connection.connectionKey)
    if (!secrets?.accessToken) {
      throw new LlmProviderAttemptRedeemError(
        'connection_unavailable',
        'no usable access token is available'
      )
    }
    const chatgptAccountId =
      secrets.chatgptAccountId || chatgptAccountIdFromJwt(secrets.accessToken)
    if (!chatgptAccountId) {
      throw new LlmProviderAttemptRedeemError(
        'connection_unavailable',
        'Codex access token is missing ChatGPT account id'
      )
    }

    const expiryClass =
      secrets.accessTokenExpiresAt &&
      secrets.accessTokenExpiresAt.getTime() - Date.now() < 3_600_000
        ? 'short_lived'
        : 'upstream_managed'

    log.info(
      { event: 'codex_attempt_redeemed', providerAttemptId: attempt.id },
      'redeemed Codex execution ticket'
    )
    return {
      accessToken: secrets.accessToken,
      chatgptAccountId,
      transport: {
        protocolVersion: CODEX_TRANSPORT_PROTOCOL,
        completionsOrigin: CODEX_COMPLETIONS_ORIGIN,
        catalogOrigin: CODEX_CATALOG_ORIGIN,
        operation: input.operation ?? 'completion_stream',
        servedModel: attempt.model,
        maxStreamDurationMs: CODEX_MAX_STREAM_DURATION_MS,
      },
      expiryClass,
      attemptReceipt: opaqueAttemptReceipt({
        jti: claims.jti,
        providerAttemptId: attempt.id,
        requestHash: attempt.requestHash,
      }),
    }
  })
}
