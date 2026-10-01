import express from 'express'
import fs from 'node:fs'
import { runtimeEdgeGuard } from './server/edgeRuntimeAuth.js'

const app = express()
const getOutputDir = () => '/tmp/artifacts'

// Unsafe: authenticated RPC Proxy edge without the paired durable artifact admission.
app.get('/v1/runtime/artifacts', runtimeEdgeGuard(['rpc-proxy']), (_req, res) => {
  const files = fs.readdirSync(getOutputDir())
  res.status(200).json({ artifacts: files })
})

// Unsafe: the download route also reaches protected files without its admitted producer.
app.get('/v1/runtime/artifacts/:filename/download', runtimeEdgeGuard(['rpc-proxy']), (req, res) => {
  const file = fs.readFileSync(`${getOutputDir()}/${req.params.filename}`)
  res.status(200).send(file)
})
