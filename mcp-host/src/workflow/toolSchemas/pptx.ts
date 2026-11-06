import {
  NATIVE_CHART_TYPES,
  PPTX_ASPECT_RATIOS,
  PPTX_PALETTES,
  PPTX_TEMPLATES,
  SEVERITIES,
  SLIDE_LAYOUTS,
  STATUSES,
} from '../pptxVocabulary'
import { ROW_SCHEMA, type ToolSchema } from './shared'

// ════════════════════════════════════════════════════════════════════
// ─── PPTX GENERATION (clerum__generate_pptx) ────────────────────────
// ════════════════════════════════════════════════════════════════════
//
// The deck is built by pptxDeck.ts from arguments read by pptxInput.ts and,
// for the preset decks, pptxTemplates.ts. The workflow path validates against
// this schema before the tool runs.

// Each shape is described in full once, under slides[]. The template fields in
// `data` repeat its structure with short descriptions that point back there:
// the schema goes out with every request and JSON Schema $ref is not portable.

const PPTX_IMAGE_PATH_DESCRIPTION =
  "Image file name in the output folder, e.g. from clerum__generate_chart ('sales.png'). " +
  'PNG, JPEG, GIF, WebP or SVG.'

const PPTX_PATH_SHORT = 'File name from clerum__generate_chart.'

/** An array of short texts, or one string read as one item per line. */
function pptxTextList(description: string): Record<string, unknown> {
  return {
    anyOf: [{ type: 'array', items: { type: ['string', 'number'] } }, { type: 'string' }],
    description,
  }
}

function pptxImage(
  description: string,
  about: { path: string; caption: string; width: string; height: string }
): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: about.path },
          caption: { type: 'string', description: about.caption },
          width: { type: 'number', description: about.width },
          height: { type: 'number', description: about.height },
        },
      },
    ],
    description,
  }
}

function pptxKpis(
  description: string,
  about: { label: string; value: string; delta: string; deltaDirection: string }
): Record<string, unknown> {
  return {
    type: 'array',
    description,
    items: {
      type: 'object',
      required: ['label', 'value'],
      properties: {
        label: { type: 'string', description: about.label },
        value: { type: ['string', 'number'], description: about.value },
        delta: { type: ['string', 'number'], description: about.delta },
        deltaDirection: {
          type: 'string',
          enum: ['up', 'down', 'neutral'],
          description: about.deltaDirection,
        },
      },
    },
  }
}

function pptxTable(description: string, headers: string, rows: string): Record<string, unknown> {
  return {
    type: 'object',
    required: ['headers', 'rows'],
    description,
    properties: {
      headers: { type: 'array', items: { type: ['string', 'number'] }, description: headers },
      rows: { type: 'array', items: ROW_SCHEMA, description: rows },
    },
  }
}

/** A chart value; text such as "1,200" and {label, value} records are read too. */
const PPTX_CHART_POINT_SCHEMA = {
  anyOf: [
    { type: 'number' },
    { type: 'string' },
    { type: 'null' },
    {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Category.' },
        value: { type: ['number', 'string'], description: 'Value.' },
      },
    },
  ],
}

function pptxChartSeries(about: {
  labels: string
  datasets: string
  label: string
  data: string
}): Record<string, Record<string, unknown>> {
  return {
    labels: { type: 'array', items: { type: ['string', 'number'] }, description: about.labels },
    datasets: {
      type: 'array',
      description: about.datasets,
      items: {
        type: 'object',
        required: ['data'],
        properties: {
          label: { type: 'string', description: about.label },
          data: { type: 'array', items: PPTX_CHART_POINT_SCHEMA, description: about.data },
        },
      },
    },
  }
}

const PPTX_SERIES_SHORT = {
  labels: 'Categories.',
  datasets: 'Series.',
  label: 'Name.',
  data: 'Values.',
}

/** What a chart's fields say: in full under slides[].chart, briefly in each template chart. */
interface PptxChartAbout {
  path: string
  type: string
  title: string
  series: Parameters<typeof pptxChartSeries>[0]
  /** The labels and datasets nested under `data`; declared only where this is set. */
  nested?: string
  caption: string
}

/**
 * A chart, as slides[].chart and every template chart declare it. Both are
 * built here, so each declares the same fields with the same types and only
 * the descriptions differ: a provider or client that builds the call from the
 * declared fields sends no other, so a field named only in prose never arrives.
 */
function pptxChart(description: string, about: PptxChartAbout): Record<string, unknown> {
  return {
    type: 'object',
    description,
    properties: {
      path: { type: 'string', description: about.path },
      type: { type: 'string', enum: [...NATIVE_CHART_TYPES], description: about.type },
      title: { type: 'string', description: about.title },
      ...pptxChartSeries(about.series),
      ...(about.nested === undefined
        ? {}
        : {
            data: {
              type: 'object',
              description: about.nested,
              properties: pptxChartSeries(PPTX_SERIES_SHORT),
            },
          }),
      caption: { type: 'string', description: about.caption },
    },
  }
}

