import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
// стаб child_process: mcp-экспорт в этих кейсах не запускается, но main.js
// требует модуль при загрузке — spawn не должен ничего порождать
const childProcessStub = {
  spawn: () => ({ stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {}, pid: 0, killed: false }),
  execFile: () => {}
}
const scratch = path.join(process.env.LOCALAPPDATA || path.dirname(root), 'hermes/cache/scratch')
fs.mkdirSync(scratch, { recursive: true })
function fixture(t, initial, backup, faults = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'config-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'config.json')
  if (initial !== undefined) fs.writeFileSync(target, initial)
  if (backup !== undefined) fs.writeFileSync(target + '.bak', backup)
  const handlers = new Map(), notices = [], ready = [], windows = [], timers = []
  class FakeWindow {
    static getAllWindows() { return windows }
    constructor() { this.events = {}; this.webContents = { setWindowOpenHandler() {} }; windows.push(this) }
    on(name, fn) { this.events[name] = fn }
    isMaximized() { return false }
    getBounds() { return { x: 1, y: 2, width: 1100, height: 900 } }
    loadFile() {}
    setBounds() {}
    setOverlayIcon() {}
  }
  const shellFrame = { url: pathToFileURL(path.join(root, 'index.html')).href }
  const shellSender = { getType: () => 'window', getURL: () => shellFrame.url, mainFrame: shellFrame }
  const electron = {
    app: { commandLine: { appendSwitch() {} }, getPath: () => dir, on() {}, requestSingleInstanceLock: () => true, setAppUserModelId() {}, whenReady: () => ({ then: fn => ready.push(fn) }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, nativeTheme: {},
    dialog: { showErrorBox: (...args) => notices.push(args) },
    BrowserWindow: FakeWindow,
    session: { fromPartition: () => ({ setProxy() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) }
  }
  const ctx = vm.createContext({ require: n => n === 'electron' ? electron : n === 'fs' ? new Proxy(fs, { get: (o, k) => faults[k] || o[k] }) : n === 'path' ? path : n === 'url' ? { pathToFileURL } : n === 'os' ? require('os') : n === 'crypto' ? require('crypto') : n === 'child_process' ? childProcessStub : n === './guest-notification-policy' ? require('../guest-notification-policy') : (() => { throw Error(n) })(), process: { env: {}, pid: process.pid, platform: process.platform }, console: { error: (...a) => notices.push(a), warn: (...a) => notices.push(a) }, __dirname: root, setTimeout: fn => timers.push(fn), clearTimeout() {} })
  vm.runInContext(source, ctx)
  return { target, dir, notices, faults, ctx, windows, timers, shellSender, shellFrame, get: () => handlers.get('config:get')({ sender: shellSender, senderFrame: shellFrame }), save: cfg => handlers.get('config:save')({ sender: shellSender, senderFrame: shellFrame }, cfg), invoke: (name, event, ...args) => handlers.get(name)(event, ...args) }
}
const good = JSON.stringify({ services: [], pinned: [], future: { nested: ['keep'] } })

test('mcpExportDir: пустая строка принимается и сохраняется', t => {
  const f = fixture(t, good)
  assert.equal(f.save({ ...f.get(), mcpExportDir: '' }), true)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).mcpExportDir, '')
  assert.equal(f.get().mcpExportDir, '')
})

test('mcpExportDir: путь C:/exports принимается и сохраняется', t => {
  const f = fixture(t, good)
  assert.equal(f.save({ ...f.get(), mcpExportDir: 'C:/exports' }), true)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).mcpExportDir, 'C:/exports')
  assert.equal(f.get().mcpExportDir, 'C:/exports')
})

for (const [label, bad] of [['42', 42], ['[]', []], ['{}', {}], ['null', null]]) {
  test('mcpExportDir: не-строка ' + label + ' отклоняется без изменения файла', t => {
    const f = fixture(t, good)
    assert.throws(() => f.save({ ...f.get(), mcpExportDir: bad }))
    assert.equal(fs.readFileSync(f.target, 'utf8'), good)
  })
}

