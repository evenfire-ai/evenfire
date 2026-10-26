import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../../src/config.js'
import {
  type ResolvedHostBinding,
  resolveBrokerHostBinding,
} from '../../src/services/access/brokerHostBinding.js'
import type { MockGateway } from '../mockGateway.js'

type Provisioner = 'hcc' | 'wrc'

/**
 * Internal control JWT a provisioner (host-context-controller / workflow-recipes)
 * presents to the issuance route, signed with that provisioner's HMAC secret.
 */
export function signInternalControlJwt(iss: Provisioner | string): string {
  const secret =
    iss === 'hcc' ? config.internalControlJwtHccHmacSecret : config.internalControlJwtWrcHmacSecret
  return jwt.sign({ iss, aud: 'control-api', sub: `${iss}-provisioner` }, secret, {
    algorithm: 'HS256',
    expiresIn: 60,
    jwtid: `${iss}-test-jti-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })
}

/**
 * The control token ("gafete") host-context-controller obtains for `host`,
 * minted through the real issuance route with the uid of the Host CR the
 * gateway holds. Going through the route (not the signing function) means a
 * route that stops forwarding host_uid turns every broker suite red.
 */
export async function mintHccControlToken(
  app: Parameters<typeof request>[0],
  gateway: MockGateway,
  host: string,
  scopes: string[] = ['oauth:user-token']
): Promise<string> {
  const cr = (await gateway.getResource('hosts', host, config.hostsNamespace)) as {
    metadata: { uid: string }
  }
  const res = await request(app)
    .post(`/api/v1/auth/mcp-host/${config.hostsNamespace}/standalone/tokens`)
    .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
    .send({
      includeMcpHostControlToken: true,
      workflowControlScopes: scopes,
      host,
      hostUid: cr.metadata.uid,
    })
  if (res.status !== 200) {
    throw new Error(`hcc control token issuance failed: ${res.status} ${res.text}`)
  }
  return res.body.mcpHostControlToken as string
}

/**
 * The live binding the broker resolves for an HCC control token of `host`
 * (uid read back from the Host CR, as the issuance route signs it), produced by
 * the real `resolveBrokerHostBinding`. For suites that drive the grant-existence
 * resolver directly; throws when the seeded state does not bind.
 */
export async function resolveHccHostBinding(
  gateway: MockGateway,
  host: string
): Promise<ResolvedHostBinding> {
  const cr = (await gateway.getResource('hosts', host, config.hostsNamespace)) as {
    metadata: { uid: string }
  }
  const binding = await resolveBrokerHostBinding(gateway, host, cr.metadata.uid, config)
  if (binding.kind !== 'ok') throw new Error(`host ${host} does not bind: ${binding.kind}`)
  return binding
}

/**
 * A control token shaped like those issued before host_uid existed, or forged
 * with the signing key. Declared exception to deriving fixtures from the
 * producer: the current issuer strips `oauth:user-token` from any non-HCC
 * token and always signs host_uid on HCC ones, so it can no longer emit these
 * shapes, yet live or stolen tokens may still carry them. Claims mirror what
 * `issueMcpHostControlJwt` signs.
 */
export function signLegacyControlToken(claims: {
  recipeNamespace: string
  recipeName: string
  hostRefs: string[]
  scopes?: string[]
  host_uid?: string
}): string {
  return jwt.sign(
    {
      sub: `${claims.recipeNamespace}/${claims.recipeName}`,
      recipeNamespace: claims.recipeNamespace,
      recipeName: claims.recipeName,
      hostRefs: claims.hostRefs,
      typ: 'service',
      scopes: claims.scopes ?? ['oauth:user-token'],
      ...(claims.host_uid !== undefined ? { host_uid: claims.host_uid } : {}),
    },
    config.adminJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.adminJwtIssuer,
      audience: 'mcp-host',
      jwtid: `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      expiresIn: 300,
    }
  )
}
