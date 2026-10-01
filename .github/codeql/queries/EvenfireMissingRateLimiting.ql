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
  or
  method = "post" and
  route in [
      "/v1/runtime/approvals/approve",
      "/v1/runtime/approvals/deny"
    ]
  or
  method = "get" and
  route in [
      "/v1/runtime/tasks/:taskId/result",
      "/v1/runtime/tasks/:taskId/progress/stream"
    ]
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
    Variable expectedBytes, CallExpr expectedBytesCall, ReturnStmt credentialReturn,
    LogAndExpr comparedBytes, StrictEqExpr lengthsEqual, PropAccess actualLength,
    PropAccess expectedLength, CallExpr constantTimeCompare, VarAccess actualBytesAtCompare,
    VarAccess expectedBytesAtCompare, VarAccess actualBytesAtLength, VarAccess expectedBytesAtLength
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
    VariableDeclarator authorizationDeclaration, VarDecl authorizationBinding,
    Variable authorization, CallExpr authorizationRead, VariableDeclarator matchDeclaration,
    VarDecl matchBinding, Variable match, MethodCallExpr regexExec, VarAccess authorizationUse,
    VarAccess matchUse
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
    (
      rpcProxyReturn = rpcProxyBranch.getThen() or
      rpcProxyReturn.nestedIn(rpcProxyBranch.getThen())
    ) and
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
    (
      allowedReturn = allowedBranch.getThen() or
      allowedReturn.nestedIn(allowedBranch.getThen())
    ) and
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
    (
      unrecognizedReturn = unrecognizedBranch.getThen() or
      unrecognizedReturn.nestedIn(unrecognizedBranch.getThen())
    ) and
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
    Function mountedHandler, CallExpr handlerCall, Function routeHandler, CallExpr dependencies,
    int useIndex
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
        "handleCronResultAckRoute",
        "handleApprovalRoute",
        "handleTaskResultRoute",
        "handleProgressStreamRoute"
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
    MethodCallExpr registration, StringLiteral route, CallExpr internalGuard, CallExpr userScopes,
    ArrayExpr scopes, Function handler, CallExpr subjectKey, CallExpr limiter,
    StringLiteral internalService, StringLiteral desktopScope, StringLiteral sandboxScope,
    StringLiteral bucketType, StringLiteral unavailableMode, VariableDeclarator subjectDeclaration,
    VarDecl subjectBinding, Variable subject, PropAccess subjectProperty,
    VariableDeclarator enforcerDeclaration, VarDecl enforcerBinding, Variable enforcer,
    CallExpr createEnforcer, ObjectExpr enforcerOptions, Property maxProperty, Expr maxPerMinute,
    Property unavailableProperty, Property bucketTypeProperty
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
    unavailableMode.getFile() = registration.getFile() and
    hasCanonicalRateLimitEnforcer()
  )
}

/**
 * The approved Class B and Spec 65 paths must reach the shared PostgreSQL
 * rate-limit pool. A canonical helper name or closed-mode option alone must
 * not make process-local accounting look like durable admission.
 */
private predicate hasCanonicalPostgresRateLimiter(string entryPoint, string queryHelperName) {
  exists(
    Function limiter, CallExpr queryHelper, ArrowFunctionExpr queryAdapter, CallExpr poolQuery,
    PropAccess poolQueryAccess, VarAccess poolAccess, ImportSpecifier poolImport,
    Parameter textParameter, Parameter valuesParameter
  |
    limiter.getFile().getRelativePath() = "control-api/src/services/rateLimiterService.ts" and
    limiter.getName() = entryPoint and
    queryHelper.getEnclosingFunction() = limiter and
    queryHelper.getCalleeName() = queryHelperName and
    queryAdapter = queryHelper.getArgument(0).(ArrowFunctionExpr) and
    poolQuery.getEnclosingFunction() = queryAdapter and
    poolQueryAccess = poolQuery.getCallee().(PropAccess) and
    poolQueryAccess.getPropertyName() = "query" and
    poolAccess = poolQueryAccess.getBase().(VarAccess) and
    poolAccess.getName() = "rateLimitPool" and
    poolImport.getImportedName() = "rateLimitPool" and
    poolImport.getImportDeclaration().getImportedFile().getRelativePath() = "control-api/src/db.ts" and
    poolAccess.getVariable() = poolImport.getLocal().getVariable() and
    textParameter = queryAdapter.getParameter(0) and
    valuesParameter = queryAdapter.getParameter(1) and
    poolQuery.getArgument(0).(VarAccess).getVariable() = textParameter.getVariable() and
    poolQuery.getArgument(1).(VarAccess).getVariable() = valuesParameter.getVariable()
  )
}

private predicate hasCanonicalRateLimitEnforcer() {
  exists(
    Function factory, Function enforcer, CallExpr increment,
    VariableDeclarator processMemoryDeclaration, VarDecl processMemoryBinding,
    Variable processMemory, ConditionalExpr processMemoryMode, StrictEqExpr processMemoryCheck,
    PropAccess unavailableMode, StringLiteral memoryModeLiteral, NullLiteral noMemory,
    VariableDeclarator resultDeclaration, VarDecl resultBinding, Variable admissionResult,
    PropAccess backendAvailable, IfStmt backendUnavailable, LogNotExpr notBackendAvailable,
    IfStmt noMemoryBranch, StrictEqExpr processMemoryIsNull, VarAccess processMemoryAccess,
    NullLiteral missingMemory, CallExpr unavailableResponse, ReturnStmt deniedReturn,
    BooleanLiteral deniedValue
  |
    factory.getFile().getRelativePath() = "control-api/src/middleware/rateLimitMiddleware.ts" and
    factory.getName() = "createRateLimitEnforcer" and
    enforcer.getName() = "enforce" and
    enforcer.getLocation().getStartLine() > factory.getLocation().getStartLine() and
    enforcer.getLocation().getEndLine() < factory.getLocation().getEndLine() and
    increment.getEnclosingFunction() = enforcer and
    isImportedCall(increment, "control-api/src/services/rateLimiterService.ts", "checkAndIncrement") and
    processMemoryDeclaration.getEnclosingFunction() = factory and
    processMemoryMode = processMemoryDeclaration.getInit().(ConditionalExpr) and
    processMemoryBinding = processMemoryDeclaration.getBindingPattern().(VarDecl) and
    processMemory = processMemoryBinding.getVariable() and
    processMemoryCheck = processMemoryMode.getCondition().(StrictEqExpr) and
    unavailableMode = processMemoryCheck.getLeftOperand().(PropAccess) and
    unavailableMode.getPropertyName() = "onBackendUnavailable" and
    unavailableMode.getBase().(VarAccess).getVariable() = factory.getParameter(0).getVariable() and
    memoryModeLiteral = processMemoryCheck.getRightOperand().(StringLiteral) and
    memoryModeLiteral.getStringValue() = "process-memory" and
    noMemory = processMemoryMode.getAlternate().(NullLiteral) and
    resultDeclaration.getEnclosingFunction() = enforcer and
    increment.getParentExpr*() = resultDeclaration.getInit() and
    resultBinding = resultDeclaration.getBindingPattern().(VarDecl) and
    admissionResult = resultBinding.getVariable() and
    backendAvailable.getPropertyName() = "backendAvailable" and
    backendAvailable.getBase().(VarAccess).getVariable() = admissionResult and
    backendUnavailable.nestedIn(enforcer.getBody()) and
    notBackendAvailable.getParentExpr*() = backendUnavailable.getCondition() and
    notBackendAvailable.getOperand() = backendAvailable and
    noMemoryBranch.nestedIn(backendUnavailable.getThen()) and
    processMemoryIsNull = noMemoryBranch.getCondition().(StrictEqExpr) and
    processMemoryAccess = processMemoryIsNull.getLeftOperand().(VarAccess) and
    processMemoryAccess.getVariable() = processMemory and
    missingMemory = processMemoryIsNull.getRightOperand().(NullLiteral) and
    unavailableResponse.getEnclosingFunction() = enforcer and
    unavailableResponse.getCalleeName() = "answerUnavailable" and
    unavailableResponse.getEnclosingStmt().nestedIn(noMemoryBranch.getThen()) and
    deniedReturn.nestedIn(noMemoryBranch.getThen()) and
    deniedValue = deniedReturn.getExpr().(BooleanLiteral) and
    deniedValue.getValue() = "false" and
    unavailableResponse.getLocation().getStartLine() < deniedReturn.getLocation().getStartLine()
  ) and
  hasCanonicalPostgresRateLimiter("checkAndIncrement", "checkAndIncrementWithQuery")
}

private predicate hasCanonicalRateLimitMiddleware() {
  exists(Function middleware, Function factory, CallExpr factoryCall |
    middleware.getFile().getRelativePath() = "control-api/src/middleware/rateLimitMiddleware.ts" and
    middleware.getName() = "rateLimitMiddleware" and
    factory.getFile() = middleware.getFile() and
    factory.getName() = "createRateLimitEnforcer" and
    factoryCall.getEnclosingFunction() = middleware and
    factoryCall.getCallee().(VarAccess).getVariable() = factory.getVariable()
  ) and
  hasCanonicalRateLimitEnforcer()
}

private predicate hasCanonicalLegacySessionLimit(Expr configuredLimit) {
  exists(
    ImportSpecifier spec, VarAccess importedLimit, VariableDeclarator declaration, VarDecl binding,
    NumberLiteral approvedLimit
  |
    spec.getImportedName() = "LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE" and
    spec.getImportDeclaration().getImportedFile().getRelativePath() =
      "control-api/src/services/legacySessionAdmission.ts" and
    importedLimit = spec.getLocal().getVariable().getAnAccess() and
    configuredLimit = importedLimit and
    declaration.getFile().getRelativePath() = "control-api/src/services/legacySessionAdmission.ts" and
    declaration.getBindingPattern() = binding and
    binding.getName() = "LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE" and
    approvedLimit = declaration.getInit().(NumberLiteral) and
    approvedLimit.getIntValue() = 60
  )
}

