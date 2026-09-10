/**
 * @name User-controlled bypass of security check
 * @description Conditions that the user controls are not suited for making security-related decisions.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 7.8
 * @precision medium
 * @id js/user-controlled-bypass
 * @tags security
 *       external/cwe/cwe-807
 *       external/cwe/cwe-290
 */

import javascript
import semmle.javascript.security.dataflow.ConditionalBypassQuery
import ConditionalBypassFlow::PathGraph

private predicate isLiteral4xx(Expr status) {
  exists(int value | value = status.getIntValue() and value >= 400 and value <= 499)
}

private predicate isLiteral2xx(Expr status) {
  exists(int value | value = status.getIntValue() and value >= 200 and value <= 299)
}

private predicate isDirectFixed4xxResponse(ReturnStmt ret) {
  exists(MethodCallExpr statusCall, MethodCallExpr jsonCall |
    statusCall.getMethodName() = "status" and
    isLiteral4xx(statusCall.getArgument(0)) and
    jsonCall.getMethodName() = "json" and
    statusCall.getParentExpr*() = jsonCall and
    jsonCall.getParentExpr*() = ret.getExpr() and
    // The branch cannot call a producer of protected data before responding.
    not exists(CallExpr nested |
      nested.getParentExpr*() = ret.getExpr() and
      nested != statusCall and
      nested != jsonCall
    )
  )
}

private predicate isDirectFixed4xxResponseCall(CallExpr call) {
  exists(MethodCallExpr statusCall, MethodCallExpr jsonCall |
    statusCall.getMethodName() = "status" and
    isLiteral4xx(statusCall.getArgument(0)) and
    jsonCall.getMethodName() = "json" and
    statusCall.getParentExpr*() = jsonCall and
    jsonCall.getParentExpr*() = call and
    not exists(CallExpr nested |
      nested.getParentExpr*() = call and
      nested != statusCall and
      nested != jsonCall
    )
  )
}

private predicate isCanonicalPublicErrorImport(ImportSpecifier spec) {
  spec.getImportedName() = "sendPublicApiError" and
  spec.getImportDeclaration().getImportedFile().getRelativePath() =
    "control-api/src/http/publicApiError.ts"
}

private predicate isFixedPublicErrorCall(CallExpr call) {
  exists(ImportSpecifier spec |
    isCanonicalPublicErrorImport(spec) and
    DataFlow::valueNode(spec).(DataFlow::SourceNode).flowsTo(DataFlow::valueNode(call.getCallee()))
  ) and
  isLiteral4xx(call.getArgument(2)) and
  call.getArgument(3) instanceof StringLiteral and
  call.getArgument(4) instanceof StringLiteral and
  not exists(call.getArgument(5))
}

private predicate isFixedFailureBranch(Stmt branch) {
  exists(ReturnStmt ret | branch = ret and isDirectFixed4xxResponse(ret))
  or
  exists(BlockStmt block, ReturnStmt ret |
    branch = block and
    block.getNumStmt() = 1 and
    ret = block.getStmt(0) and
    isDirectFixed4xxResponse(ret)
  )
  or
  exists(BlockStmt block, ExprStmt response, ReturnStmt ret |
    branch = block and
    block.getNumStmt() = 2 and
    response = block.getStmt(0) and
    isDirectFixed4xxResponseCall(response.getExpr().(CallExpr)) and
    ret = block.getStmt(1) and
    not exists(ret.getExpr())
  )
  or
  exists(BlockStmt block, ExprStmt response, ReturnStmt ret |
    branch = block and
    block.getNumStmt() = 2 and
    response = block.getStmt(0) and
    isFixedPublicErrorCall(response.getExpr().(CallExpr)) and
    ret = block.getStmt(1) and
    not exists(ret.getExpr())
  )
}

private predicate isDirect2xxResponse(ReturnStmt ret) {
  exists(MethodCallExpr statusCall |
    statusCall.getMethodName() = "status" and
    isLiteral2xx(statusCall.getArgument(0)) and
    statusCall.getParentExpr*() = ret.getExpr()
  )
}

