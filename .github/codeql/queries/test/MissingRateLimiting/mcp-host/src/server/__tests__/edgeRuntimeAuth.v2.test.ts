import express from 'express'
import fs from 'node:fs'

const app = express()

// Test servers exercise authentication and routing but are not deployed handlers.
app.get('/fixture', (_req, res) => {
  const value = fs.readFileSync('/tmp/evenfire-codeql-test-fixture', 'utf8')
  res.send(value)
})
