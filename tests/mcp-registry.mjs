import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

// M7: реестр коннекторов — поиск готовых пакетов, проверка соединения,
// установка (bundled) и подключение уже распакованного exe (existing).
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratchRoot = process.env.TMPDIR || os.tmpdir()

const seed = require(path.join(root, 'mcp-export', 'registry', 'seed.js'))
const install = require(path.join(root, 'mcp-export', 'registry', 'install.js'))
const { ALLOWED_ROOTS, loadRegistry, validateConnector } = require(path.join(root, 'mcp-export', 'bridge', 'registry.js'))

const MM_EXE = 'astra-mattermost-mcp.exe'
const MAX_EXE = 'max-user-history-mcp.exe'
const YDX_EXE = 'yandex-telemost-favorites-mcp.exe'
const SECRET = 'sekret-token-123'

function tempDir(t, prefix = 'mcp-reg-') {
  const dir = fs.mkdtempSync(path.join(scratchRoot, prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Пакет коннектора в тестовом baseDir: пустой exe-файл по ожидаемому пути.
function fakePackage(baseDir, service) {
  const name = service === 'max' ? MAX_EXE : MM_EXE
  const dirName = service === 'max' ? 'max-mcp-b22-runtime' : 'astra-mattermost-dc-mcp'
  const target = path.join(baseDir, dirName, '.venv', 'Scripts', name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '')
  return target
}

function registryPathIn(dir) {
  return path.join(dir, 'connectors.json')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Фейковый клиент MCP: ровно те методы, которые нужны проверке соединения.
function fakeClient(options = {}) {
  const calls = []
  const state = { closed: 0, created: [] }
  const client = {
    calls,
    async tools() {
      calls.push(['tools/list'])
      if (options.toolsError) throw options.toolsError
      return (options.tools || []).slice()
    },
    async request(method, params) {
      calls.push([method, params && params.name])
      if (options.callError) throw options.callError
      if (options.hang) return new Promise(() => {})
      return options.whoami === undefined ? { structuredContent: { ok: true } } : options.whoami
    },
    redact: text => String(text === undefined || text === null ? '' : text).split(SECRET).join('***'),
    async close() { state.closed += 1 }
  }
  return { client, calls, state }
}

function makeError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

test('seed: mm, max и ydx находят настоящие exe, неизвестный сервис — null', () => {
  const mm = seed.candidates('mm')
  assert.ok(mm, 'mm-кандидат не найден')
  assert.equal(path.win32.isAbsolute(mm.command), true)
  assert.equal(mm.command.endsWith(path.win32.join('astra-mattermost-dc-mcp', '.venv', 'Scripts', MM_EXE)), true)
  assert.deepEqual(mm.args, [])
  assert.equal(mm.env.MMCHAT_BASE_URL, 'https://im.astralinux.ru')
  assert.equal(mm.env.MMCHAT_READ_ONLY, 'true')
  assert.equal(mm.env.MMCHAT_FAVORITES_FILE.endsWith(path.win32.join('ChatHub', 'config.json')), true)
  assert.deepEqual(mm.desiredTools, ['mmchat_whoami', 'mmchat_list_channels', 'mmchat_read_channel'])

  const max = seed.candidates('max')
  assert.ok(max, 'max-кандидат не найден')
  assert.equal(max.command.endsWith(path.win32.join('max-mcp-b22-runtime', '.venv', 'Scripts', MAX_EXE)), true)
  assert.equal(max.env.MAX_MCP_CONFIG, path.win32.join(seed.DEFAULT_BASE_DIR, 'max-mcp.config.json'))
  assert.deepEqual(max.desiredTools, ['max_whoami', 'max_list_chats', 'max_resolve_chat', 'max_read_history'])

  // Яндекс живёт в каталоге интеграций Hermes: ровно этот путь разрешён пользователем.
  const ydx = seed.candidates('ydx')
  assert.ok(ydx, 'ydx-кандидат не найден')
  assert.equal(
    ydx.command.endsWith(path.win32.join('yandex-telemost-favorites-mcp', '.venv', 'Scripts', YDX_EXE)),
    true
  )
  assert.deepEqual(ydx.args, [])
  assert.deepEqual(ydx.desiredTools, [
    'favorite_chats_list',
    'favorite_chat_messages_list',
    'favorite_thread_messages_list',
    'favorite_chat_message_get'
  ])
  // Только системные пути: токена в env кандидата и реестре нет.
  assert.deepEqual(Object.keys(ydx.env).sort(), ['APPDATA', 'HOME', 'USERPROFILE'])
  assert.equal(Object.keys(ydx.env).some(key => /TOKEN|SECRET/i.test(key)), false)
  assert.equal(typeof ydx.env.APPDATA, 'string')
  assert.equal(typeof ydx.env.USERPROFILE, 'string')
  assert.equal(typeof ydx.env.HOME, 'string')

  assert.equal(seed.candidates('telegram'), null)
  // Все пути лежат внутри разрешённых корней валидатора реестра.
  const allowed = ALLOWED_ROOTS.map(item => path.win32.resolve(item).toLowerCase())
  for (const candidate of [mm, max, ydx]) {
    const command = path.win32.resolve(candidate.command).toLowerCase()
    assert.equal(allowed.some(item => command === item || command.startsWith(item + path.win32.sep)), true, candidate.command)
  }
})

// Узкое исключение allowlist: разрешён ровно каталог интеграции Яндекса, не весь
// hermes и не каталог integrations целиком.
test('install: ydx пишется в реестр без токена и с четырьмя favorite_*', async t => {
  const dir = tempDir(t)
  const registryPath = path.join(dir, 'connectors.json')
  let probedEntry = null
  const result = await install.installConnector('ydx', {
    registryPath,
    probe: async (service, entry) => { probedEntry = entry; return { ok: true, tools: ['favorite_chats_list'] } }
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.entry.mode, 'bundled')
  assert.equal(
    result.entry.command.endsWith(path.win32.join('yandex-telemost-favorites-mcp', '.venv', 'Scripts', YDX_EXE)),
    true
  )
  assert.deepEqual(Object.keys(result.entry.env).sort(), ['APPDATA', 'HOME', 'USERPROFILE'])
  assert.deepEqual(result.entry.tools, [
    'favorite_chats_list',
    'favorite_chat_messages_list',
    'favorite_thread_messages_list',
    'favorite_chat_message_get'
  ])
  // Ни в записи, ни в файле реестра токена нет.
  assert.equal(JSON.stringify(result.entry).includes('TOKEN'), false)
  assert.equal(fs.readFileSync(registryPath, 'utf8').includes('TOKEN'), false)
  assert.deepEqual(probedEntry.env, result.entry.env)
})

test('реестр: исключение Яндекса не расширяет соседние каталоги', () => {
  const local = process.env.LOCALAPPDATA || path.win32.join(os.homedir(), 'AppData', 'Local')
  const integration = path.win32.join(local, 'hermes', 'integrations', 'yandex-telemost-favorites-mcp')
  const entry = command => ({ mode: 'existing', command, args: [], env: {}, tools: ['favorite_chats_list'] })
  const exe = path.win32.join(integration, '.venv', 'Scripts', YDX_EXE)
  if (fs.existsSync(exe)) {
    const valid = validateConnector(entry(exe))
    assert.equal(valid.command.toLowerCase(), path.win32.resolve(exe).toLowerCase())
  }
  for (const outside of [
    path.win32.join(local, 'hermes', 'integrations', 'other-mcp', '.venv', 'Scripts', 'run.exe'),
    path.win32.join(local, 'hermes', 'integrations', 'yandex-telemost-favorites-mcp2', '.venv', 'Scripts', 'run.exe'),
    path.win32.join(local, 'hermes', 'bin', 'uv.exe'),
    path.win32.join(local, 'hermes', 'integrations', 'run.exe')
  ]) {
    assert.throws(() => validateConnector(entry(outside)), { code: 'REGISTRY_UNSAFE_COMMAND' }, outside)
  }
})

test('seed: пустой baseDir не даёт кандидата, установка возвращает CONNECTOR_NOT_FOUND', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp-empty')
  fs.mkdirSync(baseDir, { recursive: true })
  assert.equal(seed.candidates('mm', baseDir), null)
  assert.equal(seed.candidates('max', baseDir), null)

  const registryPath = registryPathIn(dir)
  let probed = 0
  const result = await install.installConnector('mm', {
    baseDir,
    registryPath,
    probe: async () => { probed += 1; return { ok: true, tools: [] } }
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CONNECTOR_NOT_FOUND')
  assert.equal(probed, 0, 'без кандидата проверять нечего')
  assert.equal(fs.existsSync(registryPath), false)
})

test('probe: tools/list и whoami дают ok, tools и identity, клиент закрыт', async () => {
  const entry = {
    mode: 'bundled',
    command: path.win32.join(seed.DEFAULT_BASE_DIR, 'astra-mattermost-dc-mcp', '.venv', 'Scripts', MM_EXE),
    args: [],
    env: { MMCHAT_READ_ONLY: 'true' },
    tools: ['mmchat_whoami', 'mmchat_read_channel']
  }
  const fake = fakeClient({ tools: ['mmchat_whoami', 'mmchat_read_channel'], whoami: { structuredContent: { user: 'иван' } } })
  let created = null
  const result = await install.probeConnector('mm', entry, {
    timeoutMs: 5000,
    createClient: options => { created = options; return fake.client }
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.tools, ['mmchat_whoami', 'mmchat_read_channel'])
  assert.deepEqual(result.identity, { user: 'иван' })
  assert.equal(created.command, entry.command)
  assert.deepEqual(created.args, [])
  assert.deepEqual(created.env, entry.env)
  assert.equal(created.timeoutMs, 5000)
  assert.deepEqual(fake.calls, [['tools/list'], ['tools/call', 'mmchat_whoami']])
  assert.equal(fake.state.closed, 1)
})

test('probe: отсутствие ожидаемого инструмента даёт TOOLS_MISMATCH без whoami', async () => {
  const entry = { mode: 'existing', command: 'C:/x.exe', args: [], env: {}, tools: ['mmchat_whoami'] }
  const fake = fakeClient({ tools: ['что_то_другое'] })
  const result = await install.probeConnector('mm', entry, { createClient: () => fake.client })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'TOOLS_MISMATCH')
  assert.deepEqual(result.tools, ['что_то_другое'])
  assert.equal(fake.calls.some(call => call[0] === 'tools/call'), false)
  assert.equal(fake.state.closed, 1)
})

test('probe: таймаут запроса переводится в PROBE_TIMEOUT', async () => {
  const entry = { mode: 'existing', command: 'C:/x.exe', args: [], env: {}, tools: ['max_whoami'] }
  const fake = fakeClient({ toolsError: makeError('REQUEST_TIMEOUT', 'таймаут 10 мс: tools/list') })
  const result = await install.probeConnector('max', entry, { createClient: () => fake.client })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PROBE_TIMEOUT')
  assert.match(result.message, /таймаут/i)
  assert.equal(fake.state.closed, 1)
})

test('probe: зависший коннектор упирается в общий дедлайн проверки', async () => {
  const entry = { mode: 'existing', command: 'C:/x.exe', args: [], env: {}, tools: ['mmchat_whoami'] }
  const fake = fakeClient({ tools: ['mmchat_whoami'], hang: true })
  const started = Date.now()
  const result = await install.probeConnector('mm', entry, { timeoutMs: 40, createClient: () => fake.client })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PROBE_TIMEOUT')
  assert.ok(Date.now() - started < 5000, 'проверка не должна ждать коннектор бесконечно')
  assert.equal(fake.state.closed, 1)
})

test('probe: ошибка коннектора сохраняет код и вычищает секреты', async () => {
  const entry = { mode: 'existing', command: 'C:/x.exe', args: [], env: { TOKEN: SECRET }, tools: ['mmchat_whoami'] }
  const fake = fakeClient({
    tools: ['mmchat_whoami'],
    callError: makeError('CONNECTOR_EXIT', `коннектор упал, token=${SECRET}`)
  })
  const result = await install.probeConnector('mm', entry, { createClient: () => fake.client })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CONNECTOR_EXIT')
  assert.equal(result.message.includes(SECRET), false)
  assert.match(result.message, /\*\*\*/)
  assert.equal(fake.state.closed, 1)
})

test('install: пишет валидный JSON атомарно, без временных файлов рядом', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  const command = fakePackage(baseDir, 'mm')
  const registryPath = path.join(dir, 'state', 'connectors.json')
  const result = await install.installConnector('mm', {
    baseDir,
    registryPath,
    roots: [baseDir],
    probe: async () => ({ ok: true, tools: ['mmchat_whoami'] })
  })
  assert.equal(result.ok, true)
  assert.equal(result.entry.mode, 'bundled')
  assert.equal(result.entry.command.toLowerCase(), path.win32.resolve(command).toLowerCase())
  const written = readJson(registryPath)
  assert.equal(written.version, 1)
  assert.equal(written.connectors.mm.mode, 'bundled')
  // В реестр попадает ожидаемый набор инструментов из seed, а не то, что ответил коннектор.
  assert.deepEqual(written.connectors.mm.tools, ['mmchat_whoami', 'mmchat_list_channels', 'mmchat_read_channel'])
  // временных файлов не осталось: в каталоге реестра ровно один файл
  assert.deepEqual(fs.readdirSync(path.dirname(registryPath)), ['connectors.json'])
  // запись читается валидатором реестра с теми же корнями
  const loaded = loadRegistry(registryPath, [baseDir])
  assert.deepEqual(loaded.connectors.mm, result.entry)
})

test('install: неудачная проверка не пишет реестр и не трогает существующий', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  fakePackage(baseDir, 'max')
  const registryPath = path.join(dir, 'connectors.json')
  const before = JSON.stringify({ version: 1, connectors: {} }, null, 2)
  fs.writeFileSync(registryPath, before)

  const result = await install.installConnector('max', {
    baseDir,
    registryPath,
    roots: [baseDir],
    probe: async () => ({ ok: false, code: 'CONNECTOR_EXIT', tools: [] })
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CONNECTOR_EXIT')
  assert.deepEqual(result.tools, [])
  assert.equal(fs.readFileSync(registryPath, 'utf8'), before, 'реестр не должен меняться')
})

test('install: обновляет запись сервиса и сохраняет чужие записи', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  const command = fakePackage(baseDir, 'mm')
  const registryPath = path.join(dir, 'connectors.json')
  const foreign = { mode: 'existing', command: path.win32.join(baseDir, 'other.exe'), args: [], env: {}, tools: ['x'] }
  fs.writeFileSync(registryPath, JSON.stringify({ version: 1, connectors: { max: foreign } }, null, 2))

  const result = await install.installConnector('mm', {
    baseDir,
    registryPath,
    roots: [baseDir],
    probe: async () => ({ ok: true, tools: ['mmchat_whoami'] })
  })
  assert.equal(result.ok, true)
  const written = readJson(registryPath)
  assert.deepEqual(Object.keys(written.connectors).sort(), ['max', 'mm'])
  assert.deepEqual(written.connectors.max, foreign)
  assert.equal(written.connectors.mm.command.toLowerCase(), path.win32.resolve(command).toLowerCase())

  // повторная установка заменяет запись, а не дублирует её
  const stale = readJson(registryPath)
  stale.connectors.mm = { ...stale.connectors.mm, mode: 'existing', command: path.win32.join(baseDir, 'old.exe') }
  fs.writeFileSync(registryPath, JSON.stringify(stale, null, 2))
  const again = await install.installConnector('mm', {
    baseDir,
    registryPath,
    roots: [baseDir],
    probe: async () => ({ ok: true })
  })
  assert.equal(again.ok, true)
  const final = readJson(registryPath)
  assert.deepEqual(Object.keys(final.connectors).sort(), ['max', 'mm'])
  assert.equal(final.connectors.mm.mode, 'bundled')
  assert.equal(final.connectors.mm.command.toLowerCase(), path.win32.resolve(command).toLowerCase())
})

test('connectExisting: путь вне разрешённых корней — REGISTRY_UNSAFE_COMMAND', async t => {
  const dir = tempDir(t)
  fakePackage(path.join(dir, 'mcp'), 'mm')
  const registryPath = registryPathIn(dir)
  const systemRoot = process.env.SystemRoot || 'C:/Windows'
  const outside = path.win32.join(systemRoot, 'System32', 'cmd.exe')
  let probed = 0
  const result = await install.connectExisting('mm', {
    exePath: outside,
    baseDir: path.join(dir, 'mcp'),
    registryPath,
    probe: async () => { probed += 1; return { ok: true, tools: [] } }
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'REGISTRY_UNSAFE_COMMAND')
  assert.equal(probed, 0)
  assert.equal(fs.existsSync(registryPath), false)
})

test('connectExisting: выбранный exe подключается как existing с env из seed', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  const command = fakePackage(baseDir, 'max')
  const registryPath = registryPathIn(dir)
  const result = await install.connectExisting('max', {
    exePath: command,
    baseDir,
    registryPath,
    roots: [baseDir],
    probe: async () => ({ ok: true, tools: ['max_whoami'] })
  })
  assert.equal(result.ok, true)
  assert.equal(result.entry.mode, 'existing')
  assert.equal(result.entry.command.toLowerCase(), path.win32.resolve(command).toLowerCase())
  assert.equal(result.entry.env.MAX_MCP_CONFIG, path.win32.join(path.win32.resolve(baseDir), 'max-mcp.config.json'))
  assert.deepEqual(result.entry.tools, ['max_whoami', 'max_list_chats', 'max_resolve_chat', 'max_read_history'])
  assert.deepEqual(readJson(registryPath).connectors.max.tools, result.entry.tools)
})

test('install: битый реестр даёт REGISTRY_INVALID и файл не перезаписывается', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  fakePackage(baseDir, 'mm')
  const registryPath = path.join(dir, 'connectors.json')
  const broken = '{ это не json'
  fs.writeFileSync(registryPath, broken)
  const result = await install.installConnector('mm', {
    baseDir,
    registryPath,
    roots: [baseDir],
    probe: async () => ({ ok: true, tools: ['mmchat_whoami'] })
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'REGISTRY_INVALID')
  assert.equal(fs.readFileSync(registryPath, 'utf8'), broken)
})

// --- M9-R1: P1 — путь к config.json профиля вместо жёсткого %APPDATA% ---

const DEFAULT_FAVORITES = path.win32.join(
  process.env.APPDATA || path.win32.join(os.homedir(), 'AppData', 'Roaming'),
  'ChatHub',
  'config.json'
)

test('seed: без chatHubConfig остаётся %APPDATA%/ChatHub/config.json', t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  fakePackage(baseDir, 'mm')

  const legacy = seed.candidates('mm', baseDir)
  assert.ok(legacy, 'кандидат по строковому baseDir')
  assert.equal(legacy.env.MMCHAT_FAVORITES_FILE, DEFAULT_FAVORITES)

  const options = seed.candidates('mm', { baseDir })
  assert.ok(options, 'кандидат по options.baseDir')
  assert.equal(options.env.MMCHAT_FAVORITES_FILE, DEFAULT_FAVORITES)
})

test('seed: явный chatHubConfig попадает в MMCHAT_FAVORITES_FILE', t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  fakePackage(baseDir, 'mm')
  const chatHubConfig = path.join(dir, 'perfil-dev', 'config.json')

  const candidate = seed.candidates('mm', { baseDir, chatHubConfig })
  assert.ok(candidate)
  assert.equal(candidate.env.MMCHAT_FAVORITES_FILE, path.win32.resolve(chatHubConfig))
  // Остальные env-переменные коннектора не меняются.
  assert.equal(candidate.env.MMCHAT_BASE_URL, 'https://im.astralinux.ru')
  assert.equal(candidate.env.MMCHAT_READ_ONLY, 'true')
})

test('seed: portable-путь <tmp>/data/config.json сохраняется как есть', t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  fakePackage(baseDir, 'mm')
  // Так выглядит portable-профиль: <app>/data/config.json рядом с exe.
  const portable = path.join(dir, 'portable-app', 'data', 'config.json')
  fs.mkdirSync(path.dirname(portable), { recursive: true })

  const candidate = seed.candidates('mm', { baseDir, chatHubConfig: portable })
  assert.ok(candidate)
  assert.equal(candidate.env.MMCHAT_FAVORITES_FILE, portable)
})

test('install/connectExisting: chatHubConfig прокидывается в env записи реестра', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  const command = fakePackage(baseDir, 'mm')
  const registryPath = registryPathIn(dir)
  const chatHubConfig = path.join(dir, 'dev-data', 'config.json')

  const installed = await install.installConnector('mm', {
    baseDir,
    registryPath,
    roots: [baseDir],
    chatHubConfig,
    probe: async () => ({ ok: true, tools: ['mmchat_whoami'] })
  })
  assert.equal(installed.ok, true)
  assert.equal(installed.entry.env.MMCHAT_FAVORITES_FILE, path.win32.resolve(chatHubConfig))
  assert.equal(
    readJson(registryPath).connectors.mm.env.MMCHAT_FAVORITES_FILE,
    path.win32.resolve(chatHubConfig)
  )

  const portable = path.join(dir, 'portable-app', 'data', 'config.json')
  const connected = await install.connectExisting('mm', {
    exePath: command,
    baseDir,
    registryPath,
    roots: [baseDir],
    chatHubConfig: portable,
    probe: async () => ({ ok: true, tools: ['mmchat_whoami'] })
  })
  assert.equal(connected.ok, true)
  assert.equal(connected.entry.env.MMCHAT_FAVORITES_FILE, portable)
  assert.equal(readJson(registryPath).connectors.mm.env.MMCHAT_FAVORITES_FILE, portable)
})

// --- M9-R2 D4: junction/symlink внутри корня не обходит allowlist ---

function createDirLink(link, target) {
  // junction через mklink /J не требует админ-прав; fallback — symlink.
  const attempts = []
  const comspec = process.env.ComSpec || 'cmd.exe'
  try {
    execFileSync(comspec, ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' })
    return { ok: true, method: 'mklink /J', attempts }
  } catch (error) {
    attempts.push('mklink /J: ' + String(error && (error.stderr || error.message)).trim())
  }
  for (const type of ['junction', 'dir']) {
    try {
      fs.symlinkSync(target, link, type)
      return { ok: true, method: 'symlink ' + type, attempts }
    } catch (error) {
      attempts.push('symlink ' + type + ': ' + String(error && error.message).trim())
    }
  }
  return { ok: false, method: '', attempts }
}

test('реестр: junction внутри корня не обходит allowlist (realpath)', t => {
  const dir = tempDir(t)
  const root = path.join(dir, 'root')
  const outside = path.join(dir, 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'run.exe'), '')
  const link = path.join(root, 'link')
  const created = createDirLink(link, outside)
  if (!created.ok) {
    t.diagnostic('UNVERIFIED: junction/symlink не создались: ' + created.attempts.join(' | '))
    t.skip('UNVERIFIED: не удалось создать junction/symlink: ' + created.attempts.join(' | '))
    return
  }
  assert.equal(fs.existsSync(path.join(link, 'run.exe')), true, 'ссылка должна вести на файл вне корня')
  const entry = {
    mode: 'existing',
    command: path.win32.join(link, 'run.exe'),
    args: [],
    env: {},
    tools: ['mmchat_read_channel']
  }
  assert.throws(() => validateConnector(entry, [root]), { code: 'REGISTRY_UNSAFE_COMMAND' })
  // обычный существующий файл внутри корня по-прежнему принимается
  fs.writeFileSync(path.join(root, 'ok.exe'), '')
  const valid = validateConnector({ ...entry, command: path.win32.join(root, 'ok.exe') }, [root])
  assert.equal(valid.command.toLowerCase(), path.win32.resolve(path.join(root, 'ok.exe')).toLowerCase())
})

// --- M9-R3 F1: MAX читает chat_hub_config из своего конфига, а не из env ---

const MAX_PROFILE_CONFIG = {
  chat_hub_config: 'C:/Users/someone/AppData/Roaming/ChatHub/config.json',
  cdp_url: 'http://127.0.0.1:9222',
  allowed_chat_id: '777',
  allowed_chat_title: 'Рабочий чат',
  max_messages: 50
}

function writeMaxPackageConfig(baseDir) {
  fs.writeFileSync(path.join(baseDir, 'max-mcp.config.json'), JSON.stringify(MAX_PROFILE_CONFIG, null, 2))
}

test('F1: install MAX с chatHubConfig генерирует профильный конфиг рядом с реестром', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  fakePackage(baseDir, 'max')
  writeMaxPackageConfig(baseDir)
  const registryPath = path.join(dir, 'state', 'connectors.json')
  const chatHubConfig = path.join(dir, 'dev-data', 'config.json')
  const result = await install.installConnector('max', {
    baseDir,
    registryPath,
    roots: [baseDir],
    chatHubConfig,
    probe: async () => ({ ok: true, tools: ['max_whoami'] })
  })
  assert.equal(result.ok, true)
  const generated = path.join(dir, 'state', 'max-mcp.config.json')
  assert.equal(result.entry.env.MAX_MCP_CONFIG, generated)
  const written = readJson(generated)
  // Меняется только chat_hub_config, остальные ключи — как в исходнике.
  assert.equal(written.chat_hub_config, path.win32.resolve(chatHubConfig))
  assert.equal(written.cdp_url, MAX_PROFILE_CONFIG.cdp_url)
  assert.equal(written.allowed_chat_id, MAX_PROFILE_CONFIG.allowed_chat_id)
  assert.equal(written.allowed_chat_title, MAX_PROFILE_CONFIG.allowed_chat_title)
  assert.equal(written.max_messages, MAX_PROFILE_CONFIG.max_messages)
  // Запись атомарная: рядом с реестром только сами файлы, без .tmp.
  assert.deepEqual(fs.readdirSync(path.dirname(registryPath)).sort(), ['connectors.json', 'max-mcp.config.json'])
  // Исходный конфиг пакета не переписан.
  assert.deepEqual(readJson(path.join(baseDir, 'max-mcp.config.json')), MAX_PROFILE_CONFIG)
  assert.equal(readJson(registryPath).connectors.max.env.MAX_MCP_CONFIG, generated)
})