/** Stock early-abort modeling must not hide a branch that proves 2xx success. */
private predicate isEvenfireSuccessEarlyAbortGuardNode(
  ConditionalBypassFlow::PathNode e, SensitiveAction action
) {
  exists(IfStmt guard, ReturnStmt ret |
    e.getNode().(Sink).asExpr().getParentExpr*() = guard.getCondition() and
    not exists(guard.getElse()) and
    not action.asExpr().getEnclosingStmt().nestedIn(guard) and
    (
      guard.getThen() = ret
      or
      exists(BlockStmt block | guard.getThen() = block and ret = block.getStmt(_))
    ) and
    isDirect2xxResponse(ret)
  )
}

private predicate isAuthenticationStateMutation(CallExpr call) {
  exists(string name |
    name = call.getCalleeName() and
    name.regexpMatch("(?i).*(set|mark|establish).*(auth|authorized|session|principal).*")
  )
}

/** A branch that mutates authentication state is never a fail-closed guard. */
private predicate isEvenfireStateMutationEarlyAbortGuardNode(
  ConditionalBypassFlow::PathNode e, SensitiveAction action
) {
  exists(IfStmt guard, BlockStmt block, ExprStmt mutation, ReturnStmt ret |
    e.getNode().(Sink).asExpr().getParentExpr*() = guard.getCondition() and
    not exists(guard.getElse()) and
    not action.asExpr().getEnclosingStmt().nestedIn(guard) and
    guard.getThen() = block and
    mutation = block.getStmt(_) and
    isAuthenticationStateMutation(mutation.getExpr().(CallExpr)) and
    ret = block.getStmt(_) and
    isDirectFixed4xxResponse(ret)
  )
}

/** A response that calls another function may expose protected data. */
private predicate isEvenfirePayloadEarlyAbortGuardNode(
  ConditionalBypassFlow::PathNode e, SensitiveAction action
) {
  exists(IfStmt guard, ReturnStmt ret, MethodCallExpr statusCall, MethodCallExpr jsonCall |
    e.getNode().(Sink).asExpr().getParentExpr*() = guard.getCondition() and
    not exists(guard.getElse()) and
    not action.asExpr().getEnclosingStmt().nestedIn(guard) and
    guard.getThen() = ret and
    statusCall.getMethodName() = "status" and
    isLiteral4xx(statusCall.getArgument(0)) and
    jsonCall.getMethodName() = "json" and
    statusCall.getParentExpr*() = jsonCall and
    jsonCall.getParentExpr*() = ret.getExpr() and
    exists(CallExpr nested |
      nested.getParentExpr*() = ret.getExpr() and
      nested != statusCall and
      nested != jsonCall
    )
  )
  or
  exists(
    IfStmt guard, BlockStmt block, ExprStmt response, ReturnStmt ret, MethodCallExpr statusCall,
    MethodCallExpr jsonCall
  |
    e.getNode().(Sink).asExpr().getParentExpr*() = guard.getCondition() and
    not exists(guard.getElse()) and
    not action.asExpr().getEnclosingStmt().nestedIn(guard) and
    guard.getThen() = block and
    response = block.getStmt(0) and
    ret = block.getStmt(1) and
    not exists(ret.getExpr()) and
    statusCall.getMethodName() = "status" and
    isLiteral4xx(statusCall.getArgument(0)) and
    jsonCall.getMethodName() = "json" and
    statusCall.getParentExpr*() = jsonCall and
    jsonCall.getParentExpr*() = response.getExpr() and
    exists(CallExpr nested |
      nested.getParentExpr*() = response.getExpr() and
      nested != statusCall and
      nested != jsonCall
    )
  )
  or
  exists(IfStmt guard, BlockStmt block, ExprStmt response, ReturnStmt ret, CallExpr helper |
    e.getNode().(Sink).asExpr().getParentExpr*() = guard.getCondition() and
    not exists(guard.getElse()) and
    not action.asExpr().getEnclosingStmt().nestedIn(guard) and
    guard.getThen() = block and
    response = block.getStmt(0) and
    helper = response.getExpr().(CallExpr) and
    exists(ImportSpecifier spec |
      isCanonicalPublicErrorImport(spec) and
      DataFlow::valueNode(spec)
          .(DataFlow::SourceNode)
          .flowsTo(DataFlow::valueNode(helper.getCallee()))
    ) and
    isLiteral4xx(helper.getArgument(2)) and
    exists(helper.getArgument(5)) and
    ret = block.getStmt(1) and
    not exists(ret.getExpr())
  )
}

