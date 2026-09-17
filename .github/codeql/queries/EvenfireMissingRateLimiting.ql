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

private predicate isExactImportedValue(Expr value, string path, string importedName) {
  exists(ImportSpecifier spec, VarAccess access |
    spec.getImportedName() = importedName and
    spec.getImportDeclaration().getImportedFile().getRelativePath() = path and
    value = access and
    access.getVariable() = spec.getLocal().getVariable()
  )
}

private predicate isExactImportedCall(CallExpr call, string path, string importedName) {
  exists(VarAccess callee |
    call.getCallee() = callee and
    isExactImportedValue(callee, path, importedName)
  )
}

private predicate isInstalledRouteArgument(
  MethodCallExpr registration, Routing::Node node, int index
) {
  exists(Expr argument |
    argument = registration.getArgument(index) and
    node = Routing::getNode(DataFlow::valueNode(argument))
  )
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

/**
 * R30 admission is distributed across the rpc-proxy artifact resolver and the
 * authoritative Control API. This predicate intentionally uses exact module
 * identities and route/middleware structure rather than inter-service flow.
 */
private predicate isCanonicalArtifactReadPath(Expr path) {
  exists(
    VariableDeclarator baseDeclaration, VarDecl baseBinding, StringLiteral basePath,
    TemplateLiteral artifactPath, VarAccess baseAccess, TemplateElement suffix
  |
    path = artifactPath and
    artifactPath.getFile().getRelativePath() = "control-api/src/routes/rpc-access/users.ts" and
    baseDeclaration.getDeclStmt() instanceof ConstDeclStmt and
    baseDeclaration.getBindingPattern() = baseBinding and
    baseDeclaration.getInit() = basePath and
    basePath.getStringValue() = "/rpc/access/users/:userId/mcp-hosts/:hostRef" and
    artifactPath.getNumElement() = 2 and
    artifactPath.getElement(0) = baseAccess and
    baseAccess.getVariable() = baseBinding.getVariable() and
    artifactPath.getElement(1) = suffix and
    suffix.getRawValue() = "/artifact-read"
  )
}

private predicate isSubjectOnlyArtifactPreAdmission(CallExpr admission) {
  exists(
    ObjectExpr options, Property bucketType, Property maxPerMinute, PropAccess configuredLimit,
    Property keyGenerator, Function keyFunction, VarAccess requestParameter,
    PropAccess rpcAuth, PropAccess subjectAccess,
    VariableDeclarator subjectDeclaration,
    VarDecl subjectBinding, TemplateLiteral bucketKey, TemplateElement keyPrefix
  |
    isExactImportedCall(admission, "control-api/src/middleware/rateLimitMiddleware.ts",
      "rateLimitMiddleware") and
    admission.getArgument(0) = options and
    bucketType = options.getPropertyByName("bucketType") and
    bucketType.getInit().getStringValue() = "host_artifact_pre_admission" and
    maxPerMinute = options.getPropertyByName("maxPerMinute") and
    maxPerMinute.getInit() = configuredLimit and
    configuredLimit.getPropertyName() = "hostArtifactReadRlPerMin" and
    isExactImportedValue(configuredLimit.getBase(), "control-api/src/config.ts", "config") and
    keyGenerator = options.getPropertyByName("getBucketKey") and
    keyGenerator.getInit() = keyFunction and
    requestParameter.getVariable() = keyFunction.getParameter(0).getVariable() and
    rpcAuth.getPropertyName() = "rpcAuth" and
    rpcAuth.getBase().getAChild*() = requestParameter and
    subjectDeclaration.getInit().getAChild*() = subjectAccess and
    subjectAccess.getBase() = rpcAuth and
    subjectAccess.getPropertyName() = "sub" and
    subjectDeclaration.getDeclStmt() instanceof ConstDeclStmt and
    subjectDeclaration.getBindingPattern() = subjectBinding and
    subjectDeclaration.getEnclosingFunction() = keyFunction and
    bucketKey.getEnclosingFunction() = keyFunction and
    bucketKey.getNumElement() = 2 and
    bucketKey.getElement(0) = keyPrefix and
    keyPrefix.getValue() = "host-artifact-pre-admission:" and
    bucketKey.getElement(1).(VarAccess).getVariable() = subjectBinding.getVariable() and
    not exists(PropAccess hostSelector |
      hostSelector.getEnclosingFunction() = keyFunction and
      hostSelector.getPropertyName() = "hostRef"
    )
  )
}

private predicate isCanonicalHostArtifactAdmission(CallExpr limiter) {
  exists(
    ObjectExpr options, Property bucketType, Property maxPerMinute, PropAccess configuredLimit,
    Property keyGenerator, Function keyFunction, PropAccess canonicalHost,
    PropAccess artifactConnection, PropAccess rpcAuth, PropAccess subjectAccess,
    TemplateLiteral bucketKey, TemplateElement keyPrefix
  |
    isExactImportedCall(limiter, "control-api/src/middleware/rateLimitMiddleware.ts",
      "rateLimitMiddleware") and
    limiter.getArgument(0) = options and
    bucketType = options.getPropertyByName("bucketType") and
    bucketType.getInit().getStringValue() = "host_artifact_read" and
    maxPerMinute = options.getPropertyByName("maxPerMinute") and
    maxPerMinute.getInit() = configuredLimit and
    configuredLimit.getPropertyName() = "hostArtifactReadRlPerMin" and
    isExactImportedValue(configuredLimit.getBase(), "control-api/src/config.ts", "config") and
    keyGenerator = options.getPropertyByName("getBucketKey") and
    keyGenerator.getInit() = keyFunction and
    rpcAuth.getEnclosingFunction() = keyFunction and
    rpcAuth.getPropertyName() = "rpcAuth" and
    subjectAccess.getBase() = rpcAuth and
    subjectAccess.getPropertyName() = "sub" and
    artifactConnection.getPropertyName() = "artifactReadConnection" and
    artifactConnection.getEnclosingFunction() = keyFunction and
    canonicalHost.getBase().getAChild*() = artifactConnection and
    canonicalHost.getPropertyName() = "hostRef" and
    bucketKey.getEnclosingFunction() = keyFunction and
    bucketKey.getNumElement() = 4 and
    bucketKey.getElement(0) = keyPrefix and
    keyPrefix.getRawValue() = "host-artifact-read:"
  )
}

private predicate isCanonicalArtifactProducer(MethodCallExpr registration) {
  exists(
    CallExpr tokenCheck, ArrayExpr scopes, StringLiteral scope,
    CallExpr userMatch, CallExpr hostMatch, CallExpr preAdmission, Function authorizationHandler,
    CallExpr liveAuthorization, CallExpr hostAdmission
  |
    registration.getMethodName() = "get" and
    registration.getFile().getRelativePath() = "control-api/src/routes/rpc-access/users.ts" and
    isCanonicalArtifactReadPath(registration.getArgument(0)) and
    tokenCheck = registration.getArgument(1) and
    isExactImportedCall(tokenCheck, "control-api/src/middleware/rpcAccessAuth.ts",
      "requireValidRpcAccessTokenAny") and
    tokenCheck.getArgument(0) = scopes and
    scopes.getSize() = 1 and
    scopes.getElement(0) = scope and
    scope.getStringValue() = "host:task:read" and
    userMatch = registration.getArgument(2) and
    isExactImportedCall(userMatch, "control-api/src/middleware/rpcAccessAuth.ts",
      "requireRpcTokenUserMatch") and
    hostMatch = registration.getArgument(3) and
    isExactImportedCall(hostMatch, "control-api/src/middleware/rpcAccessAuth.ts",
      "requireRpcTokenHostMatch") and
    preAdmission = registration.getArgument(4) and
    isSubjectOnlyArtifactPreAdmission(preAdmission) and
    authorizationHandler = registration.getArgument(5) and
    liveAuthorization.getEnclosingFunction() = authorizationHandler and
    liveAuthorization.getCalleeName() = "resolveAuthorizedHostConnection" and
    hostAdmission = registration.getArgument(6) and
    isCanonicalHostArtifactAdmission(hostAdmission)
  )
}

private predicate isCanonicalArtifactProducerGuard(Routing::Node useSite) {
  exists(MethodCallExpr registration |
    isCanonicalArtifactProducer(registration) and
    isInstalledRouteArgument(registration, useSite, 1)
  )
}

private predicate isCanonicalArtifactTransport() {
  exists(
    Function resolver, CallExpr clientCall, Function client, CallExpr fetchCall,
    ObjectExpr options, Property artifactRead, Function pathFetcher,
    ConditionalExpr endpointChoice, PropAccess artifactReadFlag, TemplateLiteral artifactEndpoint,
    TemplateElement artifactSuffix
  |
    resolver.getFile().getRelativePath() = "rpc-proxy/src/services/mcpProxyService.ts" and
    resolver.getName() = "resolveArtifactReadHostConnectionForUser" and
    clientCall.getEnclosingFunction() = resolver and
    isExactImportedCall(clientCall, "rpc-proxy/src/services/controlApiRestService.ts",
      "fetchArtifactReadHostConnectionFromControlApi") and
    client.getFile().getRelativePath() = "rpc-proxy/src/services/controlApiRestService.ts" and
    client.getName() = "fetchArtifactReadHostConnectionFromControlApi" and
    fetchCall.getEnclosingFunction() = client and
    fetchCall.getCalleeName() = "fetchHostConnectionForPath" and
    fetchCall.getArgument(3) = options and
    artifactRead = options.getPropertyByName("artifactRead") and
    artifactRead.getInit().(BooleanLiteral).getBoolValue() = true and
    pathFetcher.getFile().getRelativePath() = "rpc-proxy/src/services/controlApiRestService.ts" and
    pathFetcher.getName() = "fetchHostConnectionForPath" and
    endpointChoice.getEnclosingFunction() = pathFetcher and
    artifactReadFlag.getPropertyName() = "artifactRead" and
    endpointChoice.getCondition().getAChild*() = artifactReadFlag and
    endpointChoice.getConsequent() = artifactEndpoint and
    artifactEndpoint.getNumElement() = 2 and
    artifactEndpoint.getElement(1) = artifactSuffix and
    artifactSuffix.getRawValue() = "/artifact-read"
  )
}

private predicate hasCanonicalArtifactServiceBoundary() {
  exists(
    Function createApp, MethodCallExpr internalTokenMount, MethodCallExpr internalServiceMount,
    MethodCallExpr routerMount, CallExpr internalService, StringLiteral rpcProxyName
  |
    createApp.getFile().getRelativePath() = "control-api/src/app.ts" and
    createApp.getName() = "createApp" and
    internalTokenMount.getEnclosingFunction() = createApp and
    internalTokenMount.getMethodName() = "use" and
    isExactImportedValue(internalTokenMount.getArgument(0),
      "control-api/src/middleware/internalServiceAuth.ts", "requireInternalToken") and
    internalServiceMount.getEnclosingFunction() = createApp and
    internalServiceMount.getMethodName() = "use" and
    internalServiceMount.getArgument(0).getStringValue() = "/rpc" and
    internalService = internalServiceMount.getArgument(1) and
    isExactImportedCall(internalService, "control-api/src/middleware/internalServiceAuth.ts",
      "requireInternalService") and
    internalService.getArgument(0) = rpcProxyName and
    rpcProxyName.getStringValue() = "rpc-proxy" and
    routerMount.getEnclosingFunction() = createApp and
    routerMount.getMethodName() = "use" and
    isExactImportedCall(routerMount.getArgument(0).(CallExpr),
      "control-api/src/routes/rpc-access/index.ts", "createRpcAccessRouter")
  )
}

private predicate isCanonicalArtifactResolver(Expr resolverValue) {
  exists(
    VariableDeclarator declaration, VarDecl binding, Function resolver, VarAccess resolverAccess,
    CallExpr clientCall
  |
    declaration.getDeclStmt() instanceof ConstDeclStmt and
    declaration.getBindingPattern() = binding and
    binding.getVariable().getName() = "resolveArtifactReadHost" and
    declaration.getInit() = resolver and
    resolverValue = resolverAccess and
    resolverAccess.getVariable() = binding.getVariable() and
    resolver.getFile().getRelativePath() = "rpc-proxy/src/routes/rpc.ts" and
    clientCall.getEnclosingFunction() = resolver and
    isExactImportedCall(clientCall, "rpc-proxy/src/services/mcpProxyService.ts",
      "resolveArtifactReadHostConnectionForUser") and
    not exists(ImportSpecifier alternateImport, CallExpr alternateCall |
      alternateImport.getImportDeclaration().getImportedFile().getRelativePath() =
        "rpc-proxy/src/services/mcpProxyService.ts" and
      alternateImport.getImportedName() != "resolveArtifactReadHostConnectionForUser" and
      alternateCall.getEnclosingFunction() = resolver and
      alternateCall.getCallee().(VarAccess).getVariable() = alternateImport.getLocal().getVariable()
    ) and
    not exists(CallExpr directFallback |
      directFallback.getEnclosingFunction() = resolver and
      directFallback.getCalleeName() = "fetch"
    )
  )
}

private predicate isCanonicalArtifactProxyGuard(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral path, CallExpr scope, Expr resolver,
    int index
  |
    registration.getMethodName() = "get" and
    registration.getFile().getRelativePath() = "rpc-proxy/src/routes/rpc.ts" and
    registration.getArgument(0) = path and
    path.getStringValue() in [
      "/rpc/hosts/:hostRef/artifacts",
      "/rpc/hosts/:hostRef/artifacts/:filename/download"
    ] and
    isExactImportedValue(registration.getArgument(1), "rpc-proxy/src/middleware/auth.ts",
      "requireRpcAuth") and
    scope = registration.getArgument(2) and
    isExactImportedCall(scope, "rpc-proxy/src/middleware/auth.ts", "requireScope") and
    scope.getArgument(0).getStringValue() = "host:task:read" and
    resolver = registration.getArgument(3) and
    isCanonicalArtifactResolver(resolver) and
    isCanonicalArtifactTransport() and
    hasCanonicalArtifactServiceBoundary() and
    exists(MethodCallExpr producer | isCanonicalArtifactProducer(producer)) and
    (index = 1 or index = 3) and
    isInstalledRouteArgument(registration, useSite, index)
  )
}

private predicate hasRateLimitingGuard(Routing::Node useSite) {
  isCanonicalArtifactProxyGuard(useSite) or
  isCanonicalArtifactProducerGuard(useSite) or
  exists(RateLimitingMiddleware middleware |
    useSite.isGuardedByNode(middleware.getRoutingNode()) and
    not middleware instanceof EvenfireRateLimitingMiddleware
  ) or
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
