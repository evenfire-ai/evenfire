import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registryMcpServerManaged } from '../fixtures/registryMcpServerProducer'

const REGISTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../control-api/src/routes/admin/registry.ts'
)

it('rejects a later computed managed write in the registry producer', () => {
  const source = readFileSync(REGISTRY_PATH, 'utf8')
  const marker = '        // Local plugins whose image lives on the evenfire registry'
  expect(source).toContain(marker)
  const changedSource = source.replace(
    marker,
    `        mcpServerSpec['managed'] = false\n\n${marker}`
  )

  expect(() => registryMcpServerManaged(changedSource)).toThrow(
    /unsupported registry managed write.*mcpServerSpec\['managed'\] = false/i
  )
})

it('rejects a later destructuring managed write in the registry producer', () => {
  const source = readFileSync(REGISTRY_PATH, 'utf8')
  // Placed after a block-closed statement so the array literal parses as a
  // standalone destructuring assignment, not as element access continuation
  // of the preceding expression.
  const marker = '        // Stdio servers may need a custom command'
  expect(source).toContain(marker)
  const changedSource = source.replace(
    marker,
    `        [mcpServerSpec.managed] = [false]\n\n${marker}`
  )

  expect(() => registryMcpServerManaged(changedSource)).toThrow(
    /unsupported registry managed write.*\[mcpServerSpec\.managed\] = \[false\]/i
  )
})

it('rejects a managed write through a spec alias in the registry producer', () => {
  const source = readFileSync(REGISTRY_PATH, 'utf8')
  const marker = '        // Stdio servers may need a custom command'
  expect(source).toContain(marker)
  const changedSource = source.replace(
    marker,
    `        const specAlias = mcpServerSpec\n        specAlias['managed'] = false\n\n${marker}`
  )

  expect(() => registryMcpServerManaged(changedSource)).toThrow(
    /unsupported registry managed write.*specAlias\['managed'\] = false/i
  )
})
