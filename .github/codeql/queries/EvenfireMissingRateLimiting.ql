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

private predicate registeredRouteContainsNodeAtIndex(
  MethodCallExpr registration, Routing::Node node, int index
) {
  exists(Expr installed |
    installed = registration.getArgument(index) and
    node = Routing::getNode(DataFlow::valueNode(installed))
  )
}

/** Test-only route fixtures are not deployed application handlers. */
private predicate isRepositoryTestRoute(Routing::Node useSite) {
  exists(string path, int startLine, int startColumn, int endLine, int endColumn |
    useSite.hasLocationInfo(path, startLine, startColumn, endLine, endColumn) and
    (
      path.matches("%/__tests__/%") or
      path.matches("%.test.ts") or
      path.matches("%.test.tsx") or
      path.matches("%.spec.ts") or
      path.matches("%.spec.tsx")
    )
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
    (branch = ret or ret.nestedIn(branch)) and
    isFixed4xxReturn(ret)
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

private predicate isV2OnlyGuard(Function guard) {
  exists(IfStmt denied, LogNotExpr missingV2, CallExpr classifier, CallExpr next |
    guard.getName() = "requireV2Delegation" and
    denied.getCondition() = missingV2 and
    missingV2.getOperand() = classifier and
    classifier.getCalleeName() = "isV2ViewRequest" and
    classifier.getEnclosingFunction() = guard and
    hasCanonicalV2ViewRequestClassifier(guard, classifier) and
    isFixed4xxBranch(denied.getThen()) and
    next.getCalleeName() = "next" and
    next.getEnclosingFunction() = guard and
    denied.getLocation().getEndLine() < next.getLocation().getStartLine()
  )
}

private predicate hasCanonicalV2ViewRequestClassifier(Function guard, CallExpr classifierCall) {
  exists(
    Function classifier, ReturnStmt classifierReturn, CallExpr booleanCall,
    LogAndExpr exactAuthorityState, PropAccess delegation, PropAccess authorizedAction,
    VarAccess delegationBase, VarAccess actionBase, Parameter classifierParameter,
    Parameter guardRequest
  |
    classifier.getName() = "isV2ViewRequest" and
    classifier.getFile() = guard.getFile() and
    classifierCall.getCallee().(VarAccess).getVariable() = classifier.getVariable() and
    classifierCall.getArgument(0).(VarAccess).getVariable() = guardRequest.getVariable() and
    guardRequest = guard.getParameter(0) and
    classifierReturn.nestedIn(classifier.getBody()) and
    classifierReturn.getExpr() = booleanCall and
    booleanCall.getCalleeName() = "Boolean" and
    booleanCall.getArgument(0) = exactAuthorityState and
    exactAuthorityState.getLeftOperand() = delegation and
    exactAuthorityState.getRightOperand() = authorizedAction and
    classifierParameter = classifier.getParameter(0) and
    delegation.getPropertyName() = "userDelegationV2" and
    delegation.getBase() = delegationBase and
    delegationBase.getVariable() = classifierParameter.getVariable() and
    authorizedAction.getPropertyName() = "authorizedActionV2" and
    authorizedAction.getBase() = actionBase and
    actionBase.getVariable() = classifierParameter.getVariable() and
    not exists(ReturnStmt otherReturn |
      otherReturn.nestedIn(classifier.getBody()) and otherReturn != classifierReturn
    )
  )
}

/**
 * The v2-view branch is exempt only when its consumer capability is rejected
 * before the remote checkpoint. Issuer throttling is not consumer admission.
 * The direct session/reconnect composition is matched by exact imported gate,
 * scope, route binding, and middleware order; same-named wrappers do not match.
 */
private predicate hasRetainedRpcProxyV2ViewConsumer(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, VarAccess middleware, Function authority, VarAccess v2Only,
    Function v2OnlyGuard, Function handler, CallExpr capabilityGate, int authorityIndex,
    int v2OnlyIndex, int handlerIndex, int useIndex
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
    functionOccursWithin(capabilityGate.getEnclosingFunction(), authority) and
    isImportedCall(capabilityGate, "rpc-proxy/src/routeActionBindingV2.ts",
      "rejectUnadmittedV2DerivedView") and
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
      capabilityGate.getLocation().getStartLine() < scope.getLocation().getStartLine() and
      (
        scope.getArgument(0).getStringValue() = "sandbox:ui:view" or
        scope.getArgument(0).getStringValue() = "desktop:view"
      ) and
      hasCanonicalRpcProxyDelegationVerifier()
    )
  )
  or
  exists(
    MethodCallExpr registration, StringLiteral installedPath, Expr rpcAuth, CallExpr scope,
    VarAccess v2Only, Function v2OnlyGuard, int useIndex
  |
    registration.getMethodName() = "post" and
    installedPath = registration.getArgument(0) and
    installedPath.getStringValue() in [
        "/desktop/:hostRef/reconnect",
        "/sandbox-ui/:recipeNs/:recipeName/reconnect"
      ] and
    rpcAuth = registration.getArgument(1) and
    isImportedValue(rpcAuth, "rpc-proxy/src/middleware/auth.ts", "requireRpcAuth") and
    isImportedValue(registration.getArgument(2), "rpc-proxy/src/routeActionBindingV2.ts",
      "rejectUnadmittedV2DerivedView") and
    scope = registration.getArgument(3) and
    isImportedCall(scope, "rpc-proxy/src/middleware/auth.ts", "requireScope") and
    (
      installedPath.getStringValue().matches("/desktop/%") and
      scope.getArgument(0).getStringValue() = "desktop:view"
      or
      installedPath.getStringValue().matches("/sandbox-ui/%") and
      scope.getArgument(0).getStringValue() = "sandbox:ui:view"
    ) and
    v2Only = registration.getArgument(4) and
    v2OnlyGuard.getVariable() = v2Only.getVariable() and
    v2OnlyGuard.getFile() = registration.getFile() and
    isV2OnlyGuard(v2OnlyGuard) and
    registration.getArgument(5) instanceof Function and
    useIndex in [1, 2, 3, 4, 5] and
    canonicalBinderAcceptsRoute(registration) and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
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

/**
 * Spec 76 Class A is a single MCP Host runtime bucket for accepted direct
 * service-plane callers. The RPC Proxy branch is excluded only after the
 * canonical Spec 71 edge guard has authenticated its signed caller context.
 * Recognition is tied to the exact server mount, imported route handler,
 * runtime guard, injected DirectServiceAdmission instance, and a dominating
 * fail-closed-to-429 helper call. A caller header or local same-named helper
 * is not sufficient.
 */
private predicate isClassARoute(string route, string method) {
  method = "post" and
  route in [
    "/v1/runtime/messages",
    "/v1/runtime/provider-messages/authorize",
    "/v1/runtime/workflow-approvals/decide",
    "/v1/runtime/workflow-approval-mediums/link-sessions/confirm",
    "/v1/runtime/workflow-approvals/resolve",
    "/v1/runtime/workflow-results/latest",
    "/v1/runtime/workflow-approval-notifications/claim",
    "/v1/runtime/workflow-approval-notifications/deliveries/:id/:action",
    "/v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event"
  ]
  or
  method = "get" and route = "/v1/runtime/cron/results"
  or
  method = "delete" and route = "/v1/runtime/cron/results/:taskId"
}

private predicate hasClassACallerAllowlist(ArrayExpr callers) {
  exists(StringLiteral directCaller |
    callers.getAnElement() = directCaller and
    directCaller.getStringValue() in ["channel-reader", "workflow-approval-request-reader"]
  ) and
  not exists(Expr unrecognizedCaller |
    callers.getAnElement() = unrecognizedCaller and
    not exists(StringLiteral acceptedCaller |
      acceptedCaller = unrecognizedCaller and
      acceptedCaller.getStringValue() in [
        "rpc-proxy", "channel-reader", "workflow-approval-request-reader"
      ]
    )
  )
}

private predicate isBufferFromVariable(CallExpr bufferCall, Variable value) {
  bufferCall.getCallee().(PropAccess).getPropertyName() = "from" and
  bufferCall.getCallee().(PropAccess).getBase().(VarAccess).getName() = "Buffer" and
  bufferCall.getArgument(0).(VarAccess).getVariable() = value
}

/**
 * The rpc-proxy exemption is valid only after the MCP Host edge guard checks its
 * configured shared service credential. Requiring this source shape prevents a
 * caller header or a same-named pass-through guard from granting the exemption.
 */
private predicate hasCanonicalConfiguredEdgeCredential(Function verifier) {
  verifier.getFile().getRelativePath() = "mcp-host/src/server/edgeRuntimeAuth.ts" and
  verifier.getName() = "rpcProxyServiceAuthenticated" and
  hasConfiguredSecretComparison(verifier) and
  hasAuthorizationDerivedVerifierToken(verifier)
}

private predicate hasConfiguredSecretComparison(Function verifier) {
  exists(
    VariableDeclarator expectedDeclaration, VarDecl expectedBinding, Variable expected,
    PropAccess configuredToken, VariableDeclarator actualBytesDeclaration,
    VarDecl actualBytesBinding, Variable actualBytes, CallExpr actualBytesCall,
    VariableDeclarator expectedBytesDeclaration, VarDecl expectedBytesBinding,
    Variable expectedBytes, CallExpr expectedBytesCall,
    ReturnStmt credentialReturn, LogAndExpr comparedBytes, StrictEqExpr lengthsEqual,
    PropAccess actualLength, PropAccess expectedLength, CallExpr constantTimeCompare,
    VarAccess actualBytesAtCompare, VarAccess expectedBytesAtCompare,
    VarAccess actualBytesAtLength, VarAccess expectedBytesAtLength
  |
    expectedDeclaration.getEnclosingFunction() = verifier and
    expectedBinding = expectedDeclaration.getBindingPattern().(VarDecl) and
    expectedBinding.getName() = "expected" and
    expected = expectedBinding.getVariable() and
    configuredToken = expectedDeclaration.getInit().(PropAccess) and
    configuredToken.getPropertyName() = "rpcProxyEdgeToken" and
    configuredToken.getBase().(VarAccess).getName() = "config" and
    actualBytesDeclaration.getEnclosingFunction() = verifier and
    actualBytesBinding = actualBytesDeclaration.getBindingPattern().(VarDecl) and
    actualBytesBinding.getName() = "actualBytes" and
    actualBytes = actualBytesBinding.getVariable() and
    actualBytesCall = actualBytesDeclaration.getInit().(CallExpr) and
    expectedBytesDeclaration.getEnclosingFunction() = verifier and
    expectedBytesBinding = expectedBytesDeclaration.getBindingPattern().(VarDecl) and
    expectedBytesBinding.getName() = "expectedBytes" and
    expectedBytes = expectedBytesBinding.getVariable() and
    expectedBytesCall = expectedBytesDeclaration.getInit().(CallExpr) and
    isBufferFromVariable(expectedBytesCall, expected) and
    credentialReturn.nestedIn(verifier.getBody()) and
    comparedBytes = credentialReturn.getExpr().(LogAndExpr) and
    lengthsEqual = comparedBytes.getLeftOperand().(StrictEqExpr) and
    actualLength = lengthsEqual.getLeftOperand().(PropAccess) and
    actualLength.getPropertyName() = "length" and
    actualBytesAtLength = actualLength.getBase().(VarAccess) and
    actualBytesAtLength.getVariable() = actualBytes and
    expectedLength = lengthsEqual.getRightOperand().(PropAccess) and
    expectedLength.getPropertyName() = "length" and
    expectedBytesAtLength = expectedLength.getBase().(VarAccess) and
    expectedBytesAtLength.getVariable() = expectedBytes and
    constantTimeCompare = comparedBytes.getRightOperand().(CallExpr) and
    constantTimeCompare.getCalleeName() = "timingSafeEqual" and
    constantTimeCompare.getEnclosingFunction() = verifier and
    actualBytesAtCompare = constantTimeCompare.getArgument(0).(VarAccess) and
    actualBytesAtCompare.getVariable() = actualBytes and
    expectedBytesAtCompare = constantTimeCompare.getArgument(1).(VarAccess) and
    expectedBytesAtCompare.getVariable() = expectedBytes
  )
}

private predicate hasAuthorizationDerivedVerifierToken(Function verifier) {
  exists(
    VariableDeclarator tokenDeclaration, VarDecl tokenBinding, Variable token,
    VariableDeclarator actualBytesDeclaration, CallExpr actualBytesCall,
    VariableDeclarator authorizationDeclaration,
    VarDecl authorizationBinding, Variable authorization, CallExpr authorizationRead,
    VariableDeclarator matchDeclaration, VarDecl matchBinding, Variable match,
    MethodCallExpr regexExec, VarAccess authorizationUse, VarAccess matchUse
  |
    tokenDeclaration.getEnclosingFunction() = verifier and
    tokenBinding = tokenDeclaration.getBindingPattern().(VarDecl) and
    tokenBinding.getName() = "token" and
    token = tokenBinding.getVariable() and
    actualBytesDeclaration.getEnclosingFunction() = verifier and
    actualBytesCall = actualBytesDeclaration.getInit().(CallExpr) and
    isBufferFromVariable(actualBytesCall, token) and
    authorizationDeclaration.getEnclosingFunction() = verifier and
    authorizationBinding = authorizationDeclaration.getBindingPattern().(VarDecl) and
    authorizationBinding.getName() = "authorization" and
    authorization = authorizationBinding.getVariable() and
    authorizationRead.getCalleeName() = "cleanHeader" and
    authorizationRead.getEnclosingFunction() = verifier and
    authorizationRead.getArgument(1).(StringLiteral).getStringValue() = "authorization" and
    authorizationRead.getParentExpr*() = authorizationDeclaration.getInit() and
    matchDeclaration.getEnclosingFunction() = verifier and
    matchBinding = matchDeclaration.getBindingPattern().(VarDecl) and
    matchBinding.getName() = "match" and
    match = matchBinding.getVariable() and
    regexExec = matchDeclaration.getInit().(CallExpr) and
    authorizationUse = regexExec.getArgument(0).(VarAccess) and
    authorizationUse.getVariable() = authorization and
    matchUse.getVariable() = match and
    matchUse.getParentExpr*() = tokenDeclaration.getInit()
  )
}

private predicate hasCanonicalMcpHostRpcProxyEdgeAuthentication() {
  exists(
    Function edgeGuard, Function middleware, Function credentialVerifier,
    ReturnStmt middlewareReturn, VariableDeclarator assertedCallerDeclaration,
    VarDecl assertedCallerBinding, Variable assertedCaller, CallExpr readCaller,
    IfStmt rejectedCaller, LogAndExpr rejectedCondition, StrictEqExpr rpcProxyCheck,
    VarAccess assertedCallerUse, StringLiteral rpcProxy, LogNotExpr missingCredential,
    CallExpr credentialCheck, CallExpr unauthorizedResponse, MethodCallExpr unauthorizedStatus,
    NumberLiteral unauthorizedCode, ReturnStmt unauthorizedReturn, CallExpr next
  |
    edgeGuard.getFile().getRelativePath() = "mcp-host/src/server/edgeRuntimeAuth.ts" and
    edgeGuard.getName() = "runtimeEdgeGuard" and
    functionOccursWithin(middleware, edgeGuard) and
    middlewareReturn.nestedIn(edgeGuard.getBody()) and
    middlewareReturn.getExpr() = middleware and
    credentialVerifier.getVariable() = credentialCheck.getCallee().(VarAccess).getVariable() and
    hasCanonicalConfiguredEdgeCredential(credentialVerifier) and
    assertedCallerBinding.getName() = "assertedCaller" and
    assertedCaller = assertedCallerBinding.getVariable() and
    assertedCallerDeclaration.getBindingPattern() = assertedCallerBinding and
    readCaller.getCalleeName() = "cleanHeader" and
    readCaller.getEnclosingFunction() = middleware and
    assertedCallerDeclaration.getInit() = readCaller and
    rpcProxyCheck.getAnOperand() = assertedCallerUse and
    assertedCallerUse.getVariable() = assertedCaller and
    rpcProxyCheck.getAnOperand() = rpcProxy and
    rpcProxy.getStringValue() = "rpc-proxy" and
    rejectedCondition.getAnOperand() = rpcProxyCheck and
    rejectedCondition.getAnOperand() = missingCredential and
    rejectedCaller.getCondition() = rejectedCondition and
    rejectedCaller.nestedIn(middleware.getBody()) and
    credentialCheck.getEnclosingFunction() = middleware and
    missingCredential.getOperand() = credentialCheck and
    unauthorizedStatus.getCalleeName() = "status" and
    unauthorizedStatus.getEnclosingFunction() = middleware and
    unauthorizedCode = unauthorizedStatus.getArgument(0) and
    unauthorizedCode.getIntValue() = 401 and
    unauthorizedResponse.getCalleeName() = "json" and
    unauthorizedResponse.getEnclosingFunction() = middleware and
    unauthorizedStatus.getParentExpr*() = unauthorizedResponse and
    unauthorizedReturn.nestedIn(rejectedCaller.getThen()) and
    not exists(unauthorizedReturn.getExpr()) and
    next.getCalleeName() = "next" and
    next.getEnclosingFunction() = middleware and
    next.getLocation().getStartLine() > rejectedCaller.getLocation().getEndLine()
  )
}

private predicate isCanonicalDirectServiceAdmissionHelper(Function helper) {
  exists(
    CallExpr callerContext, IfStmt rpcProxyBranch, StrictEqExpr rpcProxyCheck,
    StringLiteral rpcProxy, ReturnStmt rpcProxyReturn, CallExpr admissionCall,
    StringLiteral channelReader, StringLiteral approvalReader, CallExpr denyResponse,
    Expr deniedStatus, VariableDeclarator resultDeclaration, VarDecl resultBinding,
    Variable admissionResult, PropAccess allowed, IfStmt allowedBranch, ReturnStmt allowedReturn,
    ReturnStmt deniedReturn, VariableDeclarator callerDeclaration, VarDecl callerBinding,
    Variable caller, PropAccess callerProperty, VarAccess callerAtRpcCheck,
    StrictNEqExpr channelCheck, StrictNEqExpr approvalCheck, VarAccess callerAtChannelCheck,
    VarAccess callerAtApprovalCheck, IfStmt unrecognizedBranch, LogAndExpr unrecognizedCheck,
    ReturnStmt unrecognizedReturn
  |
    helper.getName() = "admitDirectServiceRequest" and
    helper.getFile().getRelativePath() = "mcp-host/src/server/routes.ts" and
    isImportedCall(callerContext, "mcp-host/src/server/edgeRuntimeAuth.ts",
      "getRuntimeCallerContext") and
    callerContext.getEnclosingFunction() = helper and
    callerContext.getParentExpr*() = callerDeclaration.getInit() and
    callerBinding = callerDeclaration.getBindingPattern().(VarDecl) and
    caller = callerBinding.getVariable() and
    callerProperty.getPropertyName() = "caller" and
    callerProperty.getParentExpr*() = callerDeclaration.getInit() and
    rpcProxyCheck.getAnOperand() = callerAtRpcCheck and
    callerAtRpcCheck.getVariable() = caller and
    rpcProxyBranch.getCondition() = rpcProxyCheck and
    rpcProxy.getStringValue() = "rpc-proxy" and
    rpcProxy.getParentExpr*() = rpcProxyCheck and
    (rpcProxyReturn = rpcProxyBranch.getThen() or
      rpcProxyReturn.nestedIn(rpcProxyBranch.getThen())) and
    rpcProxyReturn.getExpr().(BooleanLiteral).getValue() = "true" and
    admissionCall.getEnclosingFunction() = helper and
    admissionCall.getCalleeName() = "directServiceAdmission" and
    admissionCall.getParentExpr*() = resultDeclaration.getInit() and
    resultBinding = resultDeclaration.getBindingPattern().(VarDecl) and
    admissionResult = resultBinding.getVariable() and
    allowed.getPropertyName() = "allowed" and
    allowed.getBase().(VarAccess).getVariable() = admissionResult and
    allowed.getEnclosingFunction() = helper and
    allowed.getParentExpr*() = allowedBranch.getCondition() and
    (allowedReturn = allowedBranch.getThen() or
      allowedReturn.nestedIn(allowedBranch.getThen())) and
    allowedReturn.getExpr().(BooleanLiteral).getValue() = "true" and
    channelReader.getStringValue() = "channel-reader" and
    channelReader.getFile() = helper.getFile() and
    channelCheck.getAnOperand() = channelReader and
    channelCheck.getAnOperand() = callerAtChannelCheck and
    callerAtChannelCheck.getVariable() = caller and
    approvalReader.getStringValue() = "workflow-approval-request-reader" and
    approvalReader.getFile() = helper.getFile() and
    approvalCheck.getAnOperand() = approvalReader and
    approvalCheck.getAnOperand() = callerAtApprovalCheck and
    callerAtApprovalCheck.getVariable() = caller and
    unrecognizedBranch.getCondition() = unrecognizedCheck and
    channelCheck.getParentExpr*() = unrecognizedCheck and
    approvalCheck.getParentExpr*() = unrecognizedCheck and
    (unrecognizedReturn = unrecognizedBranch.getThen() or
      unrecognizedReturn.nestedIn(unrecognizedBranch.getThen())) and
    unrecognizedReturn.getExpr().(BooleanLiteral).getValue() = "true" and
    denyResponse.getEnclosingFunction() = helper and
    denyResponse.getCalleeName() = "json" and
    deniedStatus.getIntValue() = 429 and
    denyResponse.getArgument(1) = deniedStatus and
    deniedReturn.getLocation().getStartLine() > denyResponse.getLocation().getEndLine() and
    deniedReturn.getExpr().(BooleanLiteral).getValue() = "false"
  )
}

private predicate hasDominatingClassAAdmission(Function routeHandler) {
  exists(
    Function helper, CallExpr admission, IfStmt rejected, LogNotExpr negated,
    ReturnStmt earlyReturn, CallExpr protectedWork
  |
    isCanonicalDirectServiceAdmissionHelper(helper) and
    admission.getCallee().(VarAccess).getVariable() = helper.getVariable() and
    admission.getEnclosingFunction() = routeHandler and
    rejected.getCondition() = negated and
    negated.getOperand() = admission and
    negated.getEnclosingFunction() = routeHandler and
    (earlyReturn = rejected.getThen() or earlyReturn.nestedIn(rejected.getThen())) and
    not exists(earlyReturn.getExpr()) and
    protectedWork.getEnclosingFunction() = routeHandler and
    not exists(CallExpr earlierProtectedWork |
      earlierProtectedWork.getEnclosingFunction() = routeHandler and
      earlierProtectedWork.getCalleeName() = protectedWork.getCalleeName() and
      earlierProtectedWork.getLocation().getStartLine() < rejected.getLocation().getStartLine()
    ) and
    protectedWork.getLocation().getStartLine() > rejected.getLocation().getEndLine()
  )
}

private predicate hasCanonicalDirectServiceAdmissionProvider() {
  exists(Function routeDeps, CallExpr admit, PropAccess receiver |
    routeDeps.getName() = "routeDeps" and
    routeDeps.getFile().getRelativePath() = "mcp-host/src/server.ts" and
    functionOccursWithin(admit.getEnclosingFunction(), routeDeps) and
    admit.getCalleeName() = "admit" and
    admit.getCallee().(PropAccess).getPropertyName() = "admit" and
    receiver = admit.getCallee().(PropAccess).getBase().(PropAccess) and
    receiver.getPropertyName() = "directServiceAdmission" and
    exists(ImportSpecifier spec |
      spec.getImportedName() = "DirectServiceAdmission" and
      spec.getImportDeclaration().getImportedFile().getRelativePath() =
        "mcp-host/src/server/directServiceAdmission.ts" and
      spec.getLocal().getVariable().getAnAccess().getFile() = routeDeps.getFile()
    )
  )
}

private predicate hasClassAAdmission(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral installedPath, CallExpr edgeGuard,
    Function mountedHandler, CallExpr handlerCall, Function routeHandler,
    CallExpr dependencies, int useIndex
  |
    registration.getFile().getRelativePath() = "mcp-host/src/server.ts" and
    installedPath = registration.getArgument(0) and
    isClassARoute(installedPath.getStringValue(), registration.getMethodName()) and
    edgeGuard = registration.getArgument(1) and
    isImportedCall(edgeGuard, "mcp-host/src/server/edgeRuntimeAuth.ts", "runtimeEdgeGuard") and
    hasClassACallerAllowlist(edgeGuard.getArgument(0).(ArrayExpr)) and
    hasCanonicalMcpHostRpcProxyEdgeAuthentication() and
    mountedHandler = registration.getArgument(2).(Function) and
    useIndex in [1, 2] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    handlerCall.getEnclosingFunction() = mountedHandler and
    dependencies.getCalleeName() = "routeDeps" and
    dependencies.getEnclosingFunction() = mountedHandler and
    dependencies.getParentExpr*() = handlerCall.getAnArgument() and
    isImportedCall(handlerCall, "mcp-host/src/server/routes.ts", routeHandler.getName()) and
    routeHandler.getFile().getRelativePath() = "mcp-host/src/server/routes.ts" and
    routeHandler.getName() in [
      "handleMessageRoute",
      "handleProviderMessageAuthorizationRoute",
      "handleProviderWorkflowApprovalDecisionRoute",
      "handleWorkflowApprovalMediumEnrollmentRoute",
      "handleProviderWorkflowApprovalResolveRoute",
      "handleProviderWorkflowResultRequestRoute",
      "handleWorkflowApprovalNotificationClaimRoute",
      "handleWorkflowApprovalNotificationTerminalRoute",
      "handleTelegramWorkflowApprovalVerificationRoute",
      "handleCronResultsRoute",
      "handleCronResultAckRoute"
    ] and
    hasDominatingClassAAdmission(routeHandler) and
    hasCanonicalDirectServiceAdmissionProvider()
  )
}

private predicate isClassAAdmissionCandidateRoute(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral installedPath, CallExpr edgeGuard, int useIndex
  |
    registration.getFile().getRelativePath() = "mcp-host/src/server.ts" and
    installedPath = registration.getArgument(0) and
    isClassARoute(installedPath.getStringValue(), registration.getMethodName()) and
    edgeGuard = registration.getArgument(1) and
    isImportedCall(edgeGuard, "mcp-host/src/server/edgeRuntimeAuth.ts", "runtimeEdgeGuard") and
    hasClassACallerAllowlist(edgeGuard.getArgument(0).(ArrayExpr)) and
    useIndex in [1, 2, 3, 4, 5] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
  )
}

