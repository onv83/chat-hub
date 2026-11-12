// ChatHub — все мессенджеры в одном окне + сборная вкладка с закреплёнными чатами
const { app, BrowserWindow, ipcMain, session, shell, webContents, Menu, nativeTheme, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { installGuestNotificationPolicy } = require('./guest-notification-policy')

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
  cssDefaultsVersion: 6,
  tabIcons: false,
  services: [
    { id: 'mm',  name: 'Mattermost',             url: 'https://im.astralinux.ru',    partition: 'persist:mm' },
    { id: 'tg',  name: 'Telegram',               url: 'https://web.telegram.org/k/', partition: 'persist:tg', proxy: 'http://127.0.0.1:18888' },
    { id: 'max', name: 'MAX',                    url: 'https://web.max.ru/',         partition: 'persist:max' },
    { id: 'ydx', name: 'Яндекс Чат (Телемост)',  url: 'https://telemost.yandex.ru/', partition: 'persist:ydx' }
  ],
  // CSS применяется ТОЛЬКО к колонкам сборной вкладки (прячем боковые панели),
  // вкладки самих мессенджеров не трогаем.
  columnCss: {
    // MM: в пинах только лента чата. Скрыты: навигация слева, вся верхняя полоса
    // (#global-header: продукты, поиск, помощь), шапка канала (.channel-header:
    // кнопка Channel, избранное, участники, файлы) и полоса плагинов (.app-bar:
    // focalboard, playbooks, todo). Правая панель треда (RHS) НЕ скрывается —
    // треды по «N ответов» работают; открытая с прошлой сессии панель
    // закрывается один раз при загрузке пин-вьюхи (см. ensurePinView).
    mm: '#SidebarContainer,#sidebar-left,.sidebar--left,.team-sidebar{display:none!important}#global-header{display:none!important}.channel-header{display:none!important}.app-bar{display:none!important}',
    // TG: вместо фиксированного сдвига -202px (при сужении уводил чат за левый
    // край) — растяжка #column-center на контейнер (absolute: left/right 0).
    tg: '.sidebar,.right-column{display:none!important} #column-center{margin:0!important;left:0!important;right:0!important;width:auto!important;max-width:none!important;transform:none!important}',
    // MAX: без фиксированного -77px (та же болезнь при сужении). Навигацию MAX
    // и ширину ленты в пинах задаёт insertCSS в ensurePinView (там медиа-сдвиг);
    // в конфиге — только базовые правила.
    max: '.app>aside{display:none!important}.app{margin:0!important;width:100%!important;max-width:none!important;min-width:0!important;box-sizing:border-box!important}',
    // Yandex GlobalBar (64px: Алиса/Почта/Диск...) после обновления веба торчит
    // в пинах отдельно от колонки — скрываем его и там (в сервисной вкладке —
    // своим insertCSS).
    ydx: '.yamb-root__layout>.ui-layout_direction_column,.yamb-sidebar,[class^="GlobalBarRoot"]{display:none!important}'
  },
  zoom: { mm: 1, tg: 1, max: 1, ydx: 1 },
  favBadgeAlways: false,
  pinned: []
}

