import {
  DEFAULT_CHART_HEIGHT,
  DEFAULT_CHART_WIDTH,
  MAX_CHART_DIMENSION,
  MIN_CHART_DIMENSION,
} from '../chartThemes'
import { type ToolSchema } from './shared'

/** A single color, or one per data point. */
function colorSchema(what: string): Record<string, unknown> {
  return {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: `${what}: a hex color, or an array of one per point.`,
  }
}

/**
 * One chart data point. Numbers are the norm; the rest are shapes models send
 * that normalizeChartData repairs or needs — text such as "1,200", null for a
 * gap, {x, y[, r]} or [x, y[, r]] for scatter and bubble, {x, y} with a
 * category x, and {label, value} records or [label, value] pairs.
 */
const CHART_POINT_SCHEMA = {
  anyOf: [
    { type: 'number' },
    { type: 'string' },
    { type: 'null' },
    { type: 'array', items: { type: ['number', 'string'] } },
    {
      type: 'object',
      properties: {
        x: { type: ['number', 'string'], description: 'X value.' },
        y: { type: 'number', description: 'Y value.' },
        r: { type: 'number', description: 'Bubble radius (px).' },
        label: { type: 'string', description: 'Category.' },
        value: { type: ['number', 'string'], description: 'Value.' },
      },
    },
  ],
  description: 'A number, null for a gap, or {x, y} / {x, y, r} or [x, y] for scatter / bubble.',
}

export const CHART_TOOL: ToolSchema = {
  name: 'clerum__generate_chart',
  description:
    'Render a chart as a PNG image, with values printed on it by default. Returns the file ' +
    'name it was saved under, such as "sales.png"; pass it as images[].path to the PDF or ' +
    'DOCX generator, as sheets[].images[].path to the XLSX generator, or as a PPTX slide ' +
    'image.path or chart.path.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: "Output filename (e.g. 'revenue.png'); .png added if missing.",
      },
      type: {
        type: 'string',
        enum: [
          'line',
          'bar',
          'horizontalBar',
          'pie',
          'doughnut',
          'area',
          'scatter',
          'radar',
          'polarArea',
          'bubble',
          'stackedBar',
          'stackedArea',
          'mixedBarLine',
          'gauge',
          'waterfall',
          'funnel',
        ],
        description:
          'area: filled line. mixedBarLine: first dataset as bars, the rest as lines. ' +
          'gauge: one value 0..gaugeMax as a half dial. waterfall: one series of deltas, ' +
          'drawn as steps plus a total bar. funnel: one series, sorted descending.',
      },
      title: {
        type: 'string',
        description: 'Title above the plot. Always set one.',
      },
      width: {
        type: 'number',
        description:
          `Width in px (default ${DEFAULT_CHART_WIDTH}, ${MIN_CHART_DIMENSION}-${MAX_CHART_DIMENSION}; ` +
          'width × height up to about 13 million). The PNG is up to 2× this.',
      },
      height: {
        type: 'number',
        description: `Height in px (default ${DEFAULT_CHART_HEIGHT}, ${MIN_CHART_DIMENSION}-${MAX_CHART_DIMENSION}).`,
      },
      theme: {
        type: 'string',
        enum: ['light', 'dark', 'corporate', 'warm', 'warm-dark'],
        description: "Color theme. Default 'light'.",
      },
      data: {
        type: 'object',
        description: 'Series to plot. Colors come from the theme unless a dataset sets them.',
        properties: {
          labels: {
            type: 'array',
            items: { type: ['string', 'number'] },
            description:
              'One per value: X-axis categories, or slice names (required) for ' +
              'pie/doughnut/polarArea. Unused by scatter/bubble.',
          },
          datasets: {
            type: 'array',
            description: 'One or more series.',
            items: {
              type: 'object',
              required: ['data'],
              properties: {
                label: {
                  type: 'string',
                  description: 'Series name, shown in the legend.',
                },
                data: {
                  type: 'array',
                  items: CHART_POINT_SCHEMA,
                  description: 'One point per label, in labels order.',
                },
                backgroundColor: colorSchema('Fill color'),
                borderColor: colorSchema('Line/border color'),
                fill: { type: 'boolean', description: 'Fill under a line series.' },
              },
            },
          },
        },
        required: ['datasets'],
      },
      yAxisLabel: { type: 'string', description: 'Y-axis title, e.g. "USD".' },
      xAxisLabel: { type: 'string', description: 'X-axis title.' },
      showValues: {
        type: 'boolean',
        description:
          'Print each value on the chart. Default on, except scatter, bubble, radar, gauge and stacked types.',
      },
      valueFormat: {
        type: 'string',
        enum: ['auto', 'plain', 'compact', 'currency', 'percent'],
        description:
          'Number style on the chart and value axis. auto: abbreviate above 10,000; compact: ' +
          'always (1.2M); currency: prefix currencySymbol; percent: append %.',
      },
      currencySymbol: {
        type: 'string',
        description: "For valueFormat 'currency'. Default '$'.",
      },
      decimals: {
        type: 'number',
        description: 'Decimal places on printed values. Default: per value.',
      },
      showLegend: {
        type: 'boolean',
        description:
          'Legend on or off. Default: on for several series, or one the titles do not name.',
      },
      dualAxis: {
        type: 'boolean',
        description: 'mixedBarLine only: put the line series on a second, right-hand axis.',
      },
      gaugeMax: {
        type: 'number',
        description: 'gauge only: dial maximum (default 100).',
      },
    },
    required: ['filename', 'type', 'data'],
  },
}