/**
 * Spec 76 Class B is limited to the two legacy session mounts. It requires the
 * exact RPC authentication, Spec 69 v2 rejection, scope, canonical shared
 * admission adapter, handled fail-closed result, and admission before HCC or
 * registry work. The adapter is accepted only when its exact internal Control
 * API endpoint enforces the shared verified-subject bucket.
 */
private predicate hasCanonicalLegacySessionAdmissionEndpoint() {
  exists(
    MethodCallExpr registration, StringLiteral route, CallExpr internalGuard,
    CallExpr userScopes, ArrayExpr scopes, Function handler, CallExpr subjectKey,
    CallExpr limiter, StringLiteral internalService, StringLiteral desktopScope,
    StringLiteral sandboxScope, StringLiteral bucketType, StringLiteral unavailableMode,
    VariableDeclarator subjectDeclaration, VarDecl subjectBinding, Variable subject,
    PropAccess subjectProperty, VariableDeclarator enforcerDeclaration, VarDecl enforcerBinding,
    Variable enforcer, CallExpr createEnforcer, ObjectExpr enforcerOptions,
    Property maxProperty, Expr maxPerMinute, Property unavailableProperty,
    Property bucketTypeProperty
  |
    registration.getFile().getRelativePath() =
      "control-api/src/routes/internal/rpcProxyLegacySessionAdmission.ts" and
    registration.getMethodName() = "post" and
    route = registration.getArgument(0) and
    route.getStringValue() = "/internal/rpc-proxy/legacy-session-admission" and
    isImportedCall(internalGuard, "control-api/src/middleware/internalServiceAuth.ts",
      "requireInternalService") and
    internalGuard.getArgument(0).getStringValue() = "rpc-proxy" and
    isImportedCall(userScopes, "control-api/src/middleware/rpcAccessAuth.ts",
      "requireValidRpcAccessTokenAny") and
    scopes = userScopes.getArgument(0).(ArrayExpr) and
    desktopScope.getStringValue() = "desktop:view" and
    desktopScope.getParentExpr*() = scopes and
    sandboxScope.getStringValue() = "sandbox:ui:view" and
    sandboxScope.getParentExpr*() = scopes and
    handler = registration.getArgument(3).(Function) and
    subjectKey.getEnclosingFunction() = handler and
    subjectKey.getCalleeName() = "legacySessionAdmissionBucketKey" and
    isImportedCall(subjectKey, "control-api/src/services/legacySessionAdmission.ts",
      "legacySessionAdmissionBucketKey") and
    subjectKey.getArgument(0).(VarAccess).getVariable() = subject and
    subjectProperty.getParentExpr*() = subjectDeclaration.getInit() and
    subjectBinding = subjectDeclaration.getBindingPattern().(VarDecl) and
    subject = subjectBinding.getVariable() and
    subjectProperty.getPropertyName() = "sub" and
    subjectProperty.getFile() = registration.getFile() and
    limiter.getEnclosingFunction() = handler and
    limiter.getCalleeName() = "enforceLegacySessionAdmission" and
    enforcerBinding.getName() = "enforceLegacySessionAdmission" and
    enforcerDeclaration.getBindingPattern() = enforcerBinding and
    enforcer = enforcerBinding.getVariable() and
    limiter.getCallee().(VarAccess).getVariable() = enforcer and
    createEnforcer.getCalleeName() = "createRateLimitEnforcer" and
    createEnforcer.getFile().getRelativePath() =
      "control-api/src/routes/internal/rpcProxyLegacySessionAdmission.ts" and
    isImportedCall(createEnforcer, "control-api/src/middleware/rateLimitMiddleware.ts",
      "createRateLimitEnforcer") and
    createEnforcer.getParentExpr*() = enforcerDeclaration.getInit() and
    enforcerOptions = createEnforcer.getArgument(0).(ObjectExpr) and
    internalService.getStringValue() = "rpc-proxy" and
    internalService.getParentExpr*() = internalGuard and
    bucketType.getStringValue() = "legacy_session_creation" and
    bucketType.getFile() = registration.getFile() and
    bucketTypeProperty = enforcerOptions.getPropertyByName("bucketType") and
    bucketType = bucketTypeProperty.getInit().(StringLiteral) and
    maxProperty = enforcerOptions.getPropertyByName("maxPerMinute") and
    maxPerMinute = maxProperty.getInit() and
    hasCanonicalLegacySessionLimit(maxPerMinute) and
    unavailableProperty = enforcerOptions.getPropertyByName("onBackendUnavailable") and
    unavailableMode = unavailableProperty.getInit().(StringLiteral) and
    unavailableMode.getStringValue() = "closed" and
    unavailableMode.getFile() = registration.getFile()
  )
}

