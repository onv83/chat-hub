'use strict'
// Контроли памяти сервисов в главном процессе: строгие булевы настройки
// serviceBackgroundThrottling / serviceIdleUnload / serviceMemoryGuard
// (+ legacy serviceMemorySaver) и санированный metrics-мост
// service-memory:metrics. Метрики Electron MemoryInfo выражены в KiB
// (privateBytes предпочтительнее workingSetSize, ноль валиден), а ассоциация
// guest↔сервис возникает только на did-attach-webview по точному совпадению
// guest.session === session.fromPartition(service.partition) — без очередей,
// таймаутов и порядка вложений. Харнесс повторяет tests/config-persistence.mjs:
// в vm исполняется НАСТОЯЩИЙ исходник main.js (не копия), а preload.js
// проверяется отдельным vm-харнессом с подменённым contextBridge/ipcRenderer.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
// стаб child_process: mcp-экспорт в этих кейсах не запускается, но main.js
// требует модуль при загрузке — spawn не должен ничего порождать
const childProcessStub = {
  spawn: () => ({ stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {}, pid: 0, killed: false }),
  execFile: () => {}
}
const scratch = path.join(process.env.LOCALAPPDATA || path.dirname(root), 'hermes/cache/scratch')
fs.mkdirSync(scratch, { recursive: true })
const KIB = 1024

function fixture(t, initial, backup, faults = {}, opts = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'sms-config-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'config.json')
  if (initial !== undefined) fs.writeFileSync(target, initial)
  if (backup !== undefined) fs.writeFileSync(target + '.bak', backup)
  const handlers = new Map(), notices = [], ready = [], windows = [], timers = []
  const appEvents = new Map()
  const contentsList = []
  const metricsState = { value: opts.metrics === undefined ? [] : opts.metrics, reads: 0 }
  const shellUrl = pathToFileURL(path.join(root, 'index.html')).href
  // сессии мемоизированы по partition: session.fromPartition должен возвращать
  // один и тот же объект для одной строки partition (как и настоящий Electron)
  const sessionsByPartition = new Map()
  const partitionSession = partition => {
    const key = String(partition)
    if (!sessionsByPartition.has(key)) {
      sessionsByPartition.set(key, { partition: key, setProxy() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} })
    }
    return sessionsByPartition.get(key)
  }
  function emitApp(name, ...args) { for (const fn of appEvents.get(name) || []) fn(...args) }
  class FakeContents {
    constructor(type, url = 'about:blank') {
      this.contentsType = type
      this.contentsUrl = url
      this.events = new Map()
      contentsList.push(this)
      emitApp('web-contents-created', {}, this)
    }
    getType() { return this.contentsType }
    getURL() { return this.contentsUrl }
    isDestroyed() { return false }
    on(name, fn) { this.events.set(name, [...(this.events.get(name) || []), fn]) }
    once(name, fn) { this.on(name, fn) }
    emit(name, ...args) { for (const fn of this.events.get(name) || []) fn(...args) }
    setWindowOpenHandler() {}
  }
  class FakeWindow {
    static getAllWindows() { return windows }
    constructor() {
      this.events = {}
      this.webContents = new FakeContents('window', shellUrl)
      windows.push(this)
    }
    on(name, fn) { this.events[name] = fn }
    isMaximized() { return false }
    getBounds() { return { x: 1, y: 2, width: 1100, height: 900 } }
    loadFile() {}
    setBounds() {}
    setOverlayIcon() {}
  }
  const shellFrame = { url: shellUrl }
  const shellSender = { getType: () => 'window', getURL: () => shellUrl, mainFrame: shellFrame }
  const electron = {
    app: {
      commandLine: { appendSwitch() {} }, getPath: () => dir,
      on: (name, fn) => appEvents.set(name, [...(appEvents.get(name) || []), fn]),
      requestSingleInstanceLock: () => true, setAppUserModelId() {},
      whenReady: () => ({ then: fn => ready.push(fn) }),
      getAppMetrics: () => { metricsState.reads++; return typeof metricsState.value === 'function' ? metricsState.value() : metricsState.value }
    },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    nativeTheme: {},
    dialog: { showErrorBox: (...args) => notices.push(args) },
    BrowserWindow: FakeWindow,
    session: { fromPartition: partitionSession },
    webContents: { getAllWebContents: () => contentsList.slice(), fromId: () => null }
  }
  const ctx = vm.createContext({
    require: n => n === 'electron' ? electron : n === 'fs' ? new Proxy(fs, { get: (o, k) => faults[k] || o[k] }) : n === 'path' ? path : n === 'url' ? { pathToFileURL } : n === 'os' ? require('os') : n === 'crypto' ? require('crypto') : n === 'child_process' ? childProcessStub : n === './guest-notification-policy' ? require('../guest-notification-policy') : (() => { throw Error(n) })(),
    process: { env: {}, pid: process.pid, platform: process.platform },
    console: { error: (...a) => notices.push(a), warn: (...a) => notices.push(a) },
    URL,
    __dirname: root,
    setTimeout: fn => timers.push(fn),
    clearTimeout() {}
  })
  vm.runInContext(source, ctx)
  const event = () => ({ sender: shellSender, senderFrame: shellFrame })
  return {
    target, dir, notices, faults, ctx, windows, timers, shellSender, shellFrame,
    Contents: FakeContents, contentsList, sessionOf: partitionSession,
    setMetrics: value => { metricsState.value = value; metricsState.reads = 0 },
    metricsReads: () => metricsState.reads,
    channels: () => [...handlers.keys()],
    get: () => handlers.get('config:get')(event()),
    save: cfg => handlers.get('config:save')(event(), cfg),
    reload: () => vm.runInContext('loadConfig()', ctx),
    invoke: (name, ev, ...args) => handlers.get(name)(ev, ...args),
    openShell: () => { vm.runInContext('createWindow()', ctx); return windows[windows.length - 1].webContents },
    metrics: () => handlers.get('service-memory:metrics')(event())
  }
}

