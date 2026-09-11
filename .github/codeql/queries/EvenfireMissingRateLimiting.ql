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
    exists(ImportSpecifier spec, VarAccess callee |
      isCanonicalEvenfireRateLimitImport(spec) and
      callee = spec.getLocal().getVariable().getAnAccess() and
      this.getCalleeNode() = DataFlow::valueNode(callee)
    )
  }

  override Routing::Node getRoutingNode() {
    result = Routing::getNode(this)
    or
    exists(VariableDeclarator declaration, VarDecl binding, VarAccess installed |
      declaration.getInit() = this.asExpr() and
      declaration.getBindingPattern() = binding and
      declaration.getDeclStmt() instanceof ConstDeclStmt and
      installed = binding.getVariable().getAnAccess() and
      result = Routing::getNode(DataFlow::valueNode(installed))
    )
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
  exists(ImportSpecifier spec, VarAccess installed |
    isCanonicalExternalLimiterIdentityImport(spec) and
    installed = spec.getLocal().getVariable().getAnAccess() and
    useSite = Routing::getNode(DataFlow::valueNode(installed))
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

private predicate isImportedValue(Expr value, string path, string importedName) {
  exists(ImportSpecifier spec, VarAccess access |
    spec.getImportedName() = importedName and
    spec.getImportDeclaration().getImportedFile().getRelativePath() = path and
    access = spec.getLocal().getVariable().getAnAccess() and
    value = access
  )
}

private predicate isImportedCall(CallExpr call, string path, string importedName) {
  isImportedValue(call.getCallee(), path, importedName)
}

private predicate isCanonicalExternalRpcLimiterStage(CallExpr middleware, string stage) {
  exists(CallExpr options |
    isImportedCall(middleware, "control-api/src/middleware/rateLimitMiddleware.ts",
      "rateLimitMiddleware") and
    middleware.getArgument(0) = options and
    isImportedCall(options, "control-api/src/middleware/externalUserRateLimitPolicy.ts",
      "externalUserRateLimitOptions") and
    isImportedValue(options.getArgument(0),
      "control-api/src/services/access/actionOperationRegistry.ts", "EXTERNAL_RPC_ADMISSION_CLASS") and
    options.getArgument(1).getStringValue() = stage
  )
}

private predicate hasCanonicalExternalRpcPolicy() {
  exists(
    VariableDeclarator policiesDeclaration, VarDecl policiesBinding, ObjectExpr policies,
    Property rpcPolicyProperty, ObjectExpr rpcPolicy, Property bucketType, Property maxPerMinute,
    VariableDeclarator admissionDeclaration, VarDecl admissionBinding
  |
    policiesDeclaration.getFile().getRelativePath() =
      "control-api/src/middleware/externalUserRateLimitPolicy.ts" and
    policiesDeclaration.getBindingPattern() = policiesBinding and
    policiesBinding.getVariable().getName() = "POLICIES" and
    policiesDeclaration.getInit() = policies and
    rpcPolicyProperty = policies.getPropertyByName("rpc_token") and
    rpcPolicyProperty.getInit() = rpcPolicy and
    bucketType = rpcPolicy.getPropertyByName("bucketType") and
    bucketType.getInit().getStringValue() = "external_rpc_token" and
    maxPerMinute = rpcPolicy.getPropertyByName("maxPerMinute") and
    maxPerMinute.getInit().getIntValue() = 10 and
    admissionDeclaration.getFile().getRelativePath() =
      "control-api/src/services/access/actionOperationRegistry.ts" and
    admissionDeclaration.getBindingPattern() = admissionBinding and
    admissionBinding.getVariable().getName() = "EXTERNAL_RPC_ADMISSION_CLASS" and
    admissionDeclaration.getInit().getStringValue() = "rpc_token"
  )
}

/**
 * The PR2 distributed admission model is valid only while the canonical
 * external delegation issuer has both exact `external_rpc_token` stages and
 * is the producer that signs the downstream delegation.
 */
private predicate hasCanonicalExternalRpcDelegationIssuer() {
  exists(
    MethodCallExpr registration, CallExpr preAuth, CallExpr authenticated, Function handler,
    CallExpr issuer, int preAuthIndex, int authenticatedIndex, int handlerIndex
  |
    registration.getMethodName() = "post" and
    registration.getArgument(0).getStringValue() = "/external/rpc/delegations" and
    preAuth = registration.getArgument(preAuthIndex) and
    authenticated = registration.getArgument(authenticatedIndex) and
    handler = registration.getArgument(handlerIndex) and
    0 < preAuthIndex and
    preAuthIndex < authenticatedIndex and
    authenticatedIndex < handlerIndex and
    isCanonicalExternalRpcLimiterStage(preAuth, "pre_auth") and
    isCanonicalExternalRpcLimiterStage(authenticated, "authenticated") and
    isImportedCall(issuer, "control-api/src/utils/auth/userDelegationV2Token.ts",
      "issueUserDelegationV2") and
    issuer.getEnclosingFunction() = handler
  ) and
  hasCanonicalExternalRpcPolicy()
}

private predicate registeredRouteContainsNodeAtIndex(
  MethodCallExpr registration, Routing::Node node, int index
) {
  exists(Expr installed |
    installed = registration.getArgument(index) and
    node = Routing::getNode(DataFlow::valueNode(installed))
  )
}

/**
 * A consumer is part of the closed v2 authority surface only when its literal
 * Express path is also handled by the canonical route-action binder.
 */
private predicate binderVariableFromCanonicalRequest(Function binder, Variable variable, string kind) {
  exists(VariableDeclarator declaration, VarDecl binding, CallExpr initializer |
    declaration.getBindingPattern() = binding and
    binding.getVariable() = variable and
    declaration.getInit() = initializer and
    initializer.getEnclosingFunction() = binder and
    (
      kind = "path" and initializer.getCalleeName() = "routePath"
      or
      kind = "method" and
      initializer.(MethodCallExpr).getMethodName() = "toUpperCase" and
      initializer.(MethodCallExpr).getReceiver().(PropAccess).getPropertyName() = "method"
    )
  )
}

private predicate comparisonMatchesBinderVariable(
  StrictEqExpr comparison, Function binder, string kind, string literalValue
) {
  exists(VarAccess access, StringLiteral literal, Variable variable |
    comparison.getAnOperand() = access and
    comparison.getAnOperand() = literal and
    access.getVariable() = variable and
    literal.getStringValue() = literalValue and
    binderVariableFromCanonicalRequest(binder, variable, kind)
  )
}

private predicate branchReturnsActionBinding(IfStmt branch) {
  exists(ReturnStmt ret, ObjectExpr binding |
    ret.nestedIn(branch.getThen()) and
    ret.getExpr() = binding and
    exists(binding.getPropertyByName("operationId"))
  )
}

private predicate canonicalBinderAcceptsRoute(MethodCallExpr registration) {
  exists(
    StringLiteral installedPath, Function binder, IfStmt acceptingBranch,
    StrictEqExpr pathComparison
  |
    installedPath = registration.getArgument(0) and
    binder.getName() = "candidateForRequest" and
    binder.getFile().getRelativePath() = "rpc-proxy/src/routeActionBindingV2.ts" and
    pathComparison.getParentExpr*() = acceptingBranch.getCondition() and
    comparisonMatchesBinderVariable(pathComparison, binder, "path", installedPath.getStringValue()) and
    branchReturnsActionBinding(acceptingBranch) and
    (
      registration.getMethodName() = "all"
      or
      exists(StrictEqExpr methodComparison |
        methodComparison.getParentExpr*() = acceptingBranch.getCondition() and
        comparisonMatchesBinderVariable(methodComparison, binder, "method",
          registration.getMethodName().toUpperCase())
      )
    )
  )
  or
  exists(
    StringLiteral installedPath, Function helper, Function binder, IfStmt acceptingBranch,
    StrictEqExpr pathComparison, CallExpr helperCall
  |
    installedPath = registration.getArgument(0) and
    registration.getMethodName() = "get" and
    helper.getName() = "targetForHostRead" and
    helper.getFile().getRelativePath() = "rpc-proxy/src/routeActionBindingV2.ts" and
    pathComparison.getParentExpr*() = acceptingBranch.getCondition() and
    comparisonMatchesBinderVariable(pathComparison, helper, "path", installedPath.getStringValue()) and
    branchReturnsActionBinding(acceptingBranch) and
    binder.getName() = "candidateForRequest" and
    binder.getFile() = helper.getFile() and
    helperCall.getEnclosingFunction() = binder and
    helperCall.getCallee().(VarAccess).getVariable() = helper.getVariable()
  )
}

private predicate functionOccursWithin(Function inner, Function outer) {
  inner.getFile() = outer.getFile() and
  outer.getLocation().getStartLine() <= inner.getLocation().getStartLine() and
  outer.getLocation().getEndLine() >= inner.getLocation().getEndLine()
}

private predicate importedGuardAtIndex(
  MethodCallExpr registration, int index, string path, string importedName
) {
  exists(Expr guard |
    guard = registration.getArgument(index) and
    (
      isImportedValue(guard, path, importedName) or
      isImportedCall(guard.(CallExpr), path, importedName)
    )
  )
}

private predicate hasRpcProxyDelegationConsumer(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, VarAccess rpcAuth, CallExpr scope, Function handler, int rpcIndex,
    int scopeIndex, int handlerIndex, int useIndex
  |
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    rpcAuth = registration.getArgument(rpcIndex) and
    scope = registration.getArgument(scopeIndex) and
    handler = registration.getArgument(handlerIndex) and
    rpcIndex < handlerIndex and
    scopeIndex < handlerIndex and
    (useIndex = rpcIndex or useIndex = scopeIndex or useIndex = handlerIndex) and
    isImportedValue(rpcAuth, "rpc-proxy/src/middleware/auth.ts", "requireRpcAuth") and
    isImportedCall(scope, "rpc-proxy/src/middleware/auth.ts", "requireScope") and
    canonicalBinderAcceptsRoute(registration) and
    hasCanonicalRpcProxyDelegationVerifier()
  )
  or
  exists(
    MethodCallExpr registration, VarAccess middleware, Function authority, Function handler,
    int authorityIndex, int handlerIndex, int useIndex
  |
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    middleware = registration.getArgument(authorityIndex) and
    handler = registration.getArgument(handlerIndex) and
    authorityIndex < handlerIndex and
    (useIndex = authorityIndex or useIndex = handlerIndex) and
    middleware.getName() = "v2ViewAuthority" and
    authority.getName() = middleware.getName() and
    authority.getFile() = registration.getFile() and
    canonicalBinderAcceptsRoute(registration) and
    exists(CallExpr declaredV2, CallExpr rpcAuth, CallExpr scope |
      functionOccursWithin(declaredV2.getEnclosingFunction(), authority) and
      functionOccursWithin(rpcAuth.getEnclosingFunction(), authority) and
      functionOccursWithin(scope.getEnclosingFunction(), authority) and
      isImportedCall(declaredV2, "rpc-proxy/src/userDelegationV2.ts", "tokenDeclaresV2") and
      isImportedCall(rpcAuth, "rpc-proxy/src/middleware/auth.ts", "requireRpcAuth") and
      isImportedCall(scope, "rpc-proxy/src/middleware/auth.ts", "requireScope") and
      (
        scope.getArgument(0).getStringValue() = "sandbox:ui:view" or
        scope.getArgument(0).getStringValue() = "desktop:view"
      ) and
      hasCanonicalRpcProxyDelegationVerifier()
    )
  )
}

private predicate hasCanonicalRpcProxyAuthentication() {
  exists(
    Function rpcAuth, CallExpr declaresV2, CallExpr verifiesDelegation,
    AssignExpr retainsDelegation, PropAccess retainedProperty, IfStmt v2Branch,
    IfStmt invalidDelegation, VariableDeclarator delegationDeclaration, VarDecl delegationBinding,
    Variable delegation, LogNotExpr missingDelegation, VarAccess missingDelegationUse,
    ReturnStmt invalidReturn
  |
    rpcAuth.getFile().getRelativePath() = "rpc-proxy/src/middleware/auth.ts" and
    rpcAuth.getName() = "requireRpcAuth" and
    isImportedCall(declaresV2, "rpc-proxy/src/userDelegationV2.ts", "tokenDeclaresV2") and
    declaresV2.getEnclosingFunction() = rpcAuth and
    v2Branch.getCondition() = declaresV2 and
    isImportedCall(verifiesDelegation, "rpc-proxy/src/userDelegationV2.ts", "verifyUserDelegationV2") and
    verifiesDelegation.getEnclosingFunction() = rpcAuth and
    delegationDeclaration.getInit() = verifiesDelegation and
    delegationDeclaration.getBindingPattern() = delegationBinding and
    delegation = delegationBinding.getVariable() and
    invalidDelegation.getCondition() = missingDelegation and
    missingDelegation.getOperand() = missingDelegationUse and
    missingDelegationUse.getVariable() = delegation and
    invalidDelegation.nestedIn(v2Branch.getThen()) and
    invalidReturn.nestedIn(invalidDelegation.getThen()) and
    not exists(invalidReturn.getExpr()) and
    retainsDelegation.getEnclosingFunction() = rpcAuth and
    retainsDelegation.getLhs() = retainedProperty and
    retainedProperty.getPropertyName() = "userDelegationV2" and
    retainsDelegation.getRhs().(VarAccess).getVariable() = delegation and
    invalidDelegation.getLocation().getEndLine() < retainsDelegation.getLocation().getStartLine() and
    not exists(CallExpr bypass |
      bypass.getEnclosingStmt().nestedIn(invalidDelegation.getThen()) and
      bypass.getCalleeName() = "next"
    )
  )
}

private predicate hasCanonicalRpcProxyScopeAuthorization() {
  exists(
    Function scopeGuard, CallExpr authorizesBoundRequest, PropAccess selectedDelegation,
    IfStmt selectedV2Branch, ReturnStmt selectedV2Return
  |
    scopeGuard.getFile().getRelativePath() = "rpc-proxy/src/middleware/auth.ts" and
    scopeGuard.getName() = "requireScope" and
    isImportedCall(authorizesBoundRequest, "rpc-proxy/src/routeActionBindingV2.ts",
      "authorizeBoundRequestV2") and
    authorizesBoundRequest.getEnclosingFunction().getFile() = scopeGuard.getFile() and
    selectedDelegation.getPropertyName() = "userDelegationV2" and
    selectedDelegation.getEnclosingFunction().getFile() = scopeGuard.getFile() and
    selectedV2Branch.getCondition() = selectedDelegation and
    authorizesBoundRequest.getEnclosingStmt().nestedIn(selectedV2Branch.getThen()) and
    selectedV2Return.nestedIn(selectedV2Branch.getThen()) and
    not exists(selectedV2Return.getExpr())
  )
}

private predicate hasCanonicalRpcProxyDelegationVerifier() {
  hasCanonicalRpcProxyAuthentication() and hasCanonicalRpcProxyScopeAuthorization()
}

private predicate hasControlApiCheckpointConsumer(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, Function handler, int guardIndex, int handlerIndex, int useIndex
  |
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    handler = registration.getArgument(handlerIndex) and
    guardIndex < handlerIndex and
    (useIndex = guardIndex or useIndex = handlerIndex) and
    (
      importedGuardAtIndex(registration, guardIndex,
        "control-api/src/middleware/actionCheckpointCaller.ts", "requireActionCheckpointCaller")
      or
      importedGuardAtIndex(registration, guardIndex,
        "control-api/src/middleware/pr2ReadinessWriterAuth.ts", "requirePr2RuntimeReadinessWriter")
    )
  )
}