const PPTX_CHART_SCHEMA = pptxChart(
  'A native, editable chart { type, labels, datasets }, or { path } for a chart image.',
  {
    path:
      "Chart image file name from clerum__generate_chart (e.g. 'sales.png'), for " +
      'types the native list lacks. Native data given too is drawn if the file cannot be used.',
    type: 'Native chart type. Only for native charts: with path, leave it out.',
    title: 'Heading, unless it repeats the slide title.',
    series: {
      labels: 'Category labels, one per value.',
      datasets: 'Series; a pie or doughnut draws only the first.',
      label: 'Legend name.',
      data: 'One value per label; null leaves a gap.',
    },
    nested: 'Or labels and datasets nested here, as clerum__generate_chart takes them.',
    caption: 'Note under the chart.',
  }
)

/**
 * A template chart: slides[].chart with short descriptions and without its
 * nested `data` form, which the flat fields make unnecessary. The deck builder
 * reads both the same way (readChart).
 */
function pptxTemplateChart(description: string): Record<string, unknown> {
  return pptxChart(`${description} As slides[].chart.`, {
    path: PPTX_PATH_SHORT,
    type: 'Chart type.',
    title: 'Slide title.',
    series: PPTX_SERIES_SHORT,
    caption: 'Note.',
  })
}

function pptxColumn(description: string): Record<string, unknown> {
  return {
    type: 'object',
    required: ['type'],
    description,
    properties: {
      type: {
        type: 'string',
        enum: ['bullets', 'narrative', 'image'],
        description: 'Which field below it uses.',
      },
      bullets: pptxTextList("For type 'bullets'."),
      text: { type: 'string', description: "For type 'narrative'." },
      image: pptxImage("For type 'image'; as slides[].image.", {
        path: PPTX_PATH_SHORT,
        caption: 'Note.',
        width: 'Inches.',
        height: 'Inches.',
      }),
    },
  }
}

/** The fields of every template's `data`; each description names the templates that read it. */
const PPTX_TEMPLATE_DATA_PROPERTIES: Record<string, Record<string, unknown>> = {
  title: {
    type: ['string', 'number'],
    description: 'executive-brief, quarterly-review, incident-review: cover title.',
  },
  subtitle: { type: ['string', 'number'], description: 'executive-brief: line under the title.' },
  status: {
    type: 'string',
    enum: [...STATUSES],
    description: 'executive-brief, quarterly-review: cover band color.',
  },
  kpis: pptxKpis('executive-brief, quarterly-review: cards, as slides[].kpis.', {
    label: 'Label.',
    value: 'Figure.',
    delta: 'Change.',
    deltaDirection: 'Delta color.',
  }),
  charts: {
    type: 'array',
    items: pptxTemplateChart('One chart.'),
    description: 'executive-brief: one slide per chart.',
  },
  takeaways: pptxTextList('executive-brief: Key Takeaways slide.'),
  nextSteps: pptxTextList('executive-brief: Next Steps slide.'),
  period: { type: ['string', 'number'], description: 'quarterly-review: period, e.g. "Q3 2026".' },
  highlights: pptxTextList('quarterly-review: highlights.'),
  revenueChart: pptxTemplateChart('quarterly-review: revenue trend.'),
  breakdownChart: pptxTemplateChart('quarterly-review: revenue breakdown.'),
  metricsTable: pptxTable('quarterly-review: metrics, as slides[].table.', 'Headings.', 'Rows.'),
  outlook: pptxTextList('quarterly-review: next-period priorities.'),
  severity: {
    type: 'string',
    enum: [...SEVERITIES],
    description: 'incident-review: colors the cover.',
  },
  date: { type: ['string', 'number'], description: 'incident-review: when it happened.' },
  summary: { type: ['string', 'number'], description: 'incident-review: what happened, briefly.' },
  timelineTable: pptxTable(
    'incident-review: timeline, as slides[].table.',
    'e.g. ["Time", "Event"].',
    'Rows.'
  ),
  impact: pptxTextList('incident-review: who and what was affected.'),
  rootCause: { type: ['string', 'number'], description: 'incident-review: root cause.' },
  remediation: pptxTextList('incident-review: fixes made or planned.'),
  lessons: pptxTextList('incident-review: lessons learned.'),
  company: { type: ['string', 'number'], description: 'pitch-deck: company name.' },
  tagline: { type: ['string', 'number'], description: 'pitch-deck: one line under the name.' },
  problem: { type: ['string', 'number'], description: 'pitch-deck: the problem, briefly.' },
  solution: { type: ['string', 'number'], description: 'pitch-deck: the solution, briefly.' },
  marketSize: {
    type: 'object',
    required: ['value'],
    description: 'pitch-deck: addressable market.',
    properties: {
      value: { type: ['string', 'number'], description: 'e.g. "$12B".' },
      description: { type: 'string', description: 'Scope and source.' },
    },
  },
  tractionChart: pptxTemplateChart('pitch-deck: traction.'),
  team: {
    type: 'array',
    description: 'pitch-deck: one card per person.',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name.' },
        role: { type: 'string', description: 'e.g. "CEO".' },
      },
    },
  },
  ask: {
    type: 'object',
    required: ['amount'],
    description: 'pitch-deck: the raise.',
    properties: {
      amount: { type: ['string', 'number'], description: 'e.g. "$5M".' },
      useOfFunds: pptxTextList('Use of funds.'),
    },
  },
}

