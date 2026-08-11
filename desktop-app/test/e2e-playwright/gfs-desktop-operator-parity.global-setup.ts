import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  GFS_OPERATOR_SETUP_PATH,
  gfsOperatorRuntimeEvidencePath,
  requireGfsOperatorRunId,
  reserveGfsOperatorEvidenceRun,
  writeJsonAtomically,
} from './gfsDesktopOperatorParityContract'
import { validateBaseUrls } from './global-setup'

const DESKTOP_APP_ROOT = path.resolve(__dirname, '../..')
const REPO_ROOT = path.resolve(DESKTOP_APP_ROOT, '..')
const REQUIRED_ARTIFACT_FILES = [
  path.join(DESKTOP_APP_ROOT, 'dist/main.js'),
  path.join(DESKTOP_APP_ROOT, 'dist/preload.js'),
  path.join(DESKTOP_APP_ROOT, 'ui-dist/index.html'),
]

function command(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function requiredEnvironment(name: string, candidates: Array<string | undefined>): string {
  const value = candidates.find(candidate => candidate?.trim())?.trim()
  if (!value) throw new Error(`[GFS-OPERATOR-E2E] ${name} is required.`)
  return value
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return filesUnder(entryPath)
    return entry.isFile() ? [entryPath] : []
  })
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    return new Set(['127.0.0.1', 'localhost', '::1']).has(new URL(rawUrl).hostname)
  } catch {
    return false
  }
}

async function assertHttpReady(baseUrl: string, label: string, pathName: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}${pathName}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new Error(
      `[GFS-OPERATOR-E2E] ${label} is unavailable at ${baseUrl}${pathName}: ${(error as Error).message}`
    )
  }
  if (response.status < 200 || response.status >= 400) {
    throw new Error(
      `[GFS-OPERATOR-E2E] ${label} returned HTTP ${response.status} at ${baseUrl}${pathName}.`
    )
  }
}

function assertRepositoryHarness(): Array<{
  path: string
  sha256: string
  bytes: number
}> {
  const missing = REQUIRED_ARTIFACT_FILES.filter(filePath => !fs.existsSync(filePath))
  if (missing.length > 0) {
    throw new Error(
      `[GFS-OPERATOR-E2E] repository Electron harness is incomplete: ${missing
        .map(filePath => path.relative(REPO_ROOT, filePath))
        .join(', ')}. Build Desktop before running the suite.`
    )
  }
  const artifactFiles = [
    ...filesUnder(path.join(DESKTOP_APP_ROOT, 'dist')).filter(
      filePath =>
        !filePath.includes(`${path.sep}__tests__${path.sep}`) && !filePath.endsWith('.test.js')
    ),
    ...filesUnder(path.join(DESKTOP_APP_ROOT, 'ui-dist')).filter(
      filePath => path.basename(filePath) !== '.gitkeep'
    ),
  ].sort()
  return artifactFiles.map(filePath => ({
    path: path.relative(REPO_ROOT, filePath),
    sha256: sha256File(filePath),
    bytes: fs.statSync(filePath).size,
  }))
}

