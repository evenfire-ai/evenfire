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

private predicate isLiteral4xx(Expr status) {
  exists(int value | value = status.getIntValue() and value >= 400 and value <= 499)
}

private predicate isFixed4xxReturn(ReturnStmt ret) {
  exists(MethodCallExpr response |
    response.getMethodName() = "sendStatus" and
    isLiteral4xx(response.getArgument(0)) and
    response.getParentExpr*() = ret.getExpr()
  )
  or
  exists(MethodCallExpr status |
    status.getMethodName() = "status" and
    isLiteral4xx(status.getArgument(0)) and
    status.getParentExpr*() = ret.getExpr()
  )
}

private predicate isFixed4xxResponseCall(CallExpr call) {
  exists(MethodCallExpr response |
    response.getMethodName() in ["sendStatus", "status"] and
    isLiteral4xx(response.getArgument(0)) and
    response.getParentExpr*() = call
  )
}

private predicate isFixed4xxBranch(Stmt branch) {
  exists(ReturnStmt ret |
    (branch = ret or ret.nestedIn(branch)) and isFixed4xxReturn(ret)
  )
  or
  exists(BlockStmt block, ExprStmt response, ReturnStmt ret |
    branch = block and
    response = block.getStmt(0) and
    isFixed4xxResponseCall(response.getExpr().(CallExpr)) and
    ret = block.getStmt(1) and
    not exists(ret.getExpr())
  )
}

private predicate isCanonicalOauthBindingValidator(CallExpr call) {
  exists(Function validator, CallExpr parse, CallExpr targetValidation, CallExpr targetHash |
    call.getCallee().(VarAccess).getVariable() = validator.getVariable() and
    validator.getName() = "hasExpectedV2OAuthContext" and
    validator.getFile().getRelativePath() = "control-api/src/routes/internal/oauth.ts" and
    validator.getNumParameter() = 2 and
    parse.getCalleeName() = "parse" and
    parse.getEnclosingFunction() = validator and
    targetValidation.getCalleeName() = "validateActionOperationTarget" and
    targetValidation.getEnclosingFunction() = validator and
    targetHash.getCalleeName() = "hashActionTarget" and
    targetHash.getEnclosingFunction() = validator
  )
}

private predicate isTerminatingOauthBindingGuard(CallExpr binding, Function handler) {
  exists(IfStmt guard, LogNotExpr denied |
    guard.getCondition() = denied and
    denied.getOperand() = binding and
    guard.getCondition().getEnclosingFunction() = handler and
    isFixed4xxBranch(guard.getThen())
  )
}

