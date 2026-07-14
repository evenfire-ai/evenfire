/**
 * 3rd-party AuthN + 1st-party MCP-host workflow approval journey.
 *
 * Product route under test:
 * A Telegram user enters through CommunicationChannel/channel-reader, resolves
 * to a verified Clerum user, asks the first-party shared mcp-host to list and
 * trigger a granted workflow, receives the durable approval request back in
 * Telegram, decides it through channel-reader -> first-party mcp-host ->
 * control-api, and receives the result artifact back through Telegram.
 *
 * Desktop notification behavior is a separate observer contract: the existing
 * bell opens a completed workflow notification and refreshes the matching run.
 */
import './third-party-authn-first-party-mcphost/desktopWorkflowCompletionNotificationSpec'
import './third-party-authn-first-party-mcphost/telegramApprovalJourneySpec'
import './third-party-authn-first-party-mcphost/telegramAuthzSpec'
import './third-party-authn-first-party-mcphost/telegramWorkflowIdentityGateRegressionSpec'
