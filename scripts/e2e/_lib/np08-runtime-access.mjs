import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

// NP-08 access-only runtime observer. This file is streamed into the mcp-host pod.
export const NP08_RUNTIME_ACCESS_ROTATION_WAIT_MS = 35_000
export const NP08_RUNTIME_ACCESS_POLL_MS = 500
export const NP08_RUNTIME_ACCESS_MIN_VALIDITY_SECONDS = 30

const DEFAULT_RUNTIME_AUTH_STATE_DIR = '/var/run/clerum/workflow-auth'
const RUNTIME_AUTH_STATE_FILE = 'approval-auth.json'
const DEFAULT_RUNTIME_PORT = 8080
const LOCAL_RUNTIME_HEALTH_PATH = '/v1/runtime/health'
const MAX_STATE_FILE_BYTES = 128 * 1024
const MAX_HEALTH_BODY_BYTES = 16 * 1024

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function strictNonEmptyString(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return null
  }
  return value
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function decodeJwtPayload(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const parts = value.split('.')
  if (parts.length !== 3 || parts[1].length === 0) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null
  } catch {
    return null
  }
}

export function decodeRuntimeAccessToken(value) {
  const payload = decodeJwtPayload(value)
  if (!payload) return null

  const hostRefs = Array.isArray(payload.hostRefs) ? payload.hostRefs : []
  // HCC runtime authority is a single-Host lineage. Rejecting additional
  // refs keeps the persisted candidate's complete binding identical to the
  // mounted identity instead of comparing only a privileged first element.
  const hostRef = hostRefs.length === 1 ? strictNonEmptyString(hostRefs[0]) : null
  const recipeNamespace = strictNonEmptyString(payload.recipeNamespace)
  const recipeName = strictNonEmptyString(payload.recipeName)
  const exp = finiteNumber(payload.exp)
  const iat = finiteNumber(payload.iat)

  if (!hostRef || !recipeNamespace || !recipeName) return null
  return {
    value,
    binding: { hostRef, recipeNamespace, recipeName },
    exp,
    iat,
  }
}

function sameBinding(left, right) {
  return (
    left.hostRef === right.hostRef &&
    left.recipeNamespace === right.recipeNamespace &&
    left.recipeName === right.recipeName
  )
}

function isFresh(candidate, nowMs, minValiditySeconds) {
  return (
    candidate?.exp !== null &&
    candidate.exp > Math.floor(nowMs / 1000) + minValiditySeconds
  )
}

function isStrictlyFresher(candidate, baseline) {
  if (!sameBinding(candidate.binding, baseline.binding)) return false

  if (baseline.iat !== null && (candidate.iat === null || candidate.iat < baseline.iat)) {
    return false
  }

  if (baseline.exp === null) return true
  if (candidate.exp === null) return false
  if (candidate.exp !== baseline.exp) return candidate.exp > baseline.exp

  if (baseline.iat === null) return candidate.iat !== null
  return candidate.iat !== null && candidate.iat > baseline.iat
}

async function readPersistedAccessCandidate(stateFilePath, readFileImpl) {
  try {
    const raw = await readFileImpl(stateFilePath, 'utf8')
    if (typeof raw !== 'string' || raw.length > MAX_STATE_FILE_BYTES) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return decodeRuntimeAccessToken(parsed.accessToken)
  } catch {
    // Atomic rotation can briefly race a read. Malformed state never becomes
    // an identity source, so the caller retains the mounted access identity.
    return null
  }
}

export function runtimeAuthStateFilePath(env = process.env) {
  const configured = strictNonEmptyString(env.MCP_HOST_RUNTIME_AUTH_STATE_DIR)
  return join(configured ?? DEFAULT_RUNTIME_AUTH_STATE_DIR, RUNTIME_AUTH_STATE_FILE)
}

export async function observeFreshRuntimeAccess({
  mountedAccessValue,
  stateFilePath = runtimeAuthStateFilePath(),
  nowMs = Date.now(),
  minValiditySeconds = NP08_RUNTIME_ACCESS_MIN_VALIDITY_SECONDS,
  readFileImpl = readFile,
}) {
  const mounted = decodeRuntimeAccessToken(mountedAccessValue)
  if (!mounted) throw new Error('runtime_access_binding_unavailable')

  const persisted = await readPersistedAccessCandidate(stateFilePath, readFileImpl)
  if (
    persisted &&
    isFresh(persisted, nowMs, minValiditySeconds) &&
    isStrictlyFresher(persisted, mounted)
  ) {
    return { ...persisted, source: 'persisted' }
  }

  if (isFresh(mounted, nowMs, minValiditySeconds)) {
    return { ...mounted, source: 'mounted' }
  }
  return null
}

