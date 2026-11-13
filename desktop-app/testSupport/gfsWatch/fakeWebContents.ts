import { EventEmitter } from 'node:events'

let nextFrame = 0

/**
 * A `webContents` double with the Electron behaviours the watch IPC depends on,
 * as verified against Electron 41/44 (the real ones are exercised by the native
 * fixture `test/native/gfs-watch-ipc.fixture.ts`):
 * - `mainFrame.frameToken` is a string that changes with every committed
 *   navigation (a reload included), and `did-navigate` is emitted after it changed;
 * - inside `render-process-gone` the main frame is disposed and reading its
 *   token throws, until the next navigation commits a new document;
 * - `destroyed` is emitted once, after `isDestroyed()` turns true.
 * Not real Electron: listener bookkeeping is Node's EventEmitter.
 */
export class FakeWebContents extends EventEmitter {
  sent: Array<{ channel: string; payload: unknown }> = []
  destroyed = false
  disposed = false
  throwOnSend = false
  private token = FakeWebContents.newToken()

  constructor(readonly id: number) {
    super()
  }

  static newToken(): string {
    nextFrame += 1
    return `frame-token-${nextFrame}`
  }

  get mainFrame(): { frameToken: string } {
    if (this.disposed)
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    return { frameToken: this.token }
  }

  /** The token of the current document, for building IPC events. */
  get currentFrameToken(): string {
    return this.token
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    if (this.throwOnSend) throw new Error('Object has been destroyed')
    this.sent.push({ channel, payload })
  }

  events(channel = 'gfsWatch:event'): unknown[] {
    return this.sent.filter(s => s.channel === channel).map(s => s.payload)
  }

  reload(): void {
    this.disposed = false
    this.token = FakeWebContents.newToken()
    this.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK')
  }

  crash(reason = 'crashed'): void {
    this.disposed = true
    this.emit('render-process-gone', {}, { reason, exitCode: 1 })
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  /** An IPC from the current document (or from a given frame token). */
  ipcEvent(frameToken: string | null = this.token, url = 'file:///app/index.html') {
    return {
      sender: this,
      senderFrame: frameToken === null ? null : { url, frameToken },
    }
  }
}
