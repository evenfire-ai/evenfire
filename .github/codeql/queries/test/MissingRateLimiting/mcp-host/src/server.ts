import express from 'express'
import { rateLimit } from 'express-rate-limit'
import fs from 'node:fs'

const app = express()
const limitArtifactCalls = rateLimit({ windowMs: 60_000, limit: 600 })

function runtimeEdgeGuard(_allowedServices: string[]) {
  return (req: unknown, _res: unknown, next: () => void) => {
    authorizeRequest(req)
    next()
  }
}

function authorizeRequest(_req: unknown) {
  return true
}

app.get(
  '/v1/runtime/artifacts',
  runtimeEdgeGuard(['rpc-proxy']),
  limitArtifactCalls,
  (_req, res) => {
    fs.readdirSync('/srv/artifacts')
    res.end()
  }
)

app.get(
  '/v1/runtime/artifacts/:filename/download',
  runtimeEdgeGuard(['rpc-proxy']),
  (_req, res) => {
    fs.readdirSync('/srv/artifacts')
    res.end()
  }
)

app.get('/unbounded-export', (_req, res) => {
  fs.readdirSync('/srv/exports')
  res.end()
})
