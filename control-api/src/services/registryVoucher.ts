// control-api/src/services/registryVoucher.ts
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import type { AdminUserRecord } from './adminAuthService.js'
import { VoucherUnavailableError, resolveVoucherSigningMaterial } from './registryConnectionDb.js'

// Re-export so existing importers (routes/registry.ts, tests) keep their path.
// The authoritative class lives in registryConnectionDb.ts so
// resolveVoucherSigningMaterial can throw it without cycling through here.
export { VoucherUnavailableError }

/**
 * Mint a one-time, 60s RS256 identity voucher for POST /user/exchange.
 *
 * VOUCHER V2 (spec §6.4/§14.6): header carries `kid` (the registry-assigned
 * key_id); payload is EXACTLY {iss,aud,sub,jti,exp} — no email/username/iat.
 * kid + signing key are resolved MODE-AWARE (managed=env, self-hosted=DB row).
 *
 * Fail-closed (M3 cutover done): if v2 material is unavailable this throws
 * VoucherUnavailableError. There is NO legacy no-kid fallback — the break-glass
 * path and the registry's no-kid transition branch were deleted at M3.
 */
export async function mintIdentityVoucher(admin: AdminUserRecord): Promise<string> {
  const { signingKey, kid } = await resolveVoucherSigningMaterial()
  return jwt.sign({ sub: admin.id, jti: randomUUID() }, signingKey, {
    algorithm: 'RS256',
    issuer: 'control-api',
    audience: 'registry-api',
    expiresIn: '60s',
    noTimestamp: true, // drop iat → payload EXACTLY {sub,jti,iss,aud,exp}
    keyid: kid,
  })
}