test('mcpExportDir: строка из 501 символа отклоняется без изменения файла', t => {
  const f = fixture(t, good)
  assert.throws(() => f.save({ ...f.get(), mcpExportDir: 'x'.repeat(501) }))
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
})

test('mcpExportDir: управляющий символ \\u0000 отклоняется без изменения файла', t => {
  const f = fixture(t, good)
  assert.throws(() => f.save({ ...f.get(), mcpExportDir: 'C:/exports' + String.fromCharCode(0) + '/bad' }))
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
})

for (const valid of [1, 30]) {
  test('mcpExportDepthDays: граница ' + valid + ' принимается и сохраняется', t => {
    const f = fixture(t, good)
    assert.equal(f.save({ ...f.get(), mcpExportDepthDays: valid }), true)
    assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).mcpExportDepthDays, valid)
    assert.equal(f.get().mcpExportDepthDays, valid)
  })
}

for (const [label, bad] of [['0', 0], ['31', 31], ['1.5', 1.5], ["'7'", '7'], ['null', null], ['true', true]]) {
  test('mcpExportDepthDays: значение ' + label + ' отклоняется без изменения файла', t => {
    const f = fixture(t, good)
    assert.throws(() => f.save({ ...f.get(), mcpExportDepthDays: bad }))
    assert.equal(fs.readFileSync(f.target, 'utf8'), good)
  })
}

test('mcpExportDepthDays: отсутствие ключа даёт дефолт 7 после loadConfig', t => {
  const f = fixture(t, good)
  assert.equal(f.get().mcpExportDepthDays, 7)
})

test('mcpExportDir: отсутствие ключа даёт пустую строку после loadConfig', t => {
  const f = fixture(t, good)
  assert.equal(f.get().mcpExportDir, '')
})

for (const invalid of ['{secret-token', 'null', '[]', '{"services":{}}', '{"pinned":[null]}']) {
  test('invalid config stays byte-identical and blocks autosave: ' + invalid.slice(0, 12), t => {
    const f = fixture(t, invalid)
    assert.ok(Array.isArray(f.get().services))
    assert.throws(() => f.save({ ...f.get(), theme: 'light' }))
    assert.equal(fs.readFileSync(f.target, 'utf8'), invalid)
    assert.ok(f.notices.length)
    assert.ok(!JSON.stringify(f.notices).includes('secret-token'))
  })
}
test('valid backup is recovered without destroying malformed original or backup', t => {
  const f = fixture(t, '{broken', good)
  assert.equal(JSON.stringify(f.get().future), JSON.stringify({ nested: ['keep'] }))
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), good)
  const archives = fs.readdirSync(f.dir).filter(n => n.includes('.invalid-'))
  assert.equal(archives.length, 1)
  assert.equal(fs.readFileSync(path.join(f.dir, archives[0]), 'utf8'), '{broken')
  assert.equal(f.save({ ...f.get(), theme: 'light' }), true)
})

test('invalid IPC input cannot poison memory or disk', t => {
  const f = fixture(t, good)
  for (const bad of [null, [], { services: null }, { pinned: [null] }, { zoom: [] }, { windowState: { width: 'wide' } }]) {
    assert.throws(() => f.save(bad))
    assert.equal(fs.readFileSync(f.target, 'utf8'), good)
  }
})
test('favourite annotation is accepted only as a local string', t => {
  const initial = JSON.stringify({ services: [], pinned: [{ id: 'p', serviceId: 'mm', url: 'https://example.test/channel', annotation: 'Инженер' }] })
  const f = fixture(t, initial)
  assert.equal(f.get().pinned[0].annotation, 'Инженер')
  const invalid = structuredClone(f.get())
  invalid.pinned[0].annotation = { text: 'Инженер' }
  assert.throws(() => f.save(invalid))
  const overlong = structuredClone(f.get())
  overlong.pinned[0].annotation = 'x'.repeat(81)
  assert.throws(() => f.save(overlong))
  assert.equal(fs.readFileSync(f.target, 'utf8'), initial)
})

