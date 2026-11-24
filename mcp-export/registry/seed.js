'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const { YANDEX_INTEGRATION_ROOT } = require('../bridge/registry')

// Реестр «известных» коннекторов: где лежит уже распакованный пакет и какие
// инструменты он обязан отдавать. Никаких сетевых загрузок здесь нет —
// установка означает «взять то, что уже лежит на диске».
const DEFAULT_BASE_DIR = path.win32.join(os.homedir(), 'mcp')

const CONNECTORS = Object.freeze({
  mm: Object.freeze({
    dir: 'astra-mattermost-dc-mcp',
    exe: 'astra-mattermost-mcp.exe',
    tools: Object.freeze(['mmchat_whoami', 'mmchat_list_channels', 'mmchat_read_channel'])
  }),
  max: Object.freeze({
    dir: 'max-mcp-b22-runtime',
    exe: 'max-user-history-mcp.exe',
    tools: Object.freeze(['max_whoami', 'max_list_chats', 'max_resolve_chat', 'max_read_history'])
  }),
  // Готовый коннектор избранного Телемоста: только read-only favorite_*.
  ydx: Object.freeze({
    dir: 'yandex-telemost-favorites-mcp',
    exe: 'yandex-telemost-favorites-mcp.exe',
    tools: Object.freeze([
      'favorite_chats_list',
      'favorite_chat_messages_list',
      'favorite_thread_messages_list',
      'favorite_chat_message_get'
    ])
  })
})

// Яндекс живёт не в ~/mcp, а в каталоге интеграций Hermes: пользователь разрешил
// ровно этот каталог (узкое исключение allowlist в bridge/registry.js).
function defaultBaseDirFor(service) {
  if (service === 'ydx') return path.win32.dirname(YANDEX_INTEGRATION_ROOT)
  return DEFAULT_BASE_DIR
}

function homeDir() {
  if (process.env.USERPROFILE) return process.env.USERPROFILE
  return os.homedir()
}

function roamingDir() {
  if (process.env.APPDATA) return process.env.APPDATA
  return path.win32.join(os.homedir(), 'AppData', 'Roaming')
}

// config.json профиля ChatHub: portable/dev-копия передаёт свой путь явно,
// иначе остаётся прежний %APPDATA%/ChatHub/config.json.
function favoritesFile(chatHubConfig) {
  if (typeof chatHubConfig === 'string' && chatHubConfig.trim() !== '') {
    return path.win32.resolve(chatHubConfig)
  }
  return path.win32.join(roamingDir(), 'ChatHub', 'config.json')
}

// env коннектора: только пути и флаги, никаких токенов.
function envFor(service, baseDir, chatHubConfig) {
  if (service === 'mm') {
    return {
      MMCHAT_BASE_URL: 'https://im.astralinux.ru',
      MMCHAT_READ_ONLY: 'true',
      MMCHAT_FAVORITES_FILE: favoritesFile(chatHubConfig)
    }
  }
  if (service === 'max') {
    return { MAX_MCP_CONFIG: path.win32.join(baseDir, 'max-mcp.config.json') }
  }
  if (service === 'ydx') {
    // Только системные пути, которые коннектор читает сам (профиль ChatHub —
    // из %APPDATA%). Токен в реестр не пишется: main передаёт его мосту
    // исключительно через env CHATHUB_YDX_TOKEN во время запуска.
    return {
      APPDATA: roamingDir(),
      USERPROFILE: homeDir(),
      HOME: process.env.HOME || homeDir()
    }
  }
  return {}
}

// Путь к exe внутри выбранного каталога коннектора: '<dir>/.venv/Scripts/<exe>'.
function executableIn(service, dir) {
  const spec = CONNECTORS[service]
  if (!spec) return null
  if (typeof dir !== 'string' || dir.trim() === '') return null
  const target = path.win32.join(dir, '.venv', 'Scripts', spec.exe)
  try {
    if (!fs.existsSync(target)) return null
    if (!fs.statSync(target).isFile()) return null
  } catch {
    return null
  }
  return target
}

function makeError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

