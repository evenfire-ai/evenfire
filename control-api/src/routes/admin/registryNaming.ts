/**
 * Naming rules for registry catalog entries that more than one admin route
 * shares. Kept free of I/O so pure modules can import it without dragging in
 * the registry routes, the database or the K8s client.
 */

/**
 * Official evenfire scopes, always trusted as the platform's own reserved orgs.
 * The registry enforces that only a curator client can publish under them, which
 * is what makes the scope of an entry name a trustworthy provenance signal.
 * Hardcoded so a misconfigured environment can never drop platform trust.
 */
export const OFFICIAL_EVENFIRE_SCOPES: readonly string[] = ['@clerum', '@evenfire']

/** The `@org` scope from an org-scoped entry name (`@org/name`), or null. */
export function entryNameScope(entryName: string): string | null {
  const m = /^@([^/]+)\//.exec(entryName)
  return m ? `@${m[1]}` : null
}

/**
 * The K8s-safe slug of a catalog entry name used in generated resource names.
 * Capped at 40 characters so a generated name always has room for its suffix
 * and hash inside the 63-character RFC 1123 label limit.
 */
export function registryNameSlug(entryName: string): string {
  return entryName
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

/**
 * Whether upgrading by `requestedName` could land on the entry a resource was
 * installed from (`installedCatalogId`), before asking the registry. A scoped name
 * is canonical; only an unscoped name may come back under a scope, and then only
 * with the same name. Anything else is a different entry whatever the registry
 * answers, so the caller can refuse it without fetching a target that may not exist.
 */
export function mayResolveToInstalledEntry(
  installedCatalogId: string,
  requestedName: string
): boolean {
  if (installedCatalogId === requestedName) return true
  const installedScope = entryNameScope(installedCatalogId)
  return (
    installedScope !== null &&
    entryNameScope(requestedName) === null &&
    installedCatalogId === `${installedScope}/${requestedName}`
  )
}
