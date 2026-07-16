// control-api/src/services/registryPopSigner.ts
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'

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
  return jwt.sign({ sub: input.sub, jti: randomUUID() }, input.privateKeyPem, {
    algorithm: 'RS256',
    audience: 'registry-api',
    expiresIn: input.ttlSeconds ?? 120,
    noTimestamp: true,
    ...(input.kid ? { keyid: input.kid } : {}),
  })
}
