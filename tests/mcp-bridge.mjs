import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratchRoot = process.env.TMPDIR || os.tmpdir()
const fixture = path.join(root, 'tests', 'fixtures', 'fake-connector.mjs')
const mainPath = path.join(root, 'mcp-export', 'bridge', 'main.js')

const DAY_MS = 24 * 60 * 60 * 1000

function bridge(name) {
  return require(path.join(root, 'mcp-export', 'bridge', name + '.js'))
}

function core(name) {
  return require(path.join(root, 'mcp-export', 'core', name + '.js'))
}

function tempDir(t, prefix = 'mcp-bridge-') {
  const dir = fs.mkdtempSync(path.join(scratchRoot, prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}

function connector(overrides = {}) {
  return {
    mode: 'existing',
    command: process.execPath,
    args: [fixture],
    env: {},
    tools: ['mmchat_read_channel'],
    ...overrides
  }
}

function registryFile(dir, entry) {
  return writeJson(path.join(dir, 'connectors.json'), {
    version: 1,
    connectors: { mm: entry }
  })
}

function allowedRoots() {
  return [path.dirname(process.execPath)]
}

function chat(overrides = {}) {
  return {
    pinId: 'p1',
    service: 'mm',
    chatId: 'team/general',
    title: 'Общий канал',
    url: 'https://mm.example.test/team/channels/general',
    projects: ['14544'],
    ...overrides
  }
}

function message(overrides = {}) {
  return {
    service: 'mm',
    chatId: 'team/general',
    messageId: 'm1',
    timestamp: '2026-11-20T10:00:00+07:00',
    author: 'Иван',
    text: 'привет',
    links: [],
    ...overrides
  }
}

function manifest(exportDir, chats, extra = {}) {
  return {
    exportedAt: '2026-11-23T12:00:00+07:00',
    depthDays: 7,
    exportDir,
    chats,
    ...extra
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForDeath(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isAlive(pid)) return true
    await delay(100)
  }
  return !isAlive(pid)
}

test('реестр: отсутствие файла даёт REGISTRY_MISSING', t => {
  const { loadRegistry } = bridge('registry')
  const dir = tempDir(t)
  assert.throws(
    () => loadRegistry(path.join(dir, 'нет-такого.json')),
    { code: 'REGISTRY_MISSING' }
  )
})

test('реестр: version не 1 даёт REGISTRY_INVALID', t => {
  const { loadRegistry } = bridge('registry')
  const dir = tempDir(t)
  const file = writeJson(path.join(dir, 'connectors.json'), { version: 2, connectors: {} })
  assert.throws(() => loadRegistry(file), { code: 'REGISTRY_INVALID' })
})

test('реестр: command вне разрешённых корней отвергается', t => {
  const { loadRegistry } = bridge('registry')
  const dir = tempDir(t)
  const systemRoot = process.env.SystemRoot || 'C:/Windows'
  const file = registryFile(dir, connector({
    command: path.win32.join(systemRoot, 'System32', 'cmd.exe')
  }))
  assert.throws(() => loadRegistry(file, [dir]), { code: 'REGISTRY_UNSAFE_COMMAND' })
})

test('реестр: относительный путь command отвергается', t => {
  const { loadRegistry } = bridge('registry')
  const dir = tempDir(t)
  const file = registryFile(dir, connector({ command: 'node.exe' }))
  assert.throws(() => loadRegistry(file, allowedRoots()), { code: 'REGISTRY_UNSAFE_COMMAND' })
})

test('реестр: UNC-путь command отвергается', t => {
  const { loadRegistry } = bridge('registry')
  const dir = tempDir(t)
  const file = registryFile(dir, connector({ command: '\\\\server\\share\\node.exe' }))
  assert.throws(() => loadRegistry(file, allowedRoots()), { code: 'REGISTRY_UNSAFE_COMMAND' })
})

test('реестр: ключ shell в записи отвергается', t => {
  const { loadRegistry } = bridge('registry')
  const dir = tempDir(t)
  const file = registryFile(dir, connector({ shell: true }))
  assert.throws(() => loadRegistry(file, allowedRoots()), { code: 'REGISTRY_UNSAFE_COMMAND' })
})

test('реестр: tools не массив непустых строк даёт REGISTRY_INVALID', t => {
  const { loadRegistry } = bridge('registry')
  const dir = tempDir(t)
  for (const tools of [undefined, 'mmchat_read_channel', [], [''], [42]]) {
    const file = registryFile(dir, connector({ tools }))
    assert.throws(() => loadRegistry(file, allowedRoots()), { code: 'REGISTRY_INVALID' })
  }
})

test('реестр: env не объект строк даёт REGISTRY_INVALID', t => {
  const { loadRegistry } = bridge('registry')
  const dir = tempDir(t)
  for (const env of [null, [], 'TOKEN=1', { TOKEN: 42 }]) {
    const file = registryFile(dir, connector({ env }))
    assert.throws(() => loadRegistry(file, allowedRoots()), { code: 'REGISTRY_INVALID' })
  }
})

test('клиент: initialize, tools/list и tools/call проходят по порядку', async t => {
  const { createClient, unwrapToolResult } = bridge('mcp-client')
  const dir = tempDir(t)
  const callLog = path.join(dir, 'calls.ndjson')
  const client = createClient({
    command: process.execPath,
    args: [fixture],
    env: { FAKE_CALL_LOG: callLog },
    timeoutMs: 10000
  })
  t.after(async () => { await client.close() })

  assert.deepEqual(await client.tools(), ['mmchat_read_channel'])
  const result = await client.request('tools/call', {
    name: 'mmchat_read_channel',
    arguments: { channel: 'general' }
  })
  // Фикстура отвечает строгим MCP-конвертом; полезная нагрузка — внутри него.
  const payload = unwrapToolResult(result)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.echo, { channel: 'general' })

  const calls = fs.readFileSync(callLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'mmchat_read_channel')
  assert.deepEqual(calls[0].args, { channel: 'general' })
})

test('мост: инструмент вне белого списка не вызывает коннектор', async t => {
  const { loadRegistry } = bridge('registry')
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const callLog = path.join(dir, 'calls.ndjson')
  const file = registryFile(dir, connector({
    env: { FAKE_CALL_LOG: callLog },
    tools: ['mmchat_read_channel']
  }))
  const registry = loadRegistry(file, allowedRoots())
  const adapters = {
    mm: async (current, ctx) => {
      await ctx.request('dangerous_send', { channel: current.chatId })
      return { messages: [] }
    }
  }
  const report = await runExport(manifest(dir, [chat()]), { registry, adapters })
  assert.equal(report.chats[0].status, 'error')
  assert.equal(report.chats[0].code, 'TOOL_NOT_ALLOWED')
  assert.equal(fs.existsSync(callLog), false)
})

test('клиент: таймаут вызова даёт REQUEST_TIMEOUT и убивает процесс', async t => {
  const { createClient } = bridge('mcp-client')
  const client = createClient({
    command: process.execPath,
    args: [fixture],
    env: { FAKE_SLEEP_MS: '10000' },
    timeoutMs: 1500
  })
  t.after(async () => { await client.close() })
  const pid = client.pid
  assert.ok(pid > 0)

  await assert.rejects(
    client.request('tools/call', { name: 'mmchat_read_channel', arguments: {} }),
    { code: 'REQUEST_TIMEOUT' }
  )
  assert.equal(await waitForDeath(pid), true, 'процесс коннектора должен быть убит')
})

test('клиент: мусор в stdout даёт PROTOCOL_ERROR', async t => {
  const { createClient } = bridge('mcp-client')
  const client = createClient({
    command: process.execPath,
    args: [fixture],
    env: { FAKE_BAD_JSON: '1' },
    timeoutMs: 5000
  })
  t.after(async () => { await client.close() })

  await assert.rejects(client.request('tools/call', { name: 'mmchat_read_channel' }), {
    code: 'PROTOCOL_ERROR'
  })
})

test('клиент: выход коннектора посреди вызова даёт CONNECTOR_EXIT', async t => {
  const { createClient } = bridge('mcp-client')
  const client = createClient({
    command: process.execPath,
    args: [fixture],
    env: { FAKE_EXIT_MIDCALL: '1' },
    timeoutMs: 5000
  })
  t.after(async () => { await client.close() })

  await assert.rejects(client.request('tools/call', { name: 'mmchat_read_channel' }), {
    code: 'CONNECTOR_EXIT'
  })
})

test('секрет из env не попадает ни в отчёт, ни в stderr-лог', async t => {
  const { loadRegistry } = bridge('registry')
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const token = 'super-secret-token-123'
  const file = registryFile(dir, connector({
    env: { FAKE_TOKEN: token, FAKE_SLEEP_MS: '0' }
  }))
  const registry = loadRegistry(file, allowedRoots())
  const log = []
  const adapters = {
    mm: async (current, ctx) => {
      const result = await ctx.request('mmchat_read_channel', { channel: current.chatId })
      throw Object.assign(new Error('эхо коннектора: ' + JSON.stringify(result)), { code: 'LEAK_PROBE' })
    }
  }
  const report = await runExport(manifest(dir, [chat()]), {
    registry,
    adapters,
    log: line => log.push(line)
  })
  await delay(200)

  assert.equal(report.errors[0].code, 'LEAK_PROBE')
  assert.equal(report.errors[0].message.includes(token), false)
  assert.equal(JSON.stringify(report).includes(token), false)
  const logText = log.map(line => JSON.stringify(line)).join('\n')
  assert.equal(logText.includes(token), false)
  assert.equal(logText.includes('connector_stderr'), true)
})

test('CLI: stdout содержит ровно один JSON-объект', async t => {
  const { loadRegistry } = bridge('registry')
  const { main } = bridge('main')
  const dir = tempDir(t)
  const out = tempDir(t, 'mcp-bridge-out-')
  const file = registryFile(dir, connector())
  writeJson(path.join(dir, 'manifest.json'), manifest(out, [chat()]))
  const registry = loadRegistry(file, allowedRoots())
  const adapters = {
    mm: async () => ({ messages: [message()], coverage: 'full' })
  }
  const output = {
    chunks: [],
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    }
  }
  const report = await main([
    '--manifest', path.join(dir, 'manifest.json'),
    '--out', out
  ], { registry, adapters, log: () => {}, stdout: output })

  const text = output.chunks.join('')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.trim().split('\n').length, 1)
  const parsed = JSON.parse(text)
  assert.deepEqual(parsed, report)
  assert.equal(report.ok, true)
  assert.equal(report.files.length, 1)
  assert.equal(fs.existsSync(report.files[0].path), true)
})

