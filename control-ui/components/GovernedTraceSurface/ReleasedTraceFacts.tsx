function displayReleasedValue(value: string | number | boolean | null): string {
  if (value === null) return 'Not recorded'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

export function ReleasedTraceFacts({
  facts,
  headingId = 'trace-released-facts',
  title = 'Released facts',
}: {
  facts: Record<string, string | number | boolean | null>
  headingId?: string
  title?: string
}) {
  const entries = Object.entries(facts).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== null
  )
  return (
    <section className="cu-trace-detail-section" aria-labelledby={headingId}>
      <div className="cu-trace-detail-section__head">
        <h2 id={headingId}>{title}</h2>
        <span>{entries.length} fields</span>
      </div>
      {entries.length ? (
        <dl className="cu-trace-facts cu-trace-facts--released">
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt>{key.replaceAll('_', ' ')}</dt>
              <dd>{displayReleasedValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="cu-empty">No additional facts were recorded for this event type.</div>
      )}
    </section>
  )
}
