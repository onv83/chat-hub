import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// M5: IPC моста MCP-экспорта. В vm исполняется настоящий main.js; electron,
// child_process и os подменены, планировщик таймеров — заглушка (иначе
// 10-минутный таймаут держал бы процесс теста).
const realRequire = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// локальные модули main.js ('./guest-notification-policy', './mcp-export/…')
// резолвим от корня приложения, а не от каталога тестов
const appRequire = createRequire(path.join(root, 'main.js'))
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
const scratch = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hermes/cache/scratch')
fs.mkdirSync(scratch, { recursive: true })

const MM_URL = 'https://im.astralinux.ru/team/channels/general'
const MAX_URL = 'https://web.max.ru/777'
// объекты из vm-контекста имеют чужие прототипы; для strict deepEqual
// сравниваем их приведёнными к обычному JSON
const plain = value => JSON.parse(JSON.stringify(value))

function fakeChild(pid = 4321, order = []) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.killed = false
  child.kill = () => { order.push({ type: 'kill', pid }); child.killed = true; child.exitCode = 0; return true }
  return child
}

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'mcp-ipc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const appDir = options.bridge === false ? fs.mkdtempSync(path.join(dir, 'app-')) : root
  const profileDir = path.join(dir, 'profile')
  const tmpDir = path.join(dir, 'tmp')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'config.json'), JSON.stringify(options.config || { services: [], pinned: [] }))

  const handlers = new Map()
  const appHandlers = new Map()
  const order = []
  const windows = []
  const progress = []
  const spawns = []
  const children = []
  let ready = null

  class FakeWindow {
    static getAllWindows() { return windows }
    constructor() {
      this.webContents = {
        send: (channel, payload) => progress.push({ channel, payload, window: this }),
        setWindowOpenHandler() {}
      }
      windows.push(this)
    }
    on() {}
    loadFile() {}
    setBounds() {}
    maximize() {}
    setOverlayIcon() {}
    isMaximized() { return false }
    getBounds() { return { x: 0, y: 0, width: 1000, height: 800 } }
    isDestroyed() { return false }
    isFocused() { return true }
  }

  const dialogState = { result: { canceled: false, filePaths: [path.join(dir, 'chosen')] }, calls: [] }
  // «Избранное» → MD: путь сохранения выбирается диалогом; состояние отдельное,
  // чтобы не путать его с выбором каталога MCP-выгрузки.
  const saveState = { result: { canceled: true, filePath: '' }, calls: [] }
  const dialog = {
    showErrorBox() {},
    showMessageBox: async () => ({ response: 1 }),
    showOpenDialog: async (...args) => { dialogState.calls.push(args); return dialogState.result },
    showSaveDialog: async (...args) => { saveState.calls.push(args); return saveState.result }
  }

  const childProcess = {
    spawn: (command, args, spawnOptions) => {
      order.push({ type: 'spawn', command, args: Array.from(args || []) })
      const child = fakeChild(4300 + children.length, order)
      children.push(child)
      spawns.push({ command, args, options: spawnOptions })
      return child
    },
    // Windows SecretStore: реальный main.js зовёт powershell Get-Secret. Тест
    // задаёт результат через options.yandexToken (нет — ошибка «секрет не найден»).
    execFile: (file, args, execOptions, callback) => {
      execState.calls.push({ file, args: Array.from(args || []), options: execOptions })
      const cb = typeof execOptions === 'function' ? execOptions : callback
      const { error, stdout } = execState.result
      setImmediate(() => { if (typeof cb === 'function') cb(error, stdout, '') })
      return { on() {} }
    }
  }

  const execState = {
    calls: [],
    result: options.yandexToken === undefined || options.yandexToken === null
      ? { error: Object.assign(new Error('Secret yandex-telemost-oauth-token was not found.'), { code: 1 }), stdout: '' }
      : { error: null, stdout: String(options.yandexToken) + String.fromCharCode(13) + String.fromCharCode(10) }
  }

  const registryState = {
    path: options.registryPath || path.join(dir, 'connectors.json'),
    value: options.registry || { version: 1, connectors: {} },
    error: options.registryError || null
  }
  const registryStub = {
    defaultRegistryPath: () => registryState.path,
    loadRegistry: () => { if (registryState.error) throw registryState.error; return registryState.value },
    ALLOWED_ROOTS: []
  }

  const sessions = new Map()
  // nativeTheme — общий объект: тест темы проверяет, что main меняет источник
  // не только в конфиге, но и в Electron.
  const nativeTheme = {}
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      getPath: () => profileDir,
      getVersion: () => '0.3.5',
      getAppMetrics: () => [],
      on(name, fn) { appHandlers.set(name, [...(appHandlers.get(name) || []), fn]) },
      requestSingleInstanceLock: () => true,
      setAppUserModelId() {},
      whenReady: () => ({ then(fn) { ready = fn } })
    },
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog,
    nativeTheme,
    Menu: { setApplicationMenu() {} },
    shell: { openExternal() {} },
    session: {
      fromPartition(id) {
        if (!sessions.has(id)) sessions.set(id, { setProxy() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} })
        return sessions.get(id)
      }
    },
    webContents: { getAllWebContents: () => [] }
  }

  const timers = []
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron
      if (name === 'child_process' || name === 'node:child_process') return childProcess
      if (name === 'os' || name === 'node:os') return { tmpdir: () => tmpDir }
      if (name === './mcp-export/bridge/registry') return registryStub
      return appRequire(name)
    },
    process: { env: {}, pid: process.pid, platform: 'win32', execPath: process.execPath },
    __dirname: appDir,
    __filename: path.join(appDir, 'main.js'),
    console: { error() {}, warn() {}, log() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout() {},
    setImmediate,
    URL
  })
  vm.runInContext(mainSource, context)
  ready()

  const shellUrl = pathToFileURL(path.join(appDir, 'index.html')).href
  const shellFrame = { url: shellUrl }
  const shellSender = { getType: () => 'window', getURL: () => shellUrl, mainFrame: shellFrame }
  const shellEvent = { sender: shellSender, senderFrame: shellFrame }
  const foreignFrame = { url: 'https://evil.example/' }
  const foreignEvent = {
    sender: { getType: () => 'window', getURL: () => 'https://evil.example/', mainFrame: foreignFrame },
    senderFrame: foreignFrame
  }

  return {
    dir, appDir, profileDir, tmpDir, handlers, appHandlers, order, windows, progress, spawns, children, timers, nativeTheme,
    dialogState, registryState, execState, shellEvent, foreignEvent, shellUrl, saveState,
    get config() { return handlers.get('config:get')(shellEvent) },
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel)
      assert.ok(handler, 'канал ' + channel + ' не зарегистрирован')
      return handler(shellEvent, ...args)
    },
    callAs: async (channel, event, ...args) => {
      const handler = handlers.get(channel)
      assert.ok(handler, 'канал ' + channel + ' не зарегистрирован')
      try { return { value: await handler(event, ...args) } } catch (error) { return { error } }
    },
    saveConfig: cfg => {
      const handler = handlers.get('config:save')
      assert.ok(handler, 'канал config:save не зарегистрирован')
      return handler(shellEvent, cfg)
    },
    openWindow: () => new FakeWindow(),
    manifestDir: () => path.join(tmpDir, 'chathub-mcp-export'),
    bridgePath: () => path.join(appDir, 'mcp-export', 'bridge', 'main.js'),
    closeChild(child, stdout, stderr) {
      if (stdout !== undefined) child.stdout.emit('data', stdout)
      if (stderr !== undefined) child.stderr.emit('data', stderr)
      child.exitCode = 0
      child.emit('close', 0)
    }
  }
}

