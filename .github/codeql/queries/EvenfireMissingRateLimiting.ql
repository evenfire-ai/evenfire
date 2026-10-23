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
import semmle.javascript.Routing
import semmle.javascript.frameworks.Express

/**
 * The public artifact-read route is admitted by the RPC Proxy and durable Control API
 * buckets before the request reaches this Host. Its Host-side limiter follows the
 * authenticated service guard so it can use the verified user ID as its key. The stock
 * query only recognizes limiters that run before the expensive authorization guard.
 * Keep this exception bound to the two exact Host routes and require their actual
 * express-rate-limit middleware to remain installed.
 */
predicate hasProducerAdmittedHostArtifactReadLimit(Routing::Node useSite) {
  exists(
    Express::RouteSetup setup, int siteIndex, int limiterIndex, RateLimitingMiddleware limiter
  |
    useSite = Routing::getNode(setup.getRouteHandlerNode(siteIndex)) and
    setup.getFile().getRelativePath() = "mcp-host/src/server.ts" and
    setup.getMethodName() = "get" and
    setup.getPath() = ["/v1/runtime/artifacts", "/v1/runtime/artifacts/:filename/download"] and
    siteIndex >= 0 and
    limiterIndex >= 0 and
    limiter.ref().flowsTo(setup.getRouteHandlerNode(limiterIndex))
  )
}

from
  Routing::Node useSite, ExpensiveRouteHandler r, string explanation, DataFlow::Node reference,
  string referenceLabel
where
  useSite = Routing::getNode(r).getRouteInstallation() and
  r.explain(explanation, reference, referenceLabel) and
  not useSite.isGuardedByNode(any(RateLimitingMiddleware m).getRoutingNode()) and
  not hasProducerAdmittedHostArtifactReadLimit(useSite)
select useSite, "This route handler " + explanation + ", but is not rate-limited.", reference,
  referenceLabel
