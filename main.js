// ChatHub — все мессенджеры в одном окне + сборная вкладка с закреплёнными чатами
const { app, BrowserWindow, ipcMain, session, shell, webContents, Menu, nativeTheme, dialog } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const fs = require('fs')
// MCP-экспорт: мост запускается дочерним процессом (Electron как Node),
// manifest — временный файл в os.tmpdir(), имя — pid + криптослучайный хвост.
const { spawn, execFile } = require('child_process')
const os = require('os')
const crypto = require('crypto')
const { installGuestNotificationPolicy } = require('./guest-notification-policy')

// Корп. хосты не должны уходить в системный прокси, если он включён
app.commandLine.appendSwitch(
  'proxy-bypass-list',
  '<-loopback>;*.astralinux.ru;*.astra-team.ru;localhost;127.0.0.1'
)

function portableUserDataPath(resourcesPath, execPath, appDir = __dirname, hasMarker = false) {
  if (!hasMarker || typeof resourcesPath !== 'string' || !resourcesPath || typeof execPath !== 'string' || !execPath) return ''
  try {
    if (path.resolve(appDir) !== path.resolve(resourcesPath, 'app')) return ''
    return path.join(path.dirname(execPath), 'data')
  } catch (e) { return '' }
}

const PORTABLE_DATA = portableUserDataPath(
  process.resourcesPath,
  process.execPath,
  __dirname,
  fs.existsSync(path.join(__dirname, 'portable.json'))
)

// dev-копия: CHATHUB_DEV_DATA переносит userData (сессии, конфиг) в отдельную
// папку, чтобы версия для разработки не делила состояние с рабочей
if (process.env.CHATHUB_DEV_DATA) {
  app.setPath('userData', process.env.CHATHUB_DEV_DATA)
  // отдельный AppUserModelID: иначе Windows склеивает окно dev-копии с
  // ярлыком стабильной версии в панели задач (клик по ярлыку открывал DEV)
  app.setAppUserModelId('ChatHub.Dev')
} else {
  // Portable build keeps logins and config inside its unpacked folder.
  if (PORTABLE_DATA) app.setPath('userData', PORTABLE_DATA)
  // стабильная версия: отдельный AUMID, чтобы панель задач и уведомления
  // не показывали «Electron»
  app.setAppUserModelId('ChatHub')
}
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')
const TELEMOST_CONNECTION_LOG = path.join(app.getPath('userData'), 'telemost-connection.log')

function logTelemostConnection(payload) {
  const state = payload?.state
  const scope = payload?.scope
  if (!['retry-visible', 'retry-cleared'].includes(state) || !['pin', 'service'].includes(scope)) return false
  try {
    fs.appendFileSync(TELEMOST_CONNECTION_LOG, '[' + new Date().toISOString() + '] ' + state + ' ' + scope + '\n')
    return true
  } catch { return false }
}

const DEFAULT_CONFIG = {
  cssDefaultsVersion: 6,
  tabIcons: false,
  pinBackgroundActive: false,
  svcNameVisible: true,
  serviceMemorySaver: false,
  // новые контроли памяти сервисов: строгие булевы значения, по умолчанию
  // выключены; legacy serviceMemorySaver не переносится ни на одну из них
  serviceBackgroundThrottling: false,
  serviceIdleUnload: false,
  serviceMemoryGuard: false,
  // Параметры MCP-экспорта: каталог не выбран, глубина — одна неделя.
  mcpExportDir: '',
  mcpExportDepthDays: 7,
  favAvatarSize: 'large',
  favPreviewVisible: true,
  favPreviewLines: 2,
  favCommentVisible: true,
  favCommentStyle: 'muted',
  favCommentPlacement: 'right',
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
      // Необязательные локальные поля пина (комментарий, проект MCP, провенанс
      // названия) в старых сборках могли сохраниться как null. Отсутствие
      // допустимо, поэтому null нормализуем — удаляем ключ, а не отвергаем весь
      // конфиг: иначе следующий запуск ушёл бы в обработку повреждённых настроек.
      if (key === 'pinned') {
        for (const field of ['annotation', 'mcpProject', 'titleCustom']) {
          if (field in item && item[field] === null) delete item[field]
        }
      }
      if (key === 'pinned' && 'annotation' in item && (typeof item.annotation !== 'string' || item.annotation.length > 80)) invalid()
      // mcpProject — локальная служебная привязка к проекту MCP: только строка
      // (пустая допустима; удаление ключа при очистке делает renderer).
      if (key === 'pinned' && 'mcpProject' in item && (typeof item.mcpProject !== 'string' || item.mcpProject.length > 80)) invalid()
      // titleCustom — провенанс локального названия: true значит «это имя задал
      // человек», и авто-переименование его не трогает. Отсутствие допустимо
      // (старые конфиги), всё кроме boolean — отказ.
      if (key === 'pinned' && 'titleCustom' in item && typeof item.titleCustom !== 'boolean') invalid()
    }
  }
  for (const key of ['columnCss', 'zoom', 'activity']) {
    if (key in value && !configObject(value[key])) invalid()
  }
  if (value.columnCss && Object.values(value.columnCss).some(v => typeof v !== 'string')) invalid()
  if (value.zoom && Object.values(value.zoom).some(v => !Number.isFinite(v) || v <= 0)) invalid()
  if ('favAvatarSize' in value && !['large', 'medium', 'small'].includes(value.favAvatarSize)) invalid()
  if ('favPreviewVisible' in value && typeof value.favPreviewVisible !== 'boolean') invalid()
  if ('favPreviewLines' in value && ![1, 2].includes(value.favPreviewLines)) invalid()
  if ('favCommentVisible' in value && typeof value.favCommentVisible !== 'boolean') invalid()
  if ('favCommentStyle' in value && !['muted', 'title'].includes(value.favCommentStyle)) invalid()
  if ('favCommentPlacement' in value && !['inline', 'right'].includes(value.favCommentPlacement)) invalid()
  if ('serviceMemorySaver' in value && typeof value.serviceMemorySaver !== 'boolean') invalid()
  if ('serviceBackgroundThrottling' in value && typeof value.serviceBackgroundThrottling !== 'boolean') invalid()
  if ('serviceIdleUnload' in value && typeof value.serviceIdleUnload !== 'boolean') invalid()
  if ('serviceMemoryGuard' in value && typeof value.serviceMemoryGuard !== 'boolean') invalid()
  // Новые ключи не нормализуем: null и значения других типов отклоняем.
  if ('mcpExportDir' in value && (typeof value.mcpExportDir !== 'string' || value.mcpExportDir.length > 500 || /[\x00-\x1F]/.test(value.mcpExportDir))) invalid()
  if ('mcpExportDepthDays' in value && (!Number.isInteger(value.mcpExportDepthDays) || value.mcpExportDepthDays < 1 || value.mcpExportDepthDays > 30)) invalid()
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

