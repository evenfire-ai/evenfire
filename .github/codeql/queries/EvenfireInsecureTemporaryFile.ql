/**
 * @name Insecure temporary file
 * @description Creating a temporary file that is accessible by other users can
 * lead to information disclosure and sometimes remote code execution.
 * @kind path-problem
 * @id js/insecure-temporary-file
 * @problem.severity warning
 * @security-severity 7.0
 * @precision medium
 * @tags external/cwe/cwe-377
 *       external/cwe/cwe-378
 *       security
 */

import javascript
import semmle.javascript.security.dataflow.InsecureTemporaryFileQuery
import InsecureTemporaryFileFlow::PathGraph

/**
 * Node's read-only `open` flags do not create or modify a file. The stock
 * query treats every `open` without an explicit permission mode as a creation
 * sink, even though permission mode is irrelevant when the flags are read-only.
 */
private predicate isReadOnlyOpenPath(InsecureTemporaryFileFlow::PathNode sink) {
  exists(DataFlow::CallNode call, string flags |
    (
      call = NodeJSLib::FS::moduleMember("open").getACall()
      or
      call = NodeJSLib::FS::moduleMember("openSync").getACall()
    ) and
    sink.getNode() = call.getArgument(0) and
    flags = call.getArgument(1).getStringValue() and
    flags = ["r", "rs"]
  )
}

from InsecureTemporaryFileFlow::PathNode source, InsecureTemporaryFileFlow::PathNode sink
where InsecureTemporaryFileFlow::flowPath(source, sink) and not isReadOnlyOpenPath(sink)
select sink.getNode(), source, sink, "Insecure creation of file in $@.", source.getNode(),
  "the os temp dir"
