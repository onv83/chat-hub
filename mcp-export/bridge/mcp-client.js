'use strict'

const { spawn } = require('node:child_process')

const INITIALIZE_PARAMS = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'chathub-bridge', version: '1.0.0' }
}
const STDERR_LIMIT = 8192
const STDOUT_LIMIT = 1024 * 1024

function makeError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

const TOOL_ERROR_LIMIT = 500

// Склеенные части type=text из content MCP.
function textParts(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const item of content) {
    if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('')
}

// FastMCP отдаёт CallToolResult: structuredContent либо JSON-текст в content.
// Простые серверы отвечают сырым объектом — его возвращаем как есть.
function unwrapToolResult(result) {
  if (result === null || result === undefined) {
    throw makeError('TOOL_RESULT_EMPTY', 'инструмент вернул пустой результат')
  }
  if (result.isError === true) {
    const text = textParts(result.content).trim()
    throw makeError('TOOL_ERROR', (text || 'инструмент вернул ошибку').slice(0, TOOL_ERROR_LIMIT))
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent
  }
  if (Array.isArray(result.content)) {
    const text = textParts(result.content).trim()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw makeError('TOOL_RESULT_INVALID', `ответ инструмента не JSON: ${text.slice(0, 200)}`)
    }
    // Скаляры не считаем данными инструмента: адаптерам нужен объект/массив.
    if (parsed === null || typeof parsed !== 'object') {
      throw makeError('TOOL_RESULT_INVALID', 'ответ инструмента не объект и не массив')
    }
    return parsed
  }
  return result
}

// M9-R2 D3: коннектору — только минимальный системный env, без process.env целиком.
const SAFE_BASE_ENV_KEYS = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMDRIVE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'LANG',
  'PYTHONIOENCODING', 'NUMBER_OF_PROCESSORS'
])

function safeBaseEnv() {
  const env = {}
  for (const key of SAFE_BASE_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string') env[key] = value
  }
  return env
}

// M9-R2 D2: секрет — значение от 8 символов ИЛИ непустое значение под
// секретным именем ключа (TOKEN/SECRET/PASSWORD/PASS/KEY/CREDENTIAL).
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL/i

function redact(text, env) {
  let result = String(text === undefined || text === null ? '' : text)
  const values = Object.entries(env || {})
    .filter(([key, value]) => typeof value === 'string' && value !== '' && (value.length >= 8 || SECRET_ENV_NAME.test(key)))
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length)
  for (const value of values) result = result.split(value).join('***')
  return result
}