test('F1: connectExisting MAX с chatHubConfig тоже генерирует профильный конфиг', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  const command = fakePackage(baseDir, 'max')
  writeMaxPackageConfig(baseDir)
  const registryPath = path.join(dir, 'connectors.json')
  const chatHubConfig = path.join(dir, 'portable-app', 'data', 'config.json')
  const result = await install.connectExisting('max', {
    exePath: command,
    baseDir,
    registryPath,
    roots: [baseDir],
    chatHubConfig,
    probe: async () => ({ ok: true, tools: ['max_whoami'] })
  })
  assert.equal(result.ok, true)
  const generated = path.join(dir, 'max-mcp.config.json')
  assert.equal(result.entry.env.MAX_MCP_CONFIG, generated)
  const written = readJson(generated)
  assert.equal(written.chat_hub_config, path.win32.resolve(chatHubConfig))
  assert.equal(written.cdp_url, MAX_PROFILE_CONFIG.cdp_url)
  assert.equal(written.max_messages, MAX_PROFILE_CONFIG.max_messages)
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
})

test('F1: без chatHubConfig MAX оставляет исходный MAX_MCP_CONFIG', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  fakePackage(baseDir, 'max')
  writeMaxPackageConfig(baseDir)
  const registryPath = path.join(dir, 'state', 'connectors.json')
  const source = path.win32.join(path.win32.resolve(baseDir), 'max-mcp.config.json')

  const candidate = seed.candidates('max', { baseDir })
  assert.ok(candidate)
  assert.equal(candidate.env.MAX_MCP_CONFIG, source)

  const result = await install.installConnector('max', {
    baseDir,
    registryPath,
    roots: [baseDir],
    probe: async () => ({ ok: true, tools: ['max_whoami'] })
  })
  assert.equal(result.ok, true)
  assert.equal(result.entry.env.MAX_MCP_CONFIG, source)
  // Конфиг не генерировался: рядом с реестром только сам реестр.
  assert.deepEqual(fs.readdirSync(path.dirname(registryPath)), ['connectors.json'])
})

