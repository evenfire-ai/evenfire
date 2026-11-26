import {
  CONNECTOR_PRESENTATION,
  INSTALLED_CONNECTOR_CATALOG_ALIASES,
} from '@constants/connectorPresentation'
import type { Metadata } from '@lib/api'

export function getConnectorPresentation(registryName: string) {
  if (Object.hasOwn(CONNECTOR_PRESENTATION, registryName)) {
    return CONNECTOR_PRESENTATION[registryName]
  }
  // Clean future first-party entries without relabelling third-party namespaces.
  const name = registryName.startsWith('@evenfire/mcp-')
    ? registryName
        .slice('@evenfire/mcp-'.length)
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    : registryName
  return {
    name,
    icon: '/connector-icons/modelcontextprotocol.svg',
    darkIcon: '/connector-icons/modelcontextprotocol-on-dark.svg',
  }
}

/** Read the saved source; names, images and descriptions are not proof of origin. */
export function getInstalledConnectorCatalogId(
  metadata: Pick<Metadata, 'annotations' | 'labels'> | undefined
): string | undefined {
  const id = (
    metadata?.annotations?.['clerum.io/catalog-id'] ?? metadata?.labels?.['clerum.io/catalog-id']
  )?.trim()
  if (!id) return undefined
  return Object.hasOwn(INSTALLED_CONNECTOR_CATALOG_ALIASES, id)
    ? INSTALLED_CONNECTOR_CATALOG_ALIASES[id]
    : id
}