function makeGuest(f, { pid = 0, url = 'about:blank', destroyed = false, throwPid = false, ses } = {}) {
  const guest = new f.Contents('webview', url)
  guest.id = 777001                          // webContents id — не должен попадать в ответ
  guest.title = 'SENTINEL-GUEST-TITLE'
  if (ses === null) { /* свойства session нет вовсе — guest без идентичности */}
  else guest.session = ses === undefined ? 'SENTINEL-GUEST-SESSION' : ses
  if (throwPid) guest.getOSProcessId = () => { throw new Error('SENTINEL-PID-THROW') }
  else guest.getOSProcessId = () => pid
  if (destroyed) guest.isDestroyed = () => true
  return guest
}

function attachWebview(f, host, params, guest) {
  const ev = { prevented: false, preventDefault() { this.prevented = true } }
  const prefs = {}
  host.emit('will-attach-webview', ev, prefs, params)
  if (!ev.prevented && guest !== undefined) host.emit('did-attach-webview', {}, guest)
  return { ev, prefs }
}

const good = JSON.stringify({ services: [], pinned: [], future: { nested: ['keep'] } })
const metricsServices = JSON.stringify({
  services: [
    { id: 'mm', name: 'SENTINEL-NAME-MM', url: 'https://mm.fixture.invalid/', partition: 'persist:mm' },
    { id: 'tg', name: 'SENTINEL-NAME-TG', url: 'https://tg.fixture.invalid/', partition: 'persist:tg' }
  ],
  pinned: []
})
// два настроенных сервиса на одном partition: точное совпадение сессии
// перестаёт быть единственным — привязка обязана не возникать
const duplicatePartitionServices = JSON.stringify({
  services: [
    { id: 'mm', name: 'SENTINEL-NAME-MM', url: 'https://mm.fixture.invalid/', partition: 'persist:mm' },
    { id: 'mm2', name: 'SENTINEL-NAME-MM2', url: 'https://mm2.fixture.invalid/', partition: 'persist:mm' }
  ],
  pinned: []
})
const MM = { src: 'https://mm.fixture.invalid/', partition: 'persist:mm' }
const TG = { src: 'https://tg.fixture.invalid/', partition: 'persist:tg' }
// Electron MemoryInfo в KiB: record(pid, mib) — процесс, занявший mib MiB
function record(pid, mib, extra = {}) {
  return { pid, type: 'SENTINEL-TYPE-' + pid, name: 'SENTINEL-PROC-' + pid, creationTime: 1, cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: mib * KIB }, ...extra }
}

test('serviceMemorySaver absent in an old config resolves to false', t => {
  const f = fixture(t, good)
  assert.equal(f.get().serviceMemorySaver, false)
})

test('literal true and false survive validation, save and reload', t => {
  const f = fixture(t, good)
  assert.equal(f.save({ ...f.get(), serviceMemorySaver: true }), true)
  assert.equal(f.get().serviceMemorySaver, true)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).serviceMemorySaver, true)
  assert.equal(f.reload().serviceMemorySaver, true)
  assert.equal(f.save({ ...f.get(), serviceMemorySaver: false }), true)
  assert.equal(f.get().serviceMemorySaver, false)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).serviceMemorySaver, false)
  assert.equal(f.reload().serviceMemorySaver, false)
})