private predicate hasCanonicalLegacySessionLimit(Expr configuredLimit) {
  exists(
    ImportSpecifier spec, VarAccess importedLimit, VariableDeclarator declaration,
    VarDecl binding, NumberLiteral approvedLimit
  |
    spec.getImportedName() = "LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE" and
    spec.getImportDeclaration().getImportedFile().getRelativePath() =
      "control-api/src/services/legacySessionAdmission.ts" and
    importedLimit = spec.getLocal().getVariable().getAnAccess() and
    configuredLimit = importedLimit and
    declaration.getFile().getRelativePath() =
      "control-api/src/services/legacySessionAdmission.ts" and
    declaration.getBindingPattern() = binding and
    binding.getName() = "LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE" and
    approvedLimit = declaration.getInit().(NumberLiteral) and
    approvedLimit.getIntValue() = 60
  )
}

private predicate hasHandledLegacySessionAdmission(
  Function routeHandler, string protectedCallName
) {
  exists(
    CallExpr admission, VariableDeclarator declaration, VarDecl binding, Variable admissionResult,
    IfStmt rejected, LogNotExpr negated, PropAccess allowed, ReturnStmt earlyReturn,
    CallExpr protectedWork, CallExpr authToken
  |
    isImportedCall(admission, "rpc-proxy/src/services/controlApiRestService.ts",
      "admitLegacySessionCreation") and
    authToken = admission.getArgument(0).(CallExpr) and
    isImportedCall(authToken, "rpc-proxy/src/middleware/auth.ts", "extractAuthToken") and
    admission.getEnclosingFunction() = routeHandler and
    admission.getParentExpr*() = declaration.getInit() and
    binding = declaration.getBindingPattern().(VarDecl) and
    admissionResult = binding.getVariable() and
    negated.getEnclosingFunction() = routeHandler and
    rejected.getCondition() = negated and
    negated.getOperand() = allowed and
    allowed.getPropertyName() = "allowed" and
    allowed.getBase().(VarAccess).getVariable() = admissionResult and
    earlyReturn.nestedIn(rejected.getThen()) and
    not exists(earlyReturn.getExpr()) and
    protectedWork.getEnclosingFunction() = routeHandler and
    protectedWork.getCalleeName() = protectedCallName and
    not exists(CallExpr earlierProtectedWork |
      earlierProtectedWork.getEnclosingFunction() = routeHandler and
      earlierProtectedWork.getCalleeName() = protectedCallName and
      earlierProtectedWork.getLocation().getStartLine() < rejected.getLocation().getStartLine()
    ) and
    protectedWork.getLocation().getStartLine() > rejected.getLocation().getEndLine()
  )
}

