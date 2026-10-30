import { type Response, Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import { loadOidcProviderConfiguration } from '../../oidc/configuration.js'
import { OidcProtocolEngine } from '../../oidc/protocolEngine.js'
import {
  OidcAttemptRejectedError,
  OidcCallerCancelledError,
  OidcCredentialConfigurationError,
  OidcPersistenceFailure,
  OidcProviderIncompatibleError,
  OidcProviderUnavailableError,
} from '../../oidc/protocolResult.js'

const BROWSER_BINDING_RE = /^[A-Za-z0-9_-]{43}$/
const STATE_RE = /^[A-Za-z0-9_-]{32,512}$/
const CODE_RE = /^[\x21-\x7e]{1,4096}$/
const ISSUER_MAX_LENGTH = 2048

type Provider = NonNullable<ReturnType<typeof loadOidcProviderConfiguration>>
type Engine = Pick<
  OidcProtocolEngine,
  'beginIdentityProofAttempt' | 'completeIdentityProofAttempt' | 'cancelIdentityProofAttempt'
>

export type ExternalOidcProfileFlowDependencies = Readonly<{
  getProvider?: () => Provider | undefined
  createEngine?: (provider: Provider) => Engine
}>

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

function safeFailure(error: unknown, res: Response): void {
  if (error instanceof OidcAttemptRejectedError) {
    res.status(400).json({ error: 'oidc_attempt_rejected' })
    return
  }
  if (error instanceof OidcCredentialConfigurationError) {
    res.status(503).json({ error: 'oidc_configuration_unavailable' })
    return
  }
  if (error instanceof OidcProviderUnavailableError) {
    res.status(503).json({ error: 'oidc_provider_unavailable' })
    return
  }
  if (error instanceof OidcProviderIncompatibleError) {
    res.status(503).json({ error: 'oidc_provider_incompatible' })
    return
  }
  if (error instanceof OidcPersistenceFailure) {
    res.status(503).json({ error: 'oidc_storage_unavailable' })
    return
  }
  if (error instanceof OidcCallerCancelledError) {
    res.status(503).json({ error: 'oidc_operation_cancelled' })
    return
  }
  res.status(503).json({ error: 'oidc_unavailable' })
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
  const router = Router()
  const edgeRateLimits = createExternalClientRateLimiters(
    'oidc_profile_flow',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )
  router.use('/oidc/profile-flow', ...edgeRateLimits)

  router.get('/oidc/profile-flow/configuration', (_req, res) => {
    try {
      const provider = getProvider()
      if (!provider) return res.status(404).json({ error: 'oidc_not_configured' })
      return res.status(200).json({
        redirectUri: provider.redirectUri,
        memberAuthenticationActivated: false,
      })
    } catch {
      return res.status(503).json({ error: 'oidc_configuration_unavailable' })
    }
  })

  router.post('/oidc/profile-flow/attempts', async (req, res) => {
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
      })
      return res.status(200).json({
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt.toISOString(),
      })
    } catch (error) {
      safeFailure(error, res)
    }
  })

  router.post('/oidc/profile-flow/complete', async (req, res) => {
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
    try {
      await createEngine(provider).completeIdentityProofAttempt({
        state,
        code,
        browserBinding,
        ...(issuer !== undefined ? { issuer } : {}),
      })
      return res.status(200).json({
        outcome: 'identity_proof_verified',
        memberAuthenticationActivated: false,
      })
    } catch (error) {
      safeFailure(error, res)
    }
  })

  router.post('/oidc/profile-flow/cancel', async (req, res) => {
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
      safeFailure(error, res)
    }
  })

  return router
}
