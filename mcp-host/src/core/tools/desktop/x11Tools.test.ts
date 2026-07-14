import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopClickTool,
  DesktopDragTool,
  DesktopKeyTool,
  DesktopMouseMoveTool,
  DesktopScreenshotTool,
  DesktopTypeTool,
} from './x11Tools'

// Mock child_process with inline factory to avoid hoisting issues
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}))

// Mock util.promisify to return the mocked functions directly
vi.mock('util', async () => {
  const { exec, execFile } = await import('child_process')
  return {
    promisify: (fn: unknown) => {
      if (fn === execFile) return execFile
      return exec
    },
  }
})

// Mock screenshot util
vi.mock('./screenshotUtil', () => ({
  createScreenshotAttachment: vi.fn().mockResolvedValue({
    id: 'att_test',
    kind: 'image',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: 'fakepng',
    sourceTool: 'desktop_screenshot',
  }),
}))

describe('X11 Desktop Tools', () => {
  let execMock: ReturnType<typeof vi.fn>
  let execFileMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const cp = await import('child_process')
    execMock = cp.exec as unknown as ReturnType<typeof vi.fn>
    execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>
    execMock.mockResolvedValue({ stdout: '', stderr: '' })
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  describe('DesktopScreenshotTool', () => {
    const tool = new DesktopScreenshotTool()

    it('has correct name and schema', () => {
      expect(tool.name()).toBe('desktop_screenshot')
      expect(tool.parametersSchema().properties).toHaveProperty('region')
    })

    it('rejects non-numeric region coordinates', async () => {
      const result = await tool.execute({ region: { x: '0; rm -rf /', y: 0, w: 100, h: 100 } })
      expect(result.is_error).toBe(true)
      expect(execMock).not.toHaveBeenCalled()
    })

    it('executes scrot command', async () => {
      const result = await tool.execute({})
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('scrot'),
        expect.objectContaining({ env: expect.objectContaining({ DISPLAY: ':1' }) })
      )
      expect(result.is_error).toBe(false)
      expect(result.attachments).toHaveLength(1)
    })

    it('requires no approval', () => {
      expect(tool.requiresApproval()).toBe(false)
    })
  })

  describe('DesktopClickTool', () => {
    const tool = new DesktopClickTool()

    it('has correct name', () => {
      expect(tool.name()).toBe('desktop_click')
    })

    it('rejects non-numeric coordinates', async () => {
      const result = await tool.execute({ x: '100; rm -rf /', y: 200 })
      expect(result.is_error).toBe(true)
      expect(execFileMock).not.toHaveBeenCalled()
    })

    it('executes xdotool mousemove + click via execFile (no shell)', async () => {
      const result = await tool.execute({ x: 100, y: 200 })
      expect(execFileMock).toHaveBeenCalledWith(
        'xdotool',
        ['mousemove', '100', '200', 'click', '1'],
        expect.objectContaining({ env: expect.objectContaining({ DISPLAY: ':1' }) })
      )
      expect(execMock).not.toHaveBeenCalled()
      expect(result.is_error).toBe(false)
    })

    it('supports right click', async () => {
      await tool.execute({ x: 100, y: 200, button: 'right' })
      expect(execFileMock).toHaveBeenCalledWith(
        'xdotool',
        expect.arrayContaining(['click', '3']),
        expect.any(Object)
      )
    })

    it('supports double click', async () => {
      await tool.execute({ x: 100, y: 200, button: 'double' })
      expect(execFileMock).toHaveBeenCalledWith(
        'xdotool',
        expect.arrayContaining(['click', '--repeat', '2', '1']),
        expect.any(Object)
      )
    })
  })

  describe('DesktopTypeTool', () => {
    const tool = new DesktopTypeTool()

    it('has correct name', () => {
      expect(tool.name()).toBe('desktop_type')
    })

    it('executes xdotool type via execFile with argument array', async () => {
      await tool.execute({ text: 'hello world' })
      expect(execFileMock).toHaveBeenCalledWith(
        'xdotool',
        ['type', '--clearmodifiers', '--delay', '50', '--', 'hello world'],
        expect.objectContaining({ env: expect.objectContaining({ DISPLAY: ':1' }) })
      )
    })

    it('prevents shell injection in text input', async () => {
      await tool.execute({ text: '$(rm -rf /)"; echo pwned' })
      // execFile is used, not exec — arguments are passed as array, not interpolated
      expect(execFileMock).toHaveBeenCalledWith(
        'xdotool',
        expect.arrayContaining(['$(rm -rf /)"; echo pwned']),
        expect.any(Object)
      )
    })
  })

  describe('DesktopKeyTool', () => {
    const tool = new DesktopKeyTool()

    it('executes xdotool key for valid key combo via execFile', async () => {
      const result = await tool.execute({ keys: 'ctrl+c' })
      expect(execFileMock).toHaveBeenCalledWith('xdotool', ['key', 'ctrl+c'], expect.any(Object))
      expect(execMock).not.toHaveBeenCalled()
      expect(result.is_error).toBe(false)
    })

    it('accepts modifier+key combos like alt+F4, super+d', async () => {
      await tool.execute({ keys: 'alt+F4' })
      expect(execFileMock).toHaveBeenCalledWith('xdotool', ['key', 'alt+F4'], expect.any(Object))
    })

    it('accepts single key names like Return, Escape, space', async () => {
      const result = await tool.execute({ keys: 'Return' })
      expect(result.is_error).toBe(false)
    })

    it('rejects invalid key names with shell metacharacters', async () => {
      const result = await tool.execute({ keys: 'ctrl+c; rm -rf /' })
      expect(result.is_error).toBe(true)
      expect(result.content).toContain('Invalid key')
      expect(execFileMock).not.toHaveBeenCalled()
    })

    it('rejects empty keys', async () => {
      const result = await tool.execute({ keys: '' })
      expect(result.is_error).toBe(true)
    })
  })

  describe('DesktopMouseMoveTool', () => {
    const tool = new DesktopMouseMoveTool()

    it('rejects non-numeric coordinates', async () => {
      const result = await tool.execute({ x: '50; rm -rf /', y: 75 })
      expect(result.is_error).toBe(true)
      expect(execFileMock).not.toHaveBeenCalled()
    })

    it('executes xdotool mousemove via execFile', async () => {
      await tool.execute({ x: 50, y: 75 })
      expect(execFileMock).toHaveBeenCalledWith(
        'xdotool',
        ['mousemove', '50', '75'],
        expect.any(Object)
      )
      expect(execMock).not.toHaveBeenCalled()
    })
  })

  describe('DesktopDragTool', () => {
    const tool = new DesktopDragTool()

    it('rejects non-numeric coordinates', async () => {
      const result = await tool.execute({ fromX: '10; rm -rf /', fromY: 20, toX: 100, toY: 200 })
      expect(result.is_error).toBe(true)
      expect(execFileMock).not.toHaveBeenCalled()
    })

    it('executes xdotool drag sequence via execFile', async () => {
      await tool.execute({ fromX: 10, fromY: 20, toX: 100, toY: 200 })
      expect(execFileMock).toHaveBeenCalledWith(
        'xdotool',
        ['mousemove', '10', '20', 'mousedown', '1', 'mousemove', '100', '200', 'mouseup', '1'],
        expect.any(Object)
      )
      expect(execMock).not.toHaveBeenCalled()
    })
  })
})
