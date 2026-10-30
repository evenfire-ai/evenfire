import { describe, expect, it } from 'vitest'
import { loadAll } from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

const e2eDir = path.resolve(__dirname, '../../e2e')
const mcpServerCrdPath = path.resolve(
  __dirname,
  '../../../../charts/clerum-crds/crds/mcpserver.yaml'
)

type JsonObject = Record<string, unknown>
type Schema = {
  properties?: Record<string, Schema>
  items?: Schema
  additionalProperties?: boolean | Schema
  'x-kubernetes-preserve-unknown-fields'?: boolean
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readMcpServerSchema(): Schema {
  const crd = loadAll(fs.readFileSync(mcpServerCrdPath, 'utf8'))[0] as {
    spec: { versions: Array<{ name: string; schema: { openAPIV3Schema: Schema } }> }
  }
  const version = crd.spec.versions.find(candidate => candidate.name === 'v1alpha1')
  if (!version) throw new Error('McpServer CRD has no v1alpha1 version')
  return version.schema.openAPIV3Schema
}

// The live lane applies these heredocs with kubectl's strict field validation,
// so a field the CRD no longer declares fails the apply before the assertion
// the test is actually about ever runs.
function undeclaredFields(value: unknown, schema: Schema, at: string): string[] {
  if (schema['x-kubernetes-preserve-unknown-fields']) return []
  if (Array.isArray(value)) {
    return schema.items
      ? value.flatMap((item, index) => undeclaredFields(item, schema.items!, `${at}[${index}]`))
      : []
  }
  if (!isObject(value)) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const childSchema =
      schema.properties?.[key] ??
      (isObject(schema.additionalProperties) ? schema.additionalProperties : undefined)
    if (childSchema) return undeclaredFields(child, childSchema, `${at}.${key}`)
    return schema.additionalProperties === true ? [] : [`${at}.${key}`]
  })
}

type Manifest = { source: string; object: JsonObject }

function mcpServerHeredocs(): Manifest[] {
  const manifests: Manifest[] = []
  for (const file of fs.readdirSync(e2eDir).filter(name => name.endsWith('.test.ts'))) {
    const text = fs.readFileSync(path.join(e2eDir, file), 'utf8')
    for (const match of text.matchAll(/<<'EOF'\n([\s\S]*?)\nEOF/g)) {
      const line = text.slice(0, match.index).split('\n').length
      // Template placeholders only ever stand for scalar values in these heredocs.
      const yaml = match[1].replace(/\$\{[^}]+\}/g, 'placeholder')
      for (const object of loadAll(yaml)) {
        if (isObject(object) && object.kind === 'McpServer') {
          manifests.push({ source: `${file}:${line}`, object })
        }
      }
    }
  }
  return manifests
}

describe('e2e McpServer heredocs', () => {
  const schema = readMcpServerSchema()
  const manifests = mcpServerHeredocs()

  it('finds McpServer heredocs to check', () => {
    expect(manifests.length).toBeGreaterThan(0)
  })

  it('only use spec fields the McpServer CRD declares', () => {
    const specSchema = schema.properties?.spec
    expect(specSchema).toEqual(expect.any(Object))
    const violations = manifests.flatMap(({ source, object }) =>
      undeclaredFields(object.spec, specSchema!, 'spec').map(field => `${source} ${field}`)
    )
    expect(violations).toEqual([])
  })
})
