import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'main.js'))
function fixture(t, initial) {
  const scratch = path.join(process.env.LOCALAPPDATA || path.dirname(root), 'hermes/cache/scratch')
  fs.mkdirSync(scratch, { recursive: true })
  const dir = fs.mkdtempSync(path.join(scratch, 'notification-policy-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  if (initial) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(initial))
  const sessions = new Map(), handlers = new Map(), events = new Map(), steps = []
  function fromPartition(id = '') {
    if (!sessions.has(id)) {
      const ses = {
        setPermissionRequestHandler(h) { this.request = h; steps.push(['request', id]) },
        setPermissionCheckHandler(h) { this.check = h; steps.push(['check', id]) },
        setProxy() { steps.push(['proxy', id]) }
      }
      sessions.set(id, ses)
      for (const fn of events.get('session-created') || []) fn(ses)
    }
    return sessions.get(id)
  }
  const defaultSession = fromPartition(''), unrelated = fromPartition('persist:unrelated')
  let ready
  class FakeWindow {
    static getAllWindows() { return [] }
    constructor() { steps.push(['window']); this.webContents = { setWindowOpenHandler() {} } }
    on() {} loadFile() {} setBounds() {} maximize() {}
  }
  const electron = {
    app: { commandLine: { appendSwitch() {} }, getPath: () => dir,
      on(n, fn) { events.set(n, [...(events.get(n) || []), fn]) },
      requestSingleInstanceLock: () => true, whenReady: () => ({ then(fn) { ready = fn } }) },
    ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, nativeTheme: {},
    dialog: { showErrorBox() {} }, BrowserWindow: FakeWindow, Menu: { setApplicationMenu() {} },
    session: { defaultSession, fromPartition }
  }
  const imports = []
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    require(n) { imports.push(n); return n === 'electron' ? electron : require(n) },
    process: { env: {}, pid: process.pid, platform: process.platform }, __dirname: root,
    console, setTimeout, clearTimeout, setImmediate, URL
  })
  ready()
  return { sessions, steps, defaultSession, unrelated, fromPartition, imports,
    get: () => handlers.get('config:get')(), save: cfg => handlers.get('config:save')(null, cfg) }
}
function assertDenied(ses) {
  for (const wc of [null, undefined, { getURL() { throw Error('do not dereference guest') } }]) {
    let answer, calls = 0
    ses.request(wc, 'notifications', value => { answer = value; calls++ }, { isMainFrame: false })
    assert.equal(answer, false)
    assert.equal(calls, 1)
    assert.equal(ses.check(wc, 'notifications', 'https://example.test', { isMainFrame: false }), false)
  }
}
test('startup denies guest notifications on all four service partitions before first window', t => {
  const f = fixture(t)
  for (const id of ['mm', 'tg', 'max', 'ydx']) {
    assertDenied(f.sessions.get('persist:' + id))
    assert.ok(f.steps.findIndex(s => s[0] === 'check' && s[1] === 'persist:' + id) < f.steps.findIndex(s => s[0] === 'window'))
  }
})
test('policy remains local to configured service sessions, not default/unrelated sessions', t => {
  const f = fixture(t)
  for (const ses of [f.defaultSession, f.unrelated, f.fromPartition('persist:later-unrelated')]) {
    assert.equal(ses.request, undefined)
    assert.equal(ses.check, undefined)
  }
})
test('other permissions retain prior request grants and Electron 33 check defaults', t => {
  const f = fixture(t), ses = f.sessions.get('persist:mm')
  for (const permission of ['media', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'midiSysex', 'unknown', 'deprecated-sync-clipboard-read']) {
    let answer
    ses.request(null, permission, v => answer = v)
    assert.equal(answer, true, permission)
    // Electron 33.4.11 denies only DEPRECATED_SYNC_CLIPBOARD_READ by default.
    assert.equal(ses.check ? ses.check(null, permission, '', {}) : permission !== 'deprecated-sync-clipboard-read', permission !== 'deprecated-sync-clipboard-read', permission)
  }
})
test('saved new/custom service partitions are protected before proxy setup', t => {
  const f = fixture(t), cfg = f.get()
  f.save({ ...cfg, services: [...cfg.services, { id: 'extra', url: 'https://example.test', partition: 'persist:custom' }] })
  assertDenied(f.sessions.get('persist:custom'))
  assert.ok(f.steps.findIndex(s => s[0] === 'check' && s[1] === 'persist:custom') < f.steps.findIndex(s => s[0] === 'proxy' && s[1] === 'persist:custom'))
})
test('startup never imports the inert broker or ledger and never constructs native toasts', t => {
  const f = fixture(t)
  assert.ok(!f.imports.some(n => /notification-(broker|ledger)/.test(n)))
})
