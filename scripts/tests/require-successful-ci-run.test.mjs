import assert from 'node:assert/strict'
import test from 'node:test'
import { CI_WORKFLOW_PATH, requireSuccessfulCiRun } from '../ci/require-successful-ci-run.mjs'

const selectedSha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

function successfulRun(overrides = {}) {
  return {
    conclusion: 'success',
    event: 'push',
    head_branch: 'dev',
    head_sha: selectedSha,
    id: 42,
    status: 'completed',
    ...overrides,
  }
}

function fakeGitHub({ run = successfulRun(), workflowPath = CI_WORKFLOW_PATH } = {}) {
  const requested = []
  const fetchImpl = async (url, options) => {
    requested.push({ options, url })

    if (url.pathname.endsWith('/actions/workflows/ci-public.yml')) {
      return response({ id: 7, path: workflowPath })
    }

    assert.equal(url.pathname, '/repos/evenfire-ai/evenfire/actions/workflows/7/runs')
    assert.equal(url.searchParams.get('event'), 'push')
    assert.equal(url.searchParams.get('status'), 'completed')
    assert.equal(url.searchParams.get('head_sha'), selectedSha)
    return response({ workflow_runs: [run] })
  }

  return { fetchImpl, requested }
}

test('accepts an exact successful push run from ci-public.yml on dev', async () => {
  const { fetchImpl, requested } = fakeGitHub()
  const run = await requireSuccessfulCiRun({
    apiUrl: 'https://api.github.test',
    fetchImpl,
    allowedBranches: ['dev'],
    repository: 'evenfire-ai/evenfire',
    sha: selectedSha,
    token: 'test-token',
  })

  assert.equal(run.id, 42)
  assert.equal(requested.length, 2)
  assert.equal(requested[0].options.headers.Authorization, 'Bearer test-token')
})

test('rejects provenance returned for a different workflow path', async () => {
  const { fetchImpl } = fakeGitHub({ workflowPath: '.github/workflows/lookalike.yml' })

  await assert.rejects(
    requireSuccessfulCiRun({
      apiUrl: 'https://api.github.test',
      fetchImpl,
      allowedBranches: ['dev'],
      repository: 'evenfire-ai/evenfire',
      sha: selectedSha,
      token: 'test-token',
    }),
    /unexpected workflow/
  )
})

for (const [label, overrides] of [
  ['wrong SHA', { head_sha: otherSha }],
  ['pull request event', { event: 'pull_request' }],
  ['feature branch', { head_branch: 'feature/unproven' }],
  ['incomplete run', { status: 'in_progress' }],
  ['failed conclusion', { conclusion: 'failure' }],
]) {
  test(`rejects a ${label} instead of exact push provenance`, async () => {
    const { fetchImpl } = fakeGitHub({ run: successfulRun(overrides) })

    await assert.rejects(
      requireSuccessfulCiRun({
        apiUrl: 'https://api.github.test',
        fetchImpl,
        allowedBranches: ['dev'],
        repository: 'evenfire-ai/evenfire',
        sha: selectedSha,
        token: 'test-token',
      }),
      /No successful completed/
    )
  })
}

test('rejects abbreviated SHAs before making a request', async () => {
  let called = false

  await assert.rejects(
    requireSuccessfulCiRun({
      fetchImpl: async () => {
        called = true
        return response({})
      },
      allowedBranches: ['dev'],
      repository: 'evenfire-ai/evenfire',
      sha: 'abc1234',
      token: 'test-token',
    }),
    /full 40-character/
  )

  assert.equal(called, false)
})

test('rejects a successful run from a branch not authorized by the caller', async () => {
  const { fetchImpl } = fakeGitHub({ run: successfulRun({ head_branch: 'main' }) })

  await assert.rejects(
    requireSuccessfulCiRun({
      allowedBranches: ['dev'],
      apiUrl: 'https://api.github.test',
      fetchImpl,
      repository: 'evenfire-ai/evenfire',
      sha: selectedSha,
      token: 'test-token',
    }),
    /allowed branch \(dev\)/
  )
})

test('accepts main when the release caller authorizes main', async () => {
  const { fetchImpl } = fakeGitHub({ run: successfulRun({ head_branch: 'main' }) })

  const run = await requireSuccessfulCiRun({
    allowedBranches: ['main'],
    apiUrl: 'https://api.github.test',
    fetchImpl,
    repository: 'evenfire-ai/evenfire',
    sha: selectedSha,
    token: 'test-token',
  })

  assert.equal(run.head_branch, 'main')
})
