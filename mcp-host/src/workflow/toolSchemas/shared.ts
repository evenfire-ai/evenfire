import type { InternalToolDefinition } from '../types'

// ─── Portable schema fragments ───────────────────────────────────────
//
// A tool schema does two jobs. The workflow path (stepRouter) compiles it with
// AJV and REJECTS arguments that do not match before execute() runs, so it must
// accept everything the runtime handles. And it reaches every provider
// verbatim, so it must survive each SDK's translation. Unions are therefore
// written as scalar type lists or `anyOf` branches — @google/genai turns both
// into its own schema — and never as `oneOf`, which it passes through
// untranslated for the Gemini API to reject. Every array declares `items`.

/** What a tool offers a model: everything but how it runs. */
export type ToolSchema = Pick<InternalToolDefinition, 'name' | 'description' | 'parameters'>

/**
 * The types of a table or sheet cell: text, a number, true/false, or null for
 * an empty cell. Each runtime stringifies or formats what arrives.
 */
export const CELL_TYPES = ['string', 'number', 'boolean', 'null']

/**
 * A row sent as a {header: cell} record, which every runtime reads by header
 * name. Gemini rejects an object schema with no properties, so it declares one
 * example key; additionalProperties keeps the others valid. The example is a
 * column index, which the runtime reads as that column.
 */
export const RECORD_ROW_SCHEMA = {
  type: 'object',
  properties: { '0': { type: CELL_TYPES, description: 'Column 0, or a header.' } },
  additionalProperties: { type: CELL_TYPES },
}

/** One row of cells, left to right in header order, or a record. */
export const ROW_SCHEMA = {
  anyOf: [{ type: 'array', items: { type: CELL_TYPES } }, RECORD_ROW_SCHEMA],
}
