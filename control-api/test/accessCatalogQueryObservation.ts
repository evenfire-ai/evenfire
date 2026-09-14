const TRANSACTION_SETUP = new Set([
  'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  "SELECT set_config('statement_timeout', $1, true)",
])

export type MeasuredCatalogStatement = Readonly<{
  text: string
  classification: 'transaction_setup' | 'catalog_work' | 'unexpected_work'
}>

function normalize(text: string): string {
  return text.trim().replaceAll(/\s+/g, ' ')
}

export function classifyMeasuredCatalogStatement(text: string): MeasuredCatalogStatement {
  const normalized = normalize(text)
  if (TRANSACTION_SETUP.has(normalized)) {
    return { text: normalized, classification: 'transaction_setup' }
  }
  if (/^(?:WITH|SELECT|EXPLAIN)\b/i.test(normalized)) {
    return { text: normalized, classification: 'catalog_work' }
  }
  return { text: normalized, classification: 'unexpected_work' }
}

export class CatalogQueryObservation {
  private readonly measured: MeasuredCatalogStatement[] = []

  observe(text: string): boolean {
    const statement = classifyMeasuredCatalogStatement(text)
    this.measured.push(statement)
    return statement.classification !== 'transaction_setup'
  }

  get workCount(): number {
    return this.measured.filter(statement => statement.classification !== 'transaction_setup')
      .length
  }

  get unexpected(): readonly MeasuredCatalogStatement[] {
    return this.measured.filter(statement => statement.classification === 'unexpected_work')
  }
}
