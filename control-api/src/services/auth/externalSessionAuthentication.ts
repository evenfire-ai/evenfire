import type { AuthClaims } from '../../profileTypes.js'
import { verifyExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'
import type { UserSessionV2Claims } from '../../utils/auth/userSessionV2Token.js'
import { validateUserSessionClaims } from './userSessionService.js'

export type ExternalSessionAuthentication =
  | { status: 'authenticated'; claims: AuthClaims }
  | { status: 'invalid' | 'expired' | 'revoked'; reason: string }

export async function authenticateExternalSessionToken(
  token: string
): Promise<ExternalSessionAuthentication> {
  const claims = verifyExternalSessionToken(token)
  if (!claims) return { status: 'invalid', reason: 'invalid_representation' }
  if (claims.sessionContract !== 'v2') return { status: 'authenticated', claims }

  const validation = await validateUserSessionClaims({
    sub: claims.userId,
    sid: claims.sid!,
    jti: claims.jti!,
    sv: claims.sv!,
    ver: 2,
    typ: 'user_session',
    ...(claims.email ? { email: claims.email } : {}),
    auth_time: claims.authTime!,
    amr: [...(claims.amr || [])],
    iat: claims.iat!,
    exp: claims.exp,
  } satisfies UserSessionV2Claims)

  if (validation.status !== 'valid') return validation
  return {
    status: 'authenticated',
    claims: {
      ...claims,
      userId: validation.identity.userId,
      email: validation.identity.email,
      sid: validation.identity.sid,
      jti: validation.identity.jti,
      sv: validation.identity.sessionVersion,
    },
  }
}
