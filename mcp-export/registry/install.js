'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { ALLOWED_ROOTS, defaultRegistryPath, loadRegistry, validateConnector } = require('../bridge/registry')
const { unwrapToolResult } = require('../bridge/mcp-client')
const { candidates, prepareMaxProfile } = require('./seed')

const DEFAULT_PROBE_TIMEOUT_MS = 45000
// Безвредная проверка личности: только она вызывается при probe, переписки не читаются.
const WHOAMI_TOOLS = Object.freeze({ mm: 'mmchat_whoami', max: 'max_whoami' })

function makeError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function codeOf(error, fallback) {
  if (error && typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(error.code)) return error.code
  const match = /^([A-Za-z][A-Za-z0-9_]*):/.exec(String(error && error.message || ''))
  return match ? match[1] : fallback
}

function rootsOf(value) {
  return Array.isArray(value) && value.length ? value : ALLOWED_ROOTS
}

function messageOf(error) {
  return String(error && error.message ? error.message : error || '')
}

// Ответ whoami уже развёрнут unwrapToolResult: остаётся вычистить секреты.
function pickIdentity(value, safe) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return safe(String(value))
  // Круговой рейс через JSON вычищает секреты во всех строковых полях.
  try {
    return JSON.parse(safe(JSON.stringify(value)))
  } catch {
    return null
  }
}

// Проверка соединения: tools/list, сверка с ожидаемыми инструментами и whoami.
// Клиент всегда закрывается, секреты из env в ответ не попадают.
async function probeConnector(service, entry, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS
  const create = typeof options.createClient === 'function'
    ? options.createClient
    : require('../bridge/mcp-client').createClient
  const target = entry && typeof entry === 'object' ? entry : {}

  let client = null
  let timer = null
  const safe = text => {
    const raw = String(text === undefined || text === null ? '' : text)
    if (!client || typeof client.redact !== 'function') return raw
    try { return client.redact(raw) } catch { return raw }
  }

  const inspect = async () => {
    const listed = await client.tools()
    const tools = (Array.isArray(listed) ? listed : [])
      .filter(name => typeof name === 'string' && name.length > 0)
    const desired = Array.isArray(target.tools) ? target.tools : []
    if (desired.some(name => !tools.includes(name))) {
      return { ok: false, code: 'TOOLS_MISMATCH', tools }
    }
    const whoami = WHOAMI_TOOLS[service]
    // Неизвестному сервису whoami не назначаем: проверяем только протокол.
    if (!whoami) return { ok: true, tools, identity: null }
    const raw = await client.request('tools/call', { name: whoami, arguments: {} })
    // Ответ FastMCP — CallToolResult: разворачиваем до полезной нагрузки.
    const payload = unwrapToolResult(raw)
    // F3: коннектор может ответить {ok:false, code}: личность не подтверждена,
    // успешной проверкой это не считается. P2-2: code тоже проходит redact.
    if (payload && typeof payload === 'object' && payload.ok === false) {
      const code = typeof payload.code === 'string' && payload.code ? safe(payload.code) : 'IDENTITY_FAILED'
      return { ok: false, code }
    }
    return { ok: true, tools, identity: pickIdentity(payload, safe) }
  }

  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(makeError('PROBE_TIMEOUT', `проверка ${service} не уложилась в ${timeoutMs} мс`))
    }, timeoutMs + 1000)
  })

  try {
    client = create({ command: target.command, args: target.args, env: target.env, timeoutMs })
    if (!client || typeof client.tools !== 'function' || typeof client.request !== 'function') {
      throw makeError('PROBE_FAILED', 'клиент MCP не создан')
    }
    return await Promise.race([inspect(), deadline])
  } catch (error) {
    const code = codeOf(error, 'PROBE_FAILED')
    return {
      ok: false,
      // Таймаут отдельного запроса и общий дедлайн — одна и та же беда для пользователя.
      // P2-2: и код, и сообщение печатаются только после client.redact.
      code: safe(code === 'REQUEST_TIMEOUT' ? 'PROBE_TIMEOUT' : code),
      message: safe(messageOf(error))
    }
  } finally {
    if (timer) {
      try { clearTimeout(timer) } catch {}
    }
    if (client) {
      try { await client.close() } catch {}
    }
  }
}

