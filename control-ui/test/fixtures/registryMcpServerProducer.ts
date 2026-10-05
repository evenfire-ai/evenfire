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
