type WatchCallback = (phase: string, apiObj: unknown) => void
type DoneCallback = (err: Error | null) => void

/**
 * The response stream of one fake watch. client-node 1.4.0 attaches its line
 * listeners and returns; what the apiserver writes on the stream (the replay,
 * then live events, then the end of the stream) reaches the caller after
 * watch() resolved, in the order it was written. The returned `cb` and `done`
 * write to the stream: every write is held until the stream opens, three
 * microtask hops after watch() was called, by which time the caller's await
 * has resumed; held writes are then delivered in order, and a write made after
 * the stream opened is delivered at once.
 */
export function fakeWatchStream(
  cb: WatchCallback,
  done: DoneCallback
): { cb: WatchCallback; done: DoneCallback } {
  const held: Array<() => void> = []
  let open = false
  const write = (deliver: () => void) => {
    if (open) deliver()
    else held.push(deliver)
  }
  void (async () => {
    for (let hop = 0; hop < 3; hop++) await Promise.resolve()
    // A callback may write again while the held writes are delivered; that
    // write joins the end of the list.
    for (let next = 0; next < held.length; next++) held[next]()
    open = true
  })()
  return {
    cb: (phase, apiObj) => write(() => cb(phase, apiObj)),
    done: err => write(() => done(err)),
  }
}
