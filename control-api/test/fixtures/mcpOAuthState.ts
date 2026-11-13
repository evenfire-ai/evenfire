import {
  type BuildAuthorizeUrlDeps,
  buildAuthorizeUrl,
} from '../../src/oauth/authorizeUrlHelper.js'

/**
 * A signed mcp OAuth state taken from the real authorize-URL mint, never written
 * by hand: the mint is the only producer of mcp states, and it decides which
 * claims they carry (the CR uid among them) from the McpServer it reads. Pass the
 * same reader the callback under test uses, so the state names the installation
 * that reader sees at mint time.
 */
export interface MintMcpStateInput {
  mcpServerName: string
  userId: string
  oauthClientId: string
  contextId?: string
}

export type MintMcpStateDeps = Pick<BuildAuthorizeUrlDeps, 'mcpServerReader' | 'secretReader'> &
  Partial<Pick<BuildAuthorizeUrlDeps, 'recipeReader'>>

export async function mintMcpState(
  deps: MintMcpStateDeps,
  stateSecret: string,
  input: MintMcpStateInput
): Promise<string> {
  const result = await buildAuthorizeUrl(
    {
      subjectKind: 'mcp',
      mcpServerName: input.mcpServerName,
      oauthClientId: input.oauthClientId,
      userId: input.userId,
      grantKind: 'user',
      background: false,
      // Not part of the signed claims; the callback rebuilds its own redirect URI.
      redirectUri: 'https://mint.example.test/oauth-callback',
      ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    },
    {
      recipeReader: deps.recipeReader ?? { read: async () => null },
      mcpServerReader: deps.mcpServerReader,
      secretReader: deps.secretReader,
      stateSecret,
    }
  )
  if (result.kind !== 'ok')
    throw new Error(`fixture: mcp authorize-url mint failed: ${result.kind}`)
  const state = new URL(result.authorizeUrl).searchParams.get('state')
  if (!state) throw new Error('fixture: the minted authorize URL carries no state')
  return state
}