test('F1: отсутствие исходного max-mcp.config.json даёт REGISTRY_INVALID', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  fakePackage(baseDir, 'max')
  const registryPath = path.join(dir, 'state', 'connectors.json')
  const chatHubConfig = path.join(dir, 'dev-data', 'config.json')
  let probed = 0
  const result = await install.installConnector('max', {
    baseDir,
    registryPath,
    roots: [baseDir],
    chatHubConfig,
    probe: async () => { probed += 1; return { ok: true, tools: ['max_whoami'] } }
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'REGISTRY_INVALID')
  assert.match(result.message, /max-mcp\.config\.json/)
  assert.equal(probed, 0, 'без исходного конфига проверять нечего')
  assert.equal(fs.existsSync(registryPath), false)
})

// --- M9-R3 F3: probe не считает успехом whoami с ok:false ---

test('F3: probe с whoami {ok:false, code} возвращает ok:false и код', async () => {
  const entry = { mode: 'existing', command: 'C:/x.exe', args: [], env: {}, tools: ['max_whoami'] }
  const fake = fakeClient({ tools: ['max_whoami'], whoami: { structuredContent: { ok: false, code: 'NOT_CONFIGURED' } } })
  const result = await install.probeConnector('max', entry, { createClient: () => fake.client })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NOT_CONFIGURED')
  assert.equal(fake.state.closed, 1)
})

