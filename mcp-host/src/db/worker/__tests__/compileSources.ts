import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/** mcp-host package root. */
export const MCP_HOST_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

/**
 * Compiles real mcp-host sources (and everything they import) into `outDir`
 * with the package tsconfig. Node cannot load `.ts` files with extensionless
 * imports directly, so tests that need the real worker thread or the real
 * entrypoint run the compiled output. `outDir`'s parent must link the
 * package's node_modules so better-sqlite3 and the logger resolve.
 *
 * @param roots paths relative to `src/`, e.g. `db/worker/dbWorker.ts`
 * @returns the compiled `.js` path of each root, in order
 */
export function compileSources(roots: readonly string[], outDir: string): string[] {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(MCP_HOST_ROOT, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: d => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      },
    }
  )
  if (!config) throw new Error('tsconfig.json could not be parsed')
  const program = ts.createProgram(
    roots.map(root => path.join(MCP_HOST_ROOT, 'src', root)),
    {
      ...config.options,
      rootDir: path.join(MCP_HOST_ROOT, 'src'),
      outDir,
      noEmit: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      incremental: false,
      composite: false,
    }
  )
  const result = program.emit()
  if (result.emitSkipped) throw new Error(`emit was skipped for ${roots.join(', ')}`)
  return roots.map(root => {
    const script = path.join(outDir, root.replace(/\.ts$/, '.js'))
    if (!fs.existsSync(script)) throw new Error(`compiled output missing: ${script}`)
    return script
  })
}
