// tests/unit.mjs — юнит-тесты чистых функций renderer.js.
// Функции извлекаются из renderer.js по исходнику (brace-matching) и исполняются
// в vm-контексте: тестируем РЕАЛЬНЫЙ код, не копию. Запуск: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(path.join(ROOT, 'renderer.js'), 'utf8')

function extractFunction(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{')
  const m = re.exec(SRC)
  if (!m) throw new Error('функция не найдена в renderer.js: ' + name)
  let i = m.index + m[0].length - 1
  let depth = 0
  let j = i
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (depth === 0) break }
  }
  return SRC.slice(m.index, j + 1)
}
function sandbox(names, extra = {}) {
  const ctx = { Date, Math, JSON, String, Number, parseInt, parseFloat, RegExp, console, ...extra }
  vm.createContext(ctx)
  for (const n of names) vm.runInContext(extractFunction(n), ctx)
  return ctx
}

// ---------- parseChatTime ----------
const pt = sandbox(['parseChatTime'])

test('parseChatTime: «10:24» — сегодняшние часы/минуты', () => {
  const r = pt.parseChatTime('10:24')
  const d = new Date(r.at)
  const n = new Date()
  assert.equal(r.dayOnly, false)
  assert.equal(d.getHours(), 10)
  assert.equal(d.getMinutes(), 24)
  assert.equal(d.getDate(), n.getDate())
})

test('parseChatTime: «вчера» — вчерашний день, отметка dayOnly', () => {
  const r = pt.parseChatTime('вчера')
  const d = new Date(r.at)
  const y = new Date(); y.setDate(y.getDate() - 1)
  assert.equal(r.dayOnly, true)
  assert.equal(d.getDate(), y.getDate())
})

test('parseChatTime: «пн» — прошлый понедельник, не сегодня', () => {
  const r = pt.parseChatTime('пн')
  const d = new Date(r.at)
  const n = new Date()
  assert.equal(r.dayOnly, true)
  assert.equal(d.getDay(), 1)
  assert.ok(r.at < n.getTime(), 'понедельник должен быть в прошлом')
})

test('parseChatTime: пустая строка → 0', () => {
  const r = pt.parseChatTime('')
  assert.equal(r.at, 0)
  assert.equal(r.dayOnly, false)
})

// ---------- fmtChatWhen ----------
const fw = sandbox(['fmtChatWhen'])

test('fmtChatWhen: дата+время в текущем году → ДД.ММ ЧЧ:ММ', () => {
  const y = new Date().getFullYear()
  const s = fw.fmtChatWhen(new Date(y, 10, 10, 9, 40, 0).getTime(), false)
  assert.equal(s, '10.11 09:40')
})

test('fmtChatWhen: dayOnly → только ДД.ММ', () => {
  const y = new Date().getFullYear()
  const s = fw.fmtChatWhen(new Date(y, 2, 5, 18, 7, 0).getTime(), true)
  assert.equal(s, '05.03')
})

test('fmtChatWhen: другой год → ДД.ММ.ГГ', () => {
  const s = fw.fmtChatWhen(new Date(2025, 2, 5, 18, 7, 0).getTime(), true)
  assert.equal(s, '05.03.25')
})

// ---------- badgeColor ----------
const bc = sandbox(['badgeColor'])

test('badgeColor: детерминированный hsl и различие имён', () => {
  const a1 = bc.badgeColor('Анна Петрова')
  const a2 = bc.badgeColor('Анна Петрова')
  const b = bc.badgeColor('Олег Смирнов')
  assert.equal(a1, a2)
  assert.notEqual(a1, b)
  const m = /^hsl\((\d+) 55% 42%\)$/.exec(a1)
  assert.ok(m, 'формат hsl(N 55% 42%)')
  assert.ok(Number(m[1]) >= 0 && Number(m[1]) < 360)
})

// ---------- escapeHtml ----------
const eh = sandbox([], {})
{
  const start = SRC.indexOf('const escapeHtml')
  const end = SRC.indexOf('\n))', start)
  if (start < 0 || end < 0) throw new Error('escapeHtml не найден в renderer.js')
  vm.runInContext(SRC.slice(start, end + 3) + '; globalThis.escapeHtml = escapeHtml;', eh)
}

