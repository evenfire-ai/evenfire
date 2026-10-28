import { describe, expect, it } from 'vitest'
import * as externalSessionAuth from '../src/middleware/externalSessionAuth.js'
import * as workflowAuth from '../src/routes/workflows/shared/auth.js'

describe('external session authentication exports', () => {
  it('does not expose the unused session and workflow auth adapters', () => {
    expect(externalSessionAuth).not.toHaveProperty('isCurrentExternalSession')
    expect(externalSessionAuth).not.toHaveProperty('assertCurrentExternalSession')
    expect(workflowAuth).not.toHaveProperty('requireExternalWorkflowCaller')
    expect(workflowAuth).not.toHaveProperty('requireExternalWorkflowCallerMiddleware')
    expect(workflowAuth).not.toHaveProperty('bindExternalWorkflowAuth')
    expect(workflowAuth.bindCompletedExternalWorkflowCaller).toBeTypeOf('function')
  })
})