function readRegistryOrEmpty(filePath, roots) {
  try {
    return loadRegistry(filePath, rootsOf(roots))
  } catch (error) {
    if (error && error.code === 'REGISTRY_MISSING') return { version: 1, connectors: {} }
    throw error
  }
}

// Атомарная запись: временный файл в том же каталоге, затем rename.
function writeRegistryAtomic(filePath, registry) {
  const directory = path.dirname(filePath)
  try {
    fs.mkdirSync(directory, { recursive: true })
  } catch (error) {
    throw makeError('REGISTRY_WRITE_FAILED', `не удалось создать каталог реестра: ${directory}`)
  }
  const payload = JSON.stringify({ version: 1, connectors: registry.connectors }, null, 2) + '\n'
  const temporary = path.join(directory, `.connectors-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx')
    fs.writeFileSync(descriptor, payload, 'utf8')
    try {
      fs.fsyncSync(descriptor)
    } catch (error) {
      if (error.code !== 'ENOSYS' && error.code !== 'EINVAL') throw error
    }
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filePath)
  } catch {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try { fs.rmSync(temporary, { force: true }) } catch {}
    throw makeError('REGISTRY_WRITE_FAILED', `не удалось записать реестр: ${filePath}`)
  }
}

function buildEntry(mode, command, base, roots) {
  try {
    return {
      ok: true,
      entry: validateConnector({
        mode,
        command,
        args: base ? base.args : [],
        env: base ? base.env : {},
        tools: base ? base.desiredTools : []
      }, rootsOf(roots))
    }
  } catch (error) {
    return { ok: false, code: codeOf(error, 'REGISTRY_INVALID'), message: messageOf(error) }
  }
}

// F1: MAX читает chat_hub_config из своего конфига, поэтому для профиля ChatHub
// генерируем копию конфига пакета и подменяем env.MAX_MCP_CONFIG.
// P2-3: пишем временный файл, final появится только после успешного probe.
// Без chatHubConfig поведение прежнее: путь к исходному конфигу.
function withMaxProfile(service, candidate, options, registryPath) {
  if (service !== 'max') return { ok: true }
  const chatHubConfig = typeof options.chatHubConfig === 'string' ? options.chatHubConfig.trim() : ''
  if (!chatHubConfig) return { ok: true }
  // P2-1: исходник берём из каталога выбранного пакета, а не из ~/mcp.
  const baseDir = candidate && typeof candidate.baseDir === 'string' ? candidate.baseDir : options.baseDir
  try {
    const profile = prepareMaxProfile({ baseDir, chatHubConfig, registryPath })
    candidate.env = { ...candidate.env, MAX_MCP_CONFIG: profile.tempPath }
    return { ok: true, tempPath: profile.tempPath, finalPath: profile.finalPath }
  } catch (error) {
    return { ok: false, code: codeOf(error, 'REGISTRY_INVALID'), message: messageOf(error) }
  }
}

// Любая ошибка probe/валидации: временный профиль удаляем, final не трогаем.
function discardProfile(profile) {
  if (!profile || typeof profile.tempPath !== 'string' || !profile.tempPath) return
  try { fs.rmSync(profile.tempPath, { force: true }) } catch {}
}

// Успешный probe: temp → final, в реестр попадает финальный путь.
function commitProfile(profile, entry) {
  if (!profile || typeof profile.tempPath !== 'string' || !profile.tempPath) return { ok: true }
  try {
    fs.renameSync(profile.tempPath, profile.finalPath)
  } catch {
    return {
      ok: false,
      code: 'REGISTRY_WRITE_FAILED',
      message: `не удалось зафиксировать профиль MAX: ${profile.finalPath}`
    }
  }
  entry.env = { ...entry.env, MAX_MCP_CONFIG: profile.finalPath }
  return { ok: true }
}

function probeFailure(verdict) {
  if (verdict && verdict.ok === true) return null
  const result = {
    ok: false,
    code: verdict && typeof verdict.code === 'string' && verdict.code ? verdict.code : 'PROBE_FAILED'
  }
  if (verdict && Array.isArray(verdict.tools)) result.tools = verdict.tools.slice()
  if (verdict && typeof verdict.message === 'string' && verdict.message) result.message = verdict.message
  return result
}

function storeEntry(service, registryPath, roots, entry) {
  let registry
  try {
    registry = readRegistryOrEmpty(registryPath, roots)
  } catch (error) {
    return { ok: false, code: codeOf(error, 'REGISTRY_INVALID'), message: messageOf(error) }
  }
  registry.connectors[service] = entry
  try {
    writeRegistryAtomic(registryPath, registry)
  } catch (error) {
    return { ok: false, code: codeOf(error, 'REGISTRY_WRITE_FAILED'), message: messageOf(error) }
  }
  return { ok: true, entry }
}

// Установка из готового пакета: реестр пишется только после успешной проверки.
async function installConnector(service, options = {}) {
  const registryPath = options.registryPath || defaultRegistryPath()
  const roots = rootsOf(options.roots)
  const probe = typeof options.probe === 'function' ? options.probe : probeConnector
  const candidate = candidates(service, { baseDir: options.baseDir, chatHubConfig: options.chatHubConfig })
  if (!candidate) {
    return { ok: false, code: 'CONNECTOR_NOT_FOUND', message: 'пакет коннектора не найден' }
  }
  const profile = withMaxProfile(service, candidate, options, registryPath)
  if (!profile.ok) return profile
  const built = buildEntry('bundled', candidate.command, candidate, roots)
  if (!built.ok) {
    discardProfile(profile)
    return built
  }

  let verdict
  try {
    verdict = await probe(service, built.entry, options.probeOptions)
  } catch (error) {
    // Профиль не фиксируем, пока проверка не завершилась успехом.
    discardProfile(profile)
    throw error
  }
  const failed = probeFailure(verdict)
  if (failed) {
    discardProfile(profile)
    return failed
  }
  const committed = commitProfile(profile, built.entry)
  if (!committed.ok) {
    discardProfile(profile)
    return committed
  }
  return storeEntry(service, registryPath, roots, built.entry)
}

// Подключение уже распакованного exe: путь приходит из диалога выбора каталога,
// command валидируется теми же корнями, что и запись реестра.
async function connectExisting(service, options = {}) {
  const registryPath = options.registryPath || defaultRegistryPath()
  const roots = rootsOf(options.roots)
  const probe = typeof options.probe === 'function' ? options.probe : probeConnector
  const exePath = typeof options.exePath === 'string' ? options.exePath.trim() : ''
  if (!exePath) {
    return { ok: false, code: 'CONNECTOR_NOT_FOUND', message: 'файл коннектора не выбран' }
  }
  // P2-1: исходник MAX читается из выбранного каталога. Без baseDir не
  // подставляем ~/mcp — там может лежать чужой cdp_url/allowed_chat_id.
  const baseDir = typeof options.baseDir === 'string' ? options.baseDir.trim() : ''
  if (!baseDir) {
    return { ok: false, code: 'CONNECTOR_NOT_FOUND', message: 'каталог пакета коннектора не передан' }
  }
  const base = candidates(service, { baseDir, chatHubConfig: options.chatHubConfig })
  if (!base) {
    return { ok: false, code: 'CONNECTOR_NOT_FOUND', message: 'пакет коннектора не найден' }
  }
  const profile = withMaxProfile(service, base, { ...options, baseDir }, registryPath)
  if (!profile.ok) return profile
  const built = buildEntry('existing', exePath, base, roots)
  if (!built.ok) {
    discardProfile(profile)
    return built
  }

  let verdict
  try {
    verdict = await probe(service, built.entry, options.probeOptions)
  } catch (error) {
    discardProfile(profile)
    throw error
  }
  const failed = probeFailure(verdict)
  if (failed) {
    discardProfile(profile)
    return failed
  }
  const committed = commitProfile(profile, built.entry)
  if (!committed.ok) {
    discardProfile(profile)
    return committed
  }
  return storeEntry(service, registryPath, roots, built.entry)
}

module.exports = { connectExisting, installConnector, probeConnector, readRegistryOrEmpty }
