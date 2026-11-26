import { describe, expect, it, vi } from 'vitest'
import type { GfsResourceActionId } from '../gfsResourceActions'
import { withPermissionGate } from '../gfsResourceMenuPermissionGate'
import type { GfsPermissionGatedMenuAction as GatedAction } from '../gfsResourceMenuPermissionGate'

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
        expect(withPermissionGate({ disabled: false, label: 'Action' }, id, status).disabled).toBe(
          true
        )
      }
      for (const id of BIT_INDEPENDENT) {
        expect(withPermissionGate({ disabled: false, label: 'Action' }, id, status).disabled).toBe(
          false
        )
      }
    }
  )

  it.each([undefined, 'ok'] as const)('returns the action untouched when bits are %s', status => {
    const action = { disabled: false, label: 'Rename' }
    expect(withPermissionGate(action, 'rename', status)).toBe(action)
  })

  it('leaves a submenu parent untouched so its children are gated one by one', () => {
    const action = { submenu: true, disabled: false, label: 'Share' }
    expect(withPermissionGate(action, 'share', 'pending')).toBe(action)
  })

  it('keeps every other field of a gated action', () => {
    const action = { disabled: false, label: 'Delete', color: 'danger' as const }
    expect(withPermissionGate(action, 'delete', 'pending')).toEqual({
      ...action,
      disabled: true,
      disabledReason: "Delete isn't available",
    })
  })

  it('explains a gated action with the neutral reason, keeping a reason it already had', () => {
    expect(
      withPermissionGate<GatedAction>({ disabled: false, label: 'Move to' }, 'move', 'error')
        .disabledReason
    ).toBe("Move to isn't available")
    // Disabled only by an in-flight change, it had nothing to explain yet.
    expect(
      withPermissionGate<GatedAction>({ disabled: true, label: 'Rename' }, 'rename', 'pending')
        .disabledReason
    ).toBe("Rename isn't available")
    expect(
      withPermissionGate(
        { disabled: true, label: 'Rename', disabledReason: 'Already explained' },
        'rename',
        'pending'
      ).disabledReason
    ).toBe('Already explained')
  })

  it('makes the run of a gated action inert and leaves a bit-independent run alone', () => {
    const rename = vi.fn()
    withPermissionGate(
      { disabled: false, label: 'Rename', run: rename },
      'rename',
      'pending'
    ).run?.()
    expect(rename).not.toHaveBeenCalled()
    const copyLink = vi.fn()
    withPermissionGate(
      { disabled: false, label: 'Copy link', run: copyLink },
      'copy-link',
      'pending'
    ).run?.()
    expect(copyLink).toHaveBeenCalledTimes(1)
  })
})