private predicate hasHandledLegacySessionAdmission(Function routeHandler, string protectedCallName) {
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
    CallExpr legacyNext, ReturnStmt legacyReturn, CallExpr binder, VarAccess binderClaims,
    CallExpr v2Response, NumberLiteral unavailableStatus, StringLiteral unavailableBody
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
    legacyNext.getParent*() = legacyBranch.getThen() and
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
    MethodCallExpr registration, StringLiteral path, Expr auth, Expr v2Gate, CallExpr scope,
    Function handler, StringLiteral scopeName, int useIndex
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
    isImportedValue(v2Gate, "rpc-proxy/src/routeActionBindingV2.ts", "rejectUnadmittedV2DerivedView") and
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
          not exists(IfStmt conditional | admission.getParent*() = conditional) and
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
    MethodCallExpr registration, StringLiteral path, CallExpr internalGuard, CallExpr userScopes,
    ArrayExpr scopes, Function handler, StringLiteral internalService, StringLiteral desktopScope,
    StringLiteral sandboxScope, int useIndex
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
      CallExpr v2Classifier, LogNotExpr negated, LogAndExpr legacyCondition, IfStmt legacyBranch,
      CallExpr admission
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
 * Spec 65 is a composed user-ingress boundary. Legacy requests are charged by
 * the canonical RPC Proxy adapter before Host resolution; v2 requests are
 * charged by the action-authority checkpoint before live authority work. This
 * recognition is deliberately limited to the enumerated route/scope pairs and
 * the canonical trusted-subject producers in both services.
 */
private predicate hasCanonicalSpec65Operation(string operationId) {
  exists(
    VariableDeclarator operationsDeclaration, VarDecl operationsBinding, Variable operations,
    Function requiresAdmission, Parameter operationParameter, MethodCallExpr membership,
    StringLiteral operationLiteral
  |
    operationsDeclaration.getFile().getRelativePath() =
      "control-api/src/services/hostRpcAdmission.ts" and
    operationsBinding = operationsDeclaration.getBindingPattern().(VarDecl) and
    operationsBinding.getName() = "HOST_RPC_ADMISSION_OPERATIONS" and
    operations = operationsBinding.getVariable() and
    operationLiteral.getStringValue() = operationId and
    operationLiteral.getFile() = operationsDeclaration.getFile() and
    operationLiteral.getParentExpr*() = operationsDeclaration.getInit() and
    requiresAdmission.getName() = "requiresHostRpcAdmission" and
    requiresAdmission.getFile() = operationsDeclaration.getFile() and
    operationParameter = requiresAdmission.getParameter(0) and
    membership.getEnclosingFunction() = requiresAdmission and
    membership.getMethodName() = "has" and
    membership.getReceiver().(VarAccess).getVariable() = operations and
    membership.getArgument(0).(VarAccess).getVariable() = operationParameter.getVariable()
  )
}

private predicate hasCompleteSpec65OperationSet() {
  hasCanonicalSpec65Operation("host.wake") and
  hasCanonicalSpec65Operation("task.manage") and
  hasCanonicalSpec65Operation("task.read") and
  hasCanonicalSpec65Operation("session.read") and
  hasCanonicalSpec65Operation("session.manage") and
  hasCanonicalSpec65Operation("model.read") and
  hasCanonicalSpec65Operation("model.select") and
  hasCanonicalSpec65Operation("host.activity.read") and
  hasCanonicalSpec65Operation("host.activity.read_all") and
  hasCanonicalSpec65Operation("host.status.read") and
  hasCanonicalSpec65Operation("host.health.read")
}

private predicate hasCanonicalStrictFixedWindowFailureHandling() {
  exists(
    Function wrapper, Parameter implementation, ImportSpecifier strictImporter,
    VarAccess strictDefault, CallExpr strictCheck, VariableDeclarator resultDeclaration,
    VarDecl resultBinding, Variable admissionResult, AssignExpr strictAssignment,
    VarAccess assignedResult, PropAccess backendAvailable, StrictNEqExpr backendIsAvailable,
    BooleanLiteral backendTrue, IfStmt unavailableBranch, ReturnStmt unavailableReturn,
    ObjectExpr unavailableResult, Property unavailableStatusProperty,
    StringLiteral unavailableStatus
  |
    wrapper.getFile().getRelativePath() = "control-api/src/services/strictFixedWindowAdmission.ts" and
    wrapper.getName() = "admitStrictFixedWindow" and
    implementation = wrapper.getParameter(2) and
    implementation.getName() = "checkAndIncrementImpl" and
    strictImporter.getImportedName() = "checkAndIncrementStrict" and
    strictImporter.getImportDeclaration().getImportedFile().getRelativePath() =
      "control-api/src/services/rateLimiterService.ts" and
    strictDefault = implementation.getDefault().(VarAccess) and
    strictDefault.getVariable() = strictImporter.getLocal().getVariable() and
    strictCheck.getEnclosingFunction() = wrapper and
    strictCheck.getCallee().(VarAccess).getVariable() = implementation.getVariable() and
    resultDeclaration.getEnclosingFunction() = wrapper and
    resultBinding = resultDeclaration.getBindingPattern().(VarDecl) and
    admissionResult = resultBinding.getVariable() and
    (
      strictCheck.getParentExpr*() = resultDeclaration.getInit()
      or
      strictCheck.getParentExpr*() = strictAssignment.getRhs() and
      strictAssignment.getEnclosingFunction() = wrapper and
      assignedResult = strictAssignment.getLhs().(VarAccess) and
      assignedResult.getVariable() = admissionResult and
      not exists(AssignExpr anotherAssignment, VarAccess anotherTarget |
        anotherAssignment.getEnclosingFunction() = wrapper and
        anotherTarget = anotherAssignment.getLhs().(VarAccess) and
        anotherTarget.getVariable() = admissionResult and
        anotherAssignment != strictAssignment
      )
    ) and
    backendAvailable.getPropertyName() = "backendAvailable" and
    backendAvailable.getBase().(VarAccess).getVariable() = admissionResult and
    backendIsAvailable.getLeftOperand() = backendAvailable and
    backendTrue = backendIsAvailable.getRightOperand().(BooleanLiteral) and
    backendTrue.getValue() = "true" and
    backendIsAvailable.getParentExpr*() = unavailableBranch.getCondition() and
    unavailableBranch.nestedIn(wrapper.getBody()) and
    unavailableReturn.nestedIn(unavailableBranch.getThen()) and
    unavailableResult = unavailableReturn.getExpr().(ObjectExpr) and
    unavailableStatusProperty = unavailableResult.getPropertyByName("status") and
    unavailableStatus = unavailableStatusProperty.getInit().(StringLiteral) and
    unavailableStatus.getStringValue() = "unavailable"
  )
}

private predicate hasCanonicalSpec65AdmissionProducer() {
  exists(
    Function admission, CallExpr strictWindow, CallExpr subjectKey, Parameter verifiedSubject,
    Function bucketKeyBody, TemplateLiteral keyTemplate, Parameter bucketSubject,
    VarAccess subjectAtKey, PropAccess configuredLimit
  |
    admission.getFile().getRelativePath() = "control-api/src/services/hostRpcAdmission.ts" and
    admission.getName() = "admitHostRpc" and
    verifiedSubject = admission.getParameter(0) and
    strictWindow.getEnclosingFunction() = admission and
    isImportedCall(strictWindow, "control-api/src/services/strictFixedWindowAdmission.ts",
      "admitStrictFixedWindow") and
    subjectKey = strictWindow.getArgument(0).(CallExpr) and
    subjectKey.getCalleeName() = "hostRpcAdmissionBucketKey" and
    subjectKey.getArgument(0).(VarAccess).getVariable() = verifiedSubject.getVariable() and
    configuredLimit = strictWindow.getArgument(1).(PropAccess) and
    configuredLimit.getPropertyName() = "hostRpcAdmissionRlPerMin" and
    configuredLimit.getBase().(VarAccess).getName() = "config" and
    exists(StringLiteral bucketPrefix |
      bucketKeyBody.getFile() = admission.getFile() and
      bucketKeyBody.getName() = "hostRpcAdmissionBucketKey" and
      subjectKey.getCallee().(VarAccess).getVariable() = bucketKeyBody.getVariable() and
      bucketSubject = bucketKeyBody.getParameter(0) and
      subjectAtKey.getEnclosingFunction() = bucketKeyBody and
      subjectAtKey.getVariable() = bucketSubject.getVariable() and
      keyTemplate.getEnclosingFunction() = bucketKeyBody and
      bucketPrefix.getFile() = admission.getFile() and
      bucketPrefix.getStringValue() = "host-rpc-admission:" and
      subjectAtKey.getLocation().getStartLine() >= keyTemplate.getLocation().getStartLine()
    ) and
    hasCompleteSpec65OperationSet() and
    hasCanonicalStrictFixedWindowFailureHandling() and
    hasCanonicalPostgresRateLimiter("checkAndIncrementStrict", "checkAndIncrementStrictWithQuery")
  )
}

private predicate hasCanonicalSpec65Checkpoint() {
  exists(
    MethodCallExpr registration, StringLiteral path, Expr callerGuard, Function handler,
    CallExpr requiresAdmission, CallExpr admission, PropAccess parsedOperation,
    PropAccess parsedPrincipal, PropAccess parsedSubject, IfStmt denied, StrictNEqExpr notAllowed,
    PropAccess admissionStatus, StringLiteral allowedStatus, CallExpr failureResponse,
    ReturnStmt earlyReturn, CallExpr protectedWork, VariableDeclarator resultDeclaration,
    VarDecl resultBinding, Variable admissionResult
  |
    registration.getFile().getRelativePath() =
      "control-api/src/routes/internal/actionAuthorityCheckpoint.ts" and
    registration.getMethodName() = "post" and
    path = registration.getArgument(0) and
    path.getStringValue() = "/internal/action-authority/checkpoint" and
    callerGuard = registration.getArgument(1) and
    isImportedValue(callerGuard, "control-api/src/middleware/actionCheckpointCaller.ts",
      "requireActionCheckpointCaller") and
    handler = registration.getArgument(2).(Function) and
    isImportedCall(requiresAdmission, "control-api/src/services/hostRpcAdmission.ts",
      "requiresHostRpcAdmission") and
    requiresAdmission.getEnclosingFunction() = handler and
    parsedOperation.getPropertyName() = "operationId" and
    parsedOperation = requiresAdmission.getArgument(0).(PropAccess) and
    parsedOperation.getBase().(VarAccess).getName() = "parsed" and
    isImportedCall(admission, "control-api/src/services/hostRpcAdmission.ts", "admitHostRpc") and
    admission.getEnclosingFunction() = handler and
    parsedSubject.getPropertyName() = "sub" and
    parsedPrincipal.getPropertyName() = "principal" and
    parsedPrincipal.getBase().(VarAccess).getName() = "parsed" and
    parsedSubject.getBase() = parsedPrincipal and
    admission.getArgument(0) = parsedSubject and
    admission.getParentExpr*() = resultDeclaration.getInit() and
    resultBinding = resultDeclaration.getBindingPattern().(VarDecl) and
    admissionResult = resultBinding.getVariable() and
    denied.nestedIn(handler.getBody()) and
    denied.getCondition() = notAllowed and
    notAllowed.getAnOperand() = admissionStatus and
    admissionStatus.getPropertyName() = "status" and
    admissionStatus.getBase().(VarAccess).getVariable() = admissionResult and
    notAllowed.getAnOperand() = allowedStatus and
    allowedStatus.getStringValue() = "allowed" and
    isImportedCall(failureResponse, "control-api/src/services/hostRpcAdmission.ts",
      "respondHostRpcAdmissionFailure") and
    failureResponse.getEnclosingFunction() = handler and
    failureResponse.getArgument(1).(VarAccess).getVariable() = admissionResult and
    earlyReturn.nestedIn(denied.getThen()) and
    not exists(earlyReturn.getExpr()) and
    protectedWork.getEnclosingFunction() = handler and
    isImportedCall(protectedWork, "control-api/src/services/access/actionAuthorityCheckpoint.ts",
      "checkpointActionAuthority") and
    requiresAdmission.getLocation().getStartLine() < admission.getLocation().getStartLine() and
    admission.getLocation().getEndLine() < denied.getLocation().getStartLine() and
    denied.getLocation().getEndLine() < protectedWork.getLocation().getStartLine() and
    hasCanonicalSpec65AdmissionProducer()
  )
}

private predicate hasCanonicalSpec65LegacyAdapter() {
  exists(
    Function adapter, IfStmt v2Branch, PropAccess v2Claims, ReturnStmt v2Return, CallExpr admission,
    PropAccess subject, MethodCallExpr hostClaim, IfStmt hostDenied, ReturnStmt hostDeniedReturn,
    BooleanLiteral hostDeniedValue, Function requestAdapter, PropAccess authProperty,
    VariableDeclarator authDeclaration, VarDecl authBinding, Variable auth,
    MethodCallExpr unavailableResponse, MethodCallExpr unavailableStatus,
    NumberLiteral unavailableCode, ReturnStmt unavailableReturn, BooleanLiteral deniedResult
  |
    adapter.getFile().getRelativePath() = "rpc-proxy/src/services/hostRpcAdmission.ts" and
    adapter.getName() = "admitLegacyHostRpcRequest" and
    v2Claims.getPropertyName() = "userDelegationV2" and
    v2Claims.getBase().(VarAccess).getName() = "req" and
    v2Claims.getEnclosingFunction() = adapter and
    v2Branch.getCondition() = v2Claims and
    v2Branch.nestedIn(adapter.getBody()) and
    v2Return = v2Branch.getThen() and
    v2Return.getExpr().(BooleanLiteral).getValue() = "true" and
    hostDenied.nestedIn(adapter.getBody()) and
    hostClaim.getEnclosingFunction() = adapter and
    hostClaim.getMethodName() = "includes" and
    hostClaim.getReceiver().(PropAccess).getPropertyName() = "hostRefs" and
    hostClaim.getReceiver().(PropAccess).getBase().(VarAccess).getVariable() = auth and
    hostClaim.getParentExpr*() = hostDenied.getCondition() and
    hostDeniedReturn.nestedIn(hostDenied.getThen()) and
    hostDeniedReturn.getExpr() = hostDeniedValue and
    hostDeniedValue.getValue() = "false" and
    authDeclaration.getInit() = authProperty and
    authBinding = authDeclaration.getBindingPattern().(VarDecl) and
    authProperty.getPropertyName() = "auth" and
    authProperty.getBase().(VarAccess).getName() = "req" and
    auth = authBinding.getVariable() and
    isImportedCall(admission, "rpc-proxy/src/services/controlApiRestService.ts",
      "requestHostRpcAdmission") and
    admission.getEnclosingFunction() = adapter and
    subject.getPropertyName() = "sub" and
    subject.getParentExpr*() = admission.getArgument(0) and
    subject.getBase().(VarAccess).getVariable() = auth and
    hostClaim.getLocation().getEndLine() < admission.getLocation().getStartLine() and
    unavailableStatus.getMethodName() = "status" and
    unavailableStatus.getEnclosingFunction() = adapter and
    unavailableCode.getIntValue() = 503 and
    unavailableStatus.getArgument(0) = unavailableCode and
    unavailableResponse.getMethodName() = "json" and
    unavailableStatus.getParentExpr*() = unavailableResponse and
    unavailableResponse.getLocation().getStartLine() <
      unavailableReturn.getLocation().getStartLine() and
    unavailableReturn.nestedIn(adapter.getBody()) and
    unavailableReturn.getExpr() = deniedResult and
    deniedResult.getValue() = "false" and
    requestAdapter.getFile().getRelativePath() = "rpc-proxy/src/services/controlApiRestService.ts" and
    requestAdapter.getName() = "requestHostRpcAdmission" and
    exists(CallExpr request, TemplateElement urlFragment, VarAccess fetchFallback |
      request.getEnclosingFunction() = requestAdapter and
      fetchFallback.getName() = "fetch" and
      fetchFallback.getParentExpr*() = request.getCallee() and
      urlFragment = request.getArgument(0).(TemplateLiteral).getAnElement() and
      urlFragment.getRawValue().regexpMatch(".*host-rpc-admission.*")
    )
  )
}

private predicate isCanonicalSpec65ProxyRoute(
  string route, string method, string scope, string operationId
) {
  method = "post" and
  route = "/rpc/hosts/:hostRef/wake" and
  scope = "host:wake:write" and
  operationId = "host.wake"
  or
  method = "post" and
  route in [
      "/rpc/hosts/:hostRef/approvals/approve",
      "/rpc/hosts/:hostRef/approvals/deny"
    ] and
  scope = "host:approval:write" and
  operationId = "task.manage"
  or
  method = "get" and
  route = "/rpc/hosts/:hostRef/sessions/search" and
  scope = "host:session:read" and
  operationId = "session.read"
  or
  method = "get" and
  route in [
      "/rpc/hosts/:hostRef/sessions",
      "/rpc/hosts/:hostRef/sessions/:agent/:chatId/messages",
      "/rpc/hosts/:hostRef/sessions/:agent/:chatId/context-breakdown"
    ] and
  scope = "host:session:read" and
  operationId = "session.read"
  or
  method = "patch" and
  route = "/rpc/hosts/:hostRef/sessions/:agent/:chatId/name" and
  scope = "host:session:write" and
  operationId = "session.manage"
  or
  method = "get" and
  route = "/rpc/hosts/:hostRef/models" and
  scope = "host:session:read" and
  operationId = "model.read"
  or
  method = "post" and
  route = "/rpc/hosts/:hostRef/model" and
  scope = "host:model:write" and
  operationId = "model.select"
  or
  method = "get" and
  route = "/rpc/hosts/:hostRef/tasks/:taskId/result" and
  scope = "host:message:invoke" and
  operationId = "task.read"
  or
  method = "post" and
  route = "/rpc/hosts/:hostRef/tasks/:taskId/cancel" and
  scope = "host:message:invoke" and
  operationId = "task.manage"
  or
  method = "get" and
  route in [
      "/rpc/hosts/:hostRef/activity",
      "/rpc/hosts/:hostRef/activity/stream"
    ] and
  scope = "host:activity:read" and
  operationId = "host.activity.read"
  or
  method = "get" and
  route = "/rpc/hosts/:hostRef/status" and
  scope = "host:status:read" and
  operationId = "host.status.read"
  or
  method = "get" and
  route = "/rpc/hosts/:hostRef/status/stream" and
  scope = "host:status:read" and
  operationId = "host.status.read"
  or
  method = "get" and
  route = "/rpc/hosts/:hostRef/health" and
  scope = "host:health:read" and
  operationId = "host.health.read"
  or
  method = "get" and
  route = "/rpc/hosts/:hostRef/tasks/:taskId/progress/stream" and
  scope = "host:activity:read" and
  operationId = "host.activity.read"
}

private predicate hasCanonicalSpec65RoutePreflight(
  MethodCallExpr registration, string route, string scope, Function handler
) {
  exists(
    Expr auth, CallExpr preflight, StringLiteral preflightScope, int preflightIndex,
    int handlerIndex
  |
    registration.getFile().getRelativePath().matches("rpc-proxy/src/routes/%") and
    registration.getMethodName() in ["get", "post", "patch"] and
    registration.getArgument(0).(StringLiteral).getStringValue() = route and
    registration.getArgument(1) = auth and
    isImportedValue(auth, "rpc-proxy/src/middleware/auth.ts", "requireRpcAuth") and
    preflightIndex in [2, 3, 4] and
    registration.getArgument(preflightIndex) = preflight and
    handlerIndex in [3, 4, 5] and
    handlerIndex = registration.getNumArgument() - 1 and
    registration.getArgument(handlerIndex) = handler and
    preflightIndex < handlerIndex and
    (
      isImportedCall(preflight, "rpc-proxy/src/middleware/auth.ts", "requireHostRpcPreflightScope") or
      isImportedCall(preflight, "rpc-proxy/src/middleware/auth.ts",
        "requireHostRpcJsonBodyPreflightScope")
    ) and
    preflightScope = preflight.getArgument(0).(StringLiteral) and
    preflightScope.getStringValue() = scope and
    hasCanonicalSpec65PreflightImplementation()
  )
  or
  exists(
    Expr auth, CallExpr binder, Expr v2Only, Expr preflight, StringLiteral boundScope,
    int handlerIndex
  |
    route = "/rpc/hosts/:hostRef/sessions/search" and
    registration.getFile().getRelativePath() = "rpc-proxy/src/routes/rpc.ts" and
    registration.getMethodName() = "get" and
    registration.getArgument(1) = auth and
    isImportedValue(auth, "rpc-proxy/src/middleware/auth.ts", "requireRpcAuth") and
    registration.getArgument(2) = binder and
    isImportedCall(binder, "rpc-proxy/src/middleware/auth.ts", "bindHostRpcScope") and
    boundScope = binder.getArgument(0).(StringLiteral) and
    boundScope.getStringValue() = scope and
    registration.getArgument(3) = v2Only and
    isImportedValue(v2Only, "rpc-proxy/src/middleware/auth.ts", "requireV2SessionSearch") and
    registration.getArgument(4) = preflight and
    isImportedValue(preflight, "rpc-proxy/src/middleware/auth.ts", "runHostRpcPreflightCheckpoint") and
    handlerIndex = registration.getNumArgument() - 1 and
    registration.getArgument(handlerIndex) = handler and
    handlerIndex = 5 and
    hasCanonicalSpec65PreflightImplementation()
  )
}

private predicate hasCanonicalSpec65PreflightImplementation() {
  exists(Function preflight, CallExpr parse, CallExpr validate, CallExpr checkpoint |
    preflight.getFile().getRelativePath() = "rpc-proxy/src/middleware/auth.ts" and
    preflight.getName() = "runHostRpcPreflightCheckpoint" and
    parse.getEnclosingFunction() = preflight and
    parse.getCalleeName() = "hostRpcRoutePreflight" and
    validate.getLocation().getStartLine() >= preflight.getLocation().getStartLine() and
    validate.getLocation().getEndLine() <= preflight.getLocation().getEndLine() and
    validate.getCalleeName() = "validateHostRef" and
    checkpoint.getLocation().getStartLine() >= preflight.getLocation().getStartLine() and
    checkpoint.getLocation().getEndLine() <= preflight.getLocation().getEndLine() and
    checkpoint.getCalleeName() = "checkpointBoundHostRpcAction" and
    parse.getLocation().getStartLine() < validate.getLocation().getStartLine() and
    validate.getLocation().getEndLine() < checkpoint.getLocation().getStartLine()
  )
}

private predicate hasHandledSpec65LegacyAdmission(Function handler) {
  exists(
    CallExpr admission, IfStmt denied, UnaryExpr negated, ReturnStmt deniedReturn,
    CallExpr resolveHost
  |
    isImportedCall(admission, "rpc-proxy/src/services/hostRpcAdmission.ts",
      "admitLegacyHostRpcRequest") and
    admission.getEnclosingFunction() = handler and
    denied.nestedIn(handler.getBody()) and
    denied.getCondition() = negated and
    negated.getOperator() = "!" and
    admission.getParentExpr*() = negated and
    deniedReturn = denied.getThen() and
    not exists(deniedReturn.getExpr()) and
    resolveHost.getEnclosingFunction() = handler and
    isImportedCall(resolveHost, "rpc-proxy/src/services/mcpProxyService.ts",
      "resolveHostConnectionForUser") and
    denied.getLocation().getEndLine() < resolveHost.getLocation().getStartLine()
  )
}

private predicate hasCanonicalSpec65RpcProxyRouteCoordinates(
  MethodCallExpr registration, string wantedRoute, string wantedMethod, string wantedScope,
  string wantedOperation
) {
  exists(
    StringLiteral routeLiteral, string scope, string operationId, Function handler, int handlerIndex
  |
    registration.getFile().getRelativePath() in [
        "rpc-proxy/src/routes/rpc.ts",
        "rpc-proxy/src/routes/rpcHostActivityStream.ts",
        "rpc-proxy/src/routes/rpcHostProgressStream.ts",
        "rpc-proxy/src/routes/rpcHostStatusStream.ts"
      ] and
    routeLiteral = registration.getArgument(0).(StringLiteral) and
    routeLiteral.getStringValue() = wantedRoute and
    registration.getMethodName() = wantedMethod and
    isCanonicalSpec65ProxyRoute(routeLiteral.getStringValue(), registration.getMethodName(), scope,
      operationId) and
    scope = wantedScope and
    operationId = wantedOperation and
    hasCanonicalSpec65Operation(operationId) and
    hasCompleteSpec65OperationSet() and
    hasCanonicalSpec65AdmissionProducer() and
    hasCanonicalSpec65Checkpoint() and
    hasCanonicalSpec65LegacyAdapter() and
    handlerIndex in [3, 4, 5] and
    handlerIndex = registration.getNumArgument() - 1 and
    handler = registration.getArgument(handlerIndex).(Function) and
    hasHandledSpec65LegacyAdmission(handler) and
    hasCanonicalSpec65RoutePreflight(registration, routeLiteral.getStringValue(), scope, handler)
  )
}

private predicate hasAnyCanonicalSpec65RpcProxyRouteCoordinates(
  string wantedRoute, string wantedMethod, string wantedScope, string wantedOperation
) {
  exists(MethodCallExpr registration |
    hasCanonicalSpec65RpcProxyRouteCoordinates(registration, wantedRoute, wantedMethod, wantedScope,
      wantedOperation)
  )
}

private predicate hasCanonicalSpec65RpcProxyRoute(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral routeLiteral, string scope, string operationId,
    int useIndex
  |
    registration.getFile().getRelativePath() in [
        "rpc-proxy/src/routes/rpc.ts",
        "rpc-proxy/src/routes/rpcHostActivityStream.ts",
        "rpc-proxy/src/routes/rpcHostProgressStream.ts",
        "rpc-proxy/src/routes/rpcHostStatusStream.ts"
      ] and
    routeLiteral = registration.getArgument(0).(StringLiteral) and
    isCanonicalSpec65ProxyRoute(routeLiteral.getStringValue(), registration.getMethodName(), scope,
      operationId) and
    hasCanonicalSpec65RpcProxyRouteCoordinates(registration, routeLiteral.getStringValue(),
      registration.getMethodName(), scope, operationId) and
    useIndex in [1, 2, 3, 4, 5] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
  )
}

