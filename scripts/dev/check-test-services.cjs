#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

// The CI contract is a literal service list. Refuse expressions or a changed
// matrix shape instead of silently checking a partial list.
function checkServices(workflow, localServices) {
  const matrices = [...(workflow + '\n').matchAll(/^      matrix:\n((?: {8}.*\n|\n)*)/gm)]
  const lists = matrices.map((match) => match[1].split('\n').filter((line) => line.trim() && !line.trim().startsWith('#')))
    .filter((lines) => lines.some((line) => /^        service:/.test(line)))
  if (lists.length !== 1 || lists[0][0] !== '        service:' || lists[0].length < 2) throw new Error('Expected one literal CI service matrix')
  const services = lists[0].slice(1).map((line) => {
    const match = line.match(/^          - ([a-z0-9][a-z0-9/-]*)\s*$/)
    if (!match || match[1].split('/').some((part) => !part)) throw new Error('Unsupported CI service entry')
    return match[1]
  })
  for (const [label, entries] of [['CI', services], ['Makefile', localServices]]) {
    if (new Set(entries).size !== entries.length) throw new Error(`${label} contains duplicate services`)
  }
  const missing = services.filter((service) => !localServices.includes(service))
  const extra = localServices.filter((service) => !services.includes(service))
  if (missing.length || extra.length) {
    throw new Error(`Test service drift: missing from Makefile: ${missing.join(', ') || 'none'}; absent from CI: ${extra.join(', ') || 'none'}`)
  }
  return services.length
}

if (require.main === module) {
  try {
    const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/ci-public.yml'), 'utf8')
    const count = checkServices(workflow, process.argv.slice(2))
    console.log(`PASS: Makefile and CI cover the same ${count} test services`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { checkServices }