test('runExport: два проекта дают два файла и осознанный дубль чата', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const chats = [chat({ projects: ['14544', '15955'] })]
  const adapters = {
    mm: async () => ({
      messages: [
        message({ messageId: 'm1', text: 'первое' }),
        message({ messageId: 'm2', text: 'второе', timestamp: '2026-11-21T11:00:00+07:00' })
      ]
    })
  }
  const report = await runExport(manifest(dir, chats), { adapters })
  assert.equal(report.ok, true)
  assert.equal(report.files.length, 2)
  assert.deepEqual(report.files.map(item => item.project), ['14544', '15955'])
  for (const item of report.files) {
    const content = fs.readFileSync(item.path, 'utf8')
    assert.equal(content.includes('первое'), true)
    assert.equal(content.includes('второе'), true)
    assert.equal(item.count, 2)
  }
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].count, 2)
})

test('runExport: второй прогон оставляет .prev.md с прежней версией файла', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const run = text => runExport(manifest(dir, [chat()], { depthDays: 7 }), {
    adapters: { mm: async () => ({ messages: [message(text ? { text } : {})] }) },
    now
  })
  const first = await run()
  const second = await run('вторая версия')
  assert.equal(second.files[0].path, first.files[0].path, 'имя файла то же — перезапись')
  const current = fs.readFileSync(second.files[0].path, 'utf8')
  const previous = fs.readFileSync(second.files[0].path.replace(/\.md$/, '.prev.md'), 'utf8')
  assert.equal(current.includes('вторая версия'), true)
  assert.equal(current.includes('привет'), false, 'новый файл без прошлой реплики')
  assert.equal(previous.includes('привет'), true, '.prev хранит прежнее содержимое')
  assert.equal(previous.includes('вторая версия'), false)
})

test('runExport: ошибка одного адаптера не мешает остальным', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const chats = [
    chat({ pinId: 'bad', service: 'mm', title: 'Сломанный' }),
    chat({ pinId: 'good', service: 'max', title: 'Рабочий', chatId: '99' })
  ]
  const adapters = {
    mm: async () => {
      throw Object.assign(new Error('канал не найден'), { code: 'CHAT_NOT_FOUND' })
    },
    max: async () => ({ messages: [message({ service: 'max', chatId: '99', messageId: 'max-1', text: 'живой чат' })] })
  }
  const report = await runExport(manifest(dir, chats), { adapters })
  const bad = report.chats.find(item => item.pinId === 'bad')
  const good = report.chats.find(item => item.pinId === 'good')
  assert.equal(bad.status, 'error')
  assert.equal(bad.code, 'CHAT_NOT_FOUND')
  assert.equal(good.status, 'ok')
  assert.equal(report.files.length, 1)
  assert.equal(report.errors.some(item => item.code === 'CHAT_NOT_FOUND'), true)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('живой чат'), true)
  assert.equal(content.includes('Сломанный'), false)
})

test('runExport: manifest без exportDir даёт MANIFEST_INVALID', async () => {
  const { runExport } = bridge('main')
  for (const bad of [null, {}, { exportDir: '', chats: [] }, { exportDir: 'x', chats: {} }]) {
    await assert.rejects(runExport(bad), { code: 'MANIFEST_INVALID' })
  }
})

test('CLI: без реестра печатает один JSON и выходит с кодом 1', t => {
  const dir = tempDir(t)
  const out = tempDir(t, 'mcp-bridge-out-')
  const manifestPath = writeJson(path.join(dir, 'manifest.json'), manifest(out, [chat()]))
  const missing = path.join(dir, 'нет-реестра.json')
  const result = spawnSync(process.execPath, [mainPath, '--manifest', manifestPath, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, CHATHUB_MCP_REGISTRY: missing },
    timeout: 30000
  })
  assert.equal(result.status, 1)
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.length, 1)
  const report = JSON.parse(lines[0])
  assert.equal(report.ok, false)
  assert.equal(report.errors[0].code, 'REGISTRY_MISSING')
})

test('R2/D1: сообщения старше глубины не попадают в файл и отчёт', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const adapters = {
    mm: async () => ({
      messages: [
        message({ messageId: 'fresh', timestamp: '2026-11-21T12:00:00+07:00', text: 'свежее сообщение' }),
        message({ messageId: 'stale', timestamp: '2026-11-18T12:00:00+07:00', text: 'старое сообщение' })
      ]
    })
  }
  const report = await runExport(manifest(dir, [chat()], { depthDays: 3 }), { adapters, now })
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].count, 1)
  assert.equal(report.chats[0].undated, 0)
  assert.equal(report.files[0].count, 1)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('свежее сообщение'), true)
  assert.equal(content.includes('старое сообщение'), false)
})