private predicate hasCanonicalLegacySessionAdmissionAdapter() {
  exists(Function adapter, CallExpr upstream, TemplateLiteral url, TemplateElement pathSuffix |
    adapter.getName() = "admitLegacySessionCreation" and
    adapter.getFile().getRelativePath() = "rpc-proxy/src/services/controlApiRestService.ts" and
    upstream.getEnclosingFunction() = adapter and
    upstream.getCalleeName() = "fetch" and
    url = upstream.getArgument(0).(TemplateLiteral) and
    pathSuffix = url.getAnElement() and
    pathSuffix.getRawValue().regexpMatch(".*/internal/rpc-proxy/legacy-session-admission.*")
  )
}

private predicate hasCanonicalSpec69V2Gate() {
  exists(
    Function gate, VariableDeclarator claimsDeclaration, VarDecl claimsBinding, Variable claims,
    PropAccess claimsProperty, VarAccess request, IfStmt legacyBranch, LogNotExpr noClaims,
    CallExpr legacyNext, ReturnStmt legacyReturn, CallExpr binder,
    VarAccess binderClaims, CallExpr v2Response, NumberLiteral unavailableStatus,
    StringLiteral unavailableBody
  |
    gate.getName() = "rejectUnadmittedV2DerivedView" and
    gate.getFile().getRelativePath() = "rpc-proxy/src/routeActionBindingV2.ts" and
    claimsDeclaration.getInit().getParentExpr*() = claimsProperty and
    claimsBinding = claimsDeclaration.getBindingPattern().(VarDecl) and
    claims = claimsBinding.getVariable() and
    claimsProperty.getPropertyName() = "userDelegationV2" and
    request = claimsProperty.getBase().(VarAccess) and
    request.getName() = "req" and
    legacyBranch.getCondition() = noClaims and
    noClaims.getOperand().(VarAccess).getVariable() = claims and
    legacyNext.getEnclosingFunction() = gate and
    legacyNext.getCalleeName() = "next" and
    (legacyNext.getParent*() = legacyBranch.getThen()) and
    legacyReturn = legacyBranch.getThen().(BlockStmt).getAChildStmt().(ReturnStmt) and
    not exists(legacyReturn.getExpr()) and
    binder.getEnclosingFunction() = gate and
    binder.getCalleeName() = "bindRouteActionV2" and
    binderClaims = binder.getArgument(1).(VarAccess) and
    binderClaims.getVariable() = claims and
    v2Response.getEnclosingFunction() = gate and
    v2Response.getCalleeName() = "json" and
    unavailableStatus.getIntValue() = 503 and
    unavailableStatus.getParentExpr*() = v2Response and
    unavailableBody.getStringValue() = "authority_unavailable" and
    unavailableBody.getParentExpr*() = v2Response and
    not exists(CallExpr nextAfterV2Binding |
      nextAfterV2Binding.getEnclosingFunction() = gate and
      nextAfterV2Binding.getCalleeName() = "next" and
      nextAfterV2Binding.getLocation().getStartLine() > binder.getLocation().getEndLine()
    )
  )
}

