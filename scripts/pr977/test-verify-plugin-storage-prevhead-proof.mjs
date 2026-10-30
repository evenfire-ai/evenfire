import assert from 'node:assert/strict'
import { verifyPreviousHeadReport } from './verify-plugin-storage-prevhead-proof.mjs'

const report = {
  success: false,
  counterConsistency: { valid: true },
  numTestFiles: 1,
  numTotalTests: 2,
  numPassedTests: 0,
  numFailedTests: 2,
  numPendingTests: 0,
  testResults: [
    {
      status: 'failed',
      failure: { phase: 'test' },
      assertionResults: [
        {
          status: 'failed',
          title: 'rejects a new audit append after an unsafe DACL is added',
          failure: {
            phase: 'test',
            category: 'assertion',
            errorType: 'AssertionError',
            failedHooks: [],
          },
        },
        {
          status: 'failed',
          title: 'refuses to trust an existing consent grant after an unsafe DACL is added',
          failure: {
            phase: 'test',
            category: 'assertion',
            errorType: 'AssertionError',
            failedHooks: [],
          },
        },
      ],
    },
  ],
}

assert.doesNotThrow(() => verifyPreviousHeadReport(report))
for (const invalid of [
  { ...report, success: true },
  { ...report, counterConsistency: { valid: false } },
  { ...report, numFailedTests: 0 },
  { ...report, numPendingTests: 1 },
  {
    ...report,
    testResults: [
      {
        ...report.testResults[0],
        failure: { phase: 'collection' },
        assertionResults: [],
      },
    ],
  },
  {
    ...report,
    testResults: [
      {
        ...report.testResults[0],
        assertionResults: [
          {
            ...report.testResults[0].assertionResults[0],
            failure: { phase: 'setup', category: 'fixture' },
          },
        ],
      },
    ],
  },
]) {
  assert.throws(() => verifyPreviousHeadReport(invalid))
}

process.stdout.write(
  'Previous-head proof verifier rejects non-assertion and incomplete evidence.\n'
)