private predicate spec65HostRoutePair(
  string hostPath, string hostMethod, string hostScope, string proxyPath, string proxyMethod,
  string proxyScope, string operationId, string handlerName
) {
  hostMethod = "get" and
  hostPath = "/v1/runtime/status" and
  hostScope = "host.status.read" and
  proxyPath = "/rpc/hosts/:hostRef/status" and
  proxyMethod = "get" and
  proxyScope = "host:status:read" and
  operationId = "host.status.read" and
  handlerName = "handleStatusRoute"
  or
  hostMethod = "get" and
  hostPath = "/v1/runtime/activity" and
  hostScope = "host.activity.read" and
  proxyPath = "/rpc/hosts/:hostRef/activity" and
  proxyMethod = "get" and
  proxyScope = "host:activity:read" and
  operationId = "host.activity.read" and
  handlerName = "handleActivityRoute"
  or
  hostMethod = "get" and
  hostPath = "/v1/runtime/activity/stream" and
  hostScope = "host.activity.read" and
  proxyPath = "/rpc/hosts/:hostRef/activity/stream" and
  proxyMethod = "get" and
  proxyScope = "host:activity:read" and
  operationId = "host.activity.read" and
  handlerName = "handleActivityStreamRoute"
  or
  hostMethod = "post" and
  hostPath = "/v1/runtime/approvals/approve" and
  hostScope = "task.manage" and
  proxyPath = "/rpc/hosts/:hostRef/approvals/approve" and
  proxyMethod = "post" and
  proxyScope = "host:approval:write" and
  operationId = "task.manage" and
  handlerName = "handleApprovalRoute"
  or
  hostMethod = "post" and
  hostPath = "/v1/runtime/approvals/deny" and
  hostScope = "task.manage" and
  proxyPath = "/rpc/hosts/:hostRef/approvals/deny" and
  proxyMethod = "post" and
  proxyScope = "host:approval:write" and
  operationId = "task.manage" and
  handlerName = "handleApprovalRoute"
  or
  hostMethod = "get" and
  hostPath = "/v1/runtime/sessions" and
  hostScope = "session.read" and
  proxyPath = "/rpc/hosts/:hostRef/sessions" and
  proxyMethod = "get" and
  proxyScope = "host:session:read" and
  operationId = "session.read" and
  handlerName = "handleSessionsListRoute"
  or
  hostMethod = "get" and
  hostPath = "/v1/runtime/sessions/search" and
  hostScope = "session.read" and
  proxyPath = "/rpc/hosts/:hostRef/sessions/search" and
  proxyMethod = "get" and
  proxyScope = "host:session:read" and
  operationId = "session.read" and
  handlerName = "handleSessionSearchRoute"
  or
  hostMethod = "get" and
  hostPath = "/v1/runtime/sessions/:agent/:chatId/messages" and
  hostScope = "session.read" and
  proxyPath = "/rpc/hosts/:hostRef/sessions/:agent/:chatId/messages" and
  proxyMethod = "get" and
  proxyScope = "host:session:read" and
  operationId = "session.read" and
  handlerName = "handleSessionMessagesRoute"
  or
  hostMethod = "get" and
  hostPath = "/v1/runtime/sessions/:agent/:chatId/context-breakdown" and
  hostScope = "session.read" and
  proxyPath = "/rpc/hosts/:hostRef/sessions/:agent/:chatId/context-breakdown" and
  proxyMethod = "get" and
  proxyScope = "host:session:read" and
  operationId = "session.read" and
  handlerName = "handleContextBreakdownRoute"
  or
  hostMethod = "patch" and
  hostPath = "/v1/runtime/sessions/:agent/:chatId/name" and
  hostScope = "session.manage" and
  proxyPath = "/rpc/hosts/:hostRef/sessions/:agent/:chatId/name" and
  proxyMethod = "patch" and
  proxyScope = "host:session:write" and
  operationId = "session.manage" and
  handlerName = "handleSetTitleRoute"
  or
  hostMethod = "get" and
  hostPath = "/v1/runtime/tasks/:taskId/result" and
  hostScope = "task.read" and
  proxyPath = "/rpc/hosts/:hostRef/tasks/:taskId/result" and
  proxyMethod = "get" and
  proxyScope = "host:message:invoke" and
  operationId = "task.read" and
  handlerName = "handleTaskResultRoute"
  or
  hostMethod = "post" and
  hostPath = "/v1/runtime/tasks/:taskId/cancel" and
  hostScope = "task.manage" and
  proxyPath = "/rpc/hosts/:hostRef/tasks/:taskId/cancel" and
  proxyMethod = "post" and
  proxyScope = "host:message:invoke" and
  operationId = "task.manage" and
  handlerName = "handleTaskCancelRoute"
  or
  hostMethod = "get" and
  hostPath = "/v1/runtime/models" and
  hostScope = "model.read" and
  proxyPath = "/rpc/hosts/:hostRef/models" and
  proxyMethod = "get" and
  proxyScope = "host:session:read" and
  operationId = "model.read" and
  handlerName = "handleModelsListRoute"
  or
  hostMethod = "post" and
  hostPath = "/v1/runtime/model" and
  hostScope = "model.select" and
  proxyPath = "/rpc/hosts/:hostRef/model" and
  proxyMethod = "post" and
  proxyScope = "host:model:write" and
  operationId = "model.select" and
  handlerName = "handleSetModelRoute"
  or
  hostMethod = "get" and
  hostPath = "/v1/runtime/tasks/:taskId/progress/stream" and
  hostScope = "task.read" and
  proxyPath = "/rpc/hosts/:hostRef/tasks/:taskId/progress/stream" and
  proxyMethod = "get" and
  proxyScope = "host:activity:read" and
  operationId = "host.activity.read" and
  handlerName = "handleProgressStreamRoute"
}