test('favourite mcpProject is an optional string preserved by save/get', t => {
  const initial = JSON.stringify({ services: [], pinned: [{ id: 'p', serviceId: 'mm', url: 'https://example.test/channel', mcpProject: 'НЭСК Портал-ЮГ' }] })
  const f = fixture(t, initial)
  assert.equal(f.get().pinned[0].mcpProject, 'НЭСК Портал-ЮГ')
  const next = structuredClone(f.get())
  next.pinned[0].mcpProject = 'ФМБА'
  assert.equal(f.save(next), true)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).pinned[0].mcpProject, 'ФМБА')
  assert.equal(f.get().pinned[0].mcpProject, 'ФМБА')
  // empty string is accepted at the config level; removing the key is renderer work
  const cleared = structuredClone(f.get())
  cleared.pinned[0].mcpProject = ''
  assert.equal(f.save(cleared), true)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).pinned[0].mcpProject, '')
})

test('mcpProject rejects non-strings and overlong values without touching the file', t => {
  const initial = JSON.stringify({ services: [], pinned: [{ id: 'p', serviceId: 'mm', url: 'https://example.test/channel', mcpProject: 'НЭСК' }] })
  const f = fixture(t, initial)
  for (const bad of [{ name: 'НЭСК' }, { nested: { id: 'p' } }, 42, 0, ['НЭСК'], true, 'x'.repeat(81)]) {
    const next = structuredClone(f.get())
    next.pinned[0].mcpProject = bad
    assert.throws(() => f.save(next), 'expected rejection for ' + JSON.stringify(bad))
    assert.equal(fs.readFileSync(f.target, 'utf8'), initial)
    assert.equal(f.get().pinned[0].mcpProject, 'НЭСК')
  }
  // the boundary value itself (80 chars) is valid
  const atLimit = structuredClone(f.get())
  atLimit.pinned[0].mcpProject = 'y'.repeat(80)
  assert.equal(f.save(atLimit), true)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).pinned[0].mcpProject, 'y'.repeat(80))
})

test('old config without mcpProject does not gain the key on load or save', t => {
  const initial = JSON.stringify({ services: [], pinned: [{ id: 'p', serviceId: 'mm', url: 'https://example.test/channel', title: 'Канал' }] })
  const f = fixture(t, initial)
  assert.ok(!('mcpProject' in f.get().pinned[0]))
  assert.equal(f.save({ ...f.get(), theme: 'light' }), true)
  const saved = JSON.parse(fs.readFileSync(f.target, 'utf8'))
  assert.ok(!('mcpProject' in saved.pinned[0]))
  assert.ok(!JSON.stringify(saved).includes('mcpProject'))
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), initial)
})

test('favourite titleCustom is an optional boolean preserved by save/get', t => {
  const initial = JSON.stringify({ services: [], pinned: [{ id: 'p', serviceId: 'ydx', url: 'https://telemost.yandex.ru/chats/x', title: 'Astra Linux', titleCustom: true }] })
  const f = fixture(t, initial)
  assert.equal(f.get().pinned[0].titleCustom, true)
  assert.equal(f.get().pinned[0].title, 'Astra Linux')
  const next = structuredClone(f.get())
  next.pinned[0].titleCustom = false
  assert.equal(f.save(next), true)
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).pinned[0].titleCustom, false)
  assert.equal(f.get().pinned[0].titleCustom, false)
  const back = structuredClone(f.get())
  back.pinned[0].title = 'Своё имя'
  back.pinned[0].titleCustom = true
  assert.equal(f.save(back), true)
  const saved = JSON.parse(fs.readFileSync(f.target, 'utf8')).pinned[0]
  assert.equal(saved.title, 'Своё имя')
  assert.equal(saved.titleCustom, true)
  assert.equal(f.get().pinned[0].titleCustom, true)
})