test('non-boolean serviceMemorySaver values never enable the setting', t => {
  const f = fixture(t, good)
  for (const bad of ['true', 1, null, [], {}]) {
    assert.throws(() => f.save({ ...f.get(), serviceMemorySaver: bad }), /Некорректный формат настроек/)
    assert.equal(fs.readFileSync(f.target, 'utf8'), good)
    assert.equal(f.get().serviceMemorySaver, false)
  }
})

test('non-boolean serviceMemorySaver on disk follows the malformed-config fallback', t => {
  const broken = JSON.stringify({ services: [], pinned: [], serviceMemorySaver: 'true' })
  const f = fixture(t, broken)
  assert.equal(f.get().serviceMemorySaver, false)
  assert.throws(() => f.save({ ...f.get(), theme: 'light' }))
  assert.equal(fs.readFileSync(f.target, 'utf8'), broken)
  assert.ok(f.notices.length)
})

test('unrelated config fields keep their exact existing behavior', t => {
  const f = fixture(t, good)
  // объект из vm-контекста: сравнение через JSON, как в tests/config-persistence.mjs
  assert.equal(JSON.stringify(f.get().future), JSON.stringify({ nested: ['keep'] }))
  assert.throws(() => f.save({ ...f.get(), favPreviewVisible: 'false' }), /Некорректный формат настроек/)
  assert.equal(f.save({ ...f.get(), theme: 'light', serviceMemorySaver: true }), true)
  const saved = JSON.parse(fs.readFileSync(f.target, 'utf8'))
  assert.deepEqual(saved.future, { nested: ['keep'] })
  assert.equal(saved.theme, 'light')
  assert.equal(saved.serviceMemorySaver, true)
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), good)
})

test('unknown legacy tgBackgroundIndex config data survives load save and reload unchanged', t => {
  const legacy = JSON.stringify({ services: [], pinned: [], tgBackgroundIndex: true })
  const f = fixture(t, legacy)
  assert.equal(f.get().tgBackgroundIndex, true)
  assert.equal(f.save({ ...f.get(), theme: 'light' }), true)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).tgBackgroundIndex, true)
  assert.equal(f.reload().tgBackgroundIndex, true)
})

test('IPC sender checks stay in force for the new field', t => {
  const f = fixture(t, good)
  const guest = { sender: { getType: () => 'webview', getURL: () => 'https://example.test/' } }
  assert.throws(() => f.invoke('config:get', guest), /Unauthorized IPC sender/)
  assert.throws(() => f.invoke('config:save', guest, { ...f.get(), serviceMemorySaver: true }), /Unauthorized IPC sender/)
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
})

/* ---------- новые строгие булевы настройки жизненного цикла ---------- */

test('old configs missing the three new lifecycle keys resolve all of them to false', t => {
  const f = fixture(t, good)
  assert.equal(f.get().serviceBackgroundThrottling, false)
  assert.equal(f.get().serviceIdleUnload, false)
  assert.equal(f.get().serviceMemoryGuard, false)
})

test('literal booleans of the new keys survive validation, save and reload', t => {
  const f = fixture(t, good)
  assert.equal(f.save({ ...f.get(), serviceBackgroundThrottling: true, serviceIdleUnload: true, serviceMemoryGuard: true }), true)
  const cfg = f.get()
  assert.equal(cfg.serviceBackgroundThrottling, true)
  assert.equal(cfg.serviceIdleUnload, true)
  assert.equal(cfg.serviceMemoryGuard, true)
  const onDisk = JSON.parse(fs.readFileSync(f.target, 'utf8'))
  assert.equal(onDisk.serviceBackgroundThrottling, true)
  assert.equal(onDisk.serviceIdleUnload, true)
  assert.equal(onDisk.serviceMemoryGuard, true)
  const reloaded = f.reload()
  assert.equal(reloaded.serviceBackgroundThrottling, true)
  assert.equal(reloaded.serviceIdleUnload, true)
  assert.equal(reloaded.serviceMemoryGuard, true)
  assert.equal(f.save({ ...f.get(), serviceIdleUnload: false }), true)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).serviceIdleUnload, false)
  assert.equal(f.reload().serviceIdleUnload, false)
})

test('non-boolean values of the new keys never reach disk', t => {
  const f = fixture(t, good)
  for (const key of ['serviceBackgroundThrottling', 'serviceIdleUnload', 'serviceMemoryGuard']) {
    for (const bad of ['true', 'off', 1, 0, null, [], {}, [false], { enabled: true }]) {
      assert.throws(() => f.save({ ...f.get(), [key]: bad }), /Некорректный формат настроек/)
    }
  }
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
  const cfg = f.get()
  assert.equal(cfg.serviceBackgroundThrottling, false)
  assert.equal(cfg.serviceIdleUnload, false)
  assert.equal(cfg.serviceMemoryGuard, false)
})

