/**
 * Cluster-backed artifact E2E for PR #91.
 *
 * This is intentionally broader than a happy-path smoke test. The PR changes a
 * security boundary around files leaving mcp-host, so the suite proves the
 * deployed chain across direct mcp-host runtime, rpc-proxy, external-rest-api
 * RPC token issuance, and control-api K8s exec.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { KUBE_CONTEXT, mcpHostExec } from '../helpers.js'
import {
  CONTROL_API_URL,
  MCP_HOST_URL,
  RPC_PROXY_URL,
  bearer,
  fetchJson,
  isServiceUp,
  postJson,
} from '../integration/helpers.integration.js'
import { E2E_TEST_HOST_REF } from '../testUser.js'
import { generateClusterJwt, issueRealRpcToken } from './runtimeAuth.js'

type ArtifactListResponse = {
  artifacts?: Array<{ name?: string; sizeBytes?: number; format?: string }>
}

const HOST_REF = E2E_TEST_HOST_REF
const RUN_ID = `e2e-pr91-${Date.now()}`
const SAFE_ARTIFACT = `${RUN_ID}-report.txt`
const SECRET_ARTIFACT = `${RUN_ID}-secret.txt`
const BINARY_SECRET_ARTIFACT = `${RUN_ID}-binary-secret.pdf`
const SPACED_ARTIFACT = `${RUN_ID}-report final.txt`
const SYMLINK_ARTIFACT = `${RUN_ID}-symlink.txt`
const DIRECTORY_ARTIFACT = `${RUN_ID}-directory.txt`
const HUGE_ARTIFACT = `${RUN_ID}-huge.bin`
const INTERNAL_STATE_ARTIFACT = '.clerum-state'
const ARTIFACT_BODY = `pr91 artifact payload ${RUN_ID}\n`
const SECRET_KEY = 'E2E_PR91_ARTIFACT_SECRET'
const SECRET_VALUE = `clerum-e2e-secret-${RUN_ID}`
const SECRET_BODY = `safe prefix ${SECRET_VALUE} safe suffix\n`
const BINARY_SECRET_BODY = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'utf-8'),
  Buffer.from([0x00, 0xff, 0x80]),
  Buffer.from(`${SECRET_VALUE}\n%%EOF`, 'utf-8'),
])
const SPACED_BODY = `spaced artifact payload ${RUN_ID}\n`
const OUTPUT_DIR = '/tmp/clerum-output'
const WRONG_HOST_REF = HOST_REF === 'not-chatllm' ? 'not-chatllm-alt' : 'not-chatllm'
// This suite targets the direct mcp-host artifact boundary, not the rpc-proxy
// broker limit. Keep aligned with mcp-host/src/workflow/artifactPaths.ts.
const MCP_HOST_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

let adminToken = ''
let rpcToken = ''
let missingTaskScopeToken = ''
let wrongHostRefRuntimeToken = ''
let fixturesPrepared = false
let hostEnvSecretExisted = false
let previousSecretValueB64: string | null = null

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function kctl(args: string[], input?: string): string {
  return execFileSync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
    encoding: 'utf-8',
    input,
    timeout: 20_000,
  }).trim()
}

function hostEnvSecretName(): string {
  return `host-${HOST_REF}-env-secret`
}

function requireMcpHostAuthHeader(): Record<string, string> {
  const token = process.env.MCP_HOST_AUTH_TOKEN
  if (!token) {
    throw new Error(
      'MCP_HOST_AUTH_TOKEN is required. Run this spec through scripts/e2e/run-vitest-e2e.sh.'
    )
  }
  return bearer(token)
}

async function fetchText(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(url, { headers })
  return { status: res.status, text: await res.text(), headers: res.headers }
}

async function fetchBytes(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; buffer: Buffer; headers: Headers }> {
  const res = await fetch(url, { headers })
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers }
}

async function loginAdmin(): Promise<string> {
  const username = process.env.TEST_ADMIN_USERNAME ?? 'admin'
  const password = process.env.TEST_ADMIN_PASSWORD ?? 'changeme123!'
  const { status, data } = await postJson<{ token?: string }>(
    `${CONTROL_API_URL}/api/v1/admin/auth/login`,
    { username, password }
  )
  if (status !== 200 || !data.token) {
    throw new Error(`Admin login failed for artifact E2E (HTTP ${status})`)
  }
  return data.token
}

function upsertSyntheticHostSecret(): void {
  const secretName = hostEnvSecretName()
  let existing: { metadata?: { name?: string }; data?: Record<string, string> } | null = null
  const existingRaw = kctl([
    'get',
    'secret',
    secretName,
    '-n',
    'mcp-host',
    '-o',
    'json',
    '--ignore-not-found',
  ])
  try {
    existing = existingRaw ? JSON.parse(existingRaw) : null
    hostEnvSecretExisted = existing?.metadata?.name === secretName
    previousSecretValueB64 = existing?.data?.[SECRET_KEY] ?? null
  } catch {
    hostEnvSecretExisted = false
    previousSecretValueB64 = null
  }

  if (!hostEnvSecretExisted) {
    kctl([
      'create',
      'secret',
      'generic',
      secretName,
      '-n',
      'mcp-host',
      `--from-literal=${SECRET_KEY}=${SECRET_VALUE}`,
    ])
    return
  }

  kctl([
    'patch',
    'secret',
    secretName,
    '-n',
    'mcp-host',
    '--type',
    'merge',
    '-p',
    JSON.stringify({
      data: {
        [SECRET_KEY]: Buffer.from(SECRET_VALUE, 'utf-8').toString('base64'),
      },
    }),
  ])
}

function restoreSyntheticHostSecret(): void {
  const secretName = hostEnvSecretName()
  try {
    if (!hostEnvSecretExisted) {
      kctl(['delete', 'secret', secretName, '-n', 'mcp-host', '--ignore-not-found=true'])
      return
    }

    if (previousSecretValueB64 === null) {
      kctl([
        'patch',
        'secret',
        secretName,
        '-n',
        'mcp-host',
        '--type',
        'json',
        '-p',
        JSON.stringify([{ op: 'remove', path: `/data/${SECRET_KEY}` }]),
      ])
      return
    }

    kctl([
      'patch',
      'secret',
      secretName,
      '-n',
      'mcp-host',
      '--type',
      'merge',
      '-p',
      JSON.stringify({ data: { [SECRET_KEY]: previousSecretValueB64 } }),
    ])
  } catch {
    // Cleanup should not hide the real test result.
  }
}

function writeRuntimeFile(filename: string, body: string): void {
  mcpHostExec(`printf %s ${shellQuote(body)} > ${shellQuote(`${OUTPUT_DIR}/${filename}`)}`)
}

function writeRuntimeBinaryFile(filename: string, body: Buffer): void {
  mcpHostExec(
    [
      'node',
      '-e',
      shellQuote(
        "require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'))"
      ),
      shellQuote(`${OUTPUT_DIR}/${filename}`),
      shellQuote(body.toString('base64')),
    ].join(' ')
  )
}

function prepareArtifactFixtures(): void {
  upsertSyntheticHostSecret()
  mcpHostExec(`mkdir -p ${shellQuote(OUTPUT_DIR)}`)
  mcpHostExec(
    `for path in ${shellQuote(OUTPUT_DIR)}/e2e-pr91-*; do [ -e "$path" ] || continue; rm -rf "$path"; done`
  )
  writeRuntimeFile(SAFE_ARTIFACT, ARTIFACT_BODY)
  writeRuntimeFile(SECRET_ARTIFACT, SECRET_BODY)
  writeRuntimeBinaryFile(BINARY_SECRET_ARTIFACT, BINARY_SECRET_BODY)
  writeRuntimeFile(SPACED_ARTIFACT, SPACED_BODY)
  mcpHostExec(`ln -sf /etc/passwd ${shellQuote(`${OUTPUT_DIR}/${SYMLINK_ARTIFACT}`)}`)
  mcpHostExec(`mkdir -p ${shellQuote(`${OUTPUT_DIR}/${DIRECTORY_ARTIFACT}`)}`)
  mcpHostExec(
    [
      'node',
      '-e',
      JSON.stringify(
        [
          "const fs = require('fs')",
          `const fd = fs.openSync(${JSON.stringify(`${OUTPUT_DIR}/${HUGE_ARTIFACT}`)}, 'w')`,
          `fs.writeSync(fd, Buffer.from([0]), 0, 1, ${MCP_HOST_MAX_ARTIFACT_BYTES})`,
          'fs.closeSync(fd)',
        ].join('; ')
      ),
    ].join(' ')
  )
}

function cleanupArtifactFixtures(): void {
  try {
    mcpHostExec(
      `for path in ${shellQuote(OUTPUT_DIR)}/${RUN_ID}-*; do [ -e "$path" ] || continue; rm -rf "$path"; done`
    )
  } catch {
    // Cleanup should not hide the real test result.
  }
  restoreSyntheticHostSecret()
}

function findArtifact(body: ArtifactListResponse, artifactName: string) {
  expect(Array.isArray(body.artifacts)).toBe(true)
  return body.artifacts?.find(item => item.name === artifactName)
}

function expectArtifactListed(
  body: ArtifactListResponse,
  artifactName: string,
  expectedBytes?: number
): void {
  const artifact = findArtifact(body, artifactName)
  expect(
    artifact,
    [
      `expected artifact ${artifactName} for host ${HOST_REF}`,
      `artifacts=${JSON.stringify(body.artifacts ?? []).slice(0, 2000)}`,
    ].join(' ')
  ).toBeDefined()
  if (expectedBytes !== undefined) {
    expect(artifact?.sizeBytes).toBe(expectedBytes)
  }
}

function expectArtifactNotListed(body: ArtifactListResponse, artifactName: string): void {
  expect(Array.isArray(body.artifacts)).toBe(true)
  expect(body.artifacts?.some(item => item.name === artifactName)).toBe(false)
}

function expectSecretRedacted(download: { status: number; text: string; headers: Headers }): void {
  expect(download.status).toBe(200)
  expect(download.headers.get('x-clerum-redaction')).toBe('applied')
  if (download.text.includes(SECRET_VALUE)) {
    throw new Error('Synthetic artifact secret was not redacted before download')
  }
  if (!download.text.includes(`[REDACTED:${SECRET_KEY}]`)) {
    throw new Error('Artifact download did not include the expected redaction marker')
  }
}

async function waitForMcpHostSecretRedaction(): Promise<void> {
  const headers = requireMcpHostAuthHeader()
  let lastDownload: { status: number; text: string; headers: Headers } | null = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    lastDownload = await fetchText(
      `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(SECRET_ARTIFACT)}/download`,
      headers
    )
    if (
      lastDownload.status === 200 &&
      lastDownload.headers.get('x-clerum-redaction') === 'applied' &&
      !lastDownload.text.includes(SECRET_VALUE)
    ) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  expectSecretRedacted(lastDownload!)
}

beforeAll(async () => {
  const mcpHostUp = await isServiceUp(MCP_HOST_URL, '/v1/runtime/health')
  const rpcProxyUp = await isServiceUp(RPC_PROXY_URL)
  const controlApiUp = await isServiceUp(CONTROL_API_URL)
  if (!mcpHostUp || !rpcProxyUp || !controlApiUp) {
    throw new Error(
      [
        'Artifact E2E requires the deployed minikube stack and held port-forwards.',
        `mcp-host=${mcpHostUp} rpc-proxy=${rpcProxyUp} control-api=${controlApiUp}`,
        'Run: MINIKUBE_PROFILE=<profile> bash scripts/e2e/run-vitest-e2e.sh mcp-host/artifacts.e2e.test.ts',
      ].join(' ')
    )
  }

  fixturesPrepared = true
  prepareArtifactFixtures()
  adminToken = await loginAdmin()
  rpcToken = await issueRealRpcToken(
    ['host:status:read', 'host:activity:read', 'host:task:read'],
    [HOST_REF]
  )
  missingTaskScopeToken = await issueRealRpcToken(['host:activity:read'], [HOST_REF])
  wrongHostRefRuntimeToken = generateClusterJwt(['host:task:read'], [WRONG_HOST_REF])
  await waitForMcpHostSecretRedaction()
})

afterAll(() => {
  if (!fixturesPrepared) return
  cleanupArtifactFixtures()
})

describe('mcp-host artifact runtime boundary', () => {
  it('enforces safe listing, redaction, headers, and downloads at the runtime file boundary', async () => {
    const headers = requireMcpHostAuthHeader()
    const list = await fetchJson<ArtifactListResponse>(`${MCP_HOST_URL}/v1/runtime/artifacts`, {
      headers,
    })
    expect(list.status).toBe(200)
    expectArtifactListed(list.data, SAFE_ARTIFACT, Buffer.byteLength(ARTIFACT_BODY))
    expectArtifactListed(list.data, SECRET_ARTIFACT, Buffer.byteLength(SECRET_BODY))
    expectArtifactListed(list.data, BINARY_SECRET_ARTIFACT, BINARY_SECRET_BODY.length)
    expectArtifactListed(list.data, SPACED_ARTIFACT, Buffer.byteLength(SPACED_BODY))
    expectArtifactNotListed(list.data, SYMLINK_ARTIFACT)
    expectArtifactNotListed(list.data, DIRECTORY_ARTIFACT)
    expectArtifactNotListed(list.data, HUGE_ARTIFACT)
    expectArtifactNotListed(list.data, INTERNAL_STATE_ARTIFACT)

    const download = await fetchText(
      `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(SAFE_ARTIFACT)}/download`,
      headers
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('x-clerum-redaction')).toBe('scanned')
    expect(download.headers.get('content-type')).toContain('text/plain')
    expect(download.headers.get('content-disposition')).toContain(SAFE_ARTIFACT)
    expect(download.text).toBe(ARTIFACT_BODY)

    expectSecretRedacted(
      await fetchText(
        `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(SECRET_ARTIFACT)}/download`,
        headers
      )
    )

    const binary = await fetchBytes(
      `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(BINARY_SECRET_ARTIFACT)}/download`,
      headers
    )
    expect(binary.status).toBe(200)
    expect(binary.headers.get('x-clerum-redaction')).toBe('skipped:binary')
    expect(binary.headers.get('content-type')).toContain('application/pdf')
    expect(binary.buffer).toEqual(BINARY_SECRET_BODY)

    const spaced = await fetchText(
      `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(SPACED_ARTIFACT)}/download`,
      headers
    )
    expect(spaced.status).toBe(200)
    expect(spaced.headers.get('content-disposition')).toContain(
      SPACED_ARTIFACT.replace(/[^a-zA-Z0-9._-]/g, '_')
    )
    expect(spaced.text).toBe(SPACED_BODY)

    // The current local minikube host leaves direct mcp-host auth permissive
    // for legacy internal suites. If auth is enabled in another profile, this
    // assertion proves hostRef binding at the same runtime boundary.
    const wrongHostRef = await fetchText(
      `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(SAFE_ARTIFACT)}/download`,
      bearer(wrongHostRefRuntimeToken)
    )
    expect([200, 403]).toContain(wrongHostRef.status)
  })

  it('rejects unsafe filenames and filesystem escape attempts before bytes leave mcp-host', async () => {
    const headers = requireMcpHostAuthHeader()
    const invalidNames = ['../../etc/passwd', 'bad/name.txt', 'bad\\name.txt', 'bad\0name.txt']

    for (const name of invalidNames) {
      const res = await fetchText(
        `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(name)}/download`,
        headers
      )
      expect(res.status, `mcp-host should reject ${JSON.stringify(name)}`).toBe(400)
      expect(res.text).toContain('Invalid filename')
    }

    const symlink = await fetchText(
      `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(SYMLINK_ARTIFACT)}/download`,
      headers
    )
    expect(symlink.status).toBe(403)
    expect(symlink.text).toContain('Symlink artifacts are not allowed')

    const directory = await fetchText(
      `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(DIRECTORY_ARTIFACT)}/download`,
      headers
    )
    expect(directory.status).toBe(404)
    expect(directory.text).toContain('Artifact not found')

    const internalState = await fetchText(
      `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(
        INTERNAL_STATE_ARTIFACT
      )}/download`,
      headers
    )
    expect(internalState.status).toBe(404)

    const huge = await fetchText(
      `${MCP_HOST_URL}/v1/runtime/artifacts/${encodeURIComponent(HUGE_ARTIFACT)}/download`,
      headers
    )
    expect(huge.status).toBe(413)
    expect(huge.text).toContain('Artifact too large to download')
  })
})

describe('rpc-proxy artifact boundary', () => {
  it('uses external-rest-api-issued user RPC tokens and propagates list/download/redaction headers', async () => {
    const noToken = await fetchText(
      `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(HOST_REF)}/artifacts`,
      {}
    )
    expect(noToken.status).toBe(401)

    const missingScope = await fetchText(
      `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(HOST_REF)}/artifacts`,
      bearer(missingTaskScopeToken)
    )
    expect(missingScope.status).toBe(403)
    expect(missingScope.text).toContain('Forbidden')

    const headers = bearer(rpcToken)
    const list = await fetchJson<ArtifactListResponse>(
      `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(HOST_REF)}/artifacts`,
      { headers }
    )
    expect(list.status).toBe(200)
    expectArtifactListed(list.data, SAFE_ARTIFACT, Buffer.byteLength(ARTIFACT_BODY))
    expectArtifactListed(list.data, SECRET_ARTIFACT, Buffer.byteLength(SECRET_BODY))
    expectArtifactListed(list.data, BINARY_SECRET_ARTIFACT, BINARY_SECRET_BODY.length)

    const download = await fetchText(
      `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(
        HOST_REF
      )}/artifacts/${encodeURIComponent(SAFE_ARTIFACT)}/download`,
      headers
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('x-clerum-redaction')).toBe('scanned')
    expect(download.headers.get('content-disposition')).toContain(SAFE_ARTIFACT)
    expect(download.text).toBe(ARTIFACT_BODY)

    expectSecretRedacted(
      await fetchText(
        `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(
          HOST_REF
        )}/artifacts/${encodeURIComponent(SECRET_ARTIFACT)}/download`,
        headers
      )
    )

    const binary = await fetchBytes(
      `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(
        HOST_REF
      )}/artifacts/${encodeURIComponent(BINARY_SECRET_ARTIFACT)}/download`,
      headers
    )
    expect(binary.status).toBe(200)
    expect(binary.headers.get('x-clerum-redaction')).toBe('skipped:binary')
    expect(binary.buffer).toEqual(BINARY_SECRET_BODY)
  })

  it('rejects malformed names at the proxy and propagates mcp-host filesystem limits', async () => {
    const headers = bearer(rpcToken)
    const invalidNames = ['../../etc/passwd', 'bad/name.txt', 'bad\\name.txt', 'bad\0name.txt']

    for (const name of invalidNames) {
      const res = await fetchText(
        `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(
          HOST_REF
        )}/artifacts/${encodeURIComponent(name)}/download`,
        headers
      )
      expect([400, 404], `rpc-proxy should reject ${JSON.stringify(name)}`).toContain(res.status)
      if (res.status === 400) {
        expect(res.text).toContain('Invalid filename')
      }
    }

    const huge = await fetchText(
      `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(
        HOST_REF
      )}/artifacts/${encodeURIComponent(HUGE_ARTIFACT)}/download`,
      headers
    )
    expect(huge.status).toBe(413)
    expect(huge.text).toContain('Artifact too large to download')
  })
})

describe('control-api admin host artifact boundary', () => {
  it('lists and downloads through admin K8s exec with redaction and safe headers', async () => {
    const noToken = await fetchText(
      `${CONTROL_API_URL}/api/v1/admin/hosts/${encodeURIComponent(HOST_REF)}/artifacts`,
      {}
    )
    expect(noToken.status).toBe(401)

    const headers = bearer(adminToken)
    const list = await fetchJson<ArtifactListResponse>(
      `${CONTROL_API_URL}/api/v1/admin/hosts/${encodeURIComponent(HOST_REF)}/artifacts`,
      { headers }
    )
    expect(list.status, `control-api list body=${JSON.stringify(list.data)}`).toBe(200)
    expectArtifactListed(list.data, SAFE_ARTIFACT)
    expectArtifactListed(list.data, SECRET_ARTIFACT)
    expectArtifactListed(list.data, BINARY_SECRET_ARTIFACT)
    expectArtifactNotListed(list.data, SYMLINK_ARTIFACT)
    expectArtifactNotListed(list.data, DIRECTORY_ARTIFACT)
    expectArtifactNotListed(list.data, INTERNAL_STATE_ARTIFACT)

    const download = await fetchText(
      `${CONTROL_API_URL}/api/v1/admin/hosts/${encodeURIComponent(
        HOST_REF
      )}/artifacts/${encodeURIComponent(SAFE_ARTIFACT)}/download`,
      headers
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('x-clerum-redaction')).toBe('scanned')
    expect(download.headers.get('content-type')).toContain('text/plain')
    expect(download.headers.get('content-disposition')).toContain(SAFE_ARTIFACT)
    expect(download.text).toBe(ARTIFACT_BODY)

    expectSecretRedacted(
      await fetchText(
        `${CONTROL_API_URL}/api/v1/admin/hosts/${encodeURIComponent(
          HOST_REF
        )}/artifacts/${encodeURIComponent(SECRET_ARTIFACT)}/download`,
        headers
      )
    )

    const binary = await fetchBytes(
      `${CONTROL_API_URL}/api/v1/admin/hosts/${encodeURIComponent(
        HOST_REF
      )}/artifacts/${encodeURIComponent(BINARY_SECRET_ARTIFACT)}/download`,
      headers
    )
    expect(binary.status).toBe(200)
    expect(binary.headers.get('x-clerum-redaction')).toBe('skipped:binary')
    expect(binary.buffer).toEqual(BINARY_SECRET_BODY)
  })

  it('rejects traversal, backslash, null-byte, symlink, directory, and oversized artifacts through K8s exec', async () => {
    const headers = bearer(adminToken)
    const invalidNames = ['../../etc/passwd', 'bad/name.txt', 'bad\\name.txt', 'bad\0name.txt']

    for (const name of invalidNames) {
      const res = await fetchText(
        `${CONTROL_API_URL}/api/v1/admin/hosts/${encodeURIComponent(
          HOST_REF
        )}/artifacts/${encodeURIComponent(name)}/download`,
        headers
      )
      expect([400, 404], `control-api should reject ${JSON.stringify(name)}`).toContain(res.status)
      if (res.status === 400) {
        expect(res.text).toContain('Invalid artifact name')
      }
    }

    const symlink = await fetchText(
      `${CONTROL_API_URL}/api/v1/admin/hosts/${encodeURIComponent(
        HOST_REF
      )}/artifacts/${encodeURIComponent(SYMLINK_ARTIFACT)}/download`,
      headers
    )
    expect([403, 404], `control-api symlink body=${symlink.text}`).toContain(symlink.status)
    if (symlink.status === 403) {
      expect(symlink.text).toContain('Artifact read rejected by exec policy')
    }

    const directory = await fetchText(
      `${CONTROL_API_URL}/api/v1/admin/hosts/${encodeURIComponent(
        HOST_REF
      )}/artifacts/${encodeURIComponent(DIRECTORY_ARTIFACT)}/download`,
      headers
    )
    expect(directory.status).toBe(404)

    const huge = await fetchText(
      `${CONTROL_API_URL}/api/v1/admin/hosts/${encodeURIComponent(
        HOST_REF
      )}/artifacts/${encodeURIComponent(HUGE_ARTIFACT)}/download`,
      headers
    )
    expect(huge.status).toBe(413)
    expect(huge.text).toContain('Artifact too large to download')
  })
})
