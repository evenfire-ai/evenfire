import { describe, expect, it } from 'vitest'
import { assertBranchProfileContext } from './e2e-playwright/helpers/branchProfileContext.js'

describe('assertBranchProfileContext', () => {
  it('accepts a generated branch-scoped profile name', () => {
    expect(() =>
      assertBranchProfileContext('clerum-fix-issue-825-storage-layout-v2-569a1d53')
    ).not.toThrow()
    expect(() => assertBranchProfileContext('clerum-a-0123abcd')).not.toThrow()
  })

  it.each([
    'minikube',
    'clerum-test',
    'prod',
    'clerum',
    'gke_${GCP_PROJECT}_us-central1-a_example-dev',
    'clerum-fix-ABC-0123abcd',
    'clerum-fix-0123abc',
    'clerum-fix-0123abcd-extra',
    ' clerum-fix-0123abcd',
  ])('refuses %j', context => {
    expect(() => assertBranchProfileContext(context)).toThrow(
      `Context '${context}' is not a branch-scoped Minikube profile`
    )
  })
})