const basePinned = [
  { id: 'p1', serviceId: 'mm', url: MM_URL, title: 'Общий канал', mcpProject: '14544, 15999' },
  { id: 'p2', serviceId: 'mm', url: 'https://im.astralinux.ru/team/channels/other', title: 'Без проекта', mcpProject: '' },
  { id: 'p3', serviceId: 'max', url: MAX_URL, title: 'MAX', mcpProject: 'bad-project' }
]

function exportConfig(exportDir, extra = {}) {
  return { mcpExportDir: exportDir, mcpExportDepthDays: 30, services: [], pinned: basePinned, ...extra }
}

const report = {
  ok: true, exportedAt: '2026-11-23T13:00:00+07:00', files: [{ project: '14544', path: 'C:/exports/14544_23112026.md', count: 3 }],
  chats: [{ pinId: 'p1', service: 'mm', status: 'ok', code: null, coverage: 'full', count: 3 }],
  truncated: false, errors: []
}

test('mcp IPC: чужой sender получает отказ на всех четырёх каналах', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-foreign')) })
  for (const channel of ['mcp:choose-dir', 'mcp:connector-status', 'mcp:export', 'mcp:cancel']) {
    const { error, value } = await f.callAs(channel, f.foreignEvent, 'mm')
    assert.ok(error, channel + ' должен отказать чужому sender')
    assert.match(String(error.message), /Unauthorized IPC sender/)
    assert.equal(value, undefined)
  }
  assert.equal(f.spawns.length, 0)
})

test('mcpExport: пустой или пробельный exportDir даёт EXPORT_DIR_MISSING без spawn', async t => {
  for (const value of ['', '   ']) {
    const f = fixture(t, { config: { mcpExportDir: value, pinned: basePinned } })
    const result = await f.invoke('mcp:export')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'EXPORT_DIR_MISSING')
    assert.equal(f.spawns.length, 0)
  }
})

test('mcpExport: без пинов с проектом возвращает NO_PROJECTS, skipped и не запускает мост', async t => {
  const f = fixture(t, {
    config: {
      mcpExportDir: path.join(scratch, 'mcp-ipc-out'),
      services: [],
      pinned: [
        { id: 'p2', serviceId: 'mm', url: 'https://im.astralinux.ru/team/channels/other', title: 'Без проекта', mcpProject: '' },
        { id: 'p3', serviceId: 'max', url: MAX_URL, title: 'MAX', mcpProject: 'bad-project' }
      ]
    }
  })
  const result = await f.invoke('mcp:export')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_PROJECTS')
  assert.ok(Array.isArray(result.skipped))
  assert.deepEqual(result.skipped.map(item => item.code), ['bad_project'])
  assert.equal(f.spawns.length, 0)
})

test('mcpExport: exportDir внутри профиля и относительный путь дают EXPORT_DIR_FORBIDDEN', async t => {
  const f = fixture(t, { config: { mcpExportDir: '', pinned: basePinned } })
  assert.equal(await f.saveConfig({ ...f.config, mcpExportDir: path.join(f.profileDir, 'exports') }), true)
  let result = await f.invoke('mcp:export')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXPORT_DIR_FORBIDDEN')
  assert.equal(await f.saveConfig({ ...f.config, mcpExportDir: 'relative/exports' }), true)
  result = await f.invoke('mcp:export')
  assert.equal(result.code, 'EXPORT_DIR_FORBIDDEN')
  assert.equal(await f.saveConfig({ ...f.config, mcpExportDir: f.profileDir }), true)
  result = await f.invoke('mcp:export')
  assert.equal(result.code, 'EXPORT_DIR_FORBIDDEN')
  assert.equal(f.spawns.length, 0)
})

test('mcpExport: отсутствие файла моста даёт BRIDGE_MISSING без spawn и без manifest', async t => {
  const f = fixture(t, { bridge: false, config: exportConfig(path.join(scratch, 'mcp-ipc-out')) })
  const result = await f.invoke('mcp:export')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BRIDGE_MISSING')
  assert.equal(f.spawns.length, 0)
  assert.equal(fs.existsSync(f.manifestDir()), false)
})

test('mcpExport: успешный запуск передаёт --manifest/--out/--registry, ELECTRON_RUN_AS_NODE и shell:false', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-success')
  const f = fixture(t, { config: exportConfig(exportDir) })
  const pending = f.invoke('mcp:export')
  assert.equal(f.spawns.length, 1)
  const [spawn] = f.spawns
  assert.equal(spawn.command, process.execPath)
  const args = spawn.args
  assert.equal(args[0], f.bridgePath())
  assert.equal(args[args.indexOf('--manifest') + 1] !== undefined, true)
  assert.equal(args[args.indexOf('--out') + 1], exportDir)
  assert.equal(args[args.indexOf('--registry') + 1], f.registryState.path)
  assert.equal(spawn.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(spawn.options.shell, false)
  assert.equal(spawn.options.windowsHide, true)
  assert.deepEqual(Array.from(spawn.options.stdio), ['ignore', 'pipe', 'pipe'])
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  assert.deepEqual(plain(await pending), report)
})

test('mcpExport: manifest содержит только пины с проектом и валидными projects, depthDays из конфига', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-manifest')
  const f = fixture(t, { config: exportConfig(exportDir) })
  const pending = f.invoke('mcp:export')
  const args = f.spawns[0].args
  const manifestPath = args[args.indexOf('--manifest') + 1]
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.depthDays, 30)
  assert.equal(manifest.exportDir, exportDir)
  assert.equal(manifest.chats.length, 1)
  assert.deepEqual(manifest.chats[0].projects, ['14544', '15999'])
  assert.equal(manifest.chats[0].pinId, 'p1')
  assert.equal(manifest.chats[0].service, 'mm')
  assert.equal(manifest.chats[0].chatId, 'team/general')
  assert.equal(manifest.skipped.length, 1)
  assert.equal(manifest.skipped[0].pinId, 'p3')
  assert.equal(manifest.skipped[0].code, 'bad_project')
  assert.equal(JSON.stringify(manifest).includes(MM_URL + '"'), true)
  assert.equal('pinned' in manifest, false)
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

