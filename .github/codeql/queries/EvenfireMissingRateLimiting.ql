/**
 * @name Missing rate limiting
 * @description An HTTP request handler that performs expensive operations without
 *              restricting the rate at which operations can be carried out is vulnerable
 *              to denial-of-service attacks.
 * @kind problem
 * @problem.severity warning
 * @security-severity 7.5
 * @precision high
 * @id js/missing-rate-limiting
 * @tags security
 *       external/cwe/cwe-770
 *       external/cwe/cwe-307
 *       external/cwe/cwe-400
 */

import javascript
import semmle.javascript.security.dataflow.MissingRateLimiting
import semmle.javascript.RestrictedLocations

private predicate isCanonicalEvenfireRateLimitImport(ImportSpecifier spec) {
  spec.getImportedName() = "rateLimitMiddleware" and
  spec.getImportDeclaration().getImportedFile().getRelativePath() =
    "control-api/src/middleware/rateLimitMiddleware.ts"
}

private class EvenfireRateLimitingMiddleware extends RateLimitingMiddleware, DataFlow::CallNode {
  EvenfireRateLimitingMiddleware() {
    exists(ImportSpecifier spec |
      isCanonicalEvenfireRateLimitImport(spec) and
      DataFlow::valueNode(spec).(DataFlow::SourceNode).flowsTo(this.getCalleeNode())
    )
  }

  override Routing::Node getRoutingNode() {
    exists(DataFlow::Node ref | this.flowsTo(ref) and result = Routing::getNode(ref))
  }
}

private predicate sameSourceFile(Routing::Node left, Routing::Node right) {
  exists(
    string path, int leftStartLine, int leftStartColumn, int leftEndLine, int leftEndColumn,
    int rightStartLine, int rightStartColumn, int rightEndLine, int rightEndColumn
  |
    left.hasLocationInfo(path, leftStartLine, leftStartColumn, leftEndLine, leftEndColumn) and
    right.hasLocationInfo(path, rightStartLine, rightStartColumn, rightEndLine, rightEndColumn)
  )
}

private predicate isCanonicalExternalLimiterIdentityImport(ImportSpecifier spec) {
  spec.getImportDeclaration().getImportedFile().getRelativePath() =
    "control-api/src/middleware/externalSessionAuth.ts" and
  spec.getImportedName() = "requireExternalSessionLimiterIdentityWithPublicErrors"
}

private predicate isCanonicalExternalLimiterIdentityHandler(Routing::Node useSite) {
  exists(ImportSpecifier spec, DataFlow::Node installedNode |
    isCanonicalExternalLimiterIdentityImport(spec) and
    useSite = Routing::getNode(installedNode) and
    DataFlow::valueNode(spec).(DataFlow::SourceNode).flowsTo(installedNode)
  )
}

private predicate hasSameRouteEvenfireLimiterAfterContext(Routing::Node useSite) {
  exists(EvenfireRateLimitingMiddleware middleware, Routing::Node limiterNode |
    limiterNode = middleware.getRoutingNode() and
    limiterNode = useSite.getNextSibling+() and
    sameSourceFile(useSite, limiterNode) and
    not exists(Routing::Node earlierNode |
      earlierNode = useSite.getNextSibling+() and
      limiterNode = earlierNode.getNextSibling+() and
      not earlierNode.mayResumeDispatch()
    )
  )
}

private predicate hasEvenfireRateLimitingGuard(Routing::Node useSite) {
  exists(EvenfireRateLimitingMiddleware middleware |
    useSite.isGuardedByNode(middleware.getRoutingNode()) and
    sameSourceFile(useSite, middleware.getRoutingNode())
  )
  or
  isCanonicalExternalLimiterIdentityHandler(useSite) and
  useSite.mayResumeDispatch() and
  hasSameRouteEvenfireLimiterAfterContext(useSite)
}

private predicate hasRateLimitingGuard(Routing::Node useSite) {
  exists(RateLimitingMiddleware middleware |
    useSite.isGuardedByNode(middleware.getRoutingNode()) and
    not middleware instanceof EvenfireRateLimitingMiddleware
  )
  or
  hasEvenfireRateLimitingGuard(useSite)
}

from
  Routing::Node useSite, ExpensiveRouteHandler r, string explanation, DataFlow::Node reference,
  string referenceLabel
where
  useSite = Routing::getNode(r).getRouteInstallation() and
  r.explain(explanation, reference, referenceLabel) and
  not hasRateLimitingGuard(useSite)
select useSite, "This route handler " + explanation + ", but is not rate-limited.", reference,
  referenceLabel