let configTempSequence = 0
let configWriteBlocked = false
const configNotices = new Set()
const configObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function validateConfig(value) {
  const invalid = () => { throw new Error('Некорректный формат настроек; сохранение отменено.') }
  if (!configObject(value)) invalid()
  for (const key of ['services', 'pinned']) {
    if (!(key in value)) continue
    if (!Array.isArray(value[key])) invalid()
    const ids = new Set()
    for (const item of value[key]) {
      if (!configObject(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) invalid()
      ids.add(item.id)
      const required = key === 'services' ? ['url'] : ['serviceId', 'url']
      for (const field of required) if (typeof item[field] !== 'string' || !item[field]) invalid()
      for (const field of ['name', 'title', 'partition', 'proxy', 'key']) {
        if (field in item && typeof item[field] !== 'string') invalid()
      }
    }
  }
  for (const key of ['columnCss', 'zoom', 'activity']) {
    if (key in value && !configObject(value[key])) invalid()
  }
  if (value.columnCss && Object.values(value.columnCss).some(v => typeof v !== 'string')) invalid()
  if (value.zoom && Object.values(value.zoom).some(v => !Number.isFinite(v) || v <= 0)) invalid()
  if ('windowState' in value && value.windowState !== null) {
    if (!configObject(value.windowState)) invalid()
    for (const key of ['x', 'y', 'width', 'height']) {
      if (key in value.windowState && (!Number.isFinite(value.windowState[key]) || (['width', 'height'].includes(key) && value.windowState[key] <= 0))) invalid()
    }
    if ('maximized' in value.windowState && typeof value.windowState.maximized !== 'boolean') invalid()
  }
  return value // Unknown keys are intentionally retained, including nested fields.
}

function loadConfig() {
  let saved, original, missing = false
  try {
    original = fs.readFileSync(CONFIG_PATH, 'utf8')
    saved = validateConfig(JSON.parse(original))
  } catch (error) {
    missing = error.code === 'ENOENT'
    let backupText
    try {
      backupText = fs.readFileSync(CONFIG_PATH + '.bak', 'utf8')
      saved = validateConfig(JSON.parse(backupText))
    } catch (backupError) {
      // Only a truly new profile may autosave defaults. Corruption/read errors
      // must never turn an automatic renderer/window save into a factory reset.
      configWriteBlocked = !(missing && backupError.code === 'ENOENT')
      if (configWriteBlocked) reportConfigProblem('Настройки не прочитаны. Исходные файлы не изменены; сохранение отключено. Восстановите config.json из исправной копии и перезапустите ChatHub.')
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
    }
    try {
      if (!missing) {
        if (original === undefined) throw new Error('unreadable')
        // Exclusive archive: never replace an earlier recovery artifact.
        const archive = CONFIG_PATH + '.invalid-' + Date.now() + '-' + process.pid + '-' + (++configTempSequence)
        fs.copyFileSync(CONFIG_PATH, archive, fs.constants.COPYFILE_EXCL)
        const fd = fs.openSync(archive, 'r+')
        try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      }
      atomicConfigWrite(CONFIG_PATH, backupText)
      reportConfigProblem('Настройки восстановлены из config.json.bak. Повреждённый исходный файл, если он был доступен, сохранён отдельно как config.json.invalid-… .')
    } catch {
      configWriteBlocked = true
      reportConfigProblem('Загружена резервная копия настроек, но восстановить основной файл не удалось. Исходные файлы сохранены; запись отключена до исправления config.json и перезапуска ChatHub.')
    }
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
// тема приложения → nativeTheme: webview-мессенджеры в «системной» теме
// должны подхватывать светлый/тёмный режим сразу при старте
try { nativeTheme.themeSource = config.theme === 'light' ? 'light' : 'dark' } catch {}

function reportConfigProblem(message) {
  // Never expose parser errors, paths, configuration values or OS error text.
  if (configNotices.has(message)) return
  configNotices.add(message)
  console.error('[ChatHub config] ' + message)
  try { dialog.showErrorBox('ChatHub — настройки', message) } catch {}
}

function atomicConfigWrite(target, text) {
  const temp = target + '.tmp-' + process.pid + '-' + (++configTempSequence)
  let fd, owned = false
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    owned = true
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    // Same-directory replacement: never unlink/truncate the committed file.
    fs.renameSync(temp, target)
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
    if (owned) { try { fs.unlinkSync(temp) } catch {} }
  }
}

function persistConfig(next = config) {
  try {
    if (configWriteBlocked) throw new Error('read-only recovery')
    validateConfig(next)
    const text = JSON.stringify(next, null, 2)
    validateConfig(JSON.parse(text))
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    let previous
    try { previous = fs.readFileSync(CONFIG_PATH, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (previous !== undefined) {
      validateConfig(JSON.parse(previous))
      atomicConfigWrite(CONFIG_PATH + '.bak', previous)
    }
    atomicConfigWrite(CONFIG_PATH, text)
  } catch {
    const message = 'Не удалось сохранить настройки. Предыдущий файл сохранён; изменения не записаны.'
    reportConfigProblem(message)
    throw new Error(message)
  }
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

function applyServiceNotificationPolicy() {
  for (const svc of config.services) {
    installGuestNotificationPolicy(session.fromPartition(svc.partition))
  }
}

ipcMain.handle('config:get', () => config)
ipcMain.handle('config:save', (_e, cfg) => {
  try { validateConfig(cfg) } catch {
    const message = 'Некорректный формат настроек; сохранение отменено.'
    reportConfigProblem(message)
    throw new Error(message)
  }
  // состояние окна (windowState) управляется только main — не даём рендереру его затирать
  const next = { ...config, ...cfg, windowState: config.windowState || null }
  persistConfig(next)
  config = next
  applyServiceNotificationPolicy()
  applyServiceProxies()
  return true
})
ipcMain.handle('config:path', () => CONFIG_PATH)
ipcMain.handle('app:version', () => app.getVersion())
// тема мессенджеров в webview: нативный prefers-color-scheme до webview НЕ
// доезжает (Electron не наследует его внутрь <webview>), поэтому подменяем
// media query через CDP-эмуляцию ЖИВО, без перезагрузки страниц. Телемост
// (theme_auto) и Telegram-webk следуют системной теме и перекрашиваются
// мгновенно; MM держит тему в настройках аккаунта — его переключаем там
function applyThemeToWC(wc, v) {
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: v }]
    })
  } catch {}
}
function applyThemeToAllWebviews() {
  const v = config.theme === 'light' ? 'light' : 'dark'
  for (const wc of webContents.getAllWebContents()) applyThemeToWC(wc, v)
}
app.on('web-contents-created', (_e, wc) => {
  // каждая новая webview (вкладка сервиса / пин) сразу получает тему
  wc.once('dom-ready', () => applyThemeToWC(wc, config.theme === 'light' ? 'light' : 'dark'))
})
ipcMain.handle('theme:set-source', (_e, src) => {
  if (src === 'light') config.theme = 'light'
  else if (src === 'dark') config.theme = 'dark'
  try { nativeTheme.themeSource = src === 'light' ? 'light' : 'dark' } catch {}
  applyThemeToAllWebviews()
  return true
})
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
// мгновенный стоп: пока окно приложения в фокусе, доверенный ввод ЗАПРЕЩЁН.
// Проход индексации мог стартовать, пока окно было в фоне (пользователь печатал
// в другом окне рядом), и продолжал печатать в поле с курсором, когда
// пользователь вернулся. Блокируем на самом низком уровне — до любого ввода.
const userAtApp = () => BrowserWindow.getAllWindows().some(w => w.isFocused())

