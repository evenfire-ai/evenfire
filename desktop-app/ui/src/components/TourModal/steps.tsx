import type { TourStepContent, TourStepContext, TourStepId } from './types'

/**
 * One illustration per card, in deck order. Every card carries commissioned
 * artwork, which is why the deck is fixed — see `tourDeck.ts`.
 *
 * All decorative: `aria-hidden`, never the only carrier of meaning, because
 * each card's title already says what the image shows.
 */
const ILLUSTRATIONS: Record<TourStepId, React.ReactNode> = {
  welcome: <img className="tour-logo" src="./logo.svg" alt="" aria-hidden="true" />,
  agents: <img className="tour-art" src="./tour/your_agent.png" alt="" aria-hidden="true" />,
  files: <img className="tour-art" src="./tour/global_file_system.png" alt="" aria-hidden="true" />,
  mcpServers: <img className="tour-art" src="./tour/connectors.png" alt="" aria-hidden="true" />,
  apps: <img className="tour-art" src="./tour/apps.png" alt="" aria-hidden="true" />,
  handoff: <img className="tour-art" src="./tour/start.png" alt="" aria-hidden="true" />,
}

/**
 * Distinct strings rather than a "(s)" suffix, and empty when the user has no
 * agent yet — the fixed deck shows this card to them too, and a dangling
 * "Yours is" would be worse than saying nothing.
 */
function agentSentence(labels: string[]): string {
  if (labels.length === 0) {
    return ''
  }
  if (labels.length === 1) {
    return `Yours is ${labels[0]}.`
  }
  if (labels.length === 2) {
    return `Yours are ${labels[0]} and ${labels[1]}.`
  }
  return `Yours include ${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more.`
}

export function getTourStepContent(id: TourStepId, ctx: TourStepContext): TourStepContent {
  const illustration = ILLUSTRATIONS[id]
  const hasAgents = ctx.agentLabels.length > 0

  switch (id) {
    case 'welcome':
      return {
        title: `Welcome to ${ctx.appName}`,
        // Opens on what the user gets. An earlier draft led with where agents
        // run, which is our architecture and not a reason for anyone to care.
        body: 'This is where you put AI to work. Ask an agent for something and it goes and does it, working through your files and using your connectors.',
        illustration,
      }

    case 'agents':
      return {
        title: hasAgents && ctx.agentLabels.length > 1 ? 'Your agents' : 'Your agent',
        // "with your approval" keeps the tools honest: shell_exec and its
        // siblings are approval-gated, and whether a given agent holds them
        // depends on how it was set up.
        body: (
          <>
            Your agent does more than answer questions. It works through files and runs code for
            you, with your approval.
            {hasAgents ? (
              <span className="tour-body-line">{agentSentence(ctx.agentLabels)}</span>
            ) : null}
          </>
        ),
        illustration,
      }

    case 'apps':
      return {
        title: 'Plugins that bring their own interface',
        body: 'Some plugins bring their own interface, which you will find in the Apps section. Ask your cluster operator when you want one installed in your Evenfire workspace.',
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

    case 'handoff':
      return hasAgents
        ? {
            title: 'Say hi',
            // No "check that it works" framing: whether the chain is wired up
            // is our problem, not something to hand the user as a task.
            body: (
              <>
                {`${ctx.agentLabels[0]} is ready.`}
                <span className="tour-body-line">Ask it anything to get started.</span>
              </>
            ),
            illustration,
          }
        : {
            title: 'You need access to an agent',
            body: 'Your account is signed in, but no agent has been shared with you yet. An administrator on your team can authorize one. That is the only thing standing between you and a first message.',
            illustration,
          }
  }
}