test('legacy null in optional pinned fields loads, normalizes away and never returns', t => {
  const initial = JSON.stringify({
    services: [],
    pinned: [{
      id: 'p',
      serviceId: 'ydx',
      url: 'https://telemost.yandex.ru/chats/x',
      title: 'Astra Linux',
      annotation: null,
      mcpProject: null,
      titleCustom: null
    }]
  })
  const f = fixture(t, initial)
  const optional = ['annotation', 'mcpProject', 'titleCustom']
  const loaded = f.get().pinned[0]
  assert.equal(loaded.title, 'Astra Linux', 'имя пина сохранено')
  for (const key of optional) assert.ok(!(key in loaded), key + ' удалён при загрузке, а не отвергнут')

  assert.equal(f.save(structuredClone(f.get())), true, 'save не падает и не пишет null обратно')
  const saved = JSON.parse(fs.readFileSync(f.target, 'utf8'))
  for (const key of optional) assert.ok(!(key in saved.pinned[0]), key + ' не вернулся в файл после save')
  assert.equal(JSON.stringify(saved.pinned[0]).includes('null'), false, 'в пине нет null-значений')
  for (const key of optional) assert.ok(!(key in f.get().pinned[0]), key + ' не вернулся в память после save')
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), initial, 'бэкап хранит точные предыдущие байты')
})

test('optional pinned fields still reject objects, numbers, arrays and overlong strings', t => {
  const initial = JSON.stringify({ services: [], pinned: [{ id: 'p', serviceId: 'ydx', url: 'https://telemost.yandex.ru/chats/x', title: 'Astra Linux' }] })
  const f = fixture(t, initial)
  const cases = [
    ['annotation', 'Строка', [{ text: 'x' }, 42, ['x'], true, 'x'.repeat(81)]],
    ['mcpProject', 'НЭСК', [{ name: 'НЭСК' }, 42, ['НЭСК'], true, 'x'.repeat(81)]],
    ['titleCustom', true, ['true', 1, 0, {}, []]]
  ]
  for (const [field, valid, bads] of cases) {
    const baseline = fs.readFileSync(f.target, 'utf8')
    for (const bad of bads) {
      const next = structuredClone(f.get())
      next.pinned[0][field] = bad
      assert.throws(() => f.save(next), 'expected rejection for ' + field + '=' + JSON.stringify(bad))
      assert.equal(fs.readFileSync(f.target, 'utf8'), baseline)
      assert.equal(f.get().pinned[0][field], undefined)
    }
    const ok = structuredClone(f.get())
    ok.pinned[0][field] = valid
    assert.equal(f.save(ok), true, 'валидное значение ' + field + ' принимается')
    assert.equal(f.get().pinned[0][field], valid)
  }
})

test('titleCustom rejects non-booleans without touching the file', t => {
  const initial = JSON.stringify({ services: [], pinned: [{ id: 'p', serviceId: 'ydx', url: 'https://telemost.yandex.ru/chats/x', title: 'Astra Linux', titleCustom: true }] })
  const f = fixture(t, initial)
  for (const bad of ['true', 'yes', 1, 0, '', {}, [], ['true']]) {
    const next = structuredClone(f.get())
    next.pinned[0].titleCustom = bad
    assert.throws(() => f.save(next), 'expected rejection for ' + JSON.stringify(bad))
    assert.equal(fs.readFileSync(f.target, 'utf8'), initial)
    assert.equal(f.get().pinned[0].titleCustom, true)
  }
})

test('old config without titleCustom does not gain the key on load or save', t => {
  const initial = JSON.stringify({ services: [], pinned: [{ id: 'p', serviceId: 'ydx', url: 'https://telemost.yandex.ru/chats/x', title: 'Astra Linux' }] })
  const f = fixture(t, initial)
  assert.ok(!('titleCustom' in f.get().pinned[0]))
  assert.equal(f.save({ ...f.get(), theme: 'light' }), true)
  const saved = JSON.parse(fs.readFileSync(f.target, 'utf8'))
  assert.ok(!('titleCustom' in saved.pinned[0]))
  assert.ok(!JSON.stringify(saved).includes('titleCustom'))
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), initial)
})

