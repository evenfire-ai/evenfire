import { type ToolSchema } from './shared'

export const MARKDOWN_TOOL: ToolSchema = {
  name: 'clerum__generate_markdown',
  description: 'Generate a Markdown (.md) file. Provide the filename and full markdown content.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'report.md'). Extension .md added if missing.",
      },
      content: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Full markdown text, as one string or an array of lines.',
      },
    },
    required: ['filename', 'content'],
  },
}
