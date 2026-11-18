import type { GfsWatchEvent, GfsWatchOwner } from '../../src/gfs/watchClient.js'

/** A renderer as the IPC layer will present it: an id, a document token and a send. */
export class FakeOwner implements GfsWatchOwner {
  events: GfsWatchEvent[] = []
  destroyed = false
  throwOnSend = false
  private docCounter = 0
  frameToken: string | null

  constructor(readonly id: number) {
    this.frameToken = this.newDocumentToken()
  }

  newDocumentToken(): string {
    return `frame-${this.id}-${++this.docCounter}`
  }

  /** A reload or navigation: a new document with a new token. */
  navigate(): string {
    this.frameToken = this.newDocumentToken()
    return this.frameToken
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  mainFrameToken(): string | null {
    return this.frameToken
  }

  send(event: GfsWatchEvent): void {
    if (this.throwOnSend) throw new Error('send failed')
    this.events.push(event)
  }

  ofType<T extends GfsWatchEvent['type']>(type: T): Extract<GfsWatchEvent, { type: T }>[] {
    return this.events.filter(e => e.type === type) as Extract<GfsWatchEvent, { type: T }>[]
  }
}