test('pinned: смена title без titleCustom не добавляет провенанс, пустая строка остаётся строкой', t => {
  // Пин из сборки, где titleCustom ещё не существовал: имя могло быть
  // переименовано авто-переименованием, но провенанс «имя задал человек» не
  // появляется — иначе следующая авто-правка перестала бы работать.
  const initial = JSON.stringify({ services: [], pinned: [{ id: 'p', serviceId: 'mm', url: 'https://example.test/channel', title: 'Общий канал' }] })
  const f = fixture(t, initial)
  assert.ok(!('titleCustom' in f.get().pinned[0]))

  const renamed = structuredClone(f.get())
  renamed.pinned[0].title = 'Проект 14544'
  assert.equal(f.save(renamed), true)
  const saved = JSON.parse(fs.readFileSync(f.target, 'utf8'))
  assert.equal(saved.pinned[0].title, 'Проект 14544')
  assert.ok(!('titleCustom' in saved.pinned[0]), 'titleCustom не должен появиться из-за смены имени')
  assert.equal(JSON.stringify(saved).includes('titleCustom'), false, 'ключа нет и в сыром JSON')
  assert.equal(f.get().pinned[0].title, 'Проект 14544', 'новое имя читается обратно')
  assert.ok(!('titleCustom' in f.get().pinned[0]))
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), initial, 'бэкап хранит исходные байты')

  // Пустая строка — валидное название (пользователь очистил поле), не null:
  // null в title превратил бы весь конфиг в повреждённый при следующей загрузке.
  const cleared = structuredClone(f.get())
  cleared.pinned[0].title = ''
  assert.equal(f.save(cleared), true)
  const clearedSaved = JSON.parse(fs.readFileSync(f.target, 'utf8')).pinned[0]
  assert.equal(clearedSaved.title, '')
  assert.equal('title' in clearedSaved, true, 'ключ title остаётся, а не исчезает')
  assert.notEqual(clearedSaved.title, null)
  assert.equal('titleCustom' in clearedSaved, false)
  assert.equal(f.get().pinned[0].title, '', 'пустая строка читается как пустая строка')
  assert.equal(f.get().pinned[0].title, '')
})

test('favourite row density settings accept only the documented values', t => {
  const initial = JSON.stringify({ services: [], pinned: [], favAvatarSize: 'medium', favPreviewVisible: false, favPreviewLines: 1, favCommentVisible: false, favCommentStyle: 'title', favCommentPlacement: 'inline' })
  const f = fixture(t, initial)
  assert.equal(f.get().favAvatarSize, 'medium')
  assert.equal(f.get().favPreviewVisible, false)
  assert.equal(f.get().favPreviewLines, 1)
  assert.equal(f.get().favCommentVisible, false)
  assert.equal(f.get().favCommentStyle, 'title')
  assert.equal(f.get().favCommentPlacement, 'inline')
  for (const patch of [
    { favAvatarSize: 'huge' },
    { favAvatarSize: 44 },
    { favPreviewVisible: 'false' },
    { favPreviewLines: 3 },
    { favPreviewLines: '1' },
    { favCommentVisible: 'false' },
    { favCommentStyle: 'loud' },
    { favCommentPlacement: 'center' }
  ]) {
    assert.throws(() => f.save({ ...f.get(), ...patch }))
  }
})

test('Telemost reconnect diagnostics retain only known state and scope', t => {
  const f = fixture(t, good)
  const event = { sender: f.shellSender, senderFrame: f.shellFrame }
  assert.equal(f.invoke('diagnostics:telemost-connection', event, { state: 'retry-visible', scope: 'pin' }), true)
  const log = fs.readFileSync(path.join(f.dir, 'telemost-connection.log'), 'utf8')
  assert.match(log, /retry-visible pin/)
  assert.equal(f.invoke('diagnostics:telemost-connection', event, { state: 'arbitrary-text', scope: 'https:\/\/private.example\/chat' }), false)
  assert.equal(fs.readFileSync(path.join(f.dir, 'telemost-connection.log'), 'utf8'), log)
})

