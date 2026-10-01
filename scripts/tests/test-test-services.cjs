'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkServices } = require('../dev/check-test-services.cjs')
const workflow = '      matrix:\n        service:\n          - one\n          - packages/two\n\n    steps:\n'
const singleServiceWorkflow = '      matrix:\n        service:\n          - one\n\n    steps:\n'
const workflowWithMetadata = workflow.replace(
  '\n    steps:',
  '\n        include:\n          - pinned_suites: one.test.ts\n            service: one\n          - service: one\n            pinned_suites: one.test.ts\n      max-parallel: 2\n    steps:'
)
const workflowWithDuplicateServiceAxis = workflow.replace(
  '\n    steps:',
  '\n        include:\n          - service: one\n        service:\n          - two\n    steps:'
)
const workflowWithUnknownLaterIncludeService = workflowWithMetadata.replace(
  '            service: one',
  '            service: fixture-only'
)
const workflowWithDynamicLaterIncludeService = workflowWithMetadata.replace(
  '            service: one',
  '            service: ${{ inputs.service }}'
)
const workflowWithFlowFirstInclude = workflowWithMetadata.replace(
  '          - pinned_suites: one.test.ts\n            service: one',
  '          - { service: fixture-only }'
)
const workflowWithFlowLaterInclude = workflowWithMetadata.replace(
  '          - pinned_suites: one.test.ts\n            service: one',
  '          - { pinned_suites: one.test.ts, service: fixture-only }'
)
const workflowWithAliasInclude = workflowWithMetadata.replace(
  '          - pinned_suites: one.test.ts\n            service: one',
  '          - &include_defaults\n            service: fixture-only'
)
const workflowWithDuplicateIncludeService = workflowWithMetadata.replace(
  '          - pinned_suites: one.test.ts\n            service: one',
  '          - pinned_suites: one.test.ts\n            service: one\n            service: fixture-only'
)
const workflowWithDynamicIncludeHeader = workflowWithMetadata.replace(
  '        include:',
  '        include: ${{ inputs.includes }}'
)
const workflowWithExclude = workflow.replace(
  '\n    steps:',
  '\n        exclude:\n          - service: packages/two\n    steps:'
)

test('matrix parity is independent of order', () => {
  assert.equal(checkServices(workflow, ['packages/two', 'one']), 2)
})
test('missing and extra services fail with actionable names', () => {
  assert.throws(() => checkServices(workflow, ['one', 'three']), /missing from Makefile: packages\/two; absent from CI: three/)
})
test('duplicate services fail on either side', () => {
  assert.throws(() => checkServices(workflow, ['one', 'one']), /Makefile contains duplicate/)
  assert.throws(() => checkServices(workflow.replace('packages/two', 'one'), ['one']), /CI contains duplicate/)
})
test('dynamic, missing and ambiguous matrices fail closed', () => {
  assert.throws(() => checkServices(workflow.replace('packages/two', '${{ inputs.service }}'), ['one']), /Unsupported/)
  assert.throws(() => checkServices('', []), /Expected one/)
  assert.throws(() => checkServices(workflow + workflow, []), /Expected one/)
})
test('matrix service collection ends at sibling metadata', () => {
  assert.equal(checkServices(workflowWithMetadata, ['one', 'packages/two']), 2)
})
test('a literal one-service axis is valid', () => {
  assert.equal(checkServices(singleServiceWorkflow, ['one']), 1)
})
test('include services must be static members of the service axis', () => {
  assert.throws(
    () => checkServices(workflowWithUnknownLaterIncludeService, ['one', 'packages/two']),
    /Include-only CI service: fixture-only/
  )
  assert.throws(
    () => checkServices(workflowWithDynamicLaterIncludeService, ['one', 'packages/two']),
    /Unsupported CI include service/
  )
  for (const unsupported of [workflowWithFlowFirstInclude, workflowWithFlowLaterInclude, workflowWithAliasInclude]) {
    assert.throws(() => checkServices(unsupported, ['one', 'packages/two']), /Unsupported CI include entry/)
  }
  assert.throws(
    () => checkServices(workflowWithDuplicateIncludeService, ['one', 'packages/two']),
    /Unsupported CI include entry/
  )
  assert.throws(
    () => checkServices(workflowWithDynamicIncludeHeader, ['one', 'packages/two']),
    /Unsupported CI matrix metadata/
  )
})
test('matrix exclude that removes required coverage fails closed', () => {
  assert.throws(() => checkServices(workflowWithExclude, ['one', 'packages/two']), /Unsupported CI matrix metadata/)
})
test('duplicate service axes in one matrix fail closed', () => {
  assert.throws(
    () => checkServices(workflowWithDuplicateServiceAxis, ['one', 'packages/two']),
    /Expected one/
  )
})
test('malformed entries and indentation still fail closed', () => {
  assert.throws(() => checkServices(workflow.replace('packages/two', 'packages/two?'), ['one']), /Unsupported/)
  assert.throws(
    () =>
      checkServices(
        workflow.replace('\n          - packages/two', '\n            - packages/two'),
        ['one']
      ),
    /Unsupported/
  )
  assert.throws(
    () =>
      checkServices(
        workflow.replace('\n        service:', '\n        include:\n        service:'),
        ['one', 'packages/two']
      ),
    /Expected one/
  )
})
test('empty, inline and re-indented matrices fail closed', () => {
  assert.throws(() => checkServices('      matrix:\n        service:\n\n    steps:\n', []), /Expected one/)
  assert.throws(() => checkServices('      matrix:\n        service: [one, packages/two]\n    steps:\n', ['one', 'packages/two']), /Expected one/)
  assert.throws(() => checkServices(workflow.replace(/^ {6}/gm, '    '), ['one', 'packages/two']), /Expected one/)
})