private predicate hasControlApiRpcProxyOauthConsumer(Routing::Node useSite, DataFlow::Node reference) {
  exists(
    MethodCallExpr registration, CallExpr serviceGuard, Function handler, CallExpr binding,
    int guardIndex, int handlerIndex, int useIndex
  |
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    serviceGuard = registration.getArgument(guardIndex) and
    handler = registration.getArgument(handlerIndex) and
    guardIndex < handlerIndex and
    (useIndex = guardIndex or useIndex = handlerIndex) and
    isImportedCall(serviceGuard, "control-api/src/middleware/internalServiceAuth.ts",
      "requireInternalService") and
    serviceGuard.getArgument(0).getStringValue() = "rpc-proxy" and
    binding.getCalleeName() = "hasExpectedV2OAuthContext" and
    binding.getEnclosingFunction() = handler and
    (
      useIndex = guardIndex
      or
      reference.asExpr() = binding
      or
      binding.getLocation().getEndLine() < reference.getLocation().getStartLine()
    )
  )
}

private predicate hasMcpRuntimeEdgeConsumer(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, CallExpr guard, StringLiteral operation, Function handler,
    int guardIndex, int handlerIndex, int useIndex
  |
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    guard = registration.getArgument(guardIndex) and
    handler = registration.getArgument(handlerIndex) and
    guardIndex < handlerIndex and
    (useIndex = guardIndex or useIndex = handlerIndex) and
    isImportedCall(guard, "mcp-host/src/server/edgeRuntimeAuth.ts", "runtimeEdgeGuard") and
    operation.getStringValue() = "chat.message.invoke" and
    operation.getParentExpr*() = guard
  )
}

