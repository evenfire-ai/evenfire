import { afterEach, describe, expect, it, vi } from 'vitest'
import { DIAGRAM_MAX_CODE_CHARS } from '../diagramLimits.js'
import {
  DiagramRenderer,
  type DiagramSurface,
  diagramPageFor,
  parseDiagramDrawRequest,
  readDiagramDrawAnswer,
} from '../diagramRenderer.js'
import type { DiagramDrawRequest } from '../types.js'

vi.mock('electron', () => ({ BrowserWindow: class {}, session: {} }))

const REQUEST: DiagramDrawRequest = {
  code: 'flowchart LR\n  A --> B',
  theme: 'dark',
  fontFamily: 'Inter, sans-serif',
  width: 700,
}
const IMAGE = {
  ok: true,
  image: {
    src: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E',
    width: 300,
    height: 80,
    label: 'Flow',
  },
}

type FakeSurface = DiagramSurface & {
  draws: DiagramDrawRequest[]
  destroyed: boolean
  goAway: () => void
}

function fakeSurface(
  draw: (request: DiagramDrawRequest) => Promise<unknown> = async () => IMAGE,
  ready: () => Promise<void> = async () => undefined
): FakeSurface {
  const listeners: Array<() => void> = []
  const surface: FakeSurface = {
    draws: [],
    destroyed: false,
    ready,
    draw: request => {
      surface.draws.push(request)
      return draw(request)
    },
    destroy: () => {
      surface.destroyed = true
    },
    onGone: listener => {
      listeners.push(listener)
    },
    goAway: () => listeners.forEach(listener => listener()),
  }
  return surface
}

