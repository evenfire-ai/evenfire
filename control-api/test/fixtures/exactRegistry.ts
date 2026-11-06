/**
 * A `fetch` double for the registry's `GET /entries/:name/versions/:version`, to run
 * under the real `registryClient.getEntryVersion`.
 *
 * The registry answers that route with `findEntryByNameVersion`: an exact lookup on
 * `(name, version)`, with no alias from an unscoped name to a scoped one, no `latest`
 * and no case folding, and a 404 for anything it does not store. This double serves
 * each row only at its exact path and answers 404 to every other URL, so a test cannot
 * model a resolution the registry never does. The 404 reaches the route as the error
 * the real client throws for it.
 */
export function exactRegistryFetch(
  rows: ReadonlyArray<{ name: string; version: string }>
): (url: string | URL | Request) => Promise<Response> {
  const byPath = rows.map(row => ({
    path: `/entries/${encodeURIComponent(row.name)}/versions/${encodeURIComponent(row.version)}`,
    body: JSON.stringify(row),
  }))
  return async url => {
    const href = url instanceof Request ? url.url : String(url)
    const hit = byPath.find(({ path }) => href.endsWith(path))
    return hit
      ? new Response(hit.body, { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('', { status: 404 })
  }
}