private predicate hasRpcProxyOnlyCallerAllowlist(ArrayExpr callers) {
  exists(StringLiteral proxyCaller |
    callers.getAnElement() = proxyCaller and
    proxyCaller.getStringValue() = "rpc-proxy"
  ) and
  not exists(Expr otherCaller |
    callers.getAnElement() = otherCaller and
    not exists(StringLiteral onlyCaller |
      onlyCaller = otherCaller and onlyCaller.getStringValue() = "rpc-proxy"
    )
  )
}

private predicate hasCanonicalSpec65McpHostRoute(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral hostPath, CallExpr edgeGuard,
    Function mountedHandler, CallExpr handlerCall, Function routeHandler, CallExpr dependencies,
    int useIndex, string hostScope, string proxyPath, string proxyMethod, string proxyScope,
    string operationId, string handlerName, string hostMethod
  |
    registration.getFile().getRelativePath() = "mcp-host/src/server.ts" and
    hostPath = registration.getArgument(0).(StringLiteral) and
    hostMethod = registration.getMethodName() and
    edgeGuard = registration.getArgument(1) and
    isImportedCall(edgeGuard, "mcp-host/src/server/edgeRuntimeAuth.ts", "runtimeEdgeGuard") and
    hostScope = edgeGuard.getArgument(1).(ArrayExpr).getAnElement().(StringLiteral).getStringValue() and
    spec65HostRoutePair(hostPath.getStringValue(), hostMethod, hostScope, proxyPath, proxyMethod,
      proxyScope, operationId, handlerName) and
    hasCanonicalMcpHostRpcProxyEdgeAuthentication() and
    mountedHandler = registration.getArgument(2).(Function) and
    useIndex in [1, 2] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex) and
    handlerCall.getEnclosingFunction() = mountedHandler and
    isImportedCall(handlerCall, "mcp-host/src/server/routes.ts", handlerName) and
    routeHandler.getFile().getRelativePath() = "mcp-host/src/server/routes.ts" and
    routeHandler.getName() = handlerName and
    dependencies.getCalleeName() = "routeDeps" and
    dependencies.getEnclosingFunction() = mountedHandler and
    dependencies.getParentExpr*() = handlerCall.getAnArgument() and
    hasAnyCanonicalSpec65RpcProxyRouteCoordinates(proxyPath, proxyMethod, proxyScope, operationId) and
    (
      hasRpcProxyOnlyCallerAllowlist(edgeGuard.getArgument(0).(ArrayExpr))
      or
      hasClassACallerAllowlist(edgeGuard.getArgument(0).(ArrayExpr)) and
      hasClassAAdmission(useSite)
    )
  )
}