export async function waitForFreshRuntimeAccess({
  mountedAccessValue,
  stateFilePath = runtimeAuthStateFilePath(),
  timeoutMs = NP08_RUNTIME_ACCESS_ROTATION_WAIT_MS,
  pollIntervalMs = NP08_RUNTIME_ACCESS_POLL_MS,
  minValiditySeconds = NP08_RUNTIME_ACCESS_MIN_VALIDITY_SECONDS,
  readFileImpl = readFile,
  now = Date.now,
  sleep = delay,
}) {
  const deadline = now() + timeoutMs
  while (true) {
    const candidate = await observeFreshRuntimeAccess({
      mountedAccessValue,
      stateFilePath,
      nowMs: now(),
      minValiditySeconds,
      readFileImpl,
    })
    if (candidate) return candidate

    const remainingMs = deadline - now()
    if (remainingMs <= 0) throw new Error('runtime_access_fresh_token_timeout')
    await sleep(Math.min(pollIntervalMs, remainingMs))
  }
}

function responseStatus(result) {
  const status = result?.response?.status ?? result?.status
  if (!Number.isInteger(status)) throw new Error('runtime_access_request_status_missing')
  return status
}

function shouldAdoptObserved(current, observed, nowMs, minValiditySeconds) {
  if (!current) return true
  if (current.value === observed.value) return true
  if (!isFresh(current, nowMs, minValiditySeconds)) return true
  return isStrictlyFresher(observed, current)
}

export async function requestWithRuntimeAccess({
  mountedAccessValue,
  stateFilePath = runtimeAuthStateFilePath(),
  currentCandidate = null,
  request,
  timeoutMs = NP08_RUNTIME_ACCESS_ROTATION_WAIT_MS,
  pollIntervalMs = NP08_RUNTIME_ACCESS_POLL_MS,
  minValiditySeconds = NP08_RUNTIME_ACCESS_MIN_VALIDITY_SECONDS,
  readFileImpl = readFile,
  now = Date.now,
  sleep = delay,
}) {
  if (typeof request !== 'function') throw new Error('runtime_access_request_missing')

  const observed = await observeFreshRuntimeAccess({
    mountedAccessValue,
    stateFilePath,
    nowMs: now(),
    minValiditySeconds,
    readFileImpl,
  })

  let candidate = currentCandidate
  if (observed && shouldAdoptObserved(candidate, observed, now(), minValiditySeconds)) {
    candidate = observed
  }
  if (!candidate || !isFresh(candidate, now(), minValiditySeconds)) {
    candidate = await waitForFreshRuntimeAccess({
      mountedAccessValue,
      stateFilePath,
      timeoutMs,
      pollIntervalMs,
      minValiditySeconds,
      readFileImpl,
      now,
      sleep,
    })
  }

  let result = await request(candidate.value)
  if (responseStatus(result) !== 401) {
    return { candidate, result, rotatedAfterUnauthorized: false }
  }

  const deadline = now() + timeoutMs
  const attemptedValues = new Set([candidate.value])
  while (true) {
    const remainingMs = deadline - now()
    if (remainingMs <= 0) throw new Error('runtime_access_rotation_timeout')
    await sleep(Math.min(pollIntervalMs, remainingMs))

    const next = await observeFreshRuntimeAccess({
      mountedAccessValue,
      stateFilePath,
      nowMs: now(),
      minValiditySeconds,
      readFileImpl,
    })
    if (
      !next ||
      attemptedValues.has(next.value) ||
      !shouldAdoptObserved(candidate, next, now(), minValiditySeconds)
    ) {
      continue
    }

    candidate = next
    attemptedValues.add(candidate.value)
    result = await request(candidate.value)
    if (responseStatus(result) !== 401) {
      return { candidate, result, rotatedAfterUnauthorized: true }
    }
  }
}

function timeoutSignal(timeoutMs) {
  return typeof globalThis.AbortSignal?.timeout === 'function'
    ? globalThis.AbortSignal.timeout(timeoutMs)
    : undefined
}