test('IPC rejects a webview sender before reading or saving configuration', t => {
  const f = fixture(t, good)
  const guest = { sender: { getType: () => 'webview', getURL: () => 'https://example.test/' } }
  assert.throws(() => f.invoke('config:get', guest), /Unauthorized IPC sender/)
  assert.throws(() => f.invoke('config:save', guest, f.get()), /Unauthorized IPC sender/)
})
test('IPC rejects a non-main frame inside the shell WebContents', t => {
  const f = fixture(t, good)
  const childFrame = { url: f.shellFrame.url }
  const event = { sender: f.shellSender, senderFrame: childFrame }
  assert.throws(() => f.invoke('config:get', event), /Unauthorized IPC sender/)
  assert.throws(() => f.invoke('config:save', event, f.get()), /Unauthorized IPC sender/)
})

test('window autosave failure retains the previous in-memory window state', t => {
  const f = fixture(t, good)
  const before = JSON.stringify(f.get())
  vm.runInContext('createWindow()', f.ctx)
  f.faults.renameSync = () => { throw Error('private') }
  f.windows[0].events.resize()
  f.timers.pop()()
  assert.equal(JSON.stringify(f.get()), before)
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
  assert.ok(f.notices.length)
})

test('failed replacement retains committed bytes and in-memory state', t => {
  const f = fixture(t, good)
  const before = JSON.stringify(f.get())
  f.faults.renameSync = () => { throw new Error('secret-path EACCES') }
  assert.throws(() => f.save({ ...f.get(), theme: 'light' }))
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
  assert.equal(JSON.stringify(f.get()), before)
  assert.ok(f.notices.length)
  assert.ok(!JSON.stringify(f.notices).includes('secret-path'))
})

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  for (const phase of ['backup', 'primary']) {
    test(operation + ' failure during ' + phase + ' preserves committed data', t => {
      const f = fixture(t, good, good)
      const before = JSON.stringify(f.get())
      let count = 0
      f.faults[operation] = (...args) => {
        if (++count === (phase === 'backup' ? 1 : 2)) {
          if (operation === 'writeFileSync') fs.writeFileSync(args[0], '{partial')
          throw new Error('private contents')
        }
        return fs[operation](...args)
      }
      assert.throws(() => f.save({ ...f.get(), theme: 'light' }), /не записаны/)
      assert.equal(fs.readFileSync(f.target, 'utf8'), good)
      assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), good)
      assert.equal(JSON.stringify(f.get()), before)
      assert.deepEqual(fs.readdirSync(f.dir).sort(), ['config.json', 'config.json.bak'])
      assert.ok(!JSON.stringify(f.notices).includes('private contents'))
    })
  }
}
for (const operation of ['copyFileSync', 'renameSync', 'fsyncSync']) {
  test('recovery failure in ' + operation + ' never destroys either original', t => {
    const f = fixture(t, '{broken', good, { [operation]: () => { throw Error('private') } })
    assert.equal(JSON.stringify(f.get().future), '{"nested":["keep"]}')
    assert.throws(() => f.save(f.get()))
    assert.equal(fs.readFileSync(f.target, 'utf8'), '{broken')
    assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), good)
  })
}
test('invalid backup is not replaced by default-config autosave', t => {
  const f = fixture(t, 'null', '[]')
  assert.throws(() => f.save(f.get()))
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'null')
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), '[]')
})
test('missing primary recovers good backup; new profile can save', t => {
  const recovered = fixture(t, undefined, good)
  assert.equal(fs.readFileSync(recovered.target, 'utf8'), good)
  const fresh = fixture(t)
  assert.equal(fresh.save(fresh.get()), true)
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(fresh.target, 'utf8')).services))
})
test('unknown nested fields survive migration and save; backup holds exact previous bytes', t => {
  const initial = JSON.stringify({ services: [{ id: 'mm', url: 'https://example.test', custom: { a: 1 } }], pinned: [{ id: 'p1', serviceId: 'mm', url: 'https://example.test/chat', extra: [2] }], future: { nested: ['keep'] }, columnCss: { custom: 'body{}' }, windowState: { width: 1000, height: 800 } })
  const f = fixture(t, initial)
  assert.equal(f.save({ theme: 'light', windowState: null }), true)
  const saved = JSON.parse(fs.readFileSync(f.target, 'utf8'))
  assert.deepEqual(saved.future, { nested: ['keep'] })
  assert.deepEqual(saved.services[0].custom, { a: 1 })
  assert.deepEqual(saved.pinned[0].extra, [2])
  assert.equal(saved.columnCss.custom, 'body{}')
  assert.equal(saved.windowState.width, 1000)
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), initial)
})
test('interrupted-write leftovers are not promoted or deleted on load', t => {
  const f = fixture(t, good)
  const stale = f.target + '.tmp-crashed'
  fs.writeFileSync(stale, '{half')
  assert.equal(JSON.stringify(vm.runInContext('loadConfig()', f.ctx).future), '{"nested":["keep"]}')
  assert.equal(fs.readFileSync(stale, 'utf8'), '{half')
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
})
test('primary corrupted after startup cannot poison a known-good backup', t => {
  const f = fixture(t, good, good)
  fs.writeFileSync(f.target, '{external')
  assert.throws(() => f.save(f.get()))
  assert.equal(fs.readFileSync(f.target, 'utf8'), '{external')
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), good)
})
test('unreadable primary is not treated as a new profile', t => {
  const f = fixture(t, good, good, { readFileSync: (target, ...args) => {
    if (String(target).endsWith('config.json')) { const error = Error('private'); error.code = 'EACCES'; throw error }
    return fs.readFileSync(target, ...args)
  } })
  assert.throws(() => f.save(f.get()))
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
})

