import type { OidcMemberSignInPolicy } from './configuration.js'
import type { OidcVerifiedClaimObservation, VerifiedOidcIdentityProof } from './protocolEngine.js'

export type OidcEligibility =
  | Readonly<{ eligible: true; guest: boolean }>
  | Readonly<{ eligible: false; reason: 'not_eligible' }>

/** `no_email`: the claim is absent, empty or not a plausible address. */
export type OidcEmailState = 'verified' | 'unverified' | 'missing_claim' | 'no_email'

const NOT_ELIGIBLE: OidcEligibility = Object.freeze({ eligible: false, reason: 'not_eligible' })

const MAX_EMAIL_LENGTH = 320
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Printable ASCII without space: no whitespace, control or non-ASCII characters. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/

/**
 * A plausible address: printable ASCII only, one '@', a dot in the domain, at
 * most 320 characters. It is not trimmed: surrounding whitespace makes the
 * claim malformed. Non-ASCII is refused because PostgreSQL lower() folds some
 * non-ASCII letters to ASCII (U+0130 to 'i', U+212A to 'k'), so a claim for a
 * different mailbox could match another account's lowercased address.
 */
function isPlausibleEmail(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_EMAIL_LENGTH &&
    PRINTABLE_ASCII.test(value) &&
    EMAIL_SHAPE.test(value)
  )
}

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
    // A member only when each marker that is present says so: `acct` exactly
    // the number 0 and `idp` the tenant's own issuer. Any other present value
    // counts as a guest, so an unexpected shape fails closed.
    const memberByAcct = acct.status !== 'present' || acct.value === 0
    const memberByIdp =
      idp.status !== 'present' || idp.value === entraTenantIdp(policy.entraTenantId)
    guest = !(memberByAcct && memberByIdp)
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
  if (!isPlausibleEmail(proof.attributes.email)) return 'no_email'
  const claim = observe(proof, 'email_verified')
  if (claim.status === 'present') return claim.value === true ? 'verified' : 'unverified'
  if (claim.status === 'missing' && policy.entraTenantId !== null && !guest) return 'missing_claim'
  return 'unverified'
}
