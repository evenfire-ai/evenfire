import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('./run-node-test-files.mjs', import.meta.url))
for (const scenario of ['valid', 'empty', 'mixed', 'skipped']) {
  test(`registration gate checks each file: ${scenario}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'evenfire-registration-'))
    try {
      const valid = path.join(directory, 'valid.test.mjs')
      const other = path.join(directory, 'other.test.mjs')
      writeFileSync(valid, "import test from 'node:test'; test('registered case', () => {});")
      writeFileSync(
        other,
        scenario === 'skipped'
          ? "import test from 'node:test'; test.skip('omitted case', () => {});"
          : ''
      )
      const files = scenario === 'valid' ? [valid] : scenario === 'mixed' ? [valid, other] : [other]
      const result = spawnSync(process.execPath, [runner, ...files], {
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status, scenario === 'valid' ? 0 : 1)
      if (scenario !== 'valid') assert.match(result.stderr, /No executed test cases in:/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