test('non-boolean new key on disk follows the malformed-config fallback', t => {
  const broken = JSON.stringify({ services: [], pinned: [], serviceMemoryGuard: 'off' })
  const f = fixture(t, broken)
  assert.equal(f.get().serviceBackgroundThrottling, false)
  assert.equal(f.get().serviceIdleUnload, false)
  assert.equal(f.get().serviceMemoryGuard, false)
  assert.throws(() => f.save({ ...f.get(), theme: 'light' }))
  assert.equal(fs.readFileSync(f.target, 'utf8'), broken)
  assert.ok(f.notices.length)
})

test('legacy serviceMemorySaver true stays valid, persisted and unlinked from the new controls', t => {
  const legacy = JSON.stringify({ services: [], pinned: [], serviceMemorySaver: true })
  const f = fixture(t, legacy)
  const cfg = f.get()
  assert.equal(cfg.serviceMemorySaver, true)
  assert.equal(cfg.serviceBackgroundThrottling, false)
  assert.equal(cfg.serviceIdleUnload, false)
  assert.equal(cfg.serviceMemoryGuard, false)
  // включение новой настройки не удаляет, не мигрирует и не «переносит» legacy-флаг
  assert.equal(f.save({ ...cfg, serviceMemoryGuard: true }), true)
  const saved = JSON.parse(fs.readFileSync(f.target, 'utf8'))
  assert.equal(saved.serviceMemorySaver, true)
  assert.equal(saved.serviceMemoryGuard, true)
  const reloaded = f.reload()
  assert.equal(reloaded.serviceMemorySaver, true)
  assert.equal(reloaded.serviceMemoryGuard, true)
  // и legacy-флаг сам по себе не включает новые политики
  assert.equal(reloaded.serviceBackgroundThrottling, false)
  assert.equal(reloaded.serviceIdleUnload, false)
})

/* ---------- поверхность IPC главного процесса ---------- */

test('main removes trusted-input IPC and keeps config theme focus diagnostics and memory metrics', t => {
  const f = fixture(t, good)
  assert.deepEqual(f.channels().sort(), [
    'app:version', 'config:get', 'config:path', 'config:save',
    'diagnostics:telemost-connection', 'favorites:export', 'mcp:cancel', 'mcp:choose-dir',
    'mcp:connector-connect', 'mcp:connector-install', 'mcp:connector-status',
    'mcp:export', 'mcp:probe', 'service-memory:metrics',
    'theme:set-source', 'win:focused'
  ])
})

test('removed input IPC channels reject shell and guest renderer attempts', async t => {
  const f = fixture(t, good)
  const shellEvent = { sender: f.shellSender, senderFrame: f.shellFrame }
  const guestEvent = { sender: { getType: () => 'webview', getURL: () => 'https://mm.fixture.invalid/' } }
  for (const channel of ['input:click', 'input:text', 'input:key', 'input:wheel']) {
    await assert.rejects(async () => f.invoke(channel, shellEvent, { wcId: 1 }), undefined, channel + ' shell')
    await assert.rejects(async () => f.invoke(channel, guestEvent, { wcId: 1 }), undefined, channel + ' guest')
  }
})

/* ---------- metrics IPC: только главный фрейм оболочки ---------- */

test('service-memory:metrics rejects guest, shell subframe and foreign window senders', t => {
  const f = fixture(t, good)
  const guestEvent = { sender: { getType: () => 'webview', getURL: () => 'https://mm.fixture.invalid/' } }
  const subframeEvent = { sender: f.shellSender, senderFrame: { url: f.shellFrame.url } }
  const foreignFrame = { url: 'https://evil.example/' }
  const foreignEvent = { sender: { getType: () => 'window', getURL: () => 'https://evil.example/', mainFrame: foreignFrame }, senderFrame: foreignFrame }
  assert.throws(() => f.invoke('service-memory:metrics', guestEvent), /Unauthorized IPC sender/)
  assert.throws(() => f.invoke('service-memory:metrics', subframeEvent), /Unauthorized IPC sender/)
  assert.throws(() => f.invoke('service-memory:metrics', foreignEvent), /Unauthorized IPC sender/)
  // отказ происходит до чтения метрик
  assert.equal(f.metricsReads(), 0)
})

/* ---------- политика will-attach-webview ---------- */

test('a validated attach keeps the shell-host policy and its security hardening', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  const { ev, prefs } = attachWebview(f, host, MM, makeGuest(f, { pid: 4242, ses: f.sessionOf('persist:mm') }))
  assert.equal(ev.prevented, false)
  // политика will-attach-webview не ослаблена
  assert.equal(prefs.preload, undefined)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.partition, 'persist:mm')
  // чужой partition — will-attach отклонён, guest не существует
  const denied = attachWebview(f, host, { src: 'https://mm.fixture.invalid/', partition: 'persist:unknown' })
  assert.equal(denied.ev.prevented, true)
  // чужой хост (не оболочка) — will-attach отклонён
  const foreignHost = new f.Contents('window', 'https://evil.example/')
  const deniedHost = attachWebview(f, foreignHost, MM, makeGuest(f, { pid: 103 }))
  assert.equal(deniedHost.ev.prevented, true)
})

