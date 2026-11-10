// ChatHub — все мессенджеры в одном окне + сборная вкладка с закреплёнными чатами
const { app, BrowserWindow, ipcMain, session, shell, webContents } = require('electron')
const path = require('path')
const fs = require('fs')

// Корп. хосты не должны уходить в системный прокси, если он включён
app.commandLine.appendSwitch(
  'proxy-bypass-list',
  '<-loopback>;*.astralinux.ru;*.astra-team.ru;localhost;127.0.0.1'
)

// dev-копия: CHATHUB_DEV_DATA переносит userData (сессии, конфиг) в отдельную
// папку, чтобы версия для разработки не делила состояние с рабочей
if (process.env.CHATHUB_DEV_DATA) {
  app.setPath('userData', process.env.CHATHUB_DEV_DATA)
  // отдельный AppUserModelID: иначе Windows склеивает окно dev-копии с
  // ярлыком стабильной версии в панели задач (клик по ярлыку открывал DEV)
  app.setAppUserModelId('ChatHub.Dev')
}
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')

const DEFAULT_CONFIG = {
  cssDefaultsVersion: 3,
  services: [
    { id: 'mm',  name: 'Mattermost',             url: 'https://im.astralinux.ru',    partition: 'persist:mm' },
    { id: 'tg',  name: 'Telegram',               url: 'https://web.telegram.org/k/', partition: 'persist:tg', proxy: 'http://127.0.0.1:18888' },
    { id: 'max', name: 'MAX',                    url: 'https://web.max.ru/',         partition: 'persist:max' },
    { id: 'ydx', name: 'Яндекс Чат (Телемост)',  url: 'https://telemost.yandex.ru/', partition: 'persist:ydx' }
  ],
  // CSS применяется ТОЛЬКО к колонкам сборной вкладки (прячем боковые панели),
  // вкладки самих мессенджеров не трогаем.
  columnCss: {
    // Правая панель Mattermost содержит тред (RHS); прячем только навигацию слева.
    mm: '#SidebarContainer,#sidebar-left,.sidebar--left{display:none!important}',
    tg: '.sidebar,.right-column{display:none!important}',
    max: '.app>aside{display:none!important}.app>main{width:100%!important}',
    ydx: '.yamb-root__layout>.ui-layout_direction_column,.yamb-sidebar{display:none!important}'
  },
  zoom: { mm: 1, tg: 1, max: 1, ydx: 1 },
  pinned: []
}

function loadConfig() {
  let saved = null
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  }
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  const merged = { ...base, ...saved }
  // доревьём дефолтные поля (например, proxy) в сохранённые сервисы по id
  merged.services = (saved.services || base.services).map(s => {
    const d = base.services.find(x => x.id === s.id)
    return d ? { ...d, ...s } : s
  })
  // устаревшие дефолтные CSS-правила обновляем принудительно (управляется версией)
  if (saved.cssDefaultsVersion !== base.cssDefaultsVersion) {
    merged.columnCss = { ...merged.columnCss, ...base.columnCss }
    merged.cssDefaultsVersion = base.cssDefaultsVersion
  }
  return merged
}

let config = loadConfig()

function persistConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

// Прокси на уровне сессии каждого мессенджера: например, Telegram
// недоступен с этой машины напрямую и ходит через локальный прокси.
function applyServiceProxies() {
  for (const svc of config.services) {
    try {
      const ses = session.fromPartition(svc.partition)
      const proxy = String(svc.proxy || '').trim()
      if (proxy) ses.setProxy({ proxyRules: proxy })
      else ses.setProxy({ mode: 'system' })
    } catch {}
  }
}

ipcMain.handle('config:get', () => config)
ipcMain.handle('config:save', (_e, cfg) => {
  // состояние окна (windowState) управляется только main — не даём рендереру его затирать
  if (cfg && typeof cfg === 'object') cfg.windowState = config.windowState || null
  config = cfg
  persistConfig()
  applyServiceProxies()
  return true
})
ipcMain.handle('config:path', () => CONFIG_PATH)
// настоящий фокус ОКНА приложения: document.hasFocus() в рендерере врёт,
// когда фокус уходит внутрь webview (клик в чат мессенджера), из-за чего
// фоновые проходы печатали в поиск Telegram при живом пользователе
ipcMain.handle('win:focused', () => BrowserWindow.getAllWindows().some(w => w.isFocused()))