function runtimePort(env) {
  const raw = strictNonEmptyString(env.CLERUM_SERVER_PORT) ?? String(DEFAULT_RUNTIME_PORT)
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('mcp_host_runtime_port_invalid')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > 65_535) {
    throw new Error('mcp_host_runtime_port_invalid')
  }
  return value
}

function contextMapperBaseUrl(env) {
  const raw = strictNonEmptyString(env.CLERUM_CONTEXT_MAPPER_URL)
  if (!raw) throw new Error('hcc_context_mapper_url_unavailable')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('hcc_context_mapper_url_invalid')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('hcc_context_mapper_url_invalid')
  }
  return parsed.origin
}

export async function requestLocalRuntimeHealth({
  port,
  timeoutMs,
  requestFactory = httpRequest,
}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let deadline
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      callback(value)
    }
    const request = requestFactory(
      {
        hostname: '127.0.0.1',
        port,
        path: LOCAL_RUNTIME_HEALTH_PATH,
        method: 'GET',
        headers: { accept: 'application/json' },
      },
      response => {
        let bytes = 0
        const chunks = []
        response.on('data', chunk => {
          bytes += chunk.length
          if (bytes > MAX_HEALTH_BODY_BYTES) {
            request.destroy(new Error('mcp_host_runtime_health_body_too_large'))
            return
          }
          chunks.push(chunk)
        })
        response.once('end', () => {
          let body = null
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            // The caller treats a malformed body as unavailable.
          }
          finish(resolve, { status: response.statusCode, body })
        })
        response.once('aborted', () => {
          finish(reject, new Error('mcp_host_runtime_health_aborted'))
        })
        response.once('error', error => finish(reject, error))
      }
    )
    // ClientRequest#setTimeout is an inactivity timeout and can be defeated by
    // a peer that drip-feeds bytes. The gate needs a wall-clock deadline for
    // the complete local health exchange.
    deadline = setTimeout(() => {
      request.destroy(new Error('mcp_host_runtime_health_timeout'))
    }, timeoutMs)
    deadline.unref?.()
    request.once('error', error => finish(reject, error))
    request.end()
  })
}

export async function requireLocalRuntimeHealth({
  env = process.env,
  requestImpl = requestLocalRuntimeHealth,
  timeoutMs = 5_000,
} = {}) {
  let result
  try {
    result = await requestImpl({ port: runtimePort(env), timeoutMs })
  } catch {
    throw new Error('mcp_host_runtime_health_unavailable')
  }

  if (result?.status !== 200 || result?.body?.status !== 'ok') {
    throw new Error(`mcp_host_runtime_health_unavailable_http_${result?.status ?? 'unknown'}`)
  }
}

async function requestJson(fetchImpl, baseUrl, path, init = {}) {
  let response
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: timeoutSignal(10_000),
    })
  } catch {
    throw new Error('hcc_request_failed')
  }

  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = { nonJson: true }
  }
  return { response, body }
}

async function assertEventually(label, assertion, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await assertion()) return
    await delay(1_000)
  }
  throw new Error(`${label} did not converge`)
}