export default async function globalSetup(): Promise<void> {
  const runId = requireGfsOperatorRunId()
  reserveGfsOperatorEvidenceRun(runId)
  const profile = requiredEnvironment('MINIKUBE_PROFILE', [process.env.MINIKUBE_PROFILE])
  const context = requiredEnvironment('E2E_K8S_CONTEXT', [process.env.E2E_K8S_CONTEXT])
  if (profile !== context) {
    throw new Error(
      `[GFS-OPERATOR-E2E] MINIKUBE_PROFILE=${profile} must equal E2E_K8S_CONTEXT=${context}.`
    )
  }
  if (!/^clerum-.+-[0-9a-f]{7,8}$/.test(context)) {
    throw new Error(`[GFS-OPERATOR-E2E] context=${context} is not a branch-owned profile name.`)
  }
  const selectedContext = command('kubectl', [
    '--context',
    context,
    'config',
    'view',
    '--minify',
    '-o',
    'jsonpath={.contexts[0].name}',
  ])
  if (selectedContext !== context) {
    throw new Error(
      `[GFS-OPERATOR-E2E] explicit kubectl context resolved to ${selectedContext}; expected ${context}.`
    )
  }

  const head = command('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'])
  const branch = command('git', ['-C', REPO_ROOT, 'branch', '--show-current'])
  const originDev = command('git', ['-C', REPO_ROOT, 'rev-parse', 'origin/dev'])
  const dirty = command('git', [
    '-C',
    REPO_ROOT,
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ])
  if (dirty) {
    throw new Error(
      '[GFS-OPERATOR-E2E] exact-HEAD evidence requires a clean worktree. Commit the intended implementation before the runtime gate.'
    )
  }
  if (!branch) {
    throw new Error('[GFS-OPERATOR-E2E] detached HEAD is not accepted for this branch-owned lane.')
  }

  const marker = JSON.parse(
    command('kubectl', [
      '--context',
      context,
      '-n',
      'control-plane',
      'get',
      'configmap',
      'clerum-pre-gate-sync-state',
      '-o',
      'json',
    ])
  ) as { data?: Record<string, string> }
  const markerData = marker.data ?? {}
  const worktreeId = createHash('sha1').update(REPO_ROOT).digest('hex')
  if (
    markerData.gitHead !== head ||
    markerData.worktreeId !== worktreeId ||
    !markerData.clusterFingerprint
  ) {
    throw new Error(
      '[GFS-OPERATOR-E2E] branch profile marker does not match this exact worktree/HEAD: ' +
        `markerHead=${markerData.gitHead ?? '<missing>'} markerWorktree=${markerData.worktreeId ?? '<missing>'} ` +
        `expectedHead=${head} expectedWorktree=${worktreeId}.`
    )
  }
  const expectedFingerprint = process.env.E2E_EXPECTED_CLUSTER_FINGERPRINT?.trim()
  if (expectedFingerprint && markerData.clusterFingerprint !== expectedFingerprint) {
    throw new Error(
      `[GFS-OPERATOR-E2E] cluster fingerprint ${markerData.clusterFingerprint} does not match E2E_EXPECTED_CLUSTER_FINGERPRINT=${expectedFingerprint}.`
    )
  }

  const controlUi = requiredEnvironment('CONTROL_UI_BASE_URL', [
    process.env.CONTROL_UI_BASE_URL,
    process.env.CONTROL_UI_URL,
  ])
  const controlApi = requiredEnvironment('CONTROL_API_BASE_URL', [
    process.env.CONTROL_API_BASE_URL,
    process.env.CONTROL_API_URL,
    process.env.E2E_CONTROL_API_URL,
  ])
  const externalRest = requiredEnvironment('EXTERNAL_REST_API_BASE_URL', [
    process.env.EXTERNAL_REST_API_BASE_URL,
    process.env.EXTERNAL_REST_API_URL,
    process.env.E2E_EXTERNAL_REST_API_URL,
  ])
  const rpcProxy = requiredEnvironment('RPC_PROXY_BASE_URL', [
    process.env.RPC_PROXY_BASE_URL,
    process.env.RPC_PROXY_URL,
    process.env.E2E_RPC_PROXY_URL,
  ])
  validateBaseUrls({
    expectedContext: context,
    controlUiUrl: controlUi,
    controlApiUrl: controlApi,
    externalRestUrl: externalRest,
    rpcProxyUrl: rpcProxy,
    allowDevPortForward: false,
  })
  for (const [name, value] of Object.entries({ controlUi, controlApi, externalRest, rpcProxy })) {
    if (!isLoopbackUrl(value)) {
      throw new Error(`[GFS-OPERATOR-E2E] ${name} must use its branch-owned loopback forward.`)
    }
  }

  await Promise.all([
    assertHttpReady(controlUi, 'control-ui', '/'),
    assertHttpReady(controlApi, 'control-api', '/health'),
    assertHttpReady(externalRest, 'external-rest-api', '/health'),
    assertHttpReady(rpcProxy, 'rpc-proxy', '/health'),
  ])

  const artifactFiles = assertRepositoryHarness()
  const artifactFingerprint = createHash('sha256')
    .update(JSON.stringify(artifactFiles.map(file => [file.path, file.sha256, file.bytes])))
    .digest('hex')
  writeJsonAtomically(gfsOperatorRuntimeEvidencePath(runId), {
    schemaVersion: 1,
    suite: 'gfs-desktop-operator-parity',
    runId,
    capturedAt: new Date().toISOString(),
    repository: {
      root: REPO_ROOT,
      branch,
      head,
      originDev,
      clean: true,
      worktreeId,
    },
    runtime: {
      minikubeProfile: profile,
      kubernetesContext: context,
      clusterFingerprint: markerData.clusterFingerprint,
      markerGitHead: markerData.gitHead,
      markerWorktreeId: markerData.worktreeId,
      urls: { controlUi, controlApi, externalRest, rpcProxy },
    },
    artifact: {
      kind: 'repository-electron-harness',
      fingerprintSha256: artifactFingerprint,
      files: artifactFiles,
    },
    bootstrap: {
      entryPoint: GFS_OPERATOR_SETUP_PATH,
      expectedStatus: 200,
      singleUse: true,
      positiveUiEvidence: false,
    },
  })
}
