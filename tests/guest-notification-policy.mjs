import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
    setOverlayIcon(icon, description) { steps.push(['overlay', icon, description]) }
  }
  const shellFrame = { url: pathToFileURL(path.join(root, 'index.html')).href }
  const shellSender = { getType: () => 'window', getURL: () => shellFrame.url, mainFrame: shellFrame }
  const electron = {
    app: { commandLine: { appendSwitch() {} }, getPath: () => dir,
      on(n, fn) { events.set(n, [...(events.get(n) || []), fn]) },
      requestSingleInstanceLock: () => true, setAppUserModelId() {}, whenReady: () => ({ then(fn) { ready = fn } }) },
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
    get: () => handlers.get('config:get')({ sender: shellSender, senderFrame: shellFrame }), save: cfg => handlers.get('config:save')({ sender: shellSender, senderFrame: shellFrame }, cfg) }
}
function assertDenied(ses, permission) {
  for (const wc of [null, undefined, { getURL() { throw Error('do not dereference guest') } }]) {
    let answer, calls = 0
    ses.request(wc, permission, value => { answer = value; calls++ }, { isMainFrame: false })
    assert.equal(answer, false)
    assert.equal(calls, 1)
    assert.equal(ses.check(wc, permission, 'https://example.test', { isMainFrame: false }), false)
  }
}
test('startup denies guest notifications on all four service partitions before first window', t => {
  const f = fixture(t)
  for (const id of ['mm', 'tg', 'max', 'ydx']) {
    assertDenied(f.sessions.get('persist:' + id), 'notifications')
    assert.ok(f.steps.findIndex(s => s[0] === 'check' && s[1] === 'persist:' + id) < f.steps.findIndex(s => s[0] === 'window'))
  }
})
test('startup clears the Windows taskbar overlay on the application window', t => {
  const f = fixture(t)
  const overlay = f.steps.findIndex(step => step[0] === 'overlay')
  const window = f.steps.findIndex(step => step[0] === 'window')
  assert.deepEqual(f.steps[overlay], ['overlay', null, ''])
  assert.ok(window >= 0 && overlay > window)
})
test('policy remains local to configured service sessions, not default/unrelated sessions', t => {
  const f = fixture(t)
  for (const ses of [f.defaultSession, f.unrelated, f.fromPartition('persist:later-unrelated')]) {
    assert.equal(ses.request, undefined)
    assert.equal(ses.check, undefined)
  }
})
test('guest service sessions deny every browser permission by default', t => {
  const f = fixture(t), ses = f.sessions.get('persist:mm')
  for (const permission of ['media', 'display-capture', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'midiSysex', 'openExternal', 'unknown', 'deprecated-sync-clipboard-read']) {
    assertDenied(ses, permission)
  }
})
test('saved new/custom service partitions are protected before proxy setup', t => {
  const f = fixture(t), cfg = f.get()
  f.save({ ...cfg, services: [...cfg.services, { id: 'extra', url: 'https://example.test', partition: 'persist:custom' }] })
  assertDenied(f.sessions.get('persist:custom'), 'notifications')
  assert.ok(f.steps.findIndex(s => s[0] === 'check' && s[1] === 'persist:custom') < f.steps.findIndex(s => s[0] === 'proxy' && s[1] === 'persist:custom'))
})
test('startup never imports the inert broker or ledger and never constructs native toasts', t => {
  const f = fixture(t)
  assert.ok(!f.imports.some(n => /notification-(broker|ledger)/.test(n)))
})