test('escapeHtml: экранирует <>&"\'', () => {
  assert.equal(eh.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  assert.equal(eh.escapeHtml(null), '')
})

// ---------- tgPidSafe ----------
const tp = sandbox(['tgPidSafe'])

test('tgPidSafe: pid из URL пина совпадает → true', () => {
  assert.equal(tp.tgPidSafe({ url: 'https://web.telegram.org/k/#-5064616793', title: 'X' }, '-5064616793', 'Y'), true)
})

test('tgPidSafe: @username-пин не принимает чужой pid', () => {
  assert.equal(tp.tgPidSafe({ url: 'https://web.telegram.org/k/#@zema152', title: 'Анна' }, '-999', 'Анна'), false)
})

test('tgPidSafe: совпадение по словам названия (≥4 симв., стоп-слова отброшены)', () => {
  assert.equal(tp.tgPidSafe({ url: 'https://web.telegram.org/k/', title: 'EXT | Метро | TM Profile' }, '-5', 'Метро — рабочий чат'), true)
  assert.equal(tp.tgPidSafe({ url: 'https://web.telegram.org/k/', title: 'EXT | Метро' }, '-5', 'Совсем другой чат'), false)
})

test('tgPidSafe: пустые аргументы → false', () => {
  assert.equal(tp.tgPidSafe(null, '-1', 'x'), false)
  assert.equal(tp.tgPidSafe({ url: '', title: '' }, '', 'x'), false)
})

// ---------- pinMatches ----------
const pm = sandbox(['pinMatches'])

test('pinMatches: MM — совпадение по slug', () => {
  const svc = { id: 'mm', url: 'https://im.astralinux.ru' }
  assert.equal(pm.pinMatches({ serviceId: 'mm', url: 'https://im.astralinux.ru/astralinux/channels/abc' }, svc, 'https://im.astralinux.ru/astralinux/channels/abc', ''), true)
  assert.equal(pm.pinMatches({ serviceId: 'mm', url: 'https://im.astralinux.ru/astralinux/channels/abc' }, svc, 'https://im.astralinux.ru/astralinux/channels/xyz', ''), false)
})

test('pinMatches: TG — совпадение по hash', () => {
  const svc = { id: 'tg', url: 'https://web.telegram.org/k/' }
  assert.equal(pm.pinMatches({ serviceId: 'tg', url: 'https://web.telegram.org/k/#@zema152' }, svc, 'https://web.telegram.org/k/#@zema152', ''), true)
  assert.equal(pm.pinMatches({ serviceId: 'tg', url: 'https://web.telegram.org/k/#@zema152' }, svc, 'https://web.telegram.org/k/#@other', ''), false)
})

test('pinMatches: чужой сервис → false; MAX deep-link по URL', () => {
  const svc = { id: 'max', url: 'https://web.max.ru/' }
  assert.equal(pm.pinMatches({ serviceId: 'tg', url: 'https://web.max.ru/-7672' }, svc, 'https://web.max.ru/-7672', ''), false)
  assert.equal(pm.pinMatches({ serviceId: 'max', url: 'https://web.max.ru/-76728609770887' }, svc, 'https://web.max.ru/-76728609770887', ''), true)
  assert.equal(pm.pinMatches({ serviceId: 'max', url: 'https://web.max.ru/-1111' }, svc, 'https://web.max.ru/-2222', ''), false)
})

// ---------- maxLiveViews ----------
test('maxLiveViews: значение из конфига, дефолт 8, мусор → 8', () => {
  const c1 = sandbox(['maxLiveViews'], { state: { cfg: { maxLiveViews: '5' } } })
  assert.equal(c1.maxLiveViews(), 5)
  const c2 = sandbox(['maxLiveViews'], { state: { cfg: {} } })
  assert.equal(c2.maxLiveViews(), 8)
  const c3 = sandbox(['maxLiveViews'], { state: { cfg: { maxLiveViews: 'abc' } } })
  assert.equal(c3.maxLiveViews(), 8)
  const c4 = sandbox(['maxLiveViews'], { state: { cfg: { maxLiveViews: '0' } } })
  assert.equal(c4.maxLiveViews(), 8)
})