// --- M9-R2 D1: renameSync поверх файла, открытого другим процессом, даёт EPERM ---
test('rename EPERM: две неудачи и успех — сохранение проходит, .bak на месте, temp убран', t => {
  const f = fixture(t, good, good)
  let primaryRenames = 0
  f.faults.renameSync = (from, to) => {
    if (String(to).endsWith('config.json')) {
      primaryRenames += 1
      if (primaryRenames <= 2) {
        const error = new Error('EPERM: файл занят другим процессом')
        error.code = 'EPERM'
        throw error
      }
    }
    return fs.renameSync(from, to)
  }
  assert.equal(f.save({ ...f.get(), theme: 'light' }), true)
  assert.equal(primaryRenames, 3, 'нужны три попытки rename для config.json')
  assert.equal(JSON.parse(fs.readFileSync(f.target, 'utf8')).theme, 'light')
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), good)
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['config.json', 'config.json.bak'])
})

test('rename EPERM всегда: сохранение падает, файл байт-в-байт прежний, temp убран', t => {
  const f = fixture(t, good, good)
  let attempts = 0
  f.faults.renameSync = (from, to) => {
    if (String(to).endsWith('config.json')) {
      attempts += 1
      const error = new Error('EPERM: файл занят другим процессом')
      error.code = 'EPERM'
      throw error
    }
    return fs.renameSync(from, to)
  }
  assert.throws(() => f.save({ ...f.get(), theme: 'light' }), /не записаны/)
  assert.equal(attempts, 4, 'первая попытка и три повтора 25/75/150 мс')
  assert.equal(fs.readFileSync(f.target, 'utf8'), good)
  assert.equal(fs.readFileSync(f.target + '.bak', 'utf8'), good)
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['config.json', 'config.json.bak'])
})

test('rename EACCES/EBUSY повторяются, прочие ошибки — сразу', t => {
  for (const item of [
    { code: 'EACCES', attempts: 4, ok: false },
    { code: 'EBUSY', attempts: 4, ok: false },
    { code: 'ENOSPC', attempts: 1, ok: false }
  ]) {
    const f = fixture(t, good, good)
    let attempts = 0
    f.faults.renameSync = (from, to) => {
      if (String(to).endsWith('config.json')) {
        attempts += 1
        const error = new Error(item.code)
        error.code = item.code
        throw error
      }
      return fs.renameSync(from, to)
    }
    assert.throws(() => f.save({ ...f.get(), theme: 'light' }), /не записаны/, item.code)
    assert.equal(attempts, item.attempts, item.code)
    assert.equal(fs.readFileSync(f.target, 'utf8'), good)
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['config.json', 'config.json.bak'])
  }
})
