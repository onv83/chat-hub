'use strict'

const fs = require('node:fs')
const { writeFileAtomic } = require('../core/write')
const { fileName, renderProjectFile } = require('../core/markdown')
const { classifyCoverage } = require('../core/coverage')
const { dedupeMessages } = require('../core/dedupe')
const { createClient, redact, unwrapToolResult } = require('./mcp-client')
const { loadRegistry } = require('./registry')
const { buildReport, writeStdout } = require('./report')

const DAY_MS = 24 * 60 * 60 * 1000
const localDateTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Novosibirsk',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23'
})

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

function isoLocal(value, fallback) {
  let date
  if (value instanceof Date) {
    date = value
  } else if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
    date = new Date(Number(value))
  } else {
    date = new Date(value)
  }
  if (Number.isNaN(date.getTime())) return fallback || null
  const parts = {}
  for (const part of localDateTime.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`
}

function formatExportedAt(date) {
  return isoLocal(date, new Date().toISOString())
}

function timestampValue(value) {
  // null/undefined/пустая строка не должны становиться эпохой 0: время неизвестно.
  if (value === null || value === undefined) return NaN
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value.trim() === '') return NaN
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  return Date.parse(value)
}

// Самое раннее время среди датированных сообщений. Без дат — undefined:
// подменять его Date.now() нельзя, иначе классификация покрытия врёт.
function oldestTimestamp(messages) {
  let oldest
  for (const message of messages) {
    const value = timestampValue(message && message.timestamp)
    if (Number.isFinite(value) && (oldest === undefined || value < oldest)) oldest = value
  }
  return oldest
}

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw makeError('MANIFEST_INVALID', 'manifest должен быть объектом')
  }
  if (typeof manifest.exportDir !== 'string' || manifest.exportDir.trim() === '') {
    throw makeError('MANIFEST_INVALID', 'exportDir должен быть непустой строкой')
  }
  if (!Array.isArray(manifest.chats)) {
    throw makeError('MANIFEST_INVALID', 'chats должен быть массивом')
  }
  // depthDays — только целое 1..30; отсутствие допустимо (дефолт 7).
  if (manifest.depthDays !== undefined) {
    const depthDays = manifest.depthDays
    if (typeof depthDays !== 'number' || !Number.isInteger(depthDays) || depthDays < 1 || depthDays > 30) {
      throw makeError('MANIFEST_INVALID', 'depthDays должен быть целым числом от 1 до 30')
    }
  }
}

function projectList(chat) {
  const seen = new Set()
  const projects = []
  for (const raw of Array.isArray(chat.projects) ? chat.projects : []) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue
    const project = String(raw).trim()
    if (!project || seen.has(project)) continue
    seen.add(project)
    projects.push(project)
  }
  return projects
}

// MAX из окна ChatHub приходит готовыми сообщениями: адаптер и коннектор такому
// чату не нужны. Проверяем именно массив сообщений — прочие поля не доверяем.
function isPrefetched(chat) {
  return !!(chat && typeof chat === 'object' && chat.prefetched && typeof chat.prefetched === 'object' &&
    Array.isArray(chat.prefetched.messages))
}

function secretEnvOf(registry) {
  const secretEnv = {}
  const connectors = registry && registry.connectors
  if (connectors && typeof connectors === 'object') {
    for (const entry of Object.values(connectors)) {
      if (entry && entry.env && typeof entry.env === 'object') Object.assign(secretEnv, entry.env)
    }
  }
  return secretEnv
}

// Токен Яндекса приходит из main через env моста (CHATHUB_YDX_TOKEN) и живёт
// только в памяти: в manifest, отчёт и журнал он не попадает, в реестре его нет.
const YDX_TOKEN_ENV = 'CHATHUB_YDX_TOKEN'
const YDX_CONNECTOR_TOKEN = 'YANDEX_TELEMOST_OAUTH_TOKEN'

// Забрать токен из своего env и сразу стереть его: другие коннекторы и их
// потомки не должны унаследовать секрет. Повторный вызов вернёт null.
function takeYdxToken() {
  const raw = typeof process.env[YDX_TOKEN_ENV] === 'string' ? process.env[YDX_TOKEN_ENV].trim() : ''
  try { delete process.env[YDX_TOKEN_ENV] } catch {}
  return raw || null
}

// env конкретного коннектора. Для ydx нужен токен; без него клиент не создаём —
// чат получит TOKEN_MISSING, а MM/MAX продолжают работу.
function connectorEnv(service, entry, ydxToken) {
  const base = entry && entry.env && typeof entry.env === 'object' ? entry.env : {}
  if (service !== 'ydx') return { ...base }
  if (typeof ydxToken !== 'string' || ydxToken === '') return null
  return { ...base, [YDX_CONNECTOR_TOKEN]: ydxToken }
}

function stderrLogger(service, log, safe) {
  return text => {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue
      log({ event: 'connector_stderr', service, line: safe(line.trim()) })
    }
  }
}

// F5: код ошибки — тоже текст. Вычищаем секреты и не отдаём пустую строку.
function codeText(value, fallback, env) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value : (fallback || 'UNKNOWN')
  const text = redact(raw, env).trim()
  return text === '' ? 'UNKNOWN' : text
}

async function runExport(manifest, options = {}) {
  assertManifest(manifest)

  const now = options.now instanceof Date ? options.now : new Date()
  const depthDays = Number.isFinite(manifest.depthDays) ? manifest.depthDays : 7
  const limit = Number.isFinite(options.limit) ? options.limit : 200
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000
  const windowStartMs = now.getTime() - depthDays * DAY_MS
  const exportedAt = typeof manifest.exportedAt === 'string' && manifest.exportedAt
    ? manifest.exportedAt
    : formatExportedAt(now)
  const adapters = options.adapters && typeof options.adapters === 'object' ? options.adapters : {}
  const registry = options.registry && options.registry.connectors && typeof options.registry.connectors === 'object'
    ? options.registry
    : { version: 1, connectors: {} }
  const writeFile = typeof options.writeFile === 'function' ? options.writeFile : writeFileAtomic
  const log = typeof options.log === 'function' ? options.log : () => {}
  const clientFactory = typeof options.createClient === 'function' ? options.createClient : createClient
  // Токен забираем один раз до первого клиента и стираем из env моста.
  const ydxToken = typeof options.ydxToken === 'string' ? options.ydxToken : takeYdxToken()
  const secretEnv = secretEnvOf(registry)
  // Токен — секрет и для redact: код/сообщение коннектора не должны вернуть его
  // в отчёт, даже если коннектор эхом повторит значение.
  if (ydxToken) secretEnv[YDX_CONNECTOR_TOKEN] = ydxToken
  const safe = text => redact(text, secretEnv)
  const safeCode = (value, fallback) => codeText(value, fallback, secretEnv)

  const clients = new Map()
  for (const [service, client] of Object.entries(options.clients || {})) {
    if (client) clients.set(service, client)
  }
  const owned = []
  const chats = []
  const errors = []
  const groups = new Map()
  // Исходы чатов по проектам: в шапку каждого файла попадают только его чаты,
  // включая ошибочные — у них нет секции с сообщениями, но файл неполон.
  const outcomes = new Map()
  function recordOutcome(projects, entry) {
    for (const project of projects) {
      if (!outcomes.has(project)) outcomes.set(project, [])
      outcomes.get(project).push(entry)
    }
  }
  // Строки сборщика MAX едут из окна ChatHub через manifest: мост не собирает
  // их сам и кладёт в отчёт как есть, отдельно от ошибок.
  const notes = Array.isArray(manifest.maxNotes) ? manifest.maxNotes : []

  function getClient(service) {
    if (clients.has(service)) return clients.get(service)
    const entry = registry.connectors[service]
    // ydx без токена: коннектор не запускаем, чат получает TOKEN_MISSING.
    const env = connectorEnv(service, entry, ydxToken)
    if (!env) throw makeError('TOKEN_MISSING', 'токен Яндекса не передан мосту')
    const client = clientFactory({
      command: entry.command,
      args: entry.args,
      env,
      timeoutMs,
      onStderr: stderrLogger(service, log, safe)
    })
    clients.set(service, client)
    owned.push(client)
    return client
  }

  function context(chat) {
    const service = chat.service
    const entry = registry.connectors[service]
    return {
      limit,
      windowStartMs,
      now,
      async request(toolName, args) {
        if (!entry) throw makeError('CONNECTOR_MISSING', `нет коннектора для сервиса ${service}`)
        if (!Array.isArray(entry.tools) || !entry.tools.includes(toolName)) {
          throw makeError('TOOL_NOT_ALLOWED', `инструмент не разрешён: ${toolName}`)
        }
        // Коннектор отвечает CallToolResult — адаптеры получают чистую нагрузку.
        const result = await getClient(service).request('tools/call', {
          name: toolName,
          arguments: args || {}
        })
        return unwrapToolResult(result)
      }
    }
  }

  try {
    for (const chat of manifest.chats) {
      if (!chat || typeof chat !== 'object') {
        chats.push({ pinId: null, service: null, status: 'skipped', code: 'chat_invalid', coverage: null, count: 0, undated: 0 })
        continue
      }

      log({ event: 'chat_started', service: chat.service, pinId: chat.pinId })
      const projects = projectList(chat)
      if (!projects.length) {
        chats.push({ pinId: chat.pinId, service: chat.service, status: 'skipped', code: 'no_project', coverage: null, count: 0, undated: 0 })
        log({ event: 'chat_skipped', service: chat.service, pinId: chat.pinId, code: 'no_project' })
        continue
      }

      // MAX, собранный в окне ChatHub: сообщения готовы, адаптер и коннектор не
      // нужны. Ошибка сборки — только этот чат, остальные продолжают.
      const prefetched = isPrefetched(chat) ? chat.prefetched : null
      // DOM-диагностика чтения MAX (капсулы/мета) приходит только у первого
      // чата: переносим в отчёт как есть, чтобы «без даты» разбиралось по факту.
      const prefetchedDiag = prefetched && prefetched.diag && typeof prefetched.diag === 'object'
        ? prefetched.diag
        : null
      if (prefetched && prefetched.status === 'error') {
        const code = safeCode(prefetched.code, 'MAX_COLLECT_FAILED')
        // Диагностика переключения: какой чат ждали и какой был открыт. Без неё
        // живой SWITCH_TIMEOUT нечем разбирать.
        const detail = prefetched.detail && typeof prefetched.detail === 'object' ? prefetched.detail : null
        const expected = detail && typeof detail.expected === 'string' ? detail.expected : ''
        const actual = detail && typeof detail.actual === 'string' ? detail.actual : ''
        const message = expected || actual
          ? 'сбор в окне ChatHub не удался: ожидался чат «' + expected + '», открыт «' + actual + '»'
          : 'сбор в окне ChatHub не удался'
        errors.push({ code, message })
        const failed = { pinId: chat.pinId, service: chat.service, status: 'error', code, coverage: null, count: 0, undated: 0 }
        if (expected || actual) failed.detail = { expected, actual }
        if (prefetchedDiag) failed.diag = prefetchedDiag
        chats.push(failed)
        recordOutcome(projects, { service: chat.service, status: 'error', coverage: null })
        log({ event: 'chat_failed', service: chat.service, pinId: chat.pinId, code })
        continue
      }
      if (prefetched && prefetched.status === 'skipped') {
        const code = safeCode(prefetched.code, 'no_messages')
        const skipped = { pinId: chat.pinId, service: chat.service, status: 'skipped', code, coverage: 'window', count: 0, undated: 0 }
        if (prefetchedDiag) skipped.diag = prefetchedDiag
        chats.push(skipped)
        log({ event: 'chat_skipped', service: chat.service, pinId: chat.pinId, code })
        continue
      }

      const adapter = adapters[chat.service]
      if (!prefetched && typeof adapter !== 'function') {
        chats.push({ pinId: chat.pinId, service: chat.service, status: 'skipped', code: 'adapter_missing', coverage: null, count: 0, undated: 0 })
        log({ event: 'chat_skipped', service: chat.service, pinId: chat.pinId, code: 'adapter_missing' })
        continue
      }

      try {
        const result = prefetched
          ? {
              messages: prefetched.messages,
              coverage: typeof prefetched.coverage === 'string' && prefetched.coverage ? prefetched.coverage : 'window'
            }
          : await adapter(chat, context(chat))
        if (result && result.status === 'unavailable') {
          const unavailableCode = safeCode(result.code, 'CONNECTOR_NOT_READY')
          chats.push({
            pinId: chat.pinId,
            service: chat.service,
            status: 'skipped',
            code: unavailableCode,
            coverage: null,
            count: 0,
            undated: 0
          })
          log({ event: 'chat_skipped', service: chat.service, pinId: chat.pinId, code: unavailableCode })
          continue
        }
        if (!result || !Array.isArray(result.messages)) {
          throw makeError('ADAPTER_INVALID', 'адаптер не вернул messages')
        }

        const deduped = dedupeMessages(result.messages)
        // ТЗ §4: старше глубины — не включаем; неразбираемое время оставляем.
        const messages = []
        const dated = []
        const undated = []
        for (const message of deduped) {
          const value = timestampValue(message && message.timestamp)
          if (!Number.isFinite(value)) {
            undated.push(message)
            messages.push(message)
            continue
          }
          if (value < windowStartMs) continue
          dated.push(message)
          messages.push(message)
        }
        const count = messages.length
        // Диапазон — только по датированным; без дат границы остаются null.
        let fromTs = null
        let toTs = null
        for (const message of dated) {
          const value = timestampValue(message.timestamp)
          if (fromTs === null || value < fromTs) fromTs = value
          if (toTs === null || value > toTs) toTs = value
        }
        const coverage = typeof result.coverage === 'string' && result.coverage
          ? result.coverage
          : classifyCoverage({ kind: result.kind, limit, count, oldestTs: oldestTimestamp(dated), windowStartMs })

        if (!messages.length) {
          chats.push({ pinId: chat.pinId, service: chat.service, status: 'skipped', code: 'no_messages', coverage, count: 0, undated: 0 })
          log({ event: 'chat_skipped', service: chat.service, pinId: chat.pinId, code: 'no_messages' })
          continue
        }

        const section = {
          service: chat.service,
          title: chat.title || '',
          url: chat.url || '',
          from: fromTs === null ? null : isoLocal(fromTs, null),
          to: toTs === null ? null : isoLocal(toTs, null),
          coverage,
          messages
        }
        for (const project of projects) {
          if (!groups.has(project)) groups.set(project, [])
          groups.get(project).push(section)
        }
        const okEntry = {
          pinId: chat.pinId,
          service: chat.service,
          status: 'ok',
          code: null,
          coverage,
          count,
          undated: undated.length
        }
        // Причина усечения от адаптера (например, ошибка глубокой страницы
        // Яндекса) — часть отчёта чата, а не только флаг покрытия.
        if (typeof result.reason === 'string' && result.reason.trim() !== '') {
          okEntry.reason = safe(result.reason.trim())
        }
        if (prefetchedDiag) okEntry.diag = prefetchedDiag
        chats.push(okEntry)
        recordOutcome(projects, { service: chat.service, status: 'ok', coverage })
        log({ event: 'chat_done', service: chat.service, pinId: chat.pinId, count })
      } catch (error) {
        const code = safeCode(codeOf(error, 'adapter_error'), 'adapter_error')
        errors.push({ code, message: safe(error && error.message ? error.message : String(error)) })
        chats.push({ pinId: chat.pinId, service: chat.service, status: 'error', code, coverage: null, count: 0, undated: 0 })
        recordOutcome(projects, { service: chat.service, status: 'error', coverage: null })
        log({ event: 'chat_failed', service: chat.service, pinId: chat.pinId, code })
      }
    }

    const files = []
    for (const [project, sections] of groups) {
      const name = fileName(project, now)
      const content = renderProjectFile({
        project,
        exportedAt,
        depthDays,
        chatSections: sections,
        chatResults: outcomes.get(project) || []
      })
      try {
        const target = await writeFile(manifest.exportDir, name, content)
        const count = sections.reduce((sum, section) => sum + section.messages.length, 0)
        files.push({ project, path: target, count })
        log({ event: 'file_written', project, count })
      } catch (error) {
        const code = safeCode(codeOf(error, 'EXPORT_WRITE_FAILED'), 'EXPORT_WRITE_FAILED')
        errors.push({ code, message: safe(error && error.message ? error.message : String(error)) })
        log({ event: 'file_failed', project, code })
      }
    }

    return buildReport({ exportedAt, files, chats, errors, notes })
  } finally {
    for (const client of owned) {
      try { await client.close() } catch {}
    }
  }
}

// --- режим --probe: проверка соединения без выгрузки ---
// Печатает ровно один JSON в stdout: { ok, service, tools, identity?, code?, message? }.
// Секреты из env коннектора редактируются клиентом (client.redact).
async function probeMode(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout
  const write = payload => {
    try { stdout.write(JSON.stringify(payload) + '\n') } catch {}
  }
  const service = typeof argv[0] === 'string' && argv[0].trim() ? argv[0].trim() : null
  if (!service || argv.length > 1) {
    const payload = {
      ok: false,
      service,
      tools: [],
      code: 'CLI_INVALID_ARGS',
      message: 'использование: --probe <service>'
    }
    write(payload)
    return payload
  }

  let registry = deps.registry && typeof deps.registry === 'object' ? deps.registry : null
  if (!registry) {
    try {
      registry = loadRegistry(deps.registryPath, deps.registryRoots)
    } catch (error) {
      const payload = {
        ok: false,
        service,
        tools: [],
        code: codeOf(error, 'REGISTRY_INVALID'),
        message: redact(error && error.message ? error.message : String(error), {})
      }
      write(payload)
      return payload
    }
  }

  const entry = registry && registry.connectors ? registry.connectors[service] : null
  if (!entry) {
    const payload = { ok: false, service, tools: [], code: 'NOT_INSTALLED', message: 'коннектор не установлен' }
    write(payload)
    return payload
  }

  // Яндекс проверяется только с токеном: без него коннектор не запускаем.
  let probeEntry = entry
  if (service === 'ydx') {
    const env = connectorEnv(service, entry, takeYdxToken())
    if (!env) {
      const payload = { ok: false, service, tools: [], code: 'TOKEN_MISSING', message: 'токен Яндекса не передан' }
      write(payload)
      return payload
    }
    probeEntry = { ...entry, env }
  }

  // P2-2: печатаемые code/message проходят redact. Клиентский redact ловим
  // у созданного клиента, env-секреты вычищает redact из mcp-client.
  let clientSafe = null
  const createClient = typeof deps.createClient === 'function'
    ? options => {
        const client = deps.createClient(options)
        if (client && typeof client.redact === 'function') {
          clientSafe = text => String(client.redact(String(text)))
        }
        return client
      }
    : undefined
  const safe = text => {
    const raw = String(text === undefined || text === null ? '' : text)
    let out
    try { out = redact(raw, secretEnvOf(registry)) } catch { out = raw }
    if (clientSafe) {
      try { out = clientSafe(out) } catch {}
    }
    return out
  }

  let verdict
  try {
    const { probeConnector } = require('../registry/install')
    verdict = await probeConnector(service, probeEntry, {
      timeoutMs: deps.timeoutMs,
      createClient
    })
  } catch (error) {
    verdict = { ok: false, code: codeOf(error, 'PROBE_FAILED'), message: error && error.message }
  }

  const payload = {
    ok: verdict.ok === true,
    service,
    tools: Array.isArray(verdict.tools) ? verdict.tools : []
  }
  if (verdict.identity !== undefined) payload.identity = verdict.identity
  if (!payload.ok) {
    payload.code = safe(typeof verdict.code === 'string' && verdict.code ? verdict.code : 'PROBE_FAILED')
    if (typeof verdict.message === 'string' && verdict.message) payload.message = safe(verdict.message)
  }
  write(payload)
  return payload
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--manifest') {
      options.manifest = argv[index + 1]
      index += 1
      if (typeof options.manifest !== 'string') throw makeError('CLI_INVALID_ARGS', '--manifest требует путь')
    } else if (token === '--out') {
      options.out = argv[index + 1]
      index += 1
      if (typeof options.out !== 'string') throw makeError('CLI_INVALID_ARGS', '--out требует путь')
    } else if (token === '--registry') {
      options.registry = argv[index + 1]
      index += 1
      if (typeof options.registry !== 'string') throw makeError('CLI_INVALID_ARGS', '--registry требует путь')
    } else if (token === '--limit') {
      options.limit = Number(argv[index + 1])
      index += 1
      if (!Number.isFinite(options.limit) || options.limit <= 0) throw makeError('CLI_INVALID_ARGS', '--limit должен быть положительным числом')
    } else if (token === '--timeout') {
      options.timeout = Number(argv[index + 1])
      index += 1
      if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw makeError('CLI_INVALID_ARGS', '--timeout должен быть положительным числом')
    } else {
      throw makeError('CLI_INVALID_ARGS', `неизвестный аргумент: ${token}`)
    }
  }
  if (!options.manifest || typeof options.manifest !== 'string') {
    throw makeError('CLI_INVALID_ARGS', 'не указан --manifest')
  }
  return options
}

function loadAdapters() {
  try {
    return require('../adapters')
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && /adapters/i.test(String(error.message))) return {}
    throw error
  }
}

async function main(argv = [], deps = {}) {
  if (Array.isArray(argv) && argv[0] === '--probe') return probeMode(argv.slice(1), deps)
  const now = deps.now instanceof Date ? deps.now : new Date()
  const exportedAt = formatExportedAt(now)
  const log = typeof deps.log === 'function'
    ? deps.log
    : line => process.stderr.write(JSON.stringify(line) + '\n')
  let activeRegistry = deps.registry || null
  // Manifest читается внутри try: строки сборщика держим снаружи, чтобы они
  // пережили фатальную ошибку и попали в аварийный отчёт.
  let manifestNotes = []

  try {
    const args = parseArgs(argv)
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'))
    } catch {
      throw makeError('MANIFEST_INVALID', `не удалось прочитать manifest: ${args.manifest}`)
    }
    if (args.out) {
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw makeError('MANIFEST_INVALID', 'manifest должен быть объектом')
      }
      manifest.exportDir = args.out
    }
    // Строки читаем до проверки схемы: при фатальной ошибке они остаются в отчёте.
    manifestNotes = manifest && typeof manifest === 'object' && Array.isArray(manifest.maxNotes)
      ? manifest.maxNotes
      : []
    assertManifest(manifest)

    const registry = deps.registry || loadRegistry(args.registry, deps.registryRoots)
    activeRegistry = registry
    const adapters = deps.adapters || loadAdapters()
    const safe = text => redact(text, secretEnvOf(registry))

    // Клиенты поднимаем только для сервисов, которые реально нужны манифесту.
    // prefetched-чаты (MAX из окна ChatHub) коннектор не требуют вовсе.
    const clients = {}
    const services = new Set(manifest.chats
      .filter(chat => !isPrefetched(chat))
      .map(chat => chat && chat.service)
      .filter(service => typeof service === 'string'))
    const makeClient = typeof deps.createClient === 'function' ? deps.createClient : createClient
    // Токен Яндекса забираем до первого клиента: в process.env он не остаётся,
    // поэтому ни MM-, ни MAX-коннектор его не унаследует.
    const ydxToken = services.has('ydx') ? takeYdxToken() : null
    for (const service of services) {
      const entry = registry.connectors[service]
      if (!entry || typeof adapters[service] !== 'function') continue
      const env = connectorEnv(service, entry, ydxToken)
      // ydx без токена: клиента нет, чат получит TOKEN_MISSING от runExport.
      if (!env) continue
      clients[service] = makeClient({
        command: entry.command,
        args: entry.args,
        env,
        timeoutMs: Number.isFinite(args.timeout) ? args.timeout : 30000,
        onStderr: stderrLogger(service, log, safe)
      })
    }

    let report
    try {
      report = await runExport(manifest, {
        registry,
        adapters,
        now,
        limit: args.limit,
        timeoutMs: args.timeout,
        clients,
        ydxToken,
        log,
        createClient: deps.createClient,
        writeFile: deps.writeFile
      })
    } finally {
      for (const client of Object.values(clients)) {
        try { await client.close() } catch {}
      }
    }
    writeStdout(report, deps.stdout || process.stdout)
    return report
  } catch (error) {
    const code = codeText(codeOf(error, 'EXPORT_FAILED'), 'EXPORT_FAILED', secretEnvOf(activeRegistry))
    const message = redact(error && error.message ? error.message : String(error), secretEnvOf(activeRegistry))
    const report = buildReport({
      exportedAt,
      files: [],
      chats: [],
      errors: [{ code, message }],
      notes: manifestNotes
    })
    writeStdout(report, deps.stdout || process.stdout)
    return report
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(report => {
    process.exitCode = report && report.ok ? 0 : 1
  }).catch(error => {
    process.stderr.write(JSON.stringify({ event: 'fatal', message: String(error && error.message || error) }) + '\n')
    process.exitCode = 1
  })
}

module.exports = { main, runExport, probeMode }
