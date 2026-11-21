import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import {
  HOST_EDGE_ASSERTION_AUDIENCE,
  HOST_EDGE_ASSERTION_CLAIM_TYPE,
  HOST_EDGE_ASSERTION_JWT_TYPE,
  HOST_EDGE_ASSERTION_MAX_TTL_SECONDS,
} from '@clerum/action-context-contracts'
import type { HostEdgeAssertionV2BoundClaims } from '@clerum/action-context-contracts'
import { config } from '../../config.js'

export type HostEdgeAssertionV1Fields = Readonly<{
  teamId: string | null
  scopes: readonly string[]
}>

/**
 * What a Host edge assertion is issued for. `sub` and `host` are the user and the
 * `<namespace>/<hostRef>` the Host compares with the request. `expBound` is the latest
 * expiry the authority behind the assertion allows, in whole seconds: the RPC access token's
 * `exp` for v 1, the checkpoint's `validUntil` for v 2, where `null` means the checkpoint
 * sets no bound and the lifetime is the maximum.
 */
export type HostEdgeAssertionIssue =
  | Readonly<{
      v: 1
      sub: string
      host: string
      expBound: number
      fields: HostEdgeAssertionV1Fields
    }>
  | Readonly<{
      v: 2
      sub: string
      host: string
      expBound: number | null
      fields: HostEdgeAssertionV2BoundClaims
    }>

/** The authority behind the assertion ends in the second of issue, so no lifetime remains. */
export class HostEdgeAssertionBindingError extends Error {
  constructor() {
    super('host_edge_assertion_invalid_binding')
    this.name = 'HostEdgeAssertionBindingError'
  }
}

function versionClaims(input: HostEdgeAssertionIssue) {
  if (input.v === 1) {
    return { teamId: input.fields.teamId, scopes: [...input.fields.scopes] }
  }
  const fields = input.fields
  return {
    operationId: fields.operationId,
    delegationJti: fields.delegationJti,
    sid: fields.sid,
    sessionVersion: fields.sessionVersion,
    accessPathId: fields.accessPathId,
    pathKind: fields.pathKind,
    effectiveTeamId: fields.effectiveTeamId,
    resource: fields.resource,
    targetHash: fields.targetHash,
    authorizationRevision: fields.authorizationRevision,
    behaviorBindingHash: fields.behaviorBindingHash,
    checkedAt: fields.checkedAt,
  }
}

/**
 * Signs the assertion rpc-proxy forwards to the Host with a request. It is signed with the
 * RPC signing key, so the Host verifies it with the RPC public key it already holds; the
 * header type and the audience keep it apart from every other token that key signs.
 */
export function issueHostEdgeAssertion(
  input: HostEdgeAssertionIssue,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const maxExp = nowSeconds + HOST_EDGE_ASSERTION_MAX_TTL_SECONDS
  const exp = input.expBound === null ? maxExp : Math.min(maxExp, input.expBound)
  if (exp <= nowSeconds) throw new HostEdgeAssertionBindingError()
  return jwt.sign(
    {
      typ: HOST_EDGE_ASSERTION_CLAIM_TYPE,
      v: input.v,
      sub: input.sub,
      host: input.host,
      ...versionClaims(input),
      iat: nowSeconds,
      exp,
    },
    config.rpcJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.rpcJwtIssuer,
      audience: HOST_EDGE_ASSERTION_AUDIENCE,
      jwtid: randomUUID(),
      header: { alg: 'RS256', typ: HOST_EDGE_ASSERTION_JWT_TYPE },
    }
  )
}

/** The allowed Host checkpoint and the request it answered, as the v 2 assertion binds them. */
export type CheckpointHostEdgeAssertionInput = Readonly<{
  request: Pick<
    HostEdgeAssertionV2BoundClaims,
    'operationId' | 'delegationJti' | 'resource' | 'targetHash'
  >
  result: Readonly<{
    attribution: Pick<
      HostEdgeAssertionV2BoundClaims,
      'sid' | 'sessionVersion' | 'accessPathId' | 'pathKind' | 'effectiveTeamId'
    > &
      Readonly<{ userId: string }>
    destination: Readonly<{ ref: string }>
    validUntil: string | null
    authorizationRevision: string
    behaviorBindingHash: string
    checkedAt: string
  }>
}>

/**
 * Signs the v 2 assertion for an allowed checkpoint whose destination is a Host. The claims
 * come from the checkpoint result and the request it answered, and the lifetime is bounded
 * by the checkpoint's `validUntil`.
 */
export function issueCheckpointHostEdgeAssertion({
  request,
  result,
}: CheckpointHostEdgeAssertionInput): string {
  return issueHostEdgeAssertion({
    v: 2,
    sub: result.attribution.userId,
    host: result.destination.ref,
    expBound: result.validUntil === null ? null : Math.floor(Date.parse(result.validUntil) / 1000),
    fields: {
      operationId: request.operationId,
      delegationJti: request.delegationJti,
      sid: result.attribution.sid,
      sessionVersion: result.attribution.sessionVersion,
      accessPathId: result.attribution.accessPathId,
      pathKind: result.attribution.pathKind,
      effectiveTeamId: result.attribution.effectiveTeamId,
      resource: request.resource,
      targetHash: request.targetHash,
      authorizationRevision: result.authorizationRevision,
      behaviorBindingHash: result.behaviorBindingHash,
      checkedAt: result.checkedAt,
    },
  })
}
