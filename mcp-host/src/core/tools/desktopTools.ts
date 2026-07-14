import { ToolRegistry } from '../interfaces'

// Dynamic import() keeps playwright-only modules out of non-desktop environments.
// Repeated imports are cached by the module system, so no extra loader state is needed.

function warnDesktopToolLoadFailure(toolGroup: string, err: unknown): void {
  console.warn(
    `[Desktop] Failed to load ${toolGroup} tools; continuing without this optional tool group.`,
    {
      enabledFlags: {
        CLERUM_DESKTOP_X11: process.env.CLERUM_DESKTOP_X11,
        CLERUM_DESKTOP_BROWSER: process.env.CLERUM_DESKTOP_BROWSER,
      },
      error:
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : String(err),
    }
  )
}

export async function registerDesktopTools(registry: ToolRegistry): Promise<void> {
  const x11Enabled = process.env.CLERUM_DESKTOP_X11 === 'true'
  const browserEnabled = process.env.CLERUM_DESKTOP_BROWSER === 'true'

  if (!x11Enabled && !browserEnabled) {
    return
  }

  if (x11Enabled) {
    try {
      const mod = await import('./desktop/x11Tools')
      registry.register(new mod.DesktopScreenshotTool())
      registry.register(new mod.DesktopClickTool())
      registry.register(new mod.DesktopTypeTool())
      registry.register(new mod.DesktopKeyTool())
      registry.register(new mod.DesktopMouseMoveTool())
      registry.register(new mod.DesktopDragTool())
      console.log('[Desktop] X11 tools registered (6 tools)')
    } catch (err) {
      warnDesktopToolLoadFailure('X11', err)
    }
  }

  if (browserEnabled) {
    try {
      const [context, tools] = await Promise.all([
        import('./desktop/browserContext'),
        import('./desktop/browserTools'),
      ])
      const manager = context.BrowserContextManager.getInstance()
      registry.register(new tools.BrowserOpenTool(manager))
      registry.register(new tools.BrowserScreenshotTool(manager))
      registry.register(new tools.BrowserClickTool(manager))
      registry.register(new tools.BrowserTypeTool(manager))
      registry.register(new tools.BrowserNavigateTool(manager))
      registry.register(new tools.BrowserGetContentTool(manager))
      console.log('[Desktop] Browser tools registered (6 tools)')
    } catch (err) {
      warnDesktopToolLoadFailure('browser', err)
    }
  }
}