test('mcpExport: аргументы renderer игнорируются, manifest собирается из конфига main', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-args')
  const f = fixture(t, { config: exportConfig(exportDir) })
  const pending = f.invoke('mcp:export', { exportDir: 'C:/evil', depthDays: 1, chats: [{ pinId: 'evil' }] }, ['p9'], 'max')
  const args = f.spawns[0].args
  assert.equal(args[args.indexOf('--out') + 1], exportDir)
  const manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'))
  assert.equal(manifest.exportDir, exportDir)
  assert.equal(manifest.depthDays, 30)
  assert.deepEqual(manifest.chats.map(chat => chat.pinId), ['p1'])
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

test('mcpExport: повторный вызов при активном экспорте даёт EXPORT_BUSY и не плодит процессы', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-busy')) })
  const pending = f.invoke('mcp:export')
  const busy = await f.invoke('mcp:export')
  assert.equal(busy.ok, false)
  assert.equal(busy.code, 'EXPORT_BUSY')
  assert.equal(f.spawns.length, 1)
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

test('mcpExport: отчёт моста возвращается как есть, мусорная stderr-строка не ломает отчёт', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-report')) })
  const other = f.openWindow()
  const pending = f.invoke('mcp:export')
  const child = f.children[0]
  const stderr = '{"event":"connector_start","service":"mm"}\nnot-json\n{"event":"connector_done","service":"mm"}\n'
  f.closeChild(child, 'progress noise\n' + JSON.stringify(report) + '\n', stderr)
  const result = await pending
  assert.deepEqual(plain(result), report)
  assert.equal(f.progress.length, 3)
  assert.deepEqual(f.progress.map(item => item.payload.event), ['connector_start', 'connector_stderr', 'connector_done'])
  assert.equal(f.progress[1].payload.line, 'not-json')
  assert.ok(f.progress.every(item => item.channel === 'mcp:progress'))
  assert.ok(f.progress.every(item => item.window === f.windows[0]))
  assert.equal(f.progress.some(item => item.window === other), false)
})

test('mcpCancel: убивает дерево процесса и возвращает true, без процесса — false', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-cancel')) })
  assert.equal(await f.invoke('mcp:cancel'), false)
  const pending = f.invoke('mcp:export')
  const child = f.children[0]
  assert.equal(await f.invoke('mcp:cancel'), true)
  assert.equal(child.killed, true)
  const taskkill = f.spawns.filter(spawn => spawn.command === 'taskkill')
  assert.equal(taskkill.length, 1)
  assert.deepEqual(Array.from(taskkill[0].args), ['/pid', String(child.pid), '/T', '/F'])
  assert.equal(await f.invoke('mcp:cancel'), false)
  f.closeChild(child, '')
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXPORT_CANCELLED')
  assert.equal(await f.invoke('mcp:cancel'), false)
})

test('mcpExport: временный manifest удаляется после успеха и после ошибки', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-cleanup')) })
  let pending = f.invoke('mcp:export')
  const first = f.spawns[0].args[f.spawns[0].args.indexOf('--manifest') + 1]
  assert.equal(fs.existsSync(first), true)
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
  assert.equal(fs.existsSync(first), false)
  assert.deepEqual(fs.readdirSync(f.manifestDir()), [])
  pending = f.invoke('mcp:export')
  const second = f.spawns[1].args[f.spawns[1].args.indexOf('--manifest') + 1]
  f.closeChild(f.children[1], '')
  const failed = await pending
  assert.equal(failed.code, 'EXPORT_FAILED')
  assert.equal(fs.existsSync(second), false)
  assert.deepEqual(fs.readdirSync(f.manifestDir()), [])
})

test('mcpExport: ровно один spawn на экспорт', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-single')) })
  const pending = f.invoke('mcp:export')
  assert.equal(f.spawns.filter(spawn => spawn.command !== 'taskkill').length, 1)
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
  assert.equal(f.spawns.filter(spawn => spawn.command !== 'taskkill').length, 1)
})

test('mcpExport: таймаут экспорта убивает дерево и возвращает EXPORT_TIMEOUT', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-timeout')) })
  const pending = f.invoke('mcp:export')
  const child = f.children[0]
  const timer = f.timers.find(item => item.ms === 10 * 60 * 1000)
  assert.ok(timer, 'таймаут экспорта не зарегистрирован')
  timer.fn()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXPORT_TIMEOUT')
  assert.equal(child.killed, true)
  assert.equal(f.spawns.filter(spawn => spawn.command === 'taskkill').length, 1)
  assert.deepEqual(fs.readdirSync(f.manifestDir()), [])
})

test('mcpConnectorStatus: установленный коннектор из реестра, отсутствующий и невалидный сервис', async t => {
  const registry = {
    version: 1,
    connectors: {
      mm: { mode: 'existing', command: 'C:/Users/Lenovo/mcp/mm/run.exe', args: [], env: {}, tools: ['mmchat_read_channel'] }
    }
  }
  const f = fixture(t, { config: { services: [], pinned: [] }, registry })
  const mm = await f.invoke('mcp:connector-status', 'mm')
  assert.deepEqual(plain(mm), { service: 'mm', installed: true, path: 'C:/Users/Lenovo/mcp/mm/run.exe', mode: 'existing', tools: ['mmchat_read_channel'] })
  const max = await f.invoke('mcp:connector-status', 'max')
  assert.deepEqual(plain(max), { service: 'max', installed: false, path: null, mode: null, tools: [] })
  for (const bad of ['tg', '', null, 7]) {
    const result = await f.invoke('mcp:connector-status', bad)
    assert.equal(result.installed, false)
    assert.equal(result.code, 'INVALID_SERVICE')
  }
})

test('mcpConnectorStatus: отсутствие файла реестра не бросает исключение', async t => {
  const error = new Error('REGISTRY_MISSING: нет файла')
  error.code = 'REGISTRY_MISSING'
  const f = fixture(t, { config: { services: [], pinned: [] }, registryError: error })
  const result = await f.invoke('mcp:connector-status', 'mm')
  assert.deepEqual(plain(result), { service: 'mm', installed: false, path: null, mode: null, tools: [] })
})

test('mcpChooseDir: путь берётся из диалога, аргументы renderer не участвуют', async t => {
  const f = fixture(t, { config: { services: [], pinned: [] } })
  const chosen = path.join(f.dir, 'export-choice')
  f.dialogState.result = { canceled: false, filePaths: [chosen] }
  const result = await f.invoke('mcp:choose-dir', 'C:/evil', { path: 'C:/evil' })
  assert.deepEqual(plain(result), { canceled: false, path: chosen })
  assert.equal(f.dialogState.calls.length, 1)
  assert.equal(f.dialogState.calls[0][0], f.windows[0])
  assert.deepEqual(Array.from(f.dialogState.calls[0][1].properties), ['openDirectory', 'createDirectory'])
  f.dialogState.result = { canceled: true, filePaths: [] }
  assert.deepEqual(plain(await f.invoke('mcp:choose-dir')), { canceled: true, path: '' })
})

test('preload: мост отдаёт четыре метода и прогресс с отпиской', () => {
  const listeners = new Map()
  const invoked = []
  let exposed = null
  const ipcRenderer = {
    invoke: (...args) => { invoked.push(args); return Promise.resolve(null) },
    on(channel, callback) { listeners.set(channel, [...(listeners.get(channel) || []), callback]) },
    removeListener(channel, callback) {
      listeners.set(channel, (listeners.get(channel) || []).filter(item => item !== callback))
    }
  }
  vm.runInNewContext(preloadSource, {
    require: name => name === 'electron' ? { contextBridge: { exposeInMainWorld: (key, api) => { exposed = { key, api } } }, ipcRenderer } : realRequire(name),
    Promise,
    console
  })
  assert.equal(exposed.key, 'hub')
  const hub = exposed.api
  for (const name of ['mcpChooseDir', 'mcpConnectorStatus', 'mcpConnectorInstall', 'mcpConnectorConnect', 'mcpProbe', 'mcpExport', 'mcpCancel', 'onMcpProgress']) {
    assert.equal(typeof hub[name], 'function', 'preload не отдаёт ' + name)
  }
  hub.mcpExport()
  hub.mcpCancel()
  hub.mcpConnectorStatus('mm')
  hub.mcpConnectorInstall('mm')
  hub.mcpConnectorConnect('max')
  hub.mcpProbe('mm')
  hub.mcpChooseDir()
  assert.deepEqual(invoked, [
    ['mcp:export'], ['mcp:cancel'], ['mcp:connector-status', 'mm'],
    ['mcp:connector-install', 'mm'], ['mcp:connector-connect', 'max'], ['mcp:probe', 'mm'],
    ['mcp:choose-dir']
  ])
  const received = []
  const unsubscribe = hub.onMcpProgress(event => received.push(event))
  assert.equal(typeof unsubscribe, 'function')
  const [channel, handlers] = [...listeners.entries()][0]
  assert.equal(channel, 'mcp:progress')
  handlers[0]({}, { event: 'connector_start' })
  assert.deepEqual(received, [{ event: 'connector_start' }])
  unsubscribe()
  assert.equal((listeners.get('mcp:progress') || []).length, 0)
})

