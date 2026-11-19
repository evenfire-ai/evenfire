import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * Read constants from another package's source without executing it. Packages
 * share no module, and importing a config module would run it (it reads the
 * environment and can throw at load). A constant that is not found throws, so
 * a rename fails the test instead of passing it.
 */
export function readSourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
}

/** The value of `export const <symbol> = <numeric literal>` in `sourceFile`. */
export function exportedNumericConst(sourceFile: ts.SourceFile, symbol: string): number {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const exported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== symbol) continue
      const initializer = declaration.initializer
      if (initializer === undefined || !ts.isNumericLiteral(initializer)) {
        throw new Error(
          `${symbol} in ${sourceFile.fileName} must be initialized with a numeric literal`
        )
      }
      return Number(initializer.text)
    }
  }
  throw new Error(`${symbol} is not an exported const in ${sourceFile.fileName}`)
}

/**
 * The string-literal default passed next to the literal env name `envName` to
 * the env reader `getter`, as in `getEnv('NAME', '30000')`. Exactly one such
 * call must exist.
 */
export function stringLiteralDefaultFor(
  sourceFile: ts.SourceFile,
  envName: string,
  getter = 'getEnv'
): string {
  const defaults: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === getter
    ) {
      const [name, fallback] = node.arguments
      if (name !== undefined && ts.isStringLiteral(name) && name.text === envName) {
        if (fallback === undefined || !ts.isStringLiteral(fallback)) {
          throw new Error(`${envName} in ${sourceFile.fileName} must have a string-literal default`)
        }
        defaults.push(fallback.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (defaults.length !== 1) {
    throw new Error(
      `expected one default for ${envName} in ${sourceFile.fileName}, found ${defaults.length}`
    )
  }
  return defaults[0]
}