/**
 * Extends the stock early-abort treatment only for a structurally proven fixed
 * 4xx response. The sensitive action remains outside the terminating branch.
 */
private predicate isEvenfireFailClosedGuardNode(
  ConditionalBypassFlow::PathNode e, SensitiveAction action
) {
  exists(IfStmt guard |
    e.getNode().(Sink).asExpr().getParentExpr*() = guard.getCondition() and
    not exists(guard.getElse()) and
    isFixedFailureBranch(guard.getThen()) and
    not action.asExpr().getEnclosingStmt().nestedIn(guard)
  )
}

private predicate isImportedValue(Expr value, string path, string importedName) {
  exists(ImportSpecifier spec |
    spec.getImportedName() = importedName and
    spec.getImportDeclaration().getImportedFile().getRelativePath() = path and
    DataFlow::valueNode(spec).(DataFlow::SourceNode).flowsTo(DataFlow::valueNode(value))
  )
}

private predicate isImportedCall(CallExpr call, string path, string importedName) {
  isImportedValue(call.getCallee(), path, importedName)
}

private predicate isDirectNamedImportCall(CallExpr call, string path, string importedName) {
  exists(ImportSpecifier spec, VarAccess callee |
    spec.getImportedName() = importedName and
    spec.getImportDeclaration().getImportedFile().getRelativePath() = path and
    callee = call.getCallee() and
    callee.getName() = spec.getLocal().getName()
  )
}

private predicate isFixedJsonHelperFailureBranch(Stmt branch) {
  exists(BlockStmt block, ExprStmt response, CallExpr helper, ReturnStmt ret |
    branch = block and
    block.getNumStmt() = 2 and
    response = block.getStmt(0) and
    helper = response.getExpr() and
    isImportedCall(helper, "mcp-host/src/server/httpUtils.ts", "json") and
    isLiteral4xx(helper.getArgument(1)) and
    ret = block.getStmt(1) and
    not exists(ret.getExpr())
  )
}

private predicate declaredByCall(VarAccess access, CallExpr call) {
  exists(VariableDeclarator declaration, VarDecl binding |
    declaration.getInit() = call and
    declaration.getBindingPattern() = binding and
    binding.getVariable() = access.getVariable()
  )
}

private predicate propertyOfVariable(PropAccess access, Variable variable, string property) {
  access.getPropertyName() = property and
  access.getBase().(VarAccess).getVariable() = variable
}

private predicate nestedPropertyOfVariable(
  PropAccess access, Variable variable, string intermediate, string property
) {
  exists(PropAccess qualifier |
    access.getPropertyName() = property and
    access.getBase() = qualifier and
    propertyOfVariable(qualifier, variable, intermediate)
  )
}

private predicate exactStrictPropertyMismatch(
  StrictNEqExpr mismatch, Variable trusted, string trustedProperty, Variable presented,
  string presentedProperty
) {
  exists(PropAccess trustedAccess, PropAccess presentedAccess |
    (
      mismatch.getLeftOperand() = trustedAccess and
      mismatch.getRightOperand() = presentedAccess
      or
      mismatch.getRightOperand() = trustedAccess and
      mismatch.getLeftOperand() = presentedAccess
    ) and
    propertyOfVariable(trustedAccess, trusted, trustedProperty) and
    propertyOfVariable(presentedAccess, presented, presentedProperty)
  )
}

private predicate isExactMcpMismatchDisjunction(
  Expr condition, StrictNEqExpr operationMismatch, Variable target, Variable message
) {
  exists(
    LogOrExpr allMismatches, LogOrExpr throughChannelType, LogOrExpr throughMessage,
    LogOrExpr operationOrMissingTarget, LogNotExpr missingTarget, VarAccess missingTargetUse,
    StrictNEqExpr messageMismatch, StrictNEqExpr channelTypeMismatch,
    StrictNEqExpr channelIdMismatch
  |
    condition = allMismatches and
    allMismatches.getLeftOperand() = throughChannelType and
    allMismatches.getRightOperand() = channelIdMismatch and
    throughChannelType.getLeftOperand() = throughMessage and
    throughChannelType.getRightOperand() = channelTypeMismatch and
    throughMessage.getLeftOperand() = operationOrMissingTarget and
    throughMessage.getRightOperand() = messageMismatch and
    operationOrMissingTarget.getLeftOperand() = operationMismatch and
    operationOrMissingTarget.getRightOperand() = missingTarget and
    missingTarget.getOperand() = missingTargetUse and
    missingTargetUse.getVariable() = target and
    exactStrictPropertyMismatch(messageMismatch, target, "messageId", message, "messageId") and
    exactStrictPropertyMismatch(channelTypeMismatch, target, "channelType", message, "channelType") and
    exactStrictPropertyMismatch(channelIdMismatch, target, "channelId", message, "channelId")
  )
}

