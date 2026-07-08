/**
 * Issuer → subject-class enforcement for gfs token minting (spec community.md
 * §Mint: two contracts).
 *
 * Only control-api mints gfs tokens, and each provisioner may mint ONLY its own
 * subject class — a provisioner can never escalate into another identity class:
 *
 *   issuer `hcc`     → `host` with party `1st`   (an HCC-provisioned Host)
 *   issuer `wrc`     → `host` with party `3rd`   (a recipe's mcp-host)
 *   issuer `session` → `user`                    (an authenticated user session)
 *
 * Any other (issuer, subjectType, party) triple is denied (deny-by-default).
 * This module is pure — no I/O — so it is unit-tested directly.
 */

export type GfsIssuer = 'hcc' | 'wrc' | 'session'
export type GfsMintableSubjectType = 'user' | 'host'
export type HostParty = '1st' | '3rd'

export class IssuerSubjectClassError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'IssuerSubjectClassError'
  }
}

export interface MintRequestClass {
  issuer: GfsIssuer
  subjectType: GfsMintableSubjectType
  /** Required when subjectType === 'host'; ignored otherwise. */
  party?: HostParty
}

/** The single authoritative mapping. Adding a row is the ONLY way to allow a cross. */
const ALLOWED: ReadonlyArray<{ issuer: GfsIssuer; subjectType: GfsMintableSubjectType; party?: HostParty }> = [
  { issuer: 'hcc', subjectType: 'host', party: '1st' },
  { issuer: 'wrc', subjectType: 'host', party: '3rd' },
  { issuer: 'session', subjectType: 'user' },
]

export function isIssuerAllowedForSubject(req: MintRequestClass): boolean {
  return ALLOWED.some(
    (row) =>
      row.issuer === req.issuer &&
      row.subjectType === req.subjectType &&
      // party is only meaningful for host; for user both sides are undefined.
      (row.subjectType === 'host' ? row.party === req.party : true)
  )
}

/**
 * Throw IssuerSubjectClassError unless `req` is an explicitly-allowed
 * (issuer, subjectType, party) cross. Callers wrap this around token minting so
 * an unauthorized issuer→subject cross is denied before any token is signed.
 */
export function assertIssuerMaySubject(req: MintRequestClass): void {
  if (req.subjectType === 'host' && req.party === undefined) {
    throw new IssuerSubjectClassError('party_required', 'a host subject requires a party (1st|3rd)')
  }
  if (!isIssuerAllowedForSubject(req)) {
    throw new IssuerSubjectClassError(
      'issuer_subject_forbidden',
      `issuer ${req.issuer} may not mint subject ${req.subjectType}${req.party ? `:${req.party}` : ''}`
    )
  }
}
