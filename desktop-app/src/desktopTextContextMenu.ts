import { Menu, type MenuItemConstructorOptions, type WebContents, app } from 'electron'

type TextContextMenuParams = {
  editFlags: {
    canCopy: boolean
    canCut: boolean
    canPaste: boolean
  }
  isEditable: boolean
  selectionText: string
}

type TextEditingWebContents = Pick<WebContents, 'copy' | 'cut' | 'isDestroyed' | 'on' | 'paste'>

type ContextMenuEvent = {
  preventDefault(): void
}

type ContextMenuBuilder = (template: MenuItemConstructorOptions[]) => { popup(): void }

function runIfLive(webContents: TextEditingWebContents, action: 'copy' | 'cut' | 'paste'): void {
  if (webContents.isDestroyed()) return
  webContents[action]()
}

export function createTextContextMenuTemplate(
  params: TextContextMenuParams,
  webContents: TextEditingWebContents
): MenuItemConstructorOptions[] {
  const hasSelection = params.selectionText.length > 0

  if (!params.isEditable) {
    return hasSelection
      ? [
          {
            label: 'Copy',
            enabled: params.editFlags.canCopy,
            click: () => runIfLive(webContents, 'copy'),
          },
        ]
      : []
  }

  const template: MenuItemConstructorOptions[] = []
  if (hasSelection) {
    template.push(
      {
        label: 'Cut',
        enabled: params.editFlags.canCut,
        click: () => runIfLive(webContents, 'cut'),
      },
      {
        label: 'Copy',
        enabled: params.editFlags.canCopy,
        click: () => runIfLive(webContents, 'copy'),
      },
      { type: 'separator' }
    )
  }
  template.push({
    label: 'Paste',
    enabled: params.editFlags.canPaste,
    click: () => runIfLive(webContents, 'paste'),
  })
  return template
}

export function wireDesktopTextContextMenu(
  webContents: TextEditingWebContents,
  buildMenu: ContextMenuBuilder = template => Menu.buildFromTemplate(template)
): void {
  webContents.on('context-menu', (event: ContextMenuEvent, params: TextContextMenuParams) => {
    const template = createTextContextMenuTemplate(params, webContents)
    if (!template.length) return
    event.preventDefault()
    buildMenu(template).popup()
  })
}

export function installDesktopTextContextMenus(): void {
  app.on('web-contents-created', (_event, webContents) => {
    wireDesktopTextContextMenu(webContents)
  })
}