export async function runDeployedNp08Journey({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const mountedAccessValue = env.MCP_HOST_RUNTIME_ACCESS_TOKEN
  const workflowToken = env.MCP_HOST_WORKFLOW_CONTROL_TOKEN
  const serverA = env.NP08_SERVER_A
  const serverB = env.NP08_SERVER_B
  const serverC = env.NP08_SERVER_C
  const expectedSyntheticValue = env.NP08_EXPECTED_SYNTHETIC_VALUE
  const hccBaseUrl = contextMapperBaseUrl(env)

  if (
    !mountedAccessValue ||
    !workflowToken ||
    !serverA ||
    !serverB ||
    !serverC ||
    !expectedSyntheticValue
  ) {
    throw new Error('runtime_access_environment_unavailable')
  }

  const stateFilePath = runtimeAuthStateFilePath(env)
  let currentCandidate = await waitForFreshRuntimeAccess({
    mountedAccessValue,
    stateFilePath,
  })
  console.log(
    currentCandidate.source === 'persisted'
      ? 'PASS runtime access observed from fresher persisted Host state'
      : 'PASS runtime access is fresh in the mounted Host identity'
  )

  let rotationReported = false
  async function callAsRuntime(path, init = {}) {
    const outcome = await requestWithRuntimeAccess({
      mountedAccessValue,
      stateFilePath,
      currentCandidate,
      request: value =>
        requestJson(fetchImpl, hccBaseUrl, path, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            authorization: `Bearer ${value}`,
          },
        }),
    })
    currentCandidate = outcome.candidate
    if (outcome.rotatedAfterUnauthorized && !rotationReported) {
      rotationReported = true
      console.log('PASS runtime access advanced after an HCC authorization retry')
    }
    return outcome.result
  }

  const credentialPath = '/api/v2/hosts/self/mcpservers/credential'
  await assertEventually('same-Context inventory', async () => {
    const { response, body } = await callAsRuntime('/api/v2/hosts/self/mcpservers')
    if (response.status !== 200 || !Array.isArray(body?.servers)) return false
    const names = body.servers.map(server => server?.name)
    if (!names.includes(serverA) || names.includes(serverB)) return false
    if (
      JSON.stringify(body).includes('secretRef') ||
      JSON.stringify(body).includes(expectedSyntheticValue)
    ) {
      throw new Error('inventory_exposed_credential_material')
    }
    return true
  })
  console.log('PASS same-Context inventory is scoped and metadata-only')

  const credentialValueField = 'token'
  const positive = await callAsRuntime(credentialPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverName: serverA }),
  })
  if (
    positive.response.status !== 200 ||
    positive.body?.[credentialValueField] !== expectedSyntheticValue ||
    typeof positive.body?.credentialRevision !== 'string' ||
    positive.body.credentialRevision.length === 0
  ) {
    throw new Error(`same_context_credential_failed_http_${positive.response.status}`)
  }
  console.log('PASS same-Context credential returned the fenced synthetic value in-memory')

  for (const [label, serverName] of [
    ['cross-Context', serverB],
    ['unknown', 'np08-e2e-unknown'],
  ]) {
    const denied = await callAsRuntime(credentialPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverName }),
    })
    if (
      denied.response.status !== 404 ||
      JSON.stringify(denied.body) !== '{"error":"not_found"}'
    ) {
      throw new Error(`${label}_credential_not_opaque_404`)
    }
    if (Object.hasOwn(denied.body ?? {}, credentialValueField)) {
      throw new Error(`${label}_credential_response_contained_value`)
    }
    console.log(`PASS ${label} credential request denied without a credential response`)
  }

  const noAuth = await callAsRuntime(credentialPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverName: serverC }),
  })
  if (noAuth.response.status !== 200 || noAuth.body?.[credentialValueField] !== null) {
    throw new Error(`same_context_no_auth_failed_http_${noAuth.response.status}`)
  }
  console.log('PASS same-Context no-auth server returned an explicit null credential')

  const malformedBody = await callAsRuntime(credentialPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverName: serverA, contextRef: 'caller-supplied-context' }),
  })
  if (malformedBody.response.status !== 400 || malformedBody.body?.error !== 'bad_request') {
    throw new Error('caller_supplied_context_was_accepted')
  }
  console.log('PASS caller-supplied Context field was rejected')

  const bearer = value => ({ authorization: `Bearer ${value}` })
  for (const [label, headers] of [
    ['anonymous', {}],
    ['workflow-only', bearer(workflowToken)],
    ['malformed-bearer', bearer('not-a-jwt')],
  ]) {
    const denied = await requestJson(fetchImpl, hccBaseUrl, '/api/v2/hosts/self/mcpservers', { headers })
    if (denied.response.status !== 401 || denied.body?.error !== 'unauthorized') {
      throw new Error(`${label}_inventory_not_generic_401`)
    }
    console.log(`PASS ${label} Host inventory request rejected`)
  }

  for (const path of [
    '/api/v1/mcpservers/context/np08-e2e-context-b',
    `/api/v1/mcpservers/${serverB}/auth`,
  ]) {
    const retired = await requestJson(fetchImpl, hccBaseUrl, path)
    if (retired.response.status !== 410 || retired.body?.error !== 'gone') {
      throw new Error('legacy_route_was_not_tombstoned')
    }
  }
  console.log('PASS legacy caller-selected routes are tombstoned')
}

if (process.env.NP08_RUNTIME_ACTION === 'health') {
  await requireLocalRuntimeHealth()
  console.log('PASS local mcp-host runtime health is ready before fixture mutation')
} else if (process.env.NP08_RUNTIME_ACTION === 'journey') {
  await runDeployedNp08Journey()
}
