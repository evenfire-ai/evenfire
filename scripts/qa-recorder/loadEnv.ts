import fs from 'node:fs'
import path from 'node:path'

const QA_RECORDER_ENV_FILENAME = '.env.qa-recorder'
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

function parseValue(rawValue: string): string {
  const value = rawValue.trim()
  if (value.length < 2) return value

  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

export function loadQaRecorderEnv(repoRoot: string): string | undefined {
  const envPath = path.join(repoRoot, QA_RECORDER_ENV_FILENAME)
  if (!fs.existsSync(envPath)) return undefined

  const lines = fs
    .readFileSync(envPath, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
  for (const [index, sourceLine] of lines.entries()) {
    const line = sourceLine.trim()
    if (!line || line.startsWith('#')) continue

    const declaration = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separator = declaration.indexOf('=')
    if (separator < 1) {
      throw new Error(`${QA_RECORDER_ENV_FILENAME}:${index + 1} must use KEY=value syntax.`)
    }

    const key = declaration.slice(0, separator).trim()
    if (!ENV_KEY.test(key)) {
      throw new Error(`${QA_RECORDER_ENV_FILENAME}:${index + 1} has invalid key "${key}".`)
    }

    if (process.env[key] === undefined) {
      process.env[key] = parseValue(declaration.slice(separator + 1))
    }
  }

  return envPath
}