test('R2/D1: сообщение без времени сохраняется и попадает в undated', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const adapters = {
    mm: async () => ({
      messages: [
        message({ messageId: 'dated', timestamp: '2026-11-22T10:00:00+07:00', text: 'датированное' }),
        message({ messageId: 'undated', timestamp: null, text: 'без времени' })
      ]
    })
  }
  const report = await runExport(manifest(dir, [chat()], { depthDays: 3 }), { adapters, now })
  assert.equal(report.chats[0].count, 2)
  assert.equal(report.chats[0].undated, 1)
  assert.equal(report.files[0].count, 2)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('без времени'), true)
  // Диапазон строится только по датированному сообщению.
  assert.equal(content.includes('Диапазон: 2026-11-22 10:00 — 2026-11-22 10:00'), true)
  assert.equal(content.includes('1970'), false)
})

test('R2/D1: граница окна включается, from не выходит за глубину', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const boundary = now.getTime() - 3 * DAY_MS
  const adapters = {
    mm: async () => ({
      messages: [
        message({ messageId: 'edge', timestamp: boundary, text: 'на границе' }),
        message({ messageId: 'older', timestamp: boundary - 1, text: 'чуть старше' }),
        message({ messageId: 'now', timestamp: now.getTime(), text: 'сейчас' })
      ]
    })
  }
  const report = await runExport(manifest(dir, [chat()], { depthDays: 3 }), { adapters, now })
  assert.equal(report.chats[0].count, 2)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('на границе'), true)
  assert.equal(content.includes('чуть старше'), false)
  const { formatTimestamp } = core('markdown')
  const rangeLine = content.split('\n').find(line => line.startsWith('Диапазон: '))
  assert.equal(rangeLine, `Диапазон: ${formatTimestamp(boundary)} — ${formatTimestamp(now.getTime())}`)
  assert.equal(rangeLine.includes('2026-11-20 12:00'), true)
})

test('R2/D1: чат без датированных сообщений даёт Диапазон: —', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const adapters = {
    mm: async () => ({
      messages: [message({ messageId: 'u1', timestamp: 'не дата', text: 'мусорное время' })]
    })
  }
  const report = await runExport(manifest(dir, [chat()], { depthDays: 3 }), { adapters, now })
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].count, 1)
  assert.equal(report.chats[0].undated, 1)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('Диапазон: —'), true)
  const row = content.split('\n').find(line => line.includes('мусорное время'))
  assert.equal(row.startsWith('| — |'), true)
})

test('R2/D1: depthDays обязан быть целым 1..30', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  for (const depthDays of [0, 31, 1.5, '7', -1, 100]) {
    await assert.rejects(
      runExport(manifest(dir, [], { depthDays }), { adapters: {} }),
      { code: 'MANIFEST_INVALID' },
      `depthDays=${JSON.stringify(depthDays)}`
    )
  }
  for (const depthDays of [1, 30]) {
    const report = await runExport(manifest(dir, [], { depthDays }), { adapters: {} })
    assert.equal(report.errors.length, 0, `depthDays=${depthDays}`)
  }
  // Отсутствие depthDays допустимо — работает дефолт 7.
  const fallback = { exportedAt: '2026-11-23T12:00:00+07:00', exportDir: dir, chats: [] }
  const report = await runExport(fallback, { adapters: {} })
  assert.equal(report.errors.length, 0)
})

// --- YANDEX-ADAPTER: токен моста и поведение ydx без него ---

const YDX_TOOLS = ['favorite_chats_list', 'favorite_chat_messages_list', 'favorite_thread_messages_list', 'favorite_chat_message_get']

function ydxBridgeChat(overrides = {}) {
  return chat({
    pinId: 'y1',
    service: 'ydx',
    chatId: null,
    title: 'Портал-Юг',
    url: 'https://telemost.yandex.ru/chats/0%2F11%2Faaaaaaaa-1111-4111-8111-111111111111',
    ...overrides
  })
}

function ydxRegistryEntry(overrides = {}) {
  return {
    mode: 'existing',
    command: process.execPath,
    args: [fixture],
    env: {},
    tools: YDX_TOOLS.slice(),
    ...overrides
  }
}

test('YANDEX-ADAPTER: ydx без токена даёт TOKEN_MISSING и не поднимает коннектор', async t => {
  const { runExport } = bridge('main')
  const adapters = require(path.join(root, 'mcp-export', 'adapters', 'index.js'))
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const saved = process.env.CHATHUB_YDX_TOKEN
  delete process.env.CHATHUB_YDX_TOKEN
  t.after(() => {
    if (saved === undefined) delete process.env.CHATHUB_YDX_TOKEN
    else process.env.CHATHUB_YDX_TOKEN = saved
  })
  let created = 0
  const report = await runExport(
    manifest(dir, [ydxBridgeChat(), chat({ pinId: 'm1', service: 'mm', title: 'Общий канал' })], { depthDays: 3 }),
    {
      adapters: {
        ...adapters,
        mm: async () => ({ messages: [message({ text: 'живой MM', timestamp: '2026-11-22T10:00:00+07:00' })] })
      },
      now,
      registry: { version: 1, connectors: { ydx: ydxRegistryEntry() } },
      createClient: () => { created += 1; throw new Error('клиент ydx не должен создаваться') }
    }
  )
  const ydx = report.chats.find(item => item.service === 'ydx')
  const mm = report.chats.find(item => item.service === 'mm')
  assert.equal(created, 0, 'без токена коннектор не запускается')
  assert.equal(ydx.status, 'error')
  assert.equal(ydx.code, 'TOKEN_MISSING')
  assert.equal(mm.status, 'ok', 'MM продолжается без токена Яндекса')
  assert.equal(report.files.length, 1)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('живой MM'), true)
  assert.equal(content.includes('Портал-Юг'), false)
})

test('YANDEX-ADAPTER: токен из env моста уходит коннектору и стирается из process.env', async t => {
  const { runExport } = bridge('main')
  const adapters = require(path.join(root, 'mcp-export', 'adapters', 'index.js'))
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const token = 'ydx-token-value-123'
  const saved = process.env.CHATHUB_YDX_TOKEN
  process.env.CHATHUB_YDX_TOKEN = token
  t.after(() => {
    if (saved === undefined) delete process.env.CHATHUB_YDX_TOKEN
    else process.env.CHATHUB_YDX_TOKEN = saved
  })

  const seen = []
  const fake = {
    async request(method, params) {
      assert.equal(method, 'tools/call')
      if (params.name === 'favorite_chats_list') {
        return { structuredContent: { chats: [{ chat_id: '0/11/aaaaaaaa-1111-4111-8111-111111111111', title: 'Портал-Юг' }] } }
      }
      if (params.name === 'favorite_chat_messages_list') {
        return {
          structuredContent: {
            items: [{
              id: 501,
              chat: { id: '0/11/aaaaaaaa-1111-4111-8111-111111111111', type: 'group' },
              author: { id: 'u-1', chat_id: '0/11/aaaaaaaa-1111-4111-8111-111111111111', display_name: 'Иван', is_bot: false },
              type: 'text',
              text: 'сообщение из Телемоста',
              attachments: [],
              forwarded_messages: [],
              created_at: '2026-11-22T10:00:00Z',
              edited_at: null
            }],
            next_cursor: null
          }
        }
      }
      throw new Error('неожиданный инструмент: ' + params.name)
    },
    async close() {}
  }
  const registry = { version: 1, connectors: { ydx: ydxRegistryEntry() } }
  const report = await runExport(manifest(dir, [ydxBridgeChat()], { depthDays: 3 }), {
    adapters,
    now,
    registry,
    createClient: options => { seen.push(options); return fake }
  })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].env.YANDEX_TELEMOST_OAUTH_TOKEN, token, 'токен доходит до коннектора')
  assert.equal('YANDEX_TELEMOST_OAUTH_TOKEN' in registry.connectors.ydx.env, false, 'реестр не мутирует')
  assert.equal('YANDEX_TELEMOST_OAUTH_TOKEN' in seen[0].env, true)
  assert.equal(process.env.CHATHUB_YDX_TOKEN, undefined, 'мост стирает токен из своего env')
  assert.equal(JSON.stringify(report).includes(token), false, 'в отчёт токен не попадает')
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].code, null)
  assert.equal(report.chats[0].count, 1)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('сообщение из Телемоста'), true)
})