// --- Каналы окна-оболочки: версия, путь конфига, тема, фокус, память сервисов ---
// Эти каналы не относятся к MCP-экспорту, но живут в том же preload-мосте и под
// тем же requireShellSender: мета-тест покрытия находит их среди ipcMain.handle,
// поэтому здесь фиксируется и их контракт.

test('preload: каждый метод моста вызывает ровно свой канал', () => {
  // Карта — исполняемая спецификация моста: имя метода → [канал, аргумент].
  // onMcpProgress в invoke-карту не входит: это подписка, а не вызов.
  const expected = {
    getConfig: ['config:get', undefined],
    saveConfig: ['config:save', { theme: 'light' }],
    configPath: ['config:path', undefined],
    reportTelemostConnection: ['diagnostics:telemost-connection', { ok: true }],
    getVersion: ['app:version', undefined],
    setThemeSource: ['theme:set-source', 'light'],
    isWinFocused: ['win:focused', undefined],
    getServiceMemoryMetrics: ['service-memory:metrics', undefined],
    mcpChooseDir: ['mcp:choose-dir', undefined],
    mcpConnectorStatus: ['mcp:connector-status', 'mm'],
    mcpConnectorInstall: ['mcp:connector-install', 'mm'],
    mcpConnectorConnect: ['mcp:connector-connect', 'max'],
    mcpProbe: ['mcp:probe', 'ydx'],
    mcpExport: ['mcp:export', undefined],
    mcpCancel: ['mcp:cancel', undefined],
    favoritesExport: ['favorites:export', undefined]
  }
  const listeners = new Map()
  const invoked = []
  let exposed = null
  const ipcRenderer = {
    invoke: (...args) => { invoked.push(args); return Promise.resolve(null) },
    on(channel, callback) { listeners.set(channel, [...(listeners.get(channel) || []), callback]) },
    removeListener(channel, callback) {
      listeners.set(channel, (listeners.get(channel) || []).filter(item => item !== callback))
    }
  }
  vm.runInNewContext(preloadSource, {
    require: name => name === 'electron' ? { contextBridge: { exposeInMainWorld: (key, api) => { exposed = { key, api } } }, ipcRenderer } : realRequire(name),
    Promise,
    console
  })
  assert.equal(exposed.key, 'hub')
  const hub = exposed.api
  // Дрейф в обе стороны: лишний метод моста и пропавший метод одинаково ломают UI.
  assert.deepEqual(Object.keys(hub).sort(), [...Object.keys(expected), 'onMcpProgress'].sort())
  for (const [name, [channel, arg]] of Object.entries(expected)) {
    assert.equal(typeof hub[name], 'function', 'preload не отдаёт ' + name)
    hub[name](arg)
    const last = invoked[invoked.length - 1]
    assert.equal(last[0], channel, name + ' должен звать ' + channel)
    if (arg === undefined) assert.equal(last.length, 1, name + ' не должен передавать аргументы')
    else assert.deepEqual(last.slice(1), [arg], name + ' передаёт аргумент как есть')
  }
  assert.equal(typeof hub.onMcpProgress, 'function')
  assert.equal(invoked.length, Object.keys(expected).length)
})

test('shell IPC: config:path и app:version отвечают только оболочке', async t => {
  const f = fixture(t, { config: { services: [], pinned: [] } })
  assert.equal(f.invoke('config:path'), path.join(f.profileDir, 'config.json'))
  assert.equal(f.invoke('app:version'), '0.3.5')
  for (const channel of ['config:path', 'app:version']) {
    const { error, value } = await f.callAs(channel, f.foreignEvent)
    assert.ok(error, channel + ' должен отказать чужому sender')
    assert.match(String(error.message), /Unauthorized IPC sender/)
    assert.equal(value, undefined)
  }
})

test('shell IPC: theme:set-source меняет тему конфига и nativeTheme, мусор тему не двигает', async t => {
  const f = fixture(t, { config: { services: [], pinned: [], theme: 'dark' } })
  assert.equal(f.invoke('theme:set-source', 'light'), true)
  assert.equal(f.config.theme, 'light', 'тема сохранена в конфиге')
  assert.equal(f.nativeTheme.themeSource, 'light', 'Electron получил источник темы')
  assert.equal(f.invoke('theme:set-source', 'dark'), true)
  assert.equal(f.config.theme, 'dark')
  assert.equal(f.nativeTheme.themeSource, 'dark')
  // Неизвестное значение не выбирает тему конфига: остаётся прежняя.
  assert.equal(f.invoke('theme:set-source', 'sepia'), true)
  assert.equal(f.config.theme, 'dark')
  const { error } = await f.callAs('theme:set-source', f.foreignEvent, 'light')
  assert.ok(error)
  assert.match(String(error.message), /Unauthorized IPC sender/)
  assert.equal(f.config.theme, 'dark', 'чужой sender тему не переключил')
})

test('shell IPC: win:focused отражает настоящее окно, а не документ renderer', async t => {
  const f = fixture(t, { config: { services: [], pinned: [] } })
  assert.ok(f.windows.length >= 1, 'окно-оболочка должна существовать')
  assert.equal(f.invoke('win:focused'), true, 'окно сфокусировано')
  for (const win of f.windows) win.isFocused = () => false
  assert.equal(f.invoke('win:focused'), false, 'фокус ушёл в webview — окно не в фокусе')
  f.windows[f.windows.length - 1].isFocused = () => true
  assert.equal(f.invoke('win:focused'), true)
  const { error } = await f.callAs('win:focused', f.foreignEvent)
  assert.ok(error)
  assert.match(String(error.message), /Unauthorized IPC sender/)
})

test('shell IPC: service-memory:metrics отдаёт санированный снимок без аргументов', async t => {
  const f = fixture(t, { config: { services: [], pinned: [] } })
  // Метрик ещё нет — снимок обязан быть пустым, но правильной формы: без
  // порогов, cooldown и прочих внутренних полей, и без доверия аргументам.
  const empty = plain(f.invoke('service-memory:metrics', { pid: 1, url: 'https://evil.example/' }))
  assert.deepEqual(empty, { services: [], totalMiB: 0 })
  assert.deepEqual(Object.keys(empty).sort(), ['services', 'totalMiB'])
  const { error, value } = await f.callAs('service-memory:metrics', f.foreignEvent)
  assert.ok(error)
  assert.match(String(error.message), /Unauthorized IPC sender/)
  assert.equal(value, undefined)
})

// --- M7: установка, подключение и проверка коннекторов ---

test('mcpConnectorInstall: неизвестный сервис — INVALID_SERVICE без spawn', async t => {
  const f = fixture(t, { config: { services: [], pinned: [] } })
  for (const bad of ['tg', '', null, 7]) {
    const result = await f.invoke('mcp:connector-install', bad)
    assert.deepEqual(plain(result), { ok: false, code: 'INVALID_SERVICE' })
  }
  assert.equal(f.spawns.length, 0)
})

