import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../../config.js'

// Derive the SPKI PEM at module load, mirroring adminAuthToken.ts:6-8.
// WRC imports this PEM via jose.importSPKI() to verify delegation JWTs
// whose `iss` claim is "control-api".
const controlApiPublicKeyPem = createPublicKey(config.adminJwtPrivateKey)
  .export({ type: 'spki', format: 'pem' })
  .toString()

export type WrcDelegationScope = 'artifact_read' | 'admin:artifact_read' | 'admin:artifact_delete'

export interface SignWrcDelegationTokenInput {
  adminUserId: string
  recipeName: string
  // Required: the target namespace where the WorkflowRecipe CRD lives. WRC
  // cross-checks this claim against the URL/state it resolves internally,
  // and rejects tokens without the claim ("JWT missing required claim:
  // recipeNamespace"). Callers should determine the namespace via the
  // same canonical namespace lookup used by recipe GET/PUT/DELETE
  // (findRecipeNamespace in routes/admin/recipes.ts).
  recipeNamespace: string
  runId?: string
  artifactName?: string
  subject?: string
  scope: WrcDelegationScope
}

const DELEGATION_TTL_SECONDS = 60
const DELEGATION_ISSUER = 'control-api' as const
const DELEGATION_AUDIENCE = 'clerum-wrc' as const

/**
 * Sign a short-lived RS256 delegation JWT that control-api presents to WRC
 * (workflow-recipes) when proxying admin operations on a WorkflowRecipe —
 * currently artifact downloads.
 *
 * The token is single-use in practice: 60s TTL, per-request signing, no caching.
 * WRC verifies the signature with the control-api SPKI public key (emitted via
 * {@link getControlApiPublicKeyPem}) and enforces the `recipeName` + `scopes`
 * claims before re-signing a fresh WRC→mcp-host token for the downstream hop.
 *
 * Claim layout (aligns with the dual-issuer spec in §5.5.2 of the plan):
 * - `iss: "control-api"` — identifies the signer
 * - `aud: "clerum-wrc"` — constrains where the token is accepted
 * - `sub: "admin:<userId>"` — carries admin attribution all the way to mcp-host audit logs
 * - `recipeName` — binds the token to a single recipe (WRC cross-checks against URL path)
 * - `scopes` — principle of least privilege; only artifact_read or artifact_delete
 * - `exp: +60s`, `iat: now`, `jti: uuid` — ephemeral, uniquely identifiable
 */
export function signWrcDelegationToken(input: SignWrcDelegationTokenInput): string {
  return jwt.sign(
    {
      sub: input.subject ?? `admin:${input.adminUserId}`,
      recipeName: input.recipeName,
      recipeNamespace: input.recipeNamespace,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.artifactName ? { artifactName: input.artifactName } : {}),
      scopes: [input.scope],
      jti: randomUUID(),
    },
    config.adminJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: DELEGATION_ISSUER,
      audience: DELEGATION_AUDIENCE,
      expiresIn: DELEGATION_TTL_SECONDS,
    }
  )
}

/**
 * Return the control-api SPKI public key in PEM format so deploy tooling can
 * materialize it into a ConfigMap mounted by WRC. Reuses the same private key
 * as the admin JWT path because control-api already owns the keypair and WRC
 * only ever verifies — never signs — with this key.
 */
export function getControlApiPublicKeyPem(): string {
  return controlApiPublicKeyPem
}
