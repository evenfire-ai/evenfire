import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
import type { SessionRow, WorkerMessage, WorkerReply } from '../protocol'

// The real worker is compiled from source into a temp dir: Node cannot load
// dbWorker.ts and its extensionless imports directly. The temp dir links the
// package's node_modules so better-sqlite3 and the logger resolve.
const MCP_HOST_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

let tmpRoot: string
let workerScript: string

function compileWorker(outDir: string): string {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(MCP_HOST_ROOT, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: d => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      },
    }
  )
  if (!config) throw new Error('tsconfig.json could not be parsed')
  const program = ts.createProgram([path.join(MCP_HOST_ROOT, 'src/db/worker/dbWorker.ts')], {
    ...config.options,
    rootDir: path.join(MCP_HOST_ROOT, 'src'),
    outDir,
    noEmit: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    incremental: false,
    composite: false,
  })
  const result = program.emit()
  if (result.emitSkipped) throw new Error('dbWorker.ts emit was skipped')
  const script = path.join(outDir, 'db', 'worker', 'dbWorker.js')
  if (!fs.existsSync(script)) throw new Error(`compiled worker missing: ${script}`)
  return script
}

function session(id: string): SessionRow {
  return {
    id,
    session_key: `u-1:rpc:agent:${id}`,
    source: 'rpc',
    user_id: 'u-1',
    team_id: null,
    channel_type: 'rpc',
    channel_id: 'agent',
    thread_id: null,
    model: null,
    model_selections: null,
    system_prompt_stable_hash: null,
    parent_session_id: null,
    started_at: Date.now() / 1000,
    ended_at: null,
    end_reason: null,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_tokens_reported: 0,
    title: null,
    state: 'idle',
    active_task_id: null,
    active_trace_context: null,
  }
}

function request(worker: Worker, msg: WorkerMessage, onReply?: () => void): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${msg.op.kind}`)), 10_000)
    const listener = (reply: WorkerReply) => {
      if (reply.id !== msg.id) return
      // Runs synchronously on delivery, before the worker can do anything
      // the main thread would observe later.
      onReply?.()
      clearTimeout(timer)
      worker.off('message', listener)
      resolve(reply)
    }
    worker.on('message', listener)
    worker.postMessage(msg)
  })
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dbworker-shutdown-'))
  fs.symlinkSync(path.join(MCP_HOST_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'))
  workerScript = compileWorker(path.join(tmpRoot, 'dist'))
}, 60_000)

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('dbWorker shutdown', () => {
  it('closes the database, removing the WAL, before it ACKs shutdown', async () => {
    const dbPath = path.join(tmpRoot, 'state.db')
    const worker = new Worker(workerScript, {
      workerData: { dbPath, checkpointEveryWrites: 1000, heartbeatMs: 60_000 },
    })
    const exited = new Promise<number>(resolve => worker.once('exit', resolve))

    const inserted = await request(worker, {
      id: 'w1',
      op: { kind: 'insert_session', payload: session('conv-shutdown') },
    })
    expect(inserted.ok).toBe(true)
    // Witness: the committed write sits in the WAL before shutdown.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true)

    let walAtAck: boolean | null = null
    const ack = await request(worker, { id: 's1', op: { kind: 'shutdown' } }, () => {
      walAtAck = fs.existsSync(`${dbPath}-wal`)
    })
    expect(ack.ok).toBe(true)
    // Closing the last connection checkpoints the WAL into state.db and
    // deletes it, so a missing WAL at ACK time means db.close() ran first.
    expect(walAtAck).toBe(false)
    await expect(exited).resolves.toBe(0)

    const reader = new Database(dbPath, { readonly: true })
    try {
      const row = reader.prepare('SELECT id FROM sessions WHERE id = ?').get('conv-shutdown')
      expect(row).toEqual({ id: 'conv-shutdown' })
    } finally {
      reader.close()
    }
  })
})
