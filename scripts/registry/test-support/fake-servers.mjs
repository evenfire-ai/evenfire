/**
 * Local HTTP stand-ins for the two services the seed talks to.
 *
 * - The fake registry stores rows built by control-api's registry row builder
 *   (`control-api/test/fixtures/registryEntryRow.ts`, the mirror of the registry's
 *   `createEntry` + publish validation) from the exact body the seed sends, so a
 *   stored row is never hand-written. `dropOAuth` reproduces a registry without
 *   remote-OAuth support, whose `createEntry` field list has no `oauth`.
 * - The fake control-api answers `/discover` with `discoverResponse`, whose shape is
 *   pinned against the real route by
 *   `control-api/test/seedRemoteOAuth.discoverContract.test.ts`.
 */
import { createServer } from 'node:http'
import { loadControlApiModule } from '../lib/control-api-modules.mjs'

export const CURATOR_ID = 'curator-client'
export const CURATOR_SECRET = 'curator-secret-value'
export const CURATOR_TOKEN = 'curator-access-token-value'
export const ADMIN_TOKEN = 'admin-session-token-value'

/** The `/discover` fields the seed reads, for one probe outcome and detected mode. */
export function discoverResponse({ transport = 'alive', registrationMode }) {
  return { transport: { status: transport }, detected: { registrationMode } }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, json) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(json))
}

async function listen(handler) {
  const server = createServer((req, res) => {
    handler(req, res).catch(err => send(res, 500, { error: String(err?.message ?? err) }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

let rowBuilder
export async function loadRegistryRowBuilder() {
  rowBuilder ??= await loadControlApiModule('test/fixtures/registryEntryRow.ts')
  return rowBuilder
}

/** A row as the registry would store it for `body` published by the curator client. */
export async function storedRow(body, { dropOAuth = false } = {}) {
  const { registryEntryRow } = await loadRegistryRowBuilder()
  const published = dropOAuth
    ? { ...body, mcpServer: { ...body.mcpServer, oauth: undefined } }
    : body
  return registryEntryRow(published, { kind: 'curator-machine' })
}

/**
 * `breakReread` / `breakPublish` cut the connection on that request instead of
 * answering, the way a timeout or a reset reaches `fetch`: it throws, there is no
 * status. `breakPublish` cuts it after storing the row, like a publish whose
 * response is lost on the way back.
 */
export async function startFakeRegistry({
  dropOAuth = false,
  preload = [],
  breakReread = false,
  breakPublish = false,
} = {}) {
  const rows = new Map(preload.map(row => [`${row.name}@${row.version}`, row]))
  const calls = []
  const server = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const raw = await readBody(req)
    calls.push({ method: req.method, path: url.pathname })
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const expected = `Basic ${Buffer.from(`${CURATOR_ID}:${CURATOR_SECRET}`).toString('base64')}`
      if (req.headers.authorization !== expected || raw !== 'grant_type=client_credentials') {
        return send(res, 401, { error: 'invalid_client' })
      }
      return send(res, 200, { access_token: CURATOR_TOKEN, token_type: 'Bearer' })
    }
    if (req.headers.authorization !== `Bearer ${CURATOR_TOKEN}`) {
      return send(res, 401, { error: 'UNAUTHORIZED' })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/entries') {
      const body = JSON.parse(raw)
      const key = `${body.name}@${body.version}`
      // The real registry answers 409 only after body validation and the quota
      // check, from the unique-index violation on insert. Answering it first is
      // equivalent for the seed: its bodies validate, and a reserved scope such as
      // @evenfire has no quota target (resolveQuotaTargetOrg returns null).
      if (rows.has(key)) return send(res, 409, { error: 'CONFLICT' })
      let row
      try {
        row = await storedRow(body, { dropOAuth })
      } catch (err) {
        return send(res, 400, { error: 'INVALID_INPUT', message: err.message })
      }
      rows.set(key, row)
      if (breakPublish) return req.socket.destroy()
      return send(res, 201, row)
    }
    const m = /^\/api\/v1\/entries\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && m) {
      if (breakReread) return req.socket.destroy()
      const row = rows.get(`${decodeURIComponent(m[1])}@${decodeURIComponent(m[2])}`)
      return row ? send(res, 200, row) : send(res, 404, { error: 'NOT_FOUND' })
    }
    return send(res, 404, { error: 'NOT_FOUND' })
  })
  return {
    ...server,
    rows,
    calls,
    publishes: () => calls.filter(c => c.path === '/api/v1/entries').length,
  }
}

/** `answer(baseUrl, body)` returns `{ status, json }` for each discover call. */
export async function startFakeControlApi(answer) {
  const calls = []
  const server = await listen(async (req, res) => {
    const raw = await readBody(req)
    if (req.method !== 'POST' || req.url !== '/api/v1/admin/mcp-servers/remote/discover') {
      return send(res, 404, { error: 'not found' })
    }
    if (req.headers.cookie !== `control_ui_admin_session=${ADMIN_TOKEN}`) {
      return send(res, 401, { error: 'Unauthorized' })
    }
    const body = JSON.parse(raw)
    calls.push(body)
    const { status, json } = answer(body.baseUrl, body)
    return send(res, status, json)
  })
  return { ...server, calls }
}