test('YANDEX-ADAPTER: токен стирается и из сообщения об ошибке коннектора', async t => {
  const { runExport } = bridge('main')
  const adapters = require(path.join(root, 'mcp-export', 'adapters', 'index.js'))
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const token = 'ydx-token-echo-456'
  const saved = process.env.CHATHUB_YDX_TOKEN
  process.env.CHATHUB_YDX_TOKEN = token
  t.after(() => {
    if (saved === undefined) delete process.env.CHATHUB_YDX_TOKEN
    else process.env.CHATHUB_YDX_TOKEN = saved
  })
  const fake = {
    async request() { throw new Error('upstream отказал: ' + token) },
    async close() {}
  }
  const report = await runExport(manifest(dir, [ydxBridgeChat()], { depthDays: 3 }), {
    adapters,
    now,
    registry: { version: 1, connectors: { ydx: ydxRegistryEntry() } },
    createClient: () => fake
  })
  assert.equal(report.chats[0].status, 'error')
  assert.equal(JSON.stringify(report).includes(token), false, 'эхо токена вычищено')
  assert.match(report.errors[0].message, /\*\*\*/)
})

test('YANDEX-ADAPTER: причина усечения доезжает до отчёта, MD помечен partial', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const chats = [
    ydxBridgeChat(),
    chat({ pinId: 'm1', service: 'mm', title: 'Общий канал' })
  ]
  const adapters = {
    ydx: async () => ({
      messages: [message({
        service: 'ydx', chatId: '0/11/aaaaaaaa-1111-4111-8111-111111111111',
        messageId: 'y501', text: 'прочитанное до сбоя', timestamp: '2026-11-22T10:00:00+07:00'
      })],
      coverage: 'truncated',
      reason: 'страница 6: TOOL_ERROR'
    }),
    mm: async () => ({ messages: [message({ text: 'живой MM' })] })
  }
  const report = await runExport(manifest(dir, chats, { depthDays: 3 }), { adapters, now })
  const ydx = report.chats.find(item => item.service === 'ydx')
  assert.equal(ydx.status, 'ok')
  assert.equal(ydx.coverage, 'truncated')
  assert.equal(ydx.reason, 'страница 6: TOOL_ERROR')
  assert.equal(report.truncated, true)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('прочитанное до сбоя'), true, 'уже прочитанное осталось в файле')
  assert.ok(content.startsWith('---\nproject: "14544"\nexported_at: "2026-11-23T12:00:00+07:00"\ndepth_days: 3\npartial: true\nincomplete: [ydx]\nsources:\n'))
})

// --- M7: режим --probe (проверка соединения без выгрузки) ---

function probeConnectorEntry(overrides = {}) {
  return connector({ tools: ['mmchat_whoami'], ...overrides })
}

function probeRegistry(dir, service, entry) {
  return writeJson(path.join(dir, 'probe-connectors.json'), {
    version: 1,
    connectors: { [service]: entry }
  })
}

function captureStream() {
  return {
    chunks: [],
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    }
  }
}

test('CLI --probe: один JSON в stdout, tools из tools/list, whoami вызывается', async t => {
  const { loadRegistry } = bridge('registry')
  const { main } = bridge('main')
  const dir = tempDir(t)
  const file = probeRegistry(dir, 'mm', probeConnectorEntry({ env: { FAKE_TOOLS: 'mmchat_whoami' } }))
  const registry = loadRegistry(file, allowedRoots())
  const output = captureStream()
  const payload = await main(['--probe', 'mm'], { registry, stdout: output })

  const text = output.chunks.join('')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.trim().split('\n').length, 1, 'в stdout ровно один JSON')
  assert.deepEqual(JSON.parse(text), payload)
  assert.equal(payload.ok, true)
  assert.equal(payload.service, 'mm')
  assert.deepEqual(payload.tools, ['mmchat_whoami'])
  assert.equal(payload.identity && payload.identity.ok, true, 'whoami вернул идентичность')
  assert.equal('code' in payload, false)
})

test('CLI --probe: сервис без записи даёт NOT_INSTALLED и код выхода 1', t => {
  const dir = tempDir(t)
  const file = writeJson(path.join(dir, 'connectors.json'), { version: 1, connectors: {} })
  const result = spawnSync(process.execPath, [mainPath, '--probe', 'max'], {
    encoding: 'utf8',
    env: { ...process.env, CHATHUB_MCP_REGISTRY: file },
    timeout: 30000
  })
  assert.equal(result.status, 1)
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.length, 1)
  const payload = JSON.parse(lines[0])
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'NOT_INSTALLED')
  assert.equal(payload.service, 'max')
  assert.deepEqual(payload.tools, [])
})

test('CLI --probe: ошибка коннектора даёт код и не раскрывает секреты', async t => {
  const { loadRegistry } = bridge('registry')
  const { main } = bridge('main')
  const dir = tempDir(t)
  const token = 'super-secret-token-123'
  const file = probeRegistry(dir, 'mm', probeConnectorEntry({
    env: { FAKE_TOOLS: 'mmchat_whoami', FAKE_EXIT_MIDCALL: '1', FAKE_TOKEN: token }
  }))
  const registry = loadRegistry(file, allowedRoots())
  const output = captureStream()
  const payload = await main(['--probe', 'mm'], { registry, stdout: output })

  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'CONNECTOR_EXIT')
  assert.match(payload.message, /\*\*\*/, 'значение секрета заменено')
  assert.equal(output.chunks.join('').includes(token), false)
})

test('CLI --probe: расхождение набора инструментов даёт TOOLS_MISMATCH', async t => {
  const { loadRegistry } = bridge('registry')
  const { main } = bridge('main')
  const dir = tempDir(t)
  // Коннектор отдаёт только mmchat_read_channel, а ждём mmchat_whoami.
  const file = probeRegistry(dir, 'mm', probeConnectorEntry())
  const registry = loadRegistry(file, allowedRoots())
  const output = captureStream()
  const payload = await main(['--probe', 'mm'], { registry, stdout: output })

  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'TOOLS_MISMATCH')
  assert.deepEqual(payload.tools, ['mmchat_read_channel'])
  assert.equal(output.chunks.join('').trim().split('\n').length, 1)
})

// --- M9-R4 P2-2: печатаемые code/message редактируются клиентским redact ---
test('CLI --probe: код ошибки whoami маскируется, секрет не попадает в stdout', async t => {
  const { loadRegistry } = bridge('registry')
  const { main } = bridge('main')
  const dir = tempDir(t)
  const token = 'sekrettoken123'
  const file = probeRegistry(dir, 'mm', probeConnectorEntry({ tools: ['mmchat_whoami'], env: {} }))
  const registry = loadRegistry(file, allowedRoots())
  const output = captureStream()
  const fake = {
    async tools() { return ['mmchat_whoami'] },
    async request() { return { structuredContent: { ok: false, code: 'CONNECTOR_' + token } } },
    redact: text => String(text === undefined || text === null ? '' : text).split(token).join('***'),
    async close() {}
  }
  const payload = await main(['--probe', 'mm'], {
    registry,
    stdout: output,
    createClient: () => fake
  })

  const text = output.chunks.join('')
  assert.equal(payload.ok, false)
  assert.match(payload.code, /\*\*\*/)
  assert.equal(payload.code.includes(token), false)
  assert.equal(text.includes(token), false, 'секрет не должен попасть в stdout')
  assert.equal(text.trim().split('\n').length, 1)
})