/* ---------- жизненный цикл привязки guest↔сервис ---------- */

test('a guest is attributed only through exact main-owned session identity, never the declared partition', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  f.setMetrics([record(100, 300), record(101, 700)])
  // will-attach провалидирован для TG, но реальная сессия guest — MM:
  // ассоциация определяется только совпадением guest.session, а не params
  attachWebview(f, host, TG, makeGuest(f, { pid: 100, ses: f.sessionOf('persist:mm') }))
  const res = f.metrics()
  assert.deepEqual(JSON.parse(JSON.stringify(res.services)), [{ id: 'mm', memoryMiB: 300 }])
  assert.equal(res.totalMiB, 1000)
})

test('an abandoned validated attach never poisons the next real guest', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  f.setMetrics([record(100, 300), record(101, 700)])
  // валидированный will-attach для MM, за которым did-attach так и не пришёл
  const abandoned = attachWebview(f, host, MM)
  assert.equal(abandoned.ev.prevented, false)
  // следующий реальный guest — TG: брошенное вложение MM не должно связывать его с MM
  attachWebview(f, host, TG, makeGuest(f, { pid: 101, ses: f.sessionOf('persist:tg') }))
  let res = f.metrics()
  assert.deepEqual(JSON.parse(JSON.stringify(res.services)), [{ id: 'tg', memoryMiB: 700 }])
  // и реальный guest MM после этого всё равно корректен
  attachWebview(f, host, MM, makeGuest(f, { pid: 100, ses: f.sessionOf('persist:mm') }))
  res = f.metrics()
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 300)
  assert.equal(res.services.find(s => s.id === 'tg').memoryMiB, 700)
  assert.equal(res.totalMiB, 1000)
})

test('repeated abandoned attachments do not shift later associations', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  f.setMetrics([record(100, 300), record(101, 700)])
  attachWebview(f, host, MM) // брошенные вложения
  attachWebview(f, host, MM)
  attachWebview(f, host, MM)
  attachWebview(f, host, TG)
  // очередь из брошенных вложений не отравляет реального guest TG
  attachWebview(f, host, TG, makeGuest(f, { pid: 101, ses: f.sessionOf('persist:tg') }))
  const res = f.metrics()
  assert.deepEqual(JSON.parse(JSON.stringify(res.services)), [{ id: 'tg', memoryMiB: 700 }])
  assert.equal(res.totalMiB, 1000)
})

test('a guest without a session identity is safely omitted and never restarts metric collection', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  f.setMetrics([record(100, 300), record(101, 50)])
  // свойства session нет вовсе
  attachWebview(f, host, MM, makeGuest(f, { pid: 100, ses: null }))
  // сессия-объект, не совпадающая ни с одним настроенным сервисом
  attachWebview(f, host, TG, makeGuest(f, { pid: 101, ses: { alien: 'SENTINEL-ALIEN-SESSION' } }))
  const res = f.metrics()
  assert.equal(JSON.stringify(res.services), '[]')
  // totalMiB агрегирует всё дерево метрик независимо от привязки
  assert.equal(res.totalMiB, 350)
  // одно чтение getAppMetrics на снимок: никакого «перезапуска» сборщика по догадке
  assert.equal(f.metricsReads(), 1)
})

test('an ambiguous session shared by two configured services leaves the guest unattributed', t => {
  const f = fixture(t, duplicatePartitionServices)
  const host = f.openShell()
  f.setMetrics([record(100, 300)])
  // два настроенных сервиса делят один partition — совпадение не единственно
  attachWebview(f, host, { src: 'https://mm.fixture.invalid/', partition: 'persist:mm' }, makeGuest(f, { pid: 100, ses: f.sessionOf('persist:mm') }))
  const res = f.metrics()
  assert.equal(JSON.stringify(res.services), '[]')
  assert.equal(res.totalMiB, 300)
})

test('guest URLs titles and renderer-supplied claims never influence the association', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  f.setMetrics([record(100, 300), record(101, 700)])
  // URL гостя указывает на MM, реальная сессия — TG: побеждает сессия, не URL
  attachWebview(f, host, MM, makeGuest(f, { pid: 101, url: 'https://mm.fixture.invalid/chat/mm', ses: f.sessionOf('persist:tg') }))
  let res = f.metrics()
  assert.deepEqual(JSON.parse(JSON.stringify(res.services)), [{ id: 'tg', memoryMiB: 700 }])
  // рендерер не может протолкнуть свою ассоциацию аргументами канала
  const shellEvent = { sender: f.shellSender, senderFrame: f.shellFrame }
  res = f.invoke('service-memory:metrics', shellEvent, { serviceId: 'mm', pid: 100, partition: 'persist:mm' })
  assert.deepEqual(JSON.parse(JSON.stringify(res.services)), [{ id: 'tg', memoryMiB: 700 }])
  assert.equal(res.totalMiB, 1000)
})

