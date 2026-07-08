import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { Tool } from '../../interfaces'
import { ToolOutput } from '../../types'
import { createScreenshotAttachment } from './screenshotUtil'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const DISPLAY_ENV = { DISPLAY: ':1' }
const SCREENSHOT_PATH = '/tmp/clerum-screenshot.png'

/**
 * Whitelist pattern for valid X11 key names.
 * Allows: alphanumeric, underscore, plus (for combos like ctrl+c), period, minus.
 * Blocks: semicolons, pipes, backticks, dollar signs, quotes, spaces, parentheses.
 */
const VALID_KEY_PATTERN = /^[a-zA-Z0-9_+\-.]+$/

async function runX11(command: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, {
    env: { ...process.env, ...DISPLAY_ENV },
    timeout: 10_000,
  })
}

async function runX11File(
  file: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, {
    env: { ...process.env, ...DISPLAY_ENV },
    timeout: 10_000,
  })
}

export class DesktopScreenshotTool implements Tool {
  name() {
    return 'desktop_screenshot'
  }
  description() {
    return 'Capture a screenshot of the desktop. Optionally capture a specific region. Returns the screenshot as an image.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        region: {
          type: 'object',
          description: 'Optional region to capture',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
          required: ['x', 'y', 'w', 'h'],
        },
      },
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const region = params.region as { x: number; y: number; w: number; h: number } | undefined
      if (region) {
        const rx = Number(region.x)
        const ry = Number(region.y)
        const rw = Number(region.w)
        const rh = Number(region.h)
        if (
          !Number.isFinite(rx) ||
          !Number.isFinite(ry) ||
          !Number.isFinite(rw) ||
          !Number.isFinite(rh)
        ) {
          return {
            content: 'Invalid region: x, y, w, and h must be finite numbers',
            duration_ms: Date.now() - start,
            is_error: true,
          }
        }
        await runX11(`import -window root -crop ${rw}x${rh}+${rx}+${ry} ${SCREENSHOT_PATH}`)
      } else {
        await runX11(`scrot -o ${SCREENSHOT_PATH}`)
      }
      const attachment = await createScreenshotAttachment(SCREENSHOT_PATH, 'desktop_screenshot')
      return {
        content: 'Screenshot captured',
        duration_ms: Date.now() - start,
        is_error: false,
        attachments: [attachment],
      }
    } catch (err) {
      return {
        content: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class DesktopClickTool implements Tool {
  name() {
    return 'desktop_click'
  }
  description() {
    return 'Click at specific screen coordinates. Supports left click, right click, and double click.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'double'],
          description: 'Click type (default: left)',
        },
      },
      required: ['x', 'y'],
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    const x = Number(params.x)
    const y = Number(params.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        content: 'Invalid coordinates: x and y must be finite numbers',
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
    const button = (params.button as string) || 'left'
    try {
      // Argument array — no shell. xdotool accepts chained subcommands as separate argv entries.
      const clickArgs: string[] =
        button === 'right'
          ? ['click', '3']
          : button === 'double'
            ? ['click', '--repeat', '2', '1']
            : ['click', '1']
      await runX11File('xdotool', ['mousemove', String(x), String(y), ...clickArgs])
      return {
        content: `Clicked ${button} at (${x}, ${y})`,
        duration_ms: Date.now() - start,
        is_error: false,
      }
    } catch (err) {
      return {
        content: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class DesktopTypeTool implements Tool {
  name() {
    return 'desktop_type'
  }
  description() {
    return 'Type text using the keyboard. The text is typed character by character with a small delay.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to type' } },
      required: ['text'],
    }
  }
  requiresSanitization() {
    return true
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    const text = params.text as string
    try {
      // Use execFile with argument array to prevent shell injection.
      // --clearmodifiers prevents stuck modifier keys from interfering.
      await runX11File('xdotool', ['type', '--clearmodifiers', '--delay', '50', '--', text])
      return {
        content: `Typed ${text.length} characters`,
        duration_ms: Date.now() - start,
        is_error: false,
      }
    } catch (err) {
      return {
        content: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class DesktopKeyTool implements Tool {
  name() {
    return 'desktop_key'
  }
  description() {
    return "Press a key combination (e.g., 'ctrl+c', 'alt+tab', 'Return', 'Escape')."
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        keys: { type: 'string', description: "Key combination (e.g., 'ctrl+c', 'alt+F4')" },
      },
      required: ['keys'],
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    const keys = params.keys as string

    // Validate key names to prevent shell injection.
    // Valid: alphanumeric, +, -, _, . (covers ctrl+c, alt+F4, Return, Escape, super+d, etc.)
    if (!keys || !VALID_KEY_PATTERN.test(keys)) {
      return {
        content: `Invalid key combination: "${keys}". Only alphanumeric characters, +, -, _, and . are allowed.`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }

    try {
      await runX11File('xdotool', ['key', keys])
      return { content: `Pressed ${keys}`, duration_ms: Date.now() - start, is_error: false }
    } catch (err) {
      return {
        content: `Key press failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class DesktopMouseMoveTool implements Tool {
  name() {
    return 'desktop_mouse_move'
  }
  description() {
    return 'Move the mouse cursor to specific screen coordinates.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
      },
      required: ['x', 'y'],
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    const x = Number(params.x)
    const y = Number(params.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        content: 'Invalid coordinates: x and y must be finite numbers',
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
    try {
      await runX11File('xdotool', ['mousemove', String(x), String(y)])
      return {
        content: `Moved mouse to (${x}, ${y})`,
        duration_ms: Date.now() - start,
        is_error: false,
      }
    } catch (err) {
      return {
        content: `Mouse move failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class DesktopDragTool implements Tool {
  name() {
    return 'desktop_drag'
  }
  description() {
    return 'Drag from one position to another (click and hold, move, release).'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    const fromX = Number(params.fromX)
    const fromY = Number(params.fromY)
    const toX = Number(params.toX)
    const toY = Number(params.toY)
    if (
      !Number.isFinite(fromX) ||
      !Number.isFinite(fromY) ||
      !Number.isFinite(toX) ||
      !Number.isFinite(toY)
    ) {
      return {
        content: 'Invalid coordinates: fromX, fromY, toX, and toY must be finite numbers',
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
    try {
      await runX11File('xdotool', [
        'mousemove',
        String(fromX),
        String(fromY),
        'mousedown',
        '1',
        'mousemove',
        String(toX),
        String(toY),
        'mouseup',
        '1',
      ])
      return {
        content: `Dragged from (${fromX},${fromY}) to (${toX},${toY})`,
        duration_ms: Date.now() - start,
        is_error: false,
      }
    } catch (err) {
      return {
        content: `Drag failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}
