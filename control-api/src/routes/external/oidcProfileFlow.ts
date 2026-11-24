import { type Request, type Response, Router } from 'express'
import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import { rootLogger } from '../../observability/logger.js'
import { loadOidcProviderConfiguration } from '../../oidc/configuration.js'
import { memberPolicyEvidenceClaimNames } from '../../oidc/memberEligibility.js'
import { OidcProtocolEngine, type VerifiedOidcIdentityProof } from '../../oidc/protocolEngine.js'
import {
  OidcAttemptRejectedError,
  OidcCallerCancelledError,
  OidcCredentialConfigurationError,
  OidcPersistenceFailure,
  OidcProviderIncompatibleError,
  OidcProviderUnavailableError,
} from '../../oidc/protocolResult.js'
import { OIDC_OPERATION_DEADLINE_MS } from '../../oidc/protocolTransport.js'
import { resolveEffectiveUserAccessPolicy } from '../../services/access/userAccessRuntimePolicy.js'
import { selectExternalSessionRepresentation } from '../../services/auth/externalSessionIssuance.js'
import type { OidcRefusalCause } from '../../services/auth/oidcAccountResolution.js'
import {
  type OidcMemberSignInResult,
  signInOidcMember,
} from '../../services/auth/oidcMemberSignIn.js'

const BROWSER_BINDING_RE = /^[A-Za-z0-9_-]{43}$/
const STATE_RE = /^[A-Za-z0-9_-]{32,512}$/
const CODE_RE = /^[\x21-\x7e]{1,4096}$/
const ISSUER_MAX_LENGTH = 2048
const ERROR_CODE_RE = /^[A-Za-z0-9_]{1,64}$/
const OIDC_SETTING_NAME_RE = /CONTROL_API_OIDC_[A-Z_]+/g

type Provider = NonNullable<ReturnType<typeof loadOidcProviderConfiguration>>
type Engine = Pick<
  OidcProtocolEngine,
  'beginIdentityProofAttempt' | 'completeIdentityProofAttempt' | 'cancelIdentityProofAttempt'
>

type SignInMember = (
  proof: VerifiedOidcIdentityProof,
  provider: Provider
) => Promise<OidcMemberSignInResult>

export type ExternalOidcProfileFlowDependencies = Readonly<{
  getProvider?: () => Provider | undefined
  createEngine?: (provider: Provider) => Engine
  signInMember?: SignInMember
}>

const logger = rootLogger.child({ component: 'oidc_profile_flow' })

/** What the operator's log says for each configuration refusal cause. */
const REFUSAL_CAUSE_LOG: Record<OidcRefusalCause, { message: string; action?: string }> = {
  connection_mismatch: {
    message:
      'OIDC member sign-in refused: the registration id is recorded for another issuer or client; use a new registration id',
    action: 'use a new registration id',
  },
  unknown_new_member_team: {
    message: 'OIDC member sign-in refused: the configured new-member team does not exist',
  },
  email_domain_claim_missing: {
    message:
      'OIDC member sign-in refused: the ID token has no xms_edov claim; add it as an optional claim in the app registration',
    action: 'add the xms_edov optional claim to the ID token',
  },
}

function defaultProvider(): Provider | undefined {
  return loadOidcProviderConfiguration(process.env, config.oauthEncryptionKey)
}

/**
 * At most one engine, for the current configuration generation, so provider
 * discovery is not repeated on every request. The generation covers every
 * protocol setting, the client credential and the eligibility settings other
 * than the new-member team; a new generation replaces the engine. A new
 * required claim name is therefore a new engine, which collects that claim.
 * The member sign-in switch is not part of the generation and is read from the
 * provider loaded for each request.
 */
const engines = new Map<string, OidcProtocolEngine>()

function defaultEngine(provider: Provider): OidcProtocolEngine {
  const cached = engines.get(provider.configurationGeneration)
  if (cached) return cached
  const engine = new OidcProtocolEngine(provider, {
    db: pool,
    getClientSecret: () => process.env[provider.clientSecretRef] ?? '',
    encryptionKeyHex: config.oauthEncryptionKey,
    policyEvidenceClaimNames: memberPolicyEvidenceClaimNames(provider.memberEligibility),
  })
  engines.clear()
  engines.set(provider.configurationGeneration, engine)
  return engine
}

/**
 * Issues the Profile UI session exactly as password login does: no requested contract
 * and no client version, so the same representation is selected.
 *
 * `signInOidcMember` runs in its own default transaction runner: it retries a
 * unique-key conflict only when the PostgreSQL error code reaches it unchanged.
 */