test('mcpConnectorInstall: ydx без токена SecretStore — TOKEN_MISSING без spawn', async t => {
  const registry = {
    version: 1,
    connectors: {
      ydx: { mode: 'existing', command: 'C:/x/ydx.exe', args: [], env: {}, tools: ['favorite_chats_list'] }
    }
  }
  const f = fixture(t, { config: { services: [], pinned: [] }, registry })
  for (const channel of ['mcp:connector-install', 'mcp:connector-connect', 'mcp:probe']) {
    const result = await f.invoke(channel, 'ydx')
    assert.deepEqual(plain(result), { ok: false, code: 'TOKEN_MISSING' }, channel)
  }
  assert.equal(f.spawns.length, 0, 'без токена коннектор не запускается')
  assert.equal(f.dialogState.calls.length, 0, 'диалог каталога не открывается без токена')
  assert.equal(f.execState.calls.length, 3, 'токен спрашивается у SecretStore')
  const command = f.execState.calls[0].args.join(' ')
  assert.match(command, /Get-Secret -Name yandex-telemost-oauth-token -AsPlainText/)
})

test('mcpConnectorConnect: отмена диалога — CANCELLED, каталог берётся только из диалога', async t => {
  const f = fixture(t, { config: { services: [], pinned: [] } })
  f.dialogState.result = { canceled: true, filePaths: [] }
  const result = await f.invoke('mcp:connector-connect', 'mm', 'C:/evil', { path: 'C:/evil' })
  assert.deepEqual(plain(result), { ok: false, code: 'CANCELLED' })
  assert.equal(f.dialogState.calls.length, 1)
  assert.deepEqual(Array.from(f.dialogState.calls[0][1].properties), ['openDirectory'])
  assert.equal(f.spawns.length, 0)
})

test('mcpProbe: без записи в реестре — NOT_INSTALLED без spawn, неизвестный сервис отвергается', async t => {
  const f = fixture(t, { config: { services: [], pinned: [] } })
  for (const service of ['mm', 'max']) {
    const result = await f.invoke('mcp:probe', service)
    assert.deepEqual(plain(result), { ok: false, code: 'NOT_INSTALLED' })
  }
  assert.deepEqual(plain(await f.invoke('mcp:probe', 'tg')), { ok: false, code: 'INVALID_SERVICE' })
  assert.equal(f.spawns.length, 0)
})

test('mcp IPC: каналы коннекторов отвергают чужой sender', async t => {
  const f = fixture(t, { config: { services: [], pinned: [] } })
  for (const channel of ['mcp:connector-install', 'mcp:connector-connect', 'mcp:probe']) {
    const { error, value } = await f.callAs(channel, f.foreignEvent, 'mm')
    assert.ok(error, channel + ' должен отказать чужому sender')
    assert.match(String(error.message), /Unauthorized IPC sender/)
    assert.equal(value, undefined)
  }
  assert.equal(f.spawns.length, 0)
  assert.equal(f.dialogState.calls.length, 0)
})

// --- M9-R2 D5: manifest не переживает выход из приложения ---

test('manifest: зарегистрирован will-quit, вызов обработчика удаляет активный manifest', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-quit')) })
  const pending = f.invoke('mcp:export')
  const manifestPath = f.spawns[0].args[f.spawns[0].args.indexOf('--manifest') + 1]
  assert.equal(fs.existsSync(manifestPath), true)
  const quit = f.appHandlers.get('will-quit') || []
  assert.ok(quit.length >= 1, 'will-quit не зарегистрирован')
  assert.ok((f.appHandlers.get('before-quit') || []).length >= 1, 'before-quit не зарегистрирован')
  quit[0]()
  assert.equal(fs.existsSync(manifestPath), false, 'will-quit должен удалить manifest')
  // повторный вызов безопасен
  quit[0]()
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
  assert.deepEqual(fs.readdirSync(f.manifestDir()), [])
})

test('manifest: при первом экспорте удаляются остатки старше 24 часов', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-sweep')) })
  fs.mkdirSync(f.manifestDir(), { recursive: true })
  const stale = path.join(f.manifestDir(), 'chathub-manifest-1111-aaaa.json')
  const fresh = path.join(f.manifestDir(), 'chathub-manifest-2222-bbbb.json')
  const foreign = path.join(f.manifestDir(), 'notes.txt')
  fs.writeFileSync(stale, '{}')
  fs.writeFileSync(fresh, '{}')
  fs.writeFileSync(foreign, 'x')
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
  fs.utimesSync(stale, old, old)
  const pending = f.invoke('mcp:export')
  assert.equal(fs.existsSync(stale), false, 'старый manifest должен быть удалён')
  assert.equal(fs.existsSync(fresh), true, 'свежий manifest не трогаем')
  assert.equal(fs.existsSync(foreign), true, 'чужие файлы не трогаем')
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

// --- M9-R2 D6: порядок taskkill /T до child.kill ---

test('killTree: taskkill дерева вызывается раньше child.kill', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-kill-order')) })
  const pending = f.invoke('mcp:export')
  const child = f.children[0]
  assert.equal(await f.invoke('mcp:cancel'), true)
  const taskkillIndex = f.order.findIndex(item => item.type === 'spawn' && item.command === 'taskkill')
  const killIndex = f.order.findIndex(item => item.type === 'kill' && item.pid === child.pid)
  assert.ok(taskkillIndex >= 0, 'taskkill не вызван')
  assert.ok(killIndex >= 0, 'child.kill не вызван')
  assert.ok(taskkillIndex < killIndex, 'taskkill /T должен идти до child.kill')
  assert.equal(child.killed, true)
  f.closeChild(child, '')
  await pending
})

// --- M9-R3 F4: уборка manifest при каждом экспорте и живучий taskkill ---

test('manifest: уборка идёт при каждом экспорте и удаляет старше часа', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-sweep2')) })
  fs.mkdirSync(f.manifestDir(), { recursive: true })
  // 2 часа: старше нового порога в час, но младше прежних суток.
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const stale1 = path.join(f.manifestDir(), 'chathub-manifest-1111-aaaa.json')
  const fresh = path.join(f.manifestDir(), 'chathub-manifest-2222-bbbb.json')
  fs.writeFileSync(stale1, '{}')
  fs.writeFileSync(fresh, '{}')
  fs.utimesSync(stale1, old, old)

  let pending = f.invoke('mcp:export')
  assert.equal(fs.existsSync(stale1), false, 'manifest старше часа удаляется при первом экспорте')
  assert.equal(fs.existsSync(fresh), true, 'свежий manifest не трогаем')
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending

  // Второй экспорт обязан убрать новый старый файл: sweep не одноразовый.
  const stale2 = path.join(f.manifestDir(), 'chathub-manifest-3333-cccc.json')
  fs.writeFileSync(stale2, '{}')
  fs.utimesSync(stale2, old, old)
  pending = f.invoke('mcp:export')
  assert.equal(fs.existsSync(stale2), false, 'второй экспорт тоже убирает старые manifest')
  assert.equal(fs.existsSync(fresh), true, 'свежий manifest не трогаем и на втором проходе')
  f.closeChild(f.children[1], JSON.stringify(report) + '\n')
  await pending
})

