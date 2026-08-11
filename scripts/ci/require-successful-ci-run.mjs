#!/usr/bin/env node
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const CI_WORKFLOW_FILE = 'ci-public.yml'
export const CI_WORKFLOW_PATH = `.github/workflows/${CI_WORKFLOW_FILE}`

function fail(message) {
  throw new Error(message)
}

async function getJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'evenfire-ci-provenance',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (!response.ok) {
    fail(`GitHub API request failed with ${response.status} for ${url.pathname}.`)
  }

  return response.json()
}

export async function requireSuccessfulCiRun({
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
  repository,
  sha,
  token,
  allowedBranches,
}) {
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail('GITHUB_REPOSITORY must be an owner/repository pair.')
  }

  if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) {
    fail('The selected source SHA must be a full 40-character commit SHA.')
  }

  if (!token) {
    fail('GITHUB_TOKEN is required to verify CI provenance.')
  }

  if (
    !Array.isArray(allowedBranches) ||
    allowedBranches.length === 0 ||
    allowedBranches.some(branch => !/^[A-Za-z0-9._/-]+$/.test(branch))
  ) {
    fail('At least one valid allowed push branch is required for CI provenance.')
  }

  const allowedPushBranches = new Set(allowedBranches)

  const normalizedSha = sha.toLowerCase()
  const base = apiUrl.replace(/\/$/, '')
  const workflowUrl = new URL(
    `${base}/repos/${repository}/actions/workflows/${encodeURIComponent(CI_WORKFLOW_FILE)}`
  )
  const workflow = await getJson(fetchImpl, workflowUrl, token)

  if (workflow.path !== CI_WORKFLOW_PATH || !Number.isInteger(workflow.id)) {
    fail(
      `Refusing CI provenance from an unexpected workflow. Expected ${CI_WORKFLOW_PATH}, ` +
        `received ${workflow.path ?? 'no path'}.`
    )
  }

  const runsUrl = new URL(`${base}/repos/${repository}/actions/workflows/${workflow.id}/runs`)
  runsUrl.searchParams.set('event', 'push')
  runsUrl.searchParams.set('status', 'completed')
  runsUrl.searchParams.set('head_sha', normalizedSha)
  runsUrl.searchParams.set('per_page', '100')

  const runs = await getJson(fetchImpl, runsUrl, token)
  const successfulRun = (runs.workflow_runs ?? []).find(
    run =>
      run.head_sha?.toLowerCase() === normalizedSha &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      allowedPushBranches.has(run.head_branch)
  )

  if (!successfulRun) {
    fail(
      `No successful completed ${CI_WORKFLOW_PATH} push run exists for ${normalizedSha} ` +
        `on an allowed branch (${allowedBranches.join(', ')}). Publication is blocked.`
    )
  }

  console.log(
    `Verified ${CI_WORKFLOW_PATH} push run ${successfulRun.id} for ${normalizedSha} ` +
      `on ${successfulRun.head_branch}.`
  )

  return successfulRun
}

function parseCliArgs(args) {
  if (args.length !== 4 || args[0] !== '--sha' || args[2] !== '--branches') {
    fail(
      'Usage: require-successful-ci-run.mjs --sha <full-commit-sha> ' +
        '--branches <branch[,branch]>'
    )
  }

  const allowedBranches = args[3].split(',').filter(Boolean)
  return { allowedBranches, sha: args[1] }
}

async function main() {
  const { allowedBranches, sha } = parseCliArgs(process.argv.slice(2))
  await requireSuccessfulCiRun({
    allowedBranches,
    apiUrl: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    sha,
    token: process.env.GITHUB_TOKEN,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
