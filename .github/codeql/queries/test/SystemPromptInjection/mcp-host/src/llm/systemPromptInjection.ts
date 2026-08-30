import express from 'express'
import OpenAI from 'openai'

const app = express()
const client = new OpenAI({ apiKey: 'test-key' })

app.get('/unsafe', async (req, res) => {
  const persona = String(req.query.persona || '')
  const response = await client.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: `You are a helpful assistant. Act as ${persona}.` },
      { role: 'user', content: String(req.query.message || '') },
    ],
  })
  res.json(response)
})

app.get('/safe', async (req, res) => {
  const persona = String(req.query.persona || '')
  const response = await client.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: `Persona to act as: ${persona}` },
      { role: 'user', content: String(req.query.message || '') },
    ],
  })
  res.json(response)
})
