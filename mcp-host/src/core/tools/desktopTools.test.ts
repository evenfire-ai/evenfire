import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRegistry } from '../interfaces'

type NamedTool = { name(): string }

function mockDesktopModules(): void {
  vi.doMock('./desktop/x11Tools', () => {
    return {
      DesktopScreenshotTool: class {
        name() {
          return 'desktop_screenshot'
        }
      },
      DesktopClickTool: class {
        name() {
          return 'desktop_click'
        }
      },
      DesktopTypeTool: class {
        name() {
          return 'desktop_type'
        }
      },
      DesktopKeyTool: class {
        name() {
          return 'desktop_key'
        }
      },
      DesktopMouseMoveTool: class {
        name() {
          return 'desktop_mouse_move'
        }
      },
      DesktopDragTool: class {
        name() {
          return 'desktop_drag'
        }
      },
    }
  })

  vi.doMock('./desktop/browserContext', () => {
    return {
      BrowserContextManager: { getInstance: () => ({}) },
    }
  })

  vi.doMock('./desktop/browserTools', () => {
    return {
      BrowserOpenTool: class {
        name() {
          return 'browser_open'
        }
      },
      BrowserScreenshotTool: class {
        name() {
          return 'browser_screenshot'
        }
      },
      BrowserClickTool: class {
        name() {
          return 'browser_click'
        }
      },
      BrowserTypeTool: class {
        name() {
          return 'browser_type'
        }
      },
      BrowserNavigateTool: class {
        name() {
          return 'browser_navigate'
        }
      },
      BrowserGetContentTool: class {
        name() {
          return 'browser_get_content'
        }
      },
    }
  })
}

async function loadRegisterDesktopTools() {
  vi.resetModules()
  mockDesktopModules()
  return (await import('./desktopTools')).registerDesktopTools
}

async function loadRegisterDesktopToolsWithX11ImportFailure() {
  vi.resetModules()
  vi.doMock('./desktop/x11Tools', () => {
    throw new Error('x11 import exploded')
  })
  vi.doMock('./desktop/browserContext', () => ({
    BrowserContextManager: { getInstance: () => ({}) },
  }))
  vi.doMock('./desktop/browserTools', () => ({
    BrowserOpenTool: class {
      name() {
        return 'browser_open'
      }
    },
    BrowserScreenshotTool: class {
      name() {
        return 'browser_screenshot'
      }
    },
    BrowserClickTool: class {
      name() {
        return 'browser_click'
      }
    },
    BrowserTypeTool: class {
      name() {
        return 'browser_type'
      }
    },
    BrowserNavigateTool: class {
      name() {
        return 'browser_navigate'
      }
    },
    BrowserGetContentTool: class {
      name() {
        return 'browser_get_content'
      }
    },
  }))
  return (await import('./desktopTools')).registerDesktopTools
}

async function loadRegisterDesktopToolsWithBrowserImportFailure() {
  vi.resetModules()
  vi.doMock('./desktop/x11Tools', () => ({
    DesktopScreenshotTool: class {
      name() {
        return 'desktop_screenshot'
      }
    },
    DesktopClickTool: class {
      name() {
        return 'desktop_click'
      }
    },
    DesktopTypeTool: class {
      name() {
        return 'desktop_type'
      }
    },
    DesktopKeyTool: class {
      name() {
        return 'desktop_key'
      }
    },
    DesktopMouseMoveTool: class {
      name() {
        return 'desktop_mouse_move'
      }
    },
    DesktopDragTool: class {
      name() {
        return 'desktop_drag'
      }
    },
  }))
  vi.doMock('./desktop/browserContext', () => {
    throw new Error('browser import exploded')
  })
  vi.doMock('./desktop/browserTools', () => ({
    BrowserOpenTool: class {
      name() {
        return 'browser_open'
      }
    },
    BrowserScreenshotTool: class {
      name() {
        return 'browser_screenshot'
      }
    },
    BrowserClickTool: class {
      name() {
        return 'browser_click'
      }
    },
    BrowserTypeTool: class {
      name() {
        return 'browser_type'
      }
    },
    BrowserNavigateTool: class {
      name() {
        return 'browser_navigate'
      }
    },
    BrowserGetContentTool: class {
      name() {
        return 'browser_get_content'
      }
    },
  }))
  return (await import('./desktopTools')).registerDesktopTools
}

