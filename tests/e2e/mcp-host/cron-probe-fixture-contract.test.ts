import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CRON_EXEC_PROBE_INSTRUCTION } from '../fixtures/cronExecProbeInstruction.js'

function yamlInstructionBlock(source: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line.trim() === 'instruction: |')
  if (start < 0) throw new Error('WorkflowRecipe fixture has no instruction block')

  const parentIndent = lines[start].length - lines[start].trimStart().length
  const contentIndent = parentIndent + 2
  const content: string[] = []
  for (const line of lines.slice(start + 1)) {
    const indent = line.length - line.trimStart().length
    if (line.trim() && indent <= parentIndent) break
    content.push(line.slice(Math.min(contentIndent, line.length)))
  }
  return content.join('\n').trim()
}

describe('CR-11 cron probe fixture contract', () => {
  it('keeps the WorkflowRecipe instruction aligned with the shared E2E probe', () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    const recipePath = path.resolve(currentDir, '../fixtures/cron-exec-test-recipe.yaml')
    expect(yamlInstructionBlock(fs.readFileSync(recipePath, 'utf8'))).toBe(
      CRON_EXEC_PROBE_INSTRUCTION
    )
  })
})