// --- M9-R1: P0 — разворачивание MCP CallToolResult ---

test('P0: unwrapToolResult разворачивает structuredContent, text и сырой ответ', () => {
  const { unwrapToolResult } = bridge('mcp-client')
  // structuredContent приоритетнее content.
  assert.deepEqual(
    unwrapToolResult({
      structuredContent: { posts: [] },
      content: [{ type: 'text', text: '{"ignored":true}' }]
    }),
    { posts: [] }
  )
  // Только content: JSON собирается из частей type=text.
  assert.deepEqual(
    unwrapToolResult({
      content: [
        { type: 'text', text: '{"channel":"general",' },
        { type: 'text', text: '"posts":[]}' },
        { type: 'image', data: 'AAAA' }
      ]
    }),
    { channel: 'general', posts: [] }
  )
  // Массив тоже валиден: инструмент может вернуть список.
  assert.deepEqual(unwrapToolResult({ content: [{ type: 'text', text: '[1,2]' }] }), [1, 2])
  // Совместимость: простой сервер без конверта отдаёт сырой результат.
  assert.deepEqual(unwrapToolResult({ posts: [] }), { posts: [] })
  assert.equal(unwrapToolResult({ ok: true }).ok, true)
})

test('P0: unwrapToolResult: пустой ответ, isError и не-JSON текст', () => {
  const { unwrapToolResult } = bridge('mcp-client')
  for (const empty of [null, undefined]) {
    assert.throws(() => unwrapToolResult(empty), error => error.code === 'TOOL_RESULT_EMPTY')
  }
  // isError: текст ошибки из content, обрезан до 500 символов.
  const long = 'ошибка коннектора '.repeat(80)
  assert.throws(
    () => unwrapToolResult({ isError: true, content: [{ type: 'text', text: long }] }),
    error => error.code === 'TOOL_ERROR'
      && error.message.includes(long.slice(0, 40))
      && error.message.length <= 520
  )
  // Не-JSON текст и пустой content — невалидный результат.
  assert.throws(
    () => unwrapToolResult({ content: [{ type: 'text', text: 'это не json' }] }),
    error => error.code === 'TOOL_RESULT_INVALID'
  )
  assert.throws(
    () => unwrapToolResult({ content: [] }),
    error => error.code === 'TOOL_RESULT_INVALID'
  )
})

test('P0: клиент отдаёт полезную нагрузку для всех форм MCP-конверта', async t => {
  const { createClient, unwrapToolResult } = bridge('mcp-client')
  for (const mode of ['structured', 'text', 'raw']) {
    const client = createClient({
      command: process.execPath,
      args: [fixture],
      env: { FAKE_ENVELOPE: mode },
      timeoutMs: 10000
    })
    try {
      const raw = await client.request('tools/call', {
        name: 'mmchat_read_channel',
        arguments: { channel: 'general' }
      })
      if (mode !== 'raw') {
        // Верхнеуровневых ok/echo больше нет — только конверт MCP.
        assert.equal(raw.ok, undefined, mode)
        assert.equal(raw.echo, undefined, mode)
        assert.equal(raw.content[0].type, 'text', mode)
      }
      const payload = unwrapToolResult(raw)
      assert.equal(payload.ok, true, mode)
      assert.deepEqual(payload.echo, { channel: 'general' }, mode)
    } finally {
      await client.close()
    }
  }
})

test('P0: runExport с настоящими адаптерами пишет MD из MCP-конверта mmchat_read_channel', async t => {
  const { loadRegistry } = bridge('registry')
  const { runExport } = bridge('main')
  const adapters = require(path.join(root, 'mcp-export', 'adapters', 'index.js'))
  const dir = tempDir(t)
  const out = tempDir(t, 'mcp-bridge-out-')
  // Ответ в точной форме коннектора, только завёрнутый в MCP CallToolResult.
  const payload = {
    channel: 'general',
    channel_id: 'chan-general',
    type: 'O',
    count: 2,
    posts: [
      {
        post_id: 'post-1',
        author: 'ivan',
        time: '2026-11-23T09:15:00',
        text: 'План на неделю: https://example.test/plan?id=7. Подробности позже.',
        root_id: '',
        is_reply: false,
        mentions_me: false,
        edited: false,
        reactions: []
      },
      {
        post_id: 'post-2',
        author: 'anna',
        time: '2026-11-22T18:30:00+07:00',
        text: 'Ответ по задаче.',
        root_id: 'post-1',
        is_reply: true,
        mentions_me: true,
        edited: false,
        reactions: []
      }
    ]
  }
  const payloadFile = writeJson(path.join(dir, 'mm-payload.json'), payload)
  const file = registryFile(dir, connector({ env: { FAKE_PAYLOAD_FILE: payloadFile } }))
  const registry = loadRegistry(file, allowedRoots())
  const now = new Date('2026-11-23T12:00:00+07:00')

  const report = await runExport(manifest(out, [chat()]), { registry, adapters, now })

  const codes = report.errors.map(item => item.code)
  assert.equal(codes.includes('MALFORMED_RESPONSE'), false, 'адаптер не должен видеть конверт')
  assert.equal(report.errors.length, 0)
  assert.equal(report.ok, true)
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].code, null)
  assert.equal(report.chats[0].count, 2)
  assert.equal(report.chats[0].undated, 0)
  assert.equal(report.files.length, 1)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('План на неделю'), true)
  assert.equal(content.includes('| 2026-11-23 09:15 |'), true)
  assert.equal(content.includes('| 2026-11-22 18:30 |'), true)
})

test('P1: невалидное числовое время из конверта попадает в undated, не в 1970', async t => {
  const { loadRegistry } = bridge('registry')
  const { runExport } = bridge('main')
  const adapters = require(path.join(root, 'mcp-export', 'adapters', 'index.js'))
  const dir = tempDir(t)
  const out = tempDir(t, 'mcp-bridge-out-')
  const payload = {
    channel: 'general',
    channel_id: 'chan-general',
    type: 'O',
    count: 3,
    posts: [
      {
        post_id: 'zero',
        author: 'ivan',
        time: 0,
        text: 'время ноль',
        root_id: '',
        is_reply: false,
        mentions_me: false,
        edited: false,
        reactions: []
      },
      {
        post_id: 'small',
        author: 'anna',
        time: 1e5,
        text: 'слишком маленькое число',
        root_id: '',
        is_reply: false,
        mentions_me: false,
        edited: false,
        reactions: []
      },
      {
        post_id: 'dated',
        author: 'petr',
        time: '2026-11-23T09:15:00',
        text: 'нормальное время',
        root_id: '',
        is_reply: false,
        mentions_me: false,
        edited: false,
        reactions: []
      }
    ]
  }
  const payloadFile = writeJson(path.join(dir, 'mm-payload.json'), payload)
  const file = registryFile(dir, connector({ env: { FAKE_PAYLOAD_FILE: payloadFile } }))
  const registry = loadRegistry(file, allowedRoots())
  const now = new Date('2026-11-23T12:00:00+07:00')

  const report = await runExport(manifest(out, [chat()]), { registry, adapters, now })
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].count, 3)
  assert.equal(report.chats[0].undated, 2)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('1970'), false)
  const undatedRows = content.split('\n').filter(line => line.startsWith('| — |'))
  assert.equal(undatedRows.length, 2)
})

