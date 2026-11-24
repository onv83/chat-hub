import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'chathub-navigation-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const handlers = new Map(), windows = []
  let ready
  const on = (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn])
  const emit = (name, ...args) => { for (const fn of handlers.get(name) || []) fn(...args) }
  class Contents {
    constructor(type, url = 'about:blank') { this.type = type; this.url = url; this.events = new Map() }
    getType() { return this.type }
    getURL() { return this.url }
    on(name, fn) { this.events.set(name, [...(this.events.get(name) || []), fn]) }
    once(name, fn) { this.on(name, fn) }
    emit(name, ...args) { for (const fn of this.events.get(name) || []) fn(...args) }
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn }
  }
  class FakeWindow {
    static getAllWindows() { return windows }
    constructor() {
      this.events = new Map()
      this.webContents = new Contents('window')
      windows.push(this)
      emit('web-contents-created', {}, this.webContents)
    }
    on(name, fn) { this.events.set(name, fn) }
    isMaximized() { return false }
    getBounds() { return { x: 1, y: 2, width: 1200, height: 900 } }
    loadFile(name) { this.webContents.url = pathToFileURL(path.join(root, name)).href }
    setBounds() {}
    maximize() {}
    setOverlayIcon() {}
  }
  const sessions = new Map()
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      getPath() { return dir },
      on,
      requestSingleInstanceLock: () => true,
      setAppUserModelId() {},
      whenReady: () => ({ then(fn) { ready = fn } })
    },
    BrowserWindow: FakeWindow,
    ipcMain: { handle() {} },
    session: { fromPartition(id) {
      if (!sessions.has(id)) sessions.set(id, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setProxy() {} })
      return sessions.get(id)
    } },
    shell: { openExternal() {} },
    webContents: { fromId() { return null }, getAllWebContents() { return [] } },
    Menu: { setApplicationMenu() {} },
    nativeTheme: {},
    dialog: { showErrorBox() {}, showMessageBox: async () => ({ response: 1 }) }
  }
  const context = vm.createContext({
    require(name) { return name === 'electron' ? electron : name === './guest-notification-policy' ? require('../guest-notification-policy') : require(name) },
    process: { env: {}, pid: process.pid, platform: process.platform, resourcesPath: '', execPath: '' },
    __dirname: root,
    console,
    URL,
    setTimeout,
    clearTimeout,
    setImmediate
  })
  vm.runInContext(source, context)
  ready()
  return { Contents, emit, shell: windows[0].webContents }
}

function event() {
  return { prevented: false, preventDefault() { this.prevented = true } }
}

test('only the local shell may embed configured guests and it cannot navigate away from index.html', t => {
  const f = fixture(t)
  const foreignNavigation = event()
  f.shell.emit('will-navigate', foreignNavigation, 'https://evil.example/', false, true)
  assert.equal(foreignNavigation.prevented, true)

  const localNavigation = event()
  f.shell.emit('will-navigate', localNavigation, f.shell.getURL(), false, true)
  assert.equal(localNavigation.prevented, false)

  const allowedGuest = event(), allowedPrefs = { preload: 'C:/evil.js', nodeIntegration: true, partition: 'persist:other' }
  f.shell.emit('will-attach-webview', allowedGuest, allowedPrefs, { src: 'https://im.astralinux.ru/', partition: 'persist:mm' })
  assert.equal(allowedGuest.prevented, false)
  assert.equal(allowedPrefs.preload, undefined)
  assert.equal(allowedPrefs.nodeIntegration, false)
  assert.equal(allowedPrefs.partition, 'persist:mm')

  const foreignWindow = new f.Contents('window', 'https://evil.example/')
  f.emit('web-contents-created', {}, foreignWindow)
  const blockedGuest = event(), blockedPrefs = {}
  foreignWindow.emit('will-attach-webview', blockedGuest, blockedPrefs, { src: 'https://im.astralinux.ru/', partition: 'persist:mm' })
  assert.equal(blockedGuest.prevented, true)
})
