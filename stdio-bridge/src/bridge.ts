import {
  StdioClientTransport,
  StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import http from 'node:http'
import { BridgeConfig } from './types'

interface PendingRequest {
  resolve: (response: JSONRPCMessage) => void
  timer: ReturnType<typeof setTimeout>
}

export class StdioBridge {
  private config: BridgeConfig
  private stdioTransport: StdioClientTransport | null = null
  private httpServer: http.Server | null = null
  private initialized: boolean = false
  private restartCount: number = 0
  private shuttingDown: boolean = false
  private pending: Map<string | number, PendingRequest> = new Map()

  constructor(config: BridgeConfig) {
    this.config = config
  }

  get isInitialized(): boolean {
    return this.initialized
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  async start(): Promise<void> {
    await this.spawnStdioProcess()
    await this.startHttpServer()
  }

  private async spawnStdioProcess(): Promise<void> {
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    const serverParams: StdioServerParameters = {
      command: this.config.command,
      args: this.config.args,
      env: childEnv,
      stderr: 'pipe',
    }

    this.stdioTransport = new StdioClientTransport(serverParams)

    // Capture stderr for logging (sanitized)
    const stderrStream = this.stdioTransport.stderr
    if (stderrStream) {
      stderrStream.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim()
        if (line) {
          console.error(`[stdio-bridge:stderr] ${this.sanitizeLog(line)}`)
        }
      })
    }

    // Route stdio responses back to pending HTTP requests
    this.stdioTransport.onmessage = (message: JSONRPCMessage) => {
      if ('id' in message && message.id != null) {
        const pending = this.pending.get(message.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          pending.resolve(message)
        }
      }
      // Notifications (no id) are logged but not routed back
    }

    this.stdioTransport.onclose = () => {
      console.log('[stdio-bridge] stdio process closed')
      this.initialized = false
      // Reject all pending requests
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.resolve({
          jsonrpc: '2.0',
          id: id as number,
          error: { code: -32603, message: 'stdio process closed' },
        })
      }
      this.pending.clear()
      if (!this.shuttingDown) {
        this.handleProcessExit()
      }
    }

    this.stdioTransport.onerror = err => {
      console.error(`[stdio-bridge] stdio error: ${err.message}`)
    }

    // Start the stdio transport (spawns the process)
    await this.stdioTransport.start()
    this.initialized = true
    this.restartCount = 0
    console.log(`[stdio-bridge] Process initialized: ${this.config.command}`)
  }

  private sendAndWait(message: JSONRPCMessage, timeoutMs: number = 30000): Promise<JSONRPCMessage> {
    return new Promise(resolve => {
      if (!('id' in message) || message.id == null) {
        // Notification — send fire-and-forget
        this.stdioTransport?.send(message)
        resolve({ jsonrpc: '2.0', id: 0, result: {} })
        return
      }

      const timer = setTimeout(() => {
        this.pending.delete(message.id as string | number)
        resolve({
          jsonrpc: '2.0',
          id: message.id as number,
          error: { code: -32603, message: 'Request timeout' },
        })
      }, timeoutMs)

      this.pending.set(message.id as string | number, { resolve, timer })
      this.stdioTransport?.send(message)
    })
  }

  private async startHttpServer(): Promise<void> {
    return new Promise(resolve => {
      this.httpServer = http.createServer(async (req, res) => {
        const url = req.url || '/'

        if (url === this.config.healthPath) {
          this.handleHealth(res)
          return
        }

        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        if (!this.stdioTransport || !this.initialized) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Bridge not ready' }))
          return
        }

        try {
          const body = await this.readBody(req)
          const message: JSONRPCMessage = JSON.parse(body)
          const response = await this.sendAndWait(message)

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
          })
          res.end(JSON.stringify(response))
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: {
                  code: -32700,
                  message: err instanceof Error ? err.message : 'Parse error',
                },
              })
            )
          }
        }
      })

      this.httpServer.listen(this.config.port, () => {
        console.log(`[stdio-bridge] HTTP server on port ${this.getPort()}`)
        resolve()
      })
    })
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString()))
      req.on('error', reject)
    })
  }

  private handleHealth(res: http.ServerResponse): void {
    if (this.shuttingDown) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'shutting_down' }))
      return
    }

    if (this.initialized) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'ok',
          command: this.config.command,
          restarts: this.restartCount,
        })
      )
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'not_ready' }))
    }
  }

  private async handleProcessExit(): Promise<void> {
    if (this.restartCount >= this.config.restartMax) {
      console.error(`[stdio-bridge] Max restarts (${this.config.restartMax}) reached, giving up`)
      return
    }

    this.restartCount++
    const delay = this.config.restartDelay * Math.pow(3, this.restartCount - 1)
    console.log(
      `[stdio-bridge] Restarting (${this.restartCount}/${this.config.restartMax}) in ${delay}ms`
    )

    await new Promise(r => setTimeout(r, delay))

    if (this.shuttingDown) return

    try {
      await this.spawnStdioProcess()
      console.log('[stdio-bridge] Process restarted successfully')
    } catch (err) {
      console.error(`[stdio-bridge] Restart failed: ${err instanceof Error ? err.message : err}`)
      this.handleProcessExit()
    }
  }

  getPort(): number {
    const addr = this.httpServer?.address()
    if (addr && typeof addr !== 'string') return addr.port
    return this.config.port
  }

  async stop(): Promise<void> {
    this.shuttingDown = true
    console.log('[stdio-bridge] Stopping...')

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({
        jsonrpc: '2.0',
        id: id as number,
        error: { code: -32603, message: 'Bridge shutting down' },
      })
    }
    this.pending.clear()

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>(resolve => {
        this.httpServer!.close(() => resolve())
        setTimeout(resolve, 5000)
      })
    }

    // Close stdio transport (sends close to child process stdin)
    if (this.stdioTransport) {
      const closePromise = this.stdioTransport.close()
      const timeout = new Promise<void>(resolve => setTimeout(resolve, this.config.shutdownTimeout))
      await Promise.race([closePromise, timeout])
    }

    console.log('[stdio-bridge] Stopped')
  }

  private sanitizeLog(line: string): string {
    return line
      .replace(/(?:password|token|secret|key|auth)\s*[=:]\s*\S+/gi, '$&=***')
      .substring(0, 500)
  }
}
