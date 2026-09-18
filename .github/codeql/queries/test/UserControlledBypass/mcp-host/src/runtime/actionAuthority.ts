import jwt from "jsonwebtoken";

export function authorityBindingFromTrustedEdge(context: any): unknown {
  const verified = jwt.verify(context.token, "test-secret");
  return Object.freeze({
    version: 2,
    userId: context.userId,
    sid: context.sid,
    delegationJti: context.delegationJti,
    operationId: context.operationId,
    resource: context.resource,
    target: context.target,
    targetHash: context.targetHash,
    accessPathId: context.accessPathId,
    authorizationRevision: context.authorizationRevision,
    verified,
  });
}
