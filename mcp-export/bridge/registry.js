'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function makeError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function localAppData() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA
  return path.win32.join(os.homedir(), 'AppData', 'Local')
}

// Узкое исключение allowlist: ровно каталог интеграции Яндекс Телемоста в
// hermes/integrations. Разрешил пользователь для пакета YANDEX-ADAPTER: не весь
// hermes и не integrations целиком — соседние каталоги и hermes/bin остаются
// вне корней, поэтому исключение не расширяет ничего, кроме одного коннектора.
const YANDEX_INTEGRATION_ROOT = path.win32.resolve(
  localAppData(), 'hermes', 'integrations', 'yandex-telemost-favorites-mcp'
)

// Разрешённые корни установки коннекторов.
const ALLOWED_ROOTS = Object.freeze([
  path.win32.resolve(os.homedir(), 'mcp'),
  path.win32.resolve(localAppData(), 'ChatHub', 'mcp'),
  YANDEX_INTEGRATION_ROOT
])

function defaultRegistryPath() {
  if (process.env.CHATHUB_MCP_REGISTRY) return process.env.CHATHUB_MCP_REGISTRY
  return path.win32.join(localAppData(), 'ChatHub', 'mcp', 'connectors.json')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRoots(roots) {
  const list = Array.isArray(roots) && roots.length ? roots : ALLOWED_ROOTS
  const normalized = []
  for (const root of list) {
    if (typeof root !== 'string' || root.trim() === '') continue
    normalized.push(path.win32.resolve(root).replace(/[\\/]+$/, '').toLowerCase())
  }
  return normalized
}

function insideRoot(target, root) {
  return target === root || target.startsWith(root + path.win32.sep)
}

function normalizeRootKey(value) {
  return String(value).replace(/[\\/]+$/, '').toLowerCase()
}

function realPathOrNull(target) {
  try {
    const real = typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(target)
      : fs.realpathSync(target)
    return typeof real === 'string' ? real : null
  } catch {
    return null
  }
}

function validateCommand(command, roots) {
  if (typeof command !== 'string' || command.trim() === '' || command.includes('\0')) {
    throw makeError('REGISTRY_UNSAFE_COMMAND', 'command должен быть непустым абсолютным путём')
  }
  if (!path.win32.isAbsolute(command)) {
    throw makeError('REGISTRY_UNSAFE_COMMAND', `относительный command запрещён: ${command}`)
  }
  if (command.startsWith('\\\\') || command.startsWith('//')) {
    throw makeError('REGISTRY_UNSAFE_COMMAND', `UNC-путь запрещён: ${command}`)
  }
  const resolved = path.win32.resolve(command)
  const candidate = resolved.toLowerCase()
  if (!roots.some(root => insideRoot(candidate, root))) {
    throw makeError('REGISTRY_UNSAFE_COMMAND', `command вне разрешённых корней: ${resolved}`)
  }
  // M9-R2 D4: junction/symlink внутри корня не обходит allowlist — сверяем realpath.
  // Несуществующий путь проверяем только по resolve, как раньше.
  if (fs.existsSync(resolved)) {
    const real = realPathOrNull(resolved)
    if (!real) throw makeError('REGISTRY_UNSAFE_COMMAND', `не удалось разрешить command: ${resolved}`)
    const realCandidate = normalizeRootKey(real)
    const realRoots = roots.map(root => {
      const realRoot = realPathOrNull(root)
      return realRoot ? normalizeRootKey(realRoot) : root
    })
    if (!realRoots.some(root => insideRoot(realCandidate, root))) {
      throw makeError('REGISTRY_UNSAFE_COMMAND', `command ведёт за пределы разрешённых корней: ${resolved}`)
    }
  }
  return resolved
}

function validateArgs(args) {
  if (!Array.isArray(args)) throw makeError('REGISTRY_INVALID', 'args должен быть массивом строк')
  const result = []
  for (const value of args) {
    if (typeof value !== 'string') throw makeError('REGISTRY_INVALID', 'args должен быть массивом строк')
    if (value.includes('\0')) throw makeError('REGISTRY_INVALID', 'args не может содержать \\0')
    result.push(value)
  }
  return result
}

function validateEnv(env) {
  if (env === undefined) return {}
  if (!isPlainObject(env)) throw makeError('REGISTRY_INVALID', 'env должен быть объектом строк')
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw makeError('REGISTRY_INVALID', `env.${key} должен быть строкой`)
    result[key] = value
  }
  return result
}

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw makeError('REGISTRY_INVALID', 'tools должен быть непустым массивом имён')
  }
  const result = []
  for (const tool of tools) {
    if (typeof tool !== 'string' || tool.trim() === '') {
      throw makeError('REGISTRY_INVALID', 'tools должен содержать непустые строки')
    }
    result.push(tool)
  }
  return result
}

// Проверка одной записи реестра. roots можно переопределить в тестах.
function validateConnector(entry, roots) {
  if (!isPlainObject(entry)) throw makeError('REGISTRY_INVALID', 'запись коннектора должна быть объектом')
  if (Object.prototype.hasOwnProperty.call(entry, 'shell')) {
    throw makeError('REGISTRY_UNSAFE_COMMAND', 'ключ shell запрещён')
  }
  if (entry.mode !== 'bundled' && entry.mode !== 'existing') {
    throw makeError('REGISTRY_INVALID', 'mode должен быть bundled или existing')
  }
  const command = validateCommand(entry.command, normalizeRoots(roots))
  return {
    mode: entry.mode,
    command,
    args: validateArgs(entry.args),
    env: validateEnv(entry.env),
    tools: validateTools(entry.tools)
  }
}

function loadRegistry(filePath, roots) {
  const target = filePath || defaultRegistryPath()
  let raw
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw makeError('REGISTRY_MISSING', `реестр не найден: ${target}`)
    }
    throw makeError('REGISTRY_INVALID', `не удалось прочитать реестр: ${target}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw makeError('REGISTRY_INVALID', `реестр не является JSON: ${target}`)
  }

  if (!isPlainObject(parsed)) throw makeError('REGISTRY_INVALID', 'реестр должен быть объектом')
  if (parsed.version !== 1) throw makeError('REGISTRY_INVALID', `version должен быть 1, получено: ${parsed.version}`)
  if (!isPlainObject(parsed.connectors)) throw makeError('REGISTRY_INVALID', 'connectors должен быть объектом')

  const connectors = {}
  for (const [service, entry] of Object.entries(parsed.connectors)) {
    if (typeof service !== 'string' || service.trim() === '') {
      throw makeError('REGISTRY_INVALID', 'имя сервиса должно быть непустой строкой')
    }
    connectors[service] = validateConnector(entry, roots)
  }
  return { version: 1, connectors }
}

module.exports = { ALLOWED_ROOTS, YANDEX_INTEGRATION_ROOT, defaultRegistryPath, loadRegistry, validateConnector }