export const PPTX_TOOL: ToolSchema = {
  name: 'clerum__generate_pptx',
  description:
    'Generate a styled PowerPoint (.pptx) deck: set `template` and fill `data`, or pass ' +
    '`slides[]`, each with a `layout`. A list of texts may also be one string, one item per ' +
    'line. Text is plain: markdown is not read. Lists, tables and KPI cards that do not fit ' +
    'continue on further slides and long text is set smaller; the result says when.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: "e.g. 'deck.pptx'; .pptx is added if missing." },
      title: { type: 'string', description: 'File metadata; not shown on a slide.' },
      subject: { type: 'string', description: 'File metadata.' },
      author: { type: 'string', description: 'File metadata.' },
      template: {
        type: 'string',
        enum: [...PPTX_TEMPLATES, 'custom'],
        description:
          'Preset deck from `data`. Required: executive-brief title; quarterly-review title, ' +
          'period; incident-review title, severity, summary; pitch-deck company, tagline, ' +
          "problem, solution. 'custom' (default): use `slides[]`.",
      },
      data: {
        type: 'object',
        description: 'Fields for `template`.',
        properties: PPTX_TEMPLATE_DATA_PROPERTIES,
      },
      palette: {
        type: 'string',
        enum: Object.keys(PPTX_PALETTES),
        description: "Default 'default'.",
      },
      aspectRatio: {
        type: 'string',
        enum: Object.keys(PPTX_ASPECT_RATIOS),
        description: "Default 'wide' (13.33×7.5 in).",
      },
      branding: {
        type: 'object',
        description: 'Footer on every slide but the cover; logo on the cover.',
        properties: {
          companyName: { type: 'string', description: 'Footer, left.' },
          logoPath: {
            type: 'string',
            description:
              'Logo image file name in the output folder; formats as slides[].image.path.',
          },
          footerText: { type: 'string', description: 'Footer, after the company name.' },
        },
      },
      slides: {
        type: 'array',
        minItems: 1,
        description: 'The slides, in order.',
        items: {
          type: 'object',
          required: ['layout'],
          properties: {
            layout: {
              type: 'string',
              enum: [...SLIDE_LAYOUTS],
              description:
                'Needs: cover, section a title; title-bullets bullets; title-chart chart; ' +
                'title-table table; kpis kpis; two-column columns; image image; quote quote.',
            },
            title: { type: 'string', description: 'Heading.' },
            eyebrow: { type: 'string', description: 'Section: label above the title.' },
            subtitle: { type: 'string', description: 'Cover, section: line under the title.' },
            status: {
              type: 'string',
              enum: [...STATUSES],
              description: 'Cover: color of the top band.',
            },
            bullets: pptxTextList('Bullet points.'),
            table: pptxTable('A table.', 'Column headings.', 'Rows of cells, in header order.'),
            kpis: pptxKpis('Figures as cards, up to 8 per slide.', {
              label: 'What it measures.',
              value: 'A number, or formatted text, e.g. "$1.2M".',
              delta: 'Change, e.g. "+12%".',
              deltaDirection: 'Delta color: up good, down bad, neutral grey.',
            }),
            chart: PPTX_CHART_SCHEMA,
            image: pptxImage('A file name, or { path, caption, width, height }.', {
              path: PPTX_IMAGE_PATH_DESCRIPTION,
              caption: 'Note under it.',
              width:
                'Inches. With width or height the other keeps the proportions; with both the ' +
                'image fits inside that box; with neither it fills the space, up to twice its size.',
              height: 'Inches; see width.',
            }),
            quote: {
              type: 'object',
              description: 'Pull quote.',
              required: ['text'],
              properties: {
                text: { type: 'string', description: 'The words.' },
                attribution: { type: 'string', description: 'Who said it.' },
              },
            },
            columns: {
              type: 'object',
              description: 'Two columns.',
              required: ['left', 'right'],
              properties: {
                left: pptxColumn('Left column.'),
                right: pptxColumn('Right column.'),
              },
            },
            notes: { type: 'string', description: 'Speaker notes.' },
          },
        },
      },
    },
    required: ['filename'],
  },
}
