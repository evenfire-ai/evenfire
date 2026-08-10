import { describe, expect, it } from 'vitest'
import {
  areRequiredCredentialRowsComplete,
  reconcileCredentialRows,
} from '../registryCredentialDraft'

describe('registry credential drafts', () => {
  const schemaKeys = [
    { name: 'CLIENT_ID', label: 'Client ID' },
    { name: 'CLIENT_SECRET', label: 'Client secret' },
  ]

  it('preserves early input while adding every schema field', () => {
    expect(
      reconcileCredentialRows(
        [{ id: 'early-row', secretKey: 'CLIENT_ID', value: 'client-123' }],
        schemaKeys
      )
    ).toEqual([
      {
        id: 'early-row',
        secretKey: 'CLIENT_ID',
        value: 'client-123',
        label: 'Client ID',
      },
      {
        id: 'mcp-schema-row-1',
        secretKey: 'CLIENT_SECRET',
        value: '',
        label: 'Client secret',
      },
    ])
  })

  it('adopts a value entered before its schema key was known', () => {
    const rows = reconcileCredentialRows(
      [{ id: 'early-row', secretKey: '', value: 'client-123' }],
      schemaKeys
    )

    expect(rows[0]).toMatchObject({
      id: 'early-row',
      secretKey: 'CLIENT_ID',
      value: 'client-123',
    })
  })

  it('requires every schema key but permits additional manual keys', () => {
    const rows = [
      { id: 'client', secretKey: 'CLIENT_ID', value: 'client-123' },
      { id: 'secret', secretKey: 'CLIENT_SECRET', value: 'secret-456' },
      { id: 'extra', secretKey: 'OPTIONAL_SCOPE', value: 'read' },
    ]

    expect(areRequiredCredentialRowsComplete(rows, schemaKeys)).toBe(true)
    expect(areRequiredCredentialRowsComplete(rows.slice(0, 1), schemaKeys)).toBe(false)
  })
})