private predicate hasCanonicalLegacySessionRoute(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral path, Expr auth, Expr v2Gate,
    CallExpr scope, Function handler, StringLiteral scopeName, int useIndex
  |
    registration.getMethodName() = "post" and
    path = registration.getArgument(0) and
    path.getStringValue() in [
      "/desktop/:hostRef/session",
      "/sandbox-ui/:recipeNs/:recipeName/session"
    ] and
    useIndex in [1, 2, 3, 4] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    auth = registration.getArgument(1) and
    isImportedValue(auth, "rpc-proxy/src/middleware/auth.ts", "requireRpcAuth") and
    v2Gate = registration.getArgument(2) and
    isImportedValue(v2Gate, "rpc-proxy/src/routeActionBindingV2.ts",
      "rejectUnadmittedV2DerivedView") and
    hasCanonicalSpec69V2Gate() and
    scope = registration.getArgument(3) and
    isImportedCall(scope, "rpc-proxy/src/middleware/auth.ts", "requireScope") and
    scopeName.getParentExpr*() = scope and
    (
      path.getStringValue() = "/desktop/:hostRef/session" and
      scopeName.getStringValue() = "desktop:view" and
      registration.getFile().getRelativePath() = "rpc-proxy/src/routes/desktopProxy.ts" and
      handler = registration.getArgument(4).(Function) and
      hasCanonicalLegacySessionSessionFlow(handler, "fetch")
      or
      path.getStringValue() = "/sandbox-ui/:recipeNs/:recipeName/session" and
      scopeName.getStringValue() = "sandbox:ui:view" and
      registration.getFile().getRelativePath() = "rpc-proxy/src/routes/sandboxUi.ts" and
      handler = registration.getArgument(4).(Function) and
      hasHandledLegacySessionAdmission(handler, "lookupSandboxUiRegistry") and
      exists(CallExpr v2Classifier |
        v2Classifier.getEnclosingFunction() = handler and
        v2Classifier.getCalleeName() = "isV2ViewRequest" and
        exists(CallExpr admission |
          isImportedCall(admission, "rpc-proxy/src/services/controlApiRestService.ts",
            "admitLegacySessionCreation") and
          admission.getEnclosingFunction() = handler and
          not exists(IfStmt conditional |
            admission.getParent*() = conditional
          ) and
          v2Classifier.getLocation().getStartLine() < admission.getLocation().getStartLine()
        )
      )
    ) and
    hasCanonicalLegacySessionAdmissionEndpoint() and
    hasCanonicalLegacySessionAdmissionAdapter()
  )
}

