import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  REGISTRY_OPERATION_ID_ANNOTATION,
  REGISTRY_SPEC_DIGEST_ANNOTATION,
  registrySpecDigest,
} from '../../../control-api/src/services/registryMutation'
import type { EnvSecret, McpServerResource } from '../../lib/api'

const REGISTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../control-api/src/routes/admin/registry.ts'
)
const GATEWAY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../control-api/test/mockGateway.ts'
)

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  )
}

/** Assignment operators: plain, compound, and logical forms. */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

/** Every expression `root` writes to, including leaves nested in
 * destructuring patterns (`[a.managed] = xs`, `({ b: a.managed } = o)`).
 * Receivers and computed keys are reads, so the walk stops at member
 * targets instead of descending into them. */
function collectWriteTargets(root: ts.Node): ts.Node[] {
  const targets: ts.Node[] = []
  function scan(node: ts.Node): void {
    if (
      ts.isIdentifier(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      targets.push(node)
      return
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      // Destructuring defaults (`[target = fallback] = xs`) write only the left side.
      scan(node.left)
      return
    }
    if (ts.isObjectLiteralExpression(node)) {
      // Object destructuring: values are nested targets, keys are reads.
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) scan(property.initializer)
        else if (ts.isShorthandPropertyAssignment(property)) targets.push(property.name)
        else if (ts.isSpreadAssignment(property)) scan(property.expression)
      }
      return
    }
    // Array destructuring patterns and any other nesting scan every child.
    ts.forEachChild(node, scan)
  }
  scan(root)
  return targets
}

/** Standard globals the producer scope may use directly; everything else it
 * references resolves to a permissive stub. */
const SCOPE_GLOBAL_WHITELIST = new Set([
  'Object',
  'Array',
  'Reflect',
  'Error',
  'TypeError',
  'RangeError',
  'JSON',
  'Math',
  'Promise',
  'Symbol',
  'String',
  'Number',
  'Boolean',
  'Map',
  'Set',
  'Date',
  'RegExp',
  'URL',
  'console',
  'crypto',
  'isNaN',
  'parseInt',
  'parseFloat',
  'globalThis',
  'undefined',
])

/** Permissive stand-in for any producer binding whose real value the fixture
 * cannot evaluate (imports, request state, config). Truthy and callable so
 * guard calls take their branch — the conservative direction for write
 * detection; numeric coercion yields 1 so `length > 0`-style guards run too.
 * `then` resolves to undefined so a stray `await` over a stub cannot hang. */
function createScopeStub(): unknown {
  const stub: unknown = new Proxy(function scopeStub() {}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return (hint: string) => (hint === 'number' ? 1 : '')
      if (prop === 'then') return undefined
      if (prop === Symbol.iterator) return function* emptyIterator() {}
      if (prop === 'toString') return () => ''
      if (prop === 'valueOf') return () => 1
      return stub
    },
    apply() {
      return stub as object
    },
    construct() {
      return stub as object
    },
    has() {
      return true
    },
  })
  return stub
}

/** Executes the producer's spec-construction scope — from the
 * `mcpServerSpec` declaration through the end of its enclosing function —
 * with the spec object wrapped in a recording proxy. Identifier aliases,
 * array/object destructuring, computed and dotted syntax, reflection, and
 * same-scope helper calls all funnel through the proxy by object identity,
 * so managed-write detection no longer depends on enumerating syntaxes.
 * Handler-level returns are neutralized (their side effects kept) so every
 * statement still executes, and awaits are stripped because every awaited
 * callee resolves to a stub.
 *
 * Stubs cannot model outer data faithfully (an outer array stays a stub,
 * so `Array.isArray` guards take the false branch and stubbed collection
 * methods never invoke their callbacks), so executed coverage is recorded
 * per statement and per expression-bodied arrow: after execution, every
 * skipped statement and never-invoked arrow is statically re-scanned with
 * the write-target walker under a strict predicate — in code that never
 * ran, nothing about the bindings is provable, so ANY computed write, any
 * `.managed` member write, and any spec-targeted reflection reject the
 * producer shape. The fixture never silently returns a value when skipped
 * producer logic could have mutated `managed`. Fails closed, naming the
 * failure, when the scope throws or references a binding even a stub
 * cannot satisfy. */
