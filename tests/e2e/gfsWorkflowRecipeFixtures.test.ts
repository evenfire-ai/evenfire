import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupGfsWorkflowRecipeFixture,
  seedGfsWorkflowRecipeCloneFixture,
} from './gfsWorkflowRecipeFixtures'

const { kubectlOutMock, runControlPostgresSqlMock } = vi.hoisted(() => ({
  kubectlOutMock: vi.fn(),
  runControlPostgresSqlMock: vi.fn(),
}))

vi.mock('./gfsFixtureCore', async importOriginal => ({
  ...(await importOriginal<typeof import('./gfsFixtureCore')>()),
  kubectlOut: kubectlOutMock,
  runControlPostgresSql: runControlPostgresSqlMock,
}))

describe('seedGfsWorkflowRecipeCloneFixture', () => {
  beforeEach(() => {
    kubectlOutMock.mockReset()
    runControlPostgresSqlMock.mockReset()
  })

  it('clones the canonical read-only source into an E2E-scoped mutation target', () => {
    kubectlOutMock
      .mockReturnValueOnce(JSON.stringify({ spec: { steps: [{ id: 'probe' }] } }))
      .mockReturnValueOnce('workflowrecipe.clerum.io/e2e-gfs-isolation created\n')
    runControlPostgresSqlMock.mockReturnValue('1\n')

    expect(seedGfsWorkflowRecipeCloneFixture('e2e-gfs-isolation', 'gfs-grant-e2e-plugin')).toEqual({
      name: 'e2e-gfs-isolation',
      namespace: 'sandbox-recipes',
      subjectId: '3rd:sandbox-recipes/e2e-gfs-isolation',
    })

    expect(kubectlOutMock).toHaveBeenCalledTimes(2)
    const applyInput = kubectlOutMock.mock.calls[1]?.[2] as string
    expect(JSON.parse(applyInput)).toMatchObject({
      metadata: {
        name: 'e2e-gfs-isolation',
        namespace: 'sandbox-recipes',
        labels: { 'clerum.io/e2e': 'true' },
      },
      spec: { steps: [{ id: 'probe' }] },
    })
    expect(runControlPostgresSqlMock).toHaveBeenCalledOnce()
    expect(runControlPostgresSqlMock.mock.calls[0]?.[0]).toContain(
      "recipe_name = 'gfs-grant-e2e-plugin'"
    )
    expect(runControlPostgresSqlMock.mock.calls[0]?.[0]).toContain("'e2e-gfs-isolation'")
  })

  it('fails closed when the canonical source has no user grant to copy', () => {
    kubectlOutMock
      .mockReturnValueOnce(JSON.stringify({ spec: { steps: [{ id: 'probe' }] } }))
      .mockReturnValueOnce('workflowrecipe.clerum.io/e2e-gfs-isolation created\n')
    runControlPostgresSqlMock.mockReturnValue('0\n')

    expect(() =>
      seedGfsWorkflowRecipeCloneFixture('e2e-gfs-isolation', 'gfs-grant-e2e-plugin')
    ).toThrow('has no user grant to copy')
  })

  it('removes only the exact E2E recipe grant rows and proves cleanup', () => {
    kubectlOutMock.mockReturnValue('workflowrecipe.clerum.io/e2e-gfs-isolation deleted\n')
    runControlPostgresSqlMock.mockReturnValueOnce('DELETE 1\n').mockReturnValueOnce('0\n')

    cleanupGfsWorkflowRecipeFixture('e2e-gfs-isolation')

    expect(kubectlOutMock).toHaveBeenCalledWith(
      [
        '-n',
        'sandbox-recipes',
        'delete',
        'workflowrecipe',
        'e2e-gfs-isolation',
        '--ignore-not-found=true',
      ],
      20_000
    )
    expect(runControlPostgresSqlMock).toHaveBeenCalledTimes(2)
    for (const [sql] of runControlPostgresSqlMock.mock.calls) {
      expect(sql).toContain("recipe_namespace = 'sandbox-recipes'")
      expect(sql).toContain("recipe_name = 'e2e-gfs-isolation'")
    }
  })

  it('rejects unsafe cleanup before invoking Kubernetes or SQL', () => {
    expect(() => cleanupGfsWorkflowRecipeFixture('unsafe-recipe')).toThrow(
      'refusing to mutate non-E2E GFS fixture'
    )
    expect(kubectlOutMock).not.toHaveBeenCalled()
    expect(runControlPostgresSqlMock).not.toHaveBeenCalled()
  })

  it('rejects an unsafe mutation target before invoking kubectl', () => {
    expect(() =>
      seedGfsWorkflowRecipeCloneFixture('unsafe-recipe', 'gfs-grant-e2e-plugin')
    ).toThrow('refusing to mutate non-E2E GFS fixture')
    expect(kubectlOutMock).not.toHaveBeenCalled()
    expect(runControlPostgresSqlMock).not.toHaveBeenCalled()
  })
})
