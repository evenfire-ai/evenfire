import { timingSafeEqual } from 'node:crypto'
import * as http from 'node:http'
import type { StepPhase, WorkflowPhase } from '../config-loader/types'
import { emitLog } from '../status-reporter/logger'

/** Constant-time string comparison to prevent timing side-channel attacks on tokens. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export interface WorkflowStateRef {
  phase: WorkflowPhase
  steps: Record<string, { phase: StepPhase; output?: unknown }>
  workflowName: string
}

/**
 * Serves `GET /health` and `GET /status`. When `validateToken` is given,
 * `/status` requires a bearer token it accepts. Signals reach the runtime only
 * through `SignalPoller.pollSignals()`; this server has no signal route.
 */
export function createServer(
  stateRef: WorkflowStateRef,
  validateToken?: (token: string) => boolean | Promise<boolean>
): http.Server {
  // The validator now sits where the removed onSignal parameter was. A caller
  // still passing three arguments would otherwise serve /status without its
  // token check, or use the old signal callback as the validator.
  if (arguments.length > 2) {
    throw new TypeError(
      'createServer(stateRef, validateToken?) takes at most two arguments: the onSignal parameter was removed'
    )
  }
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? ''

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', phase: stateRef.phase }))
      return
    }

    if (req.method === 'GET' && url === '/status') {
      // SEC-02 fix: /status exposes step outputs, so it requires the token when a validator is given.
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