test('F3: probe с whoami без поля ok остаётся успешным', async () => {
  const entry = { mode: 'existing', command: 'C:/x.exe', args: [], env: {}, tools: ['mmchat_whoami'] }
  const fake = fakeClient({ tools: ['mmchat_whoami'], whoami: { structuredContent: { user: 'иван' } } })
  const result = await install.probeConnector('mm', entry, { createClient: () => fake.client })
  assert.equal(result.ok, true)
  assert.deepEqual(result.identity, { user: 'иван' })
})

// --- M9-R4 P2-1: connect-existing MAX берёт исходник из выбранного каталога ---

const SELECTED_MAX_CONFIG = {
  chat_hub_config: 'C:/Users/someone/AppData/Roaming/ChatHub/config.json',
  cdp_url: 'http://127.0.0.1:9999',
  allowed_chat_id: '424242',
  max_messages: 33
}

// Пакет в выбранном каталоге: exe в '.venv/Scripts' и исходный конфиг рядом.
function fakeSelectedMax(root, config) {
  const selected = path.join(root, 'selected-max')
  const scripts = path.join(selected, '.venv', 'Scripts')
  fs.mkdirSync(scripts, { recursive: true })
  const exe = path.join(scripts, MAX_EXE)
  fs.writeFileSync(exe, '')
  if (config) fs.writeFileSync(path.join(selected, 'max-mcp.config.json'), JSON.stringify(config, null, 2))
  return { selected, exe }
}

