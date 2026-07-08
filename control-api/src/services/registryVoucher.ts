// control-api/src/services/registryVoucher.ts
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import type { AdminUserRecord } from './adminAuthService.js'

/** Thrown when no signing key is configured (caller maps to 500 registry_voucher_unavailable). */
export class VoucherUnavailableError extends Error {
  constructor() {
    super('registry_voucher_unavailable')
    this.name = 'VoucherUnavailableError'
  }
}

/**
 * Build the registry username for a control-api admin's synthetic identity.
 *
 * Namespaced by the registry client id so it is:
 *  (a) never a registry-reserved bareword (`admin`, `root`, `api`, `registry`, …),
 *      which the registry rejects with 409 reserved_username at user-creation; and
 *  (b) globally unique per deployment — two control-api instances' `admin` accounts
 *      map to distinct registry users (`clerum-dev-control-api-admin` vs
 *      `clerum-prod-control-api-admin`) instead of colliding on a single global
 *      `admin` on the shared registry.
 *
 * Output conforms to the registry username pattern `^[a-z0-9][a-z0-9_-]{0,62}$`.
 */
export function registrySyntheticUsername(admin: AdminUserRecord): string {
  const prefix = (config.registryClientId || 'control-api').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  const namePart = (admin.username || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  let u = `${prefix}-${namePart}`.replace(/-+/g, '-').replace(/^[^a-z0-9]+/, '')
  if (u.length > 63) u = u.slice(0, 63)
  u = u.replace(/[-_]+$/, '')
  // Ultimate fallback (only if prefix + name sanitize to nothing): the admin id,
  // a globally-unique UUID that is already pattern-conformant.
  return u || admin.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
}

/**
 * Mint a one-time, 60s RS256 identity voucher for the registry's POST /user/exchange.
 * The registry links the user by `sub` (control-api admin id); `username`/`email` are a
 * deployment-namespaced synthetic identity (see {@link registrySyntheticUsername}).
 * Signing-key precedence MUST be `||`: registryVoucherPrivateKey defaults to '' and
 * "empty means fall back to adminJwtPrivateKey".
 */
export function mintIdentityVoucher(admin: AdminUserRecord): string {
  const signingKey = config.registryVoucherPrivateKey || config.adminJwtPrivateKey
  if (!signingKey) throw new VoucherUnavailableError()
  const username = registrySyntheticUsername(admin)
  return jwt.sign(
    { sub: admin.id, email: `${username}@control-api.local`, username, jti: randomUUID() },
    signingKey,
    { algorithm: 'RS256', issuer: 'control-api', audience: 'registry-api', expiresIn: '60s' }
  )
}
