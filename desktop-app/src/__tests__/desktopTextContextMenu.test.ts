import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTextContextMenuTemplate,
  installDesktopTextContextMenus,
  wireDesktopTextContextMenu,
} from '../desktopTextContextMenu.js'

const electron = vi.hoisted(() => ({
  appOn: vi.fn(),
  buildFromTemplate: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { on: electron.appOn },
  Menu: { buildFromTemplate: electron.buildFromTemplate },
}))

function webContents() {
  return {
    copy: vi.fn(),
    cut: vi.fn(),
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    paste: vi.fn(),
  }
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    editFlags: { canCopy: true, canCut: true, canPaste: true },
    isEditable: false,
    selectionText: '',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Desktop text context menus', () => {
  it('offers only Copy for selected non-editable content', () => {
    const contents = webContents()
    const template = createTextContextMenuTemplate(
      params({ selectionText: 'selected conversation text' }),
      contents
    )

    expect(template.map(item => item.label ?? item.type)).toEqual(['Copy'])
    expect(template[0]?.enabled).toBe(true)
    ;(template[0]?.click as () => void)()
    expect(contents.copy).toHaveBeenCalledOnce()
    expect(contents.cut).not.toHaveBeenCalled()
    expect(contents.paste).not.toHaveBeenCalled()
  })

  it('offers Cut, Copy, and Paste for a selected editable value', () => {
    const contents = webContents()
    const template = createTextContextMenuTemplate(
      params({ isEditable: true, selectionText: 'selected input text' }),
      contents
    )

    expect(template.map(item => item.label ?? item.type)).toEqual([
      'Cut',
      'Copy',
      'separator',
      'Paste',
    ])
    ;(template[0]?.click as () => void)()
    ;(template[1]?.click as () => void)()
    ;(template[3]?.click as () => void)()
    expect(contents.cut).toHaveBeenCalledOnce()
    expect(contents.copy).toHaveBeenCalledOnce()
    expect(contents.paste).toHaveBeenCalledOnce()
  })

  it('keeps Paste available in editable controls without a selection', () => {
    const contents = webContents()
    const template = createTextContextMenuTemplate(params({ isEditable: true }), contents)

    expect(template.map(item => item.label)).toEqual(['Paste'])
    ;(template[0]?.click as () => void)()
    expect(contents.paste).toHaveBeenCalledOnce()
  })

  it('does not open a menu for unselected non-editable content', () => {
    const contents = webContents()
    const preventDefault = vi.fn()
    const popup = vi.fn()
    const buildMenu = vi.fn(() => ({ popup }))
    wireDesktopTextContextMenu(contents, buildMenu)
    const listener = contents.on.mock.calls[0]?.[1] as (
      event: { preventDefault(): void },
      input: ReturnType<typeof params>
    ) => void

    listener({ preventDefault }, params())

    expect(preventDefault).not.toHaveBeenCalled()
    expect(buildMenu).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
  })

  it('opens the source menu and performs its selected-text action', () => {
    const contents = webContents()
    const preventDefault = vi.fn()
    const popup = vi.fn()
    let builtTemplate: ReturnType<typeof createTextContextMenuTemplate> = []
    const buildMenu = vi.fn(template => {
      builtTemplate = template
      return { popup }
    })
    wireDesktopTextContextMenu(contents, buildMenu)
    const listener = contents.on.mock.calls[0]?.[1] as (
      event: { preventDefault(): void },
      input: ReturnType<typeof params>
    ) => void

    listener({ preventDefault }, params({ selectionText: 'selected app text' }))

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(popup).toHaveBeenCalledOnce()
    expect(builtTemplate.map(item => item.label)).toEqual(['Copy'])
    ;(builtTemplate[0]?.click as () => void)()
    expect(contents.copy).toHaveBeenCalledOnce()
  })

  it('wires every created host or sandbox WebContents through the app owner', () => {
    installDesktopTextContextMenus()
    expect(electron.appOn).toHaveBeenCalledWith('web-contents-created', expect.any(Function))

    const contents = webContents()
    const created = electron.appOn.mock.calls[0]?.[1] as (
      event: unknown,
      source: ReturnType<typeof webContents>
    ) => void
    created({}, contents)

    expect(contents.on).toHaveBeenCalledWith('context-menu', expect.any(Function))
  })

  it('does not execute an edit action after its source WebContents is destroyed', () => {
    const contents = webContents()
    const template = createTextContextMenuTemplate(
      params({ isEditable: true, selectionText: 'selected input text' }),
      contents
    )
    contents.isDestroyed.mockReturnValue(true)
    ;(template[0]?.click as () => void)()
    ;(template[1]?.click as () => void)()
    ;(template[3]?.click as () => void)()

    expect(contents.cut).not.toHaveBeenCalled()
    expect(contents.copy).not.toHaveBeenCalled()
    expect(contents.paste).not.toHaveBeenCalled()
  })
})
