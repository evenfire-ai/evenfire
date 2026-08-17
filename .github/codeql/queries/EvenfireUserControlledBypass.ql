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

from
  ConditionalBypassFlow::PathNode source, ConditionalBypassFlow::PathNode sink,
  SensitiveAction action
where
  isTaintedGuardNodeForSensitiveAction(sink, source, action) and
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
