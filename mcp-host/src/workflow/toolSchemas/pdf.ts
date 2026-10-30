import { IMAGE_FILE_DESCRIPTION, PDF_MAX_FOOTER_LINES, PDF_PORTRAIT_WIDTH } from '../documentSchema'
import { ROW_SCHEMA, type ToolSchema } from './shared'

// ─── generate_pdf ────────────────────────────────────────────────────

/** Drawn size for a spreadsheet image, in pixels. */

export const PDF_TOOL: ToolSchema = {
  name: 'clerum__generate_pdf',
  description:
    'Generate a print-quality PDF from a markdown body, with optional images, tables, a cover ' +
    'page with a status band, page numbers and a branded footer.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename, e.g. 'report.pdf'.",
      },
      title: {
        type: 'string',
        description: 'Document title, shown at the top of the first page.',
      },
      body: {
        type: 'string',
        description:
          'Markdown: # to ### headings, **bold**, *italic*, ~~strike~~, `code`, [links](url), ' +
          'fenced code, "- " and "1. " lists, GFM pipe tables, "> " quotes, "---" rules, <br>/<b>/<i>, ' +
          'and ![alt](file.png) on its own line to place an image from the output folder.',
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      coverPage: {
        type: 'boolean',
        description: 'Add a cover page with the title, headline, logo and status band.',
      },
      headline: {
        type: 'string',
        description: 'One-line subtitle under the title on the cover page.',
      },
      statusColor: {
        type: 'string',
        enum: ['green', 'yellow', 'red'],
        description: 'Color of the status band on the cover page.',
      },
      images: {
        type: 'array',
        description:
          'Images (charts, logos) placed after the body and tables, in order; ' +
          'put ![alt](file.png) on a line of the body to place one there.',
        items: {
          anyOf: [
            { type: 'string', description: IMAGE_FILE_DESCRIPTION },
            {
              type: 'object',
              required: ['path'],
              properties: {
                path: { type: 'string', description: IMAGE_FILE_DESCRIPTION },
                width: {
                  type: 'number',
                  description: `Width in points (the page is ${PDF_PORTRAIT_WIDTH} wide); the height follows.`,
                },
                height: {
                  type: 'number',
                  description: 'Height in points. With width too, the image fits inside both.',
                },
                alignment: {
                  type: 'string',
                  enum: ['left', 'center', 'right'],
                  description: "Default 'center'.",
                },
              },
            },
          ],
          description: 'A file name, or an object with path and size.',
        },
      },
      tables: {
        type: 'array',
        description: 'Tables placed after the body.',
        items: {
          type: 'object',
          required: ['headers', 'rows'],
          properties: {
            headers: {
              type: 'array',
              items: { type: ['string', 'number'], description: 'One column heading.' },
              description: 'Column headings, left to right.',
            },
            rows: {
              type: 'array',
              items: ROW_SCHEMA,
              description: 'Rows, each an array of cells in header order.',
            },
            widths: {
              type: 'array',
              items: { type: ['string', 'number'], description: 'One column width.' },
              description:
                "One per header: points, a percentage such as '30%', 'auto' or '*' (share the rest). " +
                'Omit to size columns by content.',
            },
            layout: {
              type: 'string',
              enum: ['striped', 'minimal', 'grid'],
              description: "Default 'striped'.",
            },
          },
        },
      },
      branding: {
        type: 'object',
        description: 'Header and footer branding.',
        properties: {
          logoPath: {
            type: 'string',
            description: `Logo drawn on the cover page (needs coverPage: true). ${IMAGE_FILE_DESCRIPTION}`,
          },
          companyName: {
            type: 'string',
            description: 'Shown in the running header.',
          },
          footerText: {
            type: 'string',
            description: `Footer on every page, up to ${PDF_MAX_FOOTER_LINES} lines.`,
          },
        },
      },
    },
    required: ['filename', 'body'],
  },
}
