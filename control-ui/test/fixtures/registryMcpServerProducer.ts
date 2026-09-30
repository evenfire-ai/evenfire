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
function registrySecretFactory(): {
  name: (serverName: string) => string
  envSecret: (secretName: string, keyNames: string[]) => EnvSecret
  metadata: (input: RegistryMetadataInput) => NonNullable<McpServerResource['metadata']>
} {
  const source = ts.createSourceFile(
    REGISTRY_PATH,
    readFileSync(REGISTRY_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const assignments: ts.Expression[] = []
  const secretNames: ts.Expression[] = []
  const registryLabels: ts.Expression[] = []
  const registryAnnotations: ts.Expression[] = []
  const registryResourceMetadata: ts.Expression[] = []
  let catalogAnnotations: ts.FunctionDeclaration | undefined

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
  if (
    assignments.length !== 1 ||
    !ts.isObjectLiteralExpression(assignments[0]) ||
    secretNames.length !== 1 ||
    registryAnnotations.length !== 1 ||
    registryResourceMetadata.length !== 1 ||
    !catalogAnnotations
  ) {
    throw new Error('Registry Secret producer changed; rederive the frontend fixture')
  }

  const expression = assignments[0].getText(source)
  const nameExpression = secretNames[0].getText(source)
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
    `${compiled}\nreturn { produce, produceName, produceMetadata };`
  )(REGISTRY_OPERATION_ID_ANNOTATION, REGISTRY_SPEC_DIGEST_ANNOTATION, registrySpecDigest) as {
    produce: (secretName: string, credSchema: { keys: { name: string }[] }) => EnvSecret
    produceName: (serverName: string) => string
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

export function registryMcpServerMetadata(
  input: RegistryMetadataInput
): NonNullable<McpServerResource['metadata']> {
  return registrySecret.metadata(input)
}
