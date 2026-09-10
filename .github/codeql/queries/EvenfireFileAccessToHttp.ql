/**
 * @name File data in outbound network request
 * @description Directly sending file data in an outbound network request can indicate unauthorized information disclosure.
 * @kind path-problem
 * @problem.severity warning
 * @security-severity 6.5
 * @precision medium
 * @id js/file-access-to-http
 * @tags security
 *       external/cwe/cwe-200
 */

import javascript
import semmle.javascript.security.dataflow.FileAccessToHttpQuery
private import semmle.javascript.filters.ClassifyFiles as ClassifyFiles
import FileAccessToHttpFlow::PathGraph

private predicate importedCall(CallExpr call, string path, string name) {
  exists(ImportSpecifier spec, VarAccess callee |
    spec.getImportedName() = name and
    spec.getImportDeclaration().getImportedFile().getRelativePath() = path and
    call.getCallee() = callee and
    callee.getName() = spec.getLocal().getName()
  )
}

private predicate hasCanonicalRuntimeAuthFactory() {
  exists(
    Function factory, CallExpr fromValues, ObjectExpr values, Property baseUrl,
    PropAccess configuredGateway, ImportSpecifier configImport, VarAccess configUse,
    ReturnStmt canonicalReturn
  |
    factory.getName() = "createMcpHostRuntimeAuth" and
    factory.getFile().getRelativePath() = "mcp-host/src/workflow/runtimeAuthFactory.ts" and
    fromValues.getCalleeName() = "createMcpHostRuntimeAuthFromValues" and
    fromValues.getEnclosingFunction() = factory and
    canonicalReturn.nestedIn(factory.getBody()) and
    canonicalReturn.getExpr() = fromValues and
    values = fromValues.getArgument(0) and
    baseUrl = values.getPropertyByName("baseUrl") and
    baseUrl.getInit() = configuredGateway and
    configuredGateway.getPropertyName() = "mcpHostGatewayUrl" and
    configuredGateway.getBase() = configUse and
    configImport.getImportedName() = "config" and
    configUse.getName() = configImport.getLocal().getName() and
    configImport.getImportDeclaration().getImportedFile().getRelativePath() =
      "mcp-host/src/config.ts" and
    not exists(ReturnStmt otherReturn |
      otherReturn.nestedIn(factory.getBody()) and
      exists(otherReturn.getExpr()) and
      not otherReturn.getExpr() instanceof NullLiteral and
      otherReturn != canonicalReturn
    )
  )
}

private predicate isCanonicalRuntimeAuthFactoryCall(CallExpr factoryCall) {
  importedCall(factoryCall, "mcp-host/src/workflow/runtimeAuthFactory.ts",
    "createMcpHostRuntimeAuth") and
  hasCanonicalRuntimeAuthFactory()
}

private predicate writesBaseUrlThroughRuntimeAuth(AssignExpr write, Variable runtimeAuth) {
  exists(PropAccess property, VarAccess runtimeAuthUse |
    write.getLhs() = property and
    property.getPropertyName() = "baseUrl" and
    runtimeAuthUse.getVariable() = runtimeAuth and
    DataFlow::valueNode(runtimeAuthUse)
        .(DataFlow::SourceNode)
        .flowsTo(DataFlow::valueNode(property.getBase()))
  )
}

private predicate hasOnlyCanonicalRuntimeAuthWrites(Variable runtimeAuth) {
  exists(AssignExpr assignment, CallExpr factoryCall |
    assignment.getLhs().(VarAccess).getVariable() = runtimeAuth and
    assignment.getRhs() = factoryCall and
    isCanonicalRuntimeAuthFactoryCall(factoryCall)
  ) and
  not exists(AssignExpr other |
    other.getLhs().(VarAccess).getVariable() = runtimeAuth and
    not exists(CallExpr factoryCall |
      other.getRhs() = factoryCall and
      isCanonicalRuntimeAuthFactoryCall(factoryCall)
    )
  ) and
  not exists(VariableDeclarator declaration, VarDecl binding |
    declaration.getBindingPattern() = binding and
    binding.getVariable() = runtimeAuth and
    exists(declaration.getInit()) and
    not declaration.getInit() instanceof NullLiteral and
    not exists(CallExpr factoryCall |
      declaration.getInit() = factoryCall and
      isCanonicalRuntimeAuthFactoryCall(factoryCall)
    )
  ) and
  not exists(AssignExpr propertyWrite | writesBaseUrlThroughRuntimeAuth(propertyWrite, runtimeAuth))
}

private predicate functionOccursWithin(Function inner, Function outer) {
  inner.getFile() = outer.getFile() and
  outer.getLocation().getStartLine() <= inner.getLocation().getStartLine() and
  inner.getLocation().getEndLine() <= outer.getLocation().getEndLine()
}