private predicate isTrustedMcpRuntimeEdgeAction(SensitiveAction action) {
  exists(
    CallExpr authorityBinding, CallExpr callerContext, Function handler, Variable caller,
    Variable message, Variable target, VarAccess callerDeclaration,
    VariableDeclarator targetDeclaration, VarDecl targetBinding, PropAccess targetInitializer,
    AssignExpr trustedSender, PropAccess sender, PropAccess callerUser, IfStmt rpcBranch,
    IfStmt callerBranch, StrictEqExpr rpcChannel, StrictEqExpr callerIdentity,
    PropAccess channelType, PropAccess callerName, PropAccess callerPresence, IfStmt mismatch,
    StrictNEqExpr operationMismatch, PropAccess operation, PropAccess actionContext,
    LogAndExpr exactCallerCondition
  |
    authorityBinding = action.asExpr() and
    isImportedCall(authorityBinding, "mcp-host/src/runtime/actionAuthority.ts",
      "authorityBindingFromTrustedEdge") and
    handler = authorityBinding.getEnclosingFunction() and
    callerContext.getEnclosingFunction() = handler and
    isImportedCall(callerContext, "mcp-host/src/server/edgeRuntimeAuth.ts",
      "getRuntimeCallerContext") and
    declaredByCall(callerDeclaration, callerContext) and
    caller = callerDeclaration.getVariable() and
    rpcChannel.getParentExpr*() = rpcBranch.getCondition() and
    channelType = rpcChannel.getAnOperand() and
    propertyOfVariable(channelType, message, "channelType") and
    rpcChannel.getAnOperand().getStringValue() = "rpc" and
    authorityBinding.getEnclosingStmt().nestedIn(rpcBranch.getThen()) and
    callerBranch.getCondition() = exactCallerCondition and
    exactCallerCondition.getLeftOperand() = callerIdentity and
    exactCallerCondition.getRightOperand() = callerPresence and
    callerName = callerIdentity.getAnOperand() and
    propertyOfVariable(callerName, caller, "caller") and
    callerIdentity.getAnOperand().getStringValue() = "rpc-proxy" and
    propertyOfVariable(callerPresence, caller, "userId") and
    authorityBinding.getEnclosingStmt().nestedIn(callerBranch.getThen()) and
    trustedSender.getEnclosingFunction() = handler and
    trustedSender.getLhs() = sender and
    propertyOfVariable(sender, message, "sender") and
    trustedSender.getRhs() = callerUser and
    propertyOfVariable(callerUser, caller, "userId") and
    trustedSender.getLocation().getEndLine() <= mismatch.getLocation().getStartLine() and
    targetDeclaration.getBindingPattern() = targetBinding and
    target = targetBinding.getVariable() and
    targetDeclaration.getInit() = targetInitializer and
    nestedPropertyOfVariable(targetInitializer, caller, "actionContextV2", "target") and
    operation = operationMismatch.getAnOperand() and
    nestedPropertyOfVariable(operation, caller, "actionContextV2", "operationId") and
    operationMismatch.getAnOperand().getStringValue() = "chat.message.invoke" and
    isExactMcpMismatchDisjunction(mismatch.getCondition(), operationMismatch, target, message) and
    isFixedJsonHelperFailureBranch(mismatch.getThen()) and
    mismatch.getLocation().getEndLine() < authorityBinding.getLocation().getStartLine() and
    actionContext = authorityBinding.getArgument(0) and
    propertyOfVariable(actionContext, caller, "actionContextV2")
  )
}

