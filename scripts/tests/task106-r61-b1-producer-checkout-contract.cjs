const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const repositoryRoot = path.resolve(__dirname, '../..')
const workflowPath = path.join(repositoryRoot, '.github/workflows/ci-public.yml')
const migrationTestPath = path.join(
  repositoryRoot,
  'control-api/test/migrationExecutionPolicy.realPostgres.integration.test.ts'
)

const producers = [
  {
    environment: 'TASK106_R61_B1_DEV_SOURCE_DIR',
    commit: 'OBSERVED_DEV_SOURCE_COMMIT',
    checkout: 'observed-dev',
  },
  {
    environment: 'TASK106_R61_B1_LATEST_DEV_SOURCE_DIR',
    commit: 'LATEST_DEV_SOURCE_COMMIT',
    checkout: 'latest-dev',
  },
].map(producer => ({ ...producer, checkout: `r61-b1-producers/${producer.checkout}` }))

function readJobSteps(workflow) {
  const lines = workflow.split(/\r?\n/)
  const start = lines.findIndex(line => line === '  control-api-migration:')
  assert.notEqual(start, -1, 'Real PostgreSQL job exists')
  const end = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line))
  const jobLines = lines.slice(start, end === -1 ? undefined : end)
  const steps = []
  for (const line of jobLines) {
    if (/^      - /.test(line)) steps.push([line])
    else if (steps.length > 0) steps.at(-1).push(line)
  }
  return steps.map(step => step.join('\n'))
}

function pinnedCommit(testSource, name) {
  const match = new RegExp(`^const ${name} = '([0-9a-f]{40})'$`, 'm').exec(testSource)
  assert.ok(match, `migration test declares ${name}`)
  return match[1]
}

function checkoutFor(steps, expectedPath) {
  const checkout = steps
    .filter(step => step.includes('uses: actions/checkout@'))
    .map(step => ({
      path: /^          path: (.+)$/m.exec(step)?.[1],
      ref: /^          ref: ([0-9a-f]{40})$/m.exec(step)?.[1],
    }))
    .find(candidate => candidate.path === expectedPath)
  assert.ok(checkout, `workflow checks out distinct producer path ${expectedPath}`)
  return checkout
}

function hasCommand(steps, workingDirectory, command) {
  return steps.some(
    step =>
      new RegExp(
        `^        working-directory: ${workingDirectory.replaceAll('/', '\\/')}$`,
        'm'
      ).test(step) &&
      new RegExp(`^        run: ${command.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'm').test(
        step
      )
  )
}

test('RealPG job materializes every pinned producer and builds its migration runner', () => {
  const workflow = readFileSync(workflowPath, 'utf8')
  const migrationTest = readFileSync(migrationTestPath, 'utf8')
  const steps = readJobSteps(workflow)
  const expectedPaths = producers.map(producer => producer.checkout)
  assert.equal(new Set(expectedPaths).size, producers.length, 'producer paths are distinct')

  const materialized = producers.map(producer => {
    const pin = pinnedCommit(migrationTest, producer.commit)
    const checkout = checkoutFor(steps, producer.checkout)
    assert.equal(checkout.ref, pin, `${producer.environment} uses its pinned source identity`)
    return { ...producer, pin }
  })

  const realPgStep = steps.find(step => step.includes('name: Run control-api real Postgres suites'))
  assert.ok(realPgStep, 'required RealPG suite step exists')
  for (const producer of materialized) {
    const assignment = `          ${producer.environment}: \${{ github.workspace }}/${producer.checkout}`
    assert.ok(
      realPgStep.split('\n').includes(assignment),
      `${producer.environment} maps to its own checkout`
    )

    for (const packagePath of ['packages/workflow-runtime-core', 'control-api']) {
      const directory = `${producer.checkout}/${packagePath}`
      assert.ok(hasCommand(steps, directory, 'npm ci'), `${directory} installs locked dependencies`)
      assert.ok(
        hasCommand(steps, directory, 'npm run build'),
        `${directory} builds the pinned migration producer`
      )
    }
  }

  const contractStepIndex = steps.findIndex(step =>
    step.includes('node --test scripts/tests/task106-r61-b1-producer-checkout-contract.cjs')
  )
  const setupNodeIndex = steps.findIndex(step => step.includes('uses: actions/setup-node@'))
  const realPgStepIndex = steps.indexOf(realPgStep)
  assert.ok(contractStepIndex > setupNodeIndex, 'Node 24 is installed before the contract test')
  assert.ok(contractStepIndex < realPgStepIndex, 'contract test runs before RealPG suites')

  const workspace = process.env.R61_B1_PRODUCER_WORKSPACE
  assert.ok(workspace, 'CI contract test receives the producer workspace')
  for (const producer of materialized) {
    const sourceDirectory = path.join(workspace, producer.checkout)
    assert.ok(existsSync(sourceDirectory), `${producer.environment} checkout is materialized`)
    const head = execFileSync('git', ['-C', sourceDirectory, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    assert.equal(head, producer.pin, `${producer.environment} HEAD matches its pinned commit`)
    const status = execFileSync('git', ['-C', sourceDirectory, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim()
    assert.equal(status, '', `${producer.environment} source checkout is clean`)
  }
})
