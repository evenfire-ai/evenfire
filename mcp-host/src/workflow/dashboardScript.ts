/**
 * The script that draws a dashboard's charts in the browser.
 *
 * Each chart and each sparkline is drawn on its own, so one that Chart.js
 * refuses shows why in its card and never blanks the others. Colors are read
 * from the page's CSS variables and read again when the color scheme or the
 * print media changes, so the series stay legible in light, dark and print.
 * Animation is off: headless HTML-to-PDF converters print a chart the moment it
 * is created, which with animation on is at a fraction of its height.
 */

const PAGE_SCRIPT = String.raw`
(function () {
  'use strict';
  var charts = __CHARTS__;
  var root = document.documentElement;
  var instances = [];
  var COLOR_KEYS = ['backgroundColor', 'borderColor', 'pointBackgroundColor'];

  function cssVar(name) {
    return getComputedStyle(root).getPropertyValue(name).trim();
  }

  function withAlpha(color, alpha) {
    var m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    var n = parseInt(m[1], 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function paint(value) {
    if (Array.isArray(value)) return value.map(paint);
    if (typeof value !== 'string' || value.charAt(0) !== '$') return value;
    var parts = value.slice(1).split('@');
    var series = /^chart-(\d+)$/.exec(parts[0]);
    var color = cssVar(series ? '--chart-' + ((Number(series[1]) % 7) + 1) : '--' + parts[0]);
    return parts.length > 1 ? withAlpha(color, Number(parts[1])) : color;
  }

  function paintDatasets(spec) {
    return spec.datasets.map(function (ds) {
      var out = Object.assign({}, ds);
      COLOR_KEYS.forEach(function (key) {
        if (ds[key] !== undefined) out[key] = paint(ds[key]);
      });
      return out;
    });
  }

  function options(spec) {
    var text = cssVar('--text-muted');
    var grid = cssVar('--border');
    function axis(title) {
      var out = {
        stacked: spec.stacked,
        ticks: { color: text },
        grid: { color: grid },
        title: title ? { display: true, text: title, color: text } : { display: false },
      };
      // Set only where needed: an explicit false would override the bar charts' own zero baseline.
      if (spec.stacked) out.beginAtZero = true;
      return out;
    }
    var scales;
    if (spec.axes === 'cartesian') {
      scales = { x: axis(spec.xAxisLabel), y: axis(spec.yAxisLabel) };
    } else if (spec.axes === 'radial') {
      scales = {
        r: {
          ticks: { color: text, backdropColor: cssVar('--surface') },
          grid: { color: grid },
          angleLines: { color: grid },
          pointLabels: { color: text },
        },
      };
    }
    var labels = { color: text };
    // Chart.js sorts the legend by dataset "order", which mixed charts set to draw lines on top.
    if (spec.datasets.some(function (ds) { return ds.order !== undefined; })) {
      labels.sort = function (a, b) { return a.datasetIndex - b.datasetIndex; };
    }
    var result = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      indexAxis: spec.indexAxis,
      plugins: { legend: { display: spec.legend, labels: labels } },
      scales: scales,
    };
    if (spec.gauge) {
      result.rotation = -90;
      result.circumference = 180;
      result.cutout = '70%';
      result.plugins.tooltip = { enabled: false };
    }
    return result;
  }

  function gaugeReadout(spec) {
    return {
      id: 'gaugeReadout',
      afterDatasetsDraw: function (chart) {
        var arc = chart.getDatasetMeta(0).data[0];
        if (!arc) return;
        var ctx = chart.ctx;
        var size = Math.max(16, Math.min(40, arc.innerRadius * 0.45));
        ctx.save();
        ctx.textAlign = 'center';
        ctx.fillStyle = cssVar('--text');
        ctx.font = '700 ' + size + 'px ' + cssVar('--font');
        ctx.fillText(spec.gauge.value, arc.x, arc.y - size * 0.7);
        ctx.fillStyle = cssVar('--text-muted');
        ctx.font = '500 ' + Math.round(size * 0.45) + 'px ' + cssVar('--font');
        ctx.fillText('/ ' + spec.gauge.max, arc.x, arc.y - size * 0.05);
        ctx.restore();
      },
    };
  }

  function message(err) {
    return err && err.message ? err.message : String(err);
  }

  function discard(canvas) {
    var drawn = typeof Chart !== 'undefined' && Chart.getChart(canvas);
    if (drawn) drawn.destroy();
  }

  function draw(spec) {
    var canvas = document.getElementById(spec.id);
    if (!canvas) return;
    try {
      if (typeof Chart === 'undefined') throw new Error('the chart library did not load');
      var chart = new Chart(canvas, {
        type: spec.type,
        data: { labels: spec.labels, datasets: paintDatasets(spec) },
        options: options(spec),
        plugins: spec.gauge ? [gaugeReadout(spec)] : [],
      });
      instances.push({ chart: chart, spec: spec });
    } catch (err) {
      discard(canvas);
      var note = document.createElement('p');
      note.className = 'chart-card__note';
      note.textContent = 'This chart could not be drawn: ' + message(err);
      (canvas.parentNode || canvas).replaceWith(note);
    }
  }

  function sparkline(canvas) {
    try {
      var data = JSON.parse(canvas.getAttribute('data-spark') || '[]');
      var chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels: data.map(function (_, i) { return i; }),
          datasets: [{
            data: data,
            borderColor: paint('$accent'),
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
      instances.push({ chart: chart });
    } catch (err) {
      discard(canvas);
      if (canvas.parentNode) canvas.parentNode.remove();
    }
  }

  function retheme() {
    instances.forEach(function (it) {
      try {
        if (it.spec) {
          var painted = paintDatasets(it.spec);
          it.chart.data.datasets.forEach(function (ds, i) {
            COLOR_KEYS.forEach(function (key) {
              if (painted[i][key] !== undefined) ds[key] = painted[i][key];
            });
          });
          it.chart.options = options(it.spec);
        } else {
          it.chart.data.datasets[0].borderColor = paint('$accent');
        }
        // Not update('none'): that mode keeps the shared element options, so
        // bars and points would stay in the previous scheme's colors.
        it.chart.update();
      } catch (err) {
        // Keep the chart as it was drawn.
      }
    });
  }

  charts.forEach(draw);
  document.querySelectorAll('canvas.kpi-card__sparkline[data-spark]').forEach(sparkline);

  ['(prefers-color-scheme: dark)', 'print'].forEach(function (query) {
    var media = window.matchMedia && window.matchMedia(query);
    if (media && media.addEventListener) media.addEventListener('change', retheme);
  });
  window.addEventListener('beforeprint', function () {
    instances.forEach(function (it) { it.chart.resize(); });
  });
})();
`.trim()

/**
 * The page script for a dashboard. `chartsJson` is the list of ClientChart
 * specs, already serialized so it cannot close the script element.
 */
export function dashboardScript(chartsJson: string): string {
  return PAGE_SCRIPT.replace('__CHARTS__', () => chartsJson)
}