/**
 * The task-cancel Host mount is intentionally inline in server.ts rather than
 * delegated to routes.ts. Its only admitted caller is authenticated RPC Proxy,
 * whose paired route performs the canonical Spec 65 checkpoint.
 */
private predicate hasCanonicalSpec65InlineHostCancelRoute(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral hostPath, CallExpr edgeGuard, ArrayExpr callers,
    ArrayExpr scopes, StringLiteral scope, int useIndex
  |
    registration.getFile().getRelativePath() = "mcp-host/src/server.ts" and
    registration.getMethodName() = "post" and
    hostPath = registration.getArgument(0).(StringLiteral) and
    hostPath.getStringValue() = "/v1/runtime/tasks/:taskId/cancel" and
    edgeGuard = registration.getArgument(1) and
    isImportedCall(edgeGuard, "mcp-host/src/server/edgeRuntimeAuth.ts", "runtimeEdgeGuard") and
    callers = edgeGuard.getArgument(0).(ArrayExpr) and
    hasRpcProxyOnlyCallerAllowlist(callers) and
    scopes = edgeGuard.getArgument(1).(ArrayExpr) and
    scope = scopes.getAnElement().(StringLiteral) and
    scope.getStringValue() = "task.manage" and
    hasCanonicalMcpHostRpcProxyEdgeAuthentication() and
    hasAnyCanonicalSpec65RpcProxyRouteCoordinates("/rpc/hosts/:hostRef/tasks/:taskId/cancel",
      "post", "host:message:invoke", "task.manage") and
    useIndex in [1, 2] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
  )
}