private predicate hasClassBLegacySessionAdmissionEndpoint(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral path, CallExpr internalGuard,
    CallExpr userScopes, ArrayExpr scopes, Function handler, StringLiteral internalService,
    StringLiteral desktopScope, StringLiteral sandboxScope, int useIndex
  |
    registration.getFile().getRelativePath() =
      "control-api/src/routes/internal/rpcProxyLegacySessionAdmission.ts" and
    registration.getMethodName() = "post" and
    path = registration.getArgument(0) and
    path.getStringValue() = "/internal/rpc-proxy/legacy-session-admission" and
    useIndex in [1, 2, 3] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    internalGuard = registration.getArgument(1) and
    isImportedCall(internalGuard, "control-api/src/middleware/internalServiceAuth.ts",
      "requireInternalService") and
    internalService.getStringValue() = "rpc-proxy" and
    internalService.getParentExpr*() = internalGuard and
    userScopes = registration.getArgument(2) and
    isImportedCall(userScopes, "control-api/src/middleware/rpcAccessAuth.ts",
      "requireValidRpcAccessTokenAny") and
    scopes = userScopes.getArgument(0).(ArrayExpr) and
    desktopScope.getStringValue() = "desktop:view" and
    desktopScope.getParentExpr*() = scopes and
    sandboxScope.getStringValue() = "sandbox:ui:view" and
    sandboxScope.getParentExpr*() = scopes and
    handler = registration.getArgument(3).(Function) and
    hasCanonicalLegacySessionAdmissionEndpoint()
  )
}

