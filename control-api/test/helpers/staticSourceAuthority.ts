import ts from 'typescript'

export type BoundedEnvBytes = { fallback: number; ceiling: number }

function parseTypeScript(source: string, label: string): ts.SourceFile {
  const file = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics
  if (diagnostics.length > 0) throw new Error(`${label} contains malformed TypeScript`)
  return file
}

function evaluateStaticByteExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  label: string
): number {
  if (ts.isParenthesizedExpression(expression)) {
    return evaluateStaticByteExpression(expression.expression, sourceFile, label)
  }
  if (ts.isNumericLiteral(expression)) {
    const literal = expression.getText(sourceFile)
    if (!/^(?:0|[1-9][0-9]*(?:_[0-9]+)*)$/.test(literal)) {
      throw new Error(`${label} must use a canonical decimal integer literal`)
    }
    const value = Number(literal.replaceAll('_', ''))
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`)
    return value
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken
  ) {
    const left = evaluateStaticByteExpression(expression.left, sourceFile, label)
    const right = evaluateStaticByteExpression(expression.right, sourceFile, label)
    const value = left * right
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`)
    return value
  }
  throw new Error(`${label} must use only decimal integers and multiplication`)
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false)
  )
}

function directExportedConstInitializer(
  sourceFile: ts.SourceFile,
  symbol: string,
  label: string
): ts.Expression {
  const declarations: ts.VariableDeclaration[] = []
  let indirectExport = false

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === symbol) {
      declarations.push(node)
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        indirectExport = true
      } else {
        for (const element of node.exportClause.elements) {
          if (element.name.text === symbol) indirectExport = true
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (indirectExport || declarations.length !== 1) {
    throw new Error(`${symbol} must have exactly one unambiguous direct export in ${label}`)
  }
  const declaration = declarations[0]
  const declarationList = declaration.parent
  const statement = declarationList.parent
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    (declarationList.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isVariableStatement(statement) ||
    !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
    !declaration.initializer
  ) {
    throw new Error(`${symbol} must be a direct exported const initializer in ${label}`)
  }
  return declaration.initializer
}

export function staticExportedBytesFromSource(
  source: string,
  symbol: string,
  label = symbol
): number {
  const sourceFile = parseTypeScript(source, label)
  const initializer = directExportedConstInitializer(sourceFile, symbol, label)
  return evaluateStaticByteExpression(initializer, sourceFile, `${label}:${symbol}`)
}

function staticStringExpression(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression)) return expression.text
  if (ts.isParenthesizedExpression(expression)) return staticStringExpression(expression.expression)
  return null
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) return staticStringExpression(name.expression)
  return null
}

export function boundedEnvBytesFromSource(
  source: string,
  objectSymbol: string,
  property: string,
  envName: string,
  label = envName
): BoundedEnvBytes {
  const sourceFile = parseTypeScript(source, label)
  const initializer = directExportedConstInitializer(sourceFile, objectSymbol, label)
  if (!ts.isObjectLiteralExpression(initializer)) {
    throw new Error(`${objectSymbol} must be initialized with an object literal in ${label}`)
  }

  const authorities: ts.ObjectLiteralElementLike[] = []
  for (const member of initializer.properties) {
    if (ts.isSpreadAssignment(member)) {
      throw new Error(`${objectSymbol} must not contain spread authority in ${label}`)
    }
    if (ts.isComputedPropertyName(member.name) && propertyName(member.name) === null) {
      throw new Error(`${objectSymbol} contains an unresolved computed authority in ${label}`)
    }
    if (propertyName(member.name) === property) authorities.push(member)
  }

  if (authorities.length !== 1) {
    throw new Error(`${property} must have exactly one active authority in ${label}`)
  }
  const authority = authorities[0]
  if (!ts.isPropertyAssignment(authority)) {
    throw new Error(`${property} must use an explicit property assignment in ${label}`)
  }
  const call = authority.initializer
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'boundedIntegerFromEnv' ||
    call.arguments.length !== 3 ||
    !ts.isStringLiteral(call.arguments[0]) ||
    call.arguments[0].text !== envName
  ) {
    throw new Error(`${property} must use the expected boundedIntegerFromEnv call in ${label}`)
  }
  const [, fallback, ceiling] = call.arguments
  return {
    fallback: evaluateStaticByteExpression(fallback, sourceFile, `${label}:${envName}:fallback`),
    ceiling: evaluateStaticByteExpression(ceiling, sourceFile, `${label}:${envName}:ceiling`),
  }
}