ipcMain.handle('input:click', async (_e, { wcId, x, y }) => {
  if (userAtApp()) return 'blocked-focus'
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
  if (userAtApp()) return 'blocked-focus'
  const wc = webContents.fromId(wcId)
  if (!wc) return false
  try {
    const d = await dbg(wc)
    await d.sendCommand('Input.insertText', { text: String(text || '') })
    return true
  } catch { return false }
})
ipcMain.handle('input:key', async (_e, { wcId, key, keyCode, modifiers }) => {
  if (userAtApp()) return 'blocked-focus'
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
  if (userAtApp()) return 'blocked-focus'
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
    icon: path.join(__dirname, 'build', 'icon.ico'),
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
        const next = { ...config, windowState: { ...config.windowState, x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() } }
        persistConfig(next)
        config = next
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

// Запасной барьер против окон Телемоста, созданных НЕ через обычный
// window.open (service worker clients.openWindow, всплывшие после reload):
// такие окна не должны существовать вовсе — чат остаётся в webview ChatHub.
app.on('browser-window-created', (_e, win) => {
  const wc = win.webContents
  // An auth window owns its callback for its entire lifetime. Subframes
  // cannot classify (or destroy) the containing native window.
  let authFlow = false
  const inspectMainFrame = (url) => {
    try {
      const parsed = new URL(url || '')
      if (parsed.protocol !== 'https:') return
      const host = parsed.hostname
      if (AUTH_HOSTS.includes(host)) authFlow = true
      if (!authFlow && /(^|\.)telemost\.yandex\.ru$/i.test(host)) {
        // Never persist OAuth codes, query strings or chat identifiers.
        logOpen('block-telemost-window ' + parsed.origin)
        try { win.destroy() } catch (e) {}
      }
    } catch (e) {}
  }
  inspectMainFrame(wc.getURL())
  const onNavigation = (_ev, url, _inPlace, isMainFrame) => {
    if (isMainFrame === true) inspectMainFrame(url)
  }
  wc.on('did-start-navigation', onNavigation)
  wc.on('did-redirect-navigation', onNavigation)
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
    // скрываем штатное меню Electron (File/Edit/View…) — окно полностью наше
    Menu.setApplicationMenu(null)
    // Temporary containment: ALL guest toasts (favorites too) are blocked.
    // Only configured ChatHub service sessions; no account setting changes.
    // Trusted favorite message-event adapters are not yet connected.
    applyServiceNotificationPolicy()
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
