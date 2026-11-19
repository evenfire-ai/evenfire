import type { GfsWatchEvent } from '../../../../src/types.js'
import { USER_A } from '../../../../testSupport/gfsWatch/sessionTokens.js'
import { ForwardingOwner, gfsWatchBridgeFor } from './gfsWatchBridge'
import { type WatchHarnessLike, newWatchHarness } from './mainWatchHarness'

/**
 * Watch events as main's real watch client emits them to a window: the client
 * runs with the real `fetch`/`requestJson` against the fake watch server, and
 * each method returns the events one stream situation produced. A renderer test
 * delivers them through its `gfsWatch.open` listener instead of writing the
 * event objects by hand.
 */
export class GfsWatchEventSource {
  private harness!: WatchHarnessLike

  /** Logs user A in and opens the stream over `keys`, before any window listens. */
  async start(keys: string[] = []): Promise<this> {
    this.harness = await newWatchHarness()
    await this.harness.start()
    await this.harness.login(USER_A)
    if (keys.length > 0) await this.harness.subscribe(keys)
    if (this.harness.client.inspect().link.kind !== 'Ready') {
      throw new Error('the watch client did not open the stream')
    }
    const watched = this.harness.server.current()?.keys ?? new Set<string>()
    const missing = keys.filter(key => !watched.has(key))
    if (missing.length > 0) {
      throw new Error(`the watch stream does not carry ${missing.join(', ')}`)
    }
    return this
  }

  /**
   * The renderer's `window.clerum.gfsWatch`, registered on the same client as
   * another window: every event the client emits reaches it as it would in
   * production, and captured events can also be delivered by hand.
   */
  connectRenderer() {
    const owner = new ForwardingOwner(2)
    this.harness.owners.set(2, owner)
    return gfsWatchBridgeFor(this.harness.client, owner)
  }

  async stop(): Promise<void> {
    await this.harness.stop()
  }

  /** The fake watch server's origin, for suites that route `fetch` themselves. */
  get baseUrl(): string {
    return this.harness?.server.baseUrl ?? ''
  }

  private async capture(run: () => Promise<void>): Promise<GfsWatchEvent[]> {
    const owner = this.harness.owner(1)
    const from = owner.events.length
    await run()
    return structuredClone(owner.events.slice(from))
  }

  private async watch(keys: string[]): Promise<void> {
    const sent = new Set(this.harness.client.inspect().sent)
    if (keys.every(key => sent.has(key)) && this.harness.server.openStreams().length > 0) return
    await this.harness.subscribe(keys)
  }

  /** The stream opens (or reopens) over `keys`: `resync` of them and `accessChanged`. */
  async opened(keys: string[]): Promise<GfsWatchEvent[]> {
    return this.capture(() => this.harness.subscribe(keys).then(() => undefined))
  }

  /** A write to watched resources. */
  async changed(keys: string[]): Promise<GfsWatchEvent[]> {
    await this.watch(keys)
    return this.capture(async () => {
      this.harness.server.frame({ type: 'changed', keys })
      await this.harness.settle()
    })
  }

  /**
   * The server closes the stream to reauthorize after an access change, and
   * the client reopens it once its backoff elapses.
   */
  async reauthorize(keys: string[]): Promise<GfsWatchEvent[]> {
    await this.watch(keys)
    return this.capture(async () => {
      this.harness.server.frame({ type: 'stream.closing', reason: 'reauthorize' })
      await this.harness.settle()
      await this.reopen()
    })
  }

  private async reopen(): Promise<void> {
    for (
      let step = 0;
      step < 10 && this.harness.client.inspect().link.kind !== 'Ready';
      step += 1
    ) {
      await this.harness.fireNext()
    }
    if (this.harness.client.inspect().link.kind !== 'Ready') {
      throw new Error('the watch client did not reopen the stream')
    }
  }

  /** The user's accessible roots changed. */
  async rootsChanged(keys: string[] = []): Promise<GfsWatchEvent[]> {
    await this.watch(keys)
    return this.capture(async () => {
      this.harness.server.frame({ type: 'roots_changed' })
      await this.harness.settle()
    })
  }

  /** The session the stream was opened with expired. */
  async sessionExpired(keys: string[] = []): Promise<GfsWatchEvent[]> {
    await this.watch(keys)
    return this.capture(async () => {
      this.harness.server.frame({ type: 'stream.closing', reason: 'session_expired' })
      await this.harness.settle()
    })
  }
}

/** The canonical key a test resource of drive `main` is watched under. */
export function mainDriveKey(kind: 'file' | 'dir', rid: string): string {
  return `${kind}:gfs://main/${rid}`
}
