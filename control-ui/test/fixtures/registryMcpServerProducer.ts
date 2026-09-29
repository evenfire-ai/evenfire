import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { EnvSecret } from '../../lib/api'

const REGISTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../control-api/src/routes/admin/registry.ts'
)

/** Execute the registry install producer's Secret-name and envSecret expressions. */
function registrySecretFactory(): {
  name: (serverName: string) => string
  envSecret: (secretName: string, keyNames: string[]) => EnvSecret
} {
  const source = ts.createSourceFile(
    REGISTRY_PATH,
    readFileSync(REGISTRY_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const assignments: ts.Expression[] = []
  const secretNames: ts.Expression[] = []

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'secretName' &&
      node.initializer?.getText(source).includes('${serverName}')
    ) {
      secretNames.push(node.initializer)
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
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (
    assignments.length !== 1 ||
    !ts.isObjectLiteralExpression(assignments[0]) ||
    secretNames.length !== 1
  ) {
    throw new Error('Registry Secret producer changed; rederive the frontend fixture')
  }

  const expression = assignments[0].getText(source)
  const nameExpression = secretNames[0].getText(source)
  const compiled = ts.transpileModule(
    `const produce = (secretName, credSchema) => (${expression});
     const produceName = (serverName) => (${nameExpression});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText
  const producers = new Function(`${compiled}\nreturn { produce, produceName };`)() as {
    produce: (secretName: string, credSchema: { keys: { name: string }[] }) => EnvSecret
    produceName: (serverName: string) => string
  }

  return {
    name: producers.produceName,
    envSecret: (secretName, keyNames) =>
      producers.produce(secretName, { keys: keyNames.map(name => ({ name })) }),
  }
}

const registrySecret = registrySecretFactory()

export function registryEnvSecret(secretName: string, keyNames: string[]): EnvSecret {
  return registrySecret.envSecret(secretName, keyNames)
}

export function registrySecretName(serverName: string): string {
  return registrySecret.name(serverName)
}