async function defaultSignInMember(
  proof: VerifiedOidcIdentityProof,
  provider: Provider
): Promise<OidcMemberSignInResult> {
  const policy = provider.memberSignIn
  if (!policy) throw new Error('OIDC member sign-in is switched off')
  const sessionPolicy = await resolveEffectiveUserAccessPolicy()
  const selection = selectExternalSessionRepresentation({}, sessionPolicy)
  if (selection.status !== 'selected') {
    throw new Error('Profile UI session representation is unavailable')
  }
  return signInOidcMember({
    proof,
    provider,
    policy,
    contract: selection.contract,
    sessionPolicy,
  })
}

/** Correlates sign-ins without writing the provider subject itself to logs. */
function subjectFingerprint(proof: VerifiedOidcIdentityProof): string {
  return createHash('sha256').update(`${proof.issuer}\n${proof.subject}`).digest('hex').slice(0, 16)
}

/**
 * The only facts a failure log carries: the error class and, when it has one,
 * its code. A message or a database error's detail can hold an email or a row value.
 */
function errorSummary(error: unknown): { errorClass: string; code?: string } {
  const errorClass =
    error instanceof Error ? error.constructor.name : error === null ? 'null' : typeof error
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && ERROR_CODE_RE.test(code)
    ? { errorClass, code }
    : { errorClass }
}

/**
 * A provider configuration error answers 503 on every OIDC route. Its log names
 * the settings at fault (the member sign-in switch set without its release
 * guard names CONTROL_API_OIDC_UNRELEASED), never their values.
 */
function logConfigurationFailure(error: unknown): void {
  const fields =
    error instanceof Error ? [...new Set(error.message.match(OIDC_SETTING_NAME_RE) ?? [])] : []
  logger.error(
    { event: 'oidc_configuration_unavailable', ...errorSummary(error), fields },
    'OIDC provider configuration is unusable; OIDC routes answer 503 until it is fixed'
  )
}

function safeFailure(error: unknown, res: Response, includeRetryability = false): void {
  if (error instanceof OidcAttemptRejectedError) {
    res.status(400).json({ error: 'oidc_attempt_rejected' })
    return
  }
  if (error instanceof OidcCredentialConfigurationError) {
    res.status(503).json({ error: 'oidc_configuration_unavailable' })
    return
  }
  if (error instanceof OidcProviderUnavailableError) {
    res.status(503).json({
      error: 'oidc_provider_unavailable',
      ...(includeRetryability ? { retrySameAttempt: error.retrySameAttempt } : {}),
    })
    return
  }
  if (error instanceof OidcProviderIncompatibleError) {
    res.status(503).json({ error: 'oidc_provider_incompatible' })
    return
  }
  if (error instanceof OidcPersistenceFailure) {
    res.status(503).json({
      error: 'oidc_storage_unavailable',
      ...(includeRetryability ? { retrySameAttempt: error.retrySameAttempt } : {}),
    })
    return
  }
  if (error instanceof OidcCallerCancelledError) {
    res.status(503).json({
      error: 'oidc_operation_cancelled',
      retrySameAttempt: !error.consumedAttempt,
    })
    return
  }
  res.status(503).json({ error: 'oidc_unavailable' })
}

function oidcOperationSignal(req: { get(name: string): string | undefined }): AbortSignal {
  const requested = Number(req.get('x-oidc-operation-deadline-ms'))
  const budget =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, OIDC_OPERATION_DEADLINE_MS)
      : OIDC_OPERATION_DEADLINE_MS
  return AbortSignal.timeout(budget)
}

function validBinding(value: unknown): value is string {
  return typeof value === 'string' && BROWSER_BINDING_RE.test(value)
}

function validState(value: unknown): value is string {
  return typeof value === 'string' && STATE_RE.test(value)
}