private predicate exactV2ViewAuthority(Function authority) {
  exists(
    CallExpr declaresV2, CallExpr extractToken, CallExpr rpcAuth, CallExpr scopedDispatch,
    CallExpr scopeFactory, Function success, IfStmt legacyDispatch, ExprStmt nextStatement,
    ReturnStmt returnStatement, VarAccess rpcReq, VarAccess rpcRes, VarAccess scopedReq,
    VarAccess scopedRes, VarAccess scopedNext, Parameter authorityReq, Parameter authorityRes,
    Parameter authorityNext
  |
    isDirectNamedImportCall(declaresV2, "rpc-proxy/src/userDelegationV2.ts", "tokenDeclaresV2") and
    declaresV2.getEnclosingFunction() = authority and
    isDirectNamedImportCall(extractToken, "rpc-proxy/src/middleware/auth.ts", "extractAuthToken") and
    extractToken = declaresV2.getArgument(0) and
    legacyDispatch.getCondition() = any(LogNotExpr negated | negated.getOperand() = declaresV2) and
    nextStatement.nestedIn(legacyDispatch.getThen()) and
    nextStatement.getExpr().(CallExpr).getCalleeName() = "next" and
    returnStatement.nestedIn(legacyDispatch.getThen()) and
    not exists(returnStatement.getExpr()) and
    isDirectNamedImportCall(rpcAuth, "rpc-proxy/src/middleware/auth.ts", "requireRpcAuth") and
    rpcAuth.getEnclosingFunction() = authority and
    authorityReq = authority.getParameter(0) and
    authorityRes = authority.getParameter(1) and
    authorityNext = authority.getParameter(2) and
    rpcReq = rpcAuth.getArgument(0) and
    rpcRes = rpcAuth.getArgument(1) and
    rpcReq.getVariable() = authorityReq.getVariable() and
    rpcRes.getVariable() = authorityRes.getVariable() and
    rpcAuth.getArgument(2) = success and
    success.getFile() = authority.getFile() and
    authority.getLocation().getStartLine() <= success.getLocation().getStartLine() and
    success.getLocation().getEndLine() <= authority.getLocation().getEndLine() and
    scopedDispatch.getEnclosingFunction() = success and
    scopedDispatch.getCallee() = scopeFactory and
    isDirectNamedImportCall(scopeFactory, "rpc-proxy/src/middleware/auth.ts", "requireScope") and
    scopeFactory.getArgument(0).getStringValue() = "sandbox:ui:view" and
    scopedReq = scopedDispatch.getArgument(0) and
    scopedRes = scopedDispatch.getArgument(1) and
    scopedNext = scopedDispatch.getArgument(2) and
    scopedReq.getVariable() = authorityReq.getVariable() and
    scopedRes.getVariable() = authorityRes.getVariable() and
    scopedNext.getVariable() = authorityNext.getVariable() and
    legacyDispatch.getLocation().getEndLine() < rpcAuth.getLocation().getStartLine() and
    not exists(CallExpr earlyDispatch |
      earlyDispatch.getEnclosingFunction() = authority and
      earlyDispatch.getCalleeName() = "next" and
      earlyDispatch.getLocation().getStartLine() < rpcAuth.getLocation().getStartLine() and
      not earlyDispatch.getEnclosingStmt().nestedIn(legacyDispatch.getThen())
    ) and
    not exists(CallExpr bypassDispatch |
      bypassDispatch.getEnclosingFunction() = authority and
      bypassDispatch.getCalleeName() = "next" and
      not bypassDispatch.getEnclosingStmt().nestedIn(legacyDispatch.getThen()) and
      not bypassDispatch.getEnclosingStmt().nestedIn(success.getBody())
    )
  )
}

private predicate isNegatedVariable(Expr expression, Variable variable) {
  exists(LogNotExpr negation, VarAccess access |
    expression = negation and
    negation.getOperand() = access and
    access.getVariable() = variable
  )
}

private predicate isExactV2NoLegacyChooser(
  ConditionalExpr chooser, Variable v2Request, Variable legacyCookie
) {
  exists(LogOrExpr condition, VarAccess v2Access |
    chooser.getCondition() = condition and
    condition.getLeftOperand() = v2Access and
    v2Access.getVariable() = v2Request and
    isNegatedVariable(condition.getRightOperand(), legacyCookie)
  )
}

private predicate hasExactLegacyFailure(Function handler, Variable v2Request, Variable legacyClaims) {
  exists(IfStmt failure, LogAndExpr condition |
    failure.getCondition() = condition and
    isNegatedVariable(condition.getLeftOperand(), v2Request) and
    isNegatedVariable(condition.getRightOperand(), legacyClaims) and
    isFixedFailureBranch(failure.getThen()) and
    failure.getCondition().getEnclosingFunction() = handler
  )
}

