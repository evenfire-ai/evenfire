import { describe, expect, it } from 'vitest'
import type { GfsResourceActionId } from '../gfsResourceActions'
import { withPermissionGate } from '../gfsResourceMenuPermissionGate'

const BIT_DEPENDENT: GfsResourceActionId[] = [
  'share',
  'rename',
  'move',
  'new-folder',
  'upload-file',
  'replace',
  'delete',
  'download-zip',
  'copy-content',
  'refresh',
  'open-route',
]
const BIT_INDEPENDENT: GfsResourceActionId[] = ['copy-link', 'preview', 'download', 'open-folder']

describe('withPermissionGate', () => {
  it.each(['pending', 'error'] as const)(
    'disables only bit-dependent actions while bits are %s',
    status => {
      for (const id of BIT_DEPENDENT) {
        expect(withPermissionGate({ disabled: false }, id, status).disabled).toBe(true)
      }
      for (const id of BIT_INDEPENDENT) {
        expect(withPermissionGate({ disabled: false }, id, status).disabled).toBe(false)
      }
    }
  )

  it.each([undefined, 'ok'] as const)('returns the action untouched when bits are %s', status => {
    const action = { disabled: false, label: 'Rename' }
    expect(withPermissionGate(action, 'rename', status)).toBe(action)
  })

  it('leaves a submenu parent untouched so its children are gated one by one', () => {
    const action = { submenu: true, disabled: false }
    expect(withPermissionGate(action, 'share', 'pending')).toBe(action)
  })

  it('keeps every other field of a gated action', () => {
    const action = { disabled: false, label: 'Delete', color: 'danger' as const }
    expect(withPermissionGate(action, 'delete', 'pending')).toEqual({
      ...action,
      disabled: true,
    })
  })
})
