import type { TourStepContent, TourStepContext, TourStepId } from './types'

/**
 * Illustrations are inline SVG drawn with `currentColor`, so they inherit the
 * theme with no asset pipeline and nothing for the CSP to block. All are
 * decorative — `aria-hidden`, never the only carrier of meaning.
 */
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg className="tour-glyph" viewBox="0 0 64 40" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

const GLYPHS: Record<TourStepId, React.ReactNode> = {
  welcome: (
    <Glyph>
      <rect x="6" y="8" width="34" height="24" rx="3" />
      <path d="M14 16h18M14 22h12" />
      <circle cx="52" cy="20" r="6" />
    </Glyph>
  ),
  agents: (
    <Glyph>
      <circle cx="20" cy="20" r="8" />
      <rect x="36" y="10" width="22" height="8" rx="2" />
      <rect x="36" y="22" width="22" height="8" rx="2" />
      <path d="M28 20h8" />
    </Glyph>
  ),
  approvals: (
    <Glyph>
      <rect x="8" y="10" width="30" height="20" rx="3" />
      <path d="M16 20l5 5 9-10" />
      <path d="M46 14v12M52 14v12" />
    </Glyph>
  ),
  scope: (
    <Glyph>
      <circle cx="32" cy="20" r="13" />
      <circle cx="32" cy="20" r="6" />
      <path d="M32 2v6M32 32v6M13 20h6M45 20h6" />
    </Glyph>
  ),
  apps: (
    <Glyph>
      <rect x="10" y="8" width="20" height="24" rx="3" />
      <rect x="36" y="8" width="18" height="11" rx="2" />
      <rect x="36" y="21" width="18" height="11" rx="2" />
    </Glyph>
  ),
  plugins: (
    <Glyph>
      <rect x="12" y="12" width="16" height="16" rx="2" />
      <rect x="36" y="12" width="16" height="16" rx="2" />
      <path d="M28 20h8" />
      <path d="M20 12V6M44 28v6" />
    </Glyph>
  ),
  files: (
    <Glyph>
      <path d="M8 12h16l4 5h28v15H8z" />
      <path d="M20 24h24" />
    </Glyph>
  ),
  desktop: (
    <Glyph>
      <rect x="8" y="8" width="48" height="22" rx="3" />
      <path d="M26 34h12" />
      <path d="M16 16h10" />
    </Glyph>
  ),
  handoff: (
    <Glyph>
      <rect x="8" y="10" width="34" height="22" rx="4" />
      <path d="M16 18h16M16 24h10" />
      <path d="M46 21h10M52 17l4 4-4 4" />
    </Glyph>
  ),
}

/** Distinct strings rather than a "(s)" suffix. */
function agentSentence(labels: string[]): string {
  if (labels.length === 1) {
    return `Yours is ${labels[0]}.`
  }
  if (labels.length === 2) {
    return `Yours are ${labels[0]} and ${labels[1]}.`
  }
  return `Yours include ${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more.`
}

export function getTourStepContent(id: TourStepId, ctx: TourStepContext): TourStepContent {
  const illustration = GLYPHS[id]
  const hasAgents = ctx.agentLabels.length > 0

  switch (id) {
    case 'welcome':
      return {
        title: `Welcome to ${ctx.appName}`,
        body: 'This app is how you talk to your agents. The agents themselves live on your Evenfire server, along with everything they can reach — so what you see here reflects what that server gives you.',
        illustration,
      }

    case 'agents':
      return {
        title: hasAgents && ctx.agentLabels.length > 1 ? 'Your agents' : 'Your agent',
        body: `An agent bundles a model with the contexts and tools it is allowed to use. ${agentSentence(
          ctx.agentLabels
        )} Agents are configured on the server, not in this app.`,
        illustration,
      }

    case 'approvals':
      return {
        title: 'Nothing runs without your say-so',
        body: 'When an agent wants to use a tool, it asks first. You see what it intends to do and approve or deny it, one action at a time. An agent cannot route around that.',
        illustration,
      }

    case 'scope':
      return {
        title: 'What your agent can reach',
        body: 'Contexts hold the knowledge an agent works from; connectors are the systems it can act on. Both are set by an administrator on the server — you can see the reach here, and change it there.',
        illustration,
      }

    case 'apps':
      return {
        title: 'Apps run sandboxed',
        body: 'Some tools ship their own interface, and it runs inside this app in a sandbox. An app has no access to your data until it asks and you agree.',
        illustration,
      }

    case 'plugins':
      return {
        title: 'Recipes you can trigger',
        body: 'Recipes are prepared jobs you can run on demand. Each run keeps its history and whatever files it produced, so you can go back to a result later.',
        illustration,
      }

    case 'files':
      return {
        title: 'Files your agents can see',
        body: 'The file system is the shared ground between you and your agents. Nothing is visible to an agent because it happens to be on your computer — sharing is always deliberate.',
        illustration,
      }

    case 'desktop':
      return {
        title: 'Made for the desktop',
        body: 'Four things worth knowing: replies arrive as native notifications, the command palette jumps anywhere, you can keep several servers side by side, and your chat history stays on this computer, separately for each one.',
        illustration,
      }

    case 'handoff':
      return hasAgents
        ? {
            title: 'Say hi',
            body: `${ctx.agentLabels[0]} is ready. Ask for something small first — the reply tells you the whole chain is working.`,
            illustration,
          }
        : {
            title: 'You need access to an agent',
            body: 'Your account is signed in, but no agent has been shared with you yet. An administrator on your team can authorize one — that is the only thing standing between you and a first message.',
            illustration,
          }
  }
}
