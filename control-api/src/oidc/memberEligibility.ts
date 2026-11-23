import type { OidcMemberSignInPolicy } from './configuration.js'
import type { OidcVerifiedClaimObservation, VerifiedOidcIdentityProof } from './protocolEngine.js'

export type OidcEligibility =
  | Readonly<{ eligible: true; guest: boolean }>
  | Readonly<{ eligible: false; reason: 'not_eligible' }>

/**
 * `no_email`: the claim is absent, empty or not a plausible address.
 * `domain_claim_missing`: an Entra member's token has neither `email_verified`
 * nor `xms_edov`, so the app registration is not configured to send the proof.
 */
export type OidcEmailState = 'verified' | 'unverified' | 'domain_claim_missing' | 'no_email'

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

/**
 * The claims member eligibility reads (tenant, guest markers, roles) beyond the
 * email claims the protocol engine always keeps. The member sign-in route builds
 * its engine with exactly these, so each is kept as verified evidence.
 */
export const MEMBER_POLICY_EVIDENCE_CLAIM_NAMES = Object.freeze([
  'tid',
  'idp',
  'roles',
  'acct',
  'xms_edov',
] as const)

/** Claims whose "unsupported" observation means we cannot judge eligibility. */
const ELIGIBILITY_CLAIMS = ['tid', 'idp', 'roles', 'acct', 'email_verified', 'xms_edov'] as const

/**
 * Whether an `idp` claim value names the pinned tenant's own directory.
 * Microsoft's "ID token claims reference" page documents `idp` as identical to
 * the `iss` claim unless the user's account is not in the same tenant as the
 * issuer, and says that when the claim is absent `iss` can be used instead. So
 * the proof's own issuer counts. The v1 issuer form
 * `https://sts.windows.net/<tenant>/` names the same pinned tenant, so it counts
 * too. Any other value is a guest's home directory.
 * UNVERIFIED: not yet confirmed against ID tokens captured from a real tenant.
 */
export function isEntraSameTenantIdp(idp: unknown, issuer: string, tenantId: string): boolean {
  return idp === issuer || idp === `https://sts.windows.net/${tenantId}/`
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
    // the number 0 and `idp` a same-tenant value (see isEntraSameTenantIdp).
    // Any other present value counts as a guest, so an unexpected shape fails
    // closed.
    const memberByAcct = acct.status !== 'present' || acct.value === 0
    const memberByIdp =
      idp.status !== 'present' ||
      isEntraSameTenantIdp(idp.value, proof.issuer, policy.entraTenantId)
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

/**
 * Whether the claim's email may find or create an account.
 *
 * Entra does not send `email_verified` for members, so for an Entra connection
 * and a non-guest with no `email_verified` the proof is the optional claim
 * `xms_edov`. Microsoft's optional claims reference documents it as a boolean
 * saying whether the email's domain owner has been verified: the email belongs
 * to the tenant where the user account resides and the tenant admin has verified
 * the domain. It is returned only when the `email` claim is present. It attests
 * the domain, not the mailbox: a spoof inside the tenant's own verified domain
 * is not stopped by it.
 * UNVERIFIED: the claim's shape is not yet confirmed against ID tokens captured
 * from a real tenant.
 *
 * `email_verified`, when present, decides as it always did. A guest with no
 * `email_verified` is unverified (`xms_edov` does not help a guest), and a
 * non-Entra connection ignores `xms_edov`.
 */
export function oidcEmailState(
  proof: VerifiedOidcIdentityProof,
  policy: OidcMemberSignInPolicy,
  guest: boolean
): OidcEmailState {
  if (!isPlausibleEmail(proof.attributes.email)) return 'no_email'
  const claim = observe(proof, 'email_verified')
  if (claim.status === 'present') return claim.value === true ? 'verified' : 'unverified'
  if (claim.status === 'missing' && policy.entraTenantId !== null && !guest) {
    const domain = observe(proof, 'xms_edov')
    if (domain.status === 'missing') return 'domain_claim_missing'
    return domain.status === 'present' && domain.value === true ? 'verified' : 'unverified'
  }
  return 'unverified'
}