function executeRegistrySpecScope(
  specDeclaration: ts.VariableDeclaration,
  source: ts.SourceFile,
  specIdentifiers: Set<string>
): void {
  const initializer = specDeclaration.initializer
  if (!initializer) return
  let handler: ts.Node | undefined = specDeclaration
  while (handler && !isFunctionLike(handler)) handler = handler.parent
  if (!handler || !isFunctionLike(handler) || !handler.body || !ts.isBlock(handler.body)) return
  const body = handler.body
  const declIndex = body.statements.findIndex(
    statement => statement.pos <= specDeclaration.pos && specDeclaration.end <= statement.end
  )
  if (declIndex < 0) return

  const start = body.statements[declIndex].getStart(source)
  const end = body.statements[body.statements.length - 1].end
  type Edit = {
    pos: number
    end: number
    insert?: string
    replace?: string
    prefix?: string
    suffix?: string
  }
  const edits: Edit[] = [
    { pos: initializer.pos, end: initializer.end, prefix: '__specProxy(', suffix: ')' },
  ]
  const markedStatements: ts.Node[] = []
  const markedArrows: ts.Node[] = []

  const declaredNames = new Set<string>()
  const referencedNames = new Set<string>()

  function collectBindingNames(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) declaredNames.add(name.text)
    else if (ts.isArrayBindingPattern(name))
      name.elements.forEach(element => {
        if (ts.isBindingElement(element)) collectBindingNames(element.name)
      })
    else if (ts.isObjectBindingPattern(name))
      name.elements.forEach(element => collectBindingNames(element.name))
  }

  function isStatementElement(node: ts.Node): boolean {
    const parent = node.parent
    if (!parent) return false
    if (ts.isBlock(parent)) return parent.statements.includes(node as ts.Statement)
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent))
      return (parent as ts.CaseClause).statements.includes(node as ts.Statement)
    return false
  }

  function isUnguardedBody(node: ts.Node): boolean {
    const parent = node.parent
    if (!parent) return false
    if (ts.isIfStatement(parent))
      return parent.thenStatement === node || parent.elseStatement === node
    if (
      ts.isForStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isLabeledStatement(parent)
    ) {
      return parent.statement === node
    }
    return false
  }

  function collect(node: ts.Node, depth: number): void {
    // Coverage markers: every statement that can be skipped records its
    // execution; expression-bodied arrows get a body they can mark, since
    // they contain no statements of their own.
    if (!ts.isBlock(node) && (isStatementElement(node) || isUnguardedBody(node))) {
      const id = markedStatements.push(node) - 1
      if (isUnguardedBody(node)) {
        edits.push({
          pos: node.getStart(source),
          end: node.end,
          prefix: `{ __stmt(${id}); `,
          suffix: ` }`,
        })
      } else {
        edits.push({
          pos: node.getStart(source),
          end: node.getStart(source),
          insert: `__stmt(${id}); `,
        })
      }
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      const id = markedArrows.push(node) - 1
      edits.push({
        pos: node.body.getStart(source),
        end: node.body.end,
        prefix: `{ __stmt(${id}); return (`,
        suffix: `) }`,
      })
    }
    if (ts.isVariableDeclaration(node)) collectBindingNames(node.name)
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      declaredNames.add(node.name.text)
    }
    if (isFunctionLike(node))
      node.parameters.forEach(parameter => collectBindingNames(parameter.name))
    if (ts.isCatchClause(node) && node.variableDeclaration)
      collectBindingNames(node.variableDeclaration.name)
    if (
      (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      node.initializer.declarations.forEach(declaration => collectBindingNames(declaration.name))
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent)) &&
          parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node)
      const isReference =
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isComputedPropertyName(parent) ||
        (!isPropertyName && !ts.isBindingElement(parent))
      if (isReference && !declaredNames.has(node.text)) referencedNames.add(node.text)
    }
    if (ts.isAwaitExpression(node)) {
      // Strip the `await` keyword, keeping the operand.
      edits.push({
        pos: node.getStart(source),
        end: node.expression.getStart(source),
        replace: '',
      })
    }
    if (ts.isReturnStatement(node) && depth === 0) {
      if (node.expression) {
        edits.push({
          pos: node.getStart(source),
          end: node.expression.getStart(source),
          replace: 'void ',
        })
      } else {
        edits.push({ pos: node.getStart(source), end: node.end, replace: ';void 0;' })
      }
    }
    const nextDepth = isFunctionLike(node) ? depth + 1 : depth
    ts.forEachChild(node, child => collect(child, nextDepth))
  }
  for (const statement of body.statements.slice(declIndex)) collect(statement, 0)

  // Descending application keeps nested edits (an arrow rewrite containing
  // a stripped await, a marker inside a rewritten span) composable; at equal
  // positions the wider span applies first so markers land before statements.
  edits.sort((a, b) => b.pos - a.pos || b.end - a.end)
  let code = source.text.slice(start, end)
  for (const edit of edits) {
    const p = edit.pos - start
    const e = edit.end - start
    if (edit.insert !== undefined) {
      code = code.slice(0, p) + edit.insert + code.slice(p)
    } else if (edit.replace !== undefined) {
      code = code.slice(0, p) + edit.replace + code.slice(e)
    } else {
      code =
        code.slice(0, p) +
        (edit.prefix ?? '') +
        code.slice(p, e) +
        (edit.suffix ?? '') +
        code.slice(e)
    }
  }

  const envNames = [...referencedNames]
    .filter(name => !SCOPE_GLOBAL_WHITELIST.has(name) && name !== 'this' && name !== 'arguments')
    .sort()
  let managedMutation: { op: string; value: unknown } | undefined
  const specProxy = (target: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(target, {
      set(t, prop, value) {
        if (prop === 'managed') managedMutation = { op: 'set', value }
        Reflect.set(t, prop, value)
        return true
      },
      defineProperty(t, prop, description) {
        if (prop === 'managed') managedMutation = { op: 'defineProperty', value: description.value }
        Object.defineProperty(t, prop, description)
        return true
      },
      deleteProperty(t, prop) {
        if (prop === 'managed') managedMutation = { op: 'delete', value: undefined }
        Reflect.deleteProperty(t, prop)
        return true
      },
    })
  const compiledScope = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const executedMarkers = new Set<number>()
  try {
    const runner = new Function(
      '__specProxy',
      '__stmt',
      ...envNames,
      `return (() => {\n${compiledScope}\n})()`
    )
    runner(
      specProxy,
      (id: number) => {
        executedMarkers.add(id)
      },
      ...envNames.map(() => createScopeStub())
    )
  } catch (err) {
    throw new Error(
      `Registry producer scope execution failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (managedMutation) {
    throw new Error(
      `Unsupported registry managed write executed via ${managedMutation.op}: managed = ${String(
        managedMutation.value
      )}`
    )
  }

  /** Nothing is provable inside code that never ran: any binding may hold
   * the spec, so every computed write and every `.managed` member write
   * rejects, and only tracked spec identifiers count for whole-binding
   * writes. */
  function skippedTargetTouchesManaged(target: ts.Node): boolean {
    if (ts.isIdentifier(target)) return specIdentifiers.has(target.getText(source))
    if (ts.isPropertyAccessExpression(target)) return target.name.getText(source) === 'managed'
    return ts.isElementAccessExpression(target)
  }

  function findSkippedManagedWrite(root: ts.Node): ts.Node | undefined {
    let found: ts.Node | undefined
    function scan(node: ts.Node): void {
      if (found) return
      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        if (collectWriteTargets(node.left).some(skippedTargetTouchesManaged)) found = node
      } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        if (collectWriteTargets(node.initializer).some(skippedTargetTouchesManaged)) found = node
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        if (collectWriteTargets(node.operand).some(skippedTargetTouchesManaged)) found = node
      } else if (ts.isDeleteExpression(node)) {
        if (collectWriteTargets(node.expression).some(skippedTargetTouchesManaged)) found = node
      } else if (
        ts.isCallExpression(node) &&
        node.arguments.length > 0 &&
        [
          'Object.assign',
          'Object.defineProperty',
          'Object.defineProperties',
          'Reflect.set',
          'Reflect.defineProperty',
        ].includes(node.expression.getText(source)) &&
        !ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        found = node
      }
      if (!found) ts.forEachChild(node, scan)
    }
    scan(root)
    return found
  }

  const skippedNodes = [
    ...markedStatements.filter((_, id) => !executedMarkers.has(id)),
    ...markedArrows.filter((_, id) => !executedMarkers.has(id)),
  ]
  for (const skippedNode of skippedNodes) {
    const write = findSkippedManagedWrite(skippedNode)
    if (write) {
      const line = source.getLineAndCharacterOfPosition(write.getStart(source)).line + 1
      throw new Error(
        `Unsupported registry managed write in skipped producer code at ${path.basename(
          REGISTRY_PATH
        )}:${line}: ${write.getText(source)}`
      )
    }
  }
}

/** Execute the registry install producer's Secret-name and envSecret expressions. */
function registrySecretFactory(registrySource?: string): {
  name: (serverName: string) => string
  envSecret: (secretName: string, keyNames: string[]) => EnvSecret
  managed: () => boolean
  metadata: (input: RegistryMetadataInput) => NonNullable<McpServerResource['metadata']>
} {
  const source = ts.createSourceFile(
    REGISTRY_PATH,
    registrySource ?? readFileSync(REGISTRY_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const assignments: ts.Expression[] = []
  const secretNames: ts.Expression[] = []
  const managedExpressions: ts.Expression[] = []
  const unsupportedManagedWrites: ts.Node[] = []
  const registryLabels: ts.Expression[] = []
  const registryAnnotations: ts.Expression[] = []
  const registryResourceMetadata: ts.Expression[] = []
  let catalogAnnotations: ts.FunctionDeclaration | undefined
  let specDeclaration: ts.VariableDeclaration | undefined

  /** Identifiers that can reference the spec object at the create call: the
   * producer binding plus every local copy through an identifier chain
   * (`const specAlias = mcpServerSpec`, `alias = specAlias`, transitively,
   * re-scanned to a fixpoint so copy order never matters). Copies through
   * object literals, property holders, or function boundaries are not
   * modeled; writes that spell `.managed` on any receiver still fail
   * closed independently of this set. */
  function collectSpecObjectIdentifiers(): Set<string> {
    const specIdentifiers = new Set(['mcpServerSpec'])
    let grew = true
    while (grew) {
      grew = false
      function discover(node: ts.Node): void {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          ts.isIdentifier(node.initializer) &&
          specIdentifiers.has(node.initializer.getText(source)) &&
          !specIdentifiers.has(node.name.getText(source))
        ) {
          specIdentifiers.add(node.name.getText(source))
          grew = true
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          ts.isIdentifier(node.right) &&
          specIdentifiers.has(node.right.getText(source)) &&
          !specIdentifiers.has(node.left.getText(source))
        ) {
          specIdentifiers.add(node.left.getText(source))
          grew = true
        }
        ts.forEachChild(node, discover)
      }
      discover(source)
    }
    return specIdentifiers
  }

  const specObjectIdentifiers = collectSpecObjectIdentifiers()

  /** Unwraps expression wrappers (`(...)`, `x!`, `x as T`) around a receiver. */
  function unwrapReceiver(node: ts.Expression): ts.Expression {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      node = node.expression
    }
    return node
  }

  function isSpecObjectIdentifier(node: ts.Expression): boolean {
    return ts.isIdentifier(node) && specObjectIdentifiers.has(node.getText(source))
  }

  /** A target whose write can change the `managed` value this fixture
   * derives: the whole `mcpServerSpec` binding (rebinding swaps every
   * field), any `*.managed` member write (any receiver — an alias like
   * `const s = mcpServerSpec` still writes the same field), or any
   * computed key on the spec or one of its tracked aliases (the key may
   * resolve to "managed" at runtime, so every one fails closed). */
  function writesRegistryManaged(target: ts.Node): boolean {
    // A whole-binding write rejects only the extracted binding itself;
    // rebinding an alias cannot mutate the spec object.
    if (ts.isIdentifier(target)) return target.getText(source) === 'mcpServerSpec'
    if (ts.isPropertyAccessExpression(target)) return target.name.getText(source) === 'managed'
    if (ts.isElementAccessExpression(target)) {
      return isSpecObjectIdentifier(unwrapReceiver(target.expression))
    }
    return false
  }

  /** Records the construct when any target it writes can change `managed`.
   * The construct node is kept so the error shows the full statement. */
  function rejectManagedWrites(construct: ts.Node, writeRoot: ts.Node): void {
    if (collectWriteTargets(writeRoot).some(writesRegistryManaged)) {
      unsupportedManagedWrites.push(construct)
    }
  }

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'secretName' &&
      node.initializer?.getText(source).includes('${serverName}')
    ) {
      secretNames.push(node.initializer)
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'catalogAnnotations') {
      catalogAnnotations = node
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const variableName = node.name.getText(source)
      if (variableName === 'mcpServerSpec' && ts.isObjectLiteralExpression(node.initializer)) {
        specDeclaration = node
        let managedDerived = false
        for (const property of node.initializer.properties) {
          if (ts.isSpreadAssignment(property)) {
            // A spread after `managed:` can override it with a value the
            // fixture cannot extract; fail closed instead of deriving stale.
            if (managedDerived) unsupportedManagedWrites.push(property)
            continue
          }
          if (property.name.getText(source) !== 'managed') continue
          // Only a literal `managed:` property assignment is derivable.
          // Shorthand, method, and accessor forms read `managed` from an
          // unextracted outer scope, so they fail closed.
          if (ts.isPropertyAssignment(property)) {
            managedExpressions.push(property.initializer)
            managedDerived = true
          } else {
            unsupportedManagedWrites.push(property)
          }
        }
      }
      if (variableName === 'registryLabels' && node.pos > 0) {
        registryLabels.push(node.initializer)
      }
      if (
        variableName === 'registryAnnotations' &&
        node.initializer.getText(source).includes('registrySpecDigest(mcpServerSpec)')
      ) {
        registryAnnotations.push(node.initializer)
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === 'mcpServerSpec.envSecret'
    ) {
      let parent: ts.Node | undefined = node.parent
      while (parent && !ts.isIfStatement(parent)) parent = parent.parent
      if (
        parent &&
        ts.isIfStatement(parent) &&
        parent.expression.getText(source) === 'credRequired'
      ) {
        assignments.push(node.right)
      }
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      // Catches plain, compound, and destructuring assignments whose targets
      // nest `managed` writes at any depth of the assignment's left side.
      rejectManagedWrites(node, node.left)
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      rejectManagedWrites(node, node.initializer)
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      rejectManagedWrites(node, node.operand)
    }
    if (ts.isDeleteExpression(node)) {
      rejectManagedWrites(node, node.expression)
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      [
        'Object.assign',
        'Object.defineProperty',
        'Object.defineProperties',
        'Reflect.set',
        'Reflect.defineProperty',
      ].includes(node.expression.getText(source)) &&
      (isSpecObjectIdentifier(unwrapReceiver(node.arguments[0])) ||
        writesRegistryManaged(node.arguments[0]))
    ) {
      unsupportedManagedWrites.push(node)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'gateway.createResource' &&
      node.arguments[0]?.getText(source) === "'mcpservers'" &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      const resource = node.arguments[1]
      const metadata = resource.properties.find(
        property =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === 'metadata'
      )
      if (
        metadata &&
        ts.isPropertyAssignment(metadata) &&
        metadata.initializer.getText(source).includes('registryAnnotations')
      ) {
        registryResourceMetadata.push(metadata.initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (unsupportedManagedWrites.length > 0) {
    const write = unsupportedManagedWrites[0]
    const line = source.getLineAndCharacterOfPosition(write.getStart(source)).line + 1
    throw new Error(
      `Unsupported registry managed write at ${path.basename(REGISTRY_PATH)}:${line}: ${write.getText(source)}`
    )
  }
  if (
    assignments.length !== 1 ||
    !ts.isObjectLiteralExpression(assignments[0]) ||
    secretNames.length !== 1 ||
    managedExpressions.length !== 1 ||
    registryAnnotations.length !== 1 ||
    registryResourceMetadata.length !== 1 ||
    !catalogAnnotations
  ) {
    throw new Error('Registry Secret producer changed; rederive the frontend fixture')
  }

  const expression = assignments[0].getText(source)
  const nameExpression = secretNames[0].getText(source)
  const managedExpression = managedExpressions[0].getText(source)
  const labels = registryLabels
    .filter(candidate => candidate.pos < registryAnnotations[0].pos)
    .at(-1)
  if (!labels) throw new Error('Registry labels producer changed; rederive the frontend fixture')
  // Execution semantics: total managed-write detection for the spec scope.
  executeRegistrySpecScope(specDeclaration, source, specObjectIdentifiers)
  const gatewaySource = ts.createSourceFile(
    GATEWAY_PATH,
    readFileSync(GATEWAY_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const gatewayMetadata: ts.Expression[] = []
  function visitGateway(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(gatewaySource) === 'row' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const metadata = node.initializer.properties.find(
        property =>
          ts.isPropertyAssignment(property) && property.name.getText(gatewaySource) === 'metadata'
      )
      if (
        metadata &&
        ts.isPropertyAssignment(metadata) &&
        metadata.initializer.getText(gatewaySource).includes('this.allocateUid(plural, ns')
      ) {
        gatewayMetadata.push(metadata.initializer)
      }
    }
    ts.forEachChild(node, visitGateway)
  }
  visitGateway(gatewaySource)
  if (gatewayMetadata.length !== 1) {
    throw new Error('API response metadata producer changed; rederive the frontend fixture')
  }
  const compiled = ts.transpileModule(
    `const produce = (secretName, credSchema) => (${expression});
     const produceName = (serverName) => (${nameExpression});
     const produceManaged = () => (${managedExpression});
     ${catalogAnnotations.getText(source).replace(/^export /, '')}
     const produceMetadata = (body, serverName, targetNs, isLocal, mcpServerSpec, resourceOperationId) => {
       const registryLabels = ${labels.getText(source)};
       const registryAnnotations = ${registryAnnotations[0].getText(source)};
       return (${registryResourceMetadata[0].getText(source)});
     };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText
  const producers = new Function(
    'REGISTRY_OPERATION_ID_ANNOTATION',
    'REGISTRY_SPEC_DIGEST_ANNOTATION',
    'registrySpecDigest',
    `${compiled}\nreturn { produce, produceName, produceManaged, produceMetadata };`
  )(REGISTRY_OPERATION_ID_ANNOTATION, REGISTRY_SPEC_DIGEST_ANNOTATION, registrySpecDigest) as {
    produce: (secretName: string, credSchema: { keys: { name: string }[] }) => EnvSecret
    produceName: (serverName: string) => string
    produceManaged: () => boolean
    produceMetadata: (
      body: { registryEntryName: string; registryEntryVersion: string },
      serverName: string,
      targetNs: string,
      isLocal: boolean,
      mcpServerSpec: Record<string, unknown>,
      resourceOperationId: string
    ) => NonNullable<McpServerResource['metadata']>
  }
  const gatewayCompiled = ts.transpileModule(
    `function produceResponseMetadata(body, ns, plural) {
       return (${gatewayMetadata[0].getText(gatewaySource)});
     }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText
  const produceResponseMetadata = new Function(
    `${gatewayCompiled}\nreturn produceResponseMetadata;`
  )() as (
    this: { allocateUid: (plural: string, namespace: string, name: string) => string },
    body: { metadata: NonNullable<McpServerResource['metadata']> },
    namespace: string,
    plural: string
  ) => NonNullable<McpServerResource['metadata']>

  return {
    name: producers.produceName,
    envSecret: (secretName, keyNames) =>
      producers.produce(secretName, { keys: keyNames.map(name => ({ name })) }),
    managed: producers.produceManaged,
    metadata: input => {
      const metadata = producers.produceMetadata(
        { registryEntryName: input.catalogId, registryEntryVersion: input.catalogVersion },
        input.serverName,
        input.namespace,
        true,
        input.spec,
        '00000000-0000-4000-8000-000000000001'
      )
      return produceResponseMetadata.call(
        { allocateUid: (plural, namespace, name) => `uid-${plural}-${namespace}-${name}-1` },
        { metadata },
        input.namespace,
        'mcpservers'
      )
    },
  }
}

const registrySecret = registrySecretFactory()

type RegistryMetadataInput = {
  serverName: string
  catalogId: string
  catalogVersion: string
  namespace: string
  spec: Record<string, unknown>
}

export function registryEnvSecret(secretName: string, keyNames: string[]): EnvSecret {
  return registrySecret.envSecret(secretName, keyNames)
}

export function registrySecretName(serverName: string): string {
  return registrySecret.name(serverName)
}

/** Optional source input supports contract mutation tests without writing to
 * the backend producer file. Ordinary fixtures use the checkout's source. */
export function registryMcpServerManaged(registrySource?: string): boolean {
  return registrySource === undefined
    ? registrySecret.managed()
    : registrySecretFactory(registrySource).managed()
}

export function registryMcpServerMetadata(
  input: RegistryMetadataInput
): NonNullable<McpServerResource['metadata']> {
  return registrySecret.metadata(input)
}