describe('registerDesktopTools', () => {
  let registry: ToolRegistry
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    registry = {
      get: vi.fn(),
      listDefinitions: vi.fn(),
      register: vi.fn(),
    }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
    vi.doUnmock('./desktop/x11Tools')
    vi.doUnmock('./desktop/browserContext')
    vi.doUnmock('./desktop/browserTools')
    vi.resetModules()
  })

  it('registers no tools when desktop env vars are not set', async () => {
    const registerDesktopTools = await loadRegisterDesktopTools()
    await registerDesktopTools(registry)
    expect(registry.register).not.toHaveBeenCalled()
  })

  it('registers X11 tools when CLERUM_DESKTOP_X11=true', async () => {
    process.env.CLERUM_DESKTOP_X11 = 'true'
    const registerDesktopTools = await loadRegisterDesktopTools()
    await registerDesktopTools(registry)

    const names = vi
      .mocked(registry.register)
      .mock.calls.map(([tool]) => (tool as NamedTool).name())
    expect(names).toContain('desktop_screenshot')
    expect(names).toContain('desktop_click')
    expect(names).toContain('desktop_type')
    expect(names).toContain('desktop_key')
    expect(names).toContain('desktop_mouse_move')
    expect(names).toContain('desktop_drag')
  })

  it('registers browser tools when CLERUM_DESKTOP_BROWSER=true', async () => {
    process.env.CLERUM_DESKTOP_BROWSER = 'true'
    const registerDesktopTools = await loadRegisterDesktopTools()
    await registerDesktopTools(registry)

    const names = vi
      .mocked(registry.register)
      .mock.calls.map(([tool]) => (tool as NamedTool).name())
    expect(names).toContain('browser_open')
    expect(names).toContain('browser_screenshot')
    expect(names).toContain('browser_click')
    expect(names).toContain('browser_type')
    expect(names).toContain('browser_navigate')
    expect(names).toContain('browser_get_content')
  })

  it('registers both groups when both env vars are true', async () => {
    process.env.CLERUM_DESKTOP_X11 = 'true'
    process.env.CLERUM_DESKTOP_BROWSER = 'true'
    const registerDesktopTools = await loadRegisterDesktopTools()
    await registerDesktopTools(registry)

    const callCount = vi.mocked(registry.register).mock.calls.length
    expect(callCount).toBe(12) // 6 X11 + 6 browser
  })

  it('logs diagnostics and continues with browser tools when X11 import fails', async () => {
    process.env.CLERUM_DESKTOP_X11 = 'true'
    process.env.CLERUM_DESKTOP_BROWSER = 'true'

    const registerDesktopTools = await loadRegisterDesktopToolsWithX11ImportFailure()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await registerDesktopTools(registry)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load X11 tools'),
      expect.objectContaining({
        enabledFlags: {
          CLERUM_DESKTOP_X11: 'true',
          CLERUM_DESKTOP_BROWSER: 'true',
        },
        error: expect.objectContaining({
          name: 'Error',
          message: expect.any(String),
        }),
      })
    )

    const names = vi
      .mocked(registry.register)
      .mock.calls.map(([tool]) => (tool as NamedTool).name())
    expect(names).toContain('browser_open')
    expect(names).toContain('browser_screenshot')
    expect(names).toContain('browser_click')
  })

  it('logs diagnostics and keeps X11 tools when browser imports fail', async () => {
    process.env.CLERUM_DESKTOP_X11 = 'true'
    process.env.CLERUM_DESKTOP_BROWSER = 'true'

    const registerDesktopTools = await loadRegisterDesktopToolsWithBrowserImportFailure()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await registerDesktopTools(registry)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load browser tools'),
      expect.objectContaining({
        enabledFlags: {
          CLERUM_DESKTOP_X11: 'true',
          CLERUM_DESKTOP_BROWSER: 'true',
        },
        error: expect.objectContaining({
          name: 'Error',
          message: expect.any(String),
        }),
      })
    )

    const names = vi
      .mocked(registry.register)
      .mock.calls.map(([tool]) => (tool as NamedTool).name())
    expect(names).toContain('desktop_screenshot')
    expect(names).toContain('desktop_click')
    expect(names).toContain('desktop_drag')
  })
})