export function createExternalOidcProfileFlowRouter(
  dependencies: ExternalOidcProfileFlowDependencies = {}
): Router {
  const getProvider = dependencies.getProvider ?? defaultProvider
  const createEngine = dependencies.createEngine ?? defaultEngine
  const signInMember = dependencies.signInMember ?? defaultSignInMember
  const router = Router()
  const edgeRateLimits = createExternalClientRateLimiters(
    'oidc_profile_flow',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )
  router.use('/external/oidc/profile-flow', ...edgeRateLimits)

  /** The configured provider, or undefined once the 404 or 503 answer is sent. */
  function configuredProvider(res: Response): Provider | undefined {
    let provider: Provider | undefined
    try {
      provider = getProvider()
    } catch (error) {
      logConfigurationFailure(error)
      res.status(503).json({ error: 'oidc_configuration_unavailable' })
      return undefined
    }
    if (!provider) res.status(404).json({ error: 'oidc_not_configured' })
    return provider
  }

  router.get('/external/oidc/profile-flow/configuration', (_req, res) => {
    const provider = configuredProvider(res)
    if (!provider) return
    res.status(200).json({
      redirectUri: provider.redirectUri,
      memberAuthenticationActivated: provider.memberAuthenticationActivated,
      displayLabel: provider.displayLabel,
    })
  })

  router.post('/external/oidc/profile-flow/attempts', async (req, res) => {
    const provider = configuredProvider(res)
    if (!provider) return
    if (!validBinding(req.body?.browserBinding)) {
      return res.status(400).json({ error: 'invalid_oidc_attempt' })
    }
    try {
      const result = await createEngine(provider).beginIdentityProofAttempt({
        browserBinding: req.body.browserBinding,
        signal: oidcOperationSignal(req),
      })
      return res.status(200).json({
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt.toISOString(),
      })
    } catch (error) {
      safeFailure(error, res)
    }
  })

  router.post('/external/oidc/profile-flow/complete', async (req, res) => {
    const provider = configuredProvider(res)
    if (!provider) return
    const { state, code, browserBinding, issuer } = req.body ?? {}
    if (
      !validState(state) ||
      !validBinding(browserBinding) ||
      typeof code !== 'string' ||
      !CODE_RE.test(code) ||
      (issuer !== undefined &&
        (typeof issuer !== 'string' || issuer.length === 0 || issuer.length > ISSUER_MAX_LENGTH))
    ) {
      return res.status(400).json({ error: 'invalid_oidc_attempt' })
    }
    let proof: VerifiedOidcIdentityProof
    try {
      proof = await createEngine(provider).completeIdentityProofAttempt(
        {
          state,
          code,
          browserBinding,
          ...(issuer !== undefined ? { issuer } : {}),
        },
        { signal: oidcOperationSignal(req) }
      )
    } catch (error) {
      return safeFailure(error, res, true)
    }
    if (!provider.memberAuthenticationActivated) {
      return res.status(200).json({
        outcome: 'identity_proof_verified',
        memberAuthenticationActivated: false,
      })
    }
    return completeMemberSignIn(proof, provider, req, res)
  })

  async function completeMemberSignIn(
    proof: VerifiedOidcIdentityProof,
    provider: Provider,
    req: Request,
    res: Response
  ): Promise<void> {
    const audit = {
      registrationId: proof.registrationId,
      issuer: proof.issuer,
      subjectFingerprint: subjectFingerprint(proof),
      requestId: req.get('x-request-id'),
    }
    let result: OidcMemberSignInResult
    try {
      result = await signInMember(proof, provider)
    } catch (error) {
      // The attempt is already consumed: the browser must start a new one.
      logger.error(
        { event: 'oidc_member_sign_in_failed', ...audit, ...errorSummary(error) },
        'OIDC member sign-in failed'
      )
      res.status(503).json({ error: 'oidc_storage_unavailable', retrySameAttempt: false })
      return
    }
    if (result.status === 'refused') {
      if (result.cause === undefined) {
        logger.info(
          { event: 'oidc_member_refused', ...audit, reason: result.reason },
          'OIDC member sign-in refused'
        )
      } else {
        // A configuration refusal names its cause for the operator; the cause
        // never goes into the response.
        const refusal = REFUSAL_CAUSE_LOG[result.cause]
        logger.warn(
          {
            event: 'oidc_member_refused',
            ...audit,
            reason: result.reason,
            cause: result.cause,
            ...(refusal.action === undefined ? {} : { action: refusal.action }),
          },
          refusal.message
        )
      }
      res.status(200).json({
        outcome: 'refused',
        memberAuthenticationActivated: true,
        reason: result.reason,
      })
      return
    }
    const member = { ...audit, userId: result.userId }
    if (result.created.account) {
      logger.info(
        { event: 'oidc_member_account_created', ...member },
        'OIDC member account created'
      )
    }
    if (result.created.link) {
      logger.info({ event: 'oidc_member_link_created', ...member }, 'OIDC member link created')
    }
    if (result.invitationsApplied > 0) {
      logger.info(
        { event: 'oidc_member_invitation_applied', ...member, count: result.invitationsApplied },
        'OIDC member invitations applied'
      )
    }
    logger.info(
      { event: 'oidc_member_signed_in', ...member, sessionContract: result.contract },
      'OIDC member signed in'
    )
    res.status(200).json({
      outcome: 'member_signed_in',
      memberAuthenticationActivated: true,
      token: result.token,
      sessionContract: result.contract,
    })
  }

  router.post('/external/oidc/profile-flow/cancel', async (req, res) => {
    const provider = configuredProvider(res)
    if (!provider) return
    const { state, browserBinding } = req.body ?? {}
    if (!validState(state) || !validBinding(browserBinding)) {
      return res.status(400).json({ error: 'invalid_oidc_attempt' })
    }
    try {
      const cancelled = await createEngine(provider).cancelIdentityProofAttempt({
        state,
        browserBinding,
      })
      if (!cancelled) return res.status(400).json({ error: 'oidc_attempt_rejected' })
      return res.status(200).json({ outcome: 'attempt_cancelled' })
    } catch (error) {
      safeFailure(error, res, true)
    }
  })

  return router
}
