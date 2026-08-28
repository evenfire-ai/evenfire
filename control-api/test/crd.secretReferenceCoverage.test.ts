import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  SECRET_REFERENCE_FIELDS,
  SECRET_REFERENCE_SCOPES,
} from '../src/services/secretReferenceService.js'

const crdsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../charts/clerum-crds/crds')

type OpenApiSchema = {
  description?: unknown
  type?: unknown
  properties?: unknown
  items?: unknown
  allOf?: unknown
  anyOf?: unknown
  oneOf?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function schemaDeclaresSecretReference(fieldName: string, schema: OpenApiSchema): boolean {
  if (fieldName === 'imagePullSecrets') return true

  const description = typeof schema.description === 'string' ? schema.description : ''
  if (!/\bSecret\b/.test(description) || /secret.*key$/i.test(fieldName)) return false
  if (/secret/i.test(fieldName)) return true
  if (!fieldName.endsWith('Ref')) return false

  const properties = asRecord(schema.properties)
  return schema.type === 'string' || properties?.name !== undefined
}

function collectSecretReferenceFields(schema: unknown, fields: Set<string>): void {
  const record = asRecord(schema)
  if (!record) return

  const properties = asRecord(record.properties)
  if (properties) {
    for (const [fieldName, value] of Object.entries(properties)) {
      const fieldSchema = asRecord(value) as OpenApiSchema | undefined
      if (fieldSchema && schemaDeclaresSecretReference(fieldName, fieldSchema)) {
        fields.add(fieldName)
      }
      collectSecretReferenceFields(value, fields)
    }
  }

  collectSecretReferenceFields(record.items, fields)
  for (const branch of [record.allOf, record.anyOf, record.oneOf]) {
    if (Array.isArray(branch)) branch.forEach(item => collectSecretReferenceFields(item, fields))
  }
}

function collectCrdSecretReferences(): Array<{ plural: string; field: string }> {
  const references: Array<{ plural: string; field: string }> = []
  for (const file of readdirSync(crdsDir).filter(name => name.endsWith('.yaml')).sort()) {
    const document = asRecord(parse(readFileSync(resolve(crdsDir, file), 'utf8')))
    const crdName = asRecord(document?.metadata)?.name
    const plural = typeof crdName === 'string' ? crdName.split('.', 1)[0] : undefined
    const versions = asRecord(document?.spec)?.versions
    if (!plural || !Array.isArray(versions)) throw new Error(`Invalid CRD schema: ${file}`)

    const fields = new Set<string>()
    for (const version of versions) {
      const openApiSchema = asRecord(asRecord(asRecord(version)?.schema)?.openAPIV3Schema)
      collectSecretReferenceFields(openApiSchema, fields)
    }
    for (const field of fields) references.push({ plural, field })
  }
  return references
}

describe('Secret reference CRD coverage', () => {
  it('keeps every schema-declared Secret reference covered by the safety scanner', () => {
    const references = collectCrdSecretReferences()

    expect([...new Set(references.map(reference => reference.field))].sort()).toEqual(
      [...SECRET_REFERENCE_FIELDS].sort()
    )
    expect([...new Set(references.map(reference => reference.plural))].sort()).toEqual(
      [...new Set(SECRET_REFERENCE_SCOPES.map(scope => scope.plural))].sort()
    )
  })
})