private predicate isExactV2RequestDerivation(Function handler, Variable v2Request) {
  exists(
    VariableDeclarator declaration, VarDecl binding, CallExpr classifierCall, Function classifier,
    ReturnStmt classifierReturn, CallExpr booleanCall, LogAndExpr exactAuthorityState,
    PropAccess delegation, PropAccess authorizedAction, VarAccess delegationBase,
    VarAccess actionBase, Parameter classifierParameter
  |
    declaration.getBindingPattern() = binding and
    binding.getVariable() = v2Request and
    declaration.getInit() = classifierCall and
    classifier.getName() = "isV2ViewRequest" and
    classifier.getFile() = handler.getFile() and
    classifierCall.getCallee().(VarAccess).getVariable() = classifier.getVariable() and
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
    DataFlow::valueNode(handler.getParameter(0))
        .(DataFlow::SourceNode)
        .flowsTo(DataFlow::valueNode(classifierCall.getArgument(0))) and
    not exists(ReturnStmt otherReturn |
      otherReturn.nestedIn(classifier.getBody()) and otherReturn != classifierReturn
    )
  )
}

private predicate isTrustedSandboxV2Action(SensitiveAction action) {
  exists(
    CallExpr legacyAction, MethodCallExpr route, Function handler, VarAccess authorityMiddleware,
    ConditionalExpr chooser, Function authority, int authorityIndex, int handlerIndex,
    Variable v2Request, Variable legacyCookie, Variable legacyClaims, VarAccess legacyArgument,
    VariableDeclarator chooserDeclaration, VarDecl legacyBinding, VarAccess chooserV2,
    VarAccess chooserCookie
  |
    legacyAction = action.asExpr() and
    isDirectNamedImportCall(legacyAction, "rpc-proxy/src/services/sandboxUiSession.ts",
      "verifySandboxUiSession") and
    handler = legacyAction.getEnclosingFunction() and
    route.getMethodName() = "all" and
    handler = route.getArgument(handlerIndex) and
    authorityMiddleware = route.getArgument(authorityIndex) and
    authorityIndex < handlerIndex and
    authorityMiddleware.getVariable() = authority.getVariable() and
    exactV2ViewAuthority(authority) and
    chooserDeclaration.getInit() = chooser and
    chooserDeclaration.getBindingPattern() = legacyBinding and
    legacyClaims = legacyBinding.getVariable() and
    isExactV2RequestDerivation(handler, v2Request) and
    isExactV2NoLegacyChooser(chooser, v2Request, legacyCookie) and
    chooserV2 = chooser.getCondition().(LogOrExpr).getLeftOperand() and
    chooserV2.getVariable() = v2Request and
    chooserCookie = chooser.getCondition().(LogOrExpr).getRightOperand().(LogNotExpr).getOperand() and
    chooserCookie.getVariable() = legacyCookie and
    legacyAction.getParentExpr*() = chooser.getAlternate() and
    legacyArgument = legacyAction.getArgument(0) and
    legacyArgument.getVariable() = legacyCookie and
    hasExactLegacyFailure(handler, v2Request, legacyClaims)
  )
}

private predicate isTrustedPr2AuthorityComposition(SensitiveAction action) {
  isTrustedMcpRuntimeEdgeAction(action) or isTrustedSandboxV2Action(action)
}

from
  ConditionalBypassFlow::PathNode source, ConditionalBypassFlow::PathNode sink,
  SensitiveAction action
where
  isTaintedGuardNodeForSensitiveAction(sink, source, action) and
  not isTrustedPr2AuthorityComposition(action) and
  (
    not isEarlyAbortGuardNode(sink, action) and
    not isEvenfireFailClosedGuardNode(sink, action)
    or
    isEvenfireSuccessEarlyAbortGuardNode(sink, action)
    or
    isEvenfireStateMutationEarlyAbortGuardNode(sink, action)
    or
    isEvenfirePayloadEarlyAbortGuardNode(sink, action)
  )
select sink.getNode(), source, sink, "This condition guards a sensitive $@, but a $@ controls it.",
  action, "action", source.getNode(), "user-provided value"
