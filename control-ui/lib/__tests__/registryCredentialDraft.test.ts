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

  it('is idempotent, unique by schema key, and preserves bound values', () => {
    const current = [
      { id: 'secret', secretKey: 'CLIENT_SECRET', value: 'secret-456' },
      { id: 'client', secretKey: 'CLIENT_ID', value: 'client-123' },
      { id: 'duplicate-client', secretKey: 'CLIENT_ID', value: 'ignored-duplicate' },
      { id: 'extra', secretKey: 'OPTIONAL_SCOPE', value: 'read' },
    ]
    const reconciled = reconcileCredentialRows(current, schemaKeys)

    expect(reconciled.map(row => row.secretKey)).toEqual([
      'CLIENT_ID',
      'CLIENT_SECRET',
      'OPTIONAL_SCOPE',
    ])
    expect(reconciled.find(row => row.secretKey === 'CLIENT_ID')?.value).toBe('client-123')
    expect(reconcileCredentialRows(reconciled, schemaKeys)).toEqual(reconciled)
  })

  it('is stable across permutations of uniquely bound schema rows', () => {
    const client = { id: 'client', secretKey: 'CLIENT_ID', value: 'client-123' }
    const secret = { id: 'secret', secretKey: 'CLIENT_SECRET', value: 'secret-456' }

    expect(reconcileCredentialRows([client, secret], schemaKeys)).toEqual(
      reconcileCredentialRows([secret, client], schemaKeys)
    )
  })

  it('required completeness is stable under duplicate and reordered input rows', () => {
    const complete = [
      { id: 'client', secretKey: 'CLIENT_ID', value: 'client-123' },
      { id: 'secret', secretKey: 'CLIENT_SECRET', value: 'secret-456' },
    ]
    expect(areRequiredCredentialRowsComplete([...complete].reverse(), schemaKeys)).toBe(true)
    expect(areRequiredCredentialRowsComplete([...complete, complete[0]], schemaKeys)).toBe(true)
  })
})
