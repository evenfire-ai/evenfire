import type { OidcMemberSignInPolicy } from './configuration.js'
import type { OidcVerifiedClaimObservation, VerifiedOidcIdentityProof } from './protocolEngine.js'

export type OidcEligibility =
  | Readonly<{ eligible: true; guest: boolean }>
  | Readonly<{ eligible: false; reason: 'not_eligible' }>

export type OidcEmailState = 'verified' | 'unverified' | 'missing_claim' | 'no_email'

const NOT_ELIGIBLE: OidcEligibility = Object.freeze({ eligible: false, reason: 'not_eligible' })

/** Claims whose "unsupported" observation means we cannot judge eligibility. */
const ELIGIBILITY_CLAIMS = ['tid', 'idp', 'roles', 'acct', 'email_verified'] as const

/**
 * The `idp` value Entra puts in a member's token for its own tenant.
 * UNVERIFIED: confirm on a real tenant (scope Decision 6)
 */
export function entraTenantIdp(tenantId: string): string {
  return `https://sts.windows.net/${tenantId}/`
}

function observe(proof: VerifiedOidcIdentityProof, name: string): OidcVerifiedClaimObservation {
  // A claim absent from the evidence is the same as a missing one.
  return proof.verifiedClaims.claims[name] ?? { status: 'missing' }
}

export function evaluateOidcEligibility(
  proof: VerifiedOidcIdentityProof,
  policy: OidcMemberSignInPolicy
): OidcEligibility {
  for (const name of ELIGIBILITY_CLAIMS) {
    if (observe(proof, name).status === 'unsupported') return NOT_ELIGIBLE
  }

  let guest = false
  if (policy.entraTenantId !== null) {
    const tid = observe(proof, 'tid')
    if (tid.status !== 'present' || tid.value !== policy.entraTenantId) return NOT_ELIGIBLE
    const acct = observe(proof, 'acct')
    const idp = observe(proof, 'idp')
    guest =
      (acct.status === 'present' && acct.value === 1) ||
      (idp.status === 'present' && idp.value !== entraTenantIdp(policy.entraTenantId))
    if (guest && !policy.allowGuests) return NOT_ELIGIBLE
  }

  if (policy.requiredRole !== null) {
    const roles = observe(proof, 'roles')
    if (
      roles.status !== 'present' ||
      !Array.isArray(roles.value) ||
      !roles.value.every(role => typeof role === 'string') ||
      !roles.value.includes(policy.requiredRole)
    ) {
      return NOT_ELIGIBLE
    }
  }

  return Object.freeze({ eligible: true, guest })
}

export function oidcEmailState(
  proof: VerifiedOidcIdentityProof,
  policy: OidcMemberSignInPolicy,
  guest: boolean
): OidcEmailState {
  if (typeof proof.attributes.email !== 'string' || proof.attributes.email === '') return 'no_email'
  const claim = observe(proof, 'email_verified')
  if (claim.status === 'present') return claim.value === true ? 'verified' : 'unverified'
  if (claim.status === 'missing' && policy.entraTenantId !== null && !guest) return 'missing_claim'
  return 'unverified'
}
