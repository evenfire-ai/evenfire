import { realpathSync } from 'node:fs'

// Companion reporter: a successful file-process placeholder is not a test.
// Keep normal TAP output as the primary reporter and fail on missing coverage.
export default async function* registrationReporter(source) {
  const requested = JSON.parse(process.env.NODE_TEST_EXPECTED_FILES || '[]')
  if (!Array.isArray(requested) || requested.length === 0)
    throw new Error('Expected explicit node test files')
  const counts = new Map(requested.map(file => [realpathSync(file), 0]))
  for await (const event of source) {
    if (event.type !== 'test:pass') continue
    const data = event.data
    if (!data?.file || data.skip || data.todo || data.details?.type !== 'test') continue
    const file = realpathSync(data.file)
    if (!counts.has(file)) continue
    // Empty files generate a synthetic case named after the input path.
    let filePlaceholder = false
    try {
      filePlaceholder = realpathSync(data.name) === file
    } catch {
      /* Ordinary test name. */
    }
    if (!filePlaceholder) counts.set(file, counts.get(file) + 1)
  }
  const missing = [...counts].filter(([, count]) => count === 0).map(([file]) => file)
  if (missing.length) throw new Error(`No executed test cases in: ${missing.join(', ')}`)
}
