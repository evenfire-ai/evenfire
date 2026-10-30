import {
  BLOCK_TYPES,
  CALLOUT_TONES,
  DASHBOARD_CHART_TYPES,
  DASHBOARD_TEMPLATE_NAMES,
  HERO_STATUSES,
  SECTION_TYPES,
} from '../dashboardVocabulary'
import { ROW_SCHEMA, type ToolSchema } from './shared'

// ════════════════════════════════════════════════════════════════════
// ─── DASHBOARD GENERATION (clerum__generate_dashboard) ──────────────
// ════════════════════════════════════════════════════════════════════
//
// Self-contained HTML dashboard renderer. Produces a single .html file
// with inlined CSS, plus the Chart.js bundle when the page has charts;
// works offline and prints cleanly.
//
// Templates (4 fixed presets):
//   - executive-brief   general-purpose daily/weekly executive report
//   - operations-pulse  engineering / SRE / oncall view
//   - financial-review  finance with hero chart + dense tables
//   - technical-report  long-form engineering writeup with code blocks
//
// Themes: default | corporate | warm | alert (light + dark variants)

const DELTA_DIRECTION_SCHEMA = {
  type: 'string',
  enum: ['up', 'down', 'neutral'],
  description: 'Arrow direction.',
}

const DASH_KPI_SCHEMA = {
  type: 'object',
  required: ['label', 'value'],
  properties: {
    label: { type: 'string', description: 'What it measures.' },
    value: { type: ['string', 'number'], description: 'Number or formatted text, e.g. "$1.2M".' },
    delta: { type: ['string', 'number'], description: 'Change, e.g. "+12%" or -0.3.' },
    deltaDirection: DELTA_DIRECTION_SCHEMA,
    deltaSentiment: {
      type: 'string',
      enum: ['good', 'bad', 'neutral'],
      description:
        'Delta color: good green, bad red. Default follows the arrow (up good); churn falling ' +
        'is down + good.',
    },
    sparkline: {
      type: 'array',
      items: { type: ['number', 'string', 'null'] },
      description: 'Trend, oldest first, 2+ numbers.',
    },
    accent: {
      type: 'string',
      enum: ['success', 'warning', 'danger', 'neutral'],
      description: 'Top bar color.',
    },
  },
}

const XYR_PROPERTIES = {
  x: { type: ['number', 'string'], description: 'X.' },
  y: { type: 'number', description: 'Y.' },
  r: { type: 'number', description: 'Radius (px).' },
}

/**
 * One chart value: a number, text such as "1,200", null for a gap, an [x, y]
 * or [label, value] pair, or an object.
 */
function dashPoint(objectProperties: Record<string, unknown>): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'number' },
      { type: 'string' },
      { type: 'null' },
      { type: 'array', items: { type: ['number', 'string'] } },
      { type: 'object', properties: objectProperties },
    ],
  }
}

/** normalizeChartData also reads {label, value} records. */
const DASH_POINT_SCHEMA = dashPoint({
  ...XYR_PROPERTIES,
  label: { type: 'string', description: 'Category.' },
  value: { type: ['number', 'string'], description: 'Value.' },
})

function dashColor(what: string): Record<string, unknown> {
  return {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: `${what}: hex, or one per point.`,
  }
}

const DASH_CHART_SCHEMA = {
  type: 'object',
  required: ['type', 'datasets'],
  properties: {
    type: {
      type: 'string',
      enum: [...DASHBOARD_CHART_TYPES],
      description:
        'As in clerum__generate_chart. area: filled line; stacked*: stacked series; ' +
        'mixedBarLine: 1st series bars, rest lines; gauge: 1st value on a 0-gaugeMax dial; ' +
        'waterfall: steps, then the total; funnel: one series, descending; scatter, bubble: ' +
        '{x, y[, r]} points.',
    },
    title: { type: 'string', description: 'Heading.' },
    labels: {
      type: 'array',
      items: { type: ['string', 'number'] },
      description: 'X categories or slice names, one per value.',
    },
    datasets: {
      type: 'array',
      description: 'Series.',
      items: {
        type: 'object',
        required: ['data'],
        properties: {
          label: { type: 'string', description: 'Legend name.' },
          data: {
            type: 'array',
            items: DASH_POINT_SCHEMA,
            description: 'One value per label; null for a gap.',
          },
          backgroundColor: dashColor('Fill'),
          borderColor: dashColor('Line'),
          fill: { type: 'boolean', description: 'Fill under a line.' },
        },
      },
    },
    yAxisLabel: { type: 'string', description: 'Y-axis title.' },
    xAxisLabel: { type: 'string', description: 'X-axis title.' },
    gaugeMax: { type: ['number', 'string'], description: 'Gauge dial end (default 100).' },
  },
}

const CHART_POINTER = 'As data.charts[].'

/**
 * The data.charts[] fields that carry a contract (type enum, required series,
 * value types), for the places that repeat that shape and point to it for the
 * rest: every model request carries the schema.
 */
