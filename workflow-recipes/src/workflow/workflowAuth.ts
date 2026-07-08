import { type JWTPayload, decodeJwt, importSPKI, jwtVerify } from 'jose'

export interface AuthenticatedRequest {
  tokenClaims: {
    sub: string
    aud: string
    iss: string
    recipeName: string
    recipeNamespace: string
    runId?: string
    artifactName?: string
    scopes: string[]
  }
}

export const WRC_ISSUER = 'clerum-wrc'
export const CONTROL_API_ISSUER = 'control-api'

let cachedWrcPublicKey: Awaited<ReturnType<typeof importSPKI>> | null = null
let cachedControlApiPublicKey: Awaited<ReturnType<typeof importSPKI>> | null = null

export async function initializePublicKey(publicKeyPem: string): Promise<void> {
  cachedWrcPublicKey = await importSPKI(publicKeyPem, 'RS256')
}

export async function initializeControlApiPublicKey(publicKeyPem: string): Promise<void> {
  cachedControlApiPublicKey = await importSPKI(publicKeyPem, 'RS256')
}

export async function verifyIncomingToken(
  token: string
): Promise<AuthenticatedRequest['tokenClaims']> {
  if (!token) throw new Error('Missing token')

  let unverified: JWTPayload
  try {
    unverified = decodeJwt(token)
  } catch {
    throw new Error('Malformed token')
  }

  const iss = unverified.iss
  if (typeof iss !== 'string') throw new Error('Token missing iss claim')

  let key: Awaited<ReturnType<typeof importSPKI>> | null
  let expectedIssuer: string
  if (iss === WRC_ISSUER) {
    key = cachedWrcPublicKey
    expectedIssuer = WRC_ISSUER
  } else if (iss === CONTROL_API_ISSUER) {
    key = cachedControlApiPublicKey
    expectedIssuer = CONTROL_API_ISSUER
  } else {
    throw new Error(`Unknown token issuer: ${iss}`)
  }

  if (!key) throw new Error(`Public key for issuer '${iss}' not initialized`)

  const { payload } = await jwtVerify(token, key, {
    audience: 'clerum-wrc',
    issuer: expectedIssuer,
  })

  const sub = payload.sub
  const aud = typeof payload.aud === 'string' ? payload.aud : payload.aud?.[0]
  const recipeName = (payload as JWTPayload & { recipeName?: string }).recipeName
  const recipeNamespace = (payload as JWTPayload & { recipeNamespace?: string }).recipeNamespace
  const runId = (payload as JWTPayload & { runId?: string }).runId
  const artifactName = (payload as JWTPayload & { artifactName?: string }).artifactName
  const scopes = (payload as JWTPayload & { scopes?: string[] }).scopes ?? []

  if (!sub) throw new Error('JWT missing required claim: sub')
  if (!aud) throw new Error('JWT missing required claim: aud')
  if (!recipeName) throw new Error('JWT missing required claim: recipeName')
  if (!recipeNamespace) throw new Error('JWT missing required claim: recipeNamespace')

  return {
    sub,
    aud,
    iss: expectedIssuer,
    recipeName,
    recipeNamespace,
    ...(typeof runId === 'string' ? { runId } : {}),
    ...(typeof artifactName === 'string' ? { artifactName } : {}),
    scopes,
  }
}
