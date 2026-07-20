type BigQueryField = { name?: unknown; type?: unknown }
type BigQueryCell = { v?: unknown }
type BigQueryRow = { f?: unknown }
type BigQueryQueryResponse = {
  jobComplete?: unknown
  pageToken?: unknown
  totalRows?: unknown
  errors?: unknown
  schema?: { fields?: unknown }
  rows?: unknown
}

export function parseCompletedBigQueryRows(input: {
  response: unknown
  expectedSchema: readonly (readonly [string, string])[]
  maxRows: number
  source: string
}): Array<Record<string, unknown>> {
  if (typeof input.response !== 'object' || input.response === null) {
    throw new Error(`${input.source} response is invalid`)
  }
  const response = input.response as BigQueryQueryResponse
  if (response.jobComplete !== true) {
    throw new Error(`${input.source} job did not complete within its budget`)
  }
  if (
    response.errors !== undefined &&
    (!Array.isArray(response.errors) || response.errors.length > 0)
  ) {
    throw new Error(`${input.source} job returned errors`)
  }
  if (typeof response.pageToken === 'string' && response.pageToken.length > 0) {
    throw new Error(`${input.source} result exceeds ${input.maxRows} rows`)
  }

  const fields = response.schema?.fields
  if (!Array.isArray(fields) || fields.length !== input.expectedSchema.length) {
    throw new Error(`${input.source} schema drift`)
  }
  fields.forEach((field, index) => {
    if (typeof field !== 'object' || field === null) {
      throw new Error(`${input.source} schema drift`)
    }
    const expected = input.expectedSchema[index]!
    const actual = field as BigQueryField
    if (actual.name !== expected[0] || actual.type !== expected[1]) {
      throw new Error(`${input.source} schema drift`)
    }
  })

  const rows = response.rows === undefined ? [] : response.rows
  if (!Array.isArray(rows)) throw new Error(`${input.source} rows are invalid`)
  let totalRows: bigint
  try {
    totalRows =
      typeof response.totalRows === 'string' ? BigInt(response.totalRows) : BigInt(rows.length)
  } catch {
    throw new Error(`${input.source} totalRows is invalid`)
  }
  if (totalRows !== BigInt(rows.length) || totalRows > BigInt(input.maxRows)) {
    throw new Error(`${input.source} result exceeds ${input.maxRows} rows`)
  }

  return rows.map(value => {
    if (typeof value !== 'object' || value === null || !Array.isArray((value as BigQueryRow).f)) {
      throw new Error(`${input.source} row is invalid`)
    }
    const cells = (value as { f: BigQueryCell[] }).f
    if (cells.length !== fields.length) throw new Error(`${input.source} row is invalid`)
    return Object.fromEntries(input.expectedSchema.map(([name], index) => [name, cells[index]?.v]))
  })
}
