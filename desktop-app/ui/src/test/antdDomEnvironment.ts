/** Install browser APIs Ant Design's responsive and popup primitives use in JSDOM. */
export function installAntdDomEnvironment() {
  // AntD popup alignment and motion need animation frames. JSDOM's frame loop
  // is absent or can remain idle in Vitest's non-visual environment, leaving
  // menus at their offscreen `*-prepare` position. Keep the callback async so
  // React/AntD never observe a re-entrant frame during render.
  let nextFrameId = 0
  const pendingFrames = new Map<number, FrameRequestCallback>()
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      const frameId = ++nextFrameId
      pendingFrames.set(frameId, callback)
      queueMicrotask(() => {
        const pending = pendingFrames.get(frameId)
        if (!pending) return
        pendingFrames.delete(frameId)
        pending(window.performance.now())
      })
      return frameId
    },
    writable: true,
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: (frameId: number) => pendingFrames.delete(frameId),
    writable: true,
  })

  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (media: string): MediaQueryList => ({
        matches: false,
        media,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
      writable: true,
    })
  }

  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserverMock implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
}