function createClient({ command, args = [], env = {}, timeoutMs = 30000, onStderr } = {}) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    env: { ...safeBaseEnv(), ...env }
  })

  const pending = new Map()
  const safeEnv = env || {}
  let nextId = 1
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let stderrTail = ''
  let terminal = null
  let initPromise = null
  let toolNames = []
  let closed = false
  let exitInfo = null

  function failAll(code, message) {
    if (!terminal) terminal = { code, message }
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(makeError(code, message))
    }
    pending.clear()
  }

  function killTree() {
    const pid = child.pid
    // M9-R2 D6: сначала дерево целиком, child.kill — fallback.
    if (pid && process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.on('error', () => {})
        if (typeof killer.unref === 'function') killer.unref()
      } catch {}
    }
    try { child.kill() } catch {}
  }

  function protocolError(reason) {
    failAll('PROTOCOL_ERROR', reason)
    killTree()
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      protocolError('строка stdout не является JSON-RPC 2.0')
      return
    }
    if (message.id === undefined || message.id === null) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      const detail = message.error.data && typeof message.error.data.code === 'string'
        ? message.error.data.code
        : 'MCP_ERROR'
      const error = makeError(detail, String(message.error.message || 'ошибка коннектора'))
      error.rpcCode = message.error.code
      entry.reject(error)
      return
    }
    entry.resolve(message.result)
  }

  function handleLine(line) {
    const text = line.trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      protocolError('битая строка stdout (не JSON)')
      return
    }
    handleMessage(message)
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk
    if (stdoutBuffer.length > STDOUT_LIMIT) {
      protocolError('stdout превысил лимит без перевода строки')
      return
    }
    let index = stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, '')
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      handleLine(line)
      if (terminal && terminal.code === 'PROTOCOL_ERROR') return
      index = stdoutBuffer.indexOf('\n')
    }
  })

  child.stderr.on('data', chunk => {
    stderrBuffer += String(chunk)
    let index = stderrBuffer.indexOf('\n')
    while (index >= 0) {
      const line = stderrBuffer.slice(0, index).replace(/\r$/, '')
      stderrBuffer = stderrBuffer.slice(index + 1)
      emitStderr(line)
      index = stderrBuffer.indexOf('\n')
    }
    // Очень длинная строка без перевода: редактируем и сбрасываем.
    if (stderrBuffer.length > STDERR_LIMIT) {
      emitStderr(stderrBuffer)
      stderrBuffer = ''
    }
  })

  function emitStderr(line) {
    if (!line) return
    const text = redact(line, safeEnv)
    stderrTail = (stderrTail + text + '\n').slice(-STDERR_LIMIT)
    if (typeof onStderr === 'function') {
      try { onStderr(text) } catch {}
    }
  }

  child.on('error', error => {
    failAll('CONNECTOR_SPAWN', String(error && error.message || error))
  })

  child.on('exit', (code, signal) => {
    if (stderrBuffer) {
      emitStderr(stderrBuffer)
      stderrBuffer = ''
    }
    exitInfo = { code, signal }
    if (!terminal) {
      const tail = stderrTail.trim()
      failAll('CONNECTOR_EXIT', `коннектор завершился (code=${code}, signal=${signal || 'нет'})` + (tail ? `: ${tail}` : ''))
    } else {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(makeError('CONNECTOR_EXIT', 'коннектор завершился'))
      }
      pending.clear()
    }
  })

  child.stdin.on('error', error => {
    failAll('CONNECTOR_EXIT', `ошибка stdin коннектора: ${error && error.message}`)
  })

  function rpc(method, params) {
    if (terminal) return Promise.reject(makeError(terminal.code, terminal.message))
    if (exitInfo) return Promise.reject(makeError('CONNECTOR_EXIT', 'коннектор уже завершился'))
    return new Promise((resolve, reject) => {
      const id = nextId
      nextId += 1
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(makeError('REQUEST_TIMEOUT', `таймаут ${timeoutMs} мс: ${method}`))
        for (const [, entry] of pending) {
          clearTimeout(entry.timer)
          entry.reject(makeError('CONNECTOR_EXIT', 'коннектор остановлен после таймаута'))
        }
        pending.clear()
        terminal = { code: 'CONNECTOR_EXIT', message: 'коннектор остановлен после таймаута' }
        killTree()
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })

      const payload = { jsonrpc: '2.0', id, method }
      if (params !== undefined) payload.params = params
      try {
        child.stdin.write(JSON.stringify(payload) + '\n', 'utf8', error => {
          if (!error) return
          if (!pending.has(id)) return
          pending.delete(id)
          clearTimeout(timer)
          reject(makeError('CONNECTOR_EXIT', `не удалось записать в stdin: ${error.message}`))
        })
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(makeError('CONNECTOR_EXIT', `не удалось записать в stdin: ${error.message}`))
      }
    })
  }

  function notify(method, params) {
    if (terminal || closed || exitInfo) return false
    const payload = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    try {
      child.stdin.write(JSON.stringify(payload) + '\n')
      return true
    } catch {
      return false
    }
  }

  function ensureReady() {
    if (!initPromise) {
      initPromise = (async () => {
        await rpc('initialize', INITIALIZE_PARAMS)
        notify('notifications/initialized', {})
        const listed = await rpc('tools/list', {})
        const tools = listed && Array.isArray(listed.tools) ? listed.tools : []
        toolNames = tools
          .map(tool => tool && tool.name)
          .filter(name => typeof name === 'string' && name.length > 0)
        return toolNames
      })()
    }
    return initPromise
  }

  async function request(method, params) {
    await ensureReady()
    return rpc(method, params)
  }

  async function tools() {
    await ensureReady()
    return toolNames.slice()
  }

  async function close() {
    if (closed) return
    closed = true
    if (exitInfo) return
    try { child.stdin.end() } catch {}
    await new Promise(resolve => {
      let settled = false
      let timer = null
      const finish = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(() => {
        killTree()
        finish()
      }, 2000)
      child.once('exit', finish)
    })
  }

  return {
    request,
    notify,
    close,
    tools,
    get pid() { return child.pid },
    get lastStderr() { return stderrTail },
    redact: text => redact(text, safeEnv)
  }
}

module.exports = { createClient, redact, safeBaseEnv, unwrapToolResult }