private predicate isV2OnlyGuard(Function guard) {
  exists(IfStmt denied, LogNotExpr missingV2, CallExpr classifier, CallExpr next |
    guard.getName() = "requireV2Delegation" and
    denied.getCondition() = missingV2 and
    missingV2.getOperand() = classifier and
    classifier.getCalleeName() = "isV2ViewRequest" and
    classifier.getEnclosingFunction() = guard and
    isFixed4xxBranch(denied.getThen()) and
    next.getCalleeName() = "next" and
    next.getEnclosingFunction() = guard and
    denied.getLocation().getEndLine() < next.getLocation().getStartLine()
  )
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
    MethodCallExpr registration, VarAccess middleware, Function authority, VarAccess v2Only,
    Function v2OnlyGuard, Function handler, int authorityIndex, int v2OnlyIndex, int handlerIndex,
    int useIndex
  |
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    middleware = registration.getArgument(authorityIndex) and
    handler = registration.getArgument(handlerIndex) and
    v2Only = registration.getArgument(v2OnlyIndex) and
    authorityIndex < handlerIndex and
    authorityIndex < v2OnlyIndex and
    v2OnlyIndex < handlerIndex and
    (useIndex = authorityIndex or useIndex = v2OnlyIndex or useIndex = handlerIndex) and
    middleware.getName() = "v2ViewAuthority" and
    authority.getName() = middleware.getName() and
    authority.getFile() = registration.getFile() and
    v2OnlyGuard.getVariable() = v2Only.getVariable() and
    v2OnlyGuard.getFile() = registration.getFile() and
    isV2OnlyGuard(v2OnlyGuard) and
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

private predicate assignsReadinessWriterBeforeNext(
  Function writerGuard, string service, CallExpr next
) {
  exists(AssignExpr assignment, PropAccess writer, StringLiteral value |
    functionOccursWithin(assignment.getEnclosingFunction(), writerGuard) and
    assignment.getLhs() = writer and
    writer.getPropertyName() = "pr2RuntimeReadinessWriter" and
    assignment.getRhs() = value and
    value.getStringValue() = service and
    next.getCalleeName() = "next" and
    next.getEnclosingFunction().getFile() = writerGuard.getFile() and
    assignment.getLocation().getEndLine() < next.getLocation().getStartLine()
  )
}

private predicate hasCanonicalPr2ReadinessWriterGuard() {
  exists(
    Function writerGuard, MethodCallExpr serviceHeader, CallExpr staticAuth,
    CallExpr controlAuth, CallExpr mcpAuth, IfStmt unknownService, CallExpr staticNext,
    CallExpr controlNext, CallExpr mcpNext
  |
    writerGuard.getName() = "requirePr2RuntimeReadinessWriter" and
    writerGuard.getFile().getRelativePath() =
      "control-api/src/middleware/pr2ReadinessWriterAuth.ts" and
    serviceHeader.getMethodName() = "header" and
    serviceHeader.getArgument(0).getStringValue() = "x-service-token" and
    serviceHeader.getEnclosingFunction() = writerGuard and
    isImportedCall(staticAuth, "control-api/src/middleware/internalServiceAuth.ts",
      "requireInternalToken") and
    functionOccursWithin(staticAuth.getEnclosingFunction(), writerGuard) and
    isImportedCall(controlAuth, "control-api/src/middleware/internalControlJwt.ts",
      "requireInternalControlJwt") and
    functionOccursWithin(controlAuth.getEnclosingFunction(), writerGuard) and
    isImportedCall(mcpAuth, "control-api/src/middleware/mcpHostJwtAuth.ts", "requireMcpHostJwt") and
    functionOccursWithin(mcpAuth.getEnclosingFunction(), writerGuard) and
    unknownService.getCondition().(VarAccess).getName() = "service" and
    unknownService.getCondition().getEnclosingFunction() = writerGuard and
    isFixed4xxBranch(unknownService.getThen()) and
    assignsReadinessWriterBeforeNext(writerGuard, "external-rest-api", staticNext) and
    assignsReadinessWriterBeforeNext(writerGuard, "workflow-recipes", controlNext) and
    assignsReadinessWriterBeforeNext(writerGuard, "mcp-host", mcpNext)
  )
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
        "control-api/src/middleware/pr2ReadinessWriterAuth.ts", "requirePr2RuntimeReadinessWriter") and
      hasCanonicalPr2ReadinessWriterGuard()
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
    isCanonicalOauthBindingValidator(binding) and
    binding.getEnclosingFunction() = handler and
    isTerminatingOauthBindingGuard(binding, handler) and
    (
      useIndex = guardIndex
      or
      reference.asExpr() = binding
      or
      exists(IfStmt bindingGuard |
        binding.getParentExpr*() = bindingGuard.getCondition() and
        bindingGuard.getLocation().getEndLine() < reference.getLocation().getStartLine()
      )
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
    exists(AwaitExpr awaited | awaited.getOperand() = routeCheckpoint) and
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

private predicate hasLocalRateLimitingGuard(Routing::Node useSite) {
  isCanonicalArtifactProxyGuard(useSite) or
  isCanonicalArtifactProducerGuard(useSite) or
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
