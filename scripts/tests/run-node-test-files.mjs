import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const files = process.argv.slice(2).map(file => realpathSync(file))
if (files.length === 0) throw new Error('Expected explicit node test files')
const reporter = fileURLToPath(new URL('./node-registration-reporter.mjs', import.meta.url))
const env = { ...process.env, NODE_TEST_EXPECTED_FILES: JSON.stringify(files) }
// An explicit runner invocation must not inherit a parent test worker's IPC mode.
delete env.NODE_TEST_CONTEXT
const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-reporter=tap',
    '--test-reporter-destination=stdout',
    `--test-reporter=${reporter}`,
    '--test-reporter-destination=stderr',
    ...files,
  ],
  {
    stdio: 'inherit',
    env,
  }
)
process.exit(result.status ?? 1)
