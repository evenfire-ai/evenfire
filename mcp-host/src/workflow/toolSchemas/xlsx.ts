import { RECORD_ROW_SCHEMA, type ToolSchema } from './shared'

// ─── generate_xlsx ───────────────────────────────────────────────────

const XLSX_CELL_SCHEMA = {
  type: ['string', 'number', 'boolean', 'null'],
  description:
    'A number, text, true/false, or null for empty. Text like "1,234.50", "$1,200", "45%" ' +
    'or an ISO date or datetime ("2026-09-22") is stored as a number or date; leading-zero codes and ' +
    'numbers over 15 digits stay text.',
}

const XLSX_IMAGE_PATH_DESCRIPTION =
  "File name in the output folder, as returned by clerum__generate_chart (e.g. 'sales.png')."

const XLSX_COLOR = 'hex such as "#1e3a8a" or a basic color name such as "green"'

export const XLSX_TOOL: ToolSchema = {
  name: 'clerum__generate_xlsx',
  description:
    'Generate a styled Excel (.xlsx) workbook: per sheet, rows plus an optional title row, ' +
    'column formats, conditional formatting and images such as charts. Formulas are not ' +
    'supported: text starting with "=" stays text.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'data.xlsx'); .xlsx added if missing.",
      },
      palette: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: "Color palette. Default 'default'.",
      },
      branding: {
        type: 'object',
        description: 'Workbook-level branding.',
        properties: {
          companyName: { type: 'string', description: 'Author/company in workbook properties.' },
          logoPath: {
            type: 'string',
            description:
              'Logo at the top of the first sheet; an image file name as in sheets[].images.',
          },
        },
      },
      sheets: {
        type: 'array',
        description: 'Worksheets, in tab order.',
        items: {
          type: 'object',
          required: ['name', 'rows'],
          properties: {
            name: {
              type: 'string',
              description: 'Tab name: up to 31 characters, none of \\ / ? * : [ ].',
            },
            headers: {
              type: 'array',
              description: 'Header row, when it is not the first row of rows.',
              items: { type: ['string', 'number'], description: 'Column header.' },
            },
            rows: {
              type: 'array',
              description:
                'Rows of cells; the first is the header row unless headers is given. [] for an images-only sheet.',
              items: {
                anyOf: [
                  {
                    type: 'array',
                    description: 'One row, left to right.',
                    items: XLSX_CELL_SCHEMA,
                  },
                  RECORD_ROW_SCHEMA,
                ],
              },
            },
            titleRow: {
              type: 'object',
              description: 'Merged title row above the header.',
              properties: {
                text: { type: 'string', description: 'Title text.' },
                fillColor: { type: 'string', description: `Background: ${XLSX_COLOR}.` },
                fontColor: { type: 'string', description: `Text color: ${XLSX_COLOR}.` },
              },
              required: ['text'],
            },
            columnFormats: {
              type: 'object',
              description:
                "Format per column, keyed by header text, letter ('B') or 0-based index: " +
                'currencyUsd, currencyUsdInt, currency:EUR (any ISO code), percent (0.45 = 45%), ' +
                'percentPoints (45 = 45%), integer, decimal, plain (no separators: years, IDs), ' +
                "date, datetime, text (as sent), or an Excel code like '#,##0.0'. Others are inferred.",
            },
            conditionalFormatting: {
              type: 'array',
              description: "Style a column's cells that match a rule.",
              items: {
                type: 'object',
                required: ['column', 'rules'],
                properties: {
                  column: {
                    type: ['string', 'number'],
                    description: "Header text, letter ('B') or 0-based index.",
                  },
                  rules: {
                    type: 'array',
                    description:
                      "Tested in order; the first match styles the cell. '45%' compares as 45, '$1,200' as 1200.",
                    items: {
                      type: 'object',
                      properties: {
                        equals: {
                          type: ['string', 'number', 'boolean'],
                          description: 'Cell equals this (text ignores case and outer spaces).',
                        },
                        notEquals: {
                          type: ['string', 'number', 'boolean'],
                          description: 'Cell differs from this, compared as for equals.',
                        },
                        greaterThan: {
                          type: 'number',
                          description: 'Cell is a number above this.',
                        },
                        lessThan: {
                          type: 'number',
                          description: 'Cell is a number below this.',
                        },
                        between: {
                          type: 'array',
                          items: { type: 'number' },
                          minItems: 2,
                          maxItems: 2,
                          description: 'Inclusive [min, max].',
                        },
                        contains: {
                          type: 'string',
                          description: 'Cell text contains this, ignoring case.',
                        },
                        regex: {
                          type: 'string',
                          maxLength: 256,
                          description:
                            'Regex tested on the cell text. Invalid patterns and nested unbounded quantifiers are skipped with a warning.',
                        },
                        fillColor: {
                          type: 'string',
                          description: `Background: ${XLSX_COLOR}.`,
                        },
                        fontColor: {
                          type: 'string',
                          description: `Text color: ${XLSX_COLOR}.`,
                        },
                        bold: {
                          type: 'boolean',
                          description: 'Bold the text.',
                        },
                      },
                    },
                  },
                },
              },
            },
            freezeHeader: {
              type: 'boolean',
              description: 'Freeze the header row. Default true.',
            },
            autoFilter: {
              type: 'boolean',
              description: 'Filter buttons on the header. Default true.',
            },
            images: {
              type: 'array',
              description:
                'Images such as charts; without anchor or range they stack below the data.',
              items: {
                anyOf: [
                  { type: 'string', description: XLSX_IMAGE_PATH_DESCRIPTION },
                  {
                    type: 'object',
                    required: ['path'],
                    properties: {
                      path: { type: 'string', description: 'Same as the string form.' },
                      anchor: { type: 'string', description: "Top-left cell, e.g. 'F2'." },
                      range: { type: 'string', description: "Cells to fill, e.g. 'F2:M20'." },
                      width: {
                        type: 'number',
                        description: 'Width in px; proportions are kept. Omit for automatic.',
                      },
                      height: { type: 'number', description: 'Height in px; as for width.' },
                    },
                  },
                ],
                description: 'An image file name, or {path, anchor | range, width, height}.',
              },
            },
          },
        },
      },
    },
    required: ['filename', 'sheets'],
  },
}