// Доверенный ввод в webview. webk Telegram игнорирует синтетические JS-события,
// а webContents.insertText на скрытой вьюхе теряется. Работает только ввод
// через отладчик Chromium (Input.insertText / dispatchMouseEvent) — как CDP.
async function dbg(wc) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  return wc.debugger
}
ipcMain.handle('input:click', async (_e, { wcId, x, y }) => {
  const wc = webContents.fromId(wcId)
  if (!wc) return false
  try {
    const d = await dbg(wc)
    await d.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return true
  } catch { return false }
})
ipcMain.handle('input:text', async (_e, { wcId, text }) => {
  const wc = webContents.fromId(wcId)
  if (!wc) return false
  try {
    const d = await dbg(wc)
    await d.sendCommand('Input.insertText', { text: String(text || '') })
    return true
  } catch { return false }
})
ipcMain.handle('input:key', async (_e, { wcId, key, keyCode, modifiers }) => {
  const wc = webContents.fromId(wcId)
  if (!wc) return false
  try {
    const d = await dbg(wc)
    const mods = (modifiers || []).includes('control') ? 2 : 0
    const base = { key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mods }
    if (keyCode === 65) { base.key = 'a'; base.text = mods ? '' : 'a' }
    await d.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await d.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    return true
  } catch { return false }
})
// доверенный скролл (колесо) — нужен для подгрузки старых диалогов webk:
// виртуализированный список рендерит только видимое окно, прокрутка грузит
// следующие партии диалогов с их временами последних сообщений
ipcMain.handle('input:wheel', async (_e, { wcId, x, y, deltaY }) => {
  const wc = webContents.fromId(wcId)
  if (!wc) return false
  try {
    const d = await dbg(wc)
    await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
    return true
  } catch { return false }
})

function createWindow() {
  // webk (Telegram) прячет список диалогов при viewport < ~1320px, поэтому
  // окно должно открываться большим: запоминаем размеры и «развёрнутость»
  const saved = config.windowState || null
  const win = new BrowserWindow({
    width: saved && saved.width ? saved.width : 1600,
    height: saved && saved.height ? saved.height : 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'ChatHub — все чаты в одном окне',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })
  try {
    if (saved && saved.x !== undefined && saved.y !== undefined) win.setBounds({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
    if (saved && saved.maximized) win.maximize()
  } catch (e) {}
  let saveTid = null
  const saveState = () => {
    clearTimeout(saveTid)
    saveTid = setTimeout(() => {
      try {
        const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
        config.windowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
        persistConfig()
      } catch (e) {}
    }, 400)
  }
  win.on('resize', saveState)
  win.on('move', saveState)
  win.on('maximize', saveState)
  win.on('unmaximize', saveState)
  win.on('close', saveState)
  win.loadFile('index.html')
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

// window.open внутри webview мессенджеров НЕ должен открывать отдельные окна
// Electron (Яндекс Телемост так открывает чаты и звонки — получалось второе окно).
// Политика: ссылки наших сервисов — в том же webview; логин-страницы OAuth —
// всплывающим окном (флоу требует дочернее окно); прочее — системный браузер.
const SERVICE_HOSTS = ['astralinux.ru', 'web.telegram.org', 'web.max.ru', 'telemost.yandex.ru']
const AUTH_HOSTS = ['passport.yandex.ru', 'passport.yandex.com', 'accounts.google.com', 'login.microsoftonline.com', 'oauth.telegram.org', 'connect.login.ru', 'login.max.ru']
// журнал решений по window.open — чтобы понять, откуда берутся лишние окна
// (жалоба: «Яндекс Телемост опять открылся отдельным окном»)
const OPEN_LOG = path.join(app.getPath('userData'), 'window-open.log')
function logOpen(line) {
  try { fs.appendFileSync(OPEN_LOG, '[' + new Date().toISOString() + '] ' + line + '\n') } catch (e) {}
}
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    let from = ''
    try { from = contents.getURL() } catch (e) {}
    try {
      const host = new URL(url).hostname
      const hit = hosts => hosts.some(h => host === h || host.endsWith('.' + h))
      if (hit(SERVICE_HOSTS)) {
        // открываем в том же webview, отдельное окно не создаём
        logOpen('in-view  ' + url + '  <- ' + from)
        setImmediate(() => { try { contents.loadURL(url) } catch (e) {} })
        return { action: 'deny' }
      }
      if (hit(AUTH_HOSTS)) {
        logOpen('popup    ' + url + '  <- ' + from)
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#1e1f22' }
        }
      }
      if (/^https?:/i.test(url)) {
        logOpen('browser  ' + url + '  <- ' + from)
        shell.openExternal(url)
      } else {
        logOpen('deny     ' + url + '  <- ' + from)
      }
    } catch (e) { logOpen('error    ' + url + '  <- ' + from + '  ' + (e && e.message)) }
    return { action: 'deny' }
  })
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // Разрешаем мессенджерам уведомления, камеру и микрофон (Telemost-звонки и т.п.)
    const allow = (_wc, _perm, cb) => cb(true)
    for (const svc of config.services) {
      try {
        session.fromPartition(svc.partition).setPermissionRequestHandler(allow)
      } catch {}
    }
    applyServiceProxies()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