test('P0: isError и не-JSON текст коннектора доходят до отчёта кодами', async t => {
  const { loadRegistry } = bridge('registry')
  const { runExport } = bridge('main')
  const adapters = require(path.join(root, 'mcp-export', 'adapters', 'index.js'))
  const dir = tempDir(t)
  const out = tempDir(t, 'mcp-bridge-out-')
  const now = new Date('2026-11-23T12:00:00+07:00')

  const cases = [
    { env: { FAKE_TOOL_ERROR: 'канал не найден' }, code: 'TOOL_ERROR' },
    { env: { FAKE_BAD_TEXT: '1' }, code: 'TOOL_RESULT_INVALID' }
  ]
  for (const item of cases) {
    const file = registryFile(dir, connector({ env: item.env }))
    const registry = loadRegistry(file, allowedRoots())
    const report = await runExport(manifest(out, [chat()]), { registry, adapters, now })
    assert.equal(report.ok, false, item.code)
    assert.equal(report.chats[0].status, 'error', item.code)
    assert.equal(report.chats[0].code, item.code)
    assert.equal(report.files.length, 0, item.code)
    assert.equal(report.errors.some(error => error.code === item.code), true, item.code)
  }
})

// --- M9-R2 D2/D3: секреты по имени ключа и минимальный env коннектора ---

test('redact: короткое значение скрывается, если имя ключа секретное', () => {
  const { redact } = bridge('mcp-client')
  const env = { API_KEY: 'abc', NORMAL: 'short', LONG: 'longenoughvalue' }
  // abc — по имени KEY; longenoughvalue — по длине; short у NORMAL не секрет.
  assert.equal(redact('abc short longenoughvalue', env), '*** short ***')
  // короткое значение под секретным именем тоже скрывается
  assert.equal(redact('p@ss', { PASSWORD: 'p@ss' }), '***')
  assert.equal(redact('tok', { SECRET_TOKEN: 'tok' }), '***')
  assert.equal(redact('cred', { CREDENTIALS: 'cred' }), '***')
  // пустое значение не превращает текст в звёздочки
  assert.equal(redact('обычный текст', { API_KEY: '', PASSWORD: '' }), 'обычный текст')
})

test('safeBaseEnv: белый список без ключей родителя', () => {
  const { safeBaseEnv } = bridge('mcp-client')
  const savedLeak = process.env.UNRELATED_LEAK
  const savedElectron = process.env.ELECTRON_RUN_AS_NODE
  process.env.UNRELATED_LEAK = 'xyz'
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const env = safeBaseEnv()
    const allowed = new Set([
      'PATH', 'PATHEXT', 'SYSTEMDRIVE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
      'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'LANG',
      'PYTHONIOENCODING', 'NUMBER_OF_PROCESSORS'
    ])
    for (const key of Object.keys(env)) assert.ok(allowed.has(key), 'лишний ключ ' + key)
    assert.equal('UNRELATED_LEAK' in env, false)
    assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
    assert.equal(typeof env.PATH, 'string')
    assert.equal(env.PATH.length > 0, true)
  } finally {
    if (savedLeak === undefined) delete process.env.UNRELATED_LEAK
    else process.env.UNRELATED_LEAK = savedLeak
    if (savedElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = savedElectron
  }
})

test('клиент: коннектор получает минимальный env — лишние ключи родителя не утекают', async t => {
  const { createClient } = bridge('mcp-client')
  const dir = tempDir(t)
  const probe = path.join(dir, 'env-probe.js')
  fs.writeFileSync(probe, [
    "'use strict'",
    "const readline = require('node:readline')",
    'const keys = Object.keys(process.env)',
    'const info = {',
    "  leak: keys.includes('UNRELATED_LEAK'),",
    "  electron: keys.includes('ELECTRON_RUN_AS_NODE'),",
    "  systemRoot: typeof process.env.SYSTEMROOT === 'string' && process.env.SYSTEMROOT.length > 0,",
    "  path: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,",
    "  temp: typeof process.env.TEMP === 'string' && process.env.TEMP.length > 0",
    '}',
    'function send(payload) { process.stdout.write(JSON.stringify(payload) + String.fromCharCode(10)) }',
    "readline.createInterface({ input: process.stdin }).on('line', line => {",
    '  const message = JSON.parse(line)',
    "  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'env-probe', version: '1' } } })",
    "  else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'env_probe' }] } })",
    "  else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { structuredContent: info } })",
    '})',
    ''
  ].join(String.fromCharCode(10)))

  const savedLeak = process.env.UNRELATED_LEAK
  const savedElectron = process.env.ELECTRON_RUN_AS_NODE
  process.env.UNRELATED_LEAK = 'xyz'
  process.env.ELECTRON_RUN_AS_NODE = '1'
  const client = createClient({ command: process.execPath, args: [probe], env: {}, timeoutMs: 10000 })
  t.after(async () => {
    await client.close()
    if (savedLeak === undefined) delete process.env.UNRELATED_LEAK
    else process.env.UNRELATED_LEAK = savedLeak
    if (savedElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = savedElectron
  })

  assert.deepEqual(await client.tools(), ['env_probe'])
  const result = await client.request('tools/call', { name: 'env_probe', arguments: {} })
  const info = result.structuredContent
  assert.equal(info.leak, false, 'UNRELATED_LEAK не должен доходить до коннектора')
  assert.equal(info.electron, false, 'ELECTRON_RUN_AS_NODE не должен доходить до коннектора')
  assert.equal(info.systemRoot, true, 'SYSTEMROOT должен доходить')
  assert.equal(info.path, true, 'PATH должен доходить')
  assert.equal(info.temp, true, 'TEMP должен доходить')
})

// --- M9-R3 F5: код ошибки коннектора тоже редактируется ---

test('runExport: код из error.data.code замазан секретом из env', async t => {
  const { loadRegistry } = bridge('registry')
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const token = 'sekrettoken123'
  // Настоящий stdio-коннектор отвечает JSON-RPC ошибкой, где data.code содержит
  // значение секрета: мост обязан замазать и код, а не только message.
  const connectorScript = path.join(dir, 'error-code-connector.mjs')
  fs.writeFileSync(connectorScript, [
    "import readline from 'node:readline'",
    'const secret = process.env.FAKE_TOKEN || ""',
    'const send = payload => process.stdout.write(JSON.stringify(payload) + String.fromCharCode(10))',
    'const lines = readline.createInterface({ input: process.stdin })',
    'lines.on("line", line => {',
    '  let message',
    '  try { message = JSON.parse(line) } catch { return }',
    '  const { id, method } = message',
    '  if (method === "initialize") { send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "err-code", version: "1.0.0" } } }); return }',
    '  if (method === "notifications/initialized") return',
    '  if (method === "tools/list") { send({ jsonrpc: "2.0", id, result: { tools: [{ name: "mmchat_read_channel", inputSchema: { type: "object" } }] } }); return }',
    '  if (method === "tools/call") { send({ jsonrpc: "2.0", id, error: { code: -32000, message: "нет доступа", data: { code: "CONNECTOR_" + secret } } }); return }',
    '  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "неизвестный метод" } })',
    '})',
    'lines.on("close", () => process.exit(0))',
    ''
  ].join('\n'))
  const file = registryFile(dir, connector({
    command: process.execPath,
    args: [connectorScript],
    env: { FAKE_TOKEN: token }
  }))
  const registry = loadRegistry(file, allowedRoots())
  const adapters = {
    mm: async (current, ctx) => ctx.request('mmchat_read_channel', { channel: current.chatId })
  }
  const report = await runExport(manifest(dir, [chat()]), { registry, adapters, timeoutMs: 5000 })

  assert.equal(report.chats[0].status, 'error')
  assert.equal(report.chats[0].code, 'CONNECTOR_***')
  assert.equal(report.errors[0].code, 'CONNECTOR_***')
  assert.equal(JSON.stringify(report).includes(token), false)
})

// --- MAX через webview ChatHub: prefetched обходит адаптер и коннектор ---

function prefetchedChat(overrides = {}) {
  return chat({
    pinId: 'pmax',
    service: 'max',
    chatId: '777',
    title: 'MAX чат',
    url: 'https://web.max.ru/777',
    prefetched: {
      messages: [message({
        service: 'max', chatId: '777', messageId: 'max:/777:0',
        timestamp: '2026-11-22T10:00:00+07:00', text: 'из вкладки ChatHub'
      })],
      coverage: 'window',
      status: 'ok',
      code: null
    },
    ...overrides
  })
}

test('prefetched: чат из окна ChatHub не зовёт адаптер и не поднимает клиент', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  let adapterCalls = 0
  let clientCalls = 0
  const report = await runExport(manifest(dir, [prefetchedChat()]), {
    adapters: {
      max: async () => { adapterCalls += 1; throw new Error('адаптер не должен вызываться') }
    },
    registry: {
      version: 1,
      connectors: {
        max: { command: process.execPath, args: [fixture], env: {}, tools: ['max_read_history'] }
      }
    },
    createClient: () => { clientCalls += 1; throw new Error('клиент не должен создаваться') }
  })
  assert.equal(adapterCalls, 0)
  assert.equal(clientCalls, 0)
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].coverage, 'window')
  assert.equal(report.chats[0].count, 1)
  assert.equal(report.files.length, 1)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('из вкладки ChatHub'), true)
})

