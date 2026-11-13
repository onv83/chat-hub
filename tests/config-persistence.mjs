import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
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
  }
  const electron = {
    app: { commandLine: { appendSwitch() {} }, getPath: () => dir, on() {}, requestSingleInstanceLock: () => true, setAppUserModelId() {}, whenReady: () => ({ then: fn => ready.push(fn) }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, nativeTheme: {},
    dialog: { showErrorBox: (...args) => notices.push(args) },
    BrowserWindow: FakeWindow,
    session: { fromPartition: () => ({ setProxy() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) }
  }
  const ctx = vm.createContext({ require: n => n === 'electron' ? electron : n === 'fs' ? new Proxy(fs, { get: (o, k) => faults[k] || o[k] }) : n === 'path' ? path : n === './guest-notification-policy' ? require('../guest-notification-policy') : (() => { throw Error(n) })(), process: { env: {}, pid: process.pid, platform: process.platform }, console: { error: (...a) => notices.push(a), warn: (...a) => notices.push(a) }, __dirname: root, setTimeout: fn => timers.push(fn), clearTimeout() {} })
  vm.runInContext(source, ctx)
  return { target, dir, notices, faults, ctx, windows, timers, get: () => handlers.get('config:get')(), save: cfg => handlers.get('config:save')(null, cfg) }
}
const good = JSON.stringify({ services: [], pinned: [], future: { nested: ['keep'] } })

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