// M9-R2 D1: rename поверх файла, открытого другим процессом (Python без
// FILE_SHARE_DELETE), даёт EPERM. Повторяем только транзиентные коды.
const CONFIG_RENAME_RETRY_DELAYS = [25, 75, 150]
const CONFIG_RENAME_RETRY_CODES = ['EPERM', 'EACCES', 'EBUSY']

// Синхронная пауза без зависимостей: Atomics.wait, при недоступности busy-wait.
function configRetrySleep(ms) {
  try {
    const buffer = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(buffer), 0, 0, ms)
    return
  } catch {}
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {}
}

function renameConfigFile(temp, target) {
  let retries = 0
  for (;;) {
    try {
      fs.renameSync(temp, target)
      return
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : ''
      if (!CONFIG_RENAME_RETRY_CODES.includes(code) || retries >= CONFIG_RENAME_RETRY_DELAYS.length) throw error
      configRetrySleep(CONFIG_RENAME_RETRY_DELAYS[retries])
      retries += 1
    }
  }
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
    renameConfigFile(temp, target)
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

function isShellSender(event) {
  try {
    const sender = event && event.sender
    const frame = event && event.senderFrame
    const shellUrl = pathToFileURL(path.join(__dirname, 'index.html')).href
    return sender?.getType?.() === 'window' &&
      sender.getURL?.() === shellUrl &&
      sender.mainFrame === frame &&
      frame?.url === shellUrl
  } catch { return false }
}
function requireShellSender(event) {
  if (!isShellSender(event)) throw new Error('Unauthorized IPC sender')
}

ipcMain.handle('config:get', event => {
  requireShellSender(event)
  return config
})
ipcMain.handle('config:save', (event, cfg) => {
  requireShellSender(event)
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
ipcMain.handle('config:path', event => { requireShellSender(event); return CONFIG_PATH })
ipcMain.handle('diagnostics:telemost-connection', (event, payload) => {
  requireShellSender(event)
  return logTelemostConnection(payload)
})
ipcMain.handle('app:version', event => { requireShellSender(event); return app.getVersion() })
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
ipcMain.handle('theme:set-source', (event, src) => {
  requireShellSender(event)
  if (src === 'light') config.theme = 'light'
  else if (src === 'dark') config.theme = 'dark'
  try { nativeTheme.themeSource = src === 'light' ? 'light' : 'dark' } catch {}
  applyThemeToAllWebviews()
  return true
})
// настоящий фокус ОКНА приложения: document.hasFocus() в рендерере врёт,
// когда фокус уходит внутрь webview (клик в чат мессенджера), из-за чего
// фоновые проходы печатали в поиск Telegram при живом пользователе
ipcMain.handle('win:focused', event => {
  requireShellSender(event)
  return BrowserWindow.getAllWindows().some(w => w.isFocused())
})

// --- Диагностика памяти сервисов (только чтение) ---
// Привязка guest↔сервис возникает ТОЛЬКО на did-attach-webview по точному
// совпадению guest.session === session.fromPartition(service.partition)
// (см. блок SERVICE_HOSTS): отказанные, неприкреплённые и неизвестные guests
// в снимок не попадают. Рендерер не передаёт ни ID, ни PID, ни URL — канал
// вызывается без аргументов.
function selectMemoryKiB(record) {
  const memory = record.memory && typeof record.memory === 'object' ? record.memory : null
  if (!memory) return null
  // Electron MemoryInfo сообщает KiB: privateBytes предпочтительнее, ноль валиден
  if (Number.isFinite(memory.privateBytes) && memory.privateBytes >= 0) return memory.privateBytes
  if (Number.isFinite(memory.workingSetSize) && memory.workingSetSize >= 0) return memory.workingSetSize
  return null
}
function serviceMetricKiBByPid() {
  const kibByPid = new Map()
  let records = null
  try { records = app.getAppMetrics() } catch { records = null }
  if (!Array.isArray(records)) return kibByPid
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const pid = record.pid
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (kibByPid.has(pid)) continue // дубликат PID не суммируется и не задваивается
    const kib = selectMemoryKiB(record)
    if (kib === null) continue // мусорная запись не занимает PID и ничего не изобретает
    kibByPid.set(pid, kib)
  }
  return kibByPid
}
function serviceMemorySnapshot() {
  const kibByPid = serviceMetricKiBByPid()
  let totalKiB = 0
  for (const kib of kibByPid.values()) totalKiB += kib
  const largestByService = new Map()
  let guests = null
  try { guests = webContents.getAllWebContents() } catch { guests = null }
  if (Array.isArray(guests)) {
    for (const guest of guests) {
      if (!guest || typeof guest !== 'object' || guest.isDestroyed?.()) continue
      if (guest.getType?.() !== 'webview') continue
      const serviceId = guestServiceIds.get(guest)
      if (!serviceId) continue
      let pid = null
      try { pid = guest.getOSProcessId() } catch { continue }
      if (!Number.isInteger(pid) || pid <= 0) continue
      const kib = kibByPid.get(pid)
      if (typeof kib !== 'number') continue
      if (!largestByService.has(serviceId) || kib > largestByService.get(serviceId)) largestByService.set(serviceId, kib)
    }
  }
  const services = []
  for (const service of config.services || []) {
    const kib = largestByService.get(service.id)
    if (typeof kib !== 'number') continue
    services.push({ id: service.id, memoryMiB: Math.floor(kib / 1024) })
  }
  // только санированный снимок: без порогов, cooldown, видимости и команд
  // жизненного цикла; totalMiB суммирует те же выбранные per-process KiB
  // по всему дереву метрик независимо от привязки
  return { services, totalMiB: Math.floor(totalKiB / 1024) }
}
ipcMain.handle('service-memory:metrics', event => {
  requireShellSender(event)
  return serviceMemorySnapshot()
})

// --- MCP-экспорт: каналы IPC, manifest и запуск моста ---
// Renderer не передаёт ни путей, ни списка чатов: manifest собирает main из
// своего конфига, путь моста — от корня приложения. Все каналы под
// requireShellSender; прогресс уходит только в shell-окно.
const MCP_SERVICES = ['mm', 'max', 'ydx']
const MCP_EXPORT_TIMEOUT_MS = 10 * 60 * 1000
// MAX читается из того же webview, где пользователь залогинен: окно 9333 больше
// не нужно. Сбор идёт в окне-оболочке, сбой сбора не мешает остальным каналам.
const MAX_COLLECT_TIMEOUT_MS = 10000
let mcpExportState = null

// Ленивая загрузка: при обычном старте окна экспорт не нужен, а vm-харнессы
// старых тестов подменяют require белым списком.
function mcpModules() {
  return {
    plan: require('./mcp-export/core/plan'),
    registry: require('./mcp-export/bridge/registry')
  }
}

function mcpBridgePath() {
  return path.join(__dirname, 'mcp-export', 'bridge', 'main.js')
}

function mcpShellWindow() {
  try { return BrowserWindow.getAllWindows()[0] || null } catch { return null }
}

function sendMcpProgress(event) {
  const win = mcpShellWindow()
  if (!win || win.isDestroyed?.()) return
  try { win.webContents.send('mcp:progress', event) } catch {}
}

// exportDir не должен лежать в профиле: отчёты и manifest там не место, а
// профиль — единственный каталог, который main знает точно.
function mcpExportDirIsForbidden(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return true
  let profile = ''
  try { profile = path.resolve(app.getPath('userData')) } catch { profile = '' }
  if (!profile) return false
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value
  const target = fold(path.resolve(dir))
  const base = fold(profile)
  return target === base || target.startsWith(base + path.sep)
}

function mcpDepthDays() {
  const value = config.mcpExportDepthDays
  if (!Number.isInteger(value)) return DEFAULT_CONFIG.mcpExportDepthDays
  return Math.min(30, Math.max(1, value))
}

// Токен Яндекса: Windows SecretStore, имя yandex-telemost-oauth-token. main
// читает его только когда в manifest есть ydx-чаты, и передаёт мосту ровно одним
// способом — env CHATHUB_YDX_TOKEN. В manifest, отчёт, журнал и аргументы
// командной строки он не попадает. Ошибка чтения не блокирует MM/MAX: ydx-чаты
// получат TOKEN_MISSING от моста.
const YANDEX_SECRET_NAME = 'yandex-telemost-oauth-token'
const YANDEX_TOKEN_ENV = 'CHATHUB_YDX_TOKEN'
const YANDEX_TOKEN_TIMEOUT_MS = 15000

function readYandexToken() {
  return new Promise(resolve => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          'Get-Secret -Name ' + YANDEX_SECRET_NAME + ' -AsPlainText'],
        { windowsHide: true, timeout: YANDEX_TOKEN_TIMEOUT_MS, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) { done(''); return }
          done(typeof stdout === 'string' ? stdout.trim() : '')
        }
      )
      if (child && typeof child.on === 'function') child.on('error', () => done(''))
    } catch {
      done('')
    }
  })
}

