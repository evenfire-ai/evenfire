import { DOCX_IMAGE_FILE_DESCRIPTION } from '../documentSchema'
import { ROW_SCHEMA, type ToolSchema } from './shared'

// ─── generate_docx ───────────────────────────────────────────────────

export const DOCX_TOOL: ToolSchema = {
  name: 'clerum__generate_docx',
  description:
    'Generate a styled Word (.docx) file from a markdown body, with optional tables, images, ' +
    'a palette and a branded header and footer with page numbers. The result lists anything ' +
    'left out.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'report.docx'); .docx added if missing.",
      },
      title: {
        type: 'string',
        description: 'Title at the top, also in the running header.',
      },
      body: {
        type: 'string',
        description:
          'Markdown: # to ###### headings, **bold**, *italic*, `code`, [links](https://...), ' +
          '"- " and "1. " lists (indent to nest), GFM pipe tables, ``` code blocks, > quotes, ' +
          '--- rules, <br>. ![alt](chart.png) on its own line embeds an image from the output folder.',
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      headline: {
        type: 'string',
        description: 'One-line subtitle under the title.',
      },
      images: {
        type: 'array',
        description: 'Images added after the body and tables, in order.',
        items: {
          anyOf: [
            { type: 'string', description: DOCX_IMAGE_FILE_DESCRIPTION },
            {
              type: 'object',
              required: ['path'],
              properties: {
                path: { type: 'string', description: 'Same as the string form.' },
                width: {
                  type: 'number',
                  description: 'Width in px; proportions are kept and the image fits the page.',
                },
                height: { type: 'number', description: 'Height in px; as for width.' },
                alignment: {
                  type: 'string',
                  enum: ['left', 'center', 'right'],
                  description: "Default 'left'.",
                },
              },
            },
          ],
          description: 'An image file name, or {path, width, height, alignment}.',
        },
      },
      tables: {
        type: 'array',
        description: 'Tables added after the body.',
        items: {
          type: 'object',
          required: ['headers', 'rows'],
          properties: {
            headers: {
              type: 'array',
              items: {
                type: ['string', 'number'],
                description: 'Heading text or number.',
              },
              description: 'Column headings, left to right.',
            },
            rows: {
              type: 'array',
              items: ROW_SCHEMA,
              description: 'Rows of cells in header order. Cells take inline markdown and <br>.',
            },
            layout: {
              type: 'string',
              enum: ['striped', 'minimal', 'grid'],
              description:
                "striped: alternating fills; minimal: a rule under the header; grid: all borders. Default 'striped'.",
            },
          },
        },
      },
      branding: {
        type: 'object',
        description: 'Branding for the header, footer and first page.',
        properties: {
          companyName: { type: 'string', description: 'Left side of the running header.' },
          logoPath: {
            type: 'string',
            description: 'Logo above the title; an image file name as in images.',
          },
          footerText: {
            type: 'string',
            description: 'Text at the left of every footer; \\n starts a new line (up to 6).',
          },
        },
      },
    },
    required: ['filename', 'body'],
  },
}
