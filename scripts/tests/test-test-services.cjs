'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkServices } = require('../dev/check-test-services.cjs')
const workflow = '      matrix:\n        service:\n          - one\n          - packages/two\n\n    steps:\n'

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
  assert.throws(() => checkServices(workflow.replace('\n    steps:', '        exclude:\n          - service: one\n    steps:'), ['one', 'packages/two']), /Unsupported/)
})