test('denied unattached unknown or broken guests never appear in the snapshot', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  f.setMetrics([record(100, 300), record(101, 700), record(102, 900), record(103, 950), record(104, 800)])
  // неизвестный guest: сессия не совпадает ни с одним настроенным сервисом
  host.emit('did-attach-webview', {}, makeGuest(f, { pid: 101 }))
  // чужой partition — will-attach отклонён, guest не существует
  const denied = attachWebview(f, host, { src: 'https://mm.fixture.invalid/', partition: 'persist:unknown' })
  assert.equal(denied.ev.prevented, true)
  // чужой хост (не оболочка) — will-attach отклонён
  const foreignHost = new f.Contents('window', 'https://evil.example/')
  const deniedHost = attachWebview(f, foreignHost, MM, makeGuest(f, { pid: 103 }))
  assert.equal(deniedHost.ev.prevented, true)
  // привязанные, но бесполезные guests: pid сломан / отсутствует в метриках / уничтожен
  attachWebview(f, host, MM, makeGuest(f, { pid: -1, ses: f.sessionOf('persist:mm') }))
  attachWebview(f, host, MM, makeGuest(f, { throwPid: true, ses: f.sessionOf('persist:mm') }))
  attachWebview(f, host, MM, makeGuest(f, { pid: 102, destroyed: true, ses: f.sessionOf('persist:mm') }))
  attachWebview(f, host, MM, makeGuest(f, { pid: 404, ses: f.sessionOf('persist:mm') }))
  // валидированный will-attach, после которого did-attach так и не пришёл:
  // неприкреплённое вложение не порождает привязки (did-attach за ним не следует)
  const pending = attachWebview(f, host, MM)
  assert.equal(pending.ev.prevented, false)
  const res = f.metrics()
  assert.equal(JSON.stringify(res.services), '[]')
  // totalMiB агрегирует всё дерево метрик независимо от привязки
  assert.equal(res.totalMiB, 3650)
})

test('a service reports the largest of its mapped guests exactly once', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  f.setMetrics([record(100, 300), record(101, 700), record(102, 50), record(7, 32)])
  attachWebview(f, host, MM, makeGuest(f, { pid: 100, ses: f.sessionOf('persist:mm') }))
  attachWebview(f, host, MM, makeGuest(f, { pid: 101, ses: f.sessionOf('persist:mm') }))
  attachWebview(f, host, TG, makeGuest(f, { pid: 102, ses: f.sessionOf('persist:tg') }))
  const res = f.metrics()
  assert.equal(res.services.length, 2)
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 700)
  assert.equal(res.services.find(s => s.id === 'tg').memoryMiB, 50)
  assert.equal(res.totalMiB, 1082)
})

test('a mapped guest disappears once its service leaves the config', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  attachWebview(f, host, MM, makeGuest(f, { pid: 100, ses: f.sessionOf('persist:mm') }))
  f.setMetrics([record(100, 64), record(2, 32)])
  assert.equal(f.metrics().services.length, 1)
  const cfg = JSON.parse(JSON.stringify(f.get()))
  cfg.services = cfg.services.filter(s => s.id !== 'mm')
  assert.equal(f.save(cfg), true)
  const res = f.metrics()
  assert.equal(JSON.stringify(res.services), '[]')
  assert.equal(res.totalMiB, 96)
})

/* ---------- форма ответа и санитизация ---------- */

test('metrics response carries exactly the sanitized shape and no identity', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  f.setMetrics([record(4242, 512), record(7, 50)])
  attachWebview(f, host, MM, makeGuest(f, { pid: 4242, url: 'https://sentinel-url.example/private?token=1', ses: f.sessionOf('persist:mm') }))
  const res = f.metrics()
  assert.deepEqual(Object.keys(res).sort(), ['services', 'totalMiB'])
  for (const entry of res.services) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'memoryMiB'])
    assert.equal(Number.isInteger(entry.memoryMiB), true)
  }
  assert.equal(Number.isInteger(res.totalMiB), true)
  const json = JSON.stringify(res)
  assert.equal(json.includes('SENTINEL'), false, 'никаких сенсорных строк фикстуры')
  assert.equal(json.includes('4242'), false, 'PID не попадает в ответ')
  assert.equal(json.toLowerCase().includes('pid'), false, 'поля pid быть не может')
  assert.equal(json.includes('sentinel-url.example'), false, 'URL гостя не попадает в ответ')
})

