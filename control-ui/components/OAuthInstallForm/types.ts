import type { RegistryEntry } from '@lib/api'
import type {
  GenericDiscoveryPrefill,
  GenericExtraParam,
  GenericFormState,
} from '@lib/oauthGeneric.types'
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

// Props for the generic-carril Endpoints step (S3-B4). The parent owns the form state;
// this step renders the endpoints/knobs/Detect UI and reports edits back through typed
// callbacks. Editing any field marks it `touched` in the parent so a later Apply never
// overwrites it (invariant 8).
export type GenericEndpointsStepProps = {
  state: GenericFormState
  // Client-side form issues keyed by field (UX only; control-api's 422 is authority).
  issues: Record<string, string>
  onEditString: (
    field: 'authorizationEndpoint' | 'tokenEndpoint' | 'refreshEndpoint' | 'resource',
    value: string
  ) => void
  onEditEnum: (
    field: 'tokenRequestFormat' | 'tokenAuthMethod' | 'scopeSeparator',
    value: string
  ) => void
  onEditBool: (
    field: 'sendScope' | 'usePkce' | 'includeResponseType' | 'supportsRefresh',
    value: boolean
  ) => void
  onExtraParamsChange: (rows: GenericExtraParam[]) => void
  // Store a successful discovery result; the form does NOT change until Apply.
  onDetected: (prefill: GenericDiscoveryPrefill) => void
  // Apply the stored discovery result to the form (explicit operator action).
  onApply: () => void
}
