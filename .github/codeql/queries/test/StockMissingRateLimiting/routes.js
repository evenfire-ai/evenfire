const express = require('express')
const fs = require('node:fs')

const app = express()

app.post('/unbounded-export', (_req, res) => {
  fs.writeFileSync('/tmp/unbounded-export', 'request-controlled operation')
  res.sendStatus(204)
})