const CHART_COPY_PROPERTIES = {
  type: { type: 'string', enum: [...DASHBOARD_CHART_TYPES], description: CHART_POINTER },
  title: { type: 'string', description: 'Heading.' },
  labels: { type: 'array', items: { type: ['string', 'number'] }, description: CHART_POINTER },
  datasets: {
    type: 'array',
    description: CHART_POINTER,
    items: {
      type: 'object',
      required: ['data'],
      properties: {
        label: { type: 'string', description: 'Legend name.' },
        data: { type: 'array', items: dashPoint(XYR_PROPERTIES), description: CHART_POINTER },
      },
    },
  },
  gaugeMax: { type: ['number', 'string'], description: CHART_POINTER },
}

const DASH_TABLE_SCHEMA = {
  type: 'object',
  required: ['headers', 'rows'],
  properties: {
    title: { type: 'string', description: 'Heading.' },
    headers: {
      type: 'array',
      items: { type: ['string', 'number'] },
      description: 'Column headings.',
    },
    rows: { type: 'array', items: ROW_SCHEMA, description: 'Rows, cells in header order.' },
    columnTypes: {
      type: 'object',
      // Gemini rejects an object schema with no properties, so the map declares
      // one example key. additionalProperties, which Gemini's SDK drops, keeps
      // the other keys valid and marks the object as a map.
      properties: {
        '0': { type: 'string', description: 'Column 0: plain, severity, priority or status.' },
      },
      // A plain string, not an enum: an unknown type shows the column as plain
      // text with a note, the same on every path, as it did before types were listed.
      additionalProperties: { type: 'string' },
      description:
        'Badge columns: header or 0-based index to plain, severity, priority or status, e.g. ' +
        '{"Status": "severity"}. Values such as critical, high, medium, low, info, p0-p2, ' +
        'healthy, degraded, down then show as colored badges.',
    },
  },
}

const DASH_SERVICE_SCHEMA = {
  type: 'object',
  required: ['name', 'status'],
  properties: {
    name: { type: 'string', description: 'Name.' },
    status: {
      type: 'string',
      description: 'Card color: healthy, degraded, down or maintenance.',
    },
    metric: { type: ['string', 'number'], description: 'e.g. "142 ms".' },
    delta: { type: ['string', 'number'], description: 'e.g. "+0.2pp".' },
    deltaDirection: DELTA_DIRECTION_SCHEMA,
  },
}

const DASH_INCIDENT_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    time: { type: 'string', description: 'Start, e.g. "10:42".' },
    title: { type: 'string', description: 'What happened.' },
    severity: { type: 'string', description: 'critical, high, medium, low or info (default).' },
    description: { type: 'string', description: 'Detail.' },
    resolvedAt: { type: 'string', description: 'When resolved; unset shows it open.' },
  },
}

const DASH_SECTION_CONTENT_SCHEMA = {
  anyOf: [{ type: ['string', 'number'] }, { type: 'array', items: { type: ['string', 'number'] } }],
  description: 'A paragraph, or an array of paragraphs or bullets. Inline markdown.',
}

const HERO_ONLY = 'hero: as in data.'

