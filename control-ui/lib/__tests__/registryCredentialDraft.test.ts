import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  areRequiredCredentialRowsComplete,
  reconcileCredentialRows,
} from '../registryCredentialDraft'
import type { CredentialDraftRow, RegistryCredentialKey } from '../registryCredentialDraft.types'

const token = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,11}$/)
const shortString = fc.string({ maxLength: 20 })
const schemaKeysArbitrary: fc.Arbitrary<RegistryCredentialKey[]> = fc.uniqueArray(
  fc.record({ name: token, label: shortString }),
  { maxLength: 12, selector: key => key.name }
)
const rowArbitrary: fc.Arbitrary<CredentialDraftRow> = fc.record({
  id: shortString,
  secretKey: fc.oneof(token, shortString),
  value: shortString,
  label: fc.option(shortString, { nil: undefined }),
})

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

  it('places every arbitrary schema key exactly once at the front and is idempotent', () => {
    fc.assert(
      fc.property(
        fc.array(rowArbitrary, { maxLength: 30 }),
        schemaKeysArbitrary,
        (currentRows, generatedSchemaKeys) => {
          const reconciled = reconcileCredentialRows(currentRows, generatedSchemaKeys)
          const schemaNames = generatedSchemaKeys.map(key => key.name)
          const boundRows = reconciled.slice(0, schemaNames.length)

          expect(boundRows.map(row => row.secretKey)).toEqual(schemaNames)
          expect(new Set(boundRows.map(row => row.secretKey)).size).toBe(schemaNames.length)
          expect(reconcileCredentialRows(reconciled, generatedSchemaKeys)).toEqual(reconciled)
        }
      )
    )
  })

  it('preserves arbitrary uniquely-bound values and is stable under their permutation', () => {
    fc.assert(
      fc.property(
        schemaKeysArbitrary.chain(generatedSchemaKeys =>
          fc.tuple(...generatedSchemaKeys.map(() => shortString)).chain(values => {
            const rows = generatedSchemaKeys.map((key, index) => ({
              id: `row-${index}`,
              secretKey: key.name,
              value: values[index] ?? '',
            }))
            return fc
              .shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length })
              .map(shuffled => ({ generatedSchemaKeys, rows, shuffled }))
          })
        ),
        ({ generatedSchemaKeys, rows, shuffled }) => {
          const expected = reconcileCredentialRows(rows, generatedSchemaKeys)
          expect(reconcileCredentialRows(shuffled, generatedSchemaKeys)).toEqual(expected)
          for (const row of rows) {
            expect(expected.find(item => item.secretKey === row.secretKey)?.value).toBe(row.value)
          }
        }
      )
    )
  })

  it('adopts at most one arbitrary unbound filled row', () => {
    fc.assert(
      fc.property(
        schemaKeysArbitrary,
        fc.uniqueArray(
          fc.record({
            id: shortString,
            value: shortString.filter(value => value.trim().length > 0),
          }),
          { maxLength: 10, selector: row => row.id }
        ),
        (generatedSchemaKeys, unboundRows) => {
          const currentRows = unboundRows.map(row => ({ ...row, secretKey: '' }))
          const reconciled = reconcileCredentialRows(currentRows, generatedSchemaKeys)
          const adoptedIds = new Set(currentRows.map(row => row.id))
          const adoptedSchemaRows = reconciled
            .slice(0, generatedSchemaKeys.length)
            .filter(row => adoptedIds.has(row.id))
          expect(adoptedSchemaRows.length).toBeLessThanOrEqual(1)
        }
      )
    )
  })

  it('agrees with reconciled values and remains complete under arbitrary duplicate reordering', () => {
    fc.assert(
      fc.property(
        fc.array(rowArbitrary, { maxLength: 30 }),
        schemaKeysArbitrary,
        (rows, generatedSchemaKeys) => {
          const reconciled = reconcileCredentialRows(rows, generatedSchemaKeys)
          const expectedComplete = reconciled
            .slice(0, generatedSchemaKeys.length)
            .every(row => row.value.trim().length > 0)
          expect(areRequiredCredentialRowsComplete(reconciled, generatedSchemaKeys)).toBe(
            expectedComplete
          )

          const duplicatedAndReordered = [...rows, ...rows].reverse()
          expect(
            areRequiredCredentialRowsComplete(duplicatedAndReordered, generatedSchemaKeys)
          ).toBe(areRequiredCredentialRowsComplete(rows, generatedSchemaKeys))
        }
      )
    )
  })
})