/* ---------- единицы KiB, выбор метрики, пороги и дубликаты ---------- */

test('KiB metric values report exact MiB with no factor-1024 underreporting', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  attachWebview(f, host, MM, makeGuest(f, { pid: 4242, ses: f.sessionOf('persist:mm') }))
  // Electron MemoryInfo сообщает KiB: 262144 KiB — это 256 MiB, а не 0
  f.setMetrics([{ pid: 4242, type: 'Tab', memory: { workingSetSize: 256 * KIB } }, record(7, 1)])
  const res = f.metrics()
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 256)
  assert.equal(res.totalMiB, 257)
  // 1023 KiB — меньше одного MiB
  f.setMetrics([{ pid: 4242, type: 'Tab', memory: { workingSetSize: 1023 } }])
  assert.equal(f.metrics().services.find(s => s.id === 'mm').memoryMiB, 0)
  assert.equal(f.metrics().totalMiB, 0)
})

test('privateBytes is preferred over workingSetSize and an exact zero is valid', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  attachWebview(f, host, MM, makeGuest(f, { pid: 100, ses: f.sessionOf('persist:mm') }))
  attachWebview(f, host, TG, makeGuest(f, { pid: 101, ses: f.sessionOf('persist:tg') }))
  f.setMetrics([
    record(100, 500, { memory: { privateBytes: 200 * KIB, workingSetSize: 500 * KIB } }),
    record(101, 500, { memory: { privateBytes: 0, workingSetSize: 500 * KIB } })
  ])
  const res = f.metrics()
  // privateBytes предпочтительнее workingSetSize
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 200)
  // ноль в privateBytes валиден: fallback на workingSetSize не выполняется
  assert.equal(res.services.find(s => s.id === 'tg').memoryMiB, 0)
  // total суммирует те же выбранные значения, без второго выбора метрики
  assert.equal(res.totalMiB, 200)
})

test('missing invalid or negative privateBytes falls back to workingSetSize and fabricates nothing', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  attachWebview(f, host, MM, makeGuest(f, { pid: 100, ses: f.sessionOf('persist:mm') }))
  f.setMetrics([
    record(100, 500, { memory: { privateBytes: -12 * KIB, workingSetSize: 100 * KIB } }),
    record(101, 500, { memory: { privateBytes: Number.NaN, workingSetSize: 200 * KIB } }),
    record(102, 500, { memory: { privateBytes: 'SENTINEL-PRIVATE', workingSetSize: 300 * KIB } }),
    record(103, 500, { memory: { privateBytes: Number.POSITIVE_INFINITY, workingSetSize: 400 * KIB } }),
    record(104, 500, { memory: { privateBytes: 50 * KIB, workingSetSize: -1 } }),
    record(105, 500, { memory: { privateBytes: -1, workingSetSize: -1 } }),
    record(106, 500, { memory: { privateBytes: Number.NaN, workingSetSize: Number.NaN } })
  ])
  const res = f.metrics()
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 100)
  // total суммирует те же выбранные per-process KiB: 100+200+300+400+50;
  // записи без единой валидной метрики (105, 106) ничего не изобретают
  assert.equal(res.totalMiB, 1050)
})

test('KiB amounts floor to integer MiB and prove the 1536/3072 thresholds exactly', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  attachWebview(f, host, MM, makeGuest(f, { pid: 4242, ses: f.sessionOf('persist:mm') }))
  // на 1 KiB ниже порога рендерера 1536 MiB
  f.setMetrics([{ pid: 4242, type: 'Tab', memory: { workingSetSize: 1536 * KIB - 1 } }])
  let res = f.metrics()
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 1535)
  assert.equal(res.totalMiB, 1535)
  // ровно порог рендерера 1536 MiB; второй процесс на 1536 MiB даёт ровно 3072 MiB
  f.setMetrics([
    { pid: 4242, type: 'Tab', memory: { workingSetSize: 1536 * KIB } },
    { pid: 8, type: 'GPU', memory: { workingSetSize: 1536 * KIB } }
  ])
  res = f.metrics()
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 1536)
  assert.equal(res.totalMiB, 3072)
  // на 1 KiB ниже общего порога 3072 MiB
  f.setMetrics([{ pid: 9, type: 'Browser', memory: { workingSetSize: 3072 * KIB - 1 } }])
  res = f.metrics()
  assert.equal(res.totalMiB, 3071)
  assert.equal(JSON.stringify(res.services), '[]')
  // два процесса по 1536 MiB без 1 KiB остаются ниже 3072 MiB
  f.setMetrics([
    { pid: 4242, type: 'Tab', memory: { workingSetSize: 1536 * KIB - 1 } },
    { pid: 10, type: 'Utility', memory: { workingSetSize: 1536 * KIB - 1 } }
  ])
  res = f.metrics()
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 1535)
  assert.equal(res.totalMiB, 3071)
})