// Запись для probe: токен живёт только в этом объекте и в env коннектора,
// в реестр он не записывается.
function mcpConnectorEntryForYandex(service, entry, token) {
  if (service !== 'ydx' || !token) return entry
  const base = entry && entry.env && typeof entry.env === 'object' ? entry.env : {}
  return { ...entry, env: { ...base, YANDEX_TELEMOST_OAUTH_TOKEN: token } }
}

// M9-R2 D5: активный manifest помним на уровне модуля, чтобы снять его при выходе.
let activeMcpManifestPath = ''

// Ленивая уборка при каждом старте экспорта: manifest'ы старше часа.
function sweepStaleMcpManifests() {
  try {
    const dir = path.join(os.tmpdir(), 'chathub-mcp-export')
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('chathub-manifest-') || !name.endsWith('.json')) continue
      const file = path.join(dir, name)
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
      } catch {}
    }
  } catch {}
}

function forgetMcpManifest(file) {
  if (activeMcpManifestPath === file) activeMcpManifestPath = ''
}

function cleanupActiveMcpManifest() {
  const file = activeMcpManifestPath
  activeMcpManifestPath = ''
  if (!file) return
  try { fs.unlinkSync(file) } catch {}
}

app.on('will-quit', cleanupActiveMcpManifest)
app.on('before-quit', cleanupActiveMcpManifest)

function writeMcpManifest(manifest) {
  sweepStaleMcpManifests()
  const dir = path.join(os.tmpdir(), 'chathub-mcp-export')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = 'chathub-manifest-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.json'
  const file = path.join(dir, name)
  // 0600: в manifest названия чатов и номера проектов; chmod на Windows может
  // не примениться, поэтому он в try/catch
  fs.writeFileSync(file, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch {}
  activeMcpManifestPath = file
  return file
}

// MAX: запрос сбора в окно-оболочку. Только pinId/url/title — ничего лишнего
// из manifest в renderer не уходит. windowStartMs — граница глубины (те же
// depthDays из конфига, что у моста): по ней сборщик отмечает покрытие 'full',
// когда собранная лента дошла до окна выгрузки.
function maxPrefetchedRequest(chats) {
  return {
    chats: chats.map(chat => ({ pinId: chat.pinId, url: chat.url, title: chat.title })),
    timeoutMs: MAX_COLLECT_TIMEOUT_MS,
    windowStartMs: Date.now() - mcpDepthDays() * 24 * 60 * 60 * 1000
  }
}

function maxPrefetchedFailure() {
  return { messages: [], coverage: 'window', status: 'error', code: 'MAX_COLLECT_FAILED' }
}

// Строки сборщика (сессия, рабочий webview, «собрано …», трасса скроллера):
// только непустые строки, без повторов. В чат они не попадают — живут отдельным
// полем manifest, чтобы не дублироваться по каждому MAX-чату.
function maxCollectorNotes(value) {
  const notes = []
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue
    const line = item.trim()
    if (!line || notes.includes(line)) continue
    notes.push(line)
  }
  return notes
}