function rendererWith(surfaces: FakeSurface[], overrides: Partial<{ maxWaiting: number }> = {}) {
  const created: FakeSurface[] = []
  const renderer = new DiagramRenderer({
    createSurface: () => {
      const surface = surfaces.shift() ?? fakeSurface()
      created.push(surface)
      return surface
    },
    startTimeoutMs: 1_000,
    drawTimeoutMs: 2_000,
    idleCloseMs: 60_000,
    maxWaiting: overrides.maxWaiting ?? 8,
  })
  return { renderer, created }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DiagramRenderer', () => {
  it('draws in one hidden surface, one diagram at a time', async () => {
    let active = 0
    let maxActive = 0
    const surface = fakeSurface(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return IMAGE
    })
    const { renderer, created } = rendererWith([surface])

    const results = await Promise.all([
      renderer.draw(REQUEST),
      renderer.draw({ ...REQUEST, code: 'pie\n  "A" : 1' }),
      renderer.draw({ ...REQUEST, theme: 'light' }),
    ])

    expect(results.every(result => result.ok)).toBe(true)
    expect(maxActive).toBe(1)
    expect(created).toHaveLength(1)
    expect(surface.draws).toHaveLength(3)
  })

  it('ends a drawing that never answers, refuses that code again and draws the next in a new surface', async () => {
    vi.useFakeTimers()
    const stuck = fakeSurface(() => new Promise(() => undefined))
    const fresh = fakeSurface()
    const { renderer, created } = rendererWith([stuck, fresh])

    const first = renderer.draw(REQUEST)
    const second = renderer.draw({ ...REQUEST, code: 'pie\n  "A" : 1' })
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(first).resolves.toEqual({ ok: false, reason: 'Drawing it took too long' })
    expect(stuck.destroyed).toBe(true)
    await expect(second).resolves.toEqual(IMAGE)
    expect(created).toEqual([stuck, fresh])
    // The same code is refused at once instead of tying up the renderer again.
    await expect(renderer.draw(REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'Drawing it took too long',
    })
    expect(fresh.draws).toHaveLength(1)
  })

  it('reports a renderer that does not start in time, and starts a new one next time', async () => {
    vi.useFakeTimers()
    const silent = fakeSurface(undefined, () => new Promise(() => undefined))
    const { renderer, created } = rendererWith([silent])

    const first = renderer.draw(REQUEST)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(first).resolves.toEqual({
      ok: false,
      reason: 'The diagram renderer did not start',
      retryable: true,
    })
    expect(silent.destroyed).toBe(true)
    await expect(renderer.draw(REQUEST)).resolves.toEqual(IMAGE)
    expect(created).toHaveLength(2)
  })

  it('reports a renderer that stops mid-drawing, and draws the next one in a new surface', async () => {
    const crashing = fakeSurface(async () => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    })
    const { renderer, created } = rendererWith([crashing])

    await expect(renderer.draw(REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'The diagram renderer stopped',
      retryable: true,
    })
    expect(crashing.destroyed).toBe(true)
    await expect(renderer.draw(REQUEST)).resolves.toEqual(IMAGE)
    expect(created).toHaveLength(2)
  })

  it('closes a surface that goes away on its own and draws the next in a new one', async () => {
    const first = fakeSurface()
    const { renderer, created } = rendererWith([first])

    await renderer.draw(REQUEST)
    first.goAway()
    // Its window would otherwise stay open and keep the app running.
    await new Promise(resolve => setImmediate(resolve))
    expect(first.destroyed).toBe(true)
    await renderer.draw(REQUEST)

    expect(created).toHaveLength(2)
  })

  it('ends a drawing whose surface goes away, without blaming the code', async () => {
    vi.useFakeTimers()
    const dying = fakeSurface(() => new Promise(() => undefined))
    const { renderer, created } = rendererWith([dying])

    const first = renderer.draw(REQUEST)
    await vi.advanceTimersByTimeAsync(100)
    dying.goAway()
    await vi.advanceTimersByTimeAsync(0)

    await expect(first).resolves.toEqual({
      ok: false,
      reason: 'The diagram renderer stopped',
      retryable: true,
    })
    expect(dying.destroyed).toBe(true)
    await expect(renderer.draw(REQUEST)).resolves.toEqual(IMAGE)
    expect(created).toHaveLength(2)
  })

  it('refuses at once a request that waited behind the same code timing out', async () => {
    vi.useFakeTimers()
    const hung = fakeSurface(() => new Promise(() => undefined))
    const { renderer, created } = rendererWith([hung])
    const timedOut = { ok: false, reason: 'Drawing it took too long' }

    // The same code in both themes, the second asked for while the first hangs.
    const dark = renderer.draw(REQUEST)
    const light = renderer.draw({ ...REQUEST, theme: 'light' })
    await vi.advanceTimersByTimeAsync(2_000)

    await expect(dark).resolves.toEqual(timedOut)
    await expect(light).resolves.toEqual(timedOut)
    expect(created).toEqual([hung])
    expect(hung.draws).toHaveLength(1)
    renderer.close()
  })

  it('refuses code whose drawing ends the renderer twice, and only that code', async () => {
    vi.useFakeTimers()
    // A page whose process dies a moment after it starts drawing.
    const dyingSurface = () => {
      const surface = fakeSurface(() => {
        setTimeout(() => surface.goAway(), 5)
        return new Promise(() => undefined)
      })
      return surface
    }
    const { renderer, created } = rendererWith([dyingSurface(), dyingSurface()])
    const crashed = { ok: false, reason: 'Drawing it stopped the diagram renderer' }

    const first = renderer.draw(REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    await expect(first).resolves.toEqual({
      ok: false,
      reason: 'The diagram renderer stopped',
      retryable: true,
    })
    const second = renderer.draw(REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    await expect(second).resolves.toEqual(crashed)
    expect(created).toHaveLength(2)

    // Refused at once from now on, in either theme, without another window.
    await expect(renderer.draw(REQUEST)).resolves.toEqual(crashed)
    await expect(renderer.draw({ ...REQUEST, theme: 'light' })).resolves.toEqual(crashed)
    expect(created).toHaveLength(2)
    // Other code still draws.
    await expect(renderer.draw({ ...REQUEST, code: 'pie\n  "A" : 1' })).resolves.toEqual(IMAGE)
    expect(created).toHaveLength(3)
    renderer.close()
  })

  it('never blames the code for a window the app closed itself', async () => {
    vi.useFakeTimers()
    const { renderer, created } = rendererWith([
      fakeSurface(() => new Promise(() => undefined)),
      fakeSurface(() => new Promise(() => undefined)),
    ])

    for (let round = 0; round < 2; round += 1) {
      const drawing = renderer.draw(REQUEST)
      await vi.advanceTimersByTimeAsync(100)
      renderer.close()
      await expect(drawing).resolves.toEqual({
        ok: false,
        reason: 'The diagram renderer stopped',
        retryable: true,
      })
    }

    await expect(renderer.draw(REQUEST)).resolves.toEqual(IMAGE)
    expect(created).toHaveLength(3)
    renderer.close()
  })

  it('reports a renderer that goes away while it starts', async () => {
    vi.useFakeTimers()
    const dying = fakeSurface(undefined, () => new Promise(() => undefined))
    const { renderer } = rendererWith([dying])

    const first = renderer.draw(REQUEST)
    await vi.advanceTimersByTimeAsync(100)
    dying.goAway()
    await vi.advanceTimersByTimeAsync(0)

    await expect(first).resolves.toEqual({
      ok: false,
      reason: 'The diagram renderer did not start',
      retryable: true,
    })
    await expect(renderer.draw(REQUEST)).resolves.toEqual(IMAGE)
  })

  it('on close ends the drawing and the ones waiting without opening another surface', async () => {
    vi.useFakeTimers()
    const busy = fakeSurface(() => new Promise(() => undefined))
    const { renderer, created } = rendererWith([busy])
    const stopped = { ok: false, reason: 'The diagram renderer stopped', retryable: true }

    const drawing = renderer.draw(REQUEST)
    const waiting = [
      renderer.draw({ ...REQUEST, code: 'pie\n  "A" : 1' }),
      renderer.draw({ ...REQUEST, theme: 'light' }),
    ]
    await vi.advanceTimersByTimeAsync(100)
    renderer.close()

    await expect(drawing).resolves.toEqual(stopped)
    for (const result of waiting) await expect(result).resolves.toEqual(stopped)
    expect(busy.destroyed).toBe(true)
    expect(created).toEqual([busy])
    // No idle close is left waiting either.
    expect(vi.getTimerCount()).toBe(0)
    // The code was not to blame, and a diagram asked for later opens a new surface.
    await expect(renderer.draw(REQUEST)).resolves.toEqual(IMAGE)
    expect(created).toHaveLength(2)
  })

  it('keeps drawing after a surface that cannot be created or fails at once', async () => {
    const throwing = fakeSurface(undefined, () => {
      throw new Error('ready failed at once')
    })
    let attempts = 0
    const renderer = new DiagramRenderer({
      createSurface: () => {
        attempts += 1
        if (attempts === 1) throw new Error('No window')
        return attempts === 2 ? throwing : fakeSurface()
      },
      startTimeoutMs: 1_000,
      drawTimeoutMs: 2_000,
      idleCloseMs: 60_000,
      maxWaiting: 8,
    })
    const notStarted = {
      ok: false,
      reason: 'The diagram renderer did not start',
      retryable: true,
    }

    await expect(renderer.draw(REQUEST)).resolves.toEqual(notStarted)
    await expect(renderer.draw(REQUEST)).resolves.toEqual(notStarted)
    expect(throwing.destroyed).toBe(true)
    await expect(renderer.draw(REQUEST)).resolves.toEqual(IMAGE)
    renderer.close()
  })

  it('keeps drawing after a surface that throws while it is closed', async () => {
    const broken = fakeSurface(async () => {
      throw new Error('Render frame was disposed')
    })
    broken.destroy = () => {
      throw new Error('Object has been destroyed')
    }
    const { renderer, created } = rendererWith([broken])

    await expect(renderer.draw(REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'The diagram renderer stopped',
      retryable: true,
    })
    await expect(renderer.draw(REQUEST)).resolves.toEqual(IMAGE)
    expect(created).toHaveLength(2)
  })

  it('closes the surface when idle and when asked', async () => {
    vi.useFakeTimers()
    const first = fakeSurface()
    const second = fakeSurface()
    const { renderer } = rendererWith([first, second])

    await renderer.draw(REQUEST)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(first.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(first.destroyed).toBe(true)

    await renderer.draw(REQUEST)
    renderer.close()
    expect(second.destroyed).toBe(true)
  })

  it('refuses work beyond the waiting limit instead of queueing it', async () => {
    let release!: () => void
    const slow = fakeSurface(() => new Promise(resolve => (release = () => resolve(IMAGE))))
    const { renderer } = rendererWith([slow], { maxWaiting: 2 })

    const first = renderer.draw(REQUEST)
    const second = renderer.draw({ ...REQUEST, theme: 'light' })
    await expect(renderer.draw({ ...REQUEST, width: 500 })).resolves.toEqual({
      ok: false,
      reason: 'Too many diagrams are waiting',
      retryable: true,
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await expect(first).resolves.toEqual(IMAGE)
    await vi.waitFor(() => expect(slow.draws).toHaveLength(2))
    release()
    await expect(second).resolves.toEqual(IMAGE)
  })

  it('checks every request before it reaches the surface', async () => {
    const surface = fakeSurface()
    const { renderer, created } = rendererWith([surface])
    const invalid = { ok: false, reason: 'The diagram request is not valid' }

    for (const request of [
      null,
      'flowchart LR',
      { ...REQUEST, code: '   ' },
      { ...REQUEST, code: 'x'.repeat(DIAGRAM_MAX_CODE_CHARS + 1) },
      { ...REQUEST, theme: 'forest' },
      { ...REQUEST, width: 99 },
      { ...REQUEST, width: 4_001 },
      { ...REQUEST, width: 700.5 },
      { ...REQUEST, code: 42 },
    ]) {
      await expect(renderer.draw(request), JSON.stringify(request)).resolves.toEqual(invalid)
    }
    expect(created).toHaveLength(0)
  })
})

describe('parseDiagramDrawRequest', () => {
  it('keeps a valid request and replaces a font that could escape its CSS value', () => {
    expect(parseDiagramDrawRequest(REQUEST)).toEqual(REQUEST)
    for (const fontFamily of ['x; } body { display: none } .y {', 'a'.repeat(201), '', 7]) {
      expect(parseDiagramDrawRequest({ ...REQUEST, fontFamily })?.fontFamily).toBe('sans-serif')
    }
    expect(parseDiagramDrawRequest({ ...REQUEST, extra: 'ignored' })).toEqual(REQUEST)
  })
})

describe('readDiagramDrawAnswer', () => {
  it('keeps an image and a bounded reason', () => {
    expect(readDiagramDrawAnswer(IMAGE)).toEqual(IMAGE)
    expect(readDiagramDrawAnswer({ ok: true, image: { ...IMAGE.image, label: '  ' } })).toEqual({
      ok: true,
      image: { ...IMAGE.image, label: 'Diagram' },
    })
    expect(readDiagramDrawAnswer({ ok: false, reason: 'Parse error on line 2' })).toEqual({
      ok: false,
      reason: 'Parse error on line 2',
    })
    expect(readDiagramDrawAnswer({ ok: false, reason: 'x'.repeat(500) })).toEqual({
      ok: false,
      reason: 'x'.repeat(200),
    })
  })

  it('refuses anything that is not a drawn image', () => {
    const unreadable = { ok: false, reason: 'The drawing could not be read' }
    for (const answer of [
      undefined,
      'data:image/svg+xml;charset=utf-8,x',
      { ok: true },
      { ok: true, image: { ...IMAGE.image, src: 'https://evil.example/x.svg' } },
      { ok: true, image: { ...IMAGE.image, src: 'data:text/html,<script>1</script>' } },
      { ok: true, image: { ...IMAGE.image, width: 0 } },
      { ok: true, image: { ...IMAGE.image, height: Number.NaN } },
      { ok: true, image: { ...IMAGE.image, width: 1.5 } },
      { ok: 'true', image: IMAGE.image },
    ]) {
      expect(readDiagramDrawAnswer(answer), JSON.stringify(answer)).toEqual(unreadable)
    }
  })
})

describe('diagramPageFor', () => {
  it('serves the drawing page from the build and lets through only its own files', () => {
    const page = diagramPageFor({
      devUrl: '',
      uiDistDir: '/Applications/Evenfire.app/ui dist',
      windows: false,
    })

    expect(page.url).toBe('file:///Applications/Evenfire.app/ui%20dist/diagram.html')
    expect(page.allows('file:///Applications/Evenfire.app/ui%20dist/assets/index-abc.js')).toBe(
      true
    )
    expect(page.allows('data:image/svg+xml;charset=utf-8,x')).toBe(true)
    for (const url of [
      'file:///Applications/Evenfire.app/ui%20dist-other/x.js',
      'file:///Applications/Evenfire.app/ui%20dist/%2e%2e/x.js',
      'file:///Applications/Evenfire.app/ui%20dist',
      'file:///etc/passwd',
      'file://evil-host/share/x.png',
      'https://evil.example/x.png',
      'http://127.0.0.1:5173/diagram.html',
    ]) {
      expect(page.allows(url), url).toBe(false)
    }
  })

  it('compares Windows paths as Windows does, whatever case the URL uses', () => {
    const page = diagramPageFor({
      devUrl: '',
      uiDistDir: 'C:\\Program Files\\Evenfire\\resources\\app.asar\\ui-dist',
      windows: true,
    })

    expect(page.url).toBe(
      'file:///C:/Program%20Files/Evenfire/resources/app.asar/ui-dist/diagram.html'
    )
    for (const url of [
      'file:///C:/Program%20Files/Evenfire/resources/app.asar/ui-dist/assets/x.js',
      'file:///c:/program%20files/evenfire/resources/APP.ASAR/ui-dist/assets/x.js',
    ]) {
      expect(page.allows(url), url).toBe(true)
    }
    for (const url of [
      'file://evil-host/share/x.png',
      'file:///D:/x.js',
      'file:///C:/Program%20Files/Evenfire/resources/app.asar/ui-dist-other/x.js',
      'file:///C:/Program%20Files/Evenfire/resources/app.asar/ui-dist/%2e%2e/x.js',
      'file:///C:/Program%20Files/Evenfire/resources/app.asar/ui-dist/..%2Fx.js',
      'file:///C:/Program%20Files/Evenfire/resources/app.asar/ui-dist/a%5C..%5C..%5Cx.js',
    ]) {
      expect(page.allows(url), url).toBe(false)
    }
  })

  it('uses the dev server origin while developing', () => {
    const page = diagramPageFor({ devUrl: 'http://127.0.0.1:5173', uiDistDir: '/unused' })

    expect(page.url).toBe('http://127.0.0.1:5173/diagram.html')
    expect(page.allows('http://127.0.0.1:5173/src/diagramRenderer/index.ts')).toBe(true)
    expect(page.allows('http://127.0.0.1:51730/x')).toBe(false)
    expect(page.allows('https://evil.example/x')).toBe(false)
  })
})