private predicate hasCanonicalSpec62MessageCheckpoint() {
  exists(
    MethodCallExpr registration, StringLiteral route, Function handler,
    VariableDeclarator chargeDeclaration, VarDecl chargeBinding, Variable shouldCharge,
    LogAndExpr chargeCondition, StrictEqExpr operationCheck, PropAccess operation,
    StringLiteral messageOperation, StrictEqExpr callerCheck, PropAccess callerService,
    StringLiteral proxyService, IfStmt chargeBranch, CallExpr admission, PropAccess subject,
    PropAccess principal, VariableDeclarator resultDeclaration, VarDecl resultBinding,
    Variable admissionResult, IfStmt rejected, StrictNEqExpr notAllowed, PropAccess status,
    StringLiteral allowed, CallExpr failureResponse, ReturnStmt earlyReturn, CallExpr checkpointWork
  |
    registration.getFile().getRelativePath() =
      "control-api/src/routes/internal/actionAuthorityCheckpoint.ts" and
    registration.getMethodName() = "post" and
    route = registration.getArgument(0) and
    route.getStringValue() = "/internal/action-authority/checkpoint" and
    handler = registration.getArgument(2).(Function) and
    chargeDeclaration.getEnclosingFunction() = handler and
    chargeBinding = chargeDeclaration.getBindingPattern().(VarDecl) and
    chargeBinding.getName() = "chargesHostMessageAdmission" and
    shouldCharge = chargeBinding.getVariable() and
    chargeCondition = chargeDeclaration.getInit().(LogAndExpr) and
    operationCheck = chargeCondition.getLeftOperand().(StrictEqExpr) and
    operation = operationCheck.getLeftOperand().(PropAccess) and
    operation.getPropertyName() = "operationId" and
    operation.getBase().(VarAccess).getName() = "parsed" and
    messageOperation = operationCheck.getRightOperand().(StringLiteral) and
    messageOperation.getStringValue() = "chat.message.invoke" and
    callerCheck = chargeCondition.getRightOperand().(StrictEqExpr) and
    callerService = callerCheck.getLeftOperand().(PropAccess) and
    callerService.getPropertyName() = "service" and
    callerService.getBase().(VarAccess).getName() = "caller" and
    proxyService = callerCheck.getRightOperand().(StringLiteral) and
    proxyService.getStringValue() = "rpc-proxy" and
    chargeBranch.getCondition().(VarAccess).getVariable() = shouldCharge and
    chargeBranch.nestedIn(handler.getBody()) and
    isImportedCall(admission, "control-api/src/services/hostMessageAdmission.ts", "admitHostMessage") and
    admission.getEnclosingFunction() = handler and
    principal.getPropertyName() = "principal" and
    principal.getBase().(VarAccess).getName() = "parsed" and
    subject.getPropertyName() = "sub" and
    subject.getBase() = principal and
    admission.getArgument(0) = subject and
    admission.getParentExpr*() = resultDeclaration.getInit() and
    resultBinding = resultDeclaration.getBindingPattern().(VarDecl) and
    admissionResult = resultBinding.getVariable() and
    rejected.getCondition().(StrictNEqExpr) = notAllowed and
    notAllowed.getAnOperand() = status and
    status.getPropertyName() = "status" and
    status.getBase().(VarAccess).getVariable() = admissionResult and
    notAllowed.getAnOperand() = allowed and
    allowed.getStringValue() = "allowed" and
    rejected.nestedIn(chargeBranch.getThen()) and
    isImportedCall(failureResponse, "control-api/src/services/hostMessageAdmission.ts",
      "respondHostMessageAdmissionFailure") and
    failureResponse.getArgument(1).(VarAccess).getVariable() = admissionResult and
    earlyReturn.nestedIn(rejected.getThen()) and
    not exists(earlyReturn.getExpr()) and
    isImportedCall(checkpointWork, "control-api/src/services/access/actionAuthorityCheckpoint.ts",
      "checkpointActionAuthority") and
    checkpointWork.getEnclosingFunction() = handler and
    rejected.getLocation().getEndLine() < checkpointWork.getLocation().getStartLine()
  )
}

private predicate hasCanonicalSpec62LegacyMessageResolution() {
  exists(
    MethodCallExpr registration, TemplateLiteral route, TemplateElement suffix, CallExpr tokenAuth,
    StringLiteral messageScope, Function handler, CallExpr admission, PropAccess subject,
    VarAccess claimsAccess, PropAccess authClaims, VariableDeclarator claimsDeclaration,
    VarDecl claimsBinding, Variable claimsVariable, VariableDeclarator resultDeclaration,
    VarDecl resultBinding, Variable admissionResult, IfStmt rejected, StrictNEqExpr notAllowed,
    PropAccess status, StringLiteral allowed, CallExpr failureResponse, ReturnStmt earlyReturn,
    CallExpr protectedWork
  |
    registration.getFile().getRelativePath() = "control-api/src/routes/rpc-access/users.ts" and
    registration.getMethodName() = "post" and
    route = registration.getArgument(0).(TemplateLiteral) and
    suffix = route.getAnElement() and
    suffix.getRawValue().regexpMatch(".*/message-resolution") and
    tokenAuth = registration.getArgument(1) and
    isImportedCall(tokenAuth, "control-api/src/middleware/rpcAccessAuth.ts",
      "requireValidRpcAccessToken") and
    messageScope = tokenAuth.getArgument(0).(StringLiteral) and
    messageScope.getStringValue() = "host:message:invoke" and
    handler = registration.getArgument(registration.getNumArgument() - 1).(Function) and
    isImportedCall(admission, "control-api/src/services/hostMessageAdmission.ts", "admitHostMessage") and
    admission.getEnclosingFunction() = handler and
    claimsDeclaration.getEnclosingFunction() = handler and
    claimsDeclaration.getInit() = authClaims and
    claimsBinding = claimsDeclaration.getBindingPattern().(VarDecl) and
    claimsVariable = claimsBinding.getVariable() and
    authClaims.getPropertyName() = "rpcAuth" and
    authClaims.getBase().(VarAccess).getName() = "req" and
    subject.getPropertyName() = "sub" and
    claimsAccess = subject.getBase().(VarAccess) and
    claimsAccess.getVariable() = claimsVariable and
    admission.getArgument(0) = subject and
    admission.getParentExpr*() = resultDeclaration.getInit() and
    resultBinding = resultDeclaration.getBindingPattern().(VarDecl) and
    admissionResult = resultBinding.getVariable() and
    rejected.nestedIn(handler.getBody()) and
    notAllowed = rejected.getCondition().(StrictNEqExpr) and
    status.getPropertyName() = "status" and
    status.getBase().(VarAccess).getVariable() = admissionResult and
    notAllowed.getAnOperand() = status and
    notAllowed.getAnOperand() = allowed and
    allowed.getStringValue() = "allowed" and
    isImportedCall(failureResponse, "control-api/src/services/hostMessageAdmission.ts",
      "respondHostMessageAdmissionFailure") and
    failureResponse.getArgument(1).(VarAccess).getVariable() = admissionResult and
    earlyReturn.nestedIn(rejected.getThen()) and
    not exists(earlyReturn.getExpr()) and
    protectedWork.getCalleeName() = "respondWithAuthorizedHostConnection" and
    protectedWork.getFile().getRelativePath() = "control-api/src/routes/rpc-access/users.ts" and
    protectedWork.getEnclosingFunction() = handler and
    rejected.getLocation().getEndLine() < protectedWork.getLocation().getStartLine()
  )
}

private predicate hasCanonicalSpec62RpcProxyMessageRoute(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral route, Expr auth, Expr bodyParser, CallExpr binding,
    StringLiteral messageScope, Expr checkpoint, Function handler, CallExpr hostResolver,
    CallExpr runtimeContext, ObjectExpr messageOptions, Property messageResolution,
    BooleanLiteral enabled, int useIndex
  |
    registration.getFile().getRelativePath() = "rpc-proxy/src/routes/rpc.ts" and
    registration.getMethodName() = "post" and
    route = registration.getArgument(0) and
    route.getStringValue() = "/rpc/hosts/:hostRef/messages" and
    auth = registration.getArgument(1) and
    isImportedValue(auth, "rpc-proxy/src/middleware/auth.ts", "requireRpcAuth") and
    bodyParser = registration.getArgument(2) and
    isImportedValue(bodyParser, "rpc-proxy/src/middleware/chatJsonBody.ts", "chatJsonBody") and
    binding = registration.getArgument(3) and
    isImportedCall(binding, "rpc-proxy/src/middleware/auth.ts", "bindHostRpcScope") and
    messageScope = binding.getArgument(0).(StringLiteral) and
    messageScope.getStringValue() = "host:message:invoke" and
    checkpoint = registration.getArgument(4) and
    isImportedValue(checkpoint, "rpc-proxy/src/middleware/auth.ts", "runHostRpcPreflightCheckpoint") and
    handler = registration.getArgument(5).(Function) and
    hostResolver.getEnclosingFunction() = handler and
    isImportedCall(hostResolver, "rpc-proxy/src/services/mcpProxyService.ts",
      "resolveHostConnectionForUser") and
    runtimeContext.getCalleeName() = "runtimeHostEdgeContext" and
    runtimeContext.getParentExpr*() = hostResolver.getAnArgument() and
    messageOptions = runtimeContext.getArgument(1).(ObjectExpr) and
    messageResolution = messageOptions.getPropertyByName("messageResolution") and
    enabled = messageResolution.getInit().(BooleanLiteral) and
    enabled.getValue() = "true" and
    hasCanonicalSpec62MessageCheckpoint() and
    hasCanonicalSpec62LegacyMessageResolution() and
    useIndex in [1, 2, 3, 4, 5, 6] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
  )
}

/**
 * Spec 48 artifact reads are admitted durably by Control API before live Host
 * resolution. This exception is deliberately limited to the authenticated
 * RPC Proxy list/download routes and their exact Host runtime mounts; it is
 * not a filename, service, or artifact-handler-wide exclusion.
 */