// Сбор MAX через window.__chatHubCollectMaxHistory в окне-оболочке. Любой сбой
// (нет метода, исключение, мусор вместо JSON) — MAX_COLLECT_FAILED на каждый
// MAX-чат; MM и остальные каналы продолжают выгрузку как раньше.
// Возвращает { prefetched: Map(pinId → запись), notes: string[] }.
async function collectMaxPrefetched(sender, chats) {
  const result = new Map()
  const notes = []
  const done = () => ({ prefetched: result, notes: notes })
  for (const chat of chats) result.set(chat.pinId, maxPrefetchedFailure())
  if (!sender || typeof sender.executeJavaScript !== 'function') return done()
  let payload = null
  try {
    const raw = await sender.executeJavaScript('window.__chatHubCollectMaxHistory(' + JSON.stringify(maxPrefetchedRequest(chats)) + ')')
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch { return done() }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.chats)) return done()
  // Строки сборщика читаются до разбора чатов: даже при странной записи чата
  // диагностика окна остаётся в отчёте.
  notes.push(...maxCollectorNotes(payload.notes))
  for (const item of payload.chats) {
    if (!item || typeof item !== 'object' || !result.has(item.pinId)) continue
    const status = item.status === 'ok' || item.status === 'skipped' || item.status === 'error' ? item.status : 'error'
    const code = typeof item.code === 'string' && item.code
      ? item.code
      : (status === 'error' ? 'MAX_COLLECT_FAILED' : null)
    const entry = {
      messages: Array.isArray(item.messages) ? item.messages : [],
      // coverage сборщика (full — прошли ленту от начала до низа или дошли до
      // границы глубины; truncated — упёрлись в 60 шагов или лента исчезла)
      // передаётся в manifest как есть; старые/неизвестные значения остаются
      // 'window', чтобы отчёт не обещал лишнего.
      coverage: item.coverage === 'full' || item.coverage === 'truncated' ? item.coverage : 'window',
      status,
      code
    }
    // Диагностика переключения (expected/actual) едет с чатом до моста, чтобы
    // SWITCH_TIMEOUT в отчёте объяснял, какой чат был открыт на самом деле.
    if (item.detail && typeof item.detail === 'object') {
      entry.detail = {
        expected: typeof item.detail.expected === 'string' ? item.detail.expected : '',
        actual: typeof item.detail.actual === 'string' ? item.detail.actual : ''
      }
    }
    // DOM-диагностика чтения MAX (капсулы/мета) — только у первого чата; едет
    // до моста, чтобы отчёт выгрузки показывал фактические селекторы, а не догадку.
    if (item.diag && typeof item.diag === 'object') entry.diag = item.diag
    result.set(item.pinId, entry)
  }
  return done()
}

// последняя непустая строка stdout — отчёт моста; мусор в stdout разбор не ломает
function parseMcpReport(stdout) {
  const lines = String(stdout || '').split('\n').map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index])
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {}
  }
  return null
}

// Коннектор может писать одну и ту же диагностическую строку десятки раз подряд
// (живой прогон: 40 копий одной строки Mattermost). Копим серию одинаковых строк
// одного сервиса и отдаём одно событие со счётчиком repeat; сама строка остаётся
// в событии. Ошибки с code/error не копим — их текст должен быть виден сразу.
let mcpProgressPending = null

function mcpProgressSignature(event) {
  if (!event || event.event !== 'connector_stderr') return ''
  if (event.code || event.error) return ''
  return String(event.service || '') + '\u0000' + String(event.line || '')
}

function flushMcpProgressPending() {
  const pending = mcpProgressPending
  mcpProgressPending = null
  if (!pending) return
  // Одиночная строка уходит как раньше, без поля repeat.
  sendMcpProgress(pending.repeat > 1 ? { ...pending.event, repeat: pending.repeat } : pending.event)
}

function emitMcpProgressLine(line) {
  let event = null
  try { event = JSON.parse(line) } catch { event = null }
  // битая строка stderr не должна ломать отчёт — отдаём её отдельным событием
  if (!event || typeof event !== 'object' || Array.isArray(event)) event = { event: 'connector_stderr', line }
  const signature = mcpProgressSignature(event)
  // Не диагностика (или ошибка с кодом) — сначала сбрасываем накопленную серию,
  // затем отдаём событие как есть: текст ошибки не должен схлопнуться в счётчик.
  if (!signature) {
    flushMcpProgressPending()
    sendMcpProgress(event)
    return
  }
  if (mcpProgressPending && mcpProgressPending.signature === signature) {
    mcpProgressPending.repeat += 1
    return
  }
  flushMcpProgressPending()
  mcpProgressPending = { signature: signature, event: event, repeat: 1 }
}

function killMcpTree(child) {
  if (!child || typeof child !== 'object') return false
  let killed = false
  // M9-R2 D6: сначала дерево целиком через taskkill /T, child.kill — fallback.
  try {
    if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      // taskkill может отсутствовать: без обработчика это unhandled 'error'.
      if (killer && typeof killer.on === 'function') killer.on('error', () => {})
      try { if (killer && typeof killer.unref === 'function') killer.unref() } catch {}
      killed = true
    }
  } catch {}
  try {
    if (!child.killed) { child.kill(); killed = true }
  } catch {}
  return killed
}

