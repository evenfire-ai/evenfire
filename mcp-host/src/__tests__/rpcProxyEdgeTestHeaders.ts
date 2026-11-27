import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import {
  HOST_EDGE_ASSERTION_AUDIENCE,
  HOST_EDGE_ASSERTION_CLAIM_TYPE,
  HOST_EDGE_ASSERTION_HEADER,
  HOST_EDGE_ASSERTION_JWT_TYPE,
  HOST_EDGE_ASSERTION_MAX_TTL_SECONDS,
  HOST_EDGE_RPC_PROXY_ROUTE_SCOPES,
} from '@clerum/action-context-contracts'

/** Every scope a Host route can require from an rpc-proxy edge assertion. */
export const ALL_HOST_EDGE_ROUTE_SCOPES: readonly string[] = [
  ...new Set(Object.values(HOST_EDGE_RPC_PROXY_ROUTE_SCOPES)),
]

export interface HostEdgeTestAssertionInput {
  sub: string
  /** `<namespace>/<hostName>` of the Host the assertion is for. */
  host: string
  teamId?: string | null
  scopes?: readonly string[]
  v?: number
  iat?: number
  exp?: number
  /** Claims added to (or, when undefined, removed from) the signed payload. */
  claims?: Record<string, unknown>
  privateKey?: string
  algorithm?: jwt.Algorithm
  headerType?: string
  audience?: string
  issuer?: string
}

function rpcSigningKey(): string {
  const key = process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY
  if (!key) throw new Error('Vitest RPC signing key is not installed')
  return key
}

/** The Host identity an assertion must name, as the Host config derives it. */
export function hostEdgeTestHost(hostName: string): string {
  return `${process.env.CLERUM_NAMESPACE ?? 'default'}/${hostName}`
}

/**
 * Signs an edge assertion the way control-api signs it: RS256 with the RPC
 * signing key, header `typ`, audience, issuer and a UUID `jwtid`.
 */
export function signHostEdgeTestAssertion(input: HostEdgeTestAssertionInput): string {
  const iat = input.iat ?? Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    typ: HOST_EDGE_ASSERTION_CLAIM_TYPE,
    v: input.v ?? 1,
    sub: input.sub,
    host: input.host,
    iat,
    exp: input.exp ?? iat + HOST_EDGE_ASSERTION_MAX_TTL_SECONDS,
    teamId: input.teamId ?? null,
    scopes: [...(input.scopes ?? ALL_HOST_EDGE_ROUTE_SCOPES)],
  }
  for (const [key, value] of Object.entries(input.claims ?? {})) {
    if (value === undefined) delete payload[key]
    else payload[key] = value
  }
  const algorithm = input.algorithm ?? 'RS256'
  return jwt.sign(payload, input.privateKey ?? rpcSigningKey(), {
    algorithm,
    header: { alg: algorithm, typ: input.headerType ?? HOST_EDGE_ASSERTION_JWT_TYPE },
    audience: input.audience ?? HOST_EDGE_ASSERTION_AUDIENCE,
    issuer: input.issuer ?? process.env.CLERUM_AUTH_JWT_ISSUER ?? 'control-api',
    jwtid: randomUUID(),
  })
}

/**
 * Adds the edge assertion rpc-proxy forwards for these clear headers: same
 * user, team and Host, and every Host route scope (as a Desktop token holds).
 */
export function withRpcProxyEdgeTestAuthentication(
  headers: Record<string, string>,
  options: { scopes?: readonly string[] } = {}
): Record<string, string> {
  const sub = headers['x-clerum-edge-user-id']
  const hostName = headers['x-clerum-edge-host-ref']
  if (!sub || !hostName) {
    throw new Error('An rpc-proxy edge assertion needs the user id and host ref headers')
  }
  return {
    ...headers,
    [HOST_EDGE_ASSERTION_HEADER]: signHostEdgeTestAssertion({
      sub,
      host: hostEdgeTestHost(hostName),
      teamId: headers['x-clerum-edge-team-id'] ?? null,
      scopes: options.scopes,
    }),
  }
}