// Временный профиль MAX: пишем в каталог состояния, фиксируем на диск, права 0600.
// Итоговое имя появляется только после успешного probe (rename делает install).
function writeProfileTemp(directory, text) {
  const temporary = path.win32.join(
    directory,
    `max-mcp.config.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  )
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, text, 'utf8')
    try {
      fs.fsyncSync(descriptor)
    } catch (error) {
      if (error.code !== 'ENOSYS' && error.code !== 'EINVAL') throw error
    }
    fs.closeSync(descriptor)
    descriptor = undefined
    // chmod на Windows может не примениться — не считаем это ошибкой.
    try { fs.chmodSync(temporary, 0o600) } catch {}
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try { fs.rmSync(temporary, { force: true }) } catch {}
    throw makeError('REGISTRY_WRITE_FAILED', `не удалось записать профиль MAX: ${temporary}`)
  }
  return temporary
}

// MAX читает chat_hub_config из своего конфига, а env лишь задаёт путь к нему.
// Поэтому копируем исходный конфиг пакета, меняя только chat_hub_config, и
// кладём временный файл рядом с реестром — у каждого профиля ChatHub свой.
// Возвращаем { tempPath, finalPath }: probe идёт с tempPath, final — после успеха.
function prepareMaxProfile(options = {}) {
  const settings = options && typeof options === 'object' ? options : {}
  // P2-1: только явный baseDir — дефолт ~/mcp давал чужой профиль.
  const baseDir = typeof settings.baseDir === 'string' ? settings.baseDir.trim() : ''
  if (!baseDir) {
    throw makeError('REGISTRY_INVALID', 'baseDir не передан: исходный конфиг MAX неизвестен')
  }
  const root = path.win32.resolve(baseDir)
  const source = path.win32.join(root, 'max-mcp.config.json')
  let raw
  try {
    raw = fs.readFileSync(source, 'utf8')
  } catch {
    throw makeError('REGISTRY_INVALID', `исходный конфиг MAX не найден: ${source}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw makeError('REGISTRY_INVALID', `исходный конфиг MAX не JSON: ${source}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw makeError('REGISTRY_INVALID', `исходный конфиг MAX должен быть объектом: ${source}`)
  }
  const chatHubConfig = typeof settings.chatHubConfig === 'string' ? settings.chatHubConfig.trim() : ''
  if (!chatHubConfig) {
    throw makeError('REGISTRY_INVALID', 'chatHubConfig не передан: генерировать профиль MAX не из чего')
  }
  const registryDir = typeof settings.registryPath === 'string' && settings.registryPath.trim() !== ''
    ? path.win32.dirname(path.win32.resolve(settings.registryPath))
    : root
  try {
    fs.mkdirSync(registryDir, { recursive: true })
  } catch {
    throw makeError('REGISTRY_WRITE_FAILED', `не удалось создать каталог профиля MAX: ${registryDir}`)
  }
  const payload = {
    ...parsed,
    chat_hub_config: path.win32.resolve(chatHubConfig)
  }
  const finalPath = path.win32.join(registryDir, 'max-mcp.config.json')
  const tempPath = writeProfileTemp(registryDir, JSON.stringify(payload, null, 2) + '\n')
  return { tempPath, finalPath }
}

// Каталог пакета: сначала канонический '<root>/<dir>', затем сам root —
// пользователь может выбрать каталог, внутри которого уже лежит '.venv/Scripts'.
function packageDirIn(service, root) {
  const spec = CONNECTORS[service]
  if (!spec) return null
  const nested = path.win32.join(root, spec.dir)
  if (executableIn(service, nested)) return nested
  if (executableIn(service, root)) return root
  return null
}

// Второй аргумент: строка baseDir (прежний вызов) либо объект
// { baseDir, chatHubConfig }. chatHubConfig — абсолютный путь к config.json профиля.
function candidates(service, options) {
  const spec = CONNECTORS[service]
  if (!spec) return null
  const settings = typeof options === 'string'
    ? { baseDir: options }
    : options && typeof options === 'object' ? options : {}
  const baseDir = settings.baseDir === undefined ? defaultBaseDirFor(service) : settings.baseDir
  if (typeof baseDir !== 'string' || baseDir.trim() === '') return null
  const root = path.win32.resolve(baseDir)
  const packageDir = packageDirIn(service, root)
  if (!packageDir) return null
  return {
    command: executableIn(service, packageDir),
    args: [],
    env: envFor(service, root, settings.chatHubConfig),
    desiredTools: spec.tools.slice(),
    // Эффективный baseDir: из него читается исходный max-mcp.config.json.
    baseDir: root
  }
}

module.exports = { DEFAULT_BASE_DIR, candidates, envFor, executableIn, prepareMaxProfile }