test('duplicate PID records are counted once and never double the total', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  attachWebview(f, host, MM, makeGuest(f, { pid: 500, ses: f.sessionOf('persist:mm') }))
  f.setMetrics([record(500, 100), record(500, 900), record(600, 50)])
  let res = f.metrics()
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 100)
  assert.equal(res.totalMiB, 150)
  // первая выбранная запись закрепляет PID: privateBytes дубля не переигрывает выбор
  f.setMetrics([
    record(500, 100),
    record(500, 900, { memory: { privateBytes: 900 * KIB, workingSetSize: 950 * KIB } }),
    record(600, 50)
  ])
  res = f.metrics()
  assert.equal(res.services.find(s => s.id === 'mm').memoryMiB, 100)
  assert.equal(res.totalMiB, 150)
})

test('invalid negative or missing PID and memory records fabricate nothing', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  attachWebview(f, host, MM, makeGuest(f, { pid: 700, ses: f.sessionOf('persist:mm') }))
  f.setMetrics([
    null, 'SENTINEL-RECORD', 42, {},
    { pid: -1, memory: { workingSetSize: 10 * KIB } },
    { pid: 0, memory: { workingSetSize: 10 * KIB } },
    { pid: 700.5, memory: { workingSetSize: 10 * KIB } },
    { memory: { workingSetSize: 10 * KIB } },
    { pid: 701 },
    { pid: 702, memory: { workingSetSize: -10 * KIB } },
    { pid: 703, memory: { workingSetSize: Number.NaN } },
    { pid: 704, memory: { workingSetSize: 'SENTINEL-BYTES' } },
    { pid: 705, memory: null },
    { pid: 706, memory: 'SENTINEL-MEM' },
    { pid: 707, memory: { privateBytes: 'SENTINEL-PRIVATE', workingSetSize: 'SENTINEL-WSS' } },
    { pid: 700, memory: null },
    { pid: 700, type: 'Tab', memory: { workingSetSize: 64 * KIB } }
  ])
  const res = f.metrics()
  assert.deepEqual(JSON.parse(JSON.stringify(res)), { services: [{ id: 'mm', memoryMiB: 64 }], totalMiB: 64 })
})

test('metrics stays a safe empty snapshot when getAppMetrics fails or returns junk', t => {
  const f = fixture(t, metricsServices)
  const host = f.openShell()
  attachWebview(f, host, MM, makeGuest(f, { pid: 100, ses: f.sessionOf('persist:mm') }))
  for (const junk of [() => { throw new Error('SENTINEL-METRICS-FAIL') }, undefined, 'SENTINEL-NOT-ARRAY', {}]) {
    f.setMetrics(junk)
    const res = f.metrics()
    assert.deepEqual(JSON.parse(JSON.stringify(res)), { services: [], totalMiB: 0 })
  }
})

/* ---------- preload-мост ---------- */

test('preload removes trusted input and retains every non-input method including service memory metrics', async () => {
  const calls = []
  let exposedName = null, exposedApi = null
  const ctx = vm.createContext({
    require: n => n === 'electron' ? {
      contextBridge: { exposeInMainWorld: (name, api) => { exposedName = name; exposedApi = api } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return 'SENTINEL-REPLY' } }
    } : (() => { throw Error(n) })(),
    console: { error() {} }
  })
  vm.runInContext(preloadSource, ctx)
  assert.equal(exposedName, 'hub')
  assert.deepEqual(Object.keys(exposedApi).sort(), [
    'configPath', 'favoritesExport', 'getConfig', 'getServiceMemoryMetrics', 'getVersion', 'isWinFocused',
    'mcpCancel', 'mcpChooseDir', 'mcpConnectorConnect', 'mcpConnectorInstall',
    'mcpConnectorStatus', 'mcpExport', 'mcpProbe', 'onMcpProgress',
    'reportTelemostConnection', 'saveConfig', 'setThemeSource'
  ])
  assert.equal(typeof exposedApi.getServiceMemoryMetrics, 'function')
  assert.equal(exposedApi.getServiceMemoryMetrics.length, 0)
  // лишние аргументы рендерера не доходят до канала
  assert.equal(await exposedApi.getServiceMemoryMetrics('sentinel-arg', 42), 'SENTINEL-REPLY')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['service-memory:metrics'])
  for (const method of ['trustedClick', 'trustedText', 'trustedKey', 'trustedWheel']) {
    assert.equal(Object.prototype.hasOwnProperty.call(exposedApi, method), false, method)
  }
})