private predicate isClassBLegacySessionCandidateRoute(Routing::Node useSite) {
  exists(MethodCallExpr registration, StringLiteral path, int useIndex |
    registration.getMethodName() = "post" and
    registration.getFile().getRelativePath() in [
      "rpc-proxy/src/routes/desktopProxy.ts",
      "rpc-proxy/src/routes/sandboxUi.ts"
    ] and
    path = registration.getArgument(0) and
    path.getStringValue() in [
      "/desktop/:hostRef/session",
      "/sandbox-ui/:recipeNs/:recipeName/session"
    ] and
    useIndex in [1, 2, 3, 4] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
  )
  or
  exists(MethodCallExpr registration, StringLiteral path, int useIndex |
    registration.getFile().getRelativePath() =
      "control-api/src/routes/internal/rpcProxyLegacySessionAdmission.ts" and
    registration.getMethodName() = "post" and
    path = registration.getArgument(0) and
    path.getStringValue() = "/internal/rpc-proxy/legacy-session-admission" and
    useIndex in [1, 2, 3] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
  )
}

private predicate hasOtherLocalRateLimitingGuard(Routing::Node useSite) {
  hasLocalRateLimitingGuard(useSite) and
  not (
    isClassAAdmissionCandidateRoute(useSite) or
    isClassBLegacySessionCandidateRoute(useSite)
  )
}

