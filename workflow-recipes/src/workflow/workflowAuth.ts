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

export interface PluginSdkBrokerCallerClaims {
  sub: string
  /** Access JWT scope; refresh JWTs must never redeem SDK credential tickets. */
  scope: 'workflow:approval:request'
  recipeName: string
  recipeNamespace: string
  workflowControlScopes: string[]
}

export interface PluginSdkCredentialTicketClaims {
  jti: string
  recipeName: string
  recipeNamespace: string
  invocationId: string
  targetRef: string
  provider: string
  model: string
  credentialSlot: string
  policyRevision: number
  policyHash: string
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

/** Verify the mcp-host runtime JWT without weakening the workflow REST audience. */
export async function verifyPluginSdkBrokerCallerToken(
  token: string
): Promise<PluginSdkBrokerCallerClaims> {
  if (!token) throw new Error('Missing token')
  if (!cachedControlApiPublicKey) throw new Error('Control API public key not initialized')
  const { payload } = await jwtVerify(token, cachedControlApiPublicKey, {
    audience: 'workflow-approvals',
    issuer: CONTROL_API_ISSUER,
  })
  const claims = payload as JWTPayload & {
    scope?: unknown
    recipeName?: unknown
    recipeNamespace?: unknown
    workflowControlScopes?: unknown
  }
  if (
    typeof claims.sub !== 'string' ||
    claims.scope !== 'workflow:approval:request' ||
    typeof claims.recipeName !== 'string' ||
    typeof claims.recipeNamespace !== 'string' ||
    !Array.isArray(claims.workflowControlScopes) ||
    !claims.workflowControlScopes.every(scope => typeof scope === 'string')
  ) {
    throw new Error('JWT missing required broker claims')
  }
  if (claims.sub !== `${claims.recipeNamespace}/${claims.recipeName}`) {
    throw new Error('JWT broker subject binding mismatch')
  }
  return {
    sub: claims.sub,
    scope: 'workflow:approval:request',
    recipeName: claims.recipeName,
    recipeNamespace: claims.recipeNamespace,
    workflowControlScopes: claims.workflowControlScopes,
  }
}

/** Verify the short-lived ticket and return only its exact target binding. */
export async function verifyPluginSdkCredentialTicket(
  token: string
): Promise<PluginSdkCredentialTicketClaims> {
  if (!token) throw new Error('Missing credential ticket')
  if (!cachedControlApiPublicKey) throw new Error('Control API public key not initialized')
  const { payload } = await jwtVerify(token, cachedControlApiPublicKey, {
    audience: 'plugin-sdk-credential-broker',
    issuer: CONTROL_API_ISSUER,
  })
  const claims = payload as JWTPayload & Record<string, unknown>
  if (
    typeof claims.jti !== 'string' ||
    claims.typ !== 'plugin-sdk-credential-ticket' ||
    typeof claims.recipeName !== 'string' ||
    typeof claims.recipeNamespace !== 'string' ||
    typeof claims.invocationId !== 'string' ||
    typeof claims.targetRef !== 'string' ||
    typeof claims.provider !== 'string' ||
    typeof claims.model !== 'string' ||
    typeof claims.credentialSlot !== 'string' ||
    !Number.isInteger(claims.policyRevision) ||
    (claims.policyRevision as number) < 1 ||
    typeof claims.policyHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(claims.policyHash)
  ) {
    throw new Error('Credential ticket has invalid claims')
  }
  if (claims.sub !== `${claims.recipeNamespace}/${claims.recipeName}`) {
    throw new Error('Credential ticket subject binding mismatch')
  }
  return {
    jti: claims.jti as string,
    recipeName: claims.recipeName,
    recipeNamespace: claims.recipeNamespace,
    invocationId: claims.invocationId,
    targetRef: claims.targetRef,
    provider: claims.provider,
    model: claims.model,
    credentialSlot: claims.credentialSlot,
    policyRevision: claims.policyRevision as number,
    policyHash: claims.policyHash,
  }
}