test('prefetched: ошибка сборки MAX не мешает остальным чатам', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const chats = [
    prefetchedChat({ prefetched: { messages: [], coverage: 'window', status: 'error', code: 'MAX_VIEW_MISSING' } }),
    chat({ pinId: 'pmm', service: 'mm', title: 'Общий канал' })
  ]
  const adapters = {
    mm: async () => ({ messages: [message({ text: 'живой MM' })] })
  }
  const report = await runExport(manifest(dir, chats), { adapters })
  const failed = report.chats.find(item => item.pinId === 'pmax')
  const ok = report.chats.find(item => item.pinId === 'pmm')
  assert.equal(failed.status, 'error')
  assert.equal(failed.code, 'MAX_VIEW_MISSING')
  assert.equal(ok.status, 'ok')
  assert.equal(report.files.length, 1)
  assert.equal(report.errors.some(item => item.code === 'MAX_VIEW_MISSING'), true)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('живой MM'), true)
  assert.equal(content.includes('MAX чат'), false)
})

test('prefetched: SWITCH_TIMEOUT попадает в отчёт чата с expected/actual', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const report = await runExport(manifest(dir, [prefetchedChat({
    prefetched: {
      messages: [],
      coverage: 'window',
      status: 'error',
      code: 'SWITCH_TIMEOUT',
      detail: { expected: 'MAX чат', actual: 'Другой чат' }
    }
  })]), { adapters: {} })
  assert.equal(report.chats[0].status, 'error')
  assert.equal(report.chats[0].code, 'SWITCH_TIMEOUT')
  assert.deepEqual(report.chats[0].detail, { expected: 'MAX чат', actual: 'Другой чат' })
  const failure = report.errors.find(item => item.code === 'SWITCH_TIMEOUT')
  assert.ok(failure, 'ошибка чата должна попасть в errors')
  assert.match(failure.message, /MAX чат/)
  assert.match(failure.message, /Другой чат/)
})

test('prefetched: DOM-диагностика MAX доезжает до отчёта чата без потерь', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  // Только известные поля: посторонние ключи в отчёт не попадают.
  const diag = {
    roots: 1,
    capsuleCount: 2,
    capsuleSamples: ['19 ноября 2026', 'Сегодня'],
    wrapperCount: 2,
    metaCount: 2,
    metaSamples: ['10:05', '11:30'],
    historyClasses: ['history', 'history--withBottomMargin']
  }
  const base = prefetchedChat()
  const report = await runExport(manifest(dir, [prefetchedChat({
    prefetched: { ...base.prefetched, diag, 'лишнее': 'не должно попасть' }
  })]), { adapters: {} })
  assert.equal(report.chats[0].status, 'ok')
  assert.deepEqual(report.chats[0].diag, diag)
})

test('prefetched: второй замер DOM-диагностики MAX сохраняется с ограничениями', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const diag = {
    roots: 1,
    capsuleCount: 0,
    capsuleSamples: [],
    wrapperCount: 18,
    metaCount: 18,
    metaSamples: ['18:28'],
    historyClasses: ['history history--withBottomMargin'],
    docCapsules: { total: 2, texts: ['Сегодня', 'Вчера'] },
    dateLikeNodes: Array.from({ length: 12 }, (_, index) => ({
      tag: 'time', cls: 'date', text: '18.11.202' + index
    })),
    firstChildren: Array.from({ length: 30 }, (_, index) => ({
      tag: 'div', cls: 'wrapper', text: 'узел ' + index
    })),
    metaWithDate: ['18:28 изменено']
  }
  const base = prefetchedChat()
  const report = await runExport(manifest(dir, [prefetchedChat({
    prefetched: { ...base.prefetched, diag }
  })]), { adapters: {} })
  const saved = report.chats[0].diag
  assert.equal(saved.docCapsules.total, 2)
  assert.deepEqual(saved.docCapsules.texts, ['Сегодня', 'Вчера'])
  // Ограничения отчёта: 8 узлов с датой и 25 первых детей.
  assert.equal(saved.dateLikeNodes.length, 8)
  assert.deepEqual(saved.dateLikeNodes[0], { tag: 'time', cls: 'date', text: '18.11.2020' })
  assert.equal(saved.firstChildren.length, 25)
  assert.deepEqual(saved.metaWithDate, ['18:28 изменено'])
})

test('prefetched: глубина режет сообщения окна так же, как сообщения адаптера', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const report = await runExport(manifest(dir, [prefetchedChat({
    prefetched: {
      messages: [
        message({ service: 'max', chatId: '777', messageId: 'max:/777:0', timestamp: '2026-11-21T12:00:00+07:00', text: 'свежее окно' }),
        message({ service: 'max', chatId: '777', messageId: 'max:/777:1', timestamp: '2026-11-18T12:00:00+07:00', text: 'старое окно' })
      ],
      coverage: 'window',
      status: 'ok',
      code: null
    }
  })], { depthDays: 3 }), { now })
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].count, 1)
  assert.equal(report.files[0].count, 1)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  assert.equal(content.includes('свежее окно'), true)
  assert.equal(content.includes('старое окно'), false)
})