private predicate hasCanonicalLegacySessionSessionFlow(Function handler, string protectedCallName) {
  exists(Function sessionFlow, CallExpr invocation, BooleanLiteral enabled |
    sessionFlow.getName() = "openOrReconnect" and
    sessionFlow.getFile() = handler.getFile() and
    invocation.getEnclosingFunction() = handler and
    invocation.getCalleeName() = sessionFlow.getName() and
    enabled.getValue() = "true" and
    invocation.getArgument(2) = enabled and
    hasHandledLegacySessionAdmission(sessionFlow, protectedCallName) and
    exists(
      CallExpr v2Classifier, LogNotExpr negated, LogAndExpr legacyCondition,
      IfStmt legacyBranch, CallExpr admission
    |
      v2Classifier.getEnclosingFunction() = sessionFlow and
      v2Classifier.getCalleeName() = "isV2ViewRequest" and
      negated.getOperand() = v2Classifier and
      legacyCondition.getAnOperand() = negated and
      legacyCondition.getEnclosingFunction() = sessionFlow and
      legacyBranch.getCondition() = legacyCondition and
      admission.getParent*() = legacyBranch.getThen() and
      isImportedCall(admission, "rpc-proxy/src/services/controlApiRestService.ts",
        "admitLegacySessionCreation") and
      admission.getEnclosingFunction() = sessionFlow and
      v2Classifier.getLocation().getStartLine() < admission.getLocation().getStartLine()
    )
  )
}

/**
 * R30 admission is distributed across the rpc-proxy artifact resolver and the
 * authoritative Control API. This predicate intentionally uses exact module
 * identities and route/middleware structure rather than inter-service flow.
 */
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
  not isRepositoryTestRoute(useSite) and
  not (
    hasOtherLocalRateLimitingGuard(useSite) or
    hasRetainedRpcProxyV2ViewConsumer(useSite) or
    hasClassAAdmission(useSite) or
    hasClassBLegacySessionAdmissionEndpoint(useSite) or
    hasCanonicalLegacySessionRoute(useSite)
  )
select useSite, "This route handler " + explanation + ", but is not rate-limited.", reference,
  referenceLabel