function runMcpBridge(manifestPath, exportDir, registryPath, ydxToken) {
  return new Promise(resolve => {
    let child
    try {
      // Токен Яндекса — только в env дочернего моста; в аргументах его нет.
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      delete env[YANDEX_TOKEN_ENV]
      if (typeof ydxToken === 'string' && ydxToken !== '') env[YANDEX_TOKEN_ENV] = ydxToken
      child = spawn(process.execPath, [
        mcpBridgePath(),
        '--manifest', manifestPath,
        '--out', exportDir,
        '--registry', registryPath
      ], {
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve({ ok: false, code: 'EXPORT_FAILED' })
      return
    }
    const state = { child, finished: false, cancelled: false, timer: null, stdout: '', stderr: '' }
    mcpExportState = state
    const finish = report => {
      if (state.finished) return
      state.finished = true
      // Накопленная серия диагностических строк закрывается вместе с процессом.
      flushMcpProgressPending()
      if (state.timer !== null) { try { clearTimeout(state.timer) } catch {} }
      if (mcpExportState === state) mcpExportState = null
      resolve(state.cancelled ? { ok: false, code: 'EXPORT_CANCELLED' } : report)
    }
    state.timer = setTimeout(() => {
      killMcpTree(child)
      finish({ ok: false, code: 'EXPORT_TIMEOUT' })
    }, MCP_EXPORT_TIMEOUT_MS)
    const drainStderr = () => {
      let index
      while ((index = state.stderr.indexOf('\n')) >= 0) {
        const line = state.stderr.slice(0, index).trim()
        state.stderr = state.stderr.slice(index + 1)
        if (line) emitMcpProgressLine(line)
      }
    }
    child.stdout.on('data', chunk => { state.stdout += String(chunk) })
    child.stderr.on('data', chunk => {
      state.stderr += String(chunk)
      drainStderr()
    })
    child.on('error', () => finish({ ok: false, code: 'EXPORT_FAILED' }))
    child.on('close', () => {
      drainStderr()
      const rest = state.stderr.trim()
      if (rest) emitMcpProgressLine(rest)
      finish(parseMcpReport(state.stdout) || { ok: false, code: 'EXPORT_FAILED' })
    })
  })
}

ipcMain.handle('mcp:choose-dir', async event => {
  requireShellSender(event)
  const options = { properties: ['openDirectory', 'createDirectory'] }
  let result
  try {
    const win = mcpShellWindow()
    result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  } catch {
    return { canceled: true, path: '' }
  }
  const chosen = result && !result.canceled && Array.isArray(result.filePaths) && typeof result.filePaths[0] === 'string'
    ? result.filePaths[0]
    : ''
  return { canceled: !chosen, path: chosen }
})

ipcMain.handle('mcp:connector-status', (event, service) => {
  requireShellSender(event)
  if (!MCP_SERVICES.includes(service)) {
    return { service: null, installed: false, path: null, mode: null, tools: [], code: 'INVALID_SERVICE' }
  }
  const none = { service, installed: false, path: null, mode: null, tools: [] }
  let modules
  try { modules = mcpModules() } catch { return none }
  let registry
  try {
    registry = modules.registry.loadRegistry(modules.registry.defaultRegistryPath())
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : ''
    // отсутствующий реестр — это «коннектор не установлен», а не ошибка канала
    if (code === 'REGISTRY_MISSING') return none
    return { ...none, code: code || 'REGISTRY_INVALID' }
  }
  const entry = registry && registry.connectors ? registry.connectors[service] : null
  if (!entry) return none
  return { service, installed: true, path: entry.command, mode: entry.mode, tools: entry.tools.slice() }
})

// --- Установка, подключение и проверка коннекторов (пакет M7) ---
// Renderer передаёт только имя сервиса: каталог выбирается диалогом, путь
// реестра знает main. Модули реестра грузятся лениво, как и остальные MCP-модули.
const MCP_CONNECTOR_TIMEOUT_MS = 45000

function mcpConnectorModules() {
  return {
    ...mcpModules(),
    seed: require('./mcp-export/registry/seed'),
    install: require('./mcp-export/registry/install')
  }
}

function mcpFailure(error, fallback) {
  const code = error && typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(error.code)
    ? error.code
    : fallback
  const message = error && error.message ? String(error.message) : ''
  return message ? { ok: false, code, message } : { ok: false, code }
}

ipcMain.handle('mcp:connector-install', async (event, service) => {
  requireShellSender(event)
  if (!MCP_SERVICES.includes(service)) return { ok: false, code: 'INVALID_SERVICE' }
  // Яндекс-коннектор живёт в разрешённой интеграции, но probe без токена не
  // имеет смысла: коннектор не запускаем вовсе.
  let ydxToken = null
  if (service === 'ydx') {
    ydxToken = await readYandexToken()
    if (!ydxToken) return { ok: false, code: 'TOKEN_MISSING' }
  }
  let modules
  try { modules = mcpConnectorModules() } catch { return { ok: false, code: 'CONNECTOR_INSTALL_FAILED' } }
  try {
    return await modules.install.installConnector(service, {
      registryPath: modules.registry.defaultRegistryPath(),
      // Коннектор MM читает config.json именно этого профиля (portable/dev/обычный).
      chatHubConfig: CONFIG_PATH,
      // Токен подмешивается только в запись probe; в реестр он не попадает.
      probe: ydxToken
        ? (name, entry, options) => modules.install.probeConnector(name, mcpConnectorEntryForYandex(name, entry, ydxToken), options)
        : undefined,
      probeOptions: { timeoutMs: MCP_CONNECTOR_TIMEOUT_MS }
    })
  } catch (error) {
    return mcpFailure(error, 'CONNECTOR_INSTALL_FAILED')
  }
})

ipcMain.handle('mcp:connector-connect', async (event, service) => {
  requireShellSender(event)
  if (!MCP_SERVICES.includes(service)) return { ok: false, code: 'INVALID_SERVICE' }
  let ydxToken = null
  if (service === 'ydx') {
    ydxToken = await readYandexToken()
    if (!ydxToken) return { ok: false, code: 'TOKEN_MISSING' }
  }
  let modules
  try { modules = mcpConnectorModules() } catch { return { ok: false, code: 'CONNECT_FAILED' } }
  let picked
  try {
    const win = mcpShellWindow()
    const options = { properties: ['openDirectory'] }
    picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  } catch {
    return { ok: false, code: 'CANCELLED' }
  }
  const dir = picked && !picked.canceled && Array.isArray(picked.filePaths) && typeof picked.filePaths[0] === 'string'
    ? picked.filePaths[0].trim()
    : ''
  if (!dir) return { ok: false, code: 'CANCELLED' }
  // В выбранном каталоге ищем '<dir>/.venv/Scripts/<exe>' из seed.
  const exePath = modules.seed.executableIn(service, dir)
  if (!exePath) return { ok: false, code: 'CONNECTOR_NOT_FOUND' }
  try {
    return await modules.install.connectExisting(service, {
      exePath,
      // Исходный max-mcp.config.json лежит в каталоге пакета, а не в ~/mcp.
      baseDir: path.dirname(dir),
      registryPath: modules.registry.defaultRegistryPath(),
      chatHubConfig: CONFIG_PATH,
      // Токен нужен только для probe и в реестр не записывается.
      probe: ydxToken
        ? (name, entry, options) => modules.install.probeConnector(name, mcpConnectorEntryForYandex(name, entry, ydxToken), options)
        : undefined,
      probeOptions: { timeoutMs: MCP_CONNECTOR_TIMEOUT_MS }
    })
  } catch (error) {
    return mcpFailure(error, 'CONNECT_FAILED')
  }
})

ipcMain.handle('mcp:probe', async (event, service) => {
  requireShellSender(event)
  if (!MCP_SERVICES.includes(service)) return { ok: false, code: 'INVALID_SERVICE' }
  let modules
  try { modules = mcpConnectorModules() } catch { return { ok: false, code: 'PROBE_FAILED' } }
  let registry
  try {
    registry = modules.registry.loadRegistry(modules.registry.defaultRegistryPath())
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : ''
    if (code === 'REGISTRY_MISSING') return { ok: false, code: 'NOT_INSTALLED' }
    return mcpFailure(error, 'REGISTRY_INVALID')
  }
  const entry = registry && registry.connectors ? registry.connectors[service] : null
  if (!entry) return { ok: false, code: 'NOT_INSTALLED' }
  // Яндекс без токена не проверяем: коннектор не запускаем.
  let ydxToken = null
  if (service === 'ydx') {
    ydxToken = await readYandexToken()
    if (!ydxToken) return { ok: false, code: 'TOKEN_MISSING' }
  }
  try {
    return await modules.install.probeConnector(service, mcpConnectorEntryForYandex(service, entry, ydxToken), { timeoutMs: MCP_CONNECTOR_TIMEOUT_MS })
  } catch (error) {
    return mcpFailure(error, 'PROBE_FAILED')
  }
})

ipcMain.handle('mcp:export', async event => {
  requireShellSender(event)
  // аргументы renderer'а (пути, глубина, список чатов) не читаются вовсе
  if (mcpExportState) return { ok: false, code: 'EXPORT_BUSY' }
  const exportDir = typeof config.mcpExportDir === 'string' ? config.mcpExportDir.trim() : ''
  if (!exportDir) return { ok: false, code: 'EXPORT_DIR_MISSING' }
  if (mcpExportDirIsForbidden(exportDir)) return { ok: false, code: 'EXPORT_DIR_FORBIDDEN' }
  let modules
  try { modules = mcpModules() } catch { return { ok: false, code: 'EXPORT_FAILED' } }
  const manifest = modules.plan.buildManifest(config.pinned || [], { exportDir, depthDays: mcpDepthDays(), now: new Date() })
  if (!manifest.chats.length) return { ok: false, code: 'NO_PROJECTS', skipped: manifest.skipped }
  if (!fs.existsSync(mcpBridgePath())) return { ok: false, code: 'BRIDGE_MISSING' }
  // MAX собирается в том же окне, где пользователь залогинен. Сбой сбора не
  // отменяет выгрузку: MAX-чаты получают error, MM идёт своим коннектором.
  const maxChats = manifest.chats.filter(chat => chat && chat.service === 'max')
  if (maxChats.length) {
    const collected = await collectMaxPrefetched(event.sender, maxChats)
    for (const chat of maxChats) {
      chat.prefetched = collected.prefetched.get(chat.pinId) || maxPrefetchedFailure()
    }
    // Строки сборщика — отдельным полем manifest: мост кладёт их в report.notes.
    if (collected.notes.length) manifest.maxNotes = collected.notes
  }
  // Токен Яндекса нужен только при наличии ydx-чатов. Ошибка чтения не
  // блокирует выгрузку: MM/MAX идут как обычно, ydx-чаты получат TOKEN_MISSING.
  let ydxToken = ''
  if (manifest.chats.some(chat => chat && chat.service === 'ydx')) {
    ydxToken = await readYandexToken()
  }
  let registryPath = ''
  try { registryPath = modules.registry.defaultRegistryPath() } catch { registryPath = '' }
  let manifestPath = ''
  try {
    manifestPath = writeMcpManifest(manifest)
    return await runMcpBridge(manifestPath, exportDir, registryPath, ydxToken)
  } catch {
    return { ok: false, code: 'EXPORT_FAILED' }
  } finally {
    // временный manifest не переживает запуск, ни успешный, ни аварийный
    if (manifestPath) { try { fs.unlinkSync(manifestPath) } catch {} }
    if (manifestPath) forgetMcpManifest(manifestPath)
  }
})

ipcMain.handle('mcp:cancel', event => {
  requireShellSender(event)
  const state = mcpExportState
  if (!state || state.cancelled || state.finished) return false
  if (!killMcpTree(state.child)) return false
  state.cancelled = true
  return true
})

// Коды записи файла избранного: ошибки writeFileAtomic несут префикс кода,
// остальное — общий EXPORT_FAILED.
const FAVORITES_EXPORT_CODES = ['EXPORT_DIR_MISSING', 'EXPORT_DIR_NOT_DIR', 'EXPORT_DIR_NOT_WRITABLE', 'EXPORT_NAME_INVALID']
function favoritesExportErrorCode(error) {
  const message = error && typeof error.message === 'string' ? error.message : ''
  for (const code of FAVORITES_EXPORT_CODES) {
    if (message.startsWith(code)) return code
  }
  return 'EXPORT_FAILED'
}

// «Избранное» → Markdown: выгружается только локальный список (config.pinned),
// аргументы renderer'а не читаются, мессенджеры не опрашиваются. Папка — из
// настроек MCP-выгрузки; если не задана, путь выбирается диалогом сохранения.
ipcMain.handle('favorites:export', async event => {
  requireShellSender(event)
  let favoritesCore, writeCore
  try {
    favoritesCore = require('./mcp-export/core/favorites')
    writeCore = require('./mcp-export/core/write')
  } catch {
    return { ok: false, code: 'EXPORT_FAILED' }
  }
  const pins = Array.isArray(config.pinned) ? config.pinned : []
  const now = new Date()
  const content = favoritesCore.renderFavoritesMarkdown(pins, { exportedAt: now.toISOString() })
  const defaultName = favoritesCore.fileName(now)
  const exportDir = typeof config.mcpExportDir === 'string' ? config.mcpExportDir.trim() : ''

  let directory = exportDir
  let name = defaultName
  if (!directory) {
    const options = {
      title: 'Выгрузить избранное в Markdown',
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    let picked
    try {
      const win = mcpShellWindow()
      picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    } catch {
      return { ok: false, code: 'EXPORT_FAILED' }
    }
    // Отмена диалога — не ошибка записи: renderer показывает «отменено».
    if (!picked || picked.canceled || typeof picked.filePath !== 'string' || !picked.filePath) {
      return { ok: false, code: 'CANCELLED' }
    }
    directory = path.dirname(picked.filePath)
    name = path.basename(picked.filePath)
  }
  try {
    const written = writeCore.writeFileAtomic(directory, name, content)
    return { ok: true, path: written, count: pins.length }
  } catch (error) {
    return { ok: false, code: favoritesExportErrorCode(error) }
  }
})

const shellContents = new WeakSet()
const shellDocumentUrl = pathToFileURL(path.join(__dirname, 'index.html')).href
function isShellDocumentUrl(raw) {
  try { return new URL(raw).href === shellDocumentUrl } catch { return false }
}
function isConfiguredGuestAttachment(params) {
  const src = String(params?.src || 'about:blank')
  const partition = String(params?.partition || '')
  const service = (config.services || []).find(svc => svc.partition === partition)
  if (!service) return false
  if (src === 'about:blank') return true
  try {
    const target = new URL(src), base = new URL(service.url)
    return target.protocol === 'https:' && base.protocol === 'https:' && target.origin === base.origin
  } catch { return false }
}

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
  shellContents.add(win.webContents)
  // Windows taskbar overlays belong to a window, not app.setBadgeCount().
  // Clear a stale overlay left from an earlier notification at each launch.
  if (process.platform === 'win32' && typeof win.setOverlayIcon === 'function') {
    try { win.setOverlayIcon(null, '') } catch (e) {}
  }
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
// Only the actual messenger origins stay in their webview. Links from chat
// messages to Jira/LIFE/Bitbucket and other corporate sites use the external
// browser instead of reusing the messenger's Electron guest.
const SERVICE_HOSTS = ['im.astralinux.ru', 'web.telegram.org', 'web.max.ru', 'telemost.yandex.ru']
const AUTH_HOSTS = ['passport.yandex.ru', 'passport.yandex.com', 'accounts.google.com', 'login.microsoftonline.com', 'oauth.telegram.org', 'connect.login.ru', 'login.max.ru']
function isConfiguredServiceUrl(raw) {
  try {
    const target = new URL(raw)
    if (target.protocol !== 'https:') return false
    return (config.services || []).some(svc => {
      try {
        const base = new URL(svc.url)
        return base.protocol === 'https:' && base.origin === target.origin
      } catch { return false }
    })
  } catch { return false }
}
function isAuthUrl(raw) {
  try {
    const target = new URL(raw)
    return target.protocol === 'https:' && AUTH_HOSTS.includes(target.hostname)
  } catch { return false }
}
function isAllowedGuestUrl(raw) {
  return isConfiguredServiceUrl(raw) || isAuthUrl(raw)
}

// Привязка guest↔сервис для диагностики памяти. will-attach-webview
// валидирует shell-хост и настроенный partition, но ничего не запоминает:
// на did-attach-webview guest связывается с сервисом ТОЛЬКО через точное
// совпадение его сессии с session.fromPartition(service.partition)
// настроенного сервиса. Ровно одно совпадение — привязка; отсутствие,
// неоднозначность или несовпадение сессии — guest остаётся без привязки.
// URL, порядок вложений, время, заголовок guest, идентичность от рендерера,
// PID и «заявления» сервисов никогда не используются — брошенное вложение
// не может отравить следующего guest.
const guestServiceIds = new WeakMap()       // guest webContents -> id настроенного сервиса
function serviceIdForGuestSession(guest) {
  let ses = null
  try { ses = guest && typeof guest === 'object' ? guest.session : null } catch { return null }
  if (!ses) return null
  let matched = null
  for (const service of config.services || []) {
    if (typeof service.partition !== 'string' || !service.partition) continue
    let candidate = null
    try { candidate = session.fromPartition(service.partition) } catch { continue }
    if (candidate !== ses) continue
    if (matched !== null) return null // неоднозначно: сессия делится несколькими сервисами
    matched = service.id
  }
  return matched
}
const guestAuthOrigins = new WeakMap()
const guestPendingServiceOrigins = new WeakMap()
function rememberConfiguredServiceNavigation(contents, raw) {
  try {
    const target = new URL(raw)
    if (!isConfiguredServiceUrl(target.toString())) return false
    guestPendingServiceOrigins.set(contents, { origin: target.origin, expiresAt: Date.now() + 60 * 1000 })
    return true
  } catch { return false }
}
function hasPendingConfiguredServiceNavigation(contents) {
  const state = guestPendingServiceOrigins.get(contents)
  if (!state || state.expiresAt < Date.now()) {
    guestPendingServiceOrigins.delete(contents)
    return false
  }
  return true
}
function temporaryAuthState(contents, create = false) {
  let state = guestAuthOrigins.get(contents)
  if (state && state.expiresAt < Date.now()) {
    guestAuthOrigins.delete(contents)
    state = null
  }
  if (!state && create) {
    state = { expiresAt: 0, origins: new Set() }
    guestAuthOrigins.set(contents, state)
  }
  return state
}
function isTemporaryAuthUrl(contents, raw) {
  try {
    const target = new URL(raw)
    const state = temporaryAuthState(contents)
    return target.protocol === 'https:' && !!state?.origins.has(target.origin)
  } catch { return false }
}
function grantRedirectedAuthOrigin(contents, raw) {
  try {
    const target = new URL(raw)
    if (target.protocol !== 'https:') return false
    const current = contents.getURL()
    // A custom identity provider is never admitted automatically and cannot
    // chain arbitrary origins. It must be granted explicitly from the
    // configured messenger page, then stays scoped to this one guest view.
    if (!isConfiguredServiceUrl(current) && !hasPendingConfiguredServiceNavigation(contents)) return false
    const state = temporaryAuthState(contents, true)
    if (state.origins.size && !state.origins.has(target.origin)) return false
    state.expiresAt = Date.now() + 10 * 60 * 1000
    state.origins.add(target.origin)
    return true
  } catch { return false }
}
function requestRedirectedAuthOrigin(contents, raw) {
  let target
  try {
    target = new URL(raw)
    if (target.protocol !== 'https:' || (!isConfiguredServiceUrl(contents.getURL()) && !hasPendingConfiguredServiceNavigation(contents))) return
  } catch { return }
  Promise.resolve(dialog.showMessageBox({
    type: 'question',
    buttons: ['Открыть для входа', 'Отмена'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: 'Переход для входа',
    detail: 'Мессенджер перенаправляет на ' + target.origin + '. Открыть эту страницу в ChatHub?'
  })).then(result => {
    if (result?.response !== 0 || !grantRedirectedAuthOrigin(contents, target.toString())) return
    try {
      const pending = contents.loadURL(target.toString())
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch {}
  }).catch(() => {})
}
function isPermittedGuestUrl(contents, raw) {
  return isAllowedGuestUrl(raw) || isTemporaryAuthUrl(contents, raw)
}
// журнал решений по window.open — чтобы понять, откуда берутся лишние окна
// (жалоба: «Яндекс Телемост опять открылся отдельным окном»)
const OPEN_LOG = path.join(app.getPath('userData'), 'window-open.log')
function safeOrigin(raw) {
  try { return new URL(raw).origin } catch { return '' }
}
function logOpen(kind, targetUrl, sourceUrl) {
  try {
    const target = safeOrigin(targetUrl)
    const source = safeOrigin(sourceUrl)
    const line = String(kind || '') + (target ? ' ' + target : '') + (source ? ' <- ' + source : '')
    fs.appendFileSync(OPEN_LOG, '[' + new Date().toISOString() + '] ' + line + '\n')
  } catch (e) {}
}
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const partition = String(params?.partition || '')
    const service = (config.services || []).find(svc => svc.partition === partition)
    if (!shellContents.has(contents) || !service || !isConfiguredGuestAttachment(params)) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.partition = service.partition
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
  })
  contents.on('did-attach-webview', (_event, guest) => {
    // привязка существует только при единственном точном совпадении сессии
    // guest с session.fromPartition(service.partition); guests без сессии,
    // с неоднозначной или несовпадающей сессией остаются без привязки
    const serviceId = serviceIdForGuestSession(guest)
    if (serviceId) guestServiceIds.set(guest, serviceId)
  })
  contents.on('will-navigate', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame === false) return
    if (shellContents.has(contents) && contents.getType?.() === 'window') {
      if (!isShellDocumentUrl(url)) { try { event.preventDefault() } catch {} }
      return
    }
    if (contents.getType?.() !== 'webview' || isPermittedGuestUrl(contents, url)) return
    try { event.preventDefault() } catch {}
    try {
      const target = new URL(url)
      if (target.protocol === 'https:') shell.openExternal(target.toString())
    } catch {}
  })
  contents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
    if (contents.getType?.() === 'webview' && isMainFrame !== false) rememberConfiguredServiceNavigation(contents, url)
  })
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame === false) return
    if (shellContents.has(contents) && contents.getType?.() === 'window') {
      if (!isShellDocumentUrl(url)) { try { event.preventDefault() } catch {} }
      return
    }
    if (contents.getType?.() !== 'webview' || isPermittedGuestUrl(contents, url)) return
    try { event.preventDefault() } catch {}
    requestRedirectedAuthOrigin(contents, url)
  })
  contents.on('did-navigate', (_event, url, _inPlace, isMainFrame) => {
    if (contents.getType?.() === 'webview' && isMainFrame !== false && isConfiguredServiceUrl(url)) {
      guestAuthOrigins.delete(contents)
      guestPendingServiceOrigins.delete(contents)
    }
  })
  contents.setWindowOpenHandler(({ url }) => {
    let from = ''
    try { from = contents.getURL() } catch (e) {}
    try {
      if (isConfiguredServiceUrl(url)) {
        // открываем в том же webview, отдельное окно не создаём
        logOpen('in-view', url, from)
        setImmediate(() => { try { contents.loadURL(url) } catch (e) {} })
        return { action: 'deny' }
      }
      if (isAuthUrl(url)) {
        logOpen('popup', url, from)
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#1e1f22' }
        }
      }
      if (/^https?:/i.test(url)) {
        logOpen('browser', url, from)
        shell.openExternal(url)
      } else {
        logOpen('deny', url, from)
      }
    } catch (e) { logOpen('error', url, from) }
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
  const allowedAuthPopupUrl = url => isAuthUrl(url) || isConfiguredServiceUrl(url)
  const normalizeNavigation = (urlOrDetails, legacyMainFrame) => {
    if (urlOrDetails && typeof urlOrDetails === 'object') {
      return {
        url: String(urlOrDetails.url || ''),
        isMainFrame: urlOrDetails.isMainFrame === true,
        initiator: safeOrigin(urlOrDetails.initiator?.url || '')
      }
    }
    return { url: String(urlOrDetails || ''), isMainFrame: legacyMainFrame === true, initiator: '' }
  }
  // Record native-window lifecycle boundaries with origins only. This is
  // diagnostic evidence for a future unexpected Telemost window, not a policy change.
  logOpen('native-window-created', wc.getURL())
  const blockForeignAuthPopupNavigation = (url, event) => {
    if (!authFlow || allowedAuthPopupUrl(url)) return false
    try { if (event && typeof event.preventDefault === 'function') event.preventDefault() } catch {}
    return true
  }
  const inspectMainFrame = (url, event) => {
    try {
      const parsed = new URL(url || '')
      if (parsed.protocol !== 'https:') return
      const host = parsed.hostname
      if (AUTH_HOSTS.includes(host)) authFlow = true
      if (!authFlow && /(^|\.)telemost\.yandex\.ru$/i.test(host)) {
        // Never persist OAuth codes, query strings or chat identifiers.
        logOpen('block-telemost-window', parsed.origin)
        try { if (event && typeof event.preventDefault === 'function') event.preventDefault() } catch (e) {}
        try { win.destroy() } catch (e) {}
      }
    } catch (e) {}
  }
  inspectMainFrame(wc.getURL())
  // A popup can be created as about:blank and receive its target before the
  // navigation listeners observe it (for example from a service worker).
  // Recheck once on the next turn so such a direct Telemost window cannot stay.
  setImmediate(() => inspectMainFrame(wc.getURL()))
  const onWillNavigate = (event, urlOrDetails, _inPlace, isMainFrame) => {
    const nav = normalizeNavigation(urlOrDetails, isMainFrame)
    if (!nav.isMainFrame) return
    inspectMainFrame(nav.url, event)
    blockForeignAuthPopupNavigation(nav.url, event)
  }
  const onWillRedirect = (event, urlOrDetails, _inPlace, isMainFrame) => {
    const nav = normalizeNavigation(urlOrDetails, isMainFrame)
    if (!nav.isMainFrame) return
    inspectMainFrame(nav.url, event)
    blockForeignAuthPopupNavigation(nav.url, event)
  }
  const onNavigation = (_ev, urlOrDetails, _inPlace, isMainFrame) => {
    const nav = normalizeNavigation(urlOrDetails, isMainFrame)
    if (!nav.isMainFrame) return
    logOpen('native-window-navigation', nav.url, nav.initiator)
    inspectMainFrame(nav.url)
  }
  wc.on('will-navigate', onWillNavigate)
  wc.on('will-redirect', onWillRedirect)
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
