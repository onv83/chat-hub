#!/usr/bin/env node
// Фейковый MCP-сервер по stdio для тестов моста.
import fs from 'node:fs'
import readline from 'node:readline'

const callLog = process.env.FAKE_CALL_LOG || ''
const sleepMs = Number(process.env.FAKE_SLEEP_MS || 0)
const badJson = process.env.FAKE_BAD_JSON === '1'
const exitMidCall = process.env.FAKE_EXIT_MIDCALL === '1'
const token = process.env.FAKE_TOKEN || ''
const payloadFile = process.env.FAKE_PAYLOAD_FILE || ''
const toolError = process.env.FAKE_TOOL_ERROR || ''
const badText = process.env.FAKE_BAD_TEXT === '1'
// Форма конверта tools/call: structured (по умолчанию) | text | raw.
const envelope = (process.env.FAKE_ENVELOPE || 'structured').trim() || 'structured'
const tools = (process.env.FAKE_TOOLS || 'mmchat_read_channel')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean)

let initialized = false
let listed = false

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

// Полезная нагрузка инструмента: файл (реальный ответ коннектора) или эхо аргументов.
function toolPayload(args) {
  if (payloadFile) return JSON.parse(fs.readFileSync(payloadFile, 'utf8'))
  return { ok: true, echo: args, token: token || null }
}

// Ответ tools/call в форме MCP CallToolResult; верхнеуровневых ok/echo здесь нет.
function toolResult(args) {
  if (toolError) {
    return { isError: true, content: [{ type: 'text', text: toolError }] }
  }
  if (badText) {
    return { content: [{ type: 'text', text: 'это не json' }] }
  }
  const payload = toolPayload(args)
  if (envelope === 'raw') return payload
  if (envelope === 'text') {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }]
  }
}

if (token) process.stderr.write(`fake-connector token=${token}\n`)

const lines = readline.createInterface({ input: process.stdin })
lines.on('close', () => process.exit(0))
lines.on('line', async line => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (badJson) {
    process.stdout.write('это не json\n')
    return
  }

  const { id, method, params } = message
  if (method === 'initialize') {
    if (token) process.stderr.write(`initialize token=${token}\n`)
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-connector', version: '1.0.0' }
      }
    })
    return
  }

  if (method === 'notifications/initialized') {
    initialized = true
    return
  }

  if (method === 'tools/list') {
    if (!initialized) {
      sendError(id, -32002, 'tools/list до initialize')
      return
    }
    listed = true
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: tools.map(name => ({ name, description: '', inputSchema: { type: 'object' } }))
      }
    })
    return
  }

  if (method === 'tools/call') {
    if (!initialized || !listed) {
      sendError(id, -32002, 'tools/call до initialize/tools-list')
      return
    }
    const args = (params && params.arguments) || {}
    if (callLog) fs.appendFileSync(callLog, JSON.stringify({ tool: params && params.name, args }) + '\n')
    if (exitMidCall) process.exit(3)
    if (sleepMs > 0) await new Promise(resolve => setTimeout(resolve, sleepMs))
    if (token) process.stderr.write(`call token=${token}\n`)
    send({ jsonrpc: '2.0', id, result: toolResult(args) })
    return
  }

  sendError(id, -32601, `неизвестный метод: ${method}`)
})
