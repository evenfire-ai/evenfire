import { type Request, type Response, Router } from 'express'
import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import { rootLogger } from '../../observability/logger.js'
import { loadOidcProviderConfiguration } from '../../oidc/configuration.js'
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
import {
  type OidcVerifiedMemberSignInResult,
  signInOidcVerifiedMember,
} from '../../services/auth/oidcMemberSignIn.js'

const BROWSER_BINDING_RE = /^[A-Za-z0-9_-]{43}$/
const STATE_RE = /^[A-Za-z0-9_-]{32,512}$/
const CODE_RE = /^[\x21-\x7e]{1,4096}$/
const ISSUER_MAX_LENGTH = 2048

type Provider = NonNullable<ReturnType<typeof loadOidcProviderConfiguration>>
type Engine = Pick<
  OidcProtocolEngine,
  'beginIdentityProofAttempt' | 'completeIdentityProofAttempt' | 'cancelIdentityProofAttempt'
>

type SignInMember = (proof: VerifiedOidcIdentityProof) => Promise<OidcVerifiedMemberSignInResult>

export type ExternalOidcProfileFlowDependencies = Readonly<{
  getProvider?: () => Provider | undefined
  createEngine?: (provider: Provider) => Engine
  signInMember?: SignInMember
}>

const logger = rootLogger.child({ component: 'oidc_profile_flow' })

function defaultProvider(): Provider | undefined {
  return loadOidcProviderConfiguration(process.env, config.oauthEncryptionKey)
}

function defaultEngine(provider: Provider): OidcProtocolEngine {
  return new OidcProtocolEngine(provider, {
    db: pool,
    getClientSecret: () => process.env[provider.clientSecretRef] ?? '',
    encryptionKeyHex: config.oauthEncryptionKey,
  })
}

/**
 * Issues the Profile UI session exactly as password login does: no requested contract
 * and no client version, so the same representation is selected.
 */
async function defaultSignInMember(
  proof: VerifiedOidcIdentityProof
): Promise<OidcVerifiedMemberSignInResult> {
  const policy = await resolveEffectiveUserAccessPolicy()
  const selection = selectExternalSessionRepresentation({}, policy)
  if (selection.status !== 'selected') {
    throw new Error('Profile UI session representation is unavailable')
  }
  return signInOidcVerifiedMember({
    attributes: proof.attributes,
    contract: selection.contract,
    policy,
  })
}

/** Correlates sign-ins without writing the provider subject itself to logs. */
function subjectFingerprint(proof: VerifiedOidcIdentityProof): string {
  return createHash('sha256').update(`${proof.issuer}\n${proof.subject}`).digest('hex').slice(0, 16)
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

  router.get('/external/oidc/profile-flow/configuration', (_req, res) => {
    try {
      const provider = getProvider()
      if (!provider) return res.status(404).json({ error: 'oidc_not_configured' })
      return res.status(200).json({
        redirectUri: provider.redirectUri,
        memberAuthenticationActivated: provider.memberAuthenticationActivated,
      })
    } catch {
      return res.status(503).json({ error: 'oidc_configuration_unavailable' })
    }
  })

  router.post('/external/oidc/profile-flow/attempts', async (req, res) => {
    let provider: Provider | undefined
    try {
      provider = getProvider()
    } catch {
      return res.status(503).json({ error: 'oidc_configuration_unavailable' })
    }
    if (!provider) return res.status(404).json({ error: 'oidc_not_configured' })
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
    let provider: Provider | undefined
    try {
      provider = getProvider()
    } catch {
      return res.status(503).json({ error: 'oidc_configuration_unavailable' })
    }
    if (!provider) return res.status(404).json({ error: 'oidc_not_configured' })
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
    return completeMemberSignIn(proof, req, res)
  })

  async function completeMemberSignIn(
    proof: VerifiedOidcIdentityProof,
    req: Request,
    res: Response
  ): Promise<void> {
    const audit = {
      event: 'oidc_member_sign_in',
      registrationId: proof.registrationId,
      issuer: proof.issuer,
      subjectFingerprint: subjectFingerprint(proof),
      requestId: req.get('x-request-id'),
    }
    let result: OidcVerifiedMemberSignInResult
    try {
      result = await signInMember(proof)
    } catch (error) {
      // The attempt is already consumed: the browser must start a new one.
      logger.error({ ...audit, outcome: 'failed', err: error }, 'OIDC member sign-in failed')
      res.status(503).json({ error: 'oidc_storage_unavailable', retrySameAttempt: false })
      return
    }
    if (result.status === 'refused') {
      logger.info(
        { ...audit, outcome: 'refused', reason: result.reason },
        'OIDC member sign-in refused'
      )
      res.status(200).json({
        outcome: 'identity_proof_verified',
        memberAuthenticationActivated: true,
        memberSignIn: 'no_matching_member',
      })
      return
    }
    logger.info(
      { ...audit, outcome: 'signed_in', userId: result.userId, sessionContract: result.contract },
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
    let provider: Provider | undefined
    try {
      provider = getProvider()
    } catch {
      return res.status(503).json({ error: 'oidc_configuration_unavailable' })
    }
    if (!provider) return res.status(404).json({ error: 'oidc_not_configured' })
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