private predicate hasCanonicalSpec48ArtifactReadEndpoint() {
  exists(
    MethodCallExpr registration, TemplateLiteral path, TemplateElement pathSuffix, CallExpr auth,
    ArrayExpr scopes, StringLiteral scope, CallExpr userMatch, CallExpr hostMatch,
    CallExpr subjectAdmission, ObjectExpr subjectOptions, Property subjectBucketProperty,
    StringLiteral subjectBucket, Property unavailableProperty, StringLiteral closed,
    Function subjectKey, VariableDeclarator subjectDeclaration, VarDecl subjectBinding,
    Variable subject, PropAccess subjectRead, PropAccess rpcAuthRead, VarAccess req,
    TemplateLiteral subjectKeyTemplate, TemplateElement subjectKeyPrefix, Function resolveHandler,
    CallExpr resolve, CallExpr canonicalAdmission, ObjectExpr canonicalOptions,
    Property canonicalBucketProperty, StringLiteral canonicalBucket,
    Property canonicalUnavailableProperty, StringLiteral canonicalClosed
  |
    registration.getFile().getRelativePath() = "control-api/src/routes/rpc-access/users.ts" and
    registration.getMethodName() = "get" and
    path = registration.getArgument(0).(TemplateLiteral) and
    pathSuffix = path.getAnElement() and
    pathSuffix.getRawValue() = "/artifact-read" and
    auth = registration.getArgument(1) and
    isImportedCall(auth, "control-api/src/middleware/rpcAccessAuth.ts",
      "requireValidRpcAccessTokenAny") and
    scopes = auth.getArgument(0).(ArrayExpr) and
    scope.getStringValue() = "host:task:read" and
    scope.getParentExpr*() = scopes and
    userMatch = registration.getArgument(2) and
    isImportedCall(userMatch, "control-api/src/middleware/rpcAccessAuth.ts",
      "requireRpcTokenUserMatch") and
    hostMatch = registration.getArgument(3) and
    isImportedCall(hostMatch, "control-api/src/middleware/rpcAccessAuth.ts",
      "requireRpcTokenHostMatch") and
    subjectAdmission = registration.getArgument(4) and
    isImportedCall(subjectAdmission, "control-api/src/middleware/rateLimitMiddleware.ts",
      "rateLimitMiddleware") and
    subjectOptions = subjectAdmission.getArgument(0).(ObjectExpr) and
    subjectBucketProperty = subjectOptions.getPropertyByName("bucketType") and
    subjectBucket = subjectBucketProperty.getInit().(StringLiteral) and
    subjectBucket.getStringValue() = "host_artifact_pre_admission" and
    unavailableProperty = subjectOptions.getPropertyByName("onBackendUnavailable") and
    closed = unavailableProperty.getInit().(StringLiteral) and
    closed.getStringValue() = "closed" and
    subjectKey = subjectOptions.getPropertyByName("getBucketKey").getInit().(Function) and
    subjectDeclaration.getEnclosingFunction() = subjectKey and
    subjectBinding = subjectDeclaration.getBindingPattern().(VarDecl) and
    subject = subjectBinding.getVariable() and
    subjectRead.getPropertyName() = "sub" and
    subjectRead.getParentExpr*() = subjectDeclaration.getInit() and
    rpcAuthRead.getParentExpr*() = subjectRead and
    rpcAuthRead.getPropertyName() = "rpcAuth" and
    req.getParentExpr*() = rpcAuthRead and
    req.getVariable() = subjectKey.getParameter(0).getVariable() and
    exists(VarAccess subjectUse |
      subjectKeyTemplate = subjectUse.getParentExpr*().(TemplateLiteral) and
      subjectUse.getVariable() = subject and
      subjectKeyPrefix = subjectKeyTemplate.getAnElement() and
      subjectKeyPrefix.getRawValue() = "host-artifact-pre-admission:"
    ) and
    not exists(PropAccess rotatingKeyPart |
      rotatingKeyPart.getEnclosingFunction() = subjectKey and
      rotatingKeyPart.getPropertyName() in ["hostRef", "params", "query", "body"]
    ) and
    resolveHandler = registration.getArgument(5).(Function) and
    resolve.getEnclosingFunction() = resolveHandler and
    resolve.getCalleeName() = "resolveAuthorizedHostConnection" and
    subjectAdmission.getLocation().getEndLine() < resolve.getLocation().getStartLine() and
    canonicalAdmission = registration.getArgument(6) and
    isImportedCall(canonicalAdmission, "control-api/src/middleware/rateLimitMiddleware.ts",
      "rateLimitMiddleware") and
    canonicalOptions = canonicalAdmission.getArgument(0).(ObjectExpr) and
    canonicalBucketProperty = canonicalOptions.getPropertyByName("bucketType") and
    canonicalBucket = canonicalBucketProperty.getInit().(StringLiteral) and
    canonicalBucket.getStringValue() = "host_artifact_read" and
    canonicalUnavailableProperty = canonicalOptions.getPropertyByName("onBackendUnavailable") and
    canonicalClosed = canonicalUnavailableProperty.getInit().(StringLiteral) and
    canonicalClosed.getStringValue() = "closed" and
    hasCanonicalRateLimitMiddleware() and
    resolveHandler.getLocation().getEndLine() < canonicalAdmission.getLocation().getStartLine()
  )
}

private predicate hasCanonicalSpec48ArtifactReadProxyAdapter() {
  exists(
    Function artifactResolver, CallExpr fetcher, VarAccess userId, VarAccess hostRef,
    VarAccess token, Parameter artifactUser, Parameter artifactHost, Parameter artifactToken,
    Function fetchWrapper, Parameter wrapperUser, Parameter wrapperHost, Parameter wrapperToken,
    VarAccess fetchUser, VarAccess fetchHost, VarAccess fetchToken, CallExpr fetchPath,
    VarAccess globalFetch, ObjectExpr options, Property artifactReadOption, BooleanLiteral enabled,
    Function pathFetcher, CallExpr fetchRequest, ConditionalExpr selectedPath,
    TemplateLiteral artifactPath, TemplateElement artifactSuffix
  |
    artifactResolver.getFile().getRelativePath() = "rpc-proxy/src/services/mcpProxyService.ts" and
    artifactResolver.getName() = "resolveArtifactReadHostConnectionForUser" and
    fetcher.getEnclosingFunction() = artifactResolver and
    isImportedCall(fetcher, "rpc-proxy/src/services/controlApiRestService.ts",
      "fetchArtifactReadHostConnectionFromControlApi") and
    userId = fetcher.getArgument(0).(VarAccess) and
    hostRef = fetcher.getArgument(1).(VarAccess) and
    token = fetcher.getArgument(2).(VarAccess) and
    artifactUser = artifactResolver.getParameter(0) and
    artifactHost = artifactResolver.getParameter(1) and
    artifactToken = artifactResolver.getParameter(2) and
    userId.getVariable() = artifactUser.getVariable() and
    hostRef.getVariable() = artifactHost.getVariable() and
    token.getVariable() = artifactToken.getVariable() and
    fetchWrapper.getFile().getRelativePath() = "rpc-proxy/src/services/controlApiRestService.ts" and
    fetchWrapper.getName() = "fetchArtifactReadHostConnectionFromControlApi" and
    wrapperUser = fetchWrapper.getParameter(0) and
    wrapperHost = fetchWrapper.getParameter(1) and
    wrapperToken = fetchWrapper.getParameter(2) and
    fetchRequest.getEnclosingFunction() = fetchWrapper and
    fetchRequest.getCalleeName() = "fetchHostConnectionForPath" and
    fetchUser = fetchRequest.getArgument(0).(VarAccess) and
    fetchHost = fetchRequest.getArgument(1).(VarAccess) and
    fetchToken = fetchRequest.getArgument(2).(VarAccess) and
    fetchUser.getVariable() = wrapperUser.getVariable() and
    fetchHost.getVariable() = wrapperHost.getVariable() and
    fetchToken.getVariable() = wrapperToken.getVariable() and
    options = fetchRequest.getArgument(3).(ObjectExpr) and
    artifactReadOption = options.getPropertyByName("artifactRead") and
    enabled = artifactReadOption.getInit().(BooleanLiteral) and
    enabled.getValue() = "true" and
    pathFetcher.getFile() = fetchWrapper.getFile() and
    pathFetcher.getName() = "fetchHostConnectionForPath" and
    fetchPath.getEnclosingFunction() = pathFetcher and
    globalFetch.getName() = "fetch" and
    globalFetch.getParentExpr*() = fetchPath.getCallee() and
    selectedPath = fetchPath.getArgument(0).(ConditionalExpr) and
    artifactPath = selectedPath.getConsequent().(TemplateLiteral) and
    artifactSuffix = artifactPath.getAnElement() and
    artifactSuffix.getRawValue() = "/artifact-read"
  ) and
  hasCanonicalSpec48ArtifactReadEndpoint()
}

private predicate hasHandledSpec48ArtifactResolver(Function resolverFunction) {
  exists(
    CallExpr resolution, VariableDeclarator resultDeclaration, VarDecl resultBinding,
    Variable resolvedHost, CallExpr deniedCheck, IfStmt deniedBranch, CallExpr deniedResponse,
    ReturnStmt deniedReturn, LogNotExpr missingCheck, IfStmt missingBranch,
    MethodCallExpr missingStatus, NumberLiteral forbidden, MethodCallExpr missingBody,
    ReturnStmt missingReturn, CallExpr nextCall, CallExpr fallback
  |
    resolverFunction.getName() = "resolveArtifactReadHost" and
    resolverFunction.getFile().getRelativePath() = "rpc-proxy/src/routes/rpc.ts" and
    isImportedCall(resolution, "rpc-proxy/src/services/mcpProxyService.ts",
      "resolveArtifactReadHostConnectionForUser") and
    resolution.getEnclosingFunction() = resolverFunction and
    resolution.getParentExpr*() = resultDeclaration.getInit() and
    resultBinding = resultDeclaration.getBindingPattern().(VarDecl) and
    resolvedHost = resultBinding.getVariable() and
    isImportedCall(deniedCheck, "rpc-proxy/src/services/hostAccessDenial.ts", "isHostAccessDenied") and
    deniedCheck.getEnclosingFunction() = resolverFunction and
    deniedCheck.getArgument(0).(VarAccess).getVariable() = resolvedHost and
    deniedBranch.getCondition() = deniedCheck and
    deniedBranch.nestedIn(resolverFunction.getBody()) and
    isImportedCall(deniedResponse, "rpc-proxy/src/services/hostAccessDenial.ts",
      "respondHostAccessDenied") and
    deniedResponse.getEnclosingFunction() = resolverFunction and
    deniedResponse.getArgument(1).(VarAccess).getVariable() = resolvedHost and
    deniedReturn.nestedIn(deniedBranch.getThen()) and
    not exists(deniedReturn.getExpr()) and
    missingCheck.getEnclosingFunction() = resolverFunction and
    missingCheck.getOperand().(VarAccess).getVariable() = resolvedHost and
    missingBranch.getCondition() = missingCheck and
    missingBranch.nestedIn(resolverFunction.getBody()) and
    missingStatus.getEnclosingFunction() = resolverFunction and
    missingStatus.getMethodName() = "status" and
    forbidden = missingStatus.getArgument(0).(NumberLiteral) and
    forbidden.getIntValue() = 403 and
    missingBody.getEnclosingFunction() = resolverFunction and
    missingBody.getMethodName() = "json" and
    missingStatus.getParentExpr*() = missingBody and
    missingReturn.nestedIn(missingBranch.getThen()) and
    not exists(missingReturn.getExpr()) and
    nextCall.getEnclosingFunction() = resolverFunction and
    nextCall.getCalleeName() = "next" and
    nextCall.getNumArgument() = 0 and
    nextCall.getLocation().getStartLine() > missingBranch.getLocation().getEndLine() and
    fallback.getEnclosingFunction() = resolverFunction and
    fallback.getCalleeName() = "guardedNext" and
    fallback.getLocation().getStartLine() > nextCall.getLocation().getStartLine()
  )
}