private predicate isReadinessReporterCall(CallExpr reporterCall) {
  importedCall(reporterCall, "mcp-host/src/runtime/pr2ReadinessReporter.ts",
    "startPr2ReadinessReporter") and
  not ClassifyFiles::isTestFile(reporterCall.getFile())
}

private predicate isCanonicalReadinessReporterCall(CallExpr reporterCall) {
  exists(
    VarAccess runtimeAuthUse, Variable runtimeAuth, AssignExpr assignment, CallExpr factoryCall
  |
    isReadinessReporterCall(reporterCall) and
    reporterCall.getArgument(0) = runtimeAuthUse and
    runtimeAuth = runtimeAuthUse.getVariable() and
    hasOnlyCanonicalRuntimeAuthWrites(runtimeAuth) and
    assignment.getLhs().(VarAccess).getVariable() = runtimeAuth and
    assignment.getRhs() = factoryCall and
    isCanonicalRuntimeAuthFactoryCall(factoryCall) and
    assignment.getLocation().getEndLine() < reporterCall.getLocation().getStartLine()
  )
}

private predicate allReadinessReporterCallsAreCanonical() {
  exists(CallExpr reporterCall | isCanonicalReadinessReporterCall(reporterCall)) and
  not exists(CallExpr untrustedCall |
    isReadinessReporterCall(untrustedCall) and
    not isCanonicalReadinessReporterCall(untrustedCall)
  )
}

private predicate hasTrustedRuntimeAuthCallChain(
  ClientRequest request, MethodCallExpr normalizedBase
) {
  exists(
    Function reporter, Function requestFunction, Parameter authParameter, PropAccess authBase,
    VarAccess authUse
  |
    requestFunction = request.getEnclosingFunction() and
    reporter.getName() = "startPr2ReadinessReporter" and
    reporter.getFile().getRelativePath() = "mcp-host/src/runtime/pr2ReadinessReporter.ts" and
    functionOccursWithin(requestFunction, reporter) and
    authParameter = reporter.getAParameter() and
    authParameter.getVariable().getName() = "auth" and
    normalizedBase.getReceiver() = authBase and
    authBase.getPropertyName() = "baseUrl" and
    authBase.getBase() = authUse and
    authUse.getVariable() = authParameter.getVariable() and
    allReadinessReporterCallsAreCanonical()
  )
}

module ReadinessCredentialFlowConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) { source instanceof Source }

  predicate isSink(DataFlow::Node sink) {
    exists(ClientRequest request, ObjectExpr headers, Property authorization |
      headers = request.getADataNode().asExpr() and
      authorization = headers.getPropertyByName("authorization") and
      sink = DataFlow::valueNode(authorization.getInit()) and
      hasFixedReadinessDestination(request)
    )
  }
}

module ReadinessCredentialFlow = TaintTracking::Global<ReadinessCredentialFlowConfig>;

private predicate hasFixedReadinessDestination(ClientRequest request) {
  exists(TemplateLiteral url, TemplateElement suffix, MethodCallExpr normalizedBase |
    request.getUrl().asExpr() = url and
    url.getNumElement() = 2 and
    suffix = url.getElement(1) and
    suffix.getValue() = "/api/v1/internal/pr2-readiness/runtime-evidence" and
    normalizedBase = url.getElement(0) and
    normalizedBase.getMethodName() = "replace" and
    normalizedBase.getArgument(0) instanceof RegExpLiteral and
    normalizedBase.getArgument(1).getStringValue() = "" and
    hasTrustedRuntimeAuthCallChain(request, normalizedBase)
  )
}

private predicate fileSourceReachesOnlyAuthorization(
  DataFlow::Node source, ClientRequest request, ObjectExpr headers, Property authorization
) {
  ReadinessCredentialFlow::flow(source, DataFlow::valueNode(authorization.getInit())) and
  not source.(DataFlow::SourceNode).flowsTo(request.getUrl()) and
  not exists(Property otherHeader |
    otherHeader = headers.getAProperty() and
    otherHeader != authorization and
    source.(DataFlow::SourceNode).flowsTo(DataFlow::valueNode(otherHeader.getInit()))
  )
}

private predicate isCredentialOnlyTrustedReadinessFlow(
  FileAccessToHttpFlow::PathNode source, FileAccessToHttpFlow::PathNode sink
) {
  exists(ClientRequest request, ObjectExpr headers, Property authorization |
    sink.getNode() = request.getADataNode() and
    headers = sink.getNode().asExpr() and
    authorization = headers.getPropertyByName("authorization") and
    fileSourceReachesOnlyAuthorization(source.getNode(), request, headers, authorization) and
    hasFixedReadinessDestination(request)
  )
}

from FileAccessToHttpFlow::PathNode source, FileAccessToHttpFlow::PathNode sink
where
  FileAccessToHttpFlow::flowPath(source, sink) and
  not isCredentialOnlyTrustedReadinessFlow(source, sink)
select sink.getNode(), source, sink, "Outbound network request depends on $@.", source.getNode(),
  "file data"
