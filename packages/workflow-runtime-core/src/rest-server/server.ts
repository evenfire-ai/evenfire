import { timingSafeEqual } from 'node:crypto'
import * as http from 'node:http'
import type { Signal, StepPhase, WorkflowPhase } from '../config-loader/types'
import { emitLog } from '../status-reporter/logger'

/** Constant-time string comparison to prevent timing side-channel attacks on tokens. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

const MAX_BODY_BYTES = 65536
const VALID_SIGNAL_TYPES = new Set<Signal['type']>(['pause', 'resume', 'cancel', 'approval'])

export interface WorkflowStateRef {
  phase: WorkflowPhase
  steps: Record<string, { phase: StepPhase; output?: unknown }>
  workflowName: string
}

function isValidSignal(obj: unknown): obj is Signal {
  if (typeof obj !== 'object' || obj === null) return false
  const s = obj as Record<string, unknown>
  return (
    VALID_SIGNAL_TYPES.has(s.type as Signal['type']) &&
    typeof s.requestId === 'string' &&
    s.requestId.length > 0 &&
    s.requestId.length <= 128 &&
    typeof s.receivedAt === 'string'
  )
}

export function createServer(
  stateRef: WorkflowStateRef,
  onSignal?: (signal: Signal) => void,
  validateToken?: (token: string) => boolean | Promise<boolean>
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? ''

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', phase: stateRef.phase }))
      return
    }

    if (req.method === 'GET' && url === '/status') {
      // SEC-02 fix: /status exposes step outputs — require auth like /signal.
      if (validateToken) {
        const authHeader = req.headers.authorization
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
        if (!(await validateToken(token))) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          workflowName: stateRef.workflowName,
          phase: stateRef.phase,
          steps: stateRef.steps,
        })
      )
      return
    }

    if (req.method === 'POST' && url === '/api/v1/workflow/signal') {
      const authHeader = req.headers.authorization
      if (validateToken) {
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
        if (!(await validateToken(token))) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }

      let body = ''
      let bodySize = 0
      let rejected = false // prevents double-response if req.destroy() doesn't fire synchronously
      req.on('data', (chunk: Buffer) => {
        if (rejected) return
        bodySize += chunk.length
        if (bodySize > MAX_BODY_BYTES) {
          rejected = true
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Payload too large' }))
          req.destroy()
          return
        }
        body += chunk.toString()
      })
      req.on('end', () => {
        if (rejected || bodySize > MAX_BODY_BYTES) return
        try {
          const parsed = JSON.parse(body)
          if (!isValidSignal(parsed)) {
            res.writeHead(422, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid signal schema' }))
            return
          }
          onSignal?.(parsed)
          res.writeHead(202, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ accepted: true }))
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid signal body' }))
        }
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  return server
}

export async function start(server: http.Server, port = 8090): Promise<void> {
  return new Promise(resolve => {
    server.listen(port, () => {
      emitLog('info', `SDK REST server listening on :${port}`)
      resolve()
    })
  })
}

export async function stop(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      emitLog('warn', 'REST server shutdown timed out after 15s')
      resolve()
    }, 15000)

    server.close(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}