test('prefetched: dayOnly проходит мост без потерь и печатается датой', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  const report = await runExport(manifest(dir, [prefetchedChat({
    prefetched: {
      messages: [
        message({
          service: 'max', chatId: '777', messageId: 'max:/777:0',
          timestamp: '2026-11-19T00:00:00+07:00', dayOnly: true, text: 'день из меты'
        }),
        message({
          service: 'max', chatId: '777', messageId: 'max:/777:1',
          timestamp: '2026-11-21T10:15:00+07:00', dayOnly: false, text: 'время из меты'
        })
      ],
      coverage: 'window',
      status: 'ok',
      code: null
    }
  })], { depthDays: 7 }), { now })
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].count, 2)
  const content = fs.readFileSync(report.files[0].path, 'utf8')
  // dayOnly доезжает до markdown: у дня только дата, у обычного — дата и время.
  assert.ok(content.includes('| 2026-11-19 | Иван | день из меты |'))
  assert.ok(content.includes('| 2026-11-21 10:15 | Иван | время из меты |'))
  assert.ok(content.includes('Диапазон: 2026-11-19 00:00 — 2026-11-21 10:15'))
})

test('prefetched: CLI не поднимает коннектор для сервиса, собранного в окне', async t => {
  const { main } = bridge('main')
  const dir = tempDir(t)
  const out = tempDir(t, 'mcp-bridge-out-')
  const manifestPath = writeJson(path.join(dir, 'manifest.json'), manifest(out, [prefetchedChat()]))
  let clientCalls = 0
  const lines = []
  const report = await main(['--manifest', manifestPath, '--out', out], {
    registry: {
      version: 1,
      connectors: {
        max: { command: process.execPath, args: [fixture], env: {}, tools: ['max_read_history'] }
      }
    },
    adapters: { max: async () => { throw new Error('адаптер не должен вызываться') } },
    createClient: () => { clientCalls += 1; throw new Error('клиент не должен создаваться') },
    stdout: { write: text => lines.push(text) },
    log: () => {}
  })
  assert.equal(clientCalls, 0)
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.files[0].count, 1)
  assert.equal(lines.length, 1)
})

// --- MCP-NOTES: строки сборщика MAX доходят до отчёта ---

test('prefetched: строки сборщика MAX из manifest.maxNotes попадают в report.notes', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const notes = [
    'MAX: сессия ок',
    'MAX: рабочий webview — pin, лента: 1',
    'MAX: собрано 1 сообщений, шагов 0, диапазон 2026-11-22—2026-11-22, покрытие: window'
  ]
  const report = await runExport(manifest(dir, [prefetchedChat()], { maxNotes: notes }), {
    registry: { version: 1, connectors: {} },
    adapters: {}
  })
  assert.equal(report.chats[0].status, 'ok')
  // Строки идут отдельным полем отчёта: чат их не дублирует.
  assert.deepEqual(report.notes, notes)
  assert.equal('notes' in report.chats[0], false)
})

test('prefetched: ошибки чатов не вытесняют report.notes', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const notes = [
    'MAX: сессия ок',
    'MAX: лента top=0/sh=3000/ch=600 wraps=6 → top=540/wraps=6, шагов 6, собрано 0'
  ]
  const chats = [
    prefetchedChat({
      pinId: 'pmax-bad',
      prefetched: { messages: [], coverage: 'window', status: 'error', code: 'MAX_VIEW_MISSING' }
    }),
    prefetchedChat({ pinId: 'pmax-ok' })
  ]
  const report = await runExport(manifest(dir, chats, { maxNotes: notes }), {
    registry: { version: 1, connectors: {} },
    adapters: {}
  })
  assert.equal(report.chats.some(current => current.status === 'error'), true, 'ошибка чата в отчёте')
  assert.equal(report.errors.length, 1)
  assert.deepEqual(report.notes, notes, 'ошибки не съедают строки сборщика')
})

test('buildReport: notes — только непустые строки, порядок сохранён', () => {
  const { buildReport } = bridge('report')
  const report = buildReport({
    exportedAt: null,
    files: [],
    chats: [],
    errors: [],
    notes: ['  первая  ', 7, '', '   ', 'вторая']
  })
  assert.deepEqual(report.notes, ['первая', 'вторая'])
})

// --- ШОВ сбор→мост→MD: prefetched реальной формы доезжает до файла ---
// Здесь проверяется именно стык: renderer.js собирает сообщения MAX с полями
// service/chatId/messageId/author/timestamp/dayOnly/text/links, main.js кладёт
// их в manifest как chat.prefetched, мост пишет Markdown. Если форма собранного
// сообщения и ожидания markdown.js разойдутся, файл потеряет время, ссылку или
// напечатает служебные ярлыки — этот тест падает.
test('ШОВ: prefetched реальной формы (дата-время, dayOnly, undated, ссылка) доезжает до MD', async t => {
  const { runExport } = bridge('main')
  const dir = tempDir(t)
  const now = new Date('2026-11-23T12:00:00+07:00')
  // Ровно та форма, которую строит renderer.js для MAX: ссылки уже вынуты из
  // текста, у «дня без часа» timestamp — полночь и dayOnly: true, у сообщения
  // без даты timestamp === null (не эпоха 0).
  const collected = {
    pinId: 'pmax',
    service: 'max',
    chatId: '/777',
    title: 'MAX чат',
    url: 'https://web.max.ru/777',
    projects: ['14544'],
    prefetched: {
      messages: [
        {
          service: 'max',
          chatId: '/777',
          messageId: 'max:/777:0',
          author: 'Иван',
          timestamp: '2026-11-22T09:05:00+07:00',
          dayOnly: false,
          text: 'смотри https://example.test/doc',
          links: ['https://example.test/doc']
        },
        {
          service: 'max',
          chatId: '/777',
          messageId: 'max:/777:1',
          author: 'Пётр',
          timestamp: '2026-11-19T00:00:00+07:00',
          dayOnly: true,
          text: 'только день',
          links: []
        },
        {
          service: 'max',
          chatId: '/777',
          messageId: 'max:/777:2',
          author: 'Аня',
          timestamp: null,
          dayOnly: false,
          text: 'без даты',
          links: []
        }
      ],
      coverage: 'window',
      status: 'ok',
      code: null
    }
  }
  const report = await runExport(manifest(dir, [collected]), { adapters: {}, now })
  assert.equal(report.chats[0].status, 'ok')
  assert.equal(report.chats[0].count, 3, 'все три сообщения доехали до отчёта')
  assert.equal(report.chats[0].undated, 1, 'сообщение без даты посчитано отдельно')
  assert.equal(report.files.length, 1)

  const content = fs.readFileSync(report.files[0].path, 'utf8')
  // Дата и время — для сообщения с точным часом. Ссылку мост печатает в той же
  // ячейке, что и текст; renderer кладёт в links URL, уже содержащийся в text,
  // поэтому мост обязан отфильтровать такой дубль — в ячейке ровно одна копия.
  const row = content.split('\n').find(line => line.includes('max:/777:0'))
  assert.ok(row, 'строка с датой и ссылкой не найдена:\n' + content)
  assert.ok(row.includes('2026-11-22 09:05'), 'в строке нет даты и времени: ' + row)
  assert.ok(row.includes('https://example.test/doc'), 'ссылка не доехала в ячейку: ' + row)
  assert.equal(
    row.split('https://example.test/doc').length - 1, 1,
    'URL напечатан в ячейке больше одного раза: ' + row
  )
  assert.equal(row.split('|').length, 6, 'ссылка не должна ломать разметку таблицы: ' + row)
  // Только дата — для dayOnly: полдень/полночь не выдумываем.
  assert.ok(
    content.includes('| 2026-11-19 | Пётр | только день | max:/777:1 |'),
    'dayOnly должен печататься без времени:\n' + content
  )
  // Прочерк — для сообщения без даты.
  assert.ok(
    content.includes('| — | Аня | без даты | max:/777:2 |'),
    'сообщение без даты должно получить прочерк:\n' + content
  )
  // Служебные ярлыки сбора не протекают в Markdown.
  assert.equal(/attachment|reaction|sticker/i.test(content), false, 'в MD попали служебные слова сборщика')
})
