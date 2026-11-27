import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// Execute the actual annotation producer without importing the backend's route
// dependencies. This follows guardrailProducer's AST-backed fixture pattern.
const filename = path.resolve(__dirname, '../../../control-api/src/routes/admin/registry.ts')
const source = ts.createSourceFile(
  filename,
  readFileSync(filename, 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const producer = source.statements.find(
  statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'catalogAnnotations'
)
if (!producer || !ts.isFunctionDeclaration(producer) || !producer.body) {
  throw new Error('Catalog annotation producer changed; rederive the connector metadata fixture')
}
const javascript = ts.transpileModule(
  `function produce(entryName: string, version: string) ${producer.body.getText(source)}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText
export const produceCatalogAnnotations = new Function(`${javascript}\nreturn produce;`)() as (
  name: string,
  version: string
) => Record<string, string>
