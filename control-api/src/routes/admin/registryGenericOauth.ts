import { z } from 'zod'
import {
  type DnsResolver,
  type ValidationError,
  validateOAuthEndpointUrl,
} from '../../http/validateMcpServerSpec.js'
import { type GenericOAuthKnobs, GenericOAuthKnobsSchema } from '../../oauth/genericKnobs.js'

/**
 * Install-side wiring for the `source:'generic'` carril (S3-B4). Kept in this leaf
 * module — depending only on the knob schema + the kernel §4 seam — so
 * `registry.ts`'s install saga can import it without an import cycle (the shared
 * `InstallOAuthSecretSchema` lives here for the same reason, reused by the baked
 * input schema in `registry.ts`).
 */

// Operator-supplied OAuth credential Secret on the install request. Either MANAGED
// (operator types values → control-api creates the Secret) or a REFERENCE to an
// existing Secret whose id/secret keys the operator names. Shared by the baked and
// the generic input schemas.
export const InstallOAuthSecretSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('managed'),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  }),
  z.object({
    mode: z.literal('reference'),
    secretName: z.string().min(1),
    clientIdKey: z.string().min(1),
    clientSecretKey: z.string().min(1),
  }),
])

export type InstallOAuthSecret = z.infer<typeof InstallOAuthSecretSchema>

/**
 * Operator input for a `provider:'generic'` install. `secret` is OPTIONAL — a public
 * generic client (D-A5) carries no Secret and its `client_id` IS `oauth.id` (DA-1).
 * The knobs are the operator-pinned endpoints + wire configuration.
 */
export const InstallGenericOAuthInputSchema = z.object({
  scopes: z.array(z.string()).optional(),
  grantScope: z.enum(['user', 'context']).optional(),
  secret: InstallOAuthSecretSchema.optional(),
  generic: GenericOAuthKnobsSchema,
})

export type InstallGenericOAuthInput = z.infer<typeof InstallGenericOAuthInputSchema>

/**
 * Kernel §4 (spec 19 §4) over every operator-typed endpoint, BEFORE the CR exists.
 * The generic endpoints are immutable by CEL and `authorizationEndpoint` is never
 * re-validated after install (runtime only IP-pins the token/refresh POST), so this
 * admission check is the only gate on the authorize URL. Returns [] when all pass;
 * each `field` is prefixed `oauth.generic.<knob>` for field-level UI feedback.
 */
export async function validateGenericEndpoints(
  knobs: GenericOAuthKnobs,
  options: { resolveDns?: DnsResolver } = {}
): Promise<ValidationError[]> {
  const checks: Array<{ field: string; url: string }> = [
    { field: 'oauth.generic.authorizationEndpoint', url: knobs.authorizationEndpoint },
    { field: 'oauth.generic.tokenEndpoint', url: knobs.tokenEndpoint },
  ]
  if (knobs.refreshEndpoint) {
    checks.push({ field: 'oauth.generic.refreshEndpoint', url: knobs.refreshEndpoint })
  }
  if (knobs.resource) {
    // RFC 8707 resource is an absolute URL; on a self-hosted AS it is resoluble, so
    // it passes the same kernel as the endpoints (spec 19 §4 lists all four).
    checks.push({ field: 'oauth.generic.resource', url: knobs.resource })
  }
  const errors: ValidationError[] = []
  for (const check of checks) {
    errors.push(...(await validateOAuthEndpointUrl(check.url, check.field, options)))
  }
  return errors
}

export interface GenericOAuthSpecRefs {
  clientIdRef: { name: string; key: string }
  clientSecretRef: { name: string; key: string }
}

/**
 * Pure map from install input → the flat `spec.oauth` generic object (DEC-28). Writes
 * `source:'generic'` + the 10 GENERIC-REQ knobs explicitly, plus the optional knobs
 * only when present, plus `scopes`/`grantScope`. Refs are paired — BOTH
 * (confidential) or NEITHER (public), per GENERIC-SECRET-PAIRING. NEVER `provider`,
 * `clientMode`, `issuer`, `registrationEndpoint`, `issForCallback`, `bearerInBody`
 * (GENERIC-FORBID-REMOTE-FIELDS).
 */
export function buildGenericOAuthSpec(args: {
  id: string
  knobs: GenericOAuthKnobs
  scopes: string[]
  grantScope: 'user' | 'context'
  refs?: GenericOAuthSpecRefs
}): Record<string, unknown> {
  const { id, knobs, scopes, grantScope, refs } = args
  const oauth: Record<string, unknown> = {
    source: 'generic',
    id,
    authorizationEndpoint: knobs.authorizationEndpoint,
    tokenEndpoint: knobs.tokenEndpoint,
    tokenRequestFormat: knobs.tokenRequestFormat,
    tokenAuthMethod: knobs.tokenAuthMethod,
    scopeSeparator: knobs.scopeSeparator,
    sendScope: knobs.sendScope,
    usePkce: knobs.usePkce,
    includeResponseType: knobs.includeResponseType,
    supportsRefresh: knobs.supportsRefresh,
    scopes,
    grantScope,
  }
  if (knobs.refreshEndpoint) oauth.refreshEndpoint = knobs.refreshEndpoint
  if (knobs.resource) oauth.resource = knobs.resource
  if (knobs.extraAuthorizeParams && Object.keys(knobs.extraAuthorizeParams).length > 0) {
    oauth.extraAuthorizeParams = knobs.extraAuthorizeParams
  }
  if (refs) {
    oauth.clientIdRef = refs.clientIdRef
    oauth.clientSecretRef = refs.clientSecretRef
  }
  return oauth
}
