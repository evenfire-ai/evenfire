import { CONNECTOR_PRESENTATION } from '@constants/connectorPresentation'

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
