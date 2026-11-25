// Мета-тест покрытия: не проверяет поведение продукта, а ищет дрейф между
// исходниками и тестами. Читает файлы с диска — никаких захардкоженных списков
// модулей, каналов и методов: список всегда берётся из кода.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mcpDir = path.join(root, 'mcp-export')
const testsDir = path.join(root, 'tests')
const SELF = 'mcp-coverage.mjs'

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

// Тестовые файлы верхнего уровня: фикстуры и сам мета-тест не считаются
// покрытием — иначе проверка находила бы сама себя.
function testSources() {
  return fs.readdirSync(testsDir)
    .filter(name => name.endsWith('.mjs') && name !== SELF)
    .map(name => ({ file: name, text: fs.readFileSync(path.join(testsDir, name), 'utf8') }))
}

function hasAnywhere(sources, needle) {
  // Имя ищется по границам слова: 'getConfig' не должен «находиться» внутри
  // getConfigPath, а 'app:version' — внутри другого канала с тем же префиксом.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp('(^|[^\\w$])' + escaped + '($|[^\\w$])')
  return sources.some(source => pattern.test(source.text))
}

// Локальные загрузчики тестов вида
//   function core(name) { return require(path.join(root, 'mcp-export', 'core', name + '.js')) }
// дают покрытие только для тех имён, которые реально вызываются: core('coverage').
function loaderModules(text, dir) {
  const found = new Set()
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const loader = new RegExp(
    'function\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\s*name\\s*\\)\\s*\\{[\\s\\S]{0,300}?' +
      'require\\(\\s*path\\.join\\([\\s\\S]{0,200}?' +
      '[\'"]mcp-export[\'"]\\s*,\\s*[\'"]' + escaped + '[\'"]\\s*,\\s*name\\s*\\+\\s*[\'"]\\.js[\'"]\\s*\\)\\s*\\)',
    'g'
  )
  for (const match of text.matchAll(loader)) {
    const calls = new RegExp('\\b' + match[1] + '\\(\\s*[\'"]([^\'"]+)[\'"]\\s*\\)', 'g')
    for (const call of text.matchAll(calls)) found.add(call[1])
  }
  return found
}

// Модуль покрыт, если тест грузит его по точному пути (mcp-export/<dir>/<base>
// или require(..., '<dir>', '<base>.js')) либо через локальный загрузчик с
// точным именем модуля. Голое совпадение '<base>.js' не считается: иначе
// корневой main.js «покрывал» бы mcp-export/bridge/main.js.
function isModuleCovered(source, dir, base) {
  if (source.text.includes(`mcp-export/${dir}/${base}`)) return true
  const quoted = [`'${dir}', '${base}.js'`, `"${dir}", "${base}.js"`,
    `'${dir}', "${base}.js"`, `"${dir}", '${base}.js'`]
  if (quoted.some(pattern => source.text.includes(pattern))) return true
  return loaderModules(source.text, dir).has(base)
}

function uncoveredModules() {
  const modules = walk(mcpDir).filter(file =>
    file.endsWith('.js') && path.basename(file) !== 'index.js')
  assert.ok(modules.length > 0, 'не найдено ни одного модуля mcp-export — сломан обход каталога')
  const sources = testSources()
  const uncovered = []
  for (const file of modules) {
    const rel = path.relative(mcpDir, file).split(path.sep).join('/')
    const dir = path.posix.dirname(rel)
    const base = path.basename(rel, '.js')
    if (!sources.some(source => isModuleCovered(source, dir, base))) uncovered.push(`mcp-export/${rel}`)
  }
  return uncovered
}

// Каналы, которые main.js регистрирует для renderer-а.
function registeredChannels() {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
  const channels = [...source.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map(match => match[1])
  assert.ok(channels.length > 0, 'в main.js не найдено ни одного ipcMain.handle — проверьте разбор')
  return [...new Set(channels)]
}

// Методы, которые preload.js выставляет в window.hub. Разбираем объект
// exposeInMainWorld по балансу скобок: без выполнения preload и без Electron.
function exposedMethods() {
  const source = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
  const start = source.indexOf('exposeInMainWorld')
  assert.ok(start !== -1, 'в preload.js не найден exposeInMainWorld')
  const open = source.indexOf('{', start)
  assert.ok(open !== -1, 'в preload.js не найдено тело объекта моста')
  let depth = 0
  let close = -1
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) { close = index; break }
    }
  }
  assert.ok(close !== -1, 'не удалось найти конец объекта моста в preload.js')
  const body = source.slice(open + 1, close)
  const keys = [...body.matchAll(/(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*:/g)].map(match => match[1])
  assert.ok(keys.length > 0, 'в preload.js не найдено ни одного метода моста — проверьте разбор')
  return [...new Set(keys)]
}

test('покрытие модулей: каждый mcp-export/**/*.js (кроме index.js) упомянут в тестах', () => {
  const uncovered = uncoveredModules()
  assert.deepEqual(uncovered, [], 'нет покрытия (require или имя модуля) у файлов:\n' + uncovered.join('\n'))
})

test('покрытие IPC: каждый ipcMain.handle из main.js встречается в tests/*.mjs', () => {
  const sources = testSources()
  const missing = registeredChannels().filter(channel => !hasAnywhere(sources, channel))
  assert.deepEqual(missing, [], 'каналы без упоминания в tests/*.mjs:\n' + missing.join('\n'))
})

test('покрытие preload: каждый метод моста встречается в tests/*.mjs', () => {
  const sources = testSources()
  const missing = exposedMethods().filter(name => !hasAnywhere(sources, name))
  assert.deepEqual(missing, [], 'методы preload без упоминания в tests/*.mjs:\n' + missing.join('\n'))
})