test('taskkill: ошибка спавна не роняет отмену экспорта', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-taskkill-error')) })
  const pending = f.invoke('mcp:export')
  const bridgeChild = f.children[0]
  assert.equal(await f.invoke('mcp:cancel'), true)
  const taskkillChild = f.children.find(child => child !== bridgeChild)
  assert.ok(taskkillChild, 'taskkill должен спавниться в killMcpTree')
  assert.equal(f.spawns.filter(spawn => spawn.command === 'taskkill').length, 1)
  // Без .on('error') этот emit бросил бы необработанное исключение.
  assert.doesNotThrow(() => taskkillChild.emit('error', new Error('taskkill не найден')))
  f.closeChild(bridgeChild, '')
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXPORT_CANCELLED')
})

// --- MAX через webview ChatHub: сбор в окне-оболочке, prefetched в manifest ---

const tick = () => new Promise(resolve => setImmediate(resolve))

function maxPrefetchedPayload(pinId, messages, extra = {}) {
  return JSON.stringify({
    chats: [{ pinId, status: 'ok', code: null, coverage: 'window', messages, ...extra }],
    restored: true
  })
}

test('mcpExport: MAX-чаты собираются через окно-оболочку и попадают в manifest как prefetched', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-max-prefetch')
  const pins = [
    { id: 'pmax', serviceId: 'max', url: MAX_URL, title: 'MAX чат', mcpProject: '14544' },
    { id: 'pmm', serviceId: 'mm', url: MM_URL, title: 'Общий канал', mcpProject: '14544' }
  ]
  const f = fixture(t, { config: exportConfig(exportDir, { pinned: pins }) })
  const calls = []
  // Строгий мок окна: main обязан звать сбор через window. Любая другая строка —
  // дефект вызова, в живом Electron это TypeError (undefined is not a function).
  f.shellEvent.sender.executeJavaScript = async code => {
    calls.push(code)
    if (!/^window\.__chatHubCollectMaxHistory\(/.test(code)) {
      throw new Error('сбор MAX вызван не через window: ' + code)
    }
    return maxPrefetchedPayload('pmax', [{
      service: 'max', chatId: '777', messageId: 'max:/777:0', author: 'Иван',
      timestamp: '2026-11-22T10:00:00+07:00', text: 'из окна ChatHub', links: []
    }], {
      // DOM-диагностика чтения едет в manifest вместе с prefetched-чатом.
      diag: {
        roots: 1, capsuleCount: 2, capsuleSamples: ['19 ноября 2026', 'Сегодня'],
        wrapperCount: 2, metaCount: 2, metaSamples: ['10:05', '11:30'],
        historyClasses: ['history', 'history--withBottomMargin']
      }
    })
  }
  const pending = f.invoke('mcp:export')
  await tick()
  assert.equal(calls.length, 1, 'сбор MAX должен идти одним вызовом окна')
  assert.match(calls[0], /window\.__chatHubCollectMaxHistory\(/)
  assert.equal(calls[0].includes('pmax'), true)
  assert.equal(calls[0].includes('pmm'), false, 'в запрос сбора попадают только MAX-чаты')
  const args = f.spawns[0].args
  const manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'))
  const maxChat = manifest.chats.find(item => item.pinId === 'pmax')
  const mmChat = manifest.chats.find(item => item.pinId === 'pmm')
  assert.equal(maxChat.prefetched.status, 'ok')
  assert.equal(maxChat.prefetched.coverage, 'window')
  assert.equal(maxChat.prefetched.code, null)
  assert.deepEqual(maxChat.prefetched.messages.map(item => item.text), ['из окна ChatHub'])
  // DOM-диагностика не теряется на пути renderer → main → manifest.
  assert.equal(maxChat.prefetched.diag.capsuleCount, 2)
  assert.deepEqual(maxChat.prefetched.diag.capsuleSamples, ['19 ноября 2026', 'Сегодня'])
  assert.equal('prefetched' in mmChat, false, 'каналы кроме MAX не трогаем')
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

test('mcpExport: MAX coverage и граница глубины доходят из окна до manifest', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-max-coverage')
  const pins = [{ id: 'pmax', serviceId: 'max', url: MAX_URL, title: 'MAX чат', mcpProject: '14544' }]
  const f = fixture(t, { config: exportConfig(exportDir, { pinned: pins }) })
  let request = null
  f.shellEvent.sender.executeJavaScript = async code => {
    request = JSON.parse(code.slice(code.indexOf('(') + 1, code.lastIndexOf(')')))
    return JSON.stringify({
      chats: [{ pinId: 'pmax', status: 'ok', code: null, coverage: 'full', messages: [] }],
      restored: true
    })
  }
  const pending = f.invoke('mcp:export')
  await tick()
  // Глубина прокрутки та же, что у моста: 30 дней из конфига.
  assert.ok(Number.isFinite(request.windowStartMs), 'запрос несёт windowStartMs')
  assert.ok(Math.abs(Date.now() - 30 * 24 * 60 * 60 * 1000 - request.windowStartMs) < 60000,
    'граница глубины — 30 дней от текущего момента')
  const args = f.spawns[0].args
  const manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'))
  assert.equal(manifest.chats.find(item => item.pinId === 'pmax').prefetched.coverage, 'full')
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

test('mcpExport: падение сбора MAX не мешает MM и даёт MAX_COLLECT_FAILED', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-max-failed')
  const pins = [
    { id: 'pmax', serviceId: 'max', url: MAX_URL, title: 'MAX чат', mcpProject: '14544' },
    { id: 'pmm', serviceId: 'mm', url: MM_URL, title: 'Общий канал', mcpProject: '14544' }
  ]
  const f = fixture(t, { config: exportConfig(exportDir, { pinned: pins }) })
  f.shellEvent.sender.executeJavaScript = async () => { throw new Error('renderer недоступен') }
  const pending = f.invoke('mcp:export')
  await tick()
  assert.equal(f.spawns.length, 1, 'мост должен запуститься несмотря на сбой сбора MAX')
  const args = f.spawns[0].args
  const manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'))
  const maxChat = manifest.chats.find(item => item.pinId === 'pmax')
  const mmChat = manifest.chats.find(item => item.pinId === 'pmm')
  assert.equal(maxChat.prefetched.status, 'error')
  assert.equal(maxChat.prefetched.code, 'MAX_COLLECT_FAILED')
  assert.deepEqual(maxChat.prefetched.messages, [])
  assert.equal('prefetched' in mmChat, false)
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

// --- YANDEX-ADAPTER: токен Яндекса идёт только через env моста ---

const YDX_URL = 'https://telemost.yandex.ru/chats/0%2F11%2Faaaaaaaa-1111-4111-8111-111111111111'
const YDX_TOKEN = 'yandex-oauth-token-secret-123'

function ydxPins() {
  return [
    { id: 'py', serviceId: 'ydx', url: YDX_URL, title: 'Портал-Юг', mcpProject: '14544' },
    { id: 'pmm', serviceId: 'mm', url: MM_URL, title: 'Общий канал', mcpProject: '14544' }
  ]
}

function ydxReport() {
  return {
    ok: false,
    exportedAt: '2026-11-23T13:00:00+07:00',
    files: [{ project: '14544', path: 'C:/exports/14544_23112026.md', count: 2 }],
    chats: [
      { pinId: 'py', service: 'ydx', status: 'error', code: 'TOKEN_MISSING', coverage: null, count: 0, undated: 0 },
      { pinId: 'pmm', service: 'mm', status: 'ok', code: null, coverage: 'full', count: 2, undated: 0 }
    ],
    truncated: false,
    errors: [{ code: 'TOKEN_MISSING', message: 'токен Яндекса не передан' }]
  }
}

test('mcpExport: ydx без токена не блокирует MM, токена нет в env и manifest', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-ydx-no-token')
  const f = fixture(t, { config: exportConfig(exportDir, { pinned: ydxPins() }) })
  const pending = f.invoke('mcp:export')
  await tick()
  assert.equal(f.spawns.length, 1, 'мост запускается, MM продолжается')
  const [spawn] = f.spawns
  assert.equal('CHATHUB_YDX_TOKEN' in spawn.options.env, false, 'без токена env моста чист')
  assert.equal(spawn.args.some(arg => String(arg).includes('yandex-telemost-oauth-token')), false)
  const manifestText = fs.readFileSync(spawn.args[spawn.args.indexOf('--manifest') + 1], 'utf8')
  const manifest = JSON.parse(manifestText)
  assert.deepEqual(manifest.chats.map(chat => chat.service), ['ydx', 'mm'])
  assert.equal(manifest.chats[0].title, 'Портал-Юг')
  assert.equal(manifestText.includes('CHATHUB_YDX_TOKEN'), false)
  assert.equal(manifestText.includes('oauth'), false)
  f.closeChild(f.children[0], JSON.stringify(ydxReport()) + '\n')
  const result = await pending
  assert.equal(result.chats.find(chat => chat.service === 'ydx').code, 'TOKEN_MISSING')
  assert.equal(result.chats.find(chat => chat.service === 'mm').status, 'ok', 'MM выгружен несмотря на ydx')
  assert.equal(JSON.stringify(result).includes(YDX_TOKEN), false)
})

test('mcpExport: токен Яндекса передаётся мосту только через env и не попадает в manifest/отчёт', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-ydx-token')
  const f = fixture(t, { config: exportConfig(exportDir, { pinned: ydxPins() }), yandexToken: YDX_TOKEN })
  const pending = f.invoke('mcp:export')
  await tick()
  assert.equal(f.spawns.length, 1)
  const [spawn] = f.spawns
  assert.equal(spawn.options.env.CHATHUB_YDX_TOKEN, YDX_TOKEN, 'токен доходит до моста через env')
  assert.equal(spawn.args.some(arg => String(arg).includes(YDX_TOKEN)), false, 'в аргументах токена нет')
  const manifestPath = spawn.args[spawn.args.indexOf('--manifest') + 1]
  const manifestText = fs.readFileSync(manifestPath, 'utf8')
  assert.equal(manifestText.includes(YDX_TOKEN), false, 'в manifest токена нет')
  assert.equal(manifestText.includes('CHATHUB_YDX_TOKEN'), false)
  // Проверка вызова SecretStore: только чтение секрета по имени, без вывода значения.
  assert.equal(f.execState.calls.length, 1)
  assert.equal(f.execState.calls[0].args[0], '-NoProfile')
  assert.equal(f.execState.calls[0].args.includes('-Command'), true)
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  const result = await pending
  assert.equal(JSON.stringify(result).includes(YDX_TOKEN), false, 'в отчёте токена нет')
  assert.equal(JSON.stringify(plain(result)), JSON.stringify(report))
})

test('mcpExport: без ydx-чатов SecretStore не читается вовсе', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-no-ydx')) })
  const pending = f.invoke('mcp:export')
  assert.equal(f.execState.calls.length, 0, 'токен не нужен — powershell не запускается')
  assert.equal(f.spawns.length, 1)
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

test('mcpExport: без MAX-чатов сбор в окне не вызывается', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-no-max')) })
  let calls = 0
  f.shellEvent.sender.executeJavaScript = async () => { calls += 1; return '{}' }
  const pending = f.invoke('mcp:export')
  assert.equal(calls, 0)
  assert.equal(f.spawns.length, 1)
  assert.equal(f.execState.calls.length, 0, 'без ydx-чатов SecretStore не читается')
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

test('mcpExport: окно принимает только window.__chatHubCollectMaxHistory и отдаёт prefetched в manifest', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-max-window')
  const pins = [
    { id: 'pmax', serviceId: 'max', url: MAX_URL, title: 'MAX чат', mcpProject: '14544' },
    { id: 'pmm', serviceId: 'mm', url: MM_URL, title: 'Общий канал', mcpProject: '14544' }
  ]
  const f = fixture(t, { config: exportConfig(exportDir, { pinned: pins }) })
  const calls = []
  // Как в живом Electron: по имени функции окно отвечает undefined → TypeError.
  // Принимаем единственную форму вызова — через window.
  f.shellEvent.sender.executeJavaScript = async code => {
    calls.push(code)
    if (!/^window\.__chatHubCollectMaxHistory\(/.test(code)) throw new Error('TypeError: undefined is not a function')
    return maxPrefetchedPayload('pmax', [{
      service: 'max', chatId: '777', messageId: 'max:/777:0', author: 'Иван',
      timestamp: '2026-11-22T10:00:00+07:00', text: 'из окна ChatHub', links: []
    }])
  }
  const pending = f.invoke('mcp:export')
  await tick()
  assert.equal(calls.length, 1, 'сбор MAX идёт одним вызовом окна')
  assert.equal(calls[0].startsWith('window.__chatHubCollectMaxHistory('), true)
  const args = f.spawns[0].args
  const manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'))
  const maxChat = manifest.chats.find(item => item.pinId === 'pmax')
  assert.equal(maxChat.prefetched.status, 'ok', 'сбор через window даёт ok, а не MAX_COLLECT_FAILED')
  assert.equal(maxChat.prefetched.code, null)
  assert.deepEqual(maxChat.prefetched.messages.map(item => item.text), ['из окна ChatHub'])
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

test('mcpExport: SWITCH_TIMEOUT доносит expected/actual окна до prefetched-отчёта чата', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-max-switch-timeout')
  const pins = [
    { id: 'pmax', serviceId: 'max', url: MAX_URL, title: 'MAX чат', mcpProject: '14544' },
    { id: 'pmm', serviceId: 'mm', url: MM_URL, title: 'Общий канал', mcpProject: '14544' }
  ]
  const f = fixture(t, { config: exportConfig(exportDir, { pinned: pins }) })
  // Окно не смогло открыть нужный чат: в отчёте чата должна остаться пара
  // expected/actual, иначе живой SWITCH_TIMEOUT нечем разбирать.
  f.shellEvent.sender.executeJavaScript = async () => JSON.stringify({
    chats: [{
      pinId: 'pmax', status: 'error', code: 'SWITCH_TIMEOUT', coverage: 'window', messages: [],
      detail: { expected: 'MAX чат', actual: 'Другой чат' }
    }],
    restored: false
  })
  const pending = f.invoke('mcp:export')
  await tick()
  const args = f.spawns[0].args
  const manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'))
  const maxChat = manifest.chats.find(item => item.pinId === 'pmax')
  assert.equal(maxChat.prefetched.status, 'error')
  assert.equal(maxChat.prefetched.code, 'SWITCH_TIMEOUT')
  assert.deepEqual(maxChat.prefetched.detail, { expected: 'MAX чат', actual: 'Другой чат' })
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending
})

test('mcpExport: 40 одинаковых stderr-строк дают одно событие со счётчиком, строка ошибки видна', async t => {
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-stderr-repeat')) })
  const pending = f.invoke('mcp:export')
  const child = f.children[0]
  const diagnostic = '{"event":"connector_stderr","service":"mm","line":"диагностическое сообщение коннектора"}\n'
  const failure = '{"event":"connector_stderr","service":"mm","line":"Ошибка: ECONNRESET code=5"}\n'
  f.closeChild(child, JSON.stringify(report) + '\n', diagnostic.repeat(40) + failure)
  await pending
  const stderrEvents = f.progress.map(item => item.payload).filter(event => event.event === 'connector_stderr')
  assert.equal(stderrEvents.length, 2, 'серия одинаковых строк — одно событие, ошибка — отдельное')
  assert.equal(stderrEvents[0].repeat, 40, 'счётчик серии в событии')
  assert.equal(stderrEvents[0].line, 'диагностическое сообщение коннектора', 'текст серии сохранён')
  assert.match(stderrEvents[1].line, /ECONNRESET/, 'строка с текстом ошибки не схлопнута')
  const total = f.progress.filter(item => item.payload.event === 'connector_stderr').length
  assert.ok(total <= 21, 'журнал не забивается сорока одинаковыми строками: ' + total)
})

test('mcpExport: notes сборщика MAX едут в manifest полем maxNotes и доходят до отчёта', async t => {
  const exportDir = path.join(scratch, 'mcp-ipc-max-notes')
  const pins = [{ id: 'pmax', serviceId: 'max', url: MAX_URL, title: 'MAX чат', mcpProject: '14544' }]
  const f = fixture(t, { config: exportConfig(exportDir, { pinned: pins }) })
  const notes = [
    'MAX: сессия ок',
    'MAX: рабочий webview — pin, лента: 1',
    'MAX: собрано 30 сообщений, шагов 6, диапазон 2026-11-14—2026-11-18, покрытие: full',
    'MAX: лента top=0/sh=3000/ch=600 wraps=6 → top=540/wraps=6, шагов 6, собрано 30'
  ]
  f.shellEvent.sender.executeJavaScript = async () => JSON.stringify({
    chats: [{ pinId: 'pmax', status: 'ok', code: null, coverage: 'full', messages: [] }],
    restored: true,
    notes
  })
  const pending = f.invoke('mcp:export')
  await tick()
  const args = f.spawns[0].args
  const manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'))
  // Строки — отдельным полем manifest: в prefetched-чате их нет, дублей нет.
  assert.deepEqual(manifest.maxNotes, notes)
  const maxChat = manifest.chats.find(item => item.pinId === 'pmax')
  assert.equal('notes' in maxChat.prefetched, false, 'строки не дублируются в чате')
  f.closeChild(f.children[0], JSON.stringify({ ...report, notes }) + '\n')
  const result = await pending
  // Отчёт пришёл из vm-контекста: для strict deepEqual приводим к JSON.
  assert.deepEqual(plain(result.notes), notes, 'отчёт IPC несёт строки сборщика')
})

test('mcpExport: в maxNotes только непустые строки; без notes сборщика поля нет', async t => {
  const pins = [{ id: 'pmax', serviceId: 'max', url: MAX_URL, title: 'MAX чат', mcpProject: '14544' }]
  const f = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-max-notes-clean'), { pinned: pins }) })
  f.shellEvent.sender.executeJavaScript = async () => JSON.stringify({
    chats: [{ pinId: 'pmax', status: 'ok', code: null, coverage: 'window', messages: [] }],
    restored: true,
    notes: ['  MAX: сессия ок  ', 42, '', '   ', 'MAX: сессия ок']
  })
  const pending = f.invoke('mcp:export')
  await tick()
  const args = f.spawns[0].args
  const manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'))
  assert.deepEqual(manifest.maxNotes, ['MAX: сессия ок'], 'мусор и дубли отфильтрованы')
  f.closeChild(f.children[0], JSON.stringify(report) + '\n')
  await pending

  // Сборщик не прислал notes вовсе — поля нет, manifest остаётся прежним.
  const g = fixture(t, { config: exportConfig(path.join(scratch, 'mcp-ipc-max-notes-none'), { pinned: pins }) })
  g.shellEvent.sender.executeJavaScript = async () => JSON.stringify({
    chats: [{ pinId: 'pmax', status: 'ok', code: null, coverage: 'window', messages: [] }],
    restored: true
  })
  const second = g.invoke('mcp:export')
  await tick()
  const secondArgs = g.spawns[0].args
  const secondManifest = JSON.parse(fs.readFileSync(secondArgs[secondArgs.indexOf('--manifest') + 1], 'utf8'))
  assert.equal('maxNotes' in secondManifest, false, 'без notes поля нет')
  g.closeChild(g.children[0], JSON.stringify(report) + '\n')
  await second
})

/* ---------- «Избранное» → Markdown: локальный список, без чтения мессенджеров ---------- */

test('favorites:export пишет файл в mcpExportDir и возвращает count без диалога', async t => {
  const exportDir = fs.mkdtempSync(path.join(scratch, 'fav-export-dir-'))
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }))
  const f = fixture(t, { config: exportConfig(exportDir) })
  const result = await f.invoke('favorites:export')
  assert.equal(result.ok, true)
  assert.equal(result.count, 3)
  assert.match(path.basename(result.path), /^favorites_\d{8}\.md$/)
  assert.equal(path.dirname(path.resolve(result.path)), path.resolve(exportDir))
  const content = fs.readFileSync(result.path, 'utf8')
  assert.match(content, /^count: 3$/m)
  assert.match(content, /^exported_at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/m)
  assert.ok(content.includes('| № | Сервис | Название | URL | Комментарий | Проект | Закреплён |'))
  assert.ok(content.includes('| 1 | Mattermost | Общий канал |'))
  assert.equal(f.saveState.calls.length, 0, 'папка задана — диалог не открывается')
  assert.equal(f.spawns.length, 0, 'выгрузка избранного не запускает мост')
})

test('favorites:export без папки: отмена диалога даёт CANCELLED, выбранный путь получает файл', async t => {
  const f = fixture(t, { config: { services: [], pinned: basePinned } })
  const result = await f.invoke('favorites:export')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CANCELLED')
  assert.equal(f.saveState.calls.length, 1)
  const options = f.saveState.calls[0][f.saveState.calls[0].length - 1]
  assert.match(options.defaultPath, /^favorites_\d{8}\.md$/)

  const chosen = path.join(f.dir, 'favorites.md')
  f.saveState.result = { canceled: false, filePath: chosen }
  const written = await f.invoke('favorites:export')
  assert.equal(written.ok, true)
  assert.equal(written.count, 3)
  assert.equal(path.resolve(written.path), path.resolve(chosen))
  assert.match(fs.readFileSync(chosen, 'utf8'), /^count: 3$/m)
})

test('favorites:export в отсутствующий каталог возвращает EXPORT_DIR_MISSING', async t => {
  const missing = path.join(scratch, 'fav-export-missing-' + process.pid + '-' + Date.now())
  const f = fixture(t, { config: exportConfig(missing) })
  const result = await f.invoke('favorites:export')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXPORT_DIR_MISSING')
})

test('favorites:export отказывает чужому sender и ничего не пишет', async t => {
  const exportDir = fs.mkdtempSync(path.join(scratch, 'fav-export-foreign-'))
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }))
  const f = fixture(t, { config: exportConfig(exportDir) })
  const { error, value } = await f.callAs('favorites:export', f.foreignEvent)
  assert.ok(error)
  assert.match(String(error.message), /Unauthorized IPC sender/)
  assert.equal(value, undefined)
  assert.deepEqual(fs.readdirSync(exportDir), [])
})
