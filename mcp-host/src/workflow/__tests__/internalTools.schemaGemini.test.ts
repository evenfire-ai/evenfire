/**
 * Gemini is the provider whose request shape differs most from the JSON Schema
 * the tools declare: @google/genai converts each `parameters` object into the
 * Gemini schema before sending it, and copies anything it does not recognise
 * straight through for the API to reject. The Vertex path the repo uses applies
 * the same conversion as the Gemini API path and then forwards the function
 * declarations unchanged.
 *
 * So instead of asserting rules about that conversion, this drives the repo's
 * own GoogleGenerativeDriver through the real SDK against a local server and
 * inspects the request body that would have left the pod. No network, no key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as http from 'http'
import { createGetCapabilitiesTool } from '../../capabilities/getCapabilitiesTool'
import { GoogleGenerativeDriver } from '../../llm/drivers/googleGenerative'
import { INTERNAL_TOOLS } from '../internalTools'

/** Every internal tool both runtimes offer: the registry plus the capabilities probe. */
const OFFERED_TOOLS = [...INTERNAL_TOOLS, createGetCapabilitiesTool(() => undefined)]

/** Fields the Gemini Schema message defines. Anything else is rejected. */
const GEMINI_SCHEMA_FIELDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
  'items',
  'minimum',
  'maximum',
])

type Json = Record<string, unknown>

function unknownFields(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  const n = node as Json
  for (const k of Object.keys(n)) if (!GEMINI_SCHEMA_FIELDS.has(k)) out.push(`${path}.${k}`)
  if (n.properties && typeof n.properties === 'object') {
    for (const [k, v] of Object.entries(n.properties as Json)) unknownFields(v, `${path}.${k}`, out)
  }
  if (n.items) unknownFields(n.items, `${path}[]`, out)
  if (Array.isArray(n.anyOf)) n.anyOf.forEach((b, i) => unknownFields(b, `${path}|${i}`, out))
}

let server: http.Server
let baseUrl = ''
let lastBody: Json | undefined

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      lastBody = JSON.parse(raw) as Json
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
          ],
        })
      )
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => {
  server.close()
})

async function sendThroughDriver(): Promise<Array<{ name: string; parameters: Json }>> {
  const { GoogleGenAI } = require('@google/genai')
  const ai = new GoogleGenAI({ apiKey: 'test', httpOptions: { baseUrl } })
  const driver = new GoogleGenerativeDriver(
    { generateContent: (input: never) => ai.models.generateContent(input) },
    'gemini-2.5-pro'
  )
  lastBody = undefined
  await driver.completeSingleTurnWithTools(
    [{ role: 'user', content: 'hi' }] as never,
    OFFERED_TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })) as never
  )
  // Assigned inside the server callback, which control-flow analysis cannot see.
  const body = lastBody as Json | undefined
  const tools =
    (body?.tools as Array<{ functionDeclarations: Array<{ name: string; parameters: Json }> }>) ??
    []
  return tools[0]?.functionDeclarations ?? []
}

describe('internal tools, as the Gemini driver actually sends them', () => {
  it('converts every declaration without the SDK throwing', async () => {
    // The SDK throws on some shapes (type and anyOf on one node, a null-only
    // type); a throw here is a tool that cannot be offered to Gemini at all.
    const decls = await sendThroughDriver()
    expect(decls.map(d => d.name).sort()).toEqual(OFFERED_TOOLS.map(t => t.name).sort())
  })

  it('sends no field the Gemini schema does not define', async () => {
    const decls = await sendThroughDriver()
    const bad: string[] = []
    for (const d of decls) {
      const out: string[] = []
      unknownFields(d.parameters, '', out)
      if (out.length > 0) bad.push(`${d.name}: ${out.join(', ')}`)
    }
    expect(bad, `the Gemini API would reject these declarations:\n${bad.join('\n')}`).toEqual([])
  })

  it('keeps the polymorphic fields polymorphic after conversion', async () => {
    // A cell that could be text, a number or empty must stay that way on the
    // Gemini side too, or the model is told only strings are allowed.
    const decls = await sendThroughDriver()
    const xlsx = decls.find(d => d.name === 'clerum__generate_xlsx')!
    const sheets = (xlsx.parameters.properties as Json).sheets as Json
    const rows = ((sheets.items as Json).properties as Json).rows as Json
    // A row is an array of cells, or a record read by header name.
    const shapes = (rows.items as Json).anyOf as Json[]
    expect(shapes.map(b => b.type).sort()).toEqual(['ARRAY', 'OBJECT'])
    const cell = shapes.find(b => b.type === 'ARRAY')!.items as Json
    expect(cell.nullable).toBe(true)
    expect((cell.anyOf as Json[]).map(b => b.type).sort()).toEqual(['BOOLEAN', 'NUMBER', 'STRING'])
  })
})
