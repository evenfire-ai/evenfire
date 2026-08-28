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
  // The real mark rather than a drawn glyph: this is the one card where the
  // product introduces itself. Decorative — the title already names it, so
  // announcing the logo too would just repeat that.
  welcome: <img className="tour-logo" src="./logo.svg" alt="" aria-hidden="true" />,
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
  mcpServers: (
    <Glyph>
      <rect x="8" y="12" width="18" height="16" rx="2" />
      <path d="M26 20h12" />
      <circle cx="46" cy="20" r="8" />
      <path d="M46 16v8M42 20h8" />
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
        // Opens on what the user gets. An earlier draft led with where agents
        // run, which is our architecture and not a reason for anyone to care.
        body: 'This is where you put AI to work. Ask an agent for something and it goes and does it, working through your files and using your plugins, with your approval at every step.',
        illustration,
      }

    case 'agents':
      return {
        title: hasAgents && ctx.agentLabels.length > 1 ? 'Your agents' : 'Your agent',
        // An agent is not pinned to one model: it can draw on several
        // providers, and the composer's ModelSelector switches between them.
        // "when you approve" keeps the tools honest — shell_exec and its
        // siblings are approval-gated, and whether a given agent holds them
        // depends on how it was set up.
        body: `Your agent does more than answer questions. It works through files and runs code for you, with your approval. Pick whichever model suits the task, since it is not tied to one provider. ${agentSentence(
          ctx.agentLabels
        )}`,
        illustration,
      }

    case 'approvals':
      return {
        title: 'Nothing runs without your approval',
        body: 'You get the speed of automation without handing over the keys. Before an agent touches anything it asks, and you see exactly what it intends to do.',
        illustration,
      }

    case 'scope':
      return {
        title: 'No surprises about what it can see',
        body: 'An agent reaches only what you have given it. Everything else stays out of view.',
        illustration,
      }

    case 'apps':
      return {
        title: 'Plugins that bring their own interface',
        body: 'Some plugins bring their own interface, which you will find in the Apps section. Ask your cluster operator when you want one installed in your Evenfire instance.',
        illustration,
      }

    case 'plugins':
      return {
        title: 'Repeat the work you do often',
        body: 'Turn work you repeat into a recipe and run it on demand. Every run keeps its results and files, so you can come back to them.',
        illustration,
      }

    case 'mcpServers':
      return {
        title: 'Add your own connectors',
        body: 'Need your agent to reach something new? Add a connector from the registry in a couple of clicks. Nothing to deploy, no config to edit.',
        illustration,
      }

    case 'files':
      return {
        title: 'One place for your files and your agents',
        body: 'Work on the same files as your teammates and your agents, in one shared place. Nothing on your computer is visible to an agent until you share it.',
        illustration,
      }

    case 'desktop':
      return {
        title: 'Worth knowing',
        // Capabilities stated plainly. An earlier draft framed these as things
        // "a browser would not give you", which argues for the form factor
        // instead of telling the user what they can now do.
        body: (
          <ul className="tour-list">
            <li>Replies reach you as notifications, even when you are elsewhere</li>
            <li>The command palette jumps to any agent, chat, or setting</li>
            <li>Connect to several Evenfire instances and switch between them</li>
          </ul>
        ),
        illustration,
      }

    case 'handoff':
      return hasAgents
        ? {
            title: 'Say hi',
            // No "check that it works" framing: whether the chain is wired up
            // is our problem, not something to hand the user as a task.
            body: `${ctx.agentLabels[0]} is ready. Ask it anything to get started.`,
            illustration,
          }
        : {
            title: 'You need access to an agent',
            body: 'Your account is signed in, but no agent has been shared with you yet. An administrator on your team can authorize one. That is the only thing standing between you and a first message.',
            illustration,
          }
  }
}
