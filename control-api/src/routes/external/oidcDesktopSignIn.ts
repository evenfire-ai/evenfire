import { type Request, type Response, Router } from 'express'
import { config } from '../../config.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import { rootLogger } from '../../observability/logger.js'
import type { OidcProviderConfiguration } from '../../oidc/configuration.js'
import { resolveEffectiveUserAccessPolicy } from '../../services/access/userAccessRuntimePolicy.js'
import { selectExternalSessionRepresentation } from '../../services/auth/externalSessionIssuance.js'
import { DESKTOP_SIGN_IN_CODE_RE } from '../../services/auth/oidcDesktopSignInCode.js'
import {
  type DesktopSignInRedeemResult,
  redeemDesktopSignInCode,
} from '../../services/auth/oidcDesktopSignInRedeem.js'
import { externalSessionClient } from './auth.js'
import { defaultProvider, logConfigurationFailure } from './oidcProfileFlow.js'

/** An RFC 7636 code verifier: 43 to 128 unreserved characters. */
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/

const logger = rootLogger.child({ component: 'oidc_desktop_sign_in' })

export type ExternalOidcDesktopSignInDependencies = Readonly<{
  getProvider?: () => OidcProviderConfiguration | undefined
  redeem?: typeof redeemDesktopSignInCode
}>

function sendUnavailable(res: Response): void {
  res.status(409).json({ error: 'desktop_sign_in_unavailable' })
}

/**
 * Answers a redeem result and logs it with the member and request context the
 * other OIDC sign-in events carry. There is no identity proof at redeem, so no
 * subject fingerprint. Never the code, the verifier, the token or the email.
 */
function answerRedeem(
  result: DesktopSignInRedeemResult,
  provider: OidcProviderConfiguration,
  req: Request,
  res: Response
): void {
  const member = (userId: string) => ({
    registrationId: provider.registrationId,
    issuer: provider.issuer,
    userId,
    requestId: req.get('x-request-id'),
  })
  switch (result.status) {
    case 'signed_in':
      logger.info(
        {
          event: 'oidc_desktop_code_redeemed',
          ...member(result.body.me.id),
          sessionContract: result.body.sessionContract,
        },
        'OIDC Desktop sign-in code redeemed'
      )
      res.status(200).json(result.body)
      return
    case 'invalid_code':
      res.status(400).json({ error: 'invalid_desktop_sign_in_code' })
      return
    case 'refused':
      logger.info(
        { event: 'oidc_desktop_code_refused', ...member(result.userId), reason: result.reason },
        'OIDC Desktop sign-in code refused'
      )
      res.status(403).json({ error: 'desktop_sign_in_refused', reason: result.reason })
      return
    case 'unavailable':
      logger.warn(
        { event: 'oidc_desktop_code_connection_mismatch', ...member(result.userId) },
        'OIDC Desktop sign-in code was minted under another connection or before member sign-in was switched off'
      )
      sendUnavailable(res)
      return
  }
}

/**
 * `POST /external/oidc/desktop-sign-in/redeem`: Evenfire Desktop trades the
 * one-use code from its browser sign-in, with its PKCE verifier, for the
 * `{ token, sessionContract, me }` body password login returns.
 *
 * Before any transaction, so no code is spent: a malformed code or verifier
 * answers 400; a provider configuration that fails to load, or none, answers
 * 409; no selectable session format answers 426, as password login does. A
 * switch-off or connection change since mint is decided inside the redeem
 * transaction, which spends the code. A session issuance error reaches the
 * error handler (503 session_issuance_temporarily_unavailable).
 */
export function createExternalOidcDesktopSignInRouter(
  dependencies: ExternalOidcDesktopSignInDependencies = {}
): Router {
  const getProvider = dependencies.getProvider ?? defaultProvider
  const redeem = dependencies.redeem ?? redeemDesktopSignInCode
  const router = Router()
  const edgeRateLimits = createExternalClientRateLimiters(
    'oidc_desktop_sign_in',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )
  router.use('/external/oidc/desktop-sign-in', ...edgeRateLimits)

  router.post('/external/oidc/desktop-sign-in/redeem', async (req, res, next) => {
    try {
      const { code, codeVerifier } = (req.body ?? {}) as { code?: unknown; codeVerifier?: unknown }
      if (
        typeof code !== 'string' ||
        !DESKTOP_SIGN_IN_CODE_RE.test(code) ||
        typeof codeVerifier !== 'string' ||
        !CODE_VERIFIER_RE.test(codeVerifier)
      ) {
        res.status(400).json({ error: 'invalid_desktop_sign_in_code' })
        return
      }

      let provider: OidcProviderConfiguration | undefined
      try {
        provider = getProvider()
      } catch (error) {
        logConfigurationFailure(error)
        sendUnavailable(res)
        return
      }
      if (!provider) {
        sendUnavailable(res)
        return
      }

      const sessionPolicy = await resolveEffectiveUserAccessPolicy()
      const selection = selectExternalSessionRepresentation(
        externalSessionClient(req),
        sessionPolicy
      )
      if (selection.status !== 'selected') {
        res.status(426).json({ error: 'upgrade_required' })
        return
      }

      const result = await redeem({
        code,
        codeVerifier,
        provider,
        contract: selection.contract,
        sessionPolicy,
      })
      answerRedeem(result, provider, req, res)
    } catch (error) {
      next(error)
    }
  })

  return router
}