test('P2-1: connectExisting MAX читает max-mcp.config.json из выбранного baseDir', async t => {
  const dir = tempDir(t)
  const { selected, exe } = fakeSelectedMax(dir, SELECTED_MAX_CONFIG)
  const registryPath = path.join(dir, 'connectors.json')
  const chatHubConfig = path.join(dir, 'profile', 'config.json')
  const result = await install.connectExisting('max', {
    exePath: exe,
    baseDir: selected,
    registryPath,
    roots: [selected],
    chatHubConfig,
    probe: async () => ({ ok: true, tools: ['max_whoami'] })
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const generatedPath = path.win32.join(path.win32.resolve(dir), 'max-mcp.config.json')
  assert.equal(result.entry.env.MAX_MCP_CONFIG, generatedPath)
  const generated = readJson(generatedPath)
  assert.equal(generated.cdp_url, 'http://127.0.0.1:9999')
  assert.equal(generated.allowed_chat_id, '424242')
  assert.equal(generated.max_messages, 33)
  assert.equal(generated.chat_hub_config, path.win32.resolve(chatHubConfig))
  // Значения из ~/mcp не подмешались.
  assert.notEqual(generated.cdp_url, 'http://127.0.0.1:9333')
  assert.notEqual(generated.allowed_chat_id, '-76728609770887')
  assert.notEqual(generated.max_messages, 200)
  assert.equal(readJson(registryPath).connectors.max.env.MAX_MCP_CONFIG, generatedPath)
})

test('P2-1: connectExisting без baseDir не подставляет ~/mcp', async t => {
  const dir = tempDir(t)
  const { exe } = fakeSelectedMax(dir, SELECTED_MAX_CONFIG)
  const registryPath = path.join(dir, 'connectors.json')
  const chatHubConfig = path.join(dir, 'profile', 'config.json')
  let probed = 0
  const result = await install.connectExisting('max', {
    exePath: exe,
    registryPath,
    chatHubConfig,
    probe: async () => { probed += 1; return { ok: true, tools: ['max_whoami'] } }
  })
  assert.equal(result.ok, false)
  assert.ok(['CONNECTOR_NOT_FOUND', 'REGISTRY_INVALID'].includes(result.code), result.code)
  assert.equal(probed, 0, 'без baseDir проверять нечего')
  assert.equal(fs.existsSync(registryPath), false)
})

test('P2-1: connectExisting без max-mcp.config.json в baseDir — REGISTRY_INVALID', async t => {
  const dir = tempDir(t)
  const { selected, exe } = fakeSelectedMax(dir, null)
  const registryPath = path.join(dir, 'connectors.json')
  const chatHubConfig = path.join(dir, 'profile', 'config.json')
  let probed = 0
  const result = await install.connectExisting('max', {
    exePath: exe,
    baseDir: selected,
    registryPath,
    roots: [selected],
    chatHubConfig,
    probe: async () => { probed += 1; return { ok: true, tools: ['max_whoami'] } }
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'REGISTRY_INVALID')
  assert.equal(probed, 0)
  // Чужой final из ~/mcp не создан и реестр не написан.
  assert.equal(fs.existsSync(path.join(dir, 'max-mcp.config.json')), false)
  assert.equal(fs.existsSync(registryPath), false)
})

// --- M9-R4 P2-2: code и message проходят через redact клиента ---

const LEAKY_TOKEN = 'sekrettoken123'

function leakyClient() {
  const calls = []
  return {
    calls,
    async tools() {
      calls.push(['tools/list'])
      return ['mmchat_whoami', 'mmchat_list_channels', 'mmchat_read_channel']
    },
    async request(method, params) {
      calls.push([method, params && params.name])
      return { structuredContent: { ok: false, code: 'CONNECTOR_' + LEAKY_TOKEN } }
    },
    redact: text => String(text === undefined || text === null ? '' : text).split(LEAKY_TOKEN).join('***'),
    async close() {}
  }
}

test('P2-2: probeConnector вычищает code и message клиентским redact', async () => {
  const entry = { mode: 'existing', command: 'C:/x.exe', args: [], env: {}, tools: ['mmchat_whoami'] }
  const result = await install.probeConnector('mm', entry, { createClient: () => leakyClient() })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CONNECTOR_***')
  assert.equal(JSON.stringify(result).includes(LEAKY_TOKEN), false)
})

test('P2-2: installConnector и connectExisting возвращают уже отредактированный code', async t => {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  const command = fakePackage(baseDir, 'mm')
  const registryPath = path.join(dir, 'connectors.json')

  const installed = await install.installConnector('mm', {
    baseDir,
    registryPath,
    roots: [baseDir],
    probeOptions: { createClient: () => leakyClient() }
  })
  assert.equal(installed.ok, false)
  assert.equal(installed.code, 'CONNECTOR_***')
  assert.equal(fs.existsSync(registryPath), false)

  const connected = await install.connectExisting('mm', {
    exePath: command,
    baseDir,
    registryPath,
    roots: [baseDir],
    probeOptions: { createClient: () => leakyClient() }
  })
  assert.equal(connected.ok, false)
  assert.equal(connected.code, 'CONNECTOR_***')
  assert.equal(fs.existsSync(registryPath), false)
})

// --- M9-R4 P2-3: профиль MAX фиксируется только после успешного probe ---

function maxProfileCase(t) {
  const dir = tempDir(t)
  const baseDir = path.join(dir, 'mcp')
  fakePackage(baseDir, 'max')
  writeMaxPackageConfig(baseDir)
  const stateDir = path.join(dir, 'state')
  return {
    dir,
    baseDir,
    stateDir,
    registryPath: path.join(stateDir, 'connectors.json'),
    finalPath: path.join(stateDir, 'max-mcp.config.json'),
    chatHubConfig: path.join(dir, 'profile', 'config.json')
  }
}

function tmpFilesIn(stateDir) {
  if (!fs.existsSync(stateDir)) return []
  return fs.readdirSync(stateDir).filter(name => name.includes('.tmp'))
}

test('P2-3: падение probe не оставляет ни final, ни tmp', async t => {
  const c = maxProfileCase(t)
  let seen = null
  const result = await install.installConnector('max', {
    baseDir: c.baseDir,
    registryPath: c.registryPath,
    roots: [c.baseDir],
    chatHubConfig: c.chatHubConfig,
    probe: async (service, entry) => {
      seen = entry.env.MAX_MCP_CONFIG
      assert.equal(fs.existsSync(seen), true, 'probe должен видеть временный конфиг')
      return { ok: false, code: 'CONNECTOR_EXIT' }
    }
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CONNECTOR_EXIT')
  assert.equal(seen.includes('max-mcp.config.tmp-'), true, seen)
  assert.equal(fs.existsSync(c.finalPath), false, 'final не должен появиться')
  assert.deepEqual(tmpFilesIn(c.stateDir), [], 'временный конфиг должен быть удалён')
  assert.equal(fs.existsSync(c.registryPath), false)
})

test('P2-3: успешный probe фиксирует final и реестр указывает на него', async t => {
  const c = maxProfileCase(t)
  let seen = null
  const result = await install.installConnector('max', {
    baseDir: c.baseDir,
    registryPath: c.registryPath,
    roots: [c.baseDir],
    chatHubConfig: c.chatHubConfig,
    probe: async (service, entry) => {
      seen = entry.env.MAX_MCP_CONFIG
      assert.equal(fs.existsSync(seen), true)
      return { ok: true, tools: ['max_whoami'] }
    }
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(seen.includes('max-mcp.config.tmp-'), true)
  assert.equal(seen === c.finalPath, false)
  assert.equal(result.entry.env.MAX_MCP_CONFIG, c.finalPath)
  const written = readJson(c.finalPath)
  assert.equal(written.chat_hub_config, path.win32.resolve(c.chatHubConfig))
  assert.equal(written.cdp_url, MAX_PROFILE_CONFIG.cdp_url)
  assert.equal(written.allowed_chat_id, MAX_PROFILE_CONFIG.allowed_chat_id)
  assert.equal(written.max_messages, MAX_PROFILE_CONFIG.max_messages)
  assert.deepEqual(tmpFilesIn(c.stateDir), [])
  assert.equal(readJson(c.registryPath).connectors.max.env.MAX_MCP_CONFIG, c.finalPath)
})

test('P2-3: повторное падение probe не перезаписывает существующий final', async t => {
  const c = maxProfileCase(t)
  const first = await install.installConnector('max', {
    baseDir: c.baseDir,
    registryPath: c.registryPath,
    roots: [c.baseDir],
    chatHubConfig: c.chatHubConfig,
    probe: async () => ({ ok: true, tools: ['max_whoami'] })
  })
  assert.equal(first.ok, true)
  const before = fs.readFileSync(c.finalPath)
  const registryBefore = fs.readFileSync(c.registryPath)

  const second = await install.installConnector('max', {
    baseDir: c.baseDir,
    registryPath: c.registryPath,
    roots: [c.baseDir],
    chatHubConfig: path.join(c.dir, 'other-profile', 'config.json'),
    probe: async () => ({ ok: false, code: 'CONNECTOR_EXIT' })
  })
  assert.equal(second.ok, false)
  assert.deepEqual(fs.readFileSync(c.finalPath), before, 'существующий final не должен меняться')
  assert.deepEqual(fs.readFileSync(c.registryPath), registryBefore)
  assert.deepEqual(tmpFilesIn(c.stateDir), [])
})
