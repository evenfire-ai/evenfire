/** The Chart.js bundle a dashboard inlines, read once. */
import * as fs from 'fs'
import * as path from 'path'

let cachedChartJsBundle: string | undefined

/**
 * The Chart.js UMD bundle. chart.js exports only ".", "./auto" and
 * "./helpers", so resolving "chart.js/dist/chart.umd.js" throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED; the entry point resolves, and the bundle sits
 * beside it in dist/.
 */
export function loadChartJsBundle(): string {
  if (cachedChartJsBundle) return cachedChartJsBundle
  const bundle = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js')
  cachedChartJsBundle = fs.readFileSync(bundle, 'utf-8')
  return cachedChartJsBundle
}
