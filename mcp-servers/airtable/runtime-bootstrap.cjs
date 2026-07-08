const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')

const ENABLE_FLAG = 'AIRTABLE_MCP_LOG_TRAFFIC'

function isEnabled() {
  const raw = (process.env[ENABLE_FLAG] || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function normalizeUrl(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (input && typeof input.url === 'string') return new URL(input.url)
  } catch {
    return null
  }
  return null
}

function formatUrl(url) {
  return `${url.origin}${url.pathname}`
}

function isAirtableRequest(url) {
  return url?.hostname === 'api.airtable.com'
}

function log(message) {
  console.log(`[airtable-mcp] ${message}`)
}

function patchServerModule(mod) {
  if (mod.__clerumTrafficLoggingPatched) return

  const originalCreateServer = mod.createServer
  mod.createServer = function patchedCreateServer(...args) {
    const server = originalCreateServer.apply(this, args)

    if (!server.__clerumTrafficLoggingHooked) {
      server.__clerumTrafficLoggingHooked = true
      server.on('request', (req, res) => {
        const start = Date.now()
        const method = req.method || 'GET'
        const path = req.url || '/'

        log(`inbound ${method} ${path}`)
        res.once('finish', () => {
          log(`inbound ${method} ${path} -> ${res.statusCode} ${Date.now() - start}ms`)
        })
      })
    }

    return server
  }

  mod.__clerumTrafficLoggingPatched = true
}

function patchFetch() {
  if (typeof globalThis.fetch !== 'function' || globalThis.fetch.__clerumTrafficLoggingPatched) {
    return
  }

  const originalFetch = globalThis.fetch

  async function patchedFetch(input, init) {
    const url = normalizeUrl(input)
    const method =
      (init && init.method) ||
      (input && typeof input === 'object' && 'method' in input && input.method) ||
      'GET'

    if (!isAirtableRequest(url)) {
      return originalFetch(input, init)
    }

    const prettyUrl = formatUrl(url)
    const start = Date.now()

    log(`outbound ${String(method).toUpperCase()} ${prettyUrl}`)

    try {
      const response = await originalFetch(input, init)
      log(
        `outbound ${String(method).toUpperCase()} ${prettyUrl} -> ${response.status} ${Date.now() - start}ms`
      )
      return response
    } catch (error) {
      const cause = error?.cause
        ? ` cause=${error.cause.code || error.cause.name || 'unknown'}:${error.cause.message || String(error.cause)}`
        : ''
      log(
        `outbound ${String(method).toUpperCase()} ${prettyUrl} -> ERROR ${Date.now() - start}ms ${error?.name || 'Error'}:${error?.message || String(error)}${cause}`
      )
      throw error
    }
  }

  patchedFetch.__clerumTrafficLoggingPatched = true
  globalThis.fetch = patchedFetch
}

if (isEnabled()) {
  log('traffic logging enabled')
  patchServerModule(http)
  patchServerModule(https)
  patchFetch()
}

module.exports = {
  isEnabled,
  patchFetch,
  patchServerModule,
}
