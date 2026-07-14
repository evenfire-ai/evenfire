import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ExecOutputLimitError, K8sGateway } from '../src/k8s.js'

let capturedStdout: { destroyed: boolean; write: (chunk: Buffer) => boolean } | null = null
let capturedStderr: { destroyed: boolean } | null = null
let closeSpy: ReturnType<typeof vi.fn> | null = null

vi.mock('@kubernetes/client-node', () => ({
  Exec: vi.fn().mockImplementation(function ExecMock() {
    return {
      exec: vi.fn(async (_namespace, _podName, _containerName, _command, stdout, stderr) => {
        capturedStdout = stdout
        capturedStderr = stderr
        const conn = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
        closeSpy = vi.fn(() => conn.emit('close'))
        conn.close = closeSpy
        return conn
      }),
    }
  }),
}))

describe('K8sGateway execBytes stream lifecycle', () => {
  it('rejects with a typed limit error, destroys streams, and closes the connection on overflow', async () => {
    capturedStdout = null
    capturedStderr = null
    closeSpy = null

    const gateway = Object.create(K8sGateway.prototype) as K8sGateway
    Object.defineProperty(gateway, 'kc', { value: {} })

    const result = (
      gateway as unknown as {
        execBytes: (
          podName: string,
          namespace: string,
          containerName: string | undefined,
          command: string[],
          maxBytes: number,
          maxBytesExceededMessage: string
        ) => Promise<Buffer>
      }
    ).execBytes(
      'pod-1',
      'mcp-host',
      undefined,
      ['cat', '/tmp/clerum-output/report.md'],
      4,
      'Artifact listing too large to return'
    )

    await vi.waitFor(() => expect(capturedStdout).not.toBeNull())

    capturedStdout!.write(Buffer.alloc(5))

    await expect(result).rejects.toBeInstanceOf(ExecOutputLimitError)
    expect(capturedStdout!.destroyed).toBe(true)
    expect(capturedStderr!.destroyed).toBe(true)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})
