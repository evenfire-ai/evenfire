import type { CodexToolDefinitionV1 } from '@clerum/llm-provider-attempt-contract'

// tools/list snapshot from eventasks-mcp:2.6.0-dev, captured 2026-09-16 for #647.
// Complete schema: only key/actor are required; the label edit mechanisms are
// mutually exclusive in the owning API. This fixture contains no task data.
export const eventaskUpdateTool: CodexToolDefinitionV1 = {
  name: 'eventasks__workitem_update',
  description:
    "Update a work item's title/description/status/priority/labels/due date/estimate. Use for any field change except reparenting (workitem_move) and type changes (workitem_restructure). " +
    "Setting status='done' is gated by the item's required acceptance criteria: if any are " +
    "still unchecked, this call fails with error 'criteria_unmet' and the result lists the " +
    'unmet criteria, so the item is NOT marked done. When that happens, either check off the ' +
    'fulfilled criteria with workitem_check_criterion, or retry with force=true after confirming ' +
    'with the user that the work is genuinely complete. Never tell the user an item is done ' +
    'unless this tool returned success (no error).',
  parameters: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'The work item to update, as its key (TASK-45) or its uuid.',
      },
      title: { type: 'string', minLength: 1, description: 'New title.' },
      description: { type: 'string', description: 'New body text (replaces the old one).' },
      status: {
        type: 'string',
        enum: ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'],
        description:
          'New status. A meeting suggestion cannot be moved this way — use workitem_confirm_suggestion / workitem_dismiss_suggestion.',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'New priority.',
      },
      rank: { type: 'number', description: 'Board ordering position; lower sorts first.' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description:
          "REPLACES the item's entire label set with this one — any label not " +
          'listed here is removed. To change one tag without touching the ' +
          'others, use addLabels/removeLabels instead.',
      },
      addLabels: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Add these labels, leaving the existing ones in place. Adding a label ' +
          'the item already has does nothing. Cannot be combined with `labels`.',
      },
      removeLabels: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Remove these labels, leaving the rest in place. Matching is exact and ' +
          'case-sensitive; naming a label the item lacks does nothing. Cannot be ' +
          'combined with `labels`.',
      },
      dueDate: { type: ['string', 'null'], description: 'Due date YYYY-MM-DD, or null to clear.' },
      estimate: {
        type: ['number', 'null'],
        description: 'Estimate (points/hours), or null to clear.',
      },
      force: {
        type: 'boolean',
        description:
          'Override the definition-of-done gate when setting status=done with unmet criteria.',
      },
      actor: {
        type: 'string',
        minLength: 1,
        description:
          'Your own agent name, recorded as the author. Use the SAME value every call: the work queue, your inbox and author-only checks all match it exactly.',
      },
    },
    required: ['key', 'actor'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
}

// Real second MCP: mcp-servers/web-search/src/index.ts:136-148 at 329241bc3.
// Emitted input schema for its Zod registration; keep the plugin's own default
// as schema metadata, never insert it into model-returned arguments.
export const webSearchTool: CodexToolDefinitionV1 = {
  name: 'web-search__web_search',
  description: 'Search the web using the Brave Search API. Returns titles, URLs, and snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      maxResults: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        default: 5,
        description: 'Maximum number of results to return (default 5)',
      },
    },
    required: ['query'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
}

export const optionalMcpTools = [eventaskUpdateTool, webSearchTool]
