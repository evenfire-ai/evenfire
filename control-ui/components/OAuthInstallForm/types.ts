import type { RegistryEntry } from '@lib/api'
import type { CatalogOAuthBlock } from '@lib/oauthInstall.types'

export type OAuthInstallFormProps = {
  entry: RegistryEntry
  // The validated `mcp_server_meta.oauth` block; presence is what routes the
  // install here instead of the ordinary connector form.
  catalogOAuth: CatalogOAuthBlock
  onCancel: () => void
  onInstalled: () => void
  onViewConnectors?: () => void
}