export const DASHBOARD_TOOL: ToolSchema = {
  name: 'clerum__generate_dashboard',
  description:
    'Generate a standalone HTML dashboard: one .html file, CSS and Chart.js inlined, that ' +
    'works offline, follows light/dark mode and prints cleanly. Templates: executive-brief ' +
    '(general), operations-pulse (+services, incidents), financial-review (+heroChart, ' +
    'period), technical-report (sections first), custom (data.blocks[] only). The result ' +
    'lists anything not shown, to fix and regenerate.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Output name; .html added if missing.' },
      template: {
        type: 'string',
        enum: [...DASHBOARD_TEMPLATE_NAMES],
        description: 'Default executive-brief.',
      },
      theme: {
        type: 'string',
        enum: ['default', 'corporate', 'warm', 'alert'],
        description: 'default slate, corporate navy, warm amber, alert rose.',
      },
      defaultThemeMode: {
        type: 'string',
        enum: ['light', 'dark'],
        description: "Omit to follow the viewer's color scheme; set to force it.",
      },
      inlineChartJs: {
        type: 'boolean',
        description:
          'Default true (adds ~210 KB when charts are used). false: charts become value tables, ' +
          'no sparklines.',
      },
      branding: {
        type: 'object',
        description: 'Footer.',
        properties: {
          companyName: { type: 'string', description: 'Left side.' },
          footerText: { type: 'string', description: 'Beside the date.' },
        },
      },
      data: {
        type: 'object',
        description:
          'Page content. A field that names a template shows only in it; custom reads only ' +
          'title, blocks and meta.',
        required: ['title'],
        properties: {
          eyebrow: { type: 'string', description: 'Label above the title.' },
          title: { type: 'string', description: 'Heading.' },
          headline: { type: 'string', description: 'Summary under the title.' },
          status: {
            type: 'string',
            enum: [...HERO_STATUSES],
            description: 'Badge beside the title.',
          },
          statusLabel: { type: 'string', description: 'Badge text, e.g. "On track".' },
          period: {
            type: 'string',
            description: 'financial-review: e.g. "Q3 2026", above the title if no eyebrow.',
          },
          kpis: { type: 'array', description: 'Figure cards.', items: DASH_KPI_SCHEMA },
          charts: { type: 'array', description: 'Chart cards.', items: DASH_CHART_SCHEMA },
          heroChart: {
            type: 'object',
            required: ['type', 'datasets'],
            description: `financial-review: one wide chart above charts. ${CHART_POINTER}`,
            properties: CHART_COPY_PROPERTIES,
          },
          services: {
            type: 'array',
            description: 'operations-pulse: status cards.',
            items: DASH_SERVICE_SCHEMA,
          },
          incidents: {
            type: 'array',
            description: 'operations-pulse: timeline, in order.',
            items: DASH_INCIDENT_SCHEMA,
          },
          tables: { type: 'array', description: 'Tables.', items: DASH_TABLE_SCHEMA },
          sections: {
            type: 'array',
            description: 'Prose after the tables.',
            items: {
              type: 'object',
              required: ['type', 'content'],
              properties: {
                title: { type: 'string', description: 'Heading.' },
                type: {
                  type: 'string',
                  enum: [...SECTION_TYPES],
                  description: 'Paragraphs, list, tinted box or monospaced block.',
                },
                content: DASH_SECTION_CONTENT_SCHEMA,
                tone: { type: 'string', enum: [...CALLOUT_TONES], description: 'callout color.' },
                language: { type: 'string', description: 'code language label.' },
              },
            },
          },
          blocks: {
            type: 'array',
            description: 'custom: blocks in page order; each field names the types that read it.',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string', enum: [...BLOCK_TYPES], description: 'Block type.' },
                title: { type: 'string', description: 'Heading (hero: page title).' },
                eyebrow: { type: 'string', description: HERO_ONLY },
                headline: { type: 'string', description: HERO_ONLY },
                status: { type: 'string', enum: [...HERO_STATUSES], description: HERO_ONLY },
                statusLabel: { type: 'string', description: HERO_ONLY },
                items: {
                  type: 'array',
                  items: {
                    anyOf: [
                      { type: ['string', 'number'] },
                      {
                        type: 'object',
                        properties: {
                          label: { type: ['string', 'number'], description: 'KPI label.' },
                          value: { type: ['string', 'number'], description: 'KPI value.' },
                          delta: { type: ['string', 'number'], description: 'KPI delta.' },
                          deltaDirection: DELTA_DIRECTION_SCHEMA,
                          deltaSentiment: {
                            ...DASH_KPI_SCHEMA.properties.deltaSentiment,
                            description: 'As data.kpis[].',
                          },
                          accent: {
                            ...DASH_KPI_SCHEMA.properties.accent,
                            description: 'KPI accent.',
                          },
                          ...CHART_COPY_PROPERTIES,
                          time: { type: 'string', description: 'Incident time.' },
                          severity: DASH_INCIDENT_SCHEMA.properties.severity,
                          resolvedAt: { type: 'string', description: 'As data.incidents[].' },
                          title: { type: 'string', description: 'Chart or incident title.' },
                        },
                      },
                    ],
                  },
                  description:
                    'bullets: strings. kpis, charts-grid, incidents: objects as in ' +
                    'data.kpis[], charts[], incidents[].',
                },
                services: {
                  type: 'array',
                  description: 'service-health: as in data.services[].',
                  items: {
                    type: 'object',
                    required: ['name', 'status'],
                    properties: {
                      name: { type: 'string', description: 'Name.' },
                      status: DASH_SERVICE_SCHEMA.properties.status,
                      deltaDirection: DELTA_DIRECTION_SCHEMA,
                    },
                  },
                },
                spec: {
                  type: 'object',
                  properties: {
                    ...CHART_COPY_PROPERTIES,
                    headers: DASH_TABLE_SCHEMA.properties.headers,
                    rows: {
                      type: 'array',
                      items: ROW_SCHEMA,
                      description: 'As data.tables[].',
                    },
                  },
                  description: 'chart: as data.charts[]; table: as data.tables[].',
                },
                content: {
                  ...DASH_SECTION_CONTENT_SCHEMA,
                  description: 'narrative, code, callout: as data.sections[].content.',
                },
                language: { type: 'string', description: 'code: label.' },
                tone: { type: 'string', enum: [...CALLOUT_TONES], description: 'callout: color.' },
                size: { type: 'string', enum: ['sm', 'md', 'lg'], description: 'spacer: height.' },
              },
            },
          },
          meta: {
            type: 'object',
            description: 'Footer provenance.',
            properties: {
              date: { type: ['string', 'number'], description: 'Default: today.' },
              author: { type: 'string', description: 'Author.' },
              runId: { type: 'string', description: 'Run ID.' },
            },
          },
        },
      },
    },
    required: ['filename', 'data'],
  },
}
