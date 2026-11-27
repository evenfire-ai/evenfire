# README showcase images

The root [README](../../../README.md#see-evenfire-in-action) uses seven finished PNG exports
and three labeled SVG visual placeholders in this folder, in the order below. Each image has its own section
heading, explanatory copy and descriptive alt text.

| File | Image copy | Screenshot |
| --- | --- | --- |
| `01-desktop-conversation.png` | Put your agents to work | A marketing agent conversation with a downloadable draft campaign brief. |
| `08-team-channels.svg` → `08-team-channels.png` | Bring your agents into the conversation | Planned: a real Slack or Microsoft Teams conversation with an agent. |
| `02-human-approvals.png` | Review before it runs | An Airtable tool action awaiting approval, with Approve, Always approve and Deny controls. |
| `09-approval-modes.svg` → `09-approval-modes.png` | Choose how your agent takes action | Planned: the Desktop mode picker and its administrator limit. |
| `10-guardrails.svg` → `10-guardrails.png` | Set boundaries for every agent | Planned: an installed hook and a tool action blocked by policy. |
| `03-agent-configuration.png` | Define its role; Choose its model; Connect its tools; Share with your team; Control its access | The agent overview with its model, connectors, members and teams. |
| `04-marketplace.png` | Connect the tools you use | The Marketplace connector catalog. |
| `07-plugins.png` | Build apps your agents can use | EvenPages open in Desktop alongside a Blog Post Creator agent listing blog posts found in the workspace. |
| `05-evendrive.png` | Share files with your agents; Work on them together | A folder sharing dialog with people, a team, an agent and an access selector. |
| `06-cost-and-usage.png` | Make agent spending visible | Token usage and request totals, broken down by team. Currency costs depend on configured model prices. |

## Four new visual briefs

Keep the existing 1920 × 1080 dark blue frame and white serif headlines.
Use one large screenshot and at most one supporting crop per card. Make the
product interaction readable at GitHub's display width. The SVGs deliberately
say **Visual placeholder**; they reserve space without pretending a finished
product screenshot exists.

### Plugins — Build apps your agents can use

**README heading:** Build plugins with interfaces, workflows and services.

**Recommended composition:** Make a working plugin's interface in Desktop the
main image. Overlay a smaller crop of an agent conversation invoking that same
plugin's MCP tool and returning a visible result. Show the same item or result
in both views, so the relationship is obvious.

For example, if an installed task-board plugin supports it, ask an agent to
create a task, show the successful tool call, and show that task in the board.
Choose an existing plugin that actually supports both its interface and the
agent action; do not invent a demo plugin's capabilities. If none is ready,
use a real plugin interface plus its actual workflow run detail instead, and
adjust the alt text to match the final export.

**Optional small labels:** Interface · Workflows · Services · Agent tools.
Only label ingredients that the featured plugin actually includes. Background
services and databases belong in a small, clearly illustrative architecture
inset if needed, rather than a crowded collage of admin screens.

**Alternative headline:** Your workflows. Your interface. Your agents.

The differentiation is the combination of application UI, execution and agent
tools. Avoid an unsupported claim that no other product can do this.

### Team channels — Bring your agents into the conversation

**README heading:** Work with agents in Slack and Microsoft Teams.

**Recommended composition:** Use a real Slack thread or Teams conversation as
the main image: a short request, visible tool progress, then the agent's reply.
A concrete task such as asking an agent to summarize a shared project document
makes the interaction easier to understand than a greeting. Configure the
agent's document access first and capture the actual result.

Start with whichever channel already works in your demo environment. If both
are ready, use two matching crops of equivalent requests in Slack and Teams,
with a small platform label above each. A single large thread is preferable
to two unreadably small chat windows. Keep connection settings out of the hero
card; the conversation demonstrates the value.

**Alternative headline:** Your agents, where your team works.

### Approval modes — Choose how your agent takes action

**README heading:** Choose how your agent takes action.

**Recommended composition:** Crop a Desktop conversation around the open mode
picker, keeping all three actual labels readable: **Manual**, **Auto-approve**,
and **Allow all**. Add a small secondary crop of the Allow all confirmation,
or of the administrator ceiling message if that communicates the limits more
clearly. Use captures from separate moments rather than implying both menus
are open simultaneously.

**Optional side text:**

- Manual — Review approval-gated actions.
- Auto-approve — Fewer prompts for eligible shell commands and HTTP requests.
- Allow all — Skip most prompts within administrator limits.

**Small footer:** Guardrail blocks and required guardrail reviews still apply.

Use **Allow all**, not "Approve all", to match the UI. Auto-approve does not
automatically approve every low-risk tool. Scheduled-task management retains
its approval rules. Keep the existing **Review before it runs** card focused
on an individual decision; this new card explains the session-level choice.

**Alternative headline:** More autonomy. Boundaries you set.

### Guardrails — Set boundaries for every agent

**README heading:** Set boundaries with configurable guardrails.

**Recommended composition:** Use an agent conversation showing a real tool
call blocked by a configured guardrail as the large image. Add a small crop of
**Agents → [agent] → Advanced → Hooks** or an installed guardrail's detail
screen to show the policy behind the behavior. Use an actual configured rule
or hook and capture its actual effect.

For a diagram-led alternative, create three clearly illustrative lanes:
**Allow → Normal approval checks**, **Ask → Human review**, and
**Deny → Tool blocked**. Pair the diagram with a real enforcement screenshot.
An Allow decision does not bypass the normal approval gate.

The current UI manages hook references but has no editor for tool rules,
built-ins or the capability ceiling. Configure tool rules through the Host
resource; do not draw a fictional rules editor. An optional model-hook card
could instead pair the real hook detail with a verified redacted result.

**Alternative headline:** Decide what runs. Review what matters.

Guardrails are opt-in and complement isolation. Avoid claims that they make
an agent completely safe, eliminate prompt injection, or cannot be bypassed
in every possible circumstance.

## Replacing a visual placeholder

1. Export the composition to the PNG filename in the table, in this folder.
2. In the root README, replace that slot's `.svg` source with `.png`, remove
   its slot comment, and write alt text describing the actual capture.
3. Delete only the corresponding placeholder SVG, and update this inventory
   from planned to finished.

Existing numeric filenames stay unchanged; the table records display order.

## Updating the images

- Keep these numbered filenames when replacing exports so the README links
  continue to work. Preserve the PNG format; use a matching extension and update
  the README if switching formats.
- Keep the shared blue frame and readable interface details. Match the existing
  canvas proportions and avoid stretching screenshots.
- Update alt text and surrounding copy if the depicted workflow changes.
- Use demonstration data and remove private emails, credentials and private URLs
  before committing an export. Label illustrative results in the image or caption.
- Keep this set separate from the screenshots elsewhere under `docs/assets/`,
  which are referenced by other documentation.
