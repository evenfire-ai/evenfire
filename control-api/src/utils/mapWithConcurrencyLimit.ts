/**
 * `Promise.all(items.map(mapper))` with at most `limit` mappers in flight.
 * Results keep the input order. A rejecting mapper rejects the whole call, so
 * callers that must not fail as a unit catch inside their mapper.
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapWithConcurrencyLimit: limit must be a positive integer, got ${limit}`)
  }
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(items[index])
      }
    })
  )
  return results
}
