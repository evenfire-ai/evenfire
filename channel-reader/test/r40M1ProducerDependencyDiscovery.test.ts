import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDirectory, '../..')

describe('R40-M1 CI producer dependency discovery', () => {
  it('discovers the MCP Host server used by the real mounted regression producer', () => {
    const mountedProducerTest = resolve(
      repositoryRoot,
      'channel-reader/test/r40M1ExplicitAdmissionRecovery.integration.test.ts'
    )
    const serverSourceReference = ['..', '..', 'mcp-host', 'src', 'server'].join('/')
    expect(readFileSync(mountedProducerTest, 'utf8')).toContain(serverSourceReference)

    const installer = resolve(repositoryRoot, 'scripts/ci/install-test-producer-dependencies.sh')
    const discovered = execFileSync('bash', [installer, 'channel-reader'], {
      cwd: repositoryRoot,
      env: { ...process.env, CI_TEST_PRODUCER_INSTALL_DRY_RUN: '1' },
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .filter(Boolean)

    expect(discovered.filter(producer => producer === 'mcp-host')).toHaveLength(1)
  })
})
