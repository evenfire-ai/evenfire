// control-api/src/services/registryPopSigner.ts
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import {
  JwtKeyMaterialError,
  type JwtKeyMaterialReason,
  type SigningMaterial,
  parseSigningMaterial,
} from '@clerum/jwt-key-policy'

/** Permanent local key failure; registry transport retries cannot repair it. */
export class RegistrySigningMaterialUnavailableError extends Error {
  constructor(readonly reason: JwtKeyMaterialReason) {
    super('registry_signing_material_unavailable')
    this.name = 'RegistrySigningMaterialUnavailableError'
  }
}

/**
 * Self-signed proof-of-possession JWT (spec §4 / S1). Proves the caller holds a
 * deployment private key. aud='registry-api', unique jti, short exp.
 *  - register: pass NO kid (verified by the registry against the body pubkey);
 *    goes in the request body `pop`.
 *  - status/claim: pass kid=<key_id>; goes in the `DPoP` request header.
 */
export function signPop(input: {
  privateKeyPem: string
  sub: string
  kid?: string
  ttlSeconds?: number
}): string {
  let material: SigningMaterial
  try {
    material = parseSigningMaterial(input.privateKeyPem, 'Registry proof-of-possession signing key')
  } catch (error) {
    if (!(error instanceof JwtKeyMaterialError)) throw error
    throw new RegistrySigningMaterialUnavailableError(error.reason)
  }
  return jwt.sign({ sub: input.sub, jti: randomUUID() }, material.privatePem, {
    algorithm: 'RS256',
    audience: 'registry-api',
    expiresIn: input.ttlSeconds ?? 120,
    noTimestamp: true,
    ...(input.kid ? { keyid: input.kid } : {}),
  })
}