private predicate hasCanonicalSpec48RpcProxyArtifactRoute(Routing::Node useSite, string routePath) {
  exists(
    MethodCallExpr registration, StringLiteral route, Expr auth, CallExpr scope,
    StringLiteral scopeName, VarAccess resolverMiddleware, VariableDeclarator resolverDeclaration,
    VarDecl resolverBinding, Function resolverFunction, Function handler, int resolverIndex,
    int useIndex, CallExpr helperCall, PropAccess subject, TemplateLiteral downstreamPath,
    TemplateElement downstreamSuffix, TemplateElement downstreamPrefix, CallExpr downstreamFetch
  |
    registration.getFile().getRelativePath() = "rpc-proxy/src/routes/rpc.ts" and
    registration.getMethodName() = "get" and
    route = registration.getArgument(0).(StringLiteral) and
    route.getStringValue() = routePath and
    route.getStringValue() in [
        "/rpc/hosts/:hostRef/artifacts",
        "/rpc/hosts/:hostRef/artifacts/:filename/download"
      ] and
    auth = registration.getArgument(1) and
    isImportedValue(auth, "rpc-proxy/src/middleware/auth.ts", "requireRpcAuth") and
    (
      route.getStringValue() = "/rpc/hosts/:hostRef/artifacts" and
      scope = registration.getArgument(2).(CallExpr) and
      isImportedCall(scope, "rpc-proxy/src/middleware/auth.ts", "requireHostRefCheckpointScope") and
      scopeName = scope.getArgument(0).(StringLiteral) and
      scopeName.getStringValue() = "host:task:read" and
      resolverIndex = 3
      or
      route.getStringValue() = "/rpc/hosts/:hostRef/artifacts/:filename/download" and
      scope = registration.getArgument(2).(CallExpr) and
      isImportedCall(scope, "rpc-proxy/src/middleware/auth.ts", "bindHostRpcScope") and
      scopeName = scope.getArgument(0).(StringLiteral) and
      scopeName.getStringValue() = "host:task:read" and
      resolverIndex = 5 and
      isImportedValue(registration.getArgument(4), "rpc-proxy/src/middleware/auth.ts",
        "runHostRefCheckpoint")
    ) and
    resolverMiddleware = registration.getArgument(resolverIndex).(VarAccess) and
    resolverBinding = resolverDeclaration.getBindingPattern().(VarDecl) and
    resolverBinding.getVariable() = resolverMiddleware.getVariable() and
    resolverDeclaration.getDeclStmt() instanceof ConstDeclStmt and
    resolverFunction = resolverDeclaration.getInit().(Function) and
    resolverFunction.getName() = "resolveArtifactReadHost" and
    resolverFunction.getFile().getRelativePath() = "rpc-proxy/src/routes/rpc.ts" and
    helperCall.getEnclosingFunction() = resolverFunction and
    isImportedCall(helperCall, "rpc-proxy/src/services/mcpProxyService.ts",
      "resolveArtifactReadHostConnectionForUser") and
    hasHandledSpec48ArtifactResolver(resolverFunction) and
    subject = helperCall.getArgument(0).(PropAccess) and
    subject.getPropertyName() = "sub" and
    subject.getBase().(VarAccess).getName() = "auth" and
    handler = registration.getArgument(registration.getNumArgument() - 1).(Function) and
    downstreamFetch.getEnclosingFunction().getFile() = registration.getFile() and
    downstreamFetch.getCalleeName() = "fetch" and
    functionOccursWithin(downstreamFetch.getEnclosingFunction(), handler) and
    downstreamPath = downstreamFetch.getArgument(0).(TemplateLiteral) and
    downstreamSuffix = downstreamPath.getAnElement() and
    (
      route.getStringValue() = "/rpc/hosts/:hostRef/artifacts" and
      downstreamSuffix.getRawValue().regexpMatch(".*/v1/runtime/artifacts")
      or
      route.getStringValue() = "/rpc/hosts/:hostRef/artifacts/:filename/download" and
      downstreamPrefix.getRawValue().regexpMatch(".*/v1/runtime/artifacts/") and
      downstreamSuffix.getRawValue() = "/download" and
      downstreamPrefix = downstreamPath.getAnElement()
    ) and
    resolverIndex < registration.getNumArgument() - 1 and
    handler.getFile().getRelativePath() = "rpc-proxy/src/routes/rpc.ts" and
    hasCanonicalSpec48ArtifactReadProxyAdapter() and
    useIndex >= 1 and
    useIndex <= registration.getNumArgument() - 1 and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
  )
}

private predicate hasCanonicalSpec48McpHostArtifactRoute(Routing::Node useSite) {
  exists(
    MethodCallExpr registration, StringLiteral route, VarAccess workflowReject,
    VariableDeclarator rejectDeclaration, VarDecl rejectBinding, Function rejectFunction,
    CallExpr edgeGuard, ArrayExpr callers, StringLiteral caller, Function handler, int useIndex,
    CallExpr protectedWork, string proxyRoutePath
  |
    registration.getFile().getRelativePath() = "mcp-host/src/server.ts" and
    registration.getMethodName() = "get" and
    route = registration.getArgument(0).(StringLiteral) and
    route.getStringValue() in [
        "/v1/runtime/artifacts",
        "/v1/runtime/artifacts/:filename/download"
      ] and
    (
      route.getStringValue() = "/v1/runtime/artifacts" and
      proxyRoutePath = "/rpc/hosts/:hostRef/artifacts"
      or
      route.getStringValue() = "/v1/runtime/artifacts/:filename/download" and
      proxyRoutePath = "/rpc/hosts/:hostRef/artifacts/:filename/download"
    ) and
    workflowReject = registration.getArgument(1).(VarAccess) and
    rejectBinding = rejectDeclaration.getBindingPattern().(VarDecl) and
    rejectBinding.getVariable() = workflowReject.getVariable() and
    rejectFunction = rejectDeclaration.getInit().(Function) and
    rejectFunction.getName() = "rejectWorkflowRuntimeArtifacts" and
    rejectFunction.getFile().getRelativePath() = "mcp-host/src/server.ts" and
    edgeGuard = registration.getArgument(2) and
    isImportedCall(edgeGuard, "mcp-host/src/server/edgeRuntimeAuth.ts", "runtimeEdgeGuard") and
    callers = edgeGuard.getArgument(0).(ArrayExpr) and
    caller = callers.getAnElement().(StringLiteral) and
    caller.getStringValue() = "rpc-proxy" and
    not exists(Expr otherCaller |
      callers.getAnElement() = otherCaller and
      not exists(StringLiteral rpcProxyOnly |
        rpcProxyOnly = otherCaller and rpcProxyOnly.getStringValue() = "rpc-proxy"
      )
    ) and
    hasCanonicalMcpHostRpcProxyEdgeAuthentication() and
    handler = registration.getArgument(3).(Function) and
    protectedWork.getEnclosingFunction() = handler and
    (
      route.getStringValue() = "/v1/runtime/artifacts" and
      protectedWork.getCalleeName() in ["readdirSync", "getOutputDir"]
      or
      route.getStringValue() = "/v1/runtime/artifacts/:filename/download" and
      protectedWork.getCalleeName() in ["openExistingArtifactFile", "readOpenedArtifactBuffer"]
    ) and
    useIndex in [2, 3] and
    exists(Routing::Node proxyArtifactRoute |
      hasCanonicalSpec48RpcProxyArtifactRoute(proxyArtifactRoute, proxyRoutePath)
    ) and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
  )
}

private predicate hasCanonicalActionAuthorityCheckpoint(Routing::Node useSite) {
  exists(MethodCallExpr registration, int useIndex |
    registration.getFile().getRelativePath() =
      "control-api/src/routes/internal/actionAuthorityCheckpoint.ts" and
    registration.getMethodName() = "post" and
    registration.getArgument(0).(StringLiteral).getStringValue() =
      "/internal/action-authority/checkpoint" and
    hasCanonicalSpec65Checkpoint() and
    hasCanonicalSpec62MessageCheckpoint() and
    useIndex in [1, 2] and
    registeredRouteContainsNodeAtIndex(registration, useSite, useIndex)
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
    hasCanonicalLegacySessionRoute(useSite) or
    hasCanonicalSpec65RpcProxyRoute(useSite) or
    hasCanonicalSpec65McpHostRoute(useSite) or
    hasCanonicalSpec65InlineHostCancelRoute(useSite) or
    hasCanonicalActionAuthorityCheckpoint(useSite) or
    hasCanonicalSpec62RpcProxyMessageRoute(useSite) or
    hasCanonicalSpec48McpHostArtifactRoute(useSite)
  )
select useSite, "This route handler " + explanation + ", but is not rate-limited.", reference,
  referenceLabel
