'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = parseInt(process.env.PORT || '8080', 10)
const PUBLIC = path.join(__dirname, 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function sendStatic(res, abs) {
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
      return
    }
    const ext = path.extname(abs).toLowerCase()
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
    res.end(data)
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const route = url.pathname

  // Echo all request headers — useful to confirm rpc-proxy injects
  // X-Clerum-User / X-Clerum-Recipe and strips client X-Clerum-*.
  if (route === '/api/whoami') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ headers: req.headers, method: req.method, url: req.url }, null, 2))
    return
  }

  // Same-origin 302 — proxy should rewrite the Location to live inside
  // the recipe view/* prefix.
  if (route === '/redirect-internal') {
    res.writeHead(302, { location: '/landing.html' })
    res.end()
    return
  }

  // Off-origin 302 — proxy MUST drop the Location and coerce to 200
  // (Decision 5 — off-origin redirects are not honoured in-embed).
  if (route === '/redirect-external') {
    res.writeHead(302, { location: 'https://example.com/' })
    res.end()
    return
  }

  // Sanity endpoint — confirms the upstream is reachable through the proxy.
  if (route === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }))
    return
  }

  // Static files (everything else) — confine to PUBLIC, no .. escape.
  let rel = route === '/' ? '/index.html' : route
  rel = decodeURIComponent(rel)
  // Strip any traversal attempts the path resolver might still honour.
  if (rel.includes('..')) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('Bad request')
    return
  }
  const abs = path.join(PUBLIC, rel)
  if (!abs.startsWith(PUBLIC)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('Forbidden')
    return
  }
  sendStatic(res, abs)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[harness] listening on :${PORT}`)
})
