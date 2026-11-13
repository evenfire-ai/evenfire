import type { ReactNode } from 'react'

export type RemoteOAuthSetupGuideProps = {
  /** The curator's Markdown guide; rendered as untrusted content. */
  guide?: string
  /** Where the operator registers the OAuth app; only an `https://` URL becomes a link. */
  providerConsoleUrl?: string
  /** The redirect URI field the guide refers to ("the redirect URI below"). */
  children?: ReactNode
}