private predicate hasWorkspaceFilesystemConsumer(Routing::Node useSite, DataFlow::Node reference) {
  exists(
    MethodCallExpr registration, VarAccess routeScope, Function handler, Function routerFactory,
    MethodCallExpr mountedAuth, CallExpr authFactory, Function authMiddleware,
    MethodCallExpr bearerVerification, Function checkpoint, MethodCallExpr liveCheckpoint,
    CallExpr routeCheckpoint, int scopeIndex, int handlerIndex, int useIndex
  |
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    routeScope = registration.getArgument(scopeIndex) and
    routeScope.getName() in ["requireRead", "requireWrite"] and
    handler = registration.getArgument(handlerIndex) and
    scopeIndex < handlerIndex and
    (useIndex = scopeIndex or useIndex = handlerIndex) and
    functionOccursWithin(handler, routerFactory) and
    routerFactory.getName() = "createFilesRouter" and
    mountedAuth.getMethodName() = "use" and
    mountedAuth.getEnclosingFunction() = routerFactory and
    mountedAuth.getLocation().getEndLine() < registration.getLocation().getStartLine() and
    authFactory = mountedAuth.getArgument(0) and
    authFactory.getCalleeName() = "authMiddleware" and
    authMiddleware.getName() = "authMiddleware" and
    authMiddleware.getFile() = routerFactory.getFile() and
    bearerVerification.getMethodName() = "verifyBearer" and
    functionOccursWithin(bearerVerification.getEnclosingFunction(), authMiddleware) and
    checkpoint.getName() = "checkpoint" and
    functionOccursWithin(checkpoint, routerFactory) and
    liveCheckpoint.getMethodName() = "checkpointAuthority" and
    liveCheckpoint.getEnclosingFunction() = checkpoint and
    routeCheckpoint.getCalleeName() = "checkpoint" and
    routeCheckpoint.getEnclosingFunction() = handler and
    (
      useIndex = scopeIndex or
      routeCheckpoint.getLocation().getEndLine() < reference.getLocation().getStartLine()
    )
  )
}

private predicate hasPr2DistributedAdmissionGuard(Routing::Node useSite) {
  hasCanonicalExternalRpcDelegationIssuer() and
  (
    hasRpcProxyDelegationConsumer(useSite) or
    hasControlApiCheckpointConsumer(useSite) or
    hasMcpRuntimeEdgeConsumer(useSite)
  )
}

private predicate hasReferenceBoundPr2DistributedAdmissionGuard(
  Routing::Node useSite, DataFlow::Node reference
) {
  hasCanonicalExternalRpcDelegationIssuer() and
  (
    hasControlApiRpcProxyOauthConsumer(useSite, reference) or
    hasWorkspaceFilesystemConsumer(useSite, reference)
  )
}

private predicate hasLocalRateLimitingGuard(Routing::Node useSite) {
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
  not hasLocalRateLimitingGuard(useSite) and
  not hasPr2DistributedAdmissionGuard(useSite) and
  not hasReferenceBoundPr2DistributedAdmissionGuard(useSite, reference)
select useSite, "This route handler " + explanation + ", but is not rate-limited.", reference,
  referenceLabel
