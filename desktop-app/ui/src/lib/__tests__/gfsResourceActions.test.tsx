import { isValidElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  buildGfsResourceActions,
  getGfsMenuActions,
  getGfsToolbarActions,
} from '../gfsResourceActions'

const handler = () => vi.fn()
const allHandlers = () => ({
  refresh: handler(),
  'copy-link': handler(),
  'copy-route': handler(),
  'open-route': handler(),
  rename: handler(),
  move: handler(),
  'new-folder': handler(),
  'upload-file': handler(),
  share: handler(),
  'copy-content': handler(),
  delete: handler(),
})

describe('GFS resource action model', () => {
  it('keeps the canonical folder and file toolbar order with unique icons', () => {
    const folderActions = getGfsToolbarActions(
      buildGfsResourceActions({
        kind: 'directory',
        uri: 'gfs://main/0123456789abcdef0123456789abcdef',
        handlers: allHandlers(),
        canRename: true,
        canMove: true,
        canCreateFolder: true,
        canUpload: true,
        canShare: true,
      })
    )
    const fileActions = getGfsToolbarActions(
      buildGfsResourceActions({
        kind: 'file',
        uri: 'gfs://main/0123456789abcdef0123456789abcdef',
        handlers: allHandlers(),
        canRename: true,
        canMove: true,
        canShare: true,
        canCopyContent: true,
      })
    )

    expect(folderActions.map(action => action.label)).toEqual([
      'Refresh',
      'Copy link',
      'Copy route',
      'Open route',
      'Rename',
      'Move to',
      'New folder',
      'Upload file',
      'Share',
    ])
    expect(fileActions.map(action => action.label)).toEqual([
      'Refresh',
      'Copy link',
      'Copy route',
      'Open route',
      'Rename',
      'Move to',
      'Share',
      'Copy content',
    ])
    for (const actions of [folderActions, fileActions]) {
      const iconTypes = actions.map(action => {
        expect(isValidElement(action.icon)).toBe(true)
        return isValidElement(action.icon) ? action.icon.type : null
      })
      expect(new Set(iconTypes).size).toBe(actions.length)
      expect(actions.every(action => action.targetUri.startsWith('gfs://main/'))).toBe(true)
    }
  })

  it('omits unsupported or unauthorized operations and retains busy feedback', () => {
    const actions = buildGfsResourceActions({
      kind: 'file',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      handlers: {
        refresh: handler(),
        'copy-link': handler(),
        'copy-route': handler(),
        'open-route': handler(),
        rename: handler(),
        move: handler(),
        'new-folder': handler(),
        'upload-file': handler(),
        share: handler(),
        'copy-content': handler(),
        delete: handler(),
      },
      canRename: false,
      canMove: true,
      canCreateFolder: true,
      canUpload: true,
      canShare: false,
      canCopyContent: false,
      canDelete: false,
      mutating: true,
      refreshing: true,
    })
    const toolbarActions = getGfsToolbarActions(actions)

    expect(toolbarActions.map(action => action.id)).toEqual([
      'refresh',
      'copy-link',
      'copy-route',
      'open-route',
      'move',
      'copy-content',
    ])
    expect(toolbarActions[0]).toMatchObject({ disabled: true, loading: true })
    expect(toolbarActions.find(action => action.id === 'copy-content')).toMatchObject({
      disabled: true,
    })
    expect(actions.some(action => action.id === 'delete')).toBe(false)
  })

  it('keeps menu eligibility and replacement file execution in the shared action descriptor', () => {
    const file = new File(['replacement'], 'replacement.txt')
    const requestFileSelection = vi.fn()
    const replace = vi.fn((selectedFile, context) => {
      if (selectedFile) return
      context?.requestFileSelection?.()
    })
    const actions = buildGfsResourceActions({
      kind: 'file',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      handlers: { replace },
      canReplace: true,
    })
    const menuAction = getGfsMenuActions(actions).find(action => action.id === 'replace')

    expect(menuAction).toMatchObject({ label: 'Replace file', menu: true, toolbar: false })
    menuAction?.run(undefined, { requestFileSelection })
    expect(requestFileSelection).toHaveBeenCalledOnce()
    menuAction?.run(file)
    expect(replace).toHaveBeenCalledWith(file)
  })
})
