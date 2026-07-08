/**
 * Namespace Guard — prevents hardcoded namespace strings from creeping back in.
 *
 * The WRC uses config-driven namespaces (CLERUM_NAMESPACE, CLERUM_SANDBOX_NAMESPACE).
 * Hardcoding "mcp-server" in production code bypasses the config and creates
 * silent deployment bugs when namespaces differ from defaults.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const WORKFLOW_SRC = path.resolve(__dirname, '../../../src/workflow')

// Files allowed to contain "mcp-server" as a string literal.
// WorkflowRecipe CRD placement is not one of those exceptions: recipe CRDs and
// child recipe CRDs are sandbox-owned. MCP transport resources receive their
// namespace from the explicit mcpServerNamespace plumbing instead.
const ALLOWED_FILES = new Set([
  'types.ts', // JSDoc comments with examples
])

function getSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...getSourceFiles(path.join(dir, entry.name)))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path.join(dir, entry.name))
    }
  }
  return files
}

describe('Namespace Guard', () => {
  it('no production workflow code contains hardcoded "mcp-server" string literals', () => {
    const violations: string[] = []

    for (const filePath of getSourceFiles(WORKFLOW_SRC)) {
      const fileName = path.basename(filePath)
      if (ALLOWED_FILES.has(fileName)) continue

      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip comments and imports
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
        if (line.includes('import ')) continue

        // Match string literals containing exactly "mcp-server"
        if (/"mcp-server"/.test(line) || /'mcp-server'/.test(line)) {
          violations.push(`${fileName}:${i + 1}: ${line.trim()}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('finalizationHandler.cleanupWorkflowResources requires mcpServerNamespace parameter', async () => {
    const { cleanupWorkflowResources } = await import('../../../src/workflow/finalizationHandler')
    // 4 parameters: recipeName, sandboxNamespace, mcpServerNamespace, deps
    expect(cleanupWorkflowResources.length).toBe(4)
  })
})
