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

private predicate routeSetupHasEvenfireLimiter(Routing::RouteSetup setup) {
  exists(EvenfireRateLimitingMiddleware middleware, Routing::Node limiterNode |
    limiterNode = middleware.getRoutingNode() and
    limiterNode.getParent() = setup and
    sameSourceFile(setup, limiterNode) and
    not exists(Routing::Node earlierNode |
      earlierNode.getParent() = setup and
      limiterNode = earlierNode.getNextSibling+() and
      not earlierNode.mayResumeDispatch()
    )
  )
}

private predicate isCanonicalExternalContextImport(ImportSpecifier spec) {
  spec.getImportDeclaration().getImportedFile().getRelativePath() =
    "control-api/src/middleware/externalSessionAuth.ts" and
  spec.getImportedName() =
    [
      "requireExternalSessionRateLimitContext",
      "requireValidExternalSessionToken",
      "requireValidExternalSessionTokenWithPublicErrors"
    ]
}

private predicate isCanonicalExternalContextHandler(Routing::Node useSite) {
  exists(ImportSpecifier spec, DataFlow::Node installedNode |
    isCanonicalExternalContextImport(spec) and
    useSite = Routing::getNode(installedNode) and
    (
      DataFlow::valueNode(spec).(DataFlow::SourceNode).flowsTo(installedNode)
      or
      exists(DataFlow::CallNode call |
        call = installedNode and
        DataFlow::valueNode(spec).(DataFlow::SourceNode).flowsTo(call.getCalleeNode())
      )
    )
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

private predicate hasGlobalEvenfireLimiterAfterContext(Routing::Node useSite) {
  exists(
    Routing::RouteSetup contextSetup, Routing::RouteSetup limiterSetup,
    EvenfireRateLimitingMiddleware middleware, Routing::Node limiterNode
  |
    useSite.getParent() = contextSetup and
    limiterNode = middleware.getRoutingNode() and
    limiterNode.getParent() = limiterSetup and
    limiterSetup.getRouter() = contextSetup.getRouter() and
    limiterSetup = contextSetup.getNextSibling+() and
    limiterSetup.getRelativePath() = contextSetup.getRelativePath() and
    not exists(contextSetup.getOwnHttpMethod()) and
    sameSourceFile(useSite, limiterNode) and
    not exists(Routing::RouteSetup earlierSetup |
      earlierSetup.getRouter() = contextSetup.getRouter() and
      earlierSetup = contextSetup.getNextSibling+() and
      limiterSetup = earlierSetup.getNextSibling+() and
      not earlierSetup.mayResumeDispatch()
    )
  )
}

private predicate isCoveredHttpRouteAfterContext(
  Routing::RouteSetup contextSetup, Routing::RouteSetup setup
) {
  exists(string contextPath, string setupPath |
    contextPath = contextSetup.getRelativePath() and
    setupPath = setup.getRelativePath() and
    setup.getRouter() = contextSetup.getRouter() and
    setup = contextSetup.getNextSibling+() and
    sameSourceFile(contextSetup, setup) and
    exists(setup.getOwnHttpMethod()) and
    (
      setupPath = contextPath
      or
      setupPath.length() > contextPath.length() and
      setupPath.prefix(contextPath.length() + 1) = contextPath + "/"
    )
  )
}

private predicate hasEvenfireRateLimitingGuard(Routing::Node useSite) {
  exists(EvenfireRateLimitingMiddleware middleware |
    useSite.isGuardedByNode(middleware.getRoutingNode()) and
    sameSourceFile(useSite, middleware.getRoutingNode())
  )
  or
  isCanonicalExternalContextHandler(useSite) and
  useSite.mayResumeDispatch() and
  hasSameRouteEvenfireLimiterAfterContext(useSite)
  or
  isCanonicalExternalContextHandler(useSite) and
  useSite.mayResumeDispatch() and
  hasGlobalEvenfireLimiterAfterContext(useSite)
  or
  isCanonicalExternalContextHandler(useSite) and
  useSite.mayResumeDispatch() and
  exists(Routing::RouteSetup contextSetup |
    useSite.getParent() = contextSetup and
    not exists(contextSetup.getOwnHttpMethod()) and
    exists(Routing::RouteSetup setup | isCoveredHttpRouteAfterContext(contextSetup, setup)) and
    not exists(Routing::RouteSetup setup |
      isCoveredHttpRouteAfterContext(contextSetup, setup) and
      not routeSetupHasEvenfireLimiter(setup)
    )
  )
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
