import type { Pr2ReadinessWriter } from '../../src/services/access/pr2ReadinessEvidence.js'
import { parsePr2ReadinessEvidence } from '../../src/services/access/pr2ReadinessEvidence.js'

const writer = process.argv[2] as Pr2ReadinessWriter
const payload = JSON.parse(process.argv[3] ?? '')
const parsed = parsePr2ReadinessEvidence(payload, 'runtime', writer)
process.stdout.write(JSON.stringify(parsed))
